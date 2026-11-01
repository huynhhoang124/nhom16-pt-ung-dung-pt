const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { makePool, one } = require('./helpers');
const slots = require('../src/slots');
const { signature } = require('../src/command-signature');
const { signature: producerSignature } = require('../../aggregator-service/src/command-signature');
const { decodeCommand, makeCommandProcessor, startCommandConsumer, cleanupInbox, InvalidCommand } = require('../src/commands');
const { makeReplyPublisher, makeReplyRelay } = require('../src/command-replies');
const KEY = 'test-internal-key';
const actor = { userId: 'u42', role: 'USER' };
function message(key, type = 'reserve', payload = { slotCode: 'A01', licensePlate: '30A-123.45' }, extra = {}) {
  const body = { schemaVersion: 1, parkingId: 'A', type, actor, payload, ...extra };
  const properties = { messageId: `${body.actor.userId}:${key}`, correlationId: `corr-${key}`, replyTo: 'test.replies', type,
    headers: {}, ...extra.properties };
  delete body.properties;
  properties.headers['x-command-signature'] = producerSignature(KEY, body, properties);
  return { content: Buffer.from(JSON.stringify(body)), properties, fields: { routingKey: `cmd.A.${type}` } };
}
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) assert.fail('Timed out'); await new Promise((r) => setTimeout(r, 5)); }
}

test('signed envelope: property authority, identity, metadata and producer/consumer canonical contract', () => {
  const m = message('signed', 'reserve', {}, { causationId: 'cause', traceparent: 'trace', hlc: '123.4', fencingToken: 42 });
  const e = decodeCommand(m, 'A', KEY);
  assert.equal(e.messageId, 'u42:signed'); assert.equal(e.correlationId, 'corr-signed'); assert.equal(e.fencingToken, 42);
  assert.equal(signature(KEY, JSON.parse(m.content), m.properties), m.properties.headers['x-command-signature']);
  for (const mutate of [
    (x) => { x.properties.messageId = 'other:key'; },
    (x) => { x.properties.correlationId = 'stolen'; },
    (x) => { x.properties.replyTo = 'other'; },
    (x) => { x.properties.expiration = '100'; },
    (x) => { const b = JSON.parse(x.content); b.actor.role = 'ADMIN'; x.content = Buffer.from(JSON.stringify(b)); },
    (x) => { x.properties.headers['x-command-signature'] = '00'; },
  ]) {
    const x = message('signed'); mutate(x); assert.throws(() => decodeCommand(x, 'A', KEY), InvalidCommand);
  }
  assert.throws(() => decodeCommand(message('x', 'reserve', {}, { schemaVersion: 2 }), 'A', KEY), InvalidCommand);
  assert.throws(() => decodeCommand(message('x', 'reserve', {}, { messageId: 'body-not-authoritative' }), 'A', KEY), InvalidCommand);
  assert.throws(() => decodeCommand(message('x'), 'B', KEY), InvalidCommand);
});

