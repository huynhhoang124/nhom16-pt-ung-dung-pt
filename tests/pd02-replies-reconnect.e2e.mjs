// Run only on the explicitly isolated pd02-fix project/ports (see runbook).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../parking-node/package.json', import.meta.url));
const amqp = require('amqplib'), { Pool } = require('pg');
const { startCommandConsumer } = require('../parking-node/src/commands');
const enabled = process.env.RUN_PD02_FIXES === '1';
const url = process.env.PD02_AMQP_URL ?? 'amqp://parking:parking@localhost:5674/%2F';
const tick = () => new Promise(setImmediate);
async function until(fn) {
  const end = Date.now() + 20000;
  do {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < end);
  throw new Error('Timed out waiting for actual broker/DB evidence');
}

test('PD-02 clean Docker: unroutable reply cannot block a later reply; repair retries retained record', { skip: !enabled }, async (t) => {
  const pool = new Pool({ connectionString: process.env.PD02_FIX_DATABASE_URL ?? 'postgres://postgres:dev@localhost:25432/parking' });
  const conn = await amqp.connect(url), ch = await conn.createChannel();
  const id = `pd02-fix-${randomUUID()}`, missing = id + '.missing', valid = id + '.valid';
  t.after(async () => {
    await pool.query('DELETE FROM command_reply_outbox WHERE command_id=ANY($1::text[])', [[id + '-bad', id + '-good']]);
    await ch.close(); await conn.close(); await pool.end();
  });
  await ch.assertExchange('parking.replies', 'direct', { durable: true });
  const { queue } = await ch.assertQueue('', { exclusive: true });
  await ch.bindQueue(queue, 'parking.replies', valid);
  const replies = [];
  await ch.consume(queue, (m) => { if (m) { replies.push(JSON.parse(m.content)); ch.ack(m); } });
  await pool.query(`INSERT INTO command_reply_outbox(command_id,reply_to,payload,properties)
    VALUES ($1,$2,$3,$4),($5,$6,$7,$8)`, [
    id + '-bad', missing, { fixture: id + '-bad' }, { messageId: id + '-bad', headers: {} },
    id + '-good', valid, { fixture: id + '-good' }, { messageId: id + '-good', headers: {} },
  ]);
  await until(async () => replies.some((r) => r.fixture === id + '-good') &&
    (await pool.query('SELECT published_at FROM command_reply_outbox WHERE command_id=$1', [id + '-good'])).rows[0]?.published_at);
  let rows = (await pool.query('SELECT * FROM command_reply_outbox WHERE command_id=ANY($1::text[]) ORDER BY id', [[id + '-bad', id + '-good']])).rows;
  assert.equal(rows[0].published_at, null);
  assert.equal(rows[0].last_error, 'REPLY_UNROUTABLE');
  assert.equal(rows[0].attempts, 1);
  assert.ok(rows[1].published_at);
  assert.ok(rows[0].next_attempt_at > rows[0].last_attempt_at);
  await ch.bindQueue(queue, 'parking.replies', missing);
  await pool.query('UPDATE command_reply_outbox SET next_attempt_at=now() WHERE command_id=$1', [id + '-bad']);
  await until(async () => replies.some((r) => r.fixture === id + '-bad') &&
    (await pool.query('SELECT published_at FROM command_reply_outbox WHERE command_id=$1', [id + '-bad'])).rows[0]?.published_at);
  rows = (await pool.query('SELECT * FROM command_reply_outbox WHERE command_id=$1', [id + '-bad'])).rows;
  assert.equal(rows[0].attempts, 2);
  assert.ok(rows[0].published_at);
  assert.equal(rows[0].last_error, null);
});

test('PD-02 clean Docker: real missing-queue channel errors back off to 60s; reset and shutdown use a controlled clock', { skip: !enabled }, async (t) => {
  const pending = new Map(), delays = [], connections = [];
  let timerId = 0, attempts = 0, ready = false;
  const parkingId = 'Fix' + randomUUID().replaceAll('-', '').slice(0, 10), queue = `cmd.${parkingId}`;
  const conn = await amqp.connect(url), ch = await conn.createChannel();
  let consumer;
  const created = [];
  t.after(async () => { await consumer?.stop(); for (const q of created) await ch.deleteQueue(q); await ch.close(); await conn.close(); });
  const timers = {
    setTimeout(fn, delay) { delays.push(delay); pending.set(++timerId, fn); return timerId; },
    clearTimeout(id) { pending.delete(id); },
  };
  consumer = startCommandConsumer({ url, parkingId, timers,
    connect: async (u) => { attempts++; const c = await amqp.connect(u); connections.push(c); return c; },
    processCommand: async () => {}, afterCommit() {},
    log: { error() {}, info: (_msg, meta) => { if (meta?.queue === queue + '.admin') ready = true; } },
  });
  for (let i = 0; i < 5; i++) {
    await until(() => pending.size === 1);
    const [id, fn] = pending.entries().next().value;
    pending.delete(id); fn();
  }
  await until(() => pending.size === 1);
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000]);
  for (const q of [queue, queue + '.admin']) {
    await ch.assertQueue(q, { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-single-active-consumer': true } });
    created.push(q);
  }
  const [id, fn] = pending.entries().next().value; pending.delete(id); fn();
  await until(() => ready);
  assert.equal(pending.size, 0);
  await connections.at(-1).close();
  await until(() => pending.size === 1);
  assert.equal(delays.at(-1), 5000);
  const before = attempts;
  await consumer.stop(); await tick();
  assert.equal(pending.size, 0);
  assert.equal(attempts, before);
  assert.equal((await ch.checkQueue(queue)).consumerCount, 0);
  assert.equal((await ch.checkQueue(queue + '.admin')).consumerCount, 0);
});
