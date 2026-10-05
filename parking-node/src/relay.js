// Message relay của Transactional Outbox: đọc parking_events chưa gửi, publish lên broker theo thứ tự id,
// chỉ đánh dấu published_at SAU khi broker xác nhận (publisher confirm).
// Chết giữa "publish" và "đánh dấu" => lần sau gửi lại (at-least-once); Aggregator bỏ tin trùng nhờ version.
const { makeConnector } = require('./amqp-connect');

const EXCHANGE = 'parking.events';

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
  return async (routingKey, payload) => {
    try {
      const c = await channel();
      c.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)),
        { persistent: true, contentType: 'application/json', ...(payload.requestId && { correlationId: payload.requestId }) });
      await c.waitForConfirms();
      return true;
    } catch {
      reset();
      return false;
    }
  };
}

function makeRelay(pool, publish) {
  let running = false;
  return async function relayOnce() {
    if (running) return 0;               // không chạy chồng (setInterval có thể gọi khi lần trước chưa xong)
    running = true;
    let sent = 0;
    try {
      const { rows } = await pool.query(
        'SELECT id, payload FROM parking_events WHERE published_at IS NULL ORDER BY id LIMIT 100');
      for (const e of rows) {
        const key = `parking.${e.payload.parkingId}.slot.${e.payload.slot}`;
        if (!(await publish(key, e.payload))) break;   // dừng để giữ thứ tự; lần sau gửi tiếp từ đây
        await pool.query('UPDATE parking_events SET published_at = now() WHERE id = $1', [e.id]);
        sent++;
      }
    } finally {
      running = false;
    }
    return sent;
  };
}

module.exports = { amqpPublisher, makeRelay, EXCHANGE };
