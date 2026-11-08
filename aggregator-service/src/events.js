// Nhận sự kiện slot từ RabbitMQ và giữ cache trạng thái slot trong RAM (chỉ-đọc, nguồn gốc ở DB bãi).
const hlc = require('./hlc');
const { observeHlc } = require('./metrics');
const { makeConnector } = require('./amqp-connect');
const { context, propagation, ROOT_CONTEXT } = require('@opentelemetry/api');

const EXCHANGE = 'parking.events';
const QUEUE = 'aggregator.slot-updates';

// Mỗi slot chỉ có MỘT người ghi (node của bãi đó) nên version tăng một chiều:
// tin có version <= bản đang giữ là tin trùng (relay gửi lại) hoặc tin cũ (đến sai thứ tự) -> bỏ.
function applyEvent(cache, e) {
  // Gộp đồng hồ ngay khi nhận sự kiện, kể cả khi version cũ bị bỏ qua.
  const validHlc = observeHlc(e.hlc, e.parkingId);
  if (validHlc) hlc.update(e.hlc);

  const k = `${e.parkingId}:${e.slot}`;
  const cur = cache.get(k);

  if (cur && e.version <= cur.version) return false;

  const next = {
    status: e.status,
    version: e.version,
  };

  if (validHlc) next.hlc = e.hlc;

  cache.set(k, next);
  return true;
}

// Anti-entropy: lấy ảnh chụp slot từ node rồi gộp bằng "giữ version lớn hơn".
// Phép gộp này giao hoán, kết hợp, idempotent => chạy bao nhiêu lần, theo thứ tự nào cũng ra cùng kết quả.
async function reconcile(reg, cache, n, onApplied) {
  let applied = 0;
  for (const s of await reg.json(n, '/api/slots', { job: 'reconcile' })) {   // PD-10: việc của leader, mang fencing token
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
function startConsumer(url, onEvent, log = console, { exchange = EXCHANGE, queue = QUEUE, pattern = 'parking.#', onReady } = {}) {
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
        try {
          const parent = propagation.extract(ROOT_CONTEXT, m.properties?.headers ?? {});
          context.with(parent, () => onEvent(JSON.parse(m.content.toString()), parent));
        }
        catch (e) { log.error('Bỏ tin lỗi', { error: e.message }); }
        ch.ack(m);
      });
      log.log('Đã kết nối RabbitMQ, đang nhận tin', { queue });
      onReady?.();
    } catch (e) {
      log.error('RabbitMQ chưa sẵn sàng, thử lại sau 5s', { error: e.message });
      if (conn) conn.close().catch(() => {});   // sự kiện 'close' sẽ hẹn lần thử lại
      else setTimeout(run, 5000);
    }
  }
  run();
}

async function replayRecentEvents(
  url,
  cache,
  onApplied,
  log = console,
  connectAny = makeConnector(url),
) {
  let conn;
  let ch;
  let pub;
  let consumerTag;
  let settled = false;

  const markerId = `${process.pid}-${Date.now()}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => void finish(new Error("events.stream replay timed out")), 8000);
    const finish = async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);

      try {
        if (ch && consumerTag) {
          await ch.cancel(consumerTag).catch(() => {});
        }
        if (ch) await ch.close().catch(() => {});
        if (pub) await pub.close().catch(() => {});
        if (conn) await conn.close().catch(() => {});
      } finally {
        if (err) reject(err);
        else resolve();
      }
    };

    void (async () => {
      try {
        conn = await connectAny();
        if (settled) { await conn.close(); return; }
        conn.on('error', (error) => void finish(error));

        ch = await conn.createChannel();
        ch.on?.('error', (error) => void finish(error));
        pub = await conn.createConfirmChannel();
        pub.on?.('error', (error) => void finish(error));

        await ch.prefetch(100);

        const offset = '10m';

        const result = await ch.consume(
          'events.stream',
          (msg) => {
            if (!msg || settled) return;

            try {
              const event = JSON.parse(msg.content.toString());

              if (event._pd22ReplayMarker === true) {
                ch.ack(msg);

                if (event.markerId === markerId) {
                  void finish();
                }
                return;
              }

              if (
                event.parkingId &&
                event.slot &&
                Number.isFinite(event.version) &&
                applyEvent(cache, event)
              ) {
                onApplied?.(event);
              }

              ch.ack(msg);
            } catch (e) {
              log.error('Lỗi khi replay sự kiện', {
                error: e.message,
              });
              ch.ack(msg);
            }
          },
          {
            noAck: false,
            arguments: {
              'x-stream-offset': offset,
            },
          },
        );

        consumerTag = result.consumerTag;

        pub.publish(
          '',
          'events.stream',
          Buffer.from(JSON.stringify({
            _pd22ReplayMarker: true,
            markerId,
          })),
          { persistent: true, contentType: 'application/json' },
        );

        await pub.waitForConfirms();

        log.info('Bắt đầu replay events.stream', {
          lookbackSeconds: 600,
          offset,
        });
      } catch (e) {
        await finish(e);
      }
    })();
  });
}



function createReconcileQueue(reg, cache, onApplied, log = console, delayMs = 500, leader) {
  const pending = [];
  const queued = new Set();
  let running = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function drain() {
    if (running) return;
    running = true;

    try {
      while (pending.length > 0) {
        const n = pending.shift();

        try {
          if (leader && !leader.isLeader()) continue;
          const count = await reconcile(reg, cache, n, onApplied);
          log.info?.(`Đối soát bãi ${n.id}: cập nhật ${count} slot`);
        } catch (e) {
          if (e.message?.includes('STALE_LEADER')) leader?.demote();
          log.error?.(`Đối soát bãi ${n.id} lỗi`, { error: e.message });
        } finally {
          queued.delete(n.id);
        }

        // Giãn cách các lượt đối soát, không gọi nhiều bãi cùng lúc.
        if (pending.length > 0) await sleep(delayMs);
      }
    } finally {
      running = false;
      if (pending.length > 0) void drain();
    }
  }

  function enqueue(n) {
    if (queued.has(n.id)) return;
    queued.add(n.id);
    pending.push(n);
    void drain();
  }

  return { enqueue };
}

module.exports = {
  applyEvent,
  reconcile,
  slotsFromCache,
  startConsumer,
  createReconcileQueue,
  replayRecentEvents,
  EXCHANGE,
  QUEUE,
};
