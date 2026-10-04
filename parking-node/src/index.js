const { Pool } = require('pg');
const { init } = require('./db');
const { makeApp } = require('./app');
const { amqpPublisher, makeRelay } = require('./relay');
const { expireDue } = require('./slots');

const env = (k, d) => process.env[k] ?? d;
const parkingId = env('PARKING_ID', 'A');
const port = Number(env('PORT', 8001));

async function main() {
  const pool = new Pool({ connectionString: env('DATABASE_URL') });
  for (let i = 1; ; i++) {          // DB có thể khởi động chậm hơn node
    try { await init(pool, env('SLOT_PREFIX', parkingId), env('SLOTS') ?? Number(env('SLOT_COUNT', 20))); break; }
    catch (e) { if (i >= 30) throw e; console.log(`DB chưa sẵn sàng (${e.message}), thử lại...`); await new Promise((r) => setTimeout(r, 2000)); }
  }

  const app = makeApp({
    pool, parkingId, internalKey: env('INTERNAL_KEY', 'dev'),
    reservationMinutes: Number(env('RESERVATION_MINUTES', 15)),
  });
  app.listen(port, () => console.log(`Parking ${parkingId} chạy ở cổng ${port}`));

  const relayOnce = makeRelay(pool, amqpPublisher(env('RABBITMQ_URL', 'amqp://localhost')));
  setInterval(() => relayOnce().catch((e) => console.error('relay:', e.message)), 500);
  setInterval(() => expireDue(pool, parkingId).catch((e) => console.error('expire:', e.message)), 30000);
}

main().catch((e) => { console.error(e); process.exit(1); });
