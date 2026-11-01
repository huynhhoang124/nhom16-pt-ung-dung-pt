const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const { makeRegistry } = require('./nodes');
const { applyEvent, reconcile, startConsumer } = require('./events');
const { makeAuth, seedUsers } = require('./auth');
const { makeApp } = require('./routes');
const { makeCommands } = require('./commands');
const { makeDlq, startDlq } = require('./dlq');
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
  pool.on('error', (e) => log.error('mất kết nối DB điều phối', { error: e.message }));   // không bắt thì DB khởi động lại làm sập Aggregator
  for (let i = 1; ; i++) {
    try { await init(pool); break; }
    catch (e) { if (i >= 30) throw e; log.info('DB chưa sẵn sàng, thử lại', { error: e.message }); await new Promise((r) => setTimeout(r, 2000)); }
  }

  // PD-11: Cấu hình động qua etcd watch
  const { makeConfig } = require('./config');
  const config = makeConfig({
    etcdEndpoints: env('ETCD_ENDPOINTS'),
    log,
  });
  if (config.active) {
    await config.start().catch((e) => log.error('Lỗi khởi động dynamic config etcd', { error: e.message }));
  }

  // PD-10: Bầu Leader Aggregator & Fencing Token
  const { makeLeaderElector } = require('./leader');
  const leader = makeLeaderElector({
    etcdEndpoints: env('ETCD_ENDPOINTS'),
    instanceId: env('INSTANCE_ID', '1'),
    log,
  });
  if (leader.active) {
    leader.start().catch((e) => log.error('Lỗi khởi động leader election', { error: e.message }));
  }

  const reg = makeRegistry({
    internalKey: env('INTERNAL_KEY', 'dev'),
    config,
    leader,
    timeoutMs: config.get('timeoutMs'),
    failThreshold: config.get('failThreshold'),
  });
  const hasEtcd = Boolean(env('ETCD_ENDPOINTS'));
  const nodeRows = (await pool.query('SELECT * FROM parking_nodes ORDER BY parking_id')).rows;
  for (const row of nodeRows) {
    reg.add(hasEtcd ? { ...row, hasLease: false } : row);
  }

  // PD-09: Khám phá dịch vụ động qua etcd lease (khi có ETCD_ENDPOINTS, giữ metadata từ DB và quản lý hasLease qua etcd)
  const { startDiscovery } = require('./discovery');
  const discovery = startDiscovery({
    etcdEndpoints: env('ETCD_ENDPOINTS'),
    reg,
    log,
  });
  if (discovery.active) {
    discovery.start().catch((e) => log.error('Lỗi khởi động discovery etcd', { error: e.message }));
  }

  const cache = new Map();
  const b64 = (k) => (process.env[k] ? Buffer.from(process.env[k], 'base64').toString() : undefined);
  const auth = makeAuth(env('JWT_SECRET', 'dev-secret'), { privateKey: b64('JWT_PRIVATE_KEY_B64'), publicKey: b64('JWT_PUBLIC_KEY_B64') });
  const commandUrl = env('RABBITMQ_URL', 'amqp://localhost/%2F');
  const commands = makeCommands(commandUrl, { signingKey: env('INTERNAL_KEY','dev'), ttlMs: Number(env('COMMAND_TTL_MS',10000)), replyTo:`agg.${env('INSTANCE_ID','1')}` });
  const dlq = makeDlq({ pool, url:commandUrl, internalKey:env('INTERNAL_KEY','dev'), ttlMs:Number(env('COMMAND_TTL_MS',10000)),
    claimReplay:async(parkingId,messageId,replayMessageId)=>{
      const node=reg.get(parkingId);if(!node)throw Object.assign(new Error('PARKING_NOT_FOUND'),{code:'PARKING_NOT_FOUND',status:404});
      const r=await reg.call(node,'/api/internal/commands/replay-claim',{method:'POST',body:{messageId,replayMessageId}});
      if(!r.ok)throw Object.assign(new Error('INBOX_CLAIM_REJECTED'),{code:'INBOX_CLAIM_REJECTED',status:r.status===409?409:503});
      if((await r.json()).claimed!==true)throw Object.assign(new Error('INBOX_CLAIM_UNAVAILABLE'),{code:'INBOX_CLAIM_UNAVAILABLE',status:503});
    } });
  const dlqWorker = startDlq({ url:commandUrl, dlq, log });
  const app = makeApp({ pool, reg, cache, auth, commands, dlq, config, leader, reserveTimeoutMs:config.get('reserveTimeoutMs',3000) });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => {
    const deadline=setTimeout(()=>process.exit(1),10000);
    await dlqWorker.stop(); await commands.close();
    if (discovery.active) await discovery.stop();
    if (config.active) await config.stop();
    if (leader.active) await leader.stop();
    clearTimeout(deadline);process.exit(0);
  });
  const server = http.createServer(app);
  const io = new Server(server);   // frontend đi qua nginx cùng origin nên không cần CORS
  // NV-08: socket có token hợp lệ thì vào phòng "user:<id>" để nhận thông báo riêng; không có vẫn nhận realtime chung.
  io.use((socket, next) => {
    const u = auth.verify(socket.handshake.auth?.token);
    if (u) socket.join(`user:${u.sub}`);
    next();
  });
  const instance = env('INSTANCE_ID', '1');
  startConsumer(env('RABBITMQ_URL', 'amqp://localhost'), (n) => {
    (n.to === '*' ? io : io.to(`user:${n.to}`)).emit('NOTIFICATION', n);
  }, log, { exchange: 'user.notifications', queue: `aggregator.notifications.${instance}`, pattern: '#' });

  const push = (e) => io.emit('SLOT_UPDATED', e);
  // PT-01: mỗi bản Aggregator một queue riêng -> bản nào cũng nhận đủ sự kiện, đẩy cho client đang nối với nó
  // (không cần Redis adapter). Queue durable: bản này tắt thì tin chờ, bật lại xử lý tiếp.
  startConsumer(env('RABBITMQ_URL', 'amqp://localhost'), (e) => {
    const fresh = applyEvent(cache, e);
    log.info('nhận sự kiện', { requestId: e.requestId, type: e.type, parkingId: e.parkingId, slot: e.slot, version: e.version, fresh });
    if (fresh) push(e);
  }, log, { queue: `aggregator.slot-updates.${instance}` });

  const onChange = (n, prev) => {
    log.info(`Bãi ${n.id}: ${prev} -> ${n.status}`);
    io.emit('NODE_STATUS', { parkingId: n.id, status: n.status });
    // PD-10: Chỉ Leader mới chạy đối soát (reconcile)
    if (n.status === 'ONLINE' && leader.isLeader()) {
      reconcile(reg, cache, n, push)
        .then((k) => log.info(`Đối soát bãi ${n.id}: cập nhật ${k} slot`))
        .catch((e) => {
          if (e.message?.includes('STALE_LEADER')) leader.demote();
          log.error(`Đối soát bãi ${n.id} lỗi`, { error: e.message });
        });
    }
  };
  const check = () => {
    const p = hasEtcd
      ? Promise.resolve()
      : pool.query('SELECT * FROM parking_nodes')
          .then(({ rows }) => reg.sync(rows).forEach((id) => log.info(`Nạp bãi mới ${id} (do bản Aggregator khác thêm)`)));
    return p
      .then(() => reg.check(onChange))
      .catch((e) => log.error('health check lỗi', { error: e.message }));
  };

  // PD-10: Quản lý các việc định kỳ chỉ chạy khi là Leader
  let leaderInterval = null;
  leader.onLeaderStart(async (token) => {
    log.info(`[leader-jobs] Instance ${instance} đảm nhận Leader (token: ${token}), bắt đầu các việc định kỳ`);
    try {
      // Bù trừ saga dở dang sau khi health check biết bãi nào sống (PT-07)
      await check();
      const k = await app.locals.sagas.recover(undefined, {
        fencingToken: token,
        isActive: () => leader.isLeader() && leader.getToken() === token,
      });
      if (k) log.info(`Khôi phục ${k} saga dở dang`);
    } catch (e) {
      log.error('Khôi phục saga lỗi', { error: e.message });
    }

    if (leaderInterval) clearInterval(leaderInterval);
    leaderInterval = setInterval(async () => {
      if (!leader.isLeader()) return;
      // Hook chuẩn bị sẵn cho PD-06 (dọn DLQ, lệnh hết hạn, tổng hợp thống kê)
    }, 30000);
  });

  leader.onLeaderStop(() => {
    if (leaderInterval) {
      clearInterval(leaderInterval);
      leaderInterval = null;
    }
    log.info(`[leader-jobs] Instance ${instance} thôi làm Leader, đã dừng toàn bộ việc định kỳ`);
  });

  // PD-11: mỗi vòng đọc lại healthIntervalMs (đổi qua etcd thì vòng sau áp dụng ngay, không cần restart)
  const scheduleCheck = () => setTimeout(() => check().finally(scheduleCheck), config.get('healthIntervalMs'));
  scheduleCheck();

  const port = Number(env('PORT', 8000));
  server.listen(port, () => log.info(`Aggregator chạy ở cổng ${port}`));
}

main().catch((e) => { log.error('khởi động thất bại', { error: e.message, stack: e.stack }); process.exit(1); });
