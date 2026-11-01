// Runs against the NORMAL built service entrypoints, no external checkout or source patch.
// See tests/pd08-compose.test.yml; this test controls only its isolated Compose project.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Pool } = require('../aggregator-service/node_modules/pg');
const amqp = require('../aggregator-service/node_modules/amqplib');
const { makeCommands } = require('../aggregator-service/src/commands');
try { process.loadEnvFile(path.join(__dirname, '../.env')); } catch { /* CI environment */ }
const enabled = process.env.PD08_RUNTIME === '1';
const root = path.resolve(__dirname, '..');
const key = process.env.INTERNAL_KEY ?? 'dev';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  do { const value = await fn(); if (value) return value; await sleep(100); } while (Date.now() < end);
  throw new Error('PD08 runtime evidence timeout');
}
const compose = (...args) => execFileSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8' });
const scalar = (db, sql) => compose('exec','-T',db,'psql','-U','postgres','-d','parking','-tAc',sql).trim();
async function http(url, token, body) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: {
    'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }),
  }, body: body && JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('PD08 real service entrypoints: TC57, TC58 and deadline after DB lock', { skip: !enabled, timeout: 120000 }, async t => {
  assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', /^pd08[-_]/, 'Use a reserved isolated pd08-* Compose project');
  const pool = new Pool({ connectionString: process.env.PD08_DATABASE_URL ?? 'postgres://postgres:dev@localhost:15432/parking' });
  const agg = new Pool({ connectionString: process.env.PD08_AGG_DATABASE_URL ?? 'postgres://postgres:dev@localhost:15433/parking' });
  const ids = ['pd08-runtime:retry'];
  const prefix = `R${randomUUID().replaceAll('-','').slice(0,6)}`;
  let conn, ch, publisher, deadlinePublisher, locker;
  const wires = [];
  try {
    // This recreates only the isolated test node, resetting its scoped, test-only fault counter.
    compose('up','-d','--no-deps','--no-build','--force-recreate','parking-a');
    await until(async () => { try { return (await fetch('http://localhost:8001/health')).ok; } catch { return false; } });
    await pool.query(`INSERT INTO parking_slots(slot_code,floor,type) SELECT unnest($1::text[]),98,'CAR'`, [[1,2,3,4].map(i => `${prefix}${i}`)]);
    conn = await amqp.connect(process.env.PD08_AMQP_URL ?? 'amqp://parking:parking@localhost:5673/%2F');
    ch = await conn.createChannel();
    const probe = await ch.assertQueue('', { exclusive: true });
    await ch.bindQueue(probe.queue, 'parking.dlx', '#');
    await ch.consume(probe.queue, m => { if (m) { wires.push({ at: Date.now(), route: m.fields.routingKey, body: JSON.parse(m.content), properties: m.properties }); ch.ack(m); } });
    const replies = await ch.assertQueue('', { exclusive: true });
    await ch.assertExchange('parking.replies', 'direct', { durable: true });
    await ch.bindQueue(replies.queue, 'parking.replies', 'pd08.runtime');
    const results = [];
    await ch.consume(replies.queue, m => { if (m) { results.push({ at: Date.now(), body: JSON.parse(m.content) }); ch.ack(m); } });
    publisher = makeCommands(process.env.PD08_AMQP_URL ?? 'amqp://parking:parking@localhost:5673/%2F', { signingKey: key, ttlMs: 60000, replyTo: 'pd08.runtime' });
    const actor = { userId: 'pd08-runtime', role: 'USER' };
    const send = (id, slot, extra = {}) => publisher.send('A','reserve',{ slotCode: slot, licensePlate:'30A-123.45' },{ messageId:id, actor, traceparent:'00-11111111111111111111111111111111-2222222222222222-01', ...extra });
    await t.test('TC57: live index retries after 2s and 10s; same ID/context, one effect, no cross-parking route', async () => {
      await send(ids[0], `${prefix}1`);
      const reply = await until(() => results.find(r => r.body.commandId === ids[0]));
      assert.equal(reply.body.statusCode, 201);
      const events = wires.filter(w => w.properties.messageId === ids[0]);
      assert.deepEqual(events.map(w => w.route), ['retry.1','retry.2']);
      const gaps = [events[1].at - events[0].at, reply.at - events[1].at];
      assert.ok(gaps[0] >= 1900 && gaps[1] >= 9900, JSON.stringify(gaps));
      for (const event of events) {
        assert.equal(event.properties.correlationId, ids[0]);
        assert.equal(event.properties.replyTo, 'pd08.runtime');
        assert.equal(event.body.deadlineAt - event.body.issuedAt, 60000);
        assert.equal(event.body.actor.userId, actor.userId);
        assert.equal(event.body.traceparent, '00-11111111111111111111111111111111-2222222222222222-01');
      }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE request_id=$1',[ids[0]])).rows[0].n,1);
      for (const lot of ['b','c']) assert.equal(scalar(`db-${lot}`, `SELECT count(*) FROM inbox_messages WHERE message_id='${ids[0]}'`),'0');
      console.log('TC57 live retry intervals ms:', ...gaps, '; command TTL=60000');
    });
    await t.test('TC58: actual DLQ worker persists schema failure; ADMIN edits/replays; inbox records one effect', async () => {
      const id = `pd08-runtime:${randomUUID()}`; ids.push(id);
      await send(id, `${prefix}2`, { schemaVersion: 2 });
      const login = await http('http://localhost:8000/api/auth/login', null, {username:'admin',password:process.env.DEMO_PASSWORD ?? '123456'});
      const token = login.body.token;
      assert.ok(token);
      const row = await until(async () => (await http('http://localhost:8000/api/admin/dlq?limit=100',token)).body.items?.find(r => r.messageId === id));
      assert.equal(row.reason, 'INVALID_SCHEMA');
      assert.equal(row.payload.licensePlate, '[đã che]');
      assert.equal((await http('http://localhost:8000/api/admin/dlq')).status,401);
      const response = await http(`http://localhost:8000/api/admin/dlq/${row.id}/replay`,token,{payload:{slotCode:`${prefix}3`,licensePlate:'30B-456.78'}});
      assert.equal(response.status,202); ids.push(response.body.messageId);
      assert.notEqual(response.body.messageId,id);
      await until(async () => (await pool.query('SELECT 1 FROM reservations WHERE request_id=$1',[response.body.messageId])).rowCount === 1);
      assert.equal((await pool.query('SELECT status_code FROM inbox_messages WHERE message_id=$1',[id])).rows[0].status_code,422);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE request_id=$1',[response.body.messageId])).rows[0].n,1);
      await until(async () => (await agg.query('SELECT status FROM dead_letters WHERE id=$1',[row.id])).rows[0].status === 'BROKER_CONFIRMED');
    });
    await t.test('deadline elapses while SQL waits for a slot lock: transaction fully rolls back, no late effect', async () => {
      const id = `pd08-runtime:${randomUUID()}`; ids.push(id);
      locker = await pool.connect();
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM parking_slots WHERE slot_code=$1 FOR UPDATE',[`${prefix}4`]);
      deadlinePublisher = makeCommands(process.env.PD08_AMQP_URL ?? 'amqp://parking:parking@localhost:5673/%2F', {signingKey:key,ttlMs:300,replyTo:'pd08.runtime'});
      await deadlinePublisher.send('A','reserve',{slotCode:`${prefix}4`,licensePlate:'30C-222.33'},{actor,messageId:id});
      await sleep(700);
      await locker.query('COMMIT'); locker.release(); locker = null;
      const expired = await until(() => wires.find(w => w.properties.messageId === id && w.route === 'expired'));
      assert.equal(expired.body.deadlineAt-expired.body.issuedAt,300);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE request_id=$1',[id])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM inbox_messages WHERE message_id=$1',[id])).rows[0].n,0);
      assert.equal((await pool.query('SELECT status FROM parking_slots WHERE slot_code=$1',[`${prefix}4`])).rows[0].status,'AVAILABLE');
      const m=await ch.get('cmd.expired',{noAck:false});
      assert.equal(m.properties.messageId,id); ch.ack(m);
    });
  } finally {
    if(locker){await locker.query('ROLLBACK').catch(()=>{});locker.release();}
    await publisher?.close(); await deadlinePublisher?.close();
    await ch?.close().catch(()=>{}); await conn?.close().catch(()=>{});
    // Only synthetic fixture IDs and slots; no purge/drop/volume deletion.
    await pool.query('DELETE FROM command_reply_outbox WHERE command_id=ANY($1::text[])',[ids]);
    await pool.query('DELETE FROM inbox_messages WHERE message_id=ANY($1::text[])',[ids]);
    await pool.query('DELETE FROM parking_events WHERE slot_code LIKE $1',[`${prefix}%`]);
    await pool.query('DELETE FROM reservations WHERE request_id=ANY($1::text[])',[ids]);
    await pool.query('DELETE FROM parking_slots WHERE slot_code LIKE $1',[`${prefix}%`]);
    await agg.query('DELETE FROM dead_letters WHERE message_id=ANY($1::text[])',[ids]);
    await pool.end(); await agg.end();
  }
});