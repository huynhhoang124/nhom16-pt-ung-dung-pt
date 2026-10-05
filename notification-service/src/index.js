// NV-08: dịch vụ thông báo — một bên nhận sự kiện MỚI mà không phải sửa node (lợi ích của pub/sub).
//   parking.events (queue notification.events) -> rules -> exchange user.notifications (user.<id> | broadcast)
//   -> mỗi Aggregator đẩy cho trình duyệt qua Socket.IO.
// Dịch vụ này tắt thì đặt chỗ vẫn chạy bình thường; bật lại thì xử lý tiếp tin còn nằm trong queue (durable).
const { makeConnector } = require('./amqp-connect');
const { makeRules } = require('./rules');

const url = process.env.RABBITMQ_URL ?? 'amqp://localhost';
const log = (level, msg, f) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'notification', msg, ...f }));
const rules = makeRules();
const connectAny = makeConnector(url);   // PT-03: danh sách nút của cụm

async function run() {
  let conn;
  try {
    conn = await connectAny();
    conn.on('error', () => {});
    conn.on('close', () => { log('error', 'RabbitMQ mất kết nối, thử lại sau 5s'); setTimeout(run, 5000); });
    const ch = await conn.createConfirmChannel();
    await ch.assertExchange('parking.events', 'topic', { durable: true });
    await ch.assertExchange('user.notifications', 'topic', { durable: true });
    await ch.assertQueue('notification.events', { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    await ch.bindQueue('notification.events', 'parking.events', 'parking.#');
    await ch.prefetch(20);
    await ch.consume('notification.events', async (m) => {
      if (!m) return;
      try {
        const e = JSON.parse(m.content.toString());
        for (const n of rules(e)) {
          ch.publish('user.notifications', n.to === '*' ? 'broadcast' : `user.${n.to}`,
            Buffer.from(JSON.stringify({ ...n, parkingId: e.parkingId, at: new Date().toISOString() })),
            { persistent: true, contentType: 'application/json', ...(e.requestId && { correlationId: e.requestId }) });
          log('info', 'gửi thông báo', { requestId: e.requestId, to: n.to, text: n.text });
        }
        await ch.waitForConfirms();
        ch.ack(m);   // ack SAU khi broker nhận thông báo: chết giữa chừng thì xử lý lại (at-least-once)
      } catch (err) {
        log('error', 'bỏ tin lỗi', { error: err.message });
        ch.ack(m);
      }
    });
    log('info', 'Đã kết nối RabbitMQ, đang nhận sự kiện');
  } catch (e) {
    log('error', 'RabbitMQ chưa sẵn sàng, thử lại sau 5s', { error: e.message });
    if (conn) conn.close().catch(() => {}); else setTimeout(run, 5000);
  }
}
run();
