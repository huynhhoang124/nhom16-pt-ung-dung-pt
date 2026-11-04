const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');
const { makeConnector } = require('./amqp-connect');
const { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } = require('@opentelemetry/api');
const replyTracer = trace.getTracer('parking-node/replies');
const EXCHANGE = 'parking.replies';
const unavailable = () => ({ ok: false, scope: 'infrastructure', code: 'REPLY_BROKER_UNAVAILABLE' });

function makeReplyPublisher(url, { connect = (u) => amqp.connect(u, { timeout: 2000 }), timeoutMs = 3000 } = {}) {
  const connectAny = makeConnector(url, connect);
  let current;
  let opening;
  let stopped = false;
  function discard(s) {
    if (s.dead) return;
    s.dead = true;
    if (current === s) current = undefined;
    for (const done of s.pending.values()) done(unavailable());
    s.conn.close().catch(() => {});
  }
  async function channel() {
    if (stopped) throw new Error('Reply publisher stopped');
    if (current) return current;
    if (!opening) {
      let timer;
      let s;
      let expired = false;
      const setup = (async () => {
        const conn = await connectAny();
        conn.on('error', () => { if (s) discard(s); });
        if (expired || stopped) { conn.close().catch(() => {}); throw new Error('Reply setup expired'); }
        s = { conn, pending: new Map(), dead: false };
        conn.on('close', () => discard(s));
        try {
          s.ch = await conn.createConfirmChannel();
          s.ch.on('error', () => discard(s)); s.ch.on('close', () => discard(s));
          s.ch.on('return', (m) => s.pending.get(m.properties.headers?.['x-reply-publish-id'])?.({
            ok: false, scope: 'record', code: 'REPLY_UNROUTABLE',
          }));
          await s.ch.assertExchange(EXCHANGE, 'direct', { durable: true });
          if (s.dead || stopped || expired) throw new Error('Reply channel closed');
          current = s;
          return s;
        } catch (e) { discard(s); throw e; }
      })();
      opening = Promise.race([setup, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; if (s) discard(s); reject(new Error('Reply setup timeout')); }, timeoutMs);
      })]).finally(() => { clearTimeout(timer); opening = undefined; });
    }
    return opening;
  }
  async function publishDetailed(replyTo, payload, properties) {
    const traceparent = properties?.headers?.traceparent ?? payload?.traceparent;
    const parent = traceparent ? propagation.extract(ROOT_CONTEXT, { traceparent }) : ROOT_CONTEXT;
    return replyTracer.startActiveSpan('command.reply.publish', {
      kind: SpanKind.PRODUCER,
      attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': EXCHANGE },
    }, parent, async (span) => {
      const carrier = {};
      propagation.inject(context.active(), carrier);
      try {
        const result = await publishConfirmed(replyTo, payload, properties, carrier);
        if (!result.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: result.code });
        return result;
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally { span.end(); }
    });
  }
  async function publishConfirmed(replyTo, payload, properties, carrier) {
    let content;
    try {
      if (typeof replyTo !== 'string' || !replyTo || !properties || typeof properties !== 'object') throw new TypeError();
      content = Buffer.from(JSON.stringify(payload));
    } catch {
      return { ok: false, scope: 'record', code: 'REPLY_INVALID_RECORD' };
    }
    let s;
    try { s = await channel(); } catch { return unavailable(); }
    if (s.dead || stopped) return unavailable();
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => discard(s), timeoutMs);
      const done = (ok) => { if (!s.pending.delete(id)) return; clearTimeout(timer); resolve(ok); };
      s.pending.set(id, done);
      try {
        s.ch.publish(EXCHANGE, replyTo, content, {
          ...properties, contentType: 'application/json', persistent: true, mandatory: true,
          // Transport context is outside the signed payload; never mutate/re-sign the durable reply.
          headers: { ...properties.headers, ...carrier, 'x-reply-publish-id': id },
        }, (e) => done(e ? { ok: false, scope: 'infrastructure', code: 'REPLY_NACKED' } : { ok: true }));
      } catch (error) {
        // AMQP field encoding rejects a malformed row before writing to the channel.
        if (error instanceof TypeError || error instanceof RangeError)
          done({ ok: false, scope: 'record', code: 'REPLY_INVALID_RECORD' });
        else discard(s);
      }
    });
  }
  // Preserve the boolean API for existing callers; the relay needs the failure scope.
  const publish = async (...args) => (await publishDetailed(...args)).ok;
  return { publish, publishDetailed, async close() { stopped = true; if (current) discard(current); await opening?.catch(() => {}); } };
}

function makeReplyRelay(pool, publish) {
  let running = false;
  return async function relayOnce() {
    if (running) return 0;
    running = true;
    let count = 0;
    try {
      const { rows } = await pool.query(`SELECT id, reply_to, payload, properties FROM command_reply_outbox
        WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY id LIMIT 100`);
      for (const r of rows) {
        const outcome = await publish(r.reply_to, r.payload, r.properties);
        if (outcome !== true && outcome?.ok !== true) {
          const recordError = outcome?.scope === 'record';
          // Persist only bounded error codes, never payloads, credentials or raw broker errors.
          const code = recordError
            ? (outcome.code === 'REPLY_INVALID_RECORD' ? 'REPLY_INVALID_RECORD' : 'REPLY_UNROUTABLE')
            : (outcome?.code === 'REPLY_NACKED' ? 'REPLY_NACKED' : 'REPLY_BROKER_UNAVAILABLE');
          await pool.query(`UPDATE command_reply_outbox SET attempts=attempts+1,last_attempt_at=now(),last_error=$2,
            next_attempt_at=now()+interval '30 seconds' WHERE id=$1 AND published_at IS NULL`, [r.id, code]);
          if (recordError) continue;
          break; // The connection/broker affects the whole turn, not just this record.
        }
        await pool.query(`UPDATE command_reply_outbox SET published_at=now(),attempts=attempts+1,
          last_attempt_at=now(),last_error=NULL,next_attempt_at=NULL WHERE id=$1`, [r.id]);
        count++;
      }
      return count;
    } finally { running = false; }
  };
}
module.exports = { makeReplyPublisher, makeReplyRelay, EXCHANGE };
