const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const { makeRegistry } = require('./nodes');
const { applyEvent, reconcile, startConsumer } = require('./events');
const { makeAuth, seedUsers } = require('./auth');
const { makeApp } = require('./routes');
const { log } = require('./log');

const env = (k, d) => process.env[k] ?? d;

// NODES='[{"parkingId":"A","name":"Bãi A","apiUrl":"http://parking-a:8001","address":"..."}]'
async function init(pool) {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  for (const n of JSON.parse(env('NODES', '[]'))) {
    // bãi đã có: api_url theo cấu hình hiện tại (vd đổi sang toxiproxy khi demo mạng xấu); toạ độ/địa chỉ công khai chỉ bổ sung nếu chưa có
    await pool.query(
      `INSERT INTO parking_nodes(parking_id, name, api_url, address, lat, lng, public_url) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (parking_id) DO UPDATE SET api_url = EXCLUDED.api_url, lat = COALESCE(parking_nodes.lat, EXCLUDED.lat), lng = COALESCE(parking_nodes.lng, EXCLUDED.lng),
         public_url = COALESCE(parking_nodes.public_url, EXCLUDED.public_url)`,
      [n.parkingId, n.name, n.apiUrl, n.address ?? null, n.lat ?? null, n.lng ?? null, n.publicUrl ?? null]);
  }
  await seedUsers(pool, env('DEMO_PASSWORD', '123456'));
}

async function main() {
  const pool = new Pool({ connectionString: env('DATABASE_URL') });
  for (let i = 1; ; i++) {
    try { await init(pool); break; }
    catch (e) { if (i >= 30) throw e; log.info('DB chưa sẵn sàng, thử lại', { error: e.message }); await new Promise((r) => setTimeout(r, 2000)); }
  }

  const reg = makeRegistry({
    internalKey: env('INTERNAL_KEY', 'dev'),
    timeoutMs: Number(env('NODE_TIMEOUT_MS', 2000)),
    failThreshold: Number(env('FAIL_THRESHOLD', 3)),
  });
  for (const row of (await pool.query('SELECT * FROM parking_nodes ORDER BY parking_id')).rows) reg.add(row);

  const cache = new Map();
  const b64 = (k) => (process.env[k] ? Buffer.from(process.env[k], 'base64').toString() : undefined);
  const auth = makeAuth(env('JWT_SECRET', 'dev-secret'), { privateKey: b64('JWT_PRIVATE_KEY_B64'), publicKey: b64('JWT_PUBLIC_KEY_B64') });
  const app = makeApp({ pool, reg, cache, auth });
  const server = http.createServer(app);
  const io = new Server(server);   // frontend đi qua nginx cùng origin nên không cần CORS
  // NV-08: socket có token hợp lệ thì vào phòng "user:<id>" để nhận thông báo riêng; không có vẫn nhận realtime chung.
  io.use((socket, next) => {
    const u = auth.verify(socket.handshake.auth?.token);
    if (u) socket.join(`user:${u.sub}`);
    next();
  });
  startConsumer(env('RABBITMQ_URL', 'amqp://localhost'), (n) => {
    (n.to === '*' ? io : io.to(`user:${n.to}`)).emit('NOTIFICATION', n);
  }, log, { exchange: 'user.notifications', queue: `aggregator.notifications.${instance}`, pattern: '#' });

  const push = (e) => io.emit('SLOT_UPDATED', e);
  // PT-01: mỗi bản Aggregator một queue riêng -> bản nào cũng nhận đủ sự kiện, đẩy cho client đang nối với nó
  // (không cần Redis adapter). Queue durable: bản này tắt thì tin chờ, bật lại xử lý tiếp.
  const instance = env('INSTANCE_ID', '1');
  startConsumer(env('RABBITMQ_URL', 'amqp://localhost'), (e) => {
    const fresh = applyEvent(cache, e);
    log.info('nhận sự kiện', { requestId: e.requestId, type: e.type, parkingId: e.parkingId, slot: e.slot, version: e.version, fresh });
    if (fresh) push(e);
  }, log, { queue: `aggregator.slot-updates.${instance}` });

  const onChange = (n, prev) => {
    log.info(`Bãi ${n.id}: ${prev} -> ${n.status}`);
    io.emit('NODE_STATUS', { parkingId: n.id, status: n.status });
    if (n.status === 'ONLINE') {
      reconcile(reg, cache, n, push)
        .then((k) => log.info(`Đối soát bãi ${n.id}: cập nhật ${k} slot`))
        .catch((e) => log.error(`Đối soát bãi ${n.id} lỗi`, { error: e.message }));
    }
  };
  const check = () => pool.query('SELECT * FROM parking_nodes')
    .then(({ rows }) => reg.sync(rows).forEach((id) => log.info(`Nạp bãi mới ${id} (do bản Aggregator khác thêm)`)))
    .then(() => reg.check(onChange))
    .catch((e) => log.error('health check lỗi', { error: e.message }));
  // Lần health check đầu xong (biết bãi nào sống) thì bù trừ các saga dở dang từ lần chạy trước (PT-07).
  check().then(() => app.locals.sagas.recover())
    .then((k) => k && log.info(`Khôi phục ${k} saga dở dang`))
    .catch((e) => log.error('khôi phục saga lỗi', { error: e.message }));
  setInterval(check, Number(env('HEALTH_INTERVAL_MS', 5000)));

  const port = Number(env('PORT', 8000));
  server.listen(port, () => log.info(`Aggregator chạy ở cổng ${port}`));
}

main().catch((e) => { log.error('khởi động thất bại', { error: e.message, stack: e.stack }); process.exit(1); });
