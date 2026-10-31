const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const amqp = require('amqplib');
const { makeConnector } = require('./amqp-connect');
const { canonical, verifySignature } = require('./command-signature');
const { reserveIn, endReservationIn, payIn } = require('./slots');
const { normalizePlate, isPlate } = require('./plate');
const { tokenFor } = require('./gate');

class InvalidCommand extends Error {}
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n = 128) => typeof v === 'string' && v.length > 0 && v.length <= n && !/[\u0000-\u001f\u007f]/.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META = ['causationId', 'traceparent', 'hlc', 'fencingToken'];

function decodeCommand(m, parkingId, internalKey) {
  if (m.content.length > 10240) throw new InvalidCommand('COMMAND_TOO_LARGE');
  let body;
  try { body = JSON.parse(m.content.toString()); } catch { throw new InvalidCommand('INVALID_JSON'); }
  const p = m.properties ?? {};
  if (!object(body) || !verifySignature(internalKey, body, p)) throw new InvalidCommand('UNTRUSTED_COMMAND');
  if (body.schemaVersion !== 1 || !['reserve', 'cancel', 'pay'].includes(body.type) || body.parkingId !== parkingId || !object(body.payload)) {
    throw new InvalidCommand('INVALID_ENVELOPE');
  }
  if (!object(body.actor) || !str(body.actor.userId, 64) || !/^[A-Za-z0-9_-]+$/.test(body.actor.userId) || !['USER', 'STAFF', 'ADMIN'].includes(body.actor.role)) {
    throw new InvalidCommand('INVALID_ACTOR');
  }
  const prefix = `${body.actor.userId}:`;
  if (!str(p.messageId) || !p.messageId.startsWith(prefix) || !str(p.messageId.slice(prefix.length), 64) ||
      !str(p.correlationId, 255) || !str(p.replyTo) || !/^[A-Za-z0-9._-]+$/.test(p.replyTo) ||
      (p.expiration !== undefined && !/^\d+$/.test(p.expiration))) throw new InvalidCommand('INVALID_PROPERTIES');
  for (const k of ['messageId', 'correlationId', 'replyTo', 'expiration']) {
    if (body[k] !== undefined && body[k] !== p[k]) throw new InvalidCommand('PROPERTY_MISMATCH');
  }
  if (p.type !== undefined && p.type !== body.type) throw new InvalidCommand('TYPE_MISMATCH');
  if (m.fields?.routingKey && m.fields.routingKey !== `cmd.${parkingId}.${body.type}`) throw new InvalidCommand('ROUTING_MISMATCH');
  for (const k of ['schemaVersion', 'actor', ...META]) {
    if (p.headers?.[k] !== undefined && canonical(p.headers[k]) !== canonical(body[k])) throw new InvalidCommand('HEADER_MISMATCH');
  }
  if (META.some((k) => body[k] !== undefined && (k === 'fencingToken'
    ? !((Number.isSafeInteger(body[k]) && body[k] >= 0) || (typeof body[k] === 'string' && /^\d{1,20}$/.test(body[k])))
    : !str(body[k], 512)))) throw new InvalidCommand('INVALID_METADATA');
  return { ...body, messageId: p.messageId, correlationId: p.correlationId, replyTo: p.replyTo, expiration: p.expiration };
}

