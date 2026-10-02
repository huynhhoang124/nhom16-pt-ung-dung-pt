const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// Tạo bảng (idempotent) rồi seed slot A01..A20. Chạy lại khi khởi động không làm mất dữ liệu.
async function init(pool, prefix, count) {
  await pool.query(schema);
  const codes = Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);
  await pool.query(
    `INSERT INTO parking_slots(slot_code, floor)
     SELECT code, 1 + (ord - 1) / 10 FROM unnest($1::text[]) WITH ORDINALITY AS t(code, ord)
     ON CONFLICT (slot_code) DO NOTHING`, [codes]);
}

module.exports = { init };
