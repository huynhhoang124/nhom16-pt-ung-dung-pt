const { Pool } = require('pg');
const { init } = require('./db');
const { makeApp } = require('./app');
const { amqpPublisher, makeRelay } = require('./relay');
const { expireDue, activateDue } = require('./slots');
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

  const app = makeApp({
    pool, parkingId, internalKey: env('INTERNAL_KEY', 'dev'),
    reservationMinutes: Number(env('RESERVATION_MINUTES', 15)),
    ...(process.env.QR_SECRET && { qrSecret: process.env.QR_SECRET }),
  });
  app.listen(port, () => log.info(`Parking ${parkingId} chạy ở cổng ${port}`));

  const relayOnce = makeRelay(pool, amqpPublisher(env('RABBITMQ_URL', 'amqp://localhost')));
  setInterval(() => relayOnce().catch((e) => log.error('relay lỗi', { error: e.message })), 500);
  // Hết hạn giữ chỗ + giữ chỗ cho lượt đặt trước sắp đến giờ (NV-01), theo đồng hồ DB của bãi.
  const minutes = Number(env('RESERVATION_MINUTES', 15));
  setInterval(() => expireDue(pool, parkingId)
    .then(() => activateDue(pool, parkingId, minutes))
    .catch((e) => log.error('expire/activate lỗi', { error: e.message })), 30000);
}

main().catch((e) => { log.error('khởi động thất bại', { error: e.message, stack: e.stack }); process.exit(1); });
