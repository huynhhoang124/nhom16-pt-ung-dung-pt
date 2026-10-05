// Nhận sự kiện slot từ RabbitMQ và giữ cache trạng thái slot trong RAM (chỉ-đọc, nguồn gốc ở DB bãi).
const { makeConnector } = require('./amqp-connect');

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
// Mặc định nghe sự kiện slot; NV-08 dùng lại cho exchange user.notifications.
function startConsumer(url, onEvent, log = console, { exchange = EXCHANGE, queue = QUEUE, pattern = 'parking.#' } = {}) {
  const connectAny = makeConnector(url);   // PT-03: url có thể là danh sách nút của cụm
  async function run() {
    let conn;
    try {
      conn = await connectAny();
      conn.on('error', () => {});
      conn.on('close', () => { log.error('RabbitMQ mất kết nối, thử lại sau 5s'); setTimeout(run, 5000); });
      const ch = await conn.createChannel();
      await ch.assertExchange(exchange, 'topic', { durable: true });
      // PT-03: quorum queue = nhân bản trên các nút bằng Raft, ghi khi đa số xác nhận (1 nút vẫn chạy được)
      await ch.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
      await ch.bindQueue(queue, exchange, pattern);
      await ch.prefetch(50);
      await ch.consume(queue, (m) => {
        if (!m) return;
        try { onEvent(JSON.parse(m.content.toString())); }
        catch (e) { log.error('Bỏ tin lỗi', { error: e.message }); }
        ch.ack(m);
      });
      log.log('Đã kết nối RabbitMQ, đang nhận tin', { queue });
    } catch (e) {
      log.error('RabbitMQ chưa sẵn sàng, thử lại sau 5s', { error: e.message });
      if (conn) conn.close().catch(() => {});   // sự kiện 'close' sẽ hẹn lần thử lại
      else setTimeout(run, 5000);
    }
  }
  run();
}

module.exports = { applyEvent, reconcile, slotsFromCache, startConsumer, EXCHANGE, QUEUE };
