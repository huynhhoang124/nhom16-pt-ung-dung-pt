const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEvent, reconcile, slotsFromCache } = require('../src/events');
const { startNode, startAggregator } = require('./helpers');

const ev = (slot, version, status = 'RESERVED', parkingId = 'A') => ({ parkingId, slot, version, status });

test('TC11 tin trùng và tin đến sai thứ tự bị bỏ nhờ version', () => {
  const cache = new Map();
  assert.equal(applyEvent(cache, ev('A01', 1)), true);
  assert.equal(applyEvent(cache, ev('A01', 3, 'AVAILABLE')), true);
  assert.equal(applyEvent(cache, ev('A01', 2, 'OCCUPIED')), false);   // đến muộn
  assert.equal(applyEvent(cache, ev('A01', 3, 'AVAILABLE')), false);  // trùng (relay gửi lại)
  assert.deepEqual(cache.get('A:A01'), { status: 'AVAILABLE', version: 3 });
  assert.equal(applyEvent(cache, ev('A01', 1, 'X', 'B')), true);      // bãi khác, khoá khác
});

test('slotsFromCache chỉ lấy đúng bãi, sắp theo mã', () => {
  const cache = new Map();
  applyEvent(cache, ev('A02', 1));
  applyEvent(cache, ev('A01', 4, 'OCCUPIED'));
  applyEvent(cache, ev('AB1', 1, 'X', 'AB'));
  assert.deepEqual(slotsFromCache(cache, 'A'), [
    { slotCode: 'A01', status: 'OCCUPIED', version: 4 },
    { slotCode: 'A02', status: 'RESERVED', version: 1 },
  ]);
});

test('TC13 đối soát: cache cũ được cập nhật theo DB bãi; chạy lại lần 2 không đổi gì (idempotent)', async (t) => {
  const a = await startNode('A', 3);
  const agg = await startAggregator({ A: a.url });
  t.after(() => { a.server.close(); agg.server.close(); });

  // Cache đang giữ bản cũ của A01; trong lúc đó bãi A đã có thay đổi mà Aggregator không nhận được tin.
  applyEvent(agg.cache, ev('A01', 0, 'AVAILABLE'));
  await a.pool.query(`UPDATE parking_slots SET status='OCCUPIED', version=5 WHERE slot_code='A01'`);

  const pushed = [];
  const n = agg.reg.get('A');
  assert.equal(await reconcile(agg.reg, agg.cache, n, (e) => pushed.push(e.slot)), 3);
  assert.deepEqual(agg.cache.get('A:A01'), { status: 'OCCUPIED', version: 5 });
  assert.deepEqual(pushed, ['A01', 'A02', 'A03']);
  assert.equal(await reconcile(agg.reg, agg.cache, n), 0);
});
