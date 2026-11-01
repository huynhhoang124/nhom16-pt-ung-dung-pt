const express = require('express');
const { randomUUID } = require('node:crypto');
const { slotsFromCache } = require('./events');
const { mountSessions } = require('./sessions-routes');
const { log, withRequestId } = require('./log');
const { makeSagas } = require('./saga');
const { mountMetrics } = require('./metrics');

const ACTIONS = new Set(['enter', 'exit', 'maintenance', 'unmaintenance']);

function makeApp({ pool, reg, cache, auth, commands, commandFlow, commandMode = 'http', reserveTimeoutMs = 3000, config, leader,
  zone = process.env.ZONE ?? 'bac', peerUrl = process.env.REGIONAL_PEER_URL }) {
  const app = express();
  app.set('trust proxy', 'loopback, uniquelocal');   // IP thật của client do nginx (mạng Docker nội bộ) gửi qua X-Forwarded-For
  app.use(withRequestId);
  // PT-01: cho biết request rơi vào bản Aggregator nào (demo cân bằng tải / tắt một bản)
  const instance = process.env.INSTANCE_ID ?? '1';
  app.use((_req, res, next) => { res.set('x-instance', `aggregator-${instance}`); next(); });
  const crossZone = mountMetrics(app, { reg, leader, instance });   // GET /metrics; nginx không chuyển /metrics ra ngoài
  app.use(express.json({ limit: '10kb' }));
  const { need } = auth;
  // PD-11: timeout ghi đọc lại mỗi lần gọi (đổi qua etcd là áp dụng ngay cho đặt chỗ, saga, trả tiền)
  const reserveMs = () => (config ? config.get('reserveTimeoutMs', reserveTimeoutMs) : reserveTimeoutMs);
  if (!['http', 'broker'].includes(commandMode)) throw new Error('INVALID_COMMAND_MODE');
  const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

  // PD-03: gửi lệnh qua broker, chờ phản hồi tối đa REPLY_WAIT_MS -> 201/409, quá hạn -> 202 + commandId
  async function broker(req, res, type, payload, key = req.get('idempotency-key')) {
    if (!commandFlow) return res.status(503).json({ error: 'COMMAND_SERVICE_UNAVAILABLE' });
    const traceparent = req.get('traceparent');
    if (traceparent && !TRACEPARENT.test(traceparent)) return res.status(400).json({ error: 'INVALID_TRACEPARENT' });
    try {
      const out = await commandFlow.execute({ parkingId: req.params.id, type, user: req.user, payload, key, traceparent });
      if (out.code === 202) res.set('location', `/api/commands/${encodeURIComponent(out.body.commandId)}`);
      res.status(out.code).json(out.body);
    } catch (e) {
      const extra = e.commandId ? { commandId: e.commandId, unknown: e.unknown } : {};
      res.status(e.status ?? 503).json({ error: e.code ?? 'COMMAND_SERVICE_UNAVAILABLE', ...extra });
    }
  }

  // Bảng commands nằm ở DB chung nên bản Aggregator nào cũng trả được; chỉ chủ lệnh hoặc ADMIN xem
  app.get('/api/commands/:id', need(), async (req, res) => {
    if (!commandFlow) return res.status(503).json({ error: 'COMMAND_SERVICE_UNAVAILABLE' });
    const row = await commandFlow.get(req.params.id);
    if (!row || (row.user_id !== req.user.sub && req.user.role !== 'ADMIN')) {
      return res.status(404).json({ error: 'COMMAND_NOT_FOUND' });
    }
    res.json({
      commandId: row.id, parkingId: row.parking_id, type: row.type, status: row.status,
      result: row.result, statusCode: row.status_code, publishState: row.publish_state,
      sendStatus: row.failure_phase === 'SEND' ? 'FAILED_TO_SEND' : undefined,
      createdAt: row.created_at, updatedAt: row.updated_at,
    });
  });

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

  const info = (n) => ({ parkingId: n.id, name: n.name, address: n.address, lat: n.lat, lng: n.lng, publicUrl: n.publicUrl, zone: n.zone ?? null, status: n.status, lastSeen: n.lastSeen });

  app.get('/health', (_req, res) => res.json({ status: 'UP' }));

  // PD-01: administrative publish surface; 202 means broker confirm, not node completion.
  // No registry lookup: a 404 here must come from RabbitMQ mandatory basic.return.
  app.post('/api/admin/parkings/:id/commands', need('ADMIN'), async (req, res) => {
    if (!commands) return res.status(503).json({ error: 'BROKER_UNAVAILABLE' });
    try {
      const key = req.get('idempotency-key') ?? randomUUID();
      const messageId = req.body?.messageId ?? `${req.user.sub}:${key}`;
      if (typeof key !== 'string' || !key.length || key.length > 64 || typeof messageId !== 'string' ||
          !messageId.startsWith(`${req.user.sub}:`) || !messageId.slice(String(req.user.sub).length + 1).length ||
          messageId.slice(String(req.user.sub).length + 1).length > 64) {
        return res.status(400).json({ error: 'INVALID_COMMAND_ID' });
      }
      const result = await commands.send(req.params.id, req.body?.type, req.body?.payload, {
        messageId,
        correlationId: req.body?.correlationId,
        replyTo: `agg.${process.env.INSTANCE_ID ?? '1'}`,
        actor: { userId: req.user.sub, role: req.user.role },
      });
      res.status(202).json({ ...result, processed: false });
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.code ?? 'INTERNAL_ERROR' });
    }
  });

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
  // PD-11: Tra cứu cấu hình động hiện tại (chỉ ADMIN)
  app.get('/api/config', need('ADMIN'), (_req, res) => res.json(config ? config.all() : {}));
  app.get('/api/config/:key', need('ADMIN'), (req, res) => {
    if (!config) return res.status(404).json({ error: 'CONFIG_NOT_AVAILABLE' });
    const val = config.get(req.params.key);
    res.json({ key: req.params.key, value: val });
  });

  // PD-10: Tra cứu trạng thái leader hiện tại
  app.get('/api/leader', (_req, res) => {
    res.json({
      isLeader: leader ? leader.isLeader() : true,
      fencingToken: leader ? leader.getToken() : null,
      instanceId: process.env.INSTANCE_ID || '1',
    });
  });

  // PD-10 / TC66: Giả lập lỗi pause leader (chỉ bật khi ENABLE_TEST_FAULTS=1)
  app.post('/api/test/fault/leader-pause', async (req, res) => {
    if (process.env.ENABLE_TEST_FAULTS !== '1') {
      return res.status(403).json({ error: 'FAULT_INJECTION_DISABLED' });
    }
    const ms = Number(req.body?.ms || 15000);
    const result = await leader?.simulatePause?.(ms);
    res.json(result || { ok: true, ms });
  });

  // Nghiệp vụ 1: tra cứu toàn hệ thống (scatter–gather, kết quả một phần khi có bãi lỗi)
  const localAvailability = async () => Promise.all(reg.ordered()
    .filter((n) => (n.zone ?? zone) === zone).map(async (n) => {
      if (n.status === 'OFFLINE') return { parkingId: n.id, status: 'OFFLINE' };
      try { return { parkingId: n.id, status: n.status, ...(await reg.json(n, '/api/availability')) }; }
      catch { return { parkingId: n.id, status: 'OFFLINE' }; }
    }));
  const availability = async (scope) => {
    const local = localAvailability();
    if (scope === 'zone') {
      const parkings = await local;
      return { parkings, failed: parkings.filter((p) => p.status === 'OFFLINE').map((p) => p.parkingId) };
    }
    const remoteNodes = reg.ordered().filter((n) => (n.zone ?? zone) !== zone);
    if (!remoteNodes.length) return local;
    const remote = async () => {
      if (!peerUrl) return remoteNodes.map((n) => ({ parkingId: n.id, status: 'OFFLINE' }));
      crossZone.inc();
      try {
        const response = await fetch(`${peerUrl}/api/parkings/availability?scope=zone`, {
          signal: AbortSignal.timeout(config ? config.get('timeoutMs', 2000) : 2000),
        });
        if (!response.ok) throw new Error('Vùng khác không phản hồi');
        const data = await response.json();
        if (!Array.isArray(data.parkings) || !Array.isArray(data.failed)) throw new Error('Dữ liệu vùng không hợp lệ');
        const byId = new Map(data.parkings.map((p) => [p.parkingId, p]));
        return remoteNodes.map((n) => data.failed.includes(n.id) ? { parkingId: n.id, status: 'OFFLINE' }
          : byId.get(n.id) ?? { parkingId: n.id, status: 'OFFLINE' });
      } catch { return remoteNodes.map((n) => ({ parkingId: n.id, status: 'OFFLINE' })); }
    };
    const [here, there] = await Promise.all([local, remote()]);
    return [...here, ...there];
  };
  app.get('/api/parkings/availability', async (req, res) => res.json(await availability(req.query.scope)));
  // ?type=CAR|MOTO: số chỗ tính theo loại xe đó; ?available=true: chỉ bãi đang chạy còn chỗ.
  app.get('/api/parkings/search', async (req, res) => {
    const { type } = req.query;
    if (type && !['CAR', 'MOTO'].includes(type)) return res.status(400).json({ error: 'type must be CAR or MOTO' });
    const result = await availability(req.query.scope);
    let all = req.query.scope === 'zone' ? result.parkings : result;
    if (type) all = all.map((p) => (p.status !== 'OFFLINE' ? { ...p, ...(p.byType?.[type] ?? { available: 0, total: 0 }) } : p));
    all = req.query.available === 'true' ? all.filter((p) => p.status !== 'OFFLINE' && p.available > 0) : all;
    res.json(req.query.scope === 'zone' ? { parkings: all, failed: result.failed } : all);
  });

  // Chi tiết bãi. Bãi OFFLINE: trả bản cache cuối cùng, gắn stale=true (chấp nhận cũ để vẫn sẵn sàng).
  app.get('/api/parkings/:id', async (req, res) => {
    const n = reg.get(req.params.id);
    if (!n) return res.status(404).json({ error: 'PARKING_NOT_FOUND' });
    if (n.status !== 'OFFLINE') {
      try { return res.json({ ...info(n), stale: false, slots: await reg.json(n, '/api/slots') }); }
      catch { /* rơi xuống bản cache */ }
    }
    res.json({ ...info(n), status: n.status, stale: true, slots: slotsFromCache(cache, n.id) });
  });

  // Nghiệp vụ 2: đặt chỗ. Idempotency-Key bắt buộc; ghép với userId để key của người này không đụng người khác.
  app.post('/api/parkings/:id/reservations', need('USER'), async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || key.length > 64) return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    const { slotCode, licensePlate, startTime, durationMinutes } = req.body ?? {};
    if(commandMode==='broker')return broker(req,res,'reserve',{slotCode,licensePlate,...(startTime!==undefined&&{startTime}),...(durationMinutes!==undefined&&{durationMinutes})});
    await forward(res, reg.get(req.params.id), '/api/reservations', {
      method: 'POST', ms: reserveMs(), retry: true,   // an toàn vì requestId idempotent
      body: { requestId: `${req.user.sub}:${key}`, userId: req.user.sub, slotCode, licensePlate, startTime, durationMinutes },
    });
  });

  // NV-01: lịch đặt của một slot trong ngày (để chọn khung giờ trống).
  app.get('/api/parkings/:id/slots/:code/schedule', need(), async (req, res) => {
    await forward(res, reg.get(req.params.id),
      `/api/slots/${encodeURIComponent(req.params.code)}/schedule?date=${encodeURIComponent(req.query.date ?? '')}`);
  });

  // PT-07: đặt chỗ cho nhiều xe ở nhiều bãi (Saga). Cùng Idempotency-Key -> trả lại saga cũ.
  const sagas = makeSagas({ pool, reg, timeoutMs: reserveMs });
  app.locals.sagas = sagas;
  app.post('/api/group-reservations', need('USER'), async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || key.length > 64) return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length < 2 || items.length > 5
      || !items.every((x) => [x?.parkingId, x?.slotCode, x?.licensePlate].every((v) => typeof v === 'string' && v && v.length <= 32))) {
      return res.status(400).json({ error: 'items: 2–5 x { parkingId, slotCode, licensePlate }' });
    }
    const { replayed, saga } = await sagas.start(req.user.sub, key, items);
    res.status(replayed ? 200 : 201).json(saga);
  });
  app.get('/api/group-reservations/:id', need('USER'), async (req, res) => {
    const saga = /^[0-9a-f-]{36}$/.test(req.params.id) && await sagas.get(req.params.id, req.user.sub);
    saga ? res.json(saga) : res.status(404).json({ error: 'NOT_FOUND' });
  });

  // Huỷ: USER chỉ huỷ của mình; STAFF của bãi đó hoặc ADMIN huỷ được mọi reservation.
  app.delete('/api/parkings/:id/reservations/:rid', need('USER', 'STAFF', 'ADMIN'), async (req, res) => {
    if (req.user.role === 'STAFF' && req.user.parkingId !== req.params.id) return res.status(403).json({ error: 'FORBIDDEN' });
    const owner = req.user.role === 'USER' ? `?userId=${encodeURIComponent(req.user.sub)}` : '';
    if(commandMode==='broker')return broker(req,res,'cancel',{reservationId:req.params.rid},req.get('idempotency-key')??`cancel-${req.params.rid}`);
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
      { method: 'POST', body: { licensePlate: req.body?.licensePlate, cash: req.body?.cash === true } });
  });

  // UX-04: cổng bãi quét QR qua Aggregator (node vẫn là bên kiểm chữ ký QR). Không tự retry: xe vào/ra không idempotent.
  app.post('/api/parkings/:id/gate/scan', need('STAFF', 'ADMIN'), async (req, res) => {
    if (req.user.role === 'STAFF' && req.user.parkingId !== req.params.id) return res.status(403).json({ error: 'FORBIDDEN' });
    await forward(res, reg.get(req.params.id), '/api/gate/scan', {
      method: 'POST', body: { token: req.body?.token, action: req.body?.action } });
  });

  // NV-09: quản lý slot — chỉ bãi của mình (ADMIN mọi bãi).
  const ownParking = (req, res) => {
    if (req.user.role === 'STAFF' && req.user.parkingId !== req.params.id) { res.status(403).json({ error: 'FORBIDDEN' }); return false; }
    return true;
  };
  const slotPath = (req) => `/api/slots${req.params.code ? `/${encodeURIComponent(req.params.code)}` : ''}`;
  app.post('/api/parkings/:id/slots', need('STAFF', 'ADMIN'), async (req, res) => {
    if (ownParking(req, res)) await forward(res, reg.get(req.params.id), slotPath(req), { method: 'POST', body: req.body });
  });
  app.patch('/api/parkings/:id/slots/:code', need('STAFF', 'ADMIN'), async (req, res) => {
    if (ownParking(req, res)) await forward(res, reg.get(req.params.id), slotPath(req), { method: 'PATCH', body: req.body });
  });
  app.delete('/api/parkings/:id/slots/:code', need('STAFF', 'ADMIN'), async (req, res) => {
    if (ownParking(req, res)) await forward(res, reg.get(req.params.id), slotPath(req), { method: 'DELETE' });
  });

  app.get('/api/parkings/:id/reservations', need('STAFF', 'ADMIN'), async (req, res) => {
    if (req.user.role === 'STAFF' && req.user.parkingId !== req.params.id) return res.status(403).json({ error: 'FORBIDDEN' });
    await forward(res, reg.get(req.params.id), '/api/reservations');
  });

  mountSessions(app, { reg, need, forward, reserveTimeoutMs: reserveMs, commandMode, broker });

  // Quản trị: trạng thái các node; thêm bãi mới không cần sửa code (tính mở rộng).
  app.get('/api/admin/nodes', need('ADMIN'), (_req, res) =>
    res.json(reg.all().map((n) => ({ ...info(n), url: n.url, fails: n.fails }))));

  app.post('/api/admin/nodes', need('ADMIN'), async (req, res) => {
    const { parkingId, name, apiUrl, address, lat, lng } = req.body ?? {};
    const coord = (v, max) => v == null || v === '' ? null : (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= max ? Number(v) : NaN);
    const [la, ln] = [coord(lat, 90), coord(lng, 180)];
    if (Number.isNaN(la) || Number.isNaN(ln)) return res.status(400).json({ error: 'lat/lng must be valid coordinates' });
    if (!/^[A-Z0-9]{1,8}$/.test(parkingId ?? '') || !name || !/^https?:\/\//.test(apiUrl ?? '')) {
      return res.status(400).json({ error: 'parkingId (A-Z0-9), name, apiUrl (http...) are required' });
    }
    if (reg.get(parkingId)) return res.status(409).json({ error: 'PARKING_EXISTS' });
    const row = (await pool.query(
      `INSERT INTO parking_nodes(parking_id, name, api_url, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [parkingId, name, apiUrl, address ?? null, la, ln])).rows[0];
    reg.add(row);
    res.status(201).json(info(reg.get(parkingId)));
  });

  app.use((err, _req, res, _next) => {
    log.error('lỗi xử lý request', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  return app;
}

module.exports = { makeApp };
