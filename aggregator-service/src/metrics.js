// GS-04: số đo cho Prometheus ở GET /metrics (registry riêng mỗi app).
const client = require('prom-client');

function mountMetrics(app, { reg, instance = process.env.INSTANCE_ID ?? '1' }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ aggregator: `aggregator-${instance}` });   // không dùng tên 'instance': Prometheus đã có nhãn đó
  const http = new client.Histogram({
    name: 'http_request_duration_seconds', help: 'Thời gian xử lý request',
    labelNames: ['method', 'route', 'code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
  });
  // Trạng thái failure detector / circuit breaker theo từng bãi.
  new client.Gauge({
    name: 'parking_node_up', help: '1 = bãi ONLINE, 0 = OFFLINE (mạch mở)', labelNames: ['node'], registers: [registry],
    collect() { for (const n of reg.all()) this.set({ node: n.id }, n.status === 'ONLINE' ? 1 : 0); },
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
}

module.exports = { mountMetrics };
