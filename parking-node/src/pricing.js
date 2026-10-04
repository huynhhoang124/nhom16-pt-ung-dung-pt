// NV-03: tính phí gửi xe. Hàm thuần (không đụng DB) để test được mọi trường hợp biên.
// Giờ vào/ra lấy từ đồng hồ DB của bãi (now() khi xe ra), không lấy giờ máy khách.
//
// Một quy tắc giá (mỗi loại xe một dòng pricing_rules, mỗi bãi tự đặt):
//   - firstBlockMin phút đầu: firstBlockFee
//   - mỗi giờ tiếp theo (chưa đủ giờ tính tròn 1 giờ): nextHourFee
//   - mỗi 24 giờ tính riêng, tối đa maxDayFee (null = không trần)
//   - mỗi đêm (22:00–06:00 giờ Việt Nam) mà phiên chạm vào: cộng overnightFee (ngoài trần ngày)

const DEFAULT_RULES = [
  { vehicleType: 'CAR', firstBlockMin: 120, firstBlockFee: 25000, nextHourFee: 10000, overnightFee: 30000, maxDayFee: 150000 },
  { vehicleType: 'MOTO', firstBlockMin: 120, firstBlockFee: 5000, nextHourFee: 2000, overnightFee: 5000, maxDayFee: 20000 },
];

const DAY_MIN = 24 * 60;
const VN_OFFSET = 7 * 3600_000;   // Việt Nam UTC+7, không đổi giờ mùa hè

// Phí theo thời gian cho một đoạn <= 24 giờ.
function blockFee(rule, minutes) {
  if (minutes <= 0) return 0;
  const extraHours = Math.max(0, Math.ceil((minutes - rule.firstBlockMin) / 60));
  const fee = rule.firstBlockFee + extraHours * rule.nextHourFee;
  return rule.maxDayFee == null ? fee : Math.min(fee, rule.maxDayFee);
}

// Số đêm (khung 22:00–06:00 giờ VN) giao với [from, to).
function nightsTouched(from, to) {
  let n = 0;
  // ngày theo giờ VN của lúc vào, lùi 1 ngày để bắt cả đêm bắt đầu hôm trước
  const day0 = Math.floor((from.getTime() + VN_OFFSET) / 86400_000) - 1;
  for (let d = day0; ; d++) {
    const start = d * 86400_000 + 22 * 3600_000 - VN_OFFSET;   // 22:00 VN của ngày d, theo UTC
    if (start >= to.getTime()) break;
    if (start + 8 * 3600_000 > from.getTime()) n++;              // đêm kết thúc 06:00 hôm sau
  }
  return n;
}

function calcFee(rule, enteredAt, exitedAt) {
  const from = new Date(enteredAt);
  const to = new Date(exitedAt);
  const minutes = Math.ceil((to - from) / 60000);
  if (minutes < 1) return { fee: 0, minutes: 0, breakdown: [] };   // vào rồi ra ngay: không tính

  const days = Math.floor(minutes / DAY_MIN);
  const rest = minutes % DAY_MIN;
  const breakdown = [];
  if (days) breakdown.push({ label: `${days} ngày trọn`, amount: days * blockFee(rule, DAY_MIN) });
  if (rest) breakdown.push({ label: `${Math.floor(rest / 60)} giờ ${rest % 60} phút`, amount: blockFee(rule, rest) });
  const nights = nightsTouched(from, to);
  if (nights && rule.overnightFee) breakdown.push({ label: `Qua đêm x${nights}`, amount: nights * rule.overnightFee });
  return { fee: breakdown.reduce((s, b) => s + b.amount, 0), minutes, breakdown };
}

// Dòng DB (snake_case) <-> quy tắc (camelCase)
const fromRow = (r) => ({
  vehicleType: r.vehicle_type, firstBlockMin: r.first_block_min, firstBlockFee: r.first_block_fee,
  nextHourFee: r.next_hour_fee, overnightFee: r.overnight_fee, maxDayFee: r.max_day_fee,
});

// Kiểm quy tắc giá gửi lên (từ env PRICING hoặc API). Trả về thông báo lỗi, hoặc null nếu hợp lệ.
function invalidRule(r) {
  if (!['CAR', 'MOTO'].includes(r?.vehicleType)) return 'vehicleType must be CAR or MOTO';
  for (const k of ['firstBlockMin', 'firstBlockFee', 'nextHourFee', 'overnightFee']) {
    if (!Number.isInteger(r[k]) || r[k] < 0 || r[k] > 10_000_000) return `${k} must be an integer 0..10000000`;
  }
  if (r.firstBlockMin < 1) return 'firstBlockMin must be >= 1';
  if (r.maxDayFee != null && (!Number.isInteger(r.maxDayFee) || r.maxDayFee < 0)) return 'maxDayFee must be null or an integer >= 0';
  return null;
}

module.exports = { calcFee, nightsTouched, DEFAULT_RULES, fromRow, invalidRule };
