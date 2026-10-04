// NV-05: cổng bãi quét QR. Node tự kiểm chữ ký + hạn + đúng bãi rồi cho xe vào/ra như thao tác thường.
const qr = require('./qr');
const s = require('./slots');

const tokenFor = (secret, parkingId, r) =>
  qr.sign(secret, { p: parkingId, r: r.id, e: Math.floor(new Date(r.expire_time ?? r.expireTime).getTime() / 1000) });

function mountGate(app, { pool, parkingId, qrSecret }) {
  app.post('/api/gate/scan', async (req, res) => {
    const { token, action } = req.body ?? {};
    if (!['enter', 'exit'].includes(action)) return res.status(400).json({ error: 'action must be enter or exit' });
    // Xe đã vào thì QR quá giờ giữ chỗ vẫn phải dùng được để ra: chỉ kiểm hạn khi vào.
    const v = qr.verify(qrSecret, token, action === 'exit' ? 0 : undefined);
    if (v.error) return res.status(401).json({ error: v.error });
    if (v.payload.p !== parkingId) return res.status(403).json({ error: 'WRONG_PARKING' });

    if (action === 'enter') {
      const r = (await pool.query(
        `SELECT r.status, s.slot_code FROM reservations r JOIN parking_slots s ON s.id = r.slot_id WHERE r.id=$1`,
        [v.payload.r])).rows[0];
      if (!r) return res.status(404).json({ error: 'RESERVATION_NOT_FOUND' });
      if (r.status !== 'ACTIVE') return res.status(409).json({ error: 'QR_USED', status: r.status });
      const out = await s.moveSlot(pool, parkingId, r.slot_code, ['RESERVED'], 'OCCUPIED', 'CAR_ENTER');
      return res.status(out.code).json(out.body);
    }
    const sess = (await pool.query(
      `SELECT s.slot_code FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id
       WHERE ps.reservation_id=$1 AND ps.exited_at IS NULL`, [v.payload.r])).rows[0];
    if (!sess) return res.status(409).json({ error: 'NOT_INSIDE' });
    const out = await s.moveSlot(pool, parkingId, sess.slot_code, ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT');
    res.status(out.code).json(out.body);   // chưa trả tiền -> 402 như thường
  });
}

module.exports = { mountGate, tokenFor };
