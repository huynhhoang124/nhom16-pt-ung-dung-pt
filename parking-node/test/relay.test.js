const test = require('node:test');
const assert = require('node:assert/strict');
const { makePool, one } = require('./helpers');
const s = require('../src/slots');
const { makeRelay } = require('../src/relay');

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
