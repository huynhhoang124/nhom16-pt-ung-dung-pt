const { Pool } = require('pg');
const { init } = require('./db');
const { makeApp } = require('./app');
const { amqpPublisher, makeRelay } = require('./relay');
const { expireDue, activateDue } = require('./slots');

const env = (k, d) => process.env[k] ?? d;
const parkingId = env('PARKING_ID', 'A');
const port = Number(env('PORT', 8001));

// PRICING='[{"vehicleType":"CAR","firstBlockMin":120,"firstBlockFee":30000,...}]' (không có thì dùng giá mặc định)
const pricing = process.env.PRICING ? JSON.parse(process.env.PRICING) : undefined;

async function main() {
  const pool = new Pool({ connectionString: env('DATABASE_URL') });
  for (let i = 1; ; i++) {          // DB có thể khởi động chậm hơn node
    try { await init(pool, env('SLOT_PREFIX', parkingId), env('SLOTS') ?? Number(env('SLOT_COUNT', 20)), pricing); break; }
    catch (e) { if (i >= 30) throw e; console.log(`DB chưa sẵn sàng (${e.message}), thử lại...`); await new Promise((r) => setTimeout(r, 2000)); }
  }

  const app = makeApp({
    pool, parkingId, internalKey: env('INTERNAL_KEY', 'dev'),
    reservationMinutes: Number(env('RESERVATION_MINUTES', 15)),
    ...(process.env.QR_SECRET && { qrSecret: process.env.QR_SECRET }),
  });
  app.listen(port, () => console.log(`Parking ${parkingId} chạy ở cổng ${port}`));

  const relayOnce = makeRelay(pool, amqpPublisher(env('RABBITMQ_URL', 'amqp://localhost')));
  setInterval(() => relayOnce().catch((e) => console.error('relay:', e.message)), 500);
  // Hết hạn giữ chỗ + giữ chỗ cho lượt đặt trước sắp đến giờ (NV-01), theo đồng hồ DB của bãi.
  const minutes = Number(env('RESERVATION_MINUTES', 15));
  setInterval(() => expireDue(pool, parkingId)
    .then(() => activateDue(pool, parkingId, minutes))
    .catch((e) => console.error('expire/activate:', e.message)), 30000);
}

main().catch((e) => { console.error(e); process.exit(1); });
