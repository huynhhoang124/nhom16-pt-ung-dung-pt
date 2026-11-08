const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const { makeRegistry } = require('./nodes');
const { applyEvent, createReconcileQueue, replayRecentEvents, startConsumer } = require('./events');
const { makeAuth, seedUsers } = require('./auth');
const { makeUserShards } = require('./ring');
const { makeApp } = require('./routes');
const { makeCommands } = require('./commands');
const { makeCommandFlow } = require('./command-flow');
const { startReplyService } = require('./command-replies');
const { startExpiredConsumer } = require('./expired-commands');
const { makeDlq, startDlq } = require('./dlq');
const { makeBroadcasts } = require('./broadcast');
const { startBroadcastReplies } = require('./broadcast-runtime');
const { log } = require('./log');
const { SpanKind, SpanStatusCode, trace } = require('@opentelemetry/api');

const env = (k, d) => process.env[k] ?? d;
const socketTracer = trace.getTracer('aggregator/socket.io');

function emitSocket(target, event, payload, parentContext) {
  return socketTracer.startActiveSpan('socket.emit', { kind: SpanKind.PRODUCER, attributes: { 'socket.io.event': event } }, parentContext, (span) => {
    try { target.emit(event, payload); }
    catch (error) { span.recordException(error); span.setStatus({ code: SpanStatusCode.ERROR, message: error.message }); throw error; }
    finally { span.end(); }
  });
}

// NODES='[{"parkingId":"A","name":"Bãi A","apiUrl":"http://parking-a:8001","address":"..."}]'
async function init(pool, users) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  if (users.sharded) for (const p of users.all()) await p.query(schema);   // PD-16: mỗi phân mảnh có bảng users riêng
  await pool.query(fs.readFileSync(path.join(__dirname, 'broadcast-schema.sql'), 'utf8'));
  for (const n of JSON.parse(env('NODES', '[]'))) {
    // bãi đã có: api_url theo cấu hình hiện tại (vd đổi sang toxiproxy khi demo mạng xấu); toạ độ/địa chỉ công khai chỉ bổ sung nếu chưa có
    await pool.query(
      `INSERT INTO parking_nodes(parking_id, name, api_url, address, lat, lng, public_url, zone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (parking_id) DO UPDATE SET api_url = EXCLUDED.api_url, lat = COALESCE(parking_nodes.lat, EXCLUDED.lat), lng = COALESCE(parking_nodes.lng, EXCLUDED.lng),
         public_url = COALESCE(parking_nodes.public_url, EXCLUDED.public_url), zone = COALESCE(parking_nodes.zone, EXCLUDED.zone)`,
      [n.parkingId, n.name, n.apiUrl, n.address ?? null, n.lat ?? null, n.lng ?? null, n.publicUrl ?? null, n.zone ?? env('ZONE', 'bac')]);
  }
  await seedUsers(users, env('DEMO_PASSWORD', '123456'));
}

