const { Pool } = require('pg');
const { init, readThrough } = require('./db');
const { makeApp } = require('./app');
const { amqpPublisher, makeRelay } = require('./relay');
const { expireDue, activateDue, warnExpiring } = require('./slots');
const { log } = require('./log');

const env = (k, d) => process.env[k] ?? d;
const parkingId = env('PARKING_ID', 'A');
const port = Number(env('PORT', 8001));

// PRICING='[{"vehicleType":"CAR","firstBlockMin":120,"firstBlockFee":30000,...}]' (không có thì dùng giá mặc định)
const pricing = process.env.PRICING ? JSON.parse(process.env.PRICING) : undefined;

async function main() {
  const pool = new Pool({ connectionString: env('DATABASE_URL') });
  for (let i = 1; ; i++) {          // DB có thể khởi động chậm hơn node
    try { await init(pool, env('SLOT_PREFIX', parkingId), env('SLOTS') ?? Number(env('SLOT_COUNT', 20)), pricing); break; }
    catch (e) { if (i >= 30) throw e; log.info('DB chưa sẵn sàng, thử lại', { error: e.message }); await new Promise((r) => setTimeout(r, 2000)); }
  }

  // PT-02: có READ_DATABASE_URL (bản sao) thì đọc thuần đi bản sao; kèm số đo độ trễ sao chép
  const replica = process.env.READ_DATABASE_URL ? new Pool({ connectionString: process.env.READ_DATABASE_URL, connectionTimeoutMillis: 500 }) : null;
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

  const app = makeApp({
    readPool, metricsExtra: [lagMetric],
    pool, parkingId, internalKey: env('INTERNAL_KEY', 'dev'),
    reservationMinutes: Number(env('RESERVATION_MINUTES', 15)),
    ...(process.env.QR_SECRET && { qrSecret: process.env.QR_SECRET }),
    // PT-05: khoá công khai của Aggregator (PEM, base64) -> nhân viên gọi thẳng node khi trung tâm sập
    jwtPublicKey: process.env.JWT_PUBLIC_KEY_B64 ? Buffer.from(process.env.JWT_PUBLIC_KEY_B64, 'base64').toString() : undefined,
    corsOrigins: env('CORS_ORIGIN', 'http://localhost:3000').split(','),
  });
  app.listen(port, () => log.info(`Parking ${parkingId} chạy ở cổng ${port}`));

  const relayOnce = makeRelay(pool, amqpPublisher(env('RABBITMQ_URL', 'amqp://localhost')));
  setInterval(() => relayOnce().catch((e) => log.error('relay lỗi', { error: e.message })), 500);
  // Hết hạn giữ chỗ + giữ chỗ cho lượt đặt trước sắp đến giờ (NV-01), theo đồng hồ DB của bãi.
  const minutes = Number(env('RESERVATION_MINUTES', 15));
  setInterval(() => expireDue(pool, parkingId)
    .then(() => activateDue(pool, parkingId, minutes))
    .then(() => warnExpiring(pool, parkingId))
    .catch((e) => log.error('expire/activate lỗi', { error: e.message })), 30000);
}

main().catch((e) => { log.error('khởi động thất bại', { error: e.message, stack: e.stack }); process.exit(1); });
