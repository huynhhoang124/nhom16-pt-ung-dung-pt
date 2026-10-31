const { Client } = require('pg');

const SCHEDULE_LOCK_NAMESPACE = 13013;
const SCHEDULE_LOCK_KEY = 1;
const SCHEDULE_LOCK_RETRY_MS = 1000;

// Một Client PostgreSQL riêng giữ advisory lock trong suốt thời gian node sở hữu khóa.
// Hai node cùng bãi phải dùng cùng DATABASE_URL và cùng cặp khóa này.
function createScheduledJobsLock(
  connectionString,
  { parkingId, log, ClientClass = Client } = {}
) {
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
          session = new ClientClass({
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

module.exports = { createScheduledJobsLock };
