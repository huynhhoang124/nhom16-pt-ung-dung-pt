// PD-06: lệnh chết trong cmd.<bãi> (quá TTL hoặc quá delivery-limit) đi qua parking.dlx vào cmd.expired.
// Chỉ leader tiêu thụ hàng này để mỗi lệnh chỉ được xử lý một lần:
//   - lý do expired        -> commands.status = EXPIRED, báo người dùng "bãi đang gián đoạn, chưa đặt"
//   - lý do delivery_limit -> chuyển nguyên tin sang cmd.dead để quản trị xem và đẩy lại
const amqp = require('amqplib');
const { makeConnector } = require('./amqp-connect');

const reasonOf = (m) => m.properties?.headers?.['x-death']?.[0]?.reason;

function makeExpiredHandler({ pool, notify = () => {}, log = console }) {
  return async function handle(ch, m) {
    const reason = reasonOf(m);
    const id = m.properties?.messageId;
    if (reason === 'expired' && id) {
      const r = await pool.query(
        `UPDATE commands SET status='EXPIRED', status_code=410, result=$2, updated_at=now()
         WHERE id=$1 AND status='PENDING' RETURNING *`,
        [id, { error: 'COMMAND_EXPIRED', message: 'Bãi đang gián đoạn, chưa đặt' }]);
      if (r.rows[0]) notify(r.rows[0]);
    } else if (reason === 'delivery_limit') {
      ch.sendToQueue('cmd.dead', m.content, { ...m.properties, persistent: true });
      require('./metrics').incCmdDead();
    } else {
      log.info?.('bỏ qua tin trong cmd.expired', { messageId: id, reason });
    }
    ch.ack(m);
  };
}

// Mất leader thì huỷ consumer; lên leader lại thì nghe tiếp. Không có leader (chạy 1 bản) thì luôn nghe.
function startExpiredConsumer({ url, pool, leader, notify, log = console, connect = amqp.connect, checkMs = 1000 }) {
  const connectAny = makeConnector(url, connect);
  const handle = makeExpiredHandler({ pool, notify, log });
  let conn; let ch; let tag; let stopped = false; let busy = false;

  async function sync() {
    if (stopped || busy) return;
    busy = true;
    try {
      const want = !leader || leader.isLeader();
      if (want && !tag) {
        conn = conn ?? await connectAny();
        conn.on?.('close', () => { conn = undefined; ch = undefined; tag = undefined; });
        ch = ch ?? await conn.createChannel();
        await ch.checkQueue('cmd.expired');
        tag = (await ch.consume('cmd.expired', (m) => {
          if (m) handle(ch, m).catch((e) => log.error('xử lý cmd.expired lỗi', { error: e.message }));
        }, { noAck: false })).consumerTag;
      } else if (!want && tag) {
        await ch.cancel(tag).catch(() => {});
        tag = undefined;
      }
    } catch (e) {
      log.error('consumer cmd.expired lỗi, thử lại', { error: e.message });
      tag = undefined; ch = undefined;
      if (conn) await conn.close().catch(() => {});
      conn = undefined;
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(sync, checkMs);
  const ready = sync();
  return {
    ready,
    isConsuming: () => Boolean(tag),
    sync,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (tag) await ch.cancel(tag).catch(() => {});
      if (conn) await conn.close().catch(() => {});
    },
  };
}

module.exports = { startExpiredConsumer, makeExpiredHandler };