async function main() {
  const pool = new Pool({ connectionString: env('DATABASE_URL') });
  pool.on('error', (e) => log.error('mất kết nối DB điều phối', { error: e.message }));   // không bắt thì DB khởi động lại làm sập Aggregator
  const users = makeUserShards({
    urls: env('USERS_DATABASE_URLS', ''), agg: pool,
    makePool: (u) => new Pool({ connectionString: u, connectionTimeoutMillis: 2000 }).on('error', (e) => log.error('mất kết nối phân mảnh users', { error: e.message })),
  });
  for (let i = 1; ; i++) {
    try { await init(pool, users); break; }
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
    zone: env('ZONE', 'bac'),
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
  // PD-03: COMMAND_MODE=broker gửi lệnh qua RabbitMQ và chờ phản hồi; mặc định http giữ đường cũ
  const instanceId = env('INSTANCE_ID', '1');
  const commandMode = env('COMMAND_MODE', 'http');
  const commands = makeCommands(env('RABBITMQ_URL', 'amqp://localhost/%2F'), { signingKey: env('INTERNAL_KEY', 'dev'), config });
  const commandFlow = makeCommandFlow({
    pool, publisher: commands, instanceId, config,
    waitMs: Number(env('REPLY_WAIT_MS', 3000)), ttlMs: Number(env('COMMAND_TTL_MS', 10000)),
  });
  const dlq = makeDlq({ pool, url: env('RABBITMQ_URL', 'amqp://localhost/%2F'),
    internalKey: env('INTERNAL_KEY', 'dev'), ttlMs: Number(env('COMMAND_TTL_MS', 10000)),
    markFailed: commandFlow.markFailed,
    claimReplay: async (parkingId, messageId, replayMessageId) => {
      const node = reg.get(parkingId);
      if (!node) throw Object.assign(new Error('PARKING_NOT_FOUND'), { code: 'PARKING_NOT_FOUND', status: 404 });
      const response = await fetch(`${node.url}/api/internal/commands/replay-claim`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': env('INTERNAL_KEY', 'dev') },
        body: JSON.stringify({ messageId, replayMessageId }), signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw Object.assign(new Error('INBOX_CLAIM_REJECTED'), { code: 'INBOX_CLAIM_REJECTED', status: response.status });
    },
  });
  const dlqWorker = startDlq({ url: env('RABBITMQ_URL', 'amqp://localhost/%2F'), dlq, log });
  const broadcastEnabled = env('ADMIN_BROADCAST_ENABLED', 'true') === 'true';
  const broadcastPublisher = makeCommands(env('RABBITMQ_URL', 'amqp://localhost/%2F'), {
    signingKey: env('INTERNAL_KEY', 'dev'),
  });
  const zones = JSON.parse(env('PARKING_ZONES', '{"A":"bac","B":"bac","C":"bac","D":"nam","E":"nam","F":"nam"}'));
  const broadcasts = makeBroadcasts({
    pool, publisher: broadcastPublisher, reg, zones,
    internalKey: env('INTERNAL_KEY', 'dev'), enabled: broadcastEnabled,
  });
  Object.defineProperty(broadcasts, 'zones', {
    get: () => [...new Set(reg.all()
      .filter((n) => ['A', 'B', 'C', 'D', 'E', 'F'].includes(n.id))
      .map((n) => n.zone ?? zones[n.id]).filter(Boolean))].sort(),
  });
  let broadcastReplies;
  if (broadcastEnabled) {
    broadcastReplies = startBroadcastReplies({
      url: env('RABBITMQ_URL', 'amqp://localhost/%2F'), broadcasts, log,
    });
    broadcasts.start();
  }
  const app = makeApp({
    pool, users, reg, cache, auth, commands, broadcasts, commandFlow, dlq, commandMode, config, leader,
    reserveTimeoutMs: config.get('reserveTimeoutMs', 3000),
  });
  const server = http.createServer(app);
  const io = new Server(server);   // frontend đi qua nginx cùng origin nên không cần CORS
  let replies;
  if(commandMode==='broker'){
    for(let attempt=0;;attempt++){
      try{replies=await startReplyService({pool,url:env('RABBITMQ_URL','amqp://localhost/%2F'),instanceId,internalKey:env('INTERNAL_KEY','dev'),flow:commandFlow,cache,
        onResult:(row,parent)=>{
          if(row.slot)applyEvent(cache,{parkingId:row.parking_id,slot:row.slot.slotCode,status:row.slot.status,version:row.slot.version});
          emitSocket(io.to(`user:${row.user_id}`), 'COMMAND_RESULT', {commandId:row.id,status:row.status,statusCode:row.status_code,result:row.result,parkingId:row.parking_id,slot:row.slot},parent);
        },log});break;}
      catch(e){if(e.message!=='DUPLICATE_AGGREGATOR_ID'||attempt>=20)throw e;await new Promise(r=>setTimeout(r,1000));}
    }
    commandFlow.start();
    // PD-06: lệnh hết hạn / quá số lần giao -> chỉ leader xử lý cmd.expired
    startExpiredConsumer({ pool, leader, log, url: env('RABBITMQ_URL', 'amqp://localhost/%2F'),
      notify: (row) => emitSocket(io.to(`user:${row.user_id}`), 'COMMAND_RESULT', {
        commandId: row.id, status: row.status, statusCode: row.status_code, result: row.result, parkingId: row.parking_id,
      }) });
  }
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{
    const timeout=setTimeout(()=>process.exit(1),10000);
    await dlqWorker.stop();
    await broadcasts.stop(); await broadcastReplies?.stop(); await broadcastPublisher.close();
    await commandFlow.stop(); await replies?.stop(); await commands.close();
    if (discovery.active) await discovery.stop();
    if (config.active) await config.stop();
    if (leader.active) await leader.stop();
    clearTimeout(timeout); process.exit(0);
  });
  // NV-08: socket có token hợp lệ thì vào phòng "user:<id>" để nhận thông báo riêng; không có vẫn nhận realtime chung.
  io.use((socket, next) => {
    const u = auth.verify(socket.handshake.auth?.token);
    if (u) socket.join(`user:${u.sub}`);
    next();
  });
  const instance = instanceId; // One canonical ID for replies, events and diagnostics.
  startConsumer(env('RABBITMQ_URL', 'amqp://localhost'), (n, parent) => {
    emitSocket(n.to === '*' ? io : io.to(`user:${n.to}`), 'NOTIFICATION', n, parent);
  }, log, { exchange: 'user.notifications', queue: `aggregator.notifications.${instance}`, pattern: '#' });

  const push = (e, parent) => emitSocket(io, 'SLOT_UPDATED', e, parent);
  const reconcileQueue = createReconcileQueue(reg, cache, push, log, 500, leader);
  // PT-01: mỗi bản Aggregator một queue riêng -> bản nào cũng nhận đủ sự kiện, đẩy cho client đang nối với nó
  // (không cần Redis adapter). Queue durable: bản này tắt thì tin chờ, bật lại xử lý tiếp.
  let replayStarted = false;
  const onEventConsumerReady = () => {
    if (replayStarted) return;
    replayStarted = true;
    void replayRecentEvents(env('RABBITMQ_URL', 'amqp://localhost'), cache, push, log)
      .catch((error) => log.warn('Replay events.stream failed', { error: error.message }));
  };
  const eventTracer = trace.getTracer('aggregator/events');
  startConsumer(env('RABBITMQ_URL', 'amqp://localhost'), (e, parent) => {
    eventTracer.startActiveSpan('event.process', { kind: SpanKind.CONSUMER,
      attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': 'parking.events' },
    }, parent, (span) => {
      try {
    const fresh = applyEvent(cache, e);
    log.info('nhận sự kiện', { requestId: e.requestId, type: e.type, parkingId: e.parkingId, slot: e.slot, version: e.version, fresh });
        if (fresh) push(e);
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally { span.end(); }
    });
  }, log, { queue: `aggregator.slot-updates.${instance}`, onReady: onEventConsumerReady });

  const onChange = (n, prev) => {
    log.info(`Bãi ${n.id}: ${prev} -> ${n.status}`);
    emitSocket(io, 'NODE_STATUS', { parkingId: n.id, status: n.status });
  };
  const check = () => {
    const p = hasEtcd
      ? Promise.resolve()
      : pool.query('SELECT * FROM parking_nodes')
          .then(({ rows }) => reg.sync(rows).forEach((id) => log.info(`Nạp bãi mới ${id} (do bản Aggregator khác thêm)`)));
    return p
      .then(() => reg.check(onChange))
      .then(() => {
        if (leader.isLeader()) reg.all().filter((n) => n.status === 'ONLINE').forEach(reconcileQueue.enqueue);
      })
      .catch((e) => log.error('health check lỗi', { error: e.message }));
  };

  // PD-10: Quản lý các việc định kỳ chỉ chạy khi là Leader
  let leaderInterval = null;
  leader.onLeaderStart(async (token) => {
    log.info(`[leader-jobs] Instance ${instance} đảm nhận Leader (token: ${token}), bắt đầu các việc định kỳ`);
    try {
      // Bù trừ saga dở dang sau khi health check biết bãi nào sống (PT-07)
      await check();
      const k = await app.locals.sagas.recover(commandMode === 'broker' ? 0 : undefined, {
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
      if (commandMode === 'broker') {
        app.locals.sagas.recover(5000, {
          fencingToken: leader.getToken(), isActive: () => leader.isLeader(),
        }).catch((e) => log.error('Khôi phục saga lỗi', { error: e.message }));
      }
      // PD-21: chỉ leader dọn bucket đăng nhập đã nạp đầy ở mọi phân mảnh users
      for (const p of users.all()) auth.loginBuckets.cleanup(p).catch((e) => log.error('Dọn login_buckets lỗi', { error: e.message }));
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
