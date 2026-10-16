const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRules } = require('../src/rules');

const ev = (o) => ({ parkingId: 'B', slot: 'B05', available: 20, total: 30, ...o });

test('NV-08 thông báo cho đúng người theo loại sự kiện', () => {
  const rules = makeRules();
  assert.deepEqual(rules(ev({ type: 'RESERVATION_EXPIRING', userId: 'u1', expireTime: '2026-10-05T03:15:00Z' })),
    [{ to: 'u1', kind: 'error', text: 'Chỗ B05 (bãi B) chỉ giữ đến 10:15. Hãy đến kịp hoặc huỷ để nhường chỗ.' }]);
  assert.equal(rules(ev({ type: 'RESERVATION_MOVED', userId: 'u1' }))[0].to, 'u1');
  assert.deepEqual(rules(ev({ type: 'CAR_EXIT' })), []);              // không có người nhận
  assert.deepEqual(rules(ev({ type: 'EXPIRED' })), []);               // thiếu userId thì không gửi
});

test('NV-08 bãi sắp đầy: báo mọi người 1 lần dưới 10%, chỉ báo lại sau khi đã lên trên 20%', () => {
  const rules = makeRules();
  const full = (available) => rules(ev({ type: 'CAR_ENTER', available })).filter((n) => n.to === '*');
  assert.equal(full(2).length, 1);          // 2/30 < 10%
  assert.equal(full(1).length, 0);          // đã báo rồi
  assert.equal(full(5).length, 0);          // 16%: chưa qua ngưỡng đặt lại
  assert.equal(full(2).length, 0);
  assert.equal(full(7).length, 0);          // 23% > 20%: đặt lại
  assert.equal(full(2).length, 1);          // lại xuống thấp: báo lần nữa
});
