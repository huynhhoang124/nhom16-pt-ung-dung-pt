// Nhận sự kiện slot từ RabbitMQ và giữ cache trạng thái slot trong RAM (chỉ-đọc, nguồn gốc ở DB bãi).
const amqp = require('amqplib');

const EXCHANGE = 'parking.events';
const QUEUE = 'aggregator.slot-updates';

// Mỗi slot chỉ có MỘT người ghi (node của bãi đó) nên version tăng một chiều:
// tin có version <= bản đang giữ là tin trùng (relay gửi lại) hoặc tin cũ (đến sai thứ tự) -> bỏ.
function applyEvent(cache, e) {
  const k = `${e.parkingId}:${e.slot}`;
  const cur = cache.get(k);
  if (cur && e.version <= cur.version) return false;
  cache.set(k, { status: e.status, version: e.version });
  return true;
}

// Anti-entropy: lấy ảnh chụp slot từ node rồi gộp bằng "giữ version lớn hơn".
// Phép gộp này giao hoán, kết hợp, idempotent => chạy bao nhiêu lần, theo thứ tự nào cũng ra cùng kết quả.
async function reconcile(reg, cache, n, onApplied) {
  let applied = 0;
  for (const s of await reg.json(n, '/api/slots')) {
    const e = { event: 'SLOT_UPDATED', type: 'RECONCILE', parkingId: n.id, slot: s.slotCode, status: s.status, version: s.version };
    if (applyEvent(cache, e)) { applied++; onApplied?.(e); }
  }
  return applied;
}

const slotsFromCache = (cache, parkingId) =>
  [...cache].filter(([k]) => k.startsWith(`${parkingId}:`))
    .map(([k, v]) => ({ slotCode: k.slice(parkingId.length + 1), ...v }))
    .sort((a, b) => a.slotCode.localeCompare(b.slotCode));

// Consumer: queue durable, ack thủ công sau khi xử lý, tự kết nối lại sau 5 s nếu broker sập.
function startConsumer(url, onEvent, log = console) {
  async function run() {
    let conn;
    try {
      conn = await amqp.connect(url);
      conn.on('error', () => {});
      conn.on('close', () => { log.error('RabbitMQ mất kết nối, thử lại sau 5s'); setTimeout(run, 5000); });
      const ch = await conn.createChannel();
      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
      await ch.assertQueue(QUEUE, { durable: true });
      await ch.bindQueue(QUEUE, EXCHANGE, 'parking.#');
      await ch.prefetch(50);
      await ch.consume(QUEUE, (m) => {
        if (!m) return;
        try { onEvent(JSON.parse(m.content.toString())); }
        catch (e) { log.error('Bỏ tin lỗi:', e.message); }
        ch.ack(m);
      });
      log.log('Đã kết nối RabbitMQ, đang nhận sự kiện');
    } catch (e) {
      log.error(`RabbitMQ chưa sẵn sàng (${e.message}), thử lại sau 5s`);
      if (conn) conn.close().catch(() => {});   // sự kiện 'close' sẽ hẹn lần thử lại
      else setTimeout(run, 5000);
    }
  }
  run();
}

module.exports = { applyEvent, reconcile, slotsFromCache, startConsumer, EXCHANGE, QUEUE };
