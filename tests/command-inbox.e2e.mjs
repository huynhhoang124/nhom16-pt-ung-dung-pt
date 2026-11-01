import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../aggregator-service/package.json', import.meta.url));
const amqp = require('amqplib');
const { makeCommands } = require('../aggregator-service/src/commands');

// No full HTTP request/reply assertions until PD-03 implements that contract.
export function registerCommandInboxTests({ ROOT, compose, sh, sql, KEY, until, agg, node, login, freeSlot }) {
  const options = { timeout: 120000 };
  const url = process.env.PD02_AMQP_URL ?? 'amqp://parking:parking@localhost/%2F';
  async function setup(t) {
    const conn = await amqp.connect(url);
    const ch = await conn.createChannel();
    await ch.assertExchange('parking.replies', 'direct', { durable: true });
    const { queue } = await ch.assertQueue('', { exclusive: true });
    const replyTo = `test.${randomUUID()}`;
    await ch.bindQueue(queue, 'parking.replies', replyTo);
    const responses = [];
    await ch.consume(queue, (m) => { if (m) { responses.push({ ...JSON.parse(m.content), properties: m.properties }); ch.ack(m); } });
    const commands = makeCommands(url, { signingKey: KEY });
    t.after(async () => { await commands.close(); await conn.close(); });
    const token = await login('user1');
    const actor = { userId: JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub, role: 'USER' };
    return { commands, replyTo, responses, actor, bindReply: (key) => ch.bindQueue(queue, 'parking.replies', key) };
  }
  const restoreReservation = async (id, result) => {
    if (result?.id) await node(id, `/api/reservations/${result.id}`, { method: 'DELETE' });
  };

  test('PD-02 PostgreSQL: 10 concurrent DB clients deduplicate and preserve transaction invariants', options, () => {
    const container = compose('ps -q parking-a');
    execFileSync('docker', ['cp', path.join(ROOT, 'parking-node/test/commands-pg.test.js'), `${container}:/app/commands-pg.test.js`]);
    const output = compose('exec -T -e PD02_SOURCE_ROOT=/app/src -e PD02_REAL_DATABASE_URL=postgres://postgres:dev@db-a/parking parking-a node --test /app/commands-pg.test.js');
    assert.match(output, /pass 1/);
  });

  test('PD-02 reply outbox: missing reply queue cannot block another destination; late binding recovers the reply', options, async (t) => {
    const { commands, replyTo, responses, actor, bindReply } = await setup(t);
    const missingRoute = `test.missing.${randomUUID()}`;
    const first = `${actor.userId}:missing-${randomUUID()}`;
    const second = `${actor.userId}:routed-${randomUUID()}`;
    t.after(() => sql('db-a', `DELETE FROM command_reply_outbox WHERE command_id IN ('${first}','${second}'); DELETE FROM inbox_messages WHERE message_id IN ('${first}','${second}')`));
    // Nonexistent reservations produce stable 404 replies without mutating parking data.
    await commands.send('A', 'cancel', { reservationId: randomUUID() }, { messageId: first, actor, replyTo: missingRoute });
    await until('unroutable reply retained and deferred', () =>
      sql('db-a', `SELECT count(*) FROM command_reply_outbox WHERE command_id='${first}' AND published_at IS NULL AND next_attempt_at IS NOT NULL AND last_error='NO_ROUTE'`) === '1');
    await commands.send('A', 'cancel', { reservationId: randomUUID() }, { messageId: second, actor, replyTo });
    await until('other destination receives its reply', () => responses.some((r) => r.commandId === second));
    assert.equal(responses.find((r) => r.commandId === second).statusCode, 404);
    assert.equal(sql('db-a', `SELECT count(*) FROM command_reply_outbox WHERE command_id='${first}' AND published_at IS NULL`), '1');
    await bindReply(missingRoute);
    await until('late binding receives the retained reply', () => responses.some((r) => r.commandId === first));
    assert.equal(responses.find((r) => r.commandId === first).statusCode, 404);
    await until('recovered reply is confirmed', () =>
      sql('db-a', `SELECT count(*) FROM command_reply_outbox WHERE command_id='${first}' AND published_at IS NOT NULL AND next_attempt_at IS NULL AND last_error IS NULL`) === '1');
  });

  test('TC52 PD-02 broker: 10 concurrent messages with one messageId create one reservation and 10 identical replies', options, async (t) => {
    const { commands, replyTo, responses, actor } = await setup(t);
    const messageId = `${actor.userId}:tc52-${randomUUID()}`;
    const slotCode = await freeSlot('A');
    const payload = { slotCode, licensePlate: '30A-665.52' };
    let result;
    t.after(async () => {
      result ??= responses.find((r) => r.commandId === messageId)?.result;
      await restoreReservation('A', result);
      // Only this run's inbox/reply test records; business history remains as cancelled.
      sql('db-a', `DELETE FROM command_reply_outbox WHERE command_id='${messageId}'; DELETE FROM inbox_messages WHERE message_id='${messageId}'`);
    });
    await Promise.all(Array.from({ length: 10 }, () => commands.send('A', 'reserve', payload, { messageId, replyTo, actor })));
    await until('10 broker replies', () => responses.filter((r) => r.commandId === messageId).length >= 10);
    const replies = responses.filter((r) => r.commandId === messageId).slice(0, 10);
    assert(replies.every((r) => r.statusCode === 201)); result = replies[0].result;
    assert(replies.every((r) => JSON.stringify(r.result) === JSON.stringify(result)));
    assert.equal(sql('db-a', `SELECT count(*) FROM reservations WHERE request_id='${messageId}'`), '1');
    assert.equal(sql('db-a', `SELECT count(*) FROM inbox_messages WHERE message_id='${messageId}'`), '1');
    assert.equal(sql('db-a', `SELECT count(*) FROM command_reply_outbox WHERE command_id='${messageId}'`), '10');
    assert.equal(sql('db-a', `SELECT count(*) FROM parking_events WHERE event_type='RESERVED' AND payload->>'reservationId'='${result.id}'`), '1');
  });

  test('TC53 PD-02 broker: crash after COMMIT before ack, restart, redelivery replays without another effect', options, async (t) => {
    const { commands, replyTo, responses, actor } = await setup(t);
    const messageId = `${actor.userId}:tc53-${randomUUID()}`;
    const container = `pd02-crash-${randomUUID()}`;
    const slotCode = await freeSlot('A');
    let result;
    let launched = false;
    // Restore original service even if a test assertion or injected crash fails.
    t.after(async () => {
      if (launched) { try { sh(`docker rm -f ${container}`); } catch {} }
      compose('start parking-a');
      await until('parking A restored', async () => (await node('A', '/api/slots')).status === 200);
      if (!result) {
        const stored = sql('db-a', `SELECT result FROM inbox_messages WHERE message_id='${messageId}'`);
        if (stored) result = JSON.parse(stored);
      }
      await restoreReservation('A', result);
      sql('db-a', `DELETE FROM command_reply_outbox WHERE command_id='${messageId}'; DELETE FROM inbox_messages WHERE message_id='${messageId}'`);
    });
    const originalContainer = compose('ps -q parking-a');
    compose('stop parking-a');
    assert.equal(sh(`docker inspect -f "{{.State.ExitCode}}" ${originalContainer}`), '0', 'normal shutdown must close consumer/jobs cleanly');
    compose(`run -d --no-deps --name ${container} -e NODE_ENV=test -e COMMAND_TEST_CRASH_MESSAGE_ID=${messageId} parking-a`);
    launched = true;
    await commands.send('A', 'reserve', { slotCode, licensePlate: '30A-665.53' }, { messageId, replyTo, actor });
    await until('exit 86 after committed command', () => sh(`docker inspect -f "{{.State.Status}}:{{.State.ExitCode}}" ${container}`) === 'exited:86');
    assert.equal(sql('db-a', `SELECT count(*) FROM reservations WHERE request_id='${messageId}'`), '1');
    assert.equal(sql('db-a', `SELECT status_code FROM inbox_messages WHERE message_id='${messageId}'`), '201');
    sh(`docker start ${container}`); // same container retains one-shot marker; same env must not crash forever.
    await until('reply after redelivery', () => responses.some((r) => r.commandId === messageId && r.statusCode === 201));
    await until('redelivery recorded second reply outbox row', () => sql('db-a', `SELECT count(*) FROM command_reply_outbox WHERE command_id='${messageId}'`) === '2');
    result = responses.find((r) => r.commandId === messageId).result;
    assert.equal(sh(`docker inspect -f "{{.State.Running}}" ${container}`), 'true');
    assert.equal(sql('db-a', `SELECT count(*) FROM reservations WHERE request_id='${messageId}'`), '1');
    assert.equal(sql('db-a', `SELECT count(*) FROM parking_events WHERE event_type='RESERVED' AND payload->>'reservationId'='${result.id}'`), '1');
    await until('all pending replies published', () => sql('db-a', `SELECT count(*) FROM command_reply_outbox WHERE command_id='${messageId}' AND published_at IS NULL`) === '0');
  });
}
