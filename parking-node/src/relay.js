// Message relay của Transactional Outbox: đọc parking_events chưa gửi, publish lên broker theo thứ tự id,
// chỉ đánh dấu published_at SAU khi broker xác nhận (publisher confirm).
// Chết giữa "publish" và "đánh dấu" => lần sau gửi lại (at-least-once); Aggregator bỏ tin trùng nhờ version.
const { makeConnector } = require('./amqp-connect');
const { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } = require('@opentelemetry/api');
const { log } = require('./log');

const EXCHANGE = 'parking.events';
const tracer = trace.getTracer('parking-node/outbox');

// publish(routingKey, payload) -> true nếu broker đã xác nhận. Tự kết nối lại khi broker sập.
function amqpPublisher(url) {
  const connectAny = makeConnector(url);   // PT-03: url có thể là danh sách nút của cụm
  let conn = null;
  let ch = null;
  const reset = () => {
    const old = conn;
    conn = ch = null;
    if (old) old.close().catch(() => {});
  };
  async function channel() {
    if (ch) return ch;
    conn = await connectAny();
    conn.on('error', () => {});
    conn.on('close', () => { conn = ch = null; });
    const c = await conn.createConfirmChannel();
    c.on('error', () => {});
    c.on('close', () => { ch = null; });
    await c.assertExchange(EXCHANGE, 'topic', { durable: true });
    ch = c;
    return c;
  }
  const publish = async (routingKey, payload) => {
    try {
      const c = await channel();
      const headers = {};
      propagation.inject(context.active(), headers);
      c.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)),
        { persistent: true, contentType: 'application/json', headers,
          ...(payload.requestId && { correlationId: payload.requestId }) });
      await c.waitForConfirms();
      return true;
    } catch {
      reset();
      return false;
    }
  };
  publish.close = async () => {
    const old = conn;
    conn = ch = null;
    if (old) await old.close().catch(() => {});
  };
  return publish;
}

function makeRelay(pool, publish, logger = log) {
  let running = false;
  return async function relayOnce() {
    if (running) return 0;               // không chạy chồng (setInterval có thể gọi khi lần trước chưa xong)
    running = true;
    let sent = 0;
    try {
      const { rows } = await pool.query(
        'SELECT id, payload, traceparent FROM parking_events WHERE published_at IS NULL ORDER BY id LIMIT 100');
      for (const e of rows) {
        const key = `parking.${e.payload.parkingId}.slot.${e.payload.slot}`;
        const parent = propagation.extract(ROOT_CONTEXT, { traceparent: e.traceparent });
        const published = await tracer.startActiveSpan('outbox.publish', {
          kind: SpanKind.PRODUCER,
          attributes: {
            'messaging.system': 'rabbitmq',
            'messaging.destination.name': EXCHANGE,
            'messaging.operation.type': 'publish',
            'outbox.event_id': String(e.id),
          },
        }, parent, async (span) => {
          try {
            if (!(await publish(key, e.payload))) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: 'RabbitMQ publisher confirm failed' });
              return false;
            }
            await pool.query('UPDATE parking_events SET published_at = now() WHERE id = $1', [e.id]);
            logger.info('outbox đã gửi', {
              requestId: e.payload.requestId, traceId: span.spanContext().traceId,
              eventId: e.id, type: e.payload.type, routingKey: key,
            });
            return true;
          } catch (error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
            throw error;
          } finally {
            span.end();
          }
        });
        if (!published) break;   // dừng để giữ thứ tự; lần sau gửi tiếp từ đây
        sent++;
      }
    } finally {
      running = false;
    }
    return sent;
  };
}

module.exports = { amqpPublisher, makeRelay, EXCHANGE };
