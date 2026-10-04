const express = require('express');
const s = require('./slots');
const { normalizePlate, isPlate } = require('./plate');
const { invalidRule } = require('./pricing');
const { savePricing } = require('./db');
const { mountGate, tokenFor } = require('./gate');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// qrSecret: khoá ký QR riêng của bãi (env QR_SECRET); không đặt thì suy từ khoá nội bộ.
function makeApp({ pool, parkingId, internalKey, reservationMinutes = 15, qrSecret = `${internalKey}:qr:${parkingId}` }) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  // /health không cần khoá: Aggregator dùng làm failure detector. Kiểm tra cả DB.
  app.get('/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'UP', parkingId }); }
    catch { res.status(503).json({ status: 'DOWN', parkingId }); }
  });

  // Chỉ Aggregator (và barrier của bãi) được gọi API nghiệp vụ.
  app.use('/api', (req, res, next) =>
    req.get('x-internal-key') === internalKey ? next() : res.status(401).json({ error: 'UNAUTHORIZED' }));

  const send = (res, r) => res.status(r.code).json(r.body);

  app.get('/api/availability', async (_req, res) => res.json(await s.availability(pool, parkingId)));
  const type = (req) => (['CAR', 'MOTO'].includes(req.query.type) ? req.query.type : undefined);
  app.get('/api/slots', async (req, res) => res.json(await s.listSlots(pool, false, type(req))));
  app.get('/api/slots/available', async (req, res) => res.json(await s.listSlots(pool, true, type(req))));

  app.post('/api/reservations', async (req, res) => {
    const { requestId, userId, slotCode } = req.body ?? {};
    if (![requestId, userId, slotCode, req.body?.licensePlate].every((v) => typeof v === 'string' && v && v.length <= 128)) {
      return res.status(400).json({ error: 'requestId, userId, slotCode, licensePlate are required' });
    }
    const licensePlate = normalizePlate(req.body.licensePlate);
    if (!isPlate(licensePlate)) return res.status(400).json({ error: 'INVALID_PLATE' });
    // NV-01: giờ đến (ISO, trong 7 ngày tới) + thời lượng 30 phút – 24 giờ; bỏ trống = đặt ngay 2 giờ.
    const { startTime, durationMinutes = 120 } = req.body;
    if (startTime !== undefined && !(Date.parse(startTime) < Date.now() + 7 * 86400_000)) {
      return res.status(400).json({ error: 'INVALID_START_TIME' });
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 1440) {
      return res.status(400).json({ error: 'INVALID_DURATION' });
    }
    const out = await s.reserve(pool, parkingId,
      { requestId, userId, slotCode, licensePlate, startTime, durationMinutes }, reservationMinutes);
    if (out.code < 300) out.body = { ...out.body, qrToken: tokenFor(qrSecret, parkingId, out.body) };
    send(res, out);
  });

  app.get('/api/slots/:code/schedule', async (req, res) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '')) return res.status(400).json({ error: 'date=YYYY-MM-DD is required' });
    res.json(await s.slotSchedule(pool, req.params.code, req.query.date));
  });

  app.get('/api/reservations', async (req, res) => res.json((await s.listReservations(pool, req.query.userId))
    .map((r) => (r.status === 'ACTIVE' ? { ...r, qrToken: tokenFor(qrSecret, parkingId, r) } : r))));

  // Lịch sử gửi xe: ?plate=&userId=&from=&to= (ISO 8601)
  app.get('/api/sessions', async (req, res) => {
    const { plate, userId, from, to } = req.query;
    if ([from, to].some((d) => d && Number.isNaN(Date.parse(d)))) return res.status(400).json({ error: 'from/to must be ISO dates' });
    res.json(await s.listSessions(pool, { plate, userId, from, to }));
  });

  app.delete('/api/reservations/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'RESERVATION_NOT_ACTIVE' });
    send(res, await s.endReservation(pool, parkingId, req.params.id, 'CANCELLED', req.query.userId));
  });

  app.get('/api/sessions/:id/quote', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    const q = await s.quote(pool, req.params.id);
    q ? res.json(q) : res.status(404).json({ error: 'SESSION_NOT_FOUND' });
  });

  app.post('/api/sessions/:id/pay', async (req, res) => {
    const { method, paymentKey, userId } = req.body ?? {};
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (!['ONLINE', 'CASH'].includes(method) || typeof paymentKey !== 'string' || !paymentKey || paymentKey.length > 128) {
      return res.status(400).json({ error: 'method (ONLINE|CASH) and paymentKey are required' });
    }
    send(res, await s.pay(pool, { sessionId: req.params.id, method, paymentKey, userId }));
  });

  // Bảng giá của bãi (NV-03). PUT nhận mảng quy tắc, mỗi loại xe một quy tắc.
  app.get('/api/pricing', async (_req, res) => res.json(await s.listPricing(pool)));
  app.put('/api/pricing', async (req, res) => {
    const rules = req.body;
    if (!Array.isArray(rules) || !rules.length) return res.status(400).json({ error: 'body must be a non-empty array of rules' });
    const bad = rules.map(invalidRule).find(Boolean);
    if (bad) return res.status(400).json({ error: bad });
    await savePricing(pool, rules);
    res.json(await s.listPricing(pool));
  });

  mountGate(app, { pool, parkingId, qrSecret });

  const moves = {
    enter: [['RESERVED', 'AVAILABLE'], 'OCCUPIED', 'CAR_ENTER'],   // AVAILABLE -> OCCUPIED: xe vào không đặt trước
    exit: [['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT'],
    maintenance: [['AVAILABLE'], 'MAINTENANCE', 'MAINTENANCE_ON'],
    unmaintenance: [['MAINTENANCE'], 'AVAILABLE', 'MAINTENANCE_OFF'],
  };
  app.post('/api/slots/:code/:action', async (req, res) => {
    const m = moves[req.params.action];
    if (!m) return res.status(404).json({ error: 'UNKNOWN_ACTION' });
    // Biển số không bắt buộc (barrier có thể không đọc được); có thì phải hợp lệ.
    const plate = req.body?.licensePlate ? normalizePlate(req.body.licensePlate) : undefined;
    if (plate !== undefined && !isPlate(plate)) return res.status(400).json({ error: 'INVALID_PLATE' });
    send(res, await s.moveSlot(pool, parkingId, req.params.code, ...m, plate, { cash: req.body?.cash === true }));
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  return app;
}

module.exports = { makeApp };
