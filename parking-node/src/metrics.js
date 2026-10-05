// GS-04: số đo cho Prometheus ở GET /metrics. Registry riêng cho mỗi app (test tạo nhiều app trong một tiến trình).
const client = require('prom-client');
const { availability } = require('./slots');

function mountMetrics(app, { pool, parkingId, extra = [] }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ parking: parkingId });
  const http = new client.Histogram({
    name: 'http_request_duration_seconds', help: 'Thời gian xử lý request',
    labelNames: ['method', 'route', 'code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
  });
  // Outbox chưa gửi: tăng dần khi RabbitMQ sập, về 0 khi relay gửi hết (minh hoạ "không mất sự kiện").
  new client.Gauge({
    name: 'outbox_unpublished', help: 'Số sự kiện trong outbox chưa gửi lên broker', registers: [registry],
    async collect() { this.set((await pool.query('SELECT count(*)::int AS n FROM parking_events WHERE published_at IS NULL')).rows[0].n); },
  });
  new client.Gauge({
    name: 'parking_slots', help: 'Số chỗ theo loại xe (state=available|total)', labelNames: ['type', 'state'], registers: [registry],
    async collect() {
      this.reset();
      for (const [type, v] of Object.entries((await availability(pool, parkingId)).byType)) {
        this.set({ type, state: 'available' }, v.available);
        this.set({ type, state: 'total' }, v.total);
      }
    },
  });
  for (const make of extra) make(registry, client);   // số đo bổ sung (vd độ trễ bản sao DB, PT-02)

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
