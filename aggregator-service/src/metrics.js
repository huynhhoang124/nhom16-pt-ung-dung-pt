// GS-04: số đo cho Prometheus ở GET /metrics (registry riêng mỗi app).
const client = require('prom-client');

// PD-25: số đo kênh lệnh, ghi từ command-flow và expired-commands. Tạo một lần ở mức module, mỗi registry đăng ký lại.
const commandDuration = new client.Histogram({
  name: 'command_duration_seconds', help: 'Thời gian từ lúc tạo lệnh đến khi có kết quả cuối (DONE/FAILED/EXPIRED)',
  labelNames: ['type', 'parking_id', 'status'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 30], registers: [],
});
const cmdDead = new client.Counter({ name: 'cmd_dead_total', help: 'Số lệnh quá delivery-limit bị chuyển sang cmd.dead', registers: [] });

function observeCommand(row) {
  const created = new Date(row.created_at).getTime();
  if (!Number.isFinite(created)) return;
  commandDuration.observe({ type: row.type, parking_id: row.parking_id, status: row.status }, Math.max(0, (Date.now() - created) / 1000));
}

function mountMetrics(app, { reg, leader, pool, instance = process.env.INSTANCE_ID ?? '1' }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ aggregator: `aggregator-${instance}` });   // không dùng tên 'instance': Prometheus đã có nhãn đó
  registry.registerMetric(commandDuration);
  registry.registerMetric(cmdDead);
  // Lệnh PENDING lâu nhất: tăng dần khi bãi/broker gián đoạn (lệnh chờ trong bảng commands)
  if (pool) new client.Gauge({
    name: 'cmd_oldest_age_seconds', help: 'Tuổi (giây) của lệnh PENDING lâu nhất, 0 nếu không có', registers: [registry],
    async collect() {
      const r = await pool.query("SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0) AS s FROM commands WHERE status='PENDING'")
        .catch(() => ({ rows: [{ s: 0 }] }));
      this.set(Number(r.rows[0].s));
    },
  });
  const http = new client.Histogram({
    name: 'http_request_duration_seconds', help: 'Thời gian xử lý request',
    labelNames: ['method', 'route', 'code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
  });

  const crossZone = new client.Counter({
    name: 'cross_zone_requests_total', help: 'Số request gửi sang Aggregator vùng khác', registers: [registry],
  });

  // PD-10: Trạng thái leader của bản Aggregator này
  new client.Gauge({
    name: 'aggregator_is_leader',
    help: '1 nếu bản Aggregator này là leader, 0 nếu là follower',
    registers: [registry],
    collect() {
      this.set(leader?.isLeader?.() ? 1 : 0);
    },
  });

  // Trạng thái failure detector / circuit breaker theo từng bãi.
  new client.Gauge({
    name: 'parking_node_up', help: '1 = bãi ONLINE/DEGRADED (HTTP sống), 0 = OFFLINE (mạch mở)', labelNames: ['node'], registers: [registry],
    collect() { for (const n of reg.all()) this.set({ node: n.id }, n.status !== 'OFFLINE' ? 1 : 0); },
  });
  new client.Gauge({
    name: 'parking_node_fails', help: 'Số lần lỗi liên tiếp khi gọi bãi', labelNames: ['node'], registers: [registry],
    collect() { for (const n of reg.all()) this.set({ node: n.id }, Math.min(n.fails, 99)); },
  });

  app.use((req, res, next) => {
    const end = http.startTimer();
    res.on('finish', () => end({ method: req.method, route: req.route?.path ?? 'other', code: res.statusCode }));
    next();
  });
  app.get('/metrics', async (_req, res) => {
    res.set('content-type', registry.contentType);
    res.end(await registry.metrics());
  });
  return crossZone;
}

module.exports = { mountMetrics, observeCommand, incCmdDead: () => cmdDead.inc() };
