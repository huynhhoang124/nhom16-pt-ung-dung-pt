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

function makeAuth(secret) {
  const sign = (u) => jwt.sign(
    { sub: u.id, username: u.username, role: u.role, parkingId: u.parking_id ?? null }, secret, { expiresIn: '8h' });

  async function login(pool, username, password) {
    const u = (await pool.query('SELECT * FROM users WHERE username = $1', [username])).rows[0];
    if (!u || !(await bcrypt.compare(String(password ?? ''), u.password_hash))) return null;
    return { token: sign(u), user: { id: u.id, username: u.username, role: u.role, parkingId: u.parking_id ?? null } };
  }

  // need() = chỉ cần đăng nhập; need('STAFF','ADMIN') = phải có một trong các vai trò.
  const need = (...roles) => (req, res, next) => {
    try { req.user = jwt.verify((req.get('authorization') ?? '').replace(/^Bearer /, ''), secret); }
    catch { return res.status(401).json({ error: 'UNAUTHORIZED' }); }
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'FORBIDDEN' });
    next();
  };

  return { login, need };
}

module.exports = { makeAuth, seedUsers };
