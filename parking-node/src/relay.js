// Message relay của Transactional Outbox: đọc parking_events chưa gửi, publish lên broker theo thứ tự id,
// chỉ đánh dấu published_at SAU khi broker xác nhận (publisher confirm).
// Chết giữa "publish" và "đánh dấu" => lần sau gửi lại (at-least-once); Aggregator bỏ tin trùng nhờ version.
const { makeConnector } = require('./amqp-connect');
const { log } = require('./log');
const { context, propagation, SpanKind, SpanStatusCode, trace } = require('@opentelemetry/api');

const EXCHANGE = 'parking.events';
const relayTracer = trace.getTracer('parking-node/outbox');

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
  const publish = async (routingKey, payload, traceparent) => {
    try {
      const c = await channel();
      const parent = traceparent ? propagation.extract(context.active(), { traceparent }) : context.active();
      await relayTracer.startActiveSpan('outbox.publish', { kind: SpanKind.PRODUCER,
        attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': EXCHANGE, 'messaging.rabbitmq.routing_key': routingKey },
      }, parent, async (span) => {
        try {
          const headers = {};
          propagation.inject(context.active(), headers);
          c.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)),
            { persistent: true, contentType: 'application/json', headers, ...(payload.requestId && { correlationId: payload.requestId }) });
          await c.waitForConfirms();
        } catch (error) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          throw error;
        } finally {
          span.end();
        }
      });
      return true;
    } catch {
      reset();
      return false;
    }
  };
  publish.close = async () => { const old = conn; conn = ch = null; if (old) await old.close().catch(() => {}); };


  publish.publishBatch = async (events) => {
    const spans = [];
    try {
      const c = await channel();

      for (const e of events) {
        const key = `parking.${e.payload.parkingId}.slot.${e.payload.slot}`;
        const parent = e.traceparent ? propagation.extract(context.active(), { traceparent: e.traceparent }) : context.active();
        relayTracer.startActiveSpan('outbox.publish', { kind: SpanKind.PRODUCER,
          attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': EXCHANGE, 'messaging.rabbitmq.routing_key': key },
        }, parent, (span) => {
          spans.push(span);
          const headers = {};
          propagation.inject(context.active(), headers);
          c.publish(EXCHANGE, key, Buffer.from(JSON.stringify(e.payload)),
            { persistent: true, contentType: 'application/json', headers, ...(e.payload.requestId && { correlationId: e.payload.requestId }) });
        });
      }

      await c.waitForConfirms();
      return true;
    } catch (error) {
      for (const span of spans) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }
      reset();
      return false;
    } finally {
      for (const span of spans) span.end();
    }
  };


  return publish;
}


function makeRelay(pool, publish, logger = log, onConfirmed = () => {}) {
  let running = false;

  return async function relayOnce() {
    if (running) return 0;
    running = true;

    let sent = 0;
    let client;

    try {
      client = await pool.connect();
      await client.query('BEGIN');

      const { rows } = await client.query(`
        SELECT id, payload, created_at, traceparent
        FROM parking_events
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      `);

      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      let confirmed;
      if (typeof publish.publishBatch === 'function') {
        confirmed = await publish.publishBatch(rows);
      } else {
        confirmed = true;
        for (const e of rows) {
          const key = `parking.${e.payload.parkingId}.slot.${e.payload.slot}`;
          if (!(await publish(key, e.payload, e.traceparent))) {
            confirmed = false;
            break;
          }
        }
      }

      if (!confirmed) {
        await client.query('ROLLBACK');
        return 0;
      }

      const confirmedAt = Date.now();

      const ids = rows.map((e) => e.id);

      await client.query(
        'UPDATE parking_events SET published_at = clock_timestamp() WHERE id = ANY($1)',
        [ids],
      );

      for (const e of rows) {
        const key = `parking.${e.payload.parkingId}.slot.${e.payload.slot}`;
        logger.info('outbox đã gửi', {
          requestId: e.payload.requestId,
          eventId: e.id,
          type: e.payload.type,
          routingKey: key,
        });
      }

      await client.query('COMMIT');

      try {
        onConfirmed(rows, confirmedAt);
      } catch (e) {
        logger.error('không ghi được metric relay lag', {
          error: e.message,
        });
      }

      sent = rows.length;
      return sent;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw e;
    } finally {
      client?.release();
      running = false;
    }
  };
}


module.exports = { amqpPublisher, makeRelay, EXCHANGE };