test('inbox transaction: replay, key reuse, savepoint, rollback, permissions, replies and retention', async (t) => {
  const pool = await makePool('A', 5); t.after(() => pool.db.close());
  const processCommand = makeCommandProcessor({ pool, parkingId: 'A', internalKey: KEY });
  let original;
  await t.test('same command returns exact saved status/body and creates a reply for each delivery', async () => {
    const metadata = { causationId: 'saga:1', traceparent: 'trace', hlc: '123.1', fencingToken: 42 };
    original = await processCommand(message('one', 'reserve', undefined, metadata));
    const second = await processCommand(message('one', 'reserve', undefined, metadata));
    assert.equal(original.code, 201); assert.equal(second.code, 201); assert.equal(second.duplicate, true);
    assert.deepEqual(second.body, original.body);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM reservations')).n, 1);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM parking_events')).n, 1);
    const replies = (await pool.query('SELECT payload, properties FROM command_reply_outbox ORDER BY id')).rows;
    assert.equal(replies.length, 2); assert.deepEqual(replies[0].payload.result, replies[1].payload.result);
    for (const r of replies) { assert.equal(r.properties.correlationId, 'corr-one'); assert.equal(r.properties.headers.hlc, '123.1'); assert.equal(r.payload.fencingToken, 42); }
  });
  await t.test('same key with changed payload/type is rejected without changing the original inbox', async () => {
    const changed = await processCommand(message('one', 'reserve', { slotCode: 'A02', licensePlate: '30A-123.45' }));
    assert.equal(changed.code, 422);
    const changedType = await processCommand(message('one', 'cancel', { reservationId: original.body.id }));
    assert.equal(changedType.code, 422);
    assert.equal((await one(pool, "SELECT status_code FROM inbox_messages WHERE message_id='u42:one'")).status_code, 201);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM reservations')).n, 1);
  });
  await t.test('business conflict is stored and replayed after savepoint rollback', async () => {
    const body = { slotCode: 'A02', licensePlate: '30A-999.99', startTime: new Date(Date.now() + 3600000).toISOString() };
    assert.equal((await processCommand(message('future1', 'reserve', body))).code, 201);
    const conflict = await processCommand(message('future2', 'reserve', body));
    assert.equal(conflict.code, 409); assert.equal(conflict.body.error, 'TIME_CONFLICT');
    assert.deepEqual((await processCommand(message('future2', 'reserve', body))).body, conflict.body);
    assert.equal((await one(pool, "SELECT status_code FROM inbox_messages WHERE message_id='u42:future2'")).status_code, 409);
    assert.equal((await one(pool, 'SELECT 1 AS healthy')).healthy, 1);
  });
  await t.test('outbox failure rolls back inbox, slot update, reservation and slot event together', async () => {
    const seen = [];
    let fail = true;
    const intercepted = { connect: async () => {
      const c = await pool.connect();
      return { release: c.release, query: async (sql, params) => {
        seen.push(sql);
        if (fail && sql.startsWith('INSERT INTO command_reply_outbox')) throw new Error('simulated DB outage');
        return c.query(sql, params);
      } };
    } };
    const run = makeCommandProcessor({ pool: intercepted, parkingId: 'A', internalKey: KEY });
    const m = message('rollback', 'reserve', { slotCode: 'A03', licensePlate: '30A-111.11' });
    await assert.rejects(run(m), /simulated DB outage/);
    assert.equal((await one(pool, "SELECT count(*)::int AS n FROM inbox_messages WHERE message_id='u42:rollback'")).n, 0);
    assert.equal((await one(pool, "SELECT status FROM parking_slots WHERE slot_code='A03'")).status, 'AVAILABLE');
    assert.equal((await one(pool, "SELECT count(*)::int AS n FROM parking_events WHERE slot_code='A03'")).n, 0);
    assert.equal(seen.at(-1), 'ROLLBACK'); fail = false;
    assert.equal((await run(m)).code, 201);
    assert.equal(seen.at(-1), 'COMMIT');
    assert.equal(seen.filter((s) => s === 'BEGIN').length, 2, 'exactly one BEGIN per attempt');
  });
  await t.test('cancel and pay share inbox transaction and enforce signed owner identity', async () => {
    const foreign = { userId: 'other', role: 'USER' };
    assert.equal((await processCommand(message('foreign-cancel', 'cancel', { reservationId: original.body.id }, { actor: foreign }))).code, 404);
    const cancelled = await processCommand(message('cancel', 'cancel', { reservationId: original.body.id }));
    assert.equal(cancelled.code, 200);
    assert.deepEqual((await processCommand(message('cancel', 'cancel', { reservationId: original.body.id }))).body, cancelled.body);
    const r = await processCommand(message('parking', 'reserve', { slotCode: 'A04', licensePlate: '30A-222.22' }));
    assert.equal(r.code, 201);
    const entered = await slots.moveSlot(pool, 'A', 'A04', ['RESERVED'], 'OCCUPIED', 'CAR_ENTER');
    const sessionId = entered.body.session.id;
    await pool.query("UPDATE parking_sessions SET entered_at=now()-interval '3 hours' WHERE id=$1", [sessionId]);
    const paid = await processCommand(message('pay', 'pay', { sessionId }));
    assert.equal(paid.code, 200); assert.equal(paid.body.paymentMethod, 'ONLINE');
    assert.deepEqual((await processCommand(message('pay', 'pay', { sessionId }))).body, paid.body);
    assert.equal((await processCommand(message('pay-again', 'pay', { sessionId }))).code, 409);
    assert.equal((await processCommand(message('fake-user', 'pay', { sessionId, userId: 'other' }))).code, 403);
    assert.equal((await processCommand(message('foreign-pay', 'pay', { sessionId }, { actor: foreign }))).code, 404);
  });
  await t.test('reply relay keeps returned/unavailable replies pending; marks sent only after publish succeeds', async () => {
    const before = (await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox WHERE published_at IS NULL')).n;
    const relay = makeReplyRelay(pool, async () => false);
    assert.equal(await relay(), 0);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox WHERE published_at IS NULL')).n, before);
    const sent = [];
    assert.equal(await makeReplyRelay(pool, async (...args) => { sent.push(args); return true; })(), before);
    assert.equal(sent[0][0], 'test.replies');
  });
  await t.test('retention deletes only committed inbox results older than seven days, leaves outbox untouched', async () => {
    await pool.query("UPDATE inbox_messages SET processed_at=now()-interval '8 days' WHERE message_id='u42:one'");
    const replies = (await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox')).n;
    await cleanupInbox(pool);
    assert.equal((await one(pool, "SELECT count(*)::int AS n FROM inbox_messages WHERE message_id='u42:one'")).n, 0);
    assert.equal((await one(pool, "SELECT count(*)::int AS n FROM inbox_messages WHERE message_id='u42:pay'")).n, 1);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox')).n, replies);
  });
});

