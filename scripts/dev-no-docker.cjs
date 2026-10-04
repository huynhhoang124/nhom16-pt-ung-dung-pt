// Chạy cả hệ thống KHÔNG cần Docker để làm/thử giao diện: 3 bãi + Aggregator trong một tiến trình Node,
// mỗi bãi một PGlite (PostgreSQL chạy bằng WASM, dữ liệu trong RAM, tắt là mất).
// Không có RabbitMQ: relay của từng bãi đẩy sự kiện thẳng vào Aggregator (thay cho broker), vẫn có realtime.
//   cd parking-node && npm install && cd ../aggregator-service && npm install && cd ..
//   node scripts/dev-no-docker.cjs          # API :8000, bãi :8001–8003
//   cd frontend && npm run dev              # web :3000
// Chỉ để phát triển giao diện. Kiểm chứng tính phân tán (tắt bãi, broker...) vẫn dùng Docker.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const nodeReq = createRequire(path.join(root, 'parking-node/package.json'));
const aggReq = createRequire(path.join(root, 'aggregator-service/package.json'));
const { PGlite } = nodeReq('@electric-sql/pglite');
const { btree_gist } = nodeReq('@electric-sql/pglite/contrib/btree_gist');
const { Server } = aggReq('socket.io');

const { makeApp: makeNodeApp } = require('../parking-node/src/app');
const { init: initNode } = require('../parking-node/src/db');
const { makeRelay } = require('../parking-node/src/relay');
const { expireDue, activateDue } = require('../parking-node/src/slots');
const { makeRegistry } = require('../aggregator-service/src/nodes');
const { applyEvent, reconcile } = require('../aggregator-service/src/events');
const { makeAuth, seedUsers } = require('../aggregator-service/src/auth');
const { makeApp } = require('../aggregator-service/src/routes');

const KEY = 'dev';
const BAYS = [
  ['A', 8001, 'CAR:1:10,CAR:2:10,MOTO:1:20', 'Bãi A – PTIT Hà Đông', '96A Trần Phú, Hà Đông', 20.9809, 105.7875],
  ['B', 8002, 'CAR:1:10,CAR:2:10,CAR:3:10,MOTO:1:30', 'Bãi B – Cầu Giấy', 'Cầu Giấy, Hà Nội', 21.0362, 105.7906],
  ['C', 8003, 'CAR:1:10,CAR:2:5,MOTO:1:15', 'Bãi C – Hoàn Kiếm', 'Hoàn Kiếm, Hà Nội', 21.0287, 105.8524],
];

async function pool() {
  const db = new PGlite({ extensions: { btree_gist } });
  const query = async (sql, params) => {
    const r = params ? await db.query(sql, params) : (await db.exec(sql)).at(-1) ?? { rows: [] };
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  };
  // ponytail: 1 kết nối dùng chung, giao dịch song song không tách biệt; đủ cho thử giao diện, không dùng đo tương tranh
  return { query, connect: async () => ({ query, release() {} }) };
}

const listen = (handler, port) => new Promise((ok) => {
  const server = http.createServer(handler).listen(port, () => ok(server));
});

(async () => {
  let onEvent = () => {};   // gán sau khi Aggregator sẵn sàng
  for (const [id, port, slots] of BAYS) {
    const p = await pool();
    await initNode(p, id, slots);
    await listen(makeNodeApp({ pool: p, parkingId: id, internalKey: KEY }), port);
    const relay = makeRelay(p, async (_key, payload) => { onEvent(payload); return true; });
    setInterval(() => relay().catch(() => {}), 300);
    setInterval(() => expireDue(p, id).then(() => activateDue(p, id)).catch(() => {}), 30_000);
  }

  const aggPool = await pool();
  await aggPool.query(fs.readFileSync(path.join(root, 'aggregator-service/src/schema.sql'), 'utf8'));
  await seedUsers(aggPool, '123456');
  const reg = makeRegistry({ internalKey: KEY });
  for (const [id, port, , name, address, lat, lng] of BAYS) {
    const row = (await aggPool.query(
      `INSERT INTO parking_nodes(parking_id, name, api_url, address) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, name, `http://localhost:${port}`, address])).rows[0];
    reg.add({ ...row, lat, lng });
  }
  const cache = new Map();
  const server = await listen(makeApp({ pool: aggPool, reg, cache, auth: makeAuth('dev-secret') }), 8000);
  const io = new Server(server);
  const push = (e) => io.emit('SLOT_UPDATED', e);
  onEvent = (e) => { if (applyEvent(cache, e)) push(e); };
  const check = () => reg.check((n) => {
    io.emit('NODE_STATUS', { parkingId: n.id, status: n.status });
    if (n.status === 'ONLINE') reconcile(reg, cache, n, push).catch(() => {});
  });
  await check();
  setInterval(check, 5000);
  console.log('Sẵn sàng: API http://localhost:8000 · bãi :8001–8003 · chạy tiếp "cd frontend && npm run dev" rồi mở http://localhost:3000');
  console.log('Tài khoản (mật khẩu 123456): user1, user2, staff-a, staff-b, staff-c, admin');
})().catch((e) => { console.error(e); process.exit(1); });
