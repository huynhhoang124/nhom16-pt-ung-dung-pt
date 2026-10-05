// Xác thực và phân quyền tập trung ở Aggregator (điểm vào duy nhất). Node chỉ tin khoá nội bộ.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const DEMO_USERS = [
  ['user1', 'USER', null], ['user2', 'USER', null],
  ['staff-a', 'STAFF', 'A'], ['staff-b', 'STAFF', 'B'], ['staff-c', 'STAFF', 'C'],
  ['admin', 'ADMIN', null],
];

async function seedUsers(pool, password) {
  const hash = await bcrypt.hash(password, 10);
  for (const [username, role, parkingId] of DEMO_USERS) {
    await pool.query(
      `INSERT INTO users(username, password_hash, role, parking_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO NOTHING`, [username, hash, role, parkingId]);
  }
}

// Đếm lần thử theo khoá (vd "username|IP") trong cửa sổ thời gian trượt.
// ponytail: đếm trong RAM của từng bản Aggregator; chạy N bản thì giới hạn thực tế x N. Cần chung thì lưu bảng DB.
function makeLimiter({ max = 5, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map();
  const recent = (k) => (hits.get(k) ?? []).filter((t) => Date.now() - t < windowMs);
  return {
    blocked: (k) => recent(k).length >= max,
    hit: (k) => { if (hits.size > 10_000) hits.clear(); hits.set(k, [...recent(k), Date.now()]); },
    reset: (k) => hits.delete(k),
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

  return { login, register, changePassword, need, verify, limiter: makeLimiter() };
}

module.exports = { makeAuth, seedUsers };
