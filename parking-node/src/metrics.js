// GS-04: số đo cho Prometheus ở GET /metrics. Registry riêng cho mỗi app (test tạo nhiều app trong một tiến trình).
const client = require('prom-client');
const { availability } = require('./slots');


function makeRelayLagMetric(registry, client) {
  const histogram = new client.Histogram({
    name: 'relay_lag_seconds',
    help: 'Độ trễ từ lúc tạo sự kiện outbox đến khi broker xác nhận gửi',
    buckets: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  return {
    observe(rows, confirmedAt) {
      for (const event of rows) {
        const createdAt = new Date(event.created_at).getTime();

        if (Number.isFinite(createdAt)) {
          histogram.observe(
            Math.max(0, (confirmedAt - createdAt) / 1000),
          );
        }
      }
    },
  };
}


// PD-25: tin lệnh RabbitMQ giao lại (consumer trước chết/nack trước khi ack). Module dùng chung, mỗi registry đăng ký lại.
const cmdRedelivered = new client.Counter({ name: 'cmd_redelivered_total', help: 'Số tin lệnh được RabbitMQ giao lại', registers: [] });

let fencingRejectedCounter = null;

function incFencingRejected(job = 'default') {
  if (fencingRejectedCounter) {
    try { fencingRejectedCounter.inc({ job }); } catch { /* ignore */ }
  }
}

function mountMetrics(app, { pool, parkingId, extra = [] }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ parking: parkingId });
  registry.registerMetric(cmdRedelivered);

  // PD-10: Đếm số lệnh bị từ chối do stale fencing token
  fencingRejectedCounter = new client.Counter({
    name: 'fencing_rejected_total',
    help: 'Số lần từ chối lệnh từ Leader cũ do fencing token không hợp lệ',
    labelNames: ['job'],
    registers: [registry],
  });

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

module.exports = { mountMetrics, makeRelayLagMetric, incFencingRejected, incRedelivered: () => cmdRedelivered.inc() };
