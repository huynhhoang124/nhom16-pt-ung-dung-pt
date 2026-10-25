const test = require('node:test');
const assert = require('node:assert/strict');
const { makePool, one } = require('./helpers');
const { signature, verifySignature } = require('../src/command-signature');
const { makeCommandProcessor } = require('../src/commands');

const key = 'pd03-test-key';
const actor = { userId: 'u42', role: 'USER' };

function command(id, payload = { slotCode: 'A01', licensePlate: '30A-123.45' }) {
  const body = {
    schemaVersion: 1,
    parkingId: 'A',
    type: 'reserve',
    actor,
    payload,
    traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
  };
  const properties = {
    messageId: `${actor.userId}:${id}`,
    correlationId: `${actor.userId}:${id}`,
    replyTo: 'agg.1',
    type: 'reserve',
    headers: {
      schemaVersion: 1,
      actor,
      traceparent: body.traceparent,
    },
  };
  properties.headers['x-command-signature'] = signature(key, body, properties);
  return {
    content: Buffer.from(JSON.stringify(body)),
    properties,
    fields: { routingKey: 'cmd.A.reserve' },
  };
}

test('command inbox commits reservation, event and signed reply atomically and replays idempotently', async (t) => {
  const pool = await makePool('A', 2);
  t.after(() => pool.db.close());
  const processCommand = makeCommandProcessor({ pool, parkingId: 'A', internalKey: key });

  const first = await processCommand(command('reserve-1'));
  const replay = await processCommand(command('reserve-1'));

  assert.equal(first.code, 201);
  assert.equal(replay.code, 201);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.body.id, first.body.id);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM reservations')).n, 1);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM parking_events')).n, 1);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM inbox_messages')).n, 1);

  const replies = (await pool.query('SELECT payload, properties FROM command_reply_outbox ORDER BY id')).rows;
  assert.equal(replies.length, 2);
  for (const reply of replies) {
    const replyProperties = {
      ...reply.properties,
      headers: {
        ...reply.properties.headers,
        'x-command-signature': reply.properties.headers['x-reply-signature'],
      },
    };
    assert.equal(verifySignature(key, reply.payload, replyProperties), true);
    assert.equal(reply.payload.type, 'COMMAND_RESULT');
    assert.equal(reply.payload.statusCode, 201);
  }
});

test('business conflict is persisted and leaves the outer inbox transaction usable', async (t) => {
  const pool = await makePool('A', 2);
  t.after(() => pool.db.close());
  const processCommand = makeCommandProcessor({ pool, parkingId: 'A', internalKey: key });
  const payload = { slotCode: 'A01', licensePlate: '30A-123.45' };

  assert.equal((await processCommand(command('first', payload))).code, 201);
  const rejected = await processCommand(command('second', payload));

  assert.deepEqual([rejected.code, rejected.body], [409, { error: 'SLOT_TAKEN' }]);
  assert.equal((await processCommand(command('second', payload))).body.error, 'SLOT_TAKEN');
  assert.equal((await one(pool, "SELECT status_code FROM inbox_messages WHERE message_id='u42:second'")).status_code, 409);
  assert.equal((await one(pool, 'SELECT 1 AS healthy')).healthy, 1);
});
