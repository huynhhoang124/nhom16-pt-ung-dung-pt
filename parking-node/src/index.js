const { Pool, Client } = require('pg');
const { init, readThrough } = require('./db');
const { makeApp } = require('./app');
const { amqpPublisher, makeRelay } = require('./relay');
const { expireDue, activateDue, warnExpiring } = require('./slots');
const { log } = require('./log');
const { startCommandConsumer, makeCommandProcessor, cleanupInbox } = require('./commands');
const { makeReplyPublisher, makeReplyRelay } = require('./command-replies');

const env = (k, d) => process.env[k] ?? d;
const parkingId = env('PARKING_ID', 'A');
const port = Number(env('PORT', 8001));

// PRICING='[{"vehicleType":"CAR","firstBlockMin":120,"firstBlockFee":30000,...}]' (không có thì dùng giá mặc định)
const pricing = process.env.PRICING ? JSON.parse(process.env.PRICING) : undefined;

const SCHEDULE_LOCK_NAMESPACE = 13013;
const SCHEDULE_LOCK_KEY = 1;
const SCHEDULE_LOCK_RETRY_MS = 1000;

// Một Client PostgreSQL riêng giữ advisory lock trong suốt thời gian node sở hữu khóa.
// Hai node cùng bãi phải dùng cùng DATABASE_URL và cùng cặp khóa này.
function createScheduledJobsLock(connectionString) {
  let client = null;
  let ownsLock = false;
  let stopping = false;
  let attemptPromise = null;
  let retryTimer = null;
  let lastErrorLogAt = 0;

  const lockArgs = [SCHEDULE_LOCK_NAMESPACE, SCHEDULE_LOCK_KEY];

  function logLockError(message, error) {
    // Tránh ghi log lỗi liên tục mỗi giây khi DB tạm thời mất kết nối.
    const now = Date.now();
    if (now - lastErrorLogAt < 5000) return;
    lastErrorLogAt = now;

    log.error(message, {
      parkingId,
      error: error.message,
    });
  }

  function checkLock() {
    if (stopping || attemptPromise) return;

    attemptPromise = Promise.resolve().then(async () => {
      let session = client;

      try {
        // Nếu chưa có kết nối riêng, tạo một kết nối mới.
        if (!session) {
          session = new Client({
            connectionString,
            connectionTimeoutMillis: 1000,
          });

          session.on('error', (error) => {
            // Chỉ thay đổi trạng thái nếu đây vẫn là kết nối đang được sử dụng.
            if (client !== session) return;

            client = null;
            ownsLock = false;

            logLockError(
              'Mất kết nối giữ advisory lock; sẽ thử lấy lại',
              error,
            );
          });

          await session.connect();

          // Nếu node đang tắt trong lúc kết nối được thiết lập,
          // không tiếp tục lấy khóa.
          if (stopping) {
            await session.end().catch(() => {});
            return;
          }

          client = session;
        }

        // Nếu đang giữ khóa, chỉ kiểm tra kết nối còn hoạt động.
        // KHÔNG gọi pg_try_advisory_lock lần nữa trên cùng session,
        // vì PostgreSQL có thể tăng số lần khóa được giữ.
        if (ownsLock) {
          await session.query('SELECT 1');
          return;
        }

        // Thử lấy khóa. Nếu node khác đang giữ khóa, kết quả là false.
        const result = await session.query(
          `SELECT pg_try_advisory_lock(
             $1::integer, $2::integer
           ) AS locked`,
          lockArgs,
        );

        // Đã bắt đầu shutdown trong khi truy vấn đang chạy.
        // Nếu vừa lấy được khóa thì nhả ngay.
        if (stopping) {
          if (result.rows[0].locked) {
            await session.query(
              `SELECT pg_advisory_unlock(
                 $1::integer, $2::integer
               )`,
              lockArgs,
            );
          }

          if (client === session) client = null;
          ownsLock = false;
          await session.end().catch(() => {});
          return;
        }

        if (result.rows[0].locked) {
          ownsLock = true;
          log.info('Đã nhận advisory lock cho tác vụ định kỳ', {
            parkingId,
          });
        }
        // Nếu locked === false, giữ kết nối nhưng thử lại ở lần tiếp theo.
      } catch (error) {
        if (client === session) {
          client = null;
          ownsLock = false;
        }

        if (session) {
          await session.end().catch(() => {});
        }

        logLockError(
          'Không lấy/duy trì được advisory lock; sẽ thử lại',
          error,
        );
      }
    }).finally(() => {
      attemptPromise = null;
    });
  }

  // Thử ngay khi khởi động, sau đó thử lại mỗi giây nếu chưa có khóa.
  retryTimer = setInterval(checkLock, SCHEDULE_LOCK_RETRY_MS);
  checkLock();

  return {
    isOwner: () => ownsLock && !stopping,

    async stop() {
      stopping = true;
      clearInterval(retryTimer);

      // Chờ lần thử lấy khóa đang diễn ra kết thúc.
      if (attemptPromise) await attemptPromise;

      const session = client;
      const hadLock = ownsLock;

      client = null;
      ownsLock = false;

      if (!session) return;

      try {
        if (hadLock) {
          const result = await session.query(
            `SELECT pg_advisory_unlock(
               $1::integer, $2::integer
             ) AS unlocked`,
            lockArgs,
          );

          if (!result.rows[0].unlocked) {
            log.error(
              'Khi tắt node, session không còn giữ advisory lock',
              { parkingId },
            );
          }
        }
      } catch (error) {
        logLockError(
          'Không giải phóng được advisory lock khi shutdown; có thể DB đã mất kết nối',
          error,
        );
      } finally {
        // Đóng session cũng khiến PostgreSQL giải phóng mọi lock còn giữ.
        await session.end().catch(() => {});
      }
    },
  };
}

