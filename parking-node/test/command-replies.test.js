const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { makeReplyPublisher, makeReplyRelay } = require('../src/command-replies');
const { makePool, one } = require('./helpers');
const tick = () => new Promise(setImmediate);

test('failed reply is retained with retry metadata; later valid reply is delivered and failed row can recover', async (t) => {
  const pool = await makePool(); t.after(() => pool.db.close());
  // Simulate an existing deployment's old outbox before re-running the additive schema.
  await pool.query(`ALTER TABLE command_reply_outbox DROP COLUMN attempts,DROP COLUMN last_attempt_at,
    DROP COLUMN last_error,DROP COLUMN next_attempt_at`);
  await pool.query(`INSERT INTO command_reply_outbox(command_id,reply_to,payload,properties)
    VALUES ('bad','missing','{}','{}'),('good','agg.1','{}','{}')`);
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8'));
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox')).n, 2);
  let repaired = false;
  const calls = [];
  const relay = makeReplyRelay(pool, async (key) => {
    calls.push(key);
    return key === 'missing' && !repaired
      ? { ok: false, scope: 'record', code: 'REPLY_UNROUTABLE' } : { ok: true };
  });
  assert.equal(await relay(), 1);
  assert.deepEqual(calls, ['missing', 'agg.1']);
  let bad = await one(pool, "SELECT * FROM command_reply_outbox WHERE command_id='bad'");
  assert.equal(bad.published_at, null);
  assert.equal(bad.attempts, 1);
  assert.equal(bad.last_error, 'REPLY_UNROUTABLE');
  assert.ok(bad.last_attempt_at && bad.next_attempt_at > bad.last_attempt_at);
  assert.ok((await one(pool, "SELECT published_at FROM command_reply_outbox WHERE command_id='good'")).published_at);
  assert.equal(await relay(), 0, 'bad row is deferred instead of hot retried');
  repaired = true;
  await pool.query("UPDATE command_reply_outbox SET next_attempt_at=now() WHERE command_id='bad'");
  assert.equal(await relay(), 1);
  bad = await one(pool, "SELECT * FROM command_reply_outbox WHERE command_id='bad'");
  assert.equal(bad.attempts, 2);
  assert.ok(bad.published_at);
  assert.equal(bad.last_error, null);
  assert.equal(bad.next_attempt_at, null);
});

test('one hundred unroutable rows cannot starve the next batch; infrastructure failure stops the turn', async (t) => {
  const pool = await makePool(); t.after(() => pool.db.close());
  await pool.query(`INSERT INTO command_reply_outbox(command_id,reply_to,payload,properties)
    SELECT 'bad-'||n,'missing','{}','{}' FROM generate_series(1,100) n`);
  await pool.query(`INSERT INTO command_reply_outbox(command_id,reply_to,payload,properties) VALUES ('good','agg.1','{}','{}')`);
  const relay = makeReplyRelay(pool, async (key) => key === 'missing'
    ? { ok: false, scope: 'record', code: 'REPLY_UNROUTABLE' } : true);
  assert.equal(await relay(), 0);
  assert.equal(await relay(), 1);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox WHERE published_at IS NULL')).n, 100);
  await pool.query('UPDATE command_reply_outbox SET next_attempt_at=now() WHERE published_at IS NULL');
  let calls = 0;
  const unavailable = makeReplyRelay(pool, async () => { calls++; return { ok: false, scope: 'infrastructure', code: 'REPLY_NACKED' }; });
  assert.equal(await unavailable(), 0);
  assert.equal(calls, 16);
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM command_reply_outbox WHERE last_error='REPLY_NACKED'")).n, 16);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox WHERE published_at IS NULL')).n, 100);
});

test('database/publisher infrastructure errors preserve rows; overlapping relay calls do not publish twice', async (t) => {
  const pool = await makePool(); t.after(() => pool.db.close());
  await pool.query(`INSERT INTO command_reply_outbox(command_id,reply_to,payload,properties) VALUES ('one','agg.1','{}','{}')`);
  const error = new Error('DB unavailable');
  await assert.rejects(makeReplyRelay({ query: async () => { throw error; } }, () => assert.fail())(), error);
  await assert.rejects(makeReplyRelay(pool, async () => { throw error; })(), error);
  let finish, started;
  const entered = new Promise((r) => { started = r; });
  const relay = makeReplyRelay(pool, () => new Promise((r) => { finish = r; started(); }));
  const active = relay(); await entered;
  assert.equal(await relay(), 0);
  finish(true);
  assert.equal(await active, 1);
  assert.equal((await one(pool, 'SELECT attempts FROM command_reply_outbox')).attempts, 1);
});

