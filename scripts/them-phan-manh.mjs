#!/usr/bin/env node
// PD-16: thêm phân mảnh users (2 -> 3) và chuyển các username đổi chủ theo vòng băm.
// Chạy trong container aggregator (có pg, có mạng tới các DB, có sẵn DATABASE_URL và USERS_DATABASE_URLS):
//   docker compose --profile shard3 up -d db-users-3
//   docker compose cp scripts/them-phan-manh.mjs aggregator:/tmp/them-phan-manh.mjs
//   docker compose exec -T aggregator node /tmp/them-phan-manh.mjs --add postgres://postgres:dev@db-users-3/parking --dry-run
//   docker compose exec -T aggregator node /tmp/them-phan-manh.mjs --add postgres://postgres:dev@db-users-3/parking
//   -> đặt USERS_DATABASE_URLS mới cho mọi Aggregator, khởi động lại (chuyển đọc), rồi:
//   docker compose exec -T aggregator node /tmp/them-phan-manh.mjs --cleanup
// Trong lúc chuyển, cờ write_blocked ở db-agg làm Aggregator trả 503 cho đăng ký/đổi mật khẩu; đăng nhập (chỉ đọc) vẫn chạy.
// --import-agg: chép một lần các user cũ trong bảng users của db-agg sang đúng phân mảnh hiện tại.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const base = existsSync('/app/src/ring.js') ? '/app/' : new URL('../aggregator-service/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const require = createRequire(`${base}package.json`);
const { Client } = require('pg');
const { makeRing, shardName } = require(`${base}src/ring.js`);

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const has = (k) => args.includes(k);
const dryRun = has('--dry-run');
const urls = (process.env.USERS_DATABASE_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
if (!urls.length) { console.error('Thiếu USERS_DATABASE_URLS'); process.exit(2); }

const connect = async (url) => { const c = new Client({ connectionString: url }); await c.connect(); return c; };
const COLS = 'id, username, password_hash, role, parking_id';
const checksum = (rows) => createHash('md5')
  .update(rows.map((r) => [r.id, r.username, r.password_hash, r.role, r.parking_id ?? ''].join('|')).sort().join('\n')).digest('hex');
const copy = (c, rows) => Promise.all(rows.map((r) => c.query(
  `INSERT INTO users(${COLS}) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING`,
  [r.id, r.username, r.password_hash, r.role, r.parking_id])));

const agg = await connect(process.env.DATABASE_URL);
await agg.query(`CREATE TABLE IF NOT EXISTS shard_migrations (
  id SERIAL PRIMARY KEY, shards TEXT NOT NULL, adding TEXT NOT NULL, status TEXT NOT NULL,
  write_blocked BOOLEAN NOT NULL DEFAULT false, moved INT, checksum TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
const setStatus = (id, status, extra = {}) => agg.query(
  `UPDATE shard_migrations SET status=$2, write_blocked=$3, moved=COALESCE($4, moved), checksum=COALESCE($5, checksum), updated_at=now() WHERE id=$1`,
  [id, status, extra.writeBlocked ?? false, extra.moved ?? null, extra.checksum ?? null]);

// Các user trên phân mảnh cũ mà vòng mới giao cho phân mảnh `adding`
async function movingRows(oldUrls, adding) {
  const ring = makeRing([...oldUrls, adding].map(shardName));
  const out = [];
  for (const url of oldUrls) {
    const c = await connect(url);
    const rows = (await c.query(`SELECT ${COLS} FROM users`)).rows;
    await c.end();
    const moving = rows.filter((r) => ring.shardFor(r.username) === shardName(adding));
    console.log(`${shardName(url)}: ${rows.length} user, chuyển ${moving.length}`);
    out.push(...moving.map((r) => ({ ...r, from: url })));
  }
  return out;
}

if (has('--import-agg')) {
  const ring = makeRing(urls.map(shardName));
  const rows = (await agg.query(`SELECT ${COLS} FROM users`)).rows;
  for (const url of urls) {
    const mine = rows.filter((r) => ring.shardFor(r.username) === shardName(url));
    console.log(`${shardName(url)}: ${mine.length} user từ db-agg${dryRun ? ' (dry-run)' : ''}`);
    if (dryRun) continue;
    const c = await connect(url);
    await c.query(readFileSync(`${base}src/schema.sql`, 'utf8'));
    await copy(c, mine);
    await c.end();
  }
} else if (has('--cleanup')) {
  const m = (await agg.query(`SELECT * FROM shard_migrations WHERE status='VERIFIED' ORDER BY id DESC LIMIT 1`)).rows[0];
  if (!m) { console.error('Không có lần chuyển nào ở trạng thái VERIFIED'); process.exit(1); }
  const oldUrls = m.shards.split(',');
  const moving = await movingRows(oldUrls, m.adding);
  if (!dryRun) {
    for (const url of oldUrls) {
      const names = moving.filter((r) => r.from === url).map((r) => r.username);
      const c = await connect(url);
      await c.query('DELETE FROM users WHERE username = ANY($1)', [names]);
      await c.end();
    }
    await setStatus(m.id, 'DONE');
  }
  console.log(`${dryRun ? '(dry-run) sẽ xoá' : 'Đã xoá'} ${moving.length} bản cũ, mở lại ghi`);
} else {
  const adding = opt('--add');
  if (!adding) { console.error('Dùng: --add <url phân mảnh mới> [--dry-run] | --cleanup | --import-agg'); process.exit(2); }
  if (urls.some((u) => shardName(u) === shardName(adding))) { console.error(`${shardName(adding)} đã có trong vòng`); process.exit(2); }
  const moving = await movingRows(urls, adding);
  if (dryRun) { console.log(`(dry-run) sẽ chuyển ${moving.length} user sang ${shardName(adding)}`); process.exit(0); }

  // Chặn ghi -> chép -> đối chiếu số lượng + checksum. Lỗi thì mở lại ghi, vòng cũ vẫn đúng (bản chép thừa không được đọc).
  const id = (await agg.query(
    `INSERT INTO shard_migrations(shards, adding, status, write_blocked) VALUES ($1,$2,'COPYING',true) RETURNING id`,
    [urls.join(','), adding])).rows[0].id;
  try {
    const target = await connect(adding);
    await target.query(readFileSync(`${base}src/schema.sql`, 'utf8'));
    await copy(target, moving);
    const copied = (await target.query(`SELECT ${COLS} FROM users WHERE username = ANY($1)`, [moving.map((r) => r.username)])).rows;
    await target.end();
    const [src, dst] = [checksum(moving), checksum(copied)];
    if (copied.length !== moving.length || src !== dst) throw new Error(`lệch: ${moving.length}/${copied.length} user, checksum ${src} != ${dst}`);
    await setStatus(id, 'VERIFIED', { writeBlocked: true, moved: moving.length, checksum: src });
    console.log(`Đã chép ${moving.length} user, checksum ${src}. Ghi vẫn đang chặn.`);
    console.log(`Tiếp: đặt USERS_DATABASE_URLS=${[...urls, adding].join(',')} cho mọi Aggregator, khởi động lại, rồi chạy --cleanup`);
  } catch (e) {
    await setStatus(id, 'FAILED');
    console.error(`Chuyển thất bại, đã mở lại ghi: ${e.message}`);
    process.exit(1);
  }
}
await agg.end();
