// GS-05/GS-06: kiểm các BẤT BIẾN của hệ thống sau khi chạy tải / gây lỗi (đọc thẳng DB từng bãi qua docker compose).
//   node tests/load/check-invariants.mjs
// 1. Không có hai lượt đặt còn hiệu lực chồng giờ trên cùng slot (không đặt trùng)
// 2. Outbox mọi bãi đã gửi hết (không mất sự kiện) — chờ tối đa 60 s cho relay gửi nốt
// 3. Mỗi request_id (Idempotency-Key) ứng với tối đa 1 lượt đặt
// 4. Mỗi slot tối đa 1 phiên gửi xe đang mở
import { execSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url);
const sql = (db, q) => execSync(`docker compose exec -T ${db} psql -U postgres -d parking -tAc "${q}"`, { cwd: ROOT, encoding: 'utf8' }).trim();
const DBS = ['db-a', 'db-b', 'db-c'];
const checks = {
  'đặt chồng giờ': `SELECT count(*) FROM reservations a JOIN reservations b ON a.slot_id=b.slot_id AND a.id<b.id
    AND a.status IN ('ACTIVE','USED') AND b.status IN ('ACTIVE','USED')
    AND tstzrange(a.start_time,a.end_time) && tstzrange(b.start_time,b.end_time)`,
  'request_id trùng': `SELECT count(*) FROM (SELECT request_id FROM reservations GROUP BY request_id HAVING count(*)>1) t`,
  'slot có 2 phiên mở': `SELECT count(*) FROM (SELECT slot_id FROM parking_sessions WHERE exited_at IS NULL GROUP BY slot_id HAVING count(*)>1) t`,
};

let bad = 0;
for (const db of DBS) {
  for (const [name, q] of Object.entries(checks)) {
    const n = Number(sql(db, q.replace(/\s+/g, ' ')));
    console.log(`${n === 0 ? 'ĐẠT ' : 'LỖI '} ${db}: ${name} = ${n}`);
    if (n) bad++;
  }
  let left;
  for (let i = 0; i < 60; i++) {
    left = Number(sql(db, 'SELECT count(*) FROM parking_events WHERE published_at IS NULL'));
    if (!left) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`${left === 0 ? 'ĐẠT ' : 'LỖI '} ${db}: outbox chưa gửi = ${left}`);
  if (left) bad++;
}
console.log(bad ? `\n${bad} bất biến bị vi phạm` : '\nMọi bất biến đều đạt');
process.exit(bad ? 1 : 0);