test('detailed publisher correlates concurrent returns/confirms and distinguishes record from infrastructure errors', async (t) => {
  const conn = new EventEmitter(), ch = new EventEmitter(), sent = [];
  conn.close = async () => conn.emit('close');
  conn.createConfirmChannel = async () => ch;
  ch.assertExchange = async () => {};
  ch.publish = (...args) => sent.push(args);
  let connections = 0;
  const publisher = makeReplyPublisher('amqp://test', { connect: async () => { connections++; return conn; } });
  t.after(() => publisher.close());
  const bad = publisher.publishDetailed('missing', {}, {});
  const good = publisher.publishDetailed('agg.1', {}, {});
  await tick();
  assert.equal(connections, 1);
  ch.emit('return', { properties: sent[0][3] });
  sent[1][4](null); sent[0][4](null);
  assert.deepEqual(await bad, { ok: false, scope: 'record', code: 'REPLY_UNROUTABLE' });
  assert.deepEqual(await good, { ok: true });
  const publish = ch.publish;
  ch.publish = () => { throw new TypeError('invalid AMQP property'); };
  assert.equal((await publisher.publishDetailed('agg.1', {}, {})).code, 'REPLY_INVALID_RECORD');
  ch.publish = publish;
  const nack = publisher.publishDetailed('agg.1', {}, {}); await tick();
  sent[2][4](new Error('nack'));
  assert.equal((await nack).scope, 'infrastructure');
  const lost = publisher.publishDetailed('agg.1', {}, {}); await tick();
  conn.emit('close');
  assert.equal((await lost).scope, 'infrastructure');
  const circular = {}; circular.self = circular;
  assert.deepEqual(await publisher.publishDetailed('agg.1', circular, {}), { ok: false, scope: 'record', code: 'REPLY_INVALID_RECORD' });
});

test('reply committed while the relay is waiting for confirm triggers another pass', async t => {
  const pool = await makePool();
  t.after(() => pool.db.close());
  const insert = id => pool.query(
    "INSERT INTO command_reply_outbox(command_id,reply_to,payload,properties) VALUES ($1,'agg.1','{}','{}')",
    [id],
  );
  await insert('first');
  let confirm;
  let started;
  const publishing = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { confirm = resolve; });
  const delivered = [];
  const relay = makeReplyRelay(pool, async () => {
    delivered.push(delivered.length + 1);
    if (delivered.length === 1) { started(); await blocked; }
    return true;
  });
  const first = relay();
  await publishing;
  await insert('second');
  await relay();
  confirm();
  assert.equal(await first, 2);
  assert.equal(delivered.length, 2);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox WHERE published_at IS NULL')).n, 0);
});

test('reply relay pipelines confirms but never marks an unconfirmed row as published', async t => {
  const pool = await makePool();
  t.after(() => pool.db.close());
  await pool.query(`INSERT INTO command_reply_outbox(command_id,reply_to,payload,properties)
    VALUES ('first','agg.1','{}','{}'),('second','agg.2','{}','{}')`);
  let confirm;
  const blocked = new Promise(resolve => { confirm = resolve; });
  const sent = [];
  const relay = makeReplyRelay(pool, async key => {
    sent.push(key);
    if (key === 'agg.1') await blocked;
    return true;
  });
  const active = relay();
  try {
    for (let i = 0; i < 50 && sent.length < 2; i++) await tick();
    assert.deepEqual(sent, ['agg.1', 'agg.2']);
    assert.equal((await one(pool, "SELECT published_at FROM command_reply_outbox WHERE command_id='first'")).published_at, null);
  } finally {
    confirm();
    await active;
  }
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox WHERE published_at IS NULL')).n, 0);
});

test('database loss after a batch of broker confirms retains every reply for recovery', async t => {
  const pool = await makePool();
  t.after(() => pool.db.close());
  await pool.query(`INSERT INTO command_reply_outbox(command_id,reply_to,payload,properties)
    VALUES ('one','agg.1','{}','{}'),('two','agg.2','{}','{}')`);
  let fail = true;
  const guarded = { query: async (sql, params) => {
    if (fail && sql.includes('SET published_at=now()')) throw new Error('lost DB connection');
    return pool.query(sql, params);
  } };
  const sent = [];
  const relay = makeReplyRelay(guarded, async key => { sent.push(key); return true; });
  await assert.rejects(relay(), /lost DB connection/);
  assert.deepEqual(sent, ['agg.1', 'agg.2']);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox WHERE published_at IS NULL')).n, 2);
  fail = false;
  assert.equal(await relay(), 2);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM command_reply_outbox WHERE published_at IS NULL')).n, 0);
});