function fakeBroker() {
  const connections = [];
  const connect = async () => {
    const conn = new EventEmitter(); const ch = new EventEmitter();
    conn.closed = false;
    conn.close = async () => { if (!conn.closed) { conn.closed = true; conn.emit('close'); ch.emit('close'); } };
    conn.createChannel = conn.createConfirmChannel = async () => ch;
    // Mặc định chưa có hàng đợi admin (như bãi D–F): consumer phải bỏ qua, vẫn chạy hàng thường
    ch.checkQueue = async (q) => { if (q.endsWith('.admin')) throw new Error('NOT_FOUND'); ch.queue = q; };
    ch.assertExchange = async () => {};
    ch.prefetch = async (n) => { ch.prefetchValue = n; };
    ch.consume = async (_q, cb, opts) => { ch.deliver = cb; ch.opts = opts; return { consumerTag: 'one' }; };
    ch.cancel = async () => { ch.cancelled = true; };
    ch.acks = []; ch.nacks = [];
    ch.ack = (m) => ch.acks.push(m);
    ch.nack = (...args) => ch.nacks.push(args);
    ch.sent = [];
    ch.publish = (...args) => { ch.sent.push(args); return true; };
    conn.ch = ch; connections.push(conn); return conn;
  };
  return { connect, connections };
}
const quiet = { error() {}, info() {} };

