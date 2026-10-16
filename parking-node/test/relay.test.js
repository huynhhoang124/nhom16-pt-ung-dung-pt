const test = require('node:test');
const assert = require('node:assert/strict');
const { makePool, one } = require('./helpers');
const s = require('../src/slots');
const { makeRelay } = require('../src/relay');
const { withRequestId } = require('../src/log');

test('GS-03 relay ghi đúng request ID từ outbox chỉ sau broker confirm và đánh dấu đã gửi', async () => {
  const pool = await makePool();
  await new Promise((resolve, reject) => withRequestId(
    { get: () => 'gs03-relay-trace' }, { set() {}, on() {} },
    () => s.reserve(pool, 'A', { requestId: 'idempotency-key-khac', userId: 'u', slotCode: 'A01', licensePlate: 'p' }).then(resolve, reject),
  ));
  const logs = [];
  let confirmed = false;
  const relay = makeRelay(pool, async () => confirmed, { info: (msg, fields) => logs.push({ msg, ...fields }) });
  assert.equal(await relay(), 0);
  assert.deepEqual(logs, []);
  confirmed = true;
  assert.equal(await relay(), 1);
  const event = await one(pool, 'SELECT id, published_at FROM parking_events');
  assert.ok(event.published_at);
  assert.deepEqual(logs, [{ msg: 'outbox đã gửi', requestId: 'gs03-relay-trace', eventId: event.id,
    type: 'RESERVED', routingKey: 'parking.A.slot.A01' }]);
  assert.equal(await relay(), 0);
  assert.equal(logs.length, 1);
});

const unpublished = async (pool) =>
  (await one(pool, 'SELECT count(*)::int AS c FROM parking_events WHERE published_at IS NULL')).c;

async function poolWith3Events() {
  const pool = await makePool();
  await s.reserve(pool, 'A', { requestId: 'r1', userId: 'u', slotCode: 'A01', licensePlate: 'p' });
  await s.moveSlot(pool, 'A', 'A01', ['RESERVED'], 'OCCUPIED', 'CAR_ENTER');
  await s.moveSlot(pool, 'A', 'A01', ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT');
  return pool;
}

test('broker lỗi: không đánh dấu gì; broker khoẻ lại: gửi đủ theo thứ tự, không gửi lặp', async () => {
  const pool = await poolWith3Events();
  const sent = [];
  let up = false;
  const relayOnce = makeRelay(pool, async (key, payload) => (up ? (sent.push([key, payload.version]), true) : false));

  assert.equal(await relayOnce(), 0);
  assert.equal(await unpublished(pool), 3);

  up = true;
  assert.equal(await relayOnce(), 3);
  assert.deepEqual(sent, [['parking.A.slot.A01', 1], ['parking.A.slot.A01', 2], ['parking.A.slot.A01', 3]]);
  assert.equal(await unpublished(pool), 0);
  assert.equal(await relayOnce(), 0);
});

test('broker lỗi giữa chừng: dừng ở tin lỗi, lần sau gửi tiếp đúng thứ tự', async () => {
  const pool = await poolWith3Events();
  const sent = [];
  let calls = 0;
  const relayOnce = makeRelay(pool, async (_k, p) => (++calls === 2 ? false : (sent.push(p.version), true)));
  assert.equal(await relayOnce(), 1);
  assert.equal(await relayOnce(), 2);
  assert.deepEqual(sent, [1, 2, 3]);
});

test('không chạy chồng khi lần trước chưa xong', async () => {
  const pool = await poolWith3Events();
  let release;
  const gate = new Promise((r) => { release = r; });
  const relayOnce = makeRelay(pool, async () => { await gate; return true; });
  const first = relayOnce();
  assert.equal(await relayOnce(), 0);   // lần gọi thứ hai bỏ qua ngay
  release();
  assert.equal(await first, 3);
});
