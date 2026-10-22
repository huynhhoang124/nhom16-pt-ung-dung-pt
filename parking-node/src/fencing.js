// PD-10: Kiểm tra Fencing Token chống split-brain từ Leader cũ (Issue #27)
const { incFencingRejected } = require('./metrics');

async function checkFencing(client, job, token) {
  // 1. Tương thích ngược: Nếu không truyền token (chế độ không etcd hoặc request thông thường), cho qua
  if (token === undefined || token === null || token === '') {
    return { ok: true, skipped: true };
  }

  const numToken = Number(token);
  if (Number.isNaN(numToken) || numToken < 0) {
    return { ok: false, error: 'INVALID_FENCING_TOKEN', code: 400 };
  }

  const jobName = job || 'default';

  // 2. Chạy câu lệnh SQL nguyên tử trong cùng transaction / connection:
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
    incFencingRejected(jobName);
    return { ok: false, error: 'STALE_LEADER', code: 409, job: jobName, token: numToken };
  }

  return { ok: true, maxToken: Number(res.rows[0].max_token) };
}

module.exports = { checkFencing };
