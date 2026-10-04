const fs = require('node:fs');
const path = require('node:path');

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

// Tạo bảng (idempotent) rồi seed slot. Chạy lại khi khởi động không làm mất dữ liệu.
async function init(pool, prefix, slots) {
  await pool.query(schema);
  const plan = slotPlan(prefix, slots);
  await pool.query(
    `INSERT INTO parking_slots(slot_code, floor, type)
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[])
     ON CONFLICT (slot_code) DO NOTHING`,
    [plan.map((s) => s.code), plan.map((s) => s.floor), plan.map((s) => s.type)]);
}

module.exports = { init, slotPlan };
