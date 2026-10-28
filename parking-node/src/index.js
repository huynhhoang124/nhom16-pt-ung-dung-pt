const { Pool } = require('pg');
const { init, readThrough, makeDynamicPool } = require('./db');
const { makeApp } = require('./app');
const { amqpPublisher, makeRelay } = require('./relay');
const { expireDue, activateDue, warnExpiring } = require('./slots');
const { makeRegistryClient } = require('./registry');
const { log } = require('./log');
const { startCommandConsumer, makeCommandProcessor, cleanupInbox } = require('./commands');
const { makeReplyPublisher, makeReplyRelay } = require('./command-replies');

const env = (k, d) => process.env[k] ?? d;
const parkingId = env('PARKING_ID', 'A');
const port = Number(env('PORT', 8001));
const clockSkewMs = Number(env('CLOCK_SKEW_MS', 0));
if (!Number.isSafeInteger(clockSkewMs) || Math.abs(clockSkewMs) > 300_000) {
  throw new Error('CLOCK_SKEW_MS must be an integer between -300000 and 300000');
}
if (clockSkewMs !== 0) {
  if (env('ENABLE_TEST_FAULTS', '0') !== '1') throw new Error('CLOCK_SKEW_REQUIRES_TEST_FAULTS');
  const wallClockNow = Date.now.bind(Date);
  Date.now = () => wallClockNow() + clockSkewMs;
}

// PRICING='[{"vehicleType":"CAR","firstBlockMin":120,"firstBlockFee":30000,...}]' (không có thì dùng giá mặc định)
const pricing = process.env.PRICING ? JSON.parse(process.env.PRICING) : undefined;