async function dispatch(c, env, { parkingId, reservationMinutes, qrSecret }) {
  const b = env.payload;
  const actor = env.actor;
  const error = (code, message) => ({ code, body: { error: message } });
  // Identity always comes from the signed server actor; payload identity cannot widen access.
  if ((b.userId !== undefined && b.userId !== actor.userId) ||
      (b.requestId !== undefined && b.requestId !== env.messageId) ||
      (b.paymentKey !== undefined && b.paymentKey !== env.messageId)) return error(403, 'IDENTITY_MISMATCH');
  if (actor.role === 'STAFF' && actor.parkingId !== parkingId) return error(403, 'FORBIDDEN');
  if (env.type === 'reserve') {
    if (!['USER', 'ADMIN'].includes(actor.role)) return error(403, 'FORBIDDEN');
    if (!str(b.slotCode) || !str(b.licensePlate)) return error(400, 'INVALID_RESERVATION');
    const licensePlate = normalizePlate(b.licensePlate);
    if (!isPlate(licensePlate)) return error(400, 'INVALID_PLATE');
    if (b.startTime !== undefined && !(Date.parse(b.startTime) < Date.now() + 7 * 86400_000)) return error(400, 'INVALID_START_TIME');
    const durationMinutes = b.durationMinutes ?? 120;
    if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 1440) return error(400, 'INVALID_DURATION');
    const out = await reserveIn(c, parkingId, { ...b, licensePlate, durationMinutes, requestId: env.messageId, userId: actor.userId }, reservationMinutes);
    if (out.code < 300) out.body = { ...out.body, qrToken: tokenFor(qrSecret, parkingId, out.body) };
    return out;
  }
  if (env.type === 'cancel') {
    if (!UUID.test(b.reservationId ?? '')) return error(404, 'RESERVATION_NOT_ACTIVE');
    return endReservationIn(c, parkingId, b.reservationId, 'CANCELLED', actor.role === 'USER' ? actor.userId : undefined);
  }
  if (!['USER', 'ADMIN'].includes(actor.role)) return error(403, 'FORBIDDEN');
  if (!UUID.test(b.sessionId ?? '')) return error(404, 'SESSION_NOT_FOUND');
  if (b.method !== undefined && b.method !== 'ONLINE') return error(400, 'INVALID_PAYMENT_METHOD');
  return payIn(c, {
    sessionId: b.sessionId,
    method: 'ONLINE',
    paymentKey: env.messageId,
    userId: actor.userId,
    parkingId
  });
}

function makeCommandProcessor({ pool, parkingId, internalKey, reservationMinutes = 15, qrSecret = `${internalKey}:qr:${parkingId}` }) {
  return async (m) => {
    const env = decodeCommand(m, parkingId, internalKey);
    const hash = createHash('sha256').update(canonical({ type: env.type, parkingId, actor: env.actor, payload: env.payload })).digest('hex');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const inserted = await c.query(`INSERT INTO inbox_messages(message_id, command_type, request_hash)
        VALUES ($1,$2,$3) ON CONFLICT (message_id) DO NOTHING RETURNING message_id`, [env.messageId, env.type, hash]);
      let out;
      if (!inserted.rowCount) {
        const prior = (await c.query('SELECT command_type, request_hash, result, status_code FROM inbox_messages WHERE message_id=$1', [env.messageId])).rows[0];
        if (!prior) throw new Error('Inbox row disappeared');
        out = prior.request_hash !== hash || prior.command_type !== env.type
          ? { code: 422, body: { error: 'IDEMPOTENCY_KEY_REUSED' } }
          : { code: prior.status_code, body: prior.result };
        if (out.code == null || out.body == null) throw new Error('Incomplete inbox result');
      } else {
        out = await dispatch(c, env, { parkingId, reservationMinutes, qrSecret });
        // Normalize Date values once: first delivery and replay return identical JSON.
        out.body = JSON.parse(JSON.stringify(out.body));
        await c.query('UPDATE inbox_messages SET result=$2, status_code=$3, processed_at=now() WHERE message_id=$1', [env.messageId, out.body, out.code]);
      }
      const metadata = Object.fromEntries(META.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
      const payload = { schemaVersion: 1, type: 'COMMAND_RESULT', commandType: env.type, parkingId, commandId: env.messageId,
        actor: env.actor, statusCode: out.code, result: out.body, ...metadata };
      const properties = { messageId: randomUUID(), correlationId: env.correlationId, type: 'COMMAND_RESULT',
        headers: { schemaVersion: 1, ...metadata, causationId: env.causationId ?? env.messageId } };
      await c.query('INSERT INTO command_reply_outbox(command_id, reply_to, payload, properties) VALUES ($1,$2,$3,$4)',
        [env.messageId, env.replyTo, payload, properties]);
      await c.query('COMMIT');
      return { ...out, messageId: env.messageId, duplicate: !inserted.rowCount };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release(); }
  };
}

