const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_RULES, invalidRule } = require('./pricing');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// Danh sách slot cần có. `slots` là số (SLOT_COUNT cũ: toàn ô tô, 10 chỗ/tầng)
// hoặc chuỗi SLOTS="CAR:1:10,CAR:2:10,MOTO:1:20" (loại:tầng:số lượng). Mã: ô tô A01.., xe máy AM01..
function slotPlan(prefix, slots) {
  const groups = typeof slots === 'number'
    ? Array.from({ length: Math.ceil(slots / 10) }, (_, i) => ['CAR', i + 1, Math.min(10, slots - i * 10)])
    : slots.split(',').map((g) => {
      const [t, f, n] = g.split(':');
      const group = [t?.trim().toUpperCase(), Number(f), Number(n)];
      if (!['CAR', 'MOTO'].includes(group[0]) || !(group[1] >= 1) || !(group[2] >= 0)) throw new Error(`SLOTS sai ở "${g}"`);
      return group;
    });
  const seq = {};
  return groups.flatMap(([type, floor, n]) => Array.from({ length: n }, () => {
    seq[type] = (seq[type] ?? 0) + 1;
    return { code: `${prefix}${type === 'MOTO' ? 'M' : ''}${String(seq[type]).padStart(2, '0')}`, floor, type };
  }));
}

const savePricing = (c, rules) => Promise.all(rules.map((r) => c.query(
  `INSERT INTO pricing_rules(vehicle_type, first_block_min, first_block_fee, next_hour_fee, overnight_fee, max_day_fee)
   VALUES ($1,$2,$3,$4,$5,$6)
   ON CONFLICT (vehicle_type) DO UPDATE SET first_block_min=$2, first_block_fee=$3, next_hour_fee=$4, overnight_fee=$5, max_day_fee=$6`,
  [r.vehicleType, r.firstBlockMin, r.firstBlockFee, r.nextHourFee, r.overnightFee, r.maxDayFee ?? null])));

// Tạo bảng (idempotent) rồi seed slot + bảng giá. Chạy lại khi khởi động không làm mất dữ liệu
// (giá đã sửa qua API được giữ: chỉ seed loại xe chưa có giá). `pricing` = mảng quy tắc (env PRICING).
async function init(pool, prefix, slots, pricing = DEFAULT_RULES) {
  await pool.query(schema);
  const plan = slotPlan(prefix, slots);
  await pool.query(
    `INSERT INTO parking_slots(slot_code, floor, type)
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[])
     ON CONFLICT (slot_code) DO NOTHING`,
    [plan.map((s) => s.code), plan.map((s) => s.floor), plan.map((s) => s.type)]);
  const bad = pricing.map(invalidRule).find(Boolean);
  if (bad) throw new Error(`PRICING sai: ${bad}`);
  const have = new Set((await pool.query('SELECT vehicle_type FROM pricing_rules')).rows.map((r) => r.vehicle_type));
  await savePricing(pool, pricing.filter((r) => !have.has(r.vehicleType)));
}

// PT-02: "pool chỉ đọc" — đọc bản sao (replica); bản sao lỗi thì đọc bản chính và bỏ qua bản sao `backoffMs`.
// CHỈ dùng cho truy vấn đọc không nằm trong luồng ghi: replica sao chép BẤT ĐỒNG BỘ nên có thể chậm vài trăm ms
// (vừa đặt chỗ xong mà đọc replica có thể chưa thấy -> luồng ghi luôn đọc bản chính).
function readThrough(replica, primary, { backoffMs = 10_000, onFallback } = {}) {
  let skipUntil = 0;
  return {
    async query(sql, params) {
      if (Date.now() >= skipUntil) {
        try { return await replica.query(sql, params); } catch (e) { skipUntil = Date.now() + backoffMs; onFallback?.(e); }
      }
      return primary.query(sql, params);
    },
  };
}

module.exports = { init, slotPlan, savePricing, readThrough };
