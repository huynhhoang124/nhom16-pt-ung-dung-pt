// PD-10: Kiểm tra Fencing Token chống split-brain từ Leader cũ (Issue #27)
// Token đi theo request nhờ AsyncLocalStorage (như requestId ở log.js). Thao tác ghi kiểm token bằng
// fenceIn(c) NGAY TRONG giao dịch ghi (BEGIN ... COMMIT): leader cũ không thể "qua cửa" rồi mới bị thay.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

// Chạy fn với fencing token của request hiện tại (middleware ở app.js gọi)
const withFencing = (fencing, fn) => als.run(fencing, fn);
const currentFencing = () => als.getStore();

// Token hợp lệ: số nguyên không âm. Trả về số, hoặc null nếu sai định dạng.
function parseToken(token) {
  const n = Number(token);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

async function checkFencing(client, job, token) {
  // 1. Tương thích ngược: Nếu không truyền token (chế độ không etcd hoặc request thông thường), cho qua
  if (token === undefined || token === null || token === '') {
    return { ok: true, skipped: true };
  }

  const numToken = parseToken(token);
  if (numToken === null) {
    return { ok: false, error: 'INVALID_FENCING_TOKEN', code: 400 };
  }

  const jobName = job || 'default';

  // 2. Câu lệnh nguyên tử, chạy trên client của giao dịch ghi (mục 6.5):
  // INSERT mới nếu chưa có, hoặc UPDATE nếu token mới >= max_token cũ
  const res = await client.query(
    `INSERT INTO fencing(job, max_token) VALUES ($1, $2)
     ON CONFLICT (job) DO UPDATE SET max_token = EXCLUDED.max_token
     WHERE fencing.max_token <= EXCLUDED.max_token
     RETURNING max_token`,
    [jobName, numToken]
  );

  // 3. Nếu rowCount === 0: token < max_token (Leader cũ tỉnh lại sau split-brain)
  if (!res.rowCount) {
    require('./metrics').incFencingRejected(jobName);   // require muộn: metrics -> slots -> fencing là vòng
    return { ok: false, error: 'STALE_LEADER', code: 409, job: jobName, token: numToken };
  }

  return { ok: true, maxToken: Number(res.rows[0].max_token) };
}

// Gọi trong giao dịch ghi (sau BEGIN). Không có token -> bỏ qua; token cũ -> trả lỗi để giao dịch ROLLBACK.
async function fenceIn(c) {
  const f = currentFencing();
  if (!f) return { ok: true, skipped: true };
  return checkFencing(c, f.job, f.token);
}

module.exports = { checkFencing, fenceIn, withFencing, currentFencing, parseToken };
