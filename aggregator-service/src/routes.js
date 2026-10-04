const express = require('express');
const { slotsFromCache } = require('./events');
const { mountSessions } = require('./sessions-routes');

const ACTIONS = new Set(['enter', 'exit', 'maintenance', 'unmaintenance']);

function makeApp({ pool, reg, cache, auth, reserveTimeoutMs = 3000 }) {
  const app = express();
  app.set('trust proxy', 'loopback, uniquelocal');   // IP thật của client do nginx (mạng Docker nội bộ) gửi qua X-Forwarded-For
  app.use(express.json());
  const { need } = auth;

  // Chuyển tiếp tới đúng node (định tuyến theo parking_id). Node OFFLINE: từ chối ngay, không xếp hàng ngầm.
  // Timeout khi GHI: không biết node đã làm hay chưa (bài toán hai tướng quân) -> 504, client retry cùng key.
  async function forward(res, n, path, opts) {
    if (!n) return res.status(404).json({ error: 'PARKING_NOT_FOUND' });
    if (n.status === 'OFFLINE') return res.status(503).json({ error: 'PARKING_OFFLINE', parkingId: n.id });
    let r;
    try { r = await reg.call(n, path, opts); }
    catch { return res.status(504).json({ error: 'TIMEOUT_UNKNOWN_RESULT', parkingId: n.id }); }
    res.status(r.status).json(await r.json());
  }

  const info = (n) => ({ parkingId: n.id, name: n.name, address: n.address, status: n.status, lastSeen: n.lastSeen });

  app.get('/health', (_req, res) => res.json({ status: 'UP' }));

  // Sai mật khẩu 5 lần / 15 phút theo username + IP thì khoá tạm (chống dò mật khẩu).
  app.post('/api/auth/login', async (req, res) => {
    const key = `login|${req.body?.username}|${req.ip}`;
    if (auth.limiter.blocked(key)) return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
    const out = await auth.login(pool, req.body?.username, req.body?.password);
    if (!out) { auth.limiter.hit(key); return res.status(401).json({ error: 'INVALID_CREDENTIALS' }); }
    auth.limiter.reset(key);
    res.json(out);
  });

  const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 72;   // bcrypt chỉ dùng 72 byte đầu

  app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!/^[a-z0-9_.]{4,32}$/.test(username ?? '')) return res.status(400).json({ error: 'INVALID_USERNAME' });
    if (!validPassword(password)) return res.status(400).json({ error: 'WEAK_PASSWORD' });
    const key = `register|${req.ip}`;                         // chống tạo tài khoản hàng loạt
    if (auth.limiter.blocked(key)) return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
    const out = await auth.register(pool, username, password);
    if (!out) return res.status(409).json({ error: 'USERNAME_TAKEN' });
    auth.limiter.hit(key);
    res.status(201).json(out);
  });

  app.put('/api/me/password', need(), async (req, res) => {
    const { oldPassword, newPassword } = req.body ?? {};
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'WEAK_PASSWORD' });
    (await auth.changePassword(pool, req.user.sub, oldPassword, newPassword))
      ? res.json({ ok: true }) : res.status(400).json({ error: 'WRONG_PASSWORD' });
  });

  app.get('/api/parkings', (_req, res) => res.json(reg.all().map(info)));

  // Nghiệp vụ 1: tra cứu toàn hệ thống (scatter–gather, kết quả một phần khi có bãi lỗi)
  const availability = () => reg.gather((n) => reg.json(n, '/api/availability'));
  app.get('/api/parkings/availability', async (_req, res) => res.json(await availability()));
  // ?type=CAR|MOTO: số chỗ tính theo loại xe đó; ?available=true: chỉ bãi đang chạy còn chỗ.
  app.get('/api/parkings/search', async (req, res) => {
    const { type } = req.query;
    if (type && !['CAR', 'MOTO'].includes(type)) return res.status(400).json({ error: 'type must be CAR or MOTO' });
    let all = await availability();
    if (type) all = all.map((p) => (p.status === 'ONLINE' ? { ...p, ...(p.byType?.[type] ?? { available: 0, total: 0 }) } : p));
    res.json(req.query.available === 'true' ? all.filter((p) => p.status === 'ONLINE' && p.available > 0) : all);
  });

  // Chi tiết bãi. Bãi OFFLINE: trả bản cache cuối cùng, gắn stale=true (chấp nhận cũ để vẫn sẵn sàng).
  app.get('/api/parkings/:id', async (req, res) => {
    const n = reg.get(req.params.id);
    if (!n) return res.status(404).json({ error: 'PARKING_NOT_FOUND' });
    if (n.status === 'ONLINE') {
      try { return res.json({ ...info(n), stale: false, slots: await reg.json(n, '/api/slots') }); }
      catch { /* rơi xuống bản cache */ }
    }
    res.json({ ...info(n), status: 'OFFLINE', stale: true, slots: slotsFromCache(cache, n.id) });
  });

  // Nghiệp vụ 2: đặt chỗ. Idempotency-Key bắt buộc; ghép với userId để key của người này không đụng người khác.
  app.post('/api/parkings/:id/reservations', need('USER'), async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || key.length > 64) return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    const { slotCode, licensePlate } = req.body ?? {};
    await forward(res, reg.get(req.params.id), '/api/reservations', {
      method: 'POST', ms: reserveTimeoutMs, retry: true,   // an toàn vì requestId idempotent
      body: { requestId: `${req.user.sub}:${key}`, userId: req.user.sub, slotCode, licensePlate },
    });
  });

  // Huỷ: USER chỉ huỷ của mình; STAFF của bãi đó hoặc ADMIN huỷ được mọi reservation.
  app.delete('/api/parkings/:id/reservations/:rid', need('USER', 'STAFF', 'ADMIN'), async (req, res) => {
    if (req.user.role === 'STAFF' && req.user.parkingId !== req.params.id) return res.status(403).json({ error: 'FORBIDDEN' });
    const owner = req.user.role === 'USER' ? `?userId=${encodeURIComponent(req.user.sub)}` : '';
    await forward(res, reg.get(req.params.id), `/api/reservations/${encodeURIComponent(req.params.rid)}${owner}`, { method: 'DELETE' });
  });

  // Lịch sử đặt chỗ của tôi: dữ liệu nằm rải ở các bãi -> gom song song.
  app.get('/api/me/reservations', need('USER'), async (req, res) => {
    const parts = await reg.gather(async (n) => ({
      reservations: await reg.json(n, `/api/reservations?userId=${encodeURIComponent(req.user.sub)}`),
    }));
    res.json({
      reservations: parts.flatMap((p) => (p.reservations ?? []).map((r) => ({ parkingId: p.parkingId, ...r }))),
      unavailable: parts.filter((p) => p.status === 'OFFLINE').map((p) => p.parkingId),
    });
  });

  // Nhân viên: xe vào/ra, khoá/mở slot — chỉ bãi của mình (ADMIN mọi bãi).
  app.post('/api/parkings/:id/slots/:code/:action', need('STAFF', 'ADMIN'), async (req, res) => {
    if (!ACTIONS.has(req.params.action)) return res.status(404).json({ error: 'UNKNOWN_ACTION' });
    if (req.user.role === 'STAFF' && req.user.parkingId !== req.params.id) return res.status(403).json({ error: 'FORBIDDEN' });
    await forward(res, reg.get(req.params.id),
      `/api/slots/${encodeURIComponent(req.params.code)}/${req.params.action}`,
      { method: 'POST', body: { licensePlate: req.body?.licensePlate } });
  });

  app.get('/api/parkings/:id/reservations', need('STAFF', 'ADMIN'), async (req, res) => {
    if (req.user.role === 'STAFF' && req.user.parkingId !== req.params.id) return res.status(403).json({ error: 'FORBIDDEN' });
    await forward(res, reg.get(req.params.id), '/api/reservations');
  });

  mountSessions(app, { reg, need, forward });

  // Quản trị: trạng thái các node; thêm bãi mới không cần sửa code (tính mở rộng).
  app.get('/api/admin/nodes', need('ADMIN'), (_req, res) =>
    res.json(reg.all().map((n) => ({ ...info(n), url: n.url, fails: n.fails }))));

  app.post('/api/admin/nodes', need('ADMIN'), async (req, res) => {
    const { parkingId, name, apiUrl, address } = req.body ?? {};
    if (!/^[A-Z0-9]{1,8}$/.test(parkingId ?? '') || !name || !/^https?:\/\//.test(apiUrl ?? '')) {
      return res.status(400).json({ error: 'parkingId (A-Z0-9), name, apiUrl (http...) are required' });
    }
    if (reg.get(parkingId)) return res.status(409).json({ error: 'PARKING_EXISTS' });
    const row = (await pool.query(
      `INSERT INTO parking_nodes(parking_id, name, api_url, address) VALUES ($1,$2,$3,$4) RETURNING *`,
      [parkingId, name, apiUrl, address ?? null])).rows[0];
    reg.add(row);
    res.status(201).json(info(reg.get(parkingId)));
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  return app;
}

module.exports = { makeApp };