test('consumer serializes handlers despite prefetch 20, ack follows commit hook, and stop waits in-flight', async () => {
  const b = fakeBroker(); const order = []; let release;
  const consumer = startCommandConsumer({ url: 'amqp://test', parkingId: 'A', connect: b.connect, log: quiet,
    processCommand: async (m) => { order.push(`begin${m.id}`); await new Promise((r) => { release = r; }); order.push('commit'); return m; },
    afterCommit: async () => { order.push('afterCommit'); },
  });
  await until(() => b.connections[0]?.ch.deliver);
  const ch = b.connections[0].ch;
  assert.equal(ch.prefetchValue, 16); assert.equal(ch.opts.noAck, false); assert.equal(ch.queue, 'cmd.A');
  ch.deliver({ id: 1 }); ch.deliver({ id: 2 }); await tick();
  assert.deepEqual(order, ['begin1']); assert.equal(ch.acks.length, 0);
  const stopped = consumer.stop(); await tick(); assert.equal(ch.cancelled, true);
  release(); await stopped;
  assert.deepEqual(order, ['begin1', 'commit', 'afterCommit']); assert.equal(ch.acks.length, 1);
  assert.equal(b.connections.length, 1); assert.equal(b.connections[0].closed, true);
});

test('temporary rollback reconnects with backoff, permanent envelope error dead-letters without hot requeue', async () => {
  const b = fakeBroker(); let attempt = 0;
  const consumer = startCommandConsumer({ url: 'amqp://test', parkingId: 'A', connect: b.connect, retryMs: 40, log: quiet,
    processCommand: async () => { if (attempt++ === 0) throw new Error('DB down'); throw new InvalidCommand('bad signature'); }, afterCommit() {},
  });
  await until(() => b.connections[0]?.ch.deliver); const old = b.connections[0];
  old.ch.deliver({ id: 1 }); await tick(); assert.equal(old.closed, true); assert.equal(b.connections.length, 1);
  assert.equal(old.ch.acks.length, 0); assert.equal(old.ch.nacks.length, 0);
  await until(() => b.connections[1]?.ch.deliver);
  b.connections[1].ch.deliver({ id: 2 }); await tick();
  assert.deepEqual(b.connections[1].ch.nacks[0].slice(1), [false, false]);
  await consumer.stop(); assert.equal(b.connections.length, 2);
});

test('reply publisher: mandatory return/nack/disconnect keep outbox pending; connection reused until loss', async () => {
  const b = fakeBroker(); const p = makeReplyPublisher('amqp://test', { connect: b.connect });
  const a = p.publish('agg.1', {}, { messageId: 'reply1', headers: {} }); await tick();
  const ch = b.connections[0].ch; const sent = ch.sent[0];
  assert.equal(sent[3].mandatory, true); assert.equal(sent[3].persistent, true);
  ch.emit('return', { properties: sent[3] }); sent[4](null); assert.equal(await a, false);
  const yes = p.publish('agg.1', {}, { messageId: 'reply2', headers: {} }); await tick(); ch.sent[1][4](null); assert.equal(await yes, true);
  const nack = p.publish('agg.1', {}, { headers: {} }); await tick(); ch.sent[2][4](new Error('message nacked')); assert.equal(await nack, false);
  const lost = p.publish('agg.1', {}, { headers: {} }); await tick(); await b.connections[0].close(); assert.equal(await lost, false);
  const retry = p.publish('agg.1', {}, { headers: {} }); await tick(); b.connections[1].ch.sent[0][4](null); assert.equal(await retry, true);
  assert.equal(b.connections.length, 2); await p.close();
});

test('PD-06 thiếu hàng đợi admin: ghi log một lần, consumer hàng thường vẫn nhận lệnh', async () => {
  const b = fakeBroker(); const infos = [];
  const consumer = startCommandConsumer({ url: 'amqp://test', parkingId: 'D', connect: b.connect,
    log: { error() {}, info: (msg) => infos.push(msg) }, processCommand: async (m) => m, afterCommit() {} });
  await until(() => b.connections[0]?.ch.deliver);
  const ch = b.connections[0].ch;
  assert.equal(ch.queue, 'cmd.D');
  ch.deliver({ id: 1 }); await tick();
  assert.equal(ch.acks.length, 1);
  assert.equal(b.connections[0].closed, false);
  assert.equal(infos.filter((m) => m.includes('quản trị')).length, 1);
  await consumer.stop();
});
