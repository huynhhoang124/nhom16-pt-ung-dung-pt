const test = require('node:test');
const assert = require('node:assert/strict');
const { calcFee, DEFAULT_RULES, invalidRule } = require('../src/pricing');

const CAR = DEFAULT_RULES[0];   // 120' đầu 25k, mỗi giờ sau 10k, qua đêm +30k, trần 150k/ngày
const fee = (from, to) => calcFee(CAR, `${from}+07:00`, `${to}+07:00`).fee;

test('TC24 tính phí: các mốc biên theo thời gian', () => {
  assert.equal(fee('2026-10-05T10:00:00', '2026-10-05T10:00:00'), 0);       // vào rồi ra ngay
  assert.equal(fee('2026-10-05T10:00:00', '2026-10-05T10:04:59'), 0);       // dưới 5 phút: miễn phí
  assert.equal(fee('2026-10-05T10:00:00', '2026-10-05T10:05:00'), 25000);   // từ 5 phút: tính block đầu
  assert.equal(fee('2026-10-05T10:00:00', '2026-10-05T12:00:00'), 25000);   // đúng 120 phút
  assert.equal(fee('2026-10-05T10:00:00', '2026-10-05T12:01:00'), 35000);   // 121 phút: tròn lên 1 giờ
  assert.equal(fee('2026-10-05T10:00:00', '2026-10-05T15:30:00'), 65000);   // 330' = 120' + 4 giờ
  assert.equal(fee('2026-10-05T06:00:00', '2026-10-05T21:59:00'), 150000);  // chạm trần ngày
});

test('TC24 tính phí: qua đêm theo giờ Việt Nam', () => {
  assert.equal(fee('2026-10-05T20:00:00', '2026-10-05T21:59:00'), 25000);           // chưa tới 22:00
  assert.equal(fee('2026-10-05T20:00:00', '2026-10-05T22:00:00'), 25000);           // ra đúng 22:00: chưa chạm đêm
  assert.equal(fee('2026-10-05T21:00:00', '2026-10-05T23:00:00'), 25000 + 30000);   // chạm đêm
  assert.equal(fee('2026-10-05T05:00:00', '2026-10-05T07:00:00'), 25000 + 30000);   // đêm bắt đầu từ hôm trước
  // 35 giờ, qua 2 đêm: 1 ngày trọn (150k) + 11 giờ (25k + 9 x 10k) + 2 đêm
  const r = calcFee(CAR, '2026-10-05T20:00:00+07:00', '2026-10-07T07:00:00+07:00');
  assert.equal(r.fee, 150000 + 115000 + 60000);
  assert.deepEqual(r.breakdown.map((b) => b.label), ['1 ngày trọn', '11 giờ 0 phút', 'Qua đêm x2']);
});

test('quy tắc giá: kiểm dữ liệu gửi lên', () => {
  assert.equal(invalidRule(CAR), null);
  assert.match(invalidRule({ ...CAR, vehicleType: 'BUS' }), /vehicleType/);
  assert.match(invalidRule({ ...CAR, nextHourFee: -1 }), /nextHourFee/);
  assert.match(invalidRule({ ...CAR, firstBlockFee: 1.5 }), /firstBlockFee/);
  assert.equal(invalidRule({ ...CAR, maxDayFee: null }), null);
});
