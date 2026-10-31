// NV-06: lịch sử gửi xe; NV-03: phí, bảng giá. Dữ liệu phiên nằm ở DB từng bãi -> gom song song, bãi lỗi thì báo thiếu.
const enc = encodeURIComponent;

function mountSessions(app, { reg, need, forward, reserveTimeoutMs }) {
  const gatherSessions = async (query) => {
    const parts = await reg.gather(async (n) => ({ sessions: await reg.json(n, `/api/sessions?${query}`) }));
    return {
      sessions: parts.flatMap((p) => (p.sessions ?? []).map((x) => ({ parkingId: p.parkingId, ...x })))
        .sort((a, b) => b.enteredAt.localeCompare(a.enteredAt)),
      unavailable: parts.filter((p) => p.status === 'OFFLINE').map((p) => p.parkingId),
    };
  };

  // Tra biển số trên toàn hệ thống (nhân viên, quản trị).
  app.get('/api/sessions/search', need('STAFF', 'ADMIN'), async (req, res) => {
    const plate = String(req.query.plate ?? '').trim();
    if (plate.replace(/[^a-z0-9]/gi, '').length < 3) return res.status(400).json({ error: 'PLATE_TOO_SHORT' });
    res.json(await gatherSessions(`plate=${enc(plate)}`));
  });

  // Lịch sử gửi xe của tôi (các phiên vào bằng đặt chỗ của tài khoản này).
  app.get('/api/me/sessions', need('USER'), async (req, res) =>
    res.json(await gatherSessions(`userId=${enc(req.user.sub)}`)));

  // Phiên gần đây của một bãi.
  app.get('/api/parkings/:id/sessions', need('STAFF', 'ADMIN'), async (req, res) => {
    if (req.user.role === 'STAFF' && req.user.parkingId !== req.params.id) return res.status(403).json({ error: 'FORBIDDEN' });
    await forward(res, reg.get(req.params.id), '/api/sessions');
  });

  // Phí tạm tính của một phiên đang gửi (NV-03).
  app.get('/api/parkings/:id/sessions/:sid/quote', need(), (req, res) =>
    forward(res, reg.get(req.params.id), `/api/sessions/${enc(req.params.sid)}/quote`));

  // NV-04: người dùng trả tiền phiên của mình. Idempotency-Key bắt buộc; timeout -> 504, bấm lại cùng key an toàn.
  app.post('/api/me/sessions/:id/:sid/pay', need('USER'), async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || key.length > 64) return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    await forward(res, reg.get(req.params.id), `/api/sessions/${enc(req.params.sid)}/pay`, {
      method: 'POST', ms: reserveTimeoutMs(), retry: true,
      body: { method: 'ONLINE', paymentKey: `${req.user.sub}:${key}`, userId: req.user.sub },
    });
  });

  // UX-02: thống kê gom từ các bãi (truy vấn phân tán). Bãi lỗi -> ghi tên trong `unavailable`, số liệu là MỘT PHẦN.
  // STAFF chỉ xem bãi của mình.
  
  app.get('/api/admin/stats', need('STAFF', 'ADMIN'), async (req, res) => {
    const q = new URLSearchParams(
      Object.entries({
        from: req.query.from,
        to: req.query.to,
      }).filter(([, v]) => v)
    ).toString();

    const useStatsService =
      process.env.USE_STATS_SERVICE === 'true';

    // Giữ cách thống kê cũ để đối chiếu khi cần.
    if (!useStatsService) {
      const parts = (
        await reg.gather(async (n) => ({
          stats: await reg.json(n, `/api/stats?${q}`),
        }))
      ).filter(
        (p) =>
          req.user.role !== 'STAFF' ||
          p.parkingId === req.user.parkingId
      );

      const ok = parts
        .filter((p) => p.stats)
        .map((p) => ({ parkingId: p.parkingId, ...p.stats }));

      const sum = (key) =>
        ok.reduce((n, p) => n + (Number(p[key]) || 0), 0);

      const exited = sum('exited');

      return res.json({
        total: {
          sessions: sum('sessions'),
          revenue: sum('revenue'),
          occupied: sum('occupied'),
          total: sum('total'),
          avgMinutes: exited
            ? Math.round(
                ok.reduce(
                  (n, p) =>
                    n + (Number(p.avgMinutes) || 0) * (Number(p.exited) || 0),
                  0
                ) / exited
              )
            : 0,
          byHour: Array.from({ length: 24 }, (_, h) =>
            ok.reduce((n, p) => n + (Number(p.byHour?.[h]) || 0), 0)
          ),
        },
        parkings: ok,
        unavailable: parts
          .filter((p) => !p.stats)
          .map((p) => p.parkingId),
      });
    }

    // Cách mới: đọc thống kê đã được stats-service tổng hợp.
    try {
      const statsUrl =
        process.env.STATS_SERVICE_URL || 'http://stats-service:8011';

      const response = await fetch(
        `${statsUrl}/api/stats${q ? `?${q}` : ''}`,
        { signal: AbortSignal.timeout(3000) }
      );

      if (!response.ok) {
        throw new Error(`stats-service returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // STAFF chỉ được xem bãi của mình.
      if (req.user.role === 'STAFF') {
        const ownParking = (data.parkings || []).filter(
          (p) => p.parkingId === req.user.parkingId
        );

        const own = ownParking[0];
        if (!own) {
          return res.status(503).json({
            error: 'STATS_UNAVAILABLE',
          });
        }

        return res.json({
          total: {
            sessions: Number(own.sessions) || 0,
            revenue: Number(own.revenue) || 0,
            occupied: Number(own.occupied) || 0,
            total: Number(own.total) || 0,
            avgMinutes: Number(own.avgMinutes) || 0,
            byHour: Array.from(
              { length: 24 },
              (_, h) => Number(own.byHour?.[h]) || 0
            ),
          },
          parkings: ownParking,
          unavailable: [],
        });
      }

      return res.json({
        total: data.total,
        parkings: data.parkings || [],
        unavailable: data.unavailable || [],
      });
    } catch (error) {
      console.error('[aggregator] Stats service failed:', error.message);
      return res.status(503).json({
        error: 'STATS_UNAVAILABLE',
      });
    }
  });


  // Bảng giá: ai cũng xem được; nhân viên bãi đó hoặc quản trị được sửa.
  app.get('/api/parkings/:id/pricing', (req, res) => forward(res, reg.get(req.params.id), '/api/pricing'));
  app.put('/api/parkings/:id/pricing', need('STAFF', 'ADMIN'), async (req, res) => {
    if (req.user.role === 'STAFF' && req.user.parkingId !== req.params.id) return res.status(403).json({ error: 'FORBIDDEN' });
    await forward(res, reg.get(req.params.id), '/api/pricing', { method: 'PUT', body: req.body });
  });
}

module.exports = { mountSessions };