async function main() {
  const pool = new Pool({ connectionString: env('DATABASE_URL') });
  // DB khởi động lại / mất mạng: kết nối nhàn rỗi trong pool phát 'error'. Không bắt thì cả tiến trình sập (gặp khi tập
  // failover: stop db-a làm node A chết luôn, đọc bản sao cũng không được). Bắt rồi thì pool tự mở kết nối mới khi DB về.
  pool.on('error', (e) => log.error('mất kết nối DB chính', { error: e.message }));
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
  const server = app.listen(port, () => log.info(`Parking ${parkingId} chạy ở cổng ${port}`));

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
  // Hết hạn giữ chỗ + kích hoạt lượt đặt trước + cảnh báo sắp hết hạn.
  // Chỉ node giữ advisory lock mới được chạy các tác vụ này.
  const minutes = Number(env('RESERVATION_MINUTES', 15));
  const scheduledJobsLock = createScheduledJobsLock(env('DATABASE_URL'));

  every(async () => {
    if (!scheduledJobsLock.isOwner()) return;

    await expireDue(pool, parkingId);

    // Nếu mất khóa giữa chừng, không tiếp tục các tác vụ còn lại.
    if (!scheduledJobsLock.isOwner()) return;

    await activateDue(pool, parkingId, minutes);

    if (!scheduledJobsLock.isOwner()) return;

    await warnExpiring(pool, parkingId);
  }, 30000);

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

      // Nhả advisory lock trước khi kết thúc các kết nối database.
      await scheduledJobsLock.stop();

      await Promise.all([
        replyPublisher.close(),
        publishEvents.close(),
        httpClosed,
      ]);

      await Promise.all([pool.end(), replica?.end()]);
      clearTimeout(deadline);
      process.exit(0);
    } catch (e) { log.error('shutdown failed', { error: e.message }); process.exit(1); }
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((e) => { log.error('khởi động thất bại', { error: e.message, stack: e.stack }); process.exit(1); });