function crashAfterCommitOnce(result) {
  if (process.env.NODE_ENV !== 'test' || process.env.COMMAND_TEST_CRASH_MESSAGE_ID !== result.messageId) return;
  const name = createHash('sha256').update(result.messageId).digest('hex');
  try { fs.closeSync(fs.openSync(path.join(os.tmpdir(), `pd02-crash-${name}`), 'wx')); }
  catch (e) { if (e.code === 'EEXIST') return; throw e; }
  process.exit(86);
}

function startCommandConsumer({ url, pool, parkingId, internalKey, log = console,
  connect = (u) => amqp.connect(u, { timeout: 2000 }), retryMs = 5000,
  processCommand = makeCommandProcessor({ pool, parkingId, internalKey }), afterCommit = crashAfterCommitOnce, retryOrDead }) {
  const connectAny = makeConnector(url, connect);
  let stopped = false;
  let state;
  let wake;
  let retryTimer;
  const end = (s) => {
    if (s.dead) return;
    s.dead = true;
    s.closed();
    s.conn.close().catch(() => {});
  };
  const loop = (async () => {
    while (!stopped) {
      let s;
      try {
        const conn = await connectAny();
        s = { conn, dead: false, tail: Promise.resolve() }; state = s;
        const closed = new Promise((r) => { s.closed = r; });
        conn.on('error', () => end(s)); conn.on('close', () => end(s));
        if (stopped) { end(s); break; }
        const ch = await conn.createChannel(); s.ch = ch;
        ch.on('error', () => end(s)); ch.on('close', () => end(s));
        await ch.checkQueue(`cmd.${parkingId}`); // Topology owned by definitions/policy, not redeclared here.
        await ch.prefetch(20);
        if (stopped) { end(s); break; }
        if (s.dead) throw new Error('Command channel closed during setup');
        const { consumerTag } = await ch.consume(`cmd.${parkingId}`, (m) => {
          if (!m) { end(s); return; }
          // SAC chooses a consumer, NOT a serial async callback execution order.
          s.tail = s.tail.then(async () => {
            if (s.dead || stopped) return;
            try {
              const result = await processCommand(m);
              await afterCommit(result);
              if (!s.dead) ch.ack(m); // processor returns only after COMMIT succeeds.
            } catch (error) {
              log.error('command processing failed', { parkingId, error: error.message });
              if (s.dead) return;
              // PD-08 may replace this hook with confirmed delayed retry/dead transfer.
              const transferred = await retryOrDead?.({ ch, message: m, error, permanent: error instanceof InvalidCommand });
              if (transferred === true) ch.ack(m);
              else if (error instanceof InvalidCommand) ch.nack(m, false, false); // durable DLX target; no hot requeue.
              else end(s); // Leave unacked, close/reconnect with backoff after rollback.
            }
          }).catch((error) => { log.error('command consumer failed', { error: error.message }); end(s); });
        }, { noAck: false });
        s.tag = consumerTag;
        log.info?.('command consumer ready', { parkingId, consumerTag, prefetch: 20 });
        await closed;
      } catch (e) {
        log.error('command consumer reconnect', { parkingId, error: e.message });
        if (s) end(s);
      }
      if (s) await s.tail;
      if (!stopped) await new Promise((r) => { wake = r; retryTimer = setTimeout(r, retryMs); });
      wake = undefined;
    }
  })();
  return {
    async stop() {
      stopped = true; clearTimeout(retryTimer); wake?.();
      const s = state;
      if (s && !s.dead) {
        if (s.tag) await s.ch.cancel(s.tag).catch(() => {});
        await s.tail;
        end(s);
      }
      await loop;
    },
  };
}

const cleanupInbox = (pool) => pool.query("DELETE FROM inbox_messages WHERE processed_at < now() - interval '7 days'");
module.exports = { decodeCommand, makeCommandProcessor, startCommandConsumer, cleanupInbox, InvalidCommand, crashAfterCommitOnce };