async function main() {
  const pool = await makeDynamicPool({
    etcdEndpoints: process.env.ETCD_ENDPOINTS,
    parkingId,
    defaultDatabaseUrl: env('DATABASE_URL'),
    log,
  });
  // DB khởi động lại / mất mạng: kết nối nhàn rỗi trong pool phát 'error'. Không bắt thì cả tiến trình sập (gặp khi tập
  // failover: stop db-a làm node A chết luôn, đọc bản sao cũng không được). Bắt rồi thì pool tự mở kết nối mới khi DB về.
  pool.on('error', (e) => log.error('mất kết nối DB chính', { error: e.message }));
  for (let i = 1; ; i++) {          // DB có thể khởi động chậm hơn node
    try { await init(pool, env('SLOT_PREFIX', parkingId), env('SLOTS') ?? Number(env('SLOT_COUNT', 20)), pricing); break; }
    catch (e) { if (i >= 30) throw e; log.info('DB chưa sẵn sàng, thử lại', { error: e.message }); await new Promise((r) => setTimeout(r, 2000)); }
  }

  // PT-02: có READ_DATABASE_URL (bản sao) thì đọc thuần đi bản sao; kèm số đo độ trễ sao chép
  const poolMax = Number(process.env.PGPOOL_MAX || 10);
  const replica = process.env.READ_DATABASE_URL ? new Pool({ connectionString: process.env.READ_DATABASE_URL, max: poolMax, connectionTimeoutMillis: 500 }) : null;
  replica?.on('error', () => {});   // kết nối nhàn rỗi tới bản sao bị đứt: không để sập cả node
  const readPool = replica ? readThrough(replica, pool, { onFallback: (e) => log.error('bản sao lỗi, đọc bản chính 10s', { error: e.message }) }) : pool;
  const lagMetric = (registry, client) => replica && new client.Gauge({
    name: 'replication_lag_seconds', help: 'Bản sao chậm hơn bản chính bao nhiêu giây (0 = đã theo kịp)', registers: [registry],
    async collect() {
      try {
        this.set(Number((await replica.query(
          `SELECT CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
                  ELSE COALESCE(EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()), 0) END AS lag`)).rows[0].lag));
      } catch { this.set(-1); }   // -1: không đọc được bản sao
    },
  });

  // PD-09: Đăng ký dịch vụ lên etcd bằng lease
  const regClient = makeRegistryClient({
    etcdEndpoints: process.env.ETCD_ENDPOINTS,
    parkingId,
    port,
    log,
  });

  const app = makeApp({
    readPool, metricsExtra: [lagMetric],
    pool, parkingId, internalKey: env('INTERNAL_KEY', 'dev'),
    reservationMinutes: Number(env('RESERVATION_MINUTES', 15)),
    regClient,
    ...(process.env.QR_SECRET && { qrSecret: process.env.QR_SECRET }),
    // PT-05: khoá công khai của Aggregator (PEM, base64) -> nhân viên gọi thẳng node khi trung tâm sập
    jwtPublicKey: process.env.JWT_PUBLIC_KEY_B64 ? Buffer.from(process.env.JWT_PUBLIC_KEY_B64, 'base64').toString() : undefined,
    corsOrigins: env('CORS_ORIGIN', 'http://localhost:3000').split(','),
  });
  const server = app.listen(port, async () => {
    log.info(`Parking ${parkingId} chạy ở cổng ${port}`);
    // Đăng ký etcd SAU KHI cổng HTTP đã mở thành công để Aggregator ping 200 OK ngay (Issue 4)
    if (regClient.active) {
      try {
        await regClient.register();
      } catch (e) {
        log.warn('Đăng ký etcd ban đầu thất bại, đang tự động thử lại trong nền...', { error: e.message });
        regClient.scheduleRetry(1000);
      }
    }
  });

  const url = env('RABBITMQ_URL', 'amqp://localhost/%2F');
  const publishEvents = amqpPublisher(url);
  const relayOnce = makeRelay(pool, publishEvents);
  const replyPublisher = makeReplyPublisher(url);
  const replyOnce = makeReplyRelay(pool, replyPublisher.publish);
  const consumer = startCommandConsumer({ url, pool, parkingId, internalKey: env('INTERNAL_KEY', 'dev'), log,
    processCommand: makeCommandProcessor({ pool, parkingId, internalKey: env('INTERNAL_KEY', 'dev'),
      reservationMinutes: Number(env('RESERVATION_MINUTES', 15)), qrSecret: env('QR_SECRET', `${env('INTERNAL_KEY', 'dev')}:qr:${parkingId}`) }),
  });
  const jobs = [];
  function every(fn, ms) {
    const job = { running: null };
    job.timer = setInterval(() => {
      if (job.running) return;
      job.running = Promise.resolve().then(fn).catch((e) => log.error('background task failed', { error: e.message }))
        .finally(() => { job.running = null; });
    }, ms);
    jobs.push(job);
  }
  every(relayOnce, 500);
  every(replyOnce, 500);
  every(() => cleanupInbox(pool), 30000);
  // Hết hạn giữ chỗ + giữ chỗ cho lượt đặt trước sắp đến giờ (NV-01), theo đồng hồ DB của bãi.
  const minutes = Number(env('RESERVATION_MINUTES', 15));
  every(() => expireDue(pool, parkingId)
    .then(() => activateDue(pool, parkingId, minutes))
    .then(() => warnExpiring(pool, parkingId)), 30000);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    try {
      const httpClosed = new Promise((resolve) => server.close(resolve));
      for (const job of jobs) clearInterval(job.timer);
      await consumer.stop();
      await Promise.allSettled(jobs.map((job) => job.running));
      await regClient.stop();
      await Promise.all([replyPublisher.close(), publishEvents.close(), httpClosed]);
      await Promise.all([pool.end(), replica?.end()]);
      clearTimeout(deadline);
      process.exit(0);
    } catch (e) { log.error('shutdown failed', { error: e.message }); process.exit(1); }
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((e) => { log.error('khởi động thất bại', { error: e.message, stack: e.stack }); process.exit(1); });
