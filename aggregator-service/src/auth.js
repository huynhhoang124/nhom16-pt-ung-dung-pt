// Xác thực và phân quyền tập trung ở Aggregator (điểm vào duy nhất). Node chỉ tin khoá nội bộ.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const DEMO_USERS = [
  ['user1', 'USER', null], ['user2', 'USER', null],
  ['staff-a', 'STAFF', 'A'], ['staff-b', 'STAFF', 'B'], ['staff-c', 'STAFF', 'C'],
  ['admin', 'ADMIN', null],
];

// db: pool db-agg, hoặc bộ phân mảnh của ring.js (PD-16) -> mỗi user mẫu ghi vào đúng phân mảnh của nó
async function seedUsers(db, password) {
  const hash = await bcrypt.hash(password, 10);
  for (const [username, role, parkingId] of DEMO_USERS) {
    await (db.for ? db.for(username) : db).query(
      `INSERT INTO users(username, password_hash, role, parking_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO NOTHING`, [username, hash, role, parkingId]);
  }
}

// Đếm lần thử theo khoá trong cửa sổ trượt, trong RAM. Chỉ còn dùng cho đăng ký theo IP.
// ponytail: chạy N bản Aggregator thì giới hạn đăng ký thực tế x N; đăng nhập đã dùng makeLoginBuckets (DB).
function makeMemoryLimiter({ max = 5, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map();
  const recent = (k) => (hits.get(k) ?? []).filter((t) => Date.now() - t < windowMs);
  return {
    blocked: (k) => recent(k).length >= max,
    hit: (k) => { if (hits.size > 10_000) hits.clear(); hits.set(k, [...recent(k), Date.now()]); },
    reset: (k) => hits.delete(k),
  };
}

// PD-21: token bucket theo username trong bảng login_buckets (pool = phân mảnh users của username đó).
// Dung lượng max token, nạp lại đều max token mỗi windowMs; mỗi lần sai trừ 1 trong một câu SQL nguyên tử.
function makeLoginBuckets({ max = 5, windowMs = 15 * 60_000 } = {}) {
  const rate = max / (windowMs / 1000);   // token mỗi giây
  const now = 'LEAST($2::real, login_buckets.tokens + EXTRACT(EPOCH FROM now() - login_buckets.updated_at)::real * $3::real)';
  return {
    async blocked(pool, username) {
      const r = await pool.query(`SELECT ${now} AS tokens FROM login_buckets WHERE username = $1`, [username, max, rate]);
      return r.rows.length > 0 && Number(r.rows[0].tokens) < 1;
    },
    async hit(pool, username) {
      const r = await pool.query(
        `INSERT INTO login_buckets(username, tokens, updated_at) VALUES ($1, $2::real - 1, now())
         ON CONFLICT (username) DO UPDATE SET tokens = GREATEST(${now} - 1, 0), updated_at = now()
         RETURNING tokens`, [username, max, rate]);
      return Number(r.rows[0].tokens);
    },
    reset: (pool, username) => pool.query('DELETE FROM login_buckets WHERE username = $1', [username]),
  };
}

// Có cặp khoá RSA -> ký RS256 (node chỉ cần khoá công khai để tự kiểm, PT-05); không có -> HS256 bằng secret như cũ.
function makeAuth(secret, { privateKey, publicKey } = {}) {
  const [signKey, verifyKey, algorithm] = privateKey ? [privateKey, publicKey, 'RS256'] : [secret, secret, 'HS256'];
  const sign = (u) => jwt.sign(
    { sub: u.id, username: u.username, role: u.role, parkingId: u.parking_id ?? null }, signKey, { expiresIn: '8h', algorithm });

  async function login(pool, username, password) {
    const u = (await pool.query('SELECT * FROM users WHERE username = $1', [username])).rows[0];
    if (!u || !(await bcrypt.compare(String(password ?? ''), u.password_hash))) return null;
    return { token: sign(u), user: { id: u.id, username: u.username, role: u.role, parkingId: u.parking_id ?? null } };
  }

  // NV-07: tự đăng ký, chỉ được vai trò USER. Trùng tên do UNIQUE của DB chặn (không SELECT trước -> không có cửa sổ đua).
  async function register(pool, username, password) {
    try {
      const u = (await pool.query(
        `INSERT INTO users(username, password_hash, role) VALUES ($1,$2,'USER') RETURNING *`,
        [username, await bcrypt.hash(password, 10)])).rows[0];
      return { token: sign(u), user: { id: u.id, username: u.username, role: u.role, parkingId: null } };
    } catch (e) {
      if (e.code === '23505') return null;
      throw e;
    }
  }

  async function changePassword(pool, userId, oldPassword, newPassword) {
    const u = (await pool.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    if (!u || !(await bcrypt.compare(String(oldPassword ?? ''), u.password_hash))) return false;
    await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, await bcrypt.hash(newPassword, 10)]);
    return true;
  }

  // need() = chỉ cần đăng nhập; need('STAFF','ADMIN') = phải có một trong các vai trò.
  const need = (...roles) => (req, res, next) => {
    try { req.user = jwt.verify((req.get('authorization') ?? '').replace(/^Bearer /, ''), verifyKey, { algorithms: [algorithm] }); }
    catch { return res.status(401).json({ error: 'UNAUTHORIZED' }); }
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'FORBIDDEN' });
    next();
  };

  // Kiểm token (dùng cho Socket.IO). Trả payload hoặc null.
  const verify = (token) => { try { return jwt.verify(token ?? '', verifyKey, { algorithms: [algorithm] }); } catch { return null; } };

  return { login, register, changePassword, need, verify, limiter: makeMemoryLimiter(), loginBuckets: makeLoginBuckets() };
}

module.exports = { makeAuth, seedUsers, makeLoginBuckets };
