// PD-03: luồng request–reply qua broker.
// execute(): ghi ý định lệnh vào bảng commands (bền) -> worker pump() gửi lên RabbitMQ -> chờ phản hồi tối đa waitMs.
// Có kết quả trong hạn thì trả 201/409, quá hạn trả 202 + commandId để client hỏi lại GET /api/commands/:id.
const { createHash, randomUUID } = require('node:crypto');
const { canonical } = require('./command-signature');

const terminal = (row) => row && row.status !== 'PENDING';
const fail = (code, status) => Object.assign(new Error(code), { code, status });
const response = (row) => ({
  code: row.status_code ?? 202,
  body: row.status === 'PENDING'
    ? { commandId: row.id, status: 'PENDING', publishState: row.publish_state }
    : { ...row.result, commandId: row.id },
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COMMAND_TYPES = ['reserve', 'cancel', 'pay'];
// Lỗi chắc chắn chưa gửi được: đánh dấu FAILED ngay; lỗi khác coi như "không rõ đã gửi chưa" và thử lại sau.
const DEFINITE_SEND_ERRORS = ['BROKER_UNAVAILABLE', 'PARKING_NOT_FOUND', 'PUBLISH_NACKED', 'INVALID_COMMAND',
  'COMMAND_DEADLINE_BEFORE_SEND'];
const PUBLISH_BATCH = 20;   // giới hạn mỗi lượt để không chiếm event loop khi tồn nhiều lệnh

function makeCommandFlow({
  pool, publisher, instanceId, waitMs = 3000, ttlMs = 10000, leaseMs = 5000,
  now = Date.now, onResult = () => {}, afterClaim = async () => {}, afterPublish = async () => {},
}) {
  if (!ID_RE.test(instanceId ?? '') || instanceId === 'recovery') throw fail('INVALID_AGGREGATOR_ID', 500);
  const validWait = Number.isInteger(waitMs) && waitMs >= 1 && waitMs <= 30000;
  const validTtl = Number.isInteger(ttlMs) && ttlMs >= 1 && ttlMs <= 3600000;
  if (!validWait || !validTtl) throw fail('INVALID_COMMAND_TIMING', 500);

  const pending = new Map();   // commandId -> Set các request HTTP đang chờ kết quả
  let stopped = false;
  let publishing = false;
  let scanning = false;
  let replyReady = false;
  let timer;

  function wait(id) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const entry = { resolve, until: now() + waitMs };
    if (!pending.has(id)) pending.set(id, new Set());
    pending.get(id).add(entry);
    const remove = () => {
      const set = pending.get(id);
      set?.delete(entry);
      if (!set?.size) pending.delete(id);
    };
    return { promise, remove };
  }

  function settle(id, row) {
    const set = pending.get(id);
    if (!set) return;
    pending.delete(id);
    for (const p of set) p.resolve(response(row));
  }

  async function get(id) {
    return (await pool.query('SELECT * FROM commands WHERE id=$1', [id])).rows[0];
  }

  async function signal(row) {
    if (!terminal(row)) return;
    settle(row.id, row);
    onResult(row);
    await pool.query("SELECT pg_notify('command_results',$1)", [row.id]);
  }

  async function failBeforeSend(id, code, status, extraWhere) {
    await pool.query(
      `UPDATE commands SET status='FAILED', status_code=$3, result=$2, failure_phase='SEND', last_error=$4,
         publish_state='REJECTED', updated_at=now()
       WHERE id=$1 AND status='PENDING' AND ${extraWhere}`,
      [id, { error: code, sendStatus: 'FAILED_TO_SEND' }, status, code]);
  }

  async function execute({ parkingId, type, user, payload, key, traceparent }) {
    if (stopped) throw fail('COMMAND_SERVICE_STOPPED', 503);
    if (typeof key !== 'string' || !key.length || key.length > 64 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw fail('IDEMPOTENCY_KEY_REQUIRED', 400);
    }
    if (!ID_RE.test(parkingId) || !COMMAND_TYPES.includes(type)) throw fail('INVALID_COMMAND', 400);
    const id = `${user.sub}:${key}`;
    if (id.length > 128) throw fail('INVALID_COMMAND_ID', 400);

    const actor = { userId: user.sub, role: user.role, ...(user.parkingId && { parkingId: user.parkingId }) };
    const hash = createHash('sha256').update(canonical({ parkingId, type, actor, payload })).digest('hex');
    const issuedAt = now();
    const envelope = { issuedAt, deadlineAt: issuedAt + ttlMs, ...(traceparent && { traceparent }) };
    const waiter = wait(id);   // phải đăng ký chờ TRƯỚC khi ghi ý định, vì worker có thể gửi ngay sau đó

    try {
      await pool.query(
        `INSERT INTO commands(id, parking_id, type, user_id, request_hash, payload, actor, envelope, correlation_id, reply_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$1,$9) ON CONFLICT (id) DO NOTHING`,
        [id, parkingId, type, user.sub, hash, payload, actor, envelope, `agg.${instanceId}`]);
      let row = await get(id);
      if (row.request_hash !== hash) throw fail('IDEMPOTENCY_KEY_REUSED', 422);

      // Lần trước broker từ chối và còn hạn: cho gửi lại cùng commandId
      const retryable = row.status === 'FAILED' && row.failure_phase === 'SEND' && row.publish_state === 'REJECTED';
      if (retryable && row.envelope.deadlineAt > now() && replyReady) {
        await pool.query(
          `UPDATE commands SET status='PENDING', result=NULL, status_code=NULL, publish_state='QUEUED', failure_phase=NULL,
             last_error=NULL, next_publish_at=now(), updated_at=now()
           WHERE id=$1 AND status='FAILED' AND publish_state='REJECTED'`, [id]);
        row = await get(id);
      }
      if (terminal(row)) return response(row);

      // Hàng đợi phản hồi chưa sẵn sàng: lệnh chưa từng gửi thì báo lỗi ngay thay vì treo
      if (!replyReady && row.publish_state === 'QUEUED' && row.attempts === 0) {
        await failBeforeSend(id, 'BROKER_UNAVAILABLE', 503, `publish_state='QUEUED' AND attempts=0`);
        row = await get(id);
        if (terminal(row)) return response(row);
      }

      pump().catch(() => {});
      return await waiter.promise;
    } catch (e) {
      if (e.status) throw e;
      throw Object.assign(fail('COMMAND_PERSISTENCE_UNKNOWN', 503), { commandId: id, unknown: true });
    } finally {
      waiter.remove();
    }
  }

  async function expireUnsent() {
    const expired = await pool.query(
      `UPDATE commands SET status='FAILED', publish_state='REJECTED', failure_phase='SEND', status_code=410,
         result=$2, last_error='COMMAND_DEADLINE_BEFORE_SEND', updated_at=now()
       WHERE status='PENDING' AND publish_state='QUEUED' AND uncertain=false
         AND (envelope->>'deadlineAt')::bigint <= $1
       RETURNING *`,
      [now(), { error: 'COMMAND_DEADLINE_BEFORE_SEND', sendStatus: 'FAILED_TO_SEND' }]);
    for (const row of expired.rows) await signal(row);
  }

  // Nhận một lệnh để gửi: khoá dòng (SKIP LOCKED) và đặt lease để bản Aggregator khác không gửi trùng
  async function claim(owner) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const row = (await c.query(
        `SELECT * FROM commands
         WHERE status='PENDING' AND publish_state<>'CONFIRMED' AND next_publish_at <= now()
           AND (publish_lease_until IS NULL OR publish_lease_until < now())
           AND (envelope->>'deadlineAt')::bigint > $1
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [now()])).rows[0];
      if (row) {
        await c.query(
          `UPDATE commands SET uncertain = uncertain OR publish_state IN ('SENDING','UNKNOWN'), publish_state='SENDING',
             publish_owner=$2, publish_lease_until=now() + ($3 * interval '1 millisecond'),
             attempts=attempts+1, updated_at=now()
           WHERE id=$1`, [row.id, owner, leaseMs]);
      }
      await c.query('COMMIT');
      return row;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async function publishOne(row, owner) {
    const uncertain = row.uncertain || ['SENDING', 'UNKNOWN'].includes(row.publish_state);
    await afterClaim(row);
    try {
      await publisher.send(row.parking_id, row.type, row.payload, {
        ...row.envelope, actor: row.actor, messageId: row.id, correlationId: row.correlation_id, replyTo: row.reply_to,
      });
      await afterPublish(row);
      await pool.query(
        `UPDATE commands SET publish_state='CONFIRMED', publish_lease_until=NULL, updated_at=now()
         WHERE id=$1 AND publish_owner=$2 AND status='PENDING'`, [row.id, owner]);
    } catch (e) {
      if (!uncertain && DEFINITE_SEND_ERRORS.includes(e.code)) {
        const r = await pool.query(
          `UPDATE commands SET status='FAILED', publish_state='REJECTED', failure_phase='SEND',
             status_code=$3, result=$4, last_error=$5, publish_lease_until=NULL, updated_at=now()
           WHERE id=$1 AND publish_owner=$2 AND status='PENDING' RETURNING *`,
          [row.id, owner, e.status ?? 503, { error: e.code, sendStatus: 'FAILED_TO_SEND' }, e.code]);
        if (r.rows[0]) await signal(r.rows[0]);
        return;
      }
      await pool.query(
        `UPDATE commands SET publish_state='UNKNOWN', uncertain=true, last_error='PUBLISH_UNKNOWN_RESULT',
           publish_lease_until=NULL, next_publish_at=now() + interval '2 seconds', updated_at=now()
         WHERE id=$1 AND publish_owner=$2 AND status='PENDING'`, [row.id, owner]);
    }
  }

  async function pump() {
    if (stopped || publishing || !replyReady) return;
    publishing = true;
    try {
      await expireUnsent();
      for (let n = 0; n < PUBLISH_BATCH && !stopped && replyReady; n++) {
        const owner = randomUUID();
        const row = await claim(owner);
        if (!row) break;
        await publishOne(row, owner);
      }
    } finally {
      publishing = false;
    }
  }

  // Request chờ quá hạn -> trả 202; lệnh đã có kết quả trong DB (do bản khác nhận phản hồi) -> trả luôn
  async function scan() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      for (const [id, set] of pending) {
        for (const p of set) {
          if (now() < p.until) continue;
          set.delete(p);
          p.resolve(response({ id, status: 'PENDING', publish_state: 'AWAITING_RESULT' }));
          if (!set.size) pending.delete(id);
        }
      }
      const ids = [...pending.keys()];
      if (ids.length) {
        const r = await pool.query("SELECT * FROM commands WHERE id = ANY($1::text[]) AND status <> 'PENDING'", [ids]);
        for (const row of r.rows) settle(row.id, row);
      }
    } finally {
      scanning = false;
    }
  }

  function start() {
    timer = setInterval(() => {
      scan().catch(() => {});
      pump().catch(() => {});
    }, 100);
  }

  async function stop() {
    stopped = true;
    clearInterval(timer);
    for (const id of pending.keys()) settle(id, { id, status: 'PENDING', publish_state: 'AWAITING_RESULT' });
    while (publishing || scanning) await new Promise((r) => setTimeout(r, 10));
  }

  return { execute, get, pump, scan, start, stop, signal, pending, setReady(v) { replyReady = v; } };
}

module.exports = { makeCommandFlow, response, terminal };
