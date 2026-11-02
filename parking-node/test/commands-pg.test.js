// Opt-in PostgreSQL concurrency test; the e2e harness runs this inside an isolated parking container.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const source = process.env.PD02_SOURCE_ROOT ?? path.resolve(__dirname, '../src');
const { makeCommandProcessor } = require(path.join(source, 'commands'));
const { signature } = require(path.join(source, 'command-signature'));

test('PostgreSQL: concurrent duplicate transactions, same-slot contention, SQL failure and rollback', {
  skip: !process.env.PD02_REAL_DATABASE_URL,
}, async (t) => {
  const pool = new Pool({ connectionString: process.env.PD02_REAL_DATABASE_URL, max: 12 });
  const userId = `pgtest-${randomUUID()}`;
  const key = 'isolated-test-key';
  const slotCodes = Array.from({ length: 3 }, () => `T${randomUUID().replaceAll('-', '').slice(0, 8)}`);
  t.after(async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM command_reply_outbox WHERE command_id LIKE $1', [`${userId}:%`]);
      await c.query('DELETE FROM inbox_messages WHERE message_id LIKE $1', [`${userId}:%`]);
      await c.query('DELETE FROM reservations WHERE user_id=$1', [userId]);
      await c.query('DELETE FROM parking_events WHERE slot_code=ANY($1::text[])', [slotCodes]);
      await c.query('DELETE FROM parking_slots WHERE slot_code=ANY($1::text[])', [slotCodes]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); await pool.end(); }
  });
  for (const code of slotCodes) await pool.query('INSERT INTO parking_slots(slot_code) VALUES ($1)', [code]);
  const make = (id, slot, extra = {}) => {
    const body = { schemaVersion: 1, type: 'reserve', parkingId: 'A', actor: { userId, role: 'USER' },
      payload: { slotCode: slot, licensePlate: '30A-888.88', ...extra } };
    const properties = { messageId: `${userId}:${id}`, correlationId: `${userId}:${id}`, replyTo: 'test.pg', type: 'reserve', headers: {} };
    properties.headers['x-command-signature'] = signature(key, body, properties);
    return { content: Buffer.from(JSON.stringify(body)), properties, fields: { routingKey: 'cmd.A.reserve' } };
  };
  const run = makeCommandProcessor({ pool, parkingId: 'A', internalKey: key });
  const results = await Promise.all(Array.from({ length: 10 }, () => run(make('same', slotCodes[0]))));
  assert(results.every((r) => r.code === 201));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  // PostgreSQL JSONB may reorder object keys; compare the actual JSON values.
  for (const r of results) assert.deepEqual(r.body, results[0].body);
  const count = async (table, where, params) => Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params)).rows[0].n);
  assert.equal(await count('reservations', 'request_id=$1', [`${userId}:same`]), 1);
  assert.equal(await count('inbox_messages', 'message_id=$1', [`${userId}:same`]), 1);
  assert.equal(await count('command_reply_outbox', 'command_id=$1', [`${userId}:same`]), 10);
  assert.equal(Number((await pool.query('SELECT version FROM parking_slots WHERE slot_code=$1', [slotCodes[0]])).rows[0].version), 1);
  const race = await Promise.all(Array.from({ length: 10 }, (_, i) => run(make(`race-${i}`, slotCodes[1]))));
  assert.equal(race.filter((r) => r.code === 201).length, 1);
  assert.equal(race.filter((r) => r.code === 409).length, 9);
  assert.equal((await run(make('same', slotCodes[2]))).code, 422);
  const future = { startTime: new Date(Date.now() + 3600000).toISOString() };
  assert.equal((await run(make('future1', slotCodes[2], future))).code, 201);
  assert.equal((await run(make('future2', slotCodes[2], future))).body.error, 'TIME_CONFLICT');
  const brokenPool = { connect: async () => {
    const c = await pool.connect();
    return { release: () => c.release(), query: (sql, params) => {
      if (sql.startsWith('INSERT INTO command_reply_outbox')) throw new Error('injected outbox error');
      return c.query(sql, params);
    } };
  } };
  await assert.rejects(makeCommandProcessor({ pool: brokenPool, parkingId: 'A', internalKey: key })(make('rollback', slotCodes[2], {
    startTime: new Date(Date.now() + 12 * 3600000).toISOString(),
  })), /injected outbox error/);
  assert.equal(await count('inbox_messages', 'message_id=$1', [`${userId}:rollback`]), 0);
  assert.equal(await count('reservations', 'request_id=$1', [`${userId}:rollback`]), 0);
});
