const test = require('node:test');
const assert = require('node:assert/strict');
const { makePool, one } = require('./helpers');
const { signature } = require('../src/command-signature');
const { makeCommandProcessor } = require('../src/commands');

const key = 'saga-test-key';
const sagaId = '11111111-1111-4111-8111-111111111111';
const actor = { userId: 'user1', role: 'USER' };

function message(i, type, payload, fencingToken = 10) {
  const id = `${sagaId}:${i}:${type}`;
  const body = { schemaVersion: 1, parkingId: 'A', type, actor, payload: { ...payload, sagaId, step: i }, fencingToken };
  const properties = { messageId: id, correlationId: id, replyTo: 'agg.test', type, headers: { fencingToken } };
  properties.headers['x-command-signature'] = signature(key, body, properties);
  return { content: Buffer.from(JSON.stringify(body)), properties, fields: { routingKey: `cmd.A.${type}` } };
}

test('saga giữ PENDING_SAGA tới khi confirm; cancel và fencing bảo vệ các bước', async (t) => {
  const pool = await makePool('A', 3); t.after(() => pool.db.close());
  const process = makeCommandProcessor({ pool, parkingId: 'A', internalKey: key });
  const reserve = await process(message(0, 'reserve', { slotCode: 'A01', licensePlate: '30A-123.45' }));
  assert.equal(reserve.code, 201);
  assert.equal((await one(pool, 'SELECT status FROM reservations WHERE id=$1', [reserve.body.id])).status, 'PENDING_SAGA');
  assert.equal((await process(message(0, 'confirm', { reservationId: reserve.body.id }))).code, 200);
  assert.equal((await one(pool, 'SELECT status FROM reservations WHERE id=$1', [reserve.body.id])).status, 'ACTIVE');
  const second = await process(message(1, 'reserve', { slotCode: 'A02', licensePlate: '30A-123.46' }));
  assert.equal((await process(message(1, 'cancel', { reservationId: second.body.id }))).code, 200);
  assert.equal((await one(pool, 'SELECT status FROM parking_slots WHERE slot_code=$1', ['A02'])).status, 'AVAILABLE');
  const stale = await process(message(2, 'reserve', { slotCode: 'A03', licensePlate: '30A-123.47' }, 9));
  assert.equal(stale.body.error, 'STALE_LEADER');
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM reservations WHERE slot_id=(SELECT id FROM parking_slots WHERE slot_code=$1)', ['A03'])).n, 0);
});

test('lệnh saga sai ID hoặc xác nhận đặt chỗ người khác bị từ chối', async (t) => {
  const pool = await makePool('A', 2); t.after(() => pool.db.close());
  const process = makeCommandProcessor({ pool, parkingId: 'A', internalKey: key });
  const ordinary = await process((() => {
    const m = message(0, 'reserve', { slotCode: 'A01', licensePlate: '30A-123.45' });
    const body = JSON.parse(m.content); delete body.payload.sagaId;
    m.properties.messageId = 'user1:ordinary'; m.properties.correlationId = 'user1:ordinary';
    m.content = Buffer.from(JSON.stringify(body));
    m.properties.headers['x-command-signature'] = signature(key, body, m.properties);
    return m;
  })());
  assert.equal(ordinary.code, 201);
  assert.equal((await process(message(1, 'confirm', { reservationId: ordinary.body.id }))).code, 404);
  const invalid = message(0, 'reserve', { slotCode: 'A02', licensePlate: '30A-123.46' });
  invalid.properties.messageId = `${sagaId}:0:cancel`;
  assert.throws(() => require('../src/commands').decodeCommand(invalid, 'A', key));
});
