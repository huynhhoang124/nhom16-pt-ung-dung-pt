const { randomUUID } = require('node:crypto');
const amqp = require('amqplib');
const { makeConnector } = require('./amqp-connect');
const { signature } = require('./command-signature');
const { context, propagation } = require('@opentelemetry/api');

const EXCHANGE = 'parking.commands';
const ATTEMPT_HEADER = 'x-command-publish-id';
const failure = (code, status, cause) => Object.assign(new Error(code, { cause }), { code, status });

function routingKey(parkingId, type) {
  // A routing segment must not inject topic wildcards or multiple destinations.
  if (![parkingId, type].every((s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s))) {
    throw failure('INVALID_COMMAND', 400);
  }
  return `cmd.${parkingId}.${type}`;
}

function makeCommands(url, {
  connect = (u) => amqp.connect(u, { timeout: 5000 }),
  timeoutMs = 5000,
  signingKey,
  onStatus = () => {},
} = {}) {
  const connectAny = makeConnector(url, connect);
  let current;
  let opening;
  let stopped = false;

  function discard(state, cause) {
    if (state.dead) return;
    state.dead = true;
    if (current === state) {
      current = undefined;
      onStatus(false);
    }
    for (const p of state.pending.values()) p.finish(failure('PUBLISH_UNKNOWN_RESULT', 504, cause));
    state.conn.close().catch(() => {});
  }

  async function channel() {
    if (stopped) throw failure('BROKER_UNAVAILABLE', 503);
    if (current && !current.dead) return current;
    if (!opening) {
      const attempt = { expired: false, state: undefined };
      let setupTimer;
      const build = (async () => {
        const conn = await connectAny();
        if (attempt.expired || stopped) {
          conn.close().catch(() => {});
          throw failure('BROKER_UNAVAILABLE', 503);
        }
        const state = { conn, pending: new Map(), dead: false };
        attempt.state = state;
        conn.on('error', (e) => discard(state, e));
        conn.on('close', () => discard(state));
        try {
          const ch = await conn.createConfirmChannel();
          state.ch = ch;
          ch.on('error', (e) => discard(state, e));
          ch.on('close', () => discard(state));
          ch.on('return', (m) => {
            const p = state.pending.get(m.properties.headers?.[ATTEMPT_HEADER]);
            if (p) p.finish(failure(m.fields.replyCode === 312 ? 'PARKING_NOT_FOUND' : 'PUBLISH_RETURNED', m.fields.replyCode === 312 ? 404 : 502));
          });
          await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
          if (state.dead || stopped || attempt.expired) throw failure('BROKER_UNAVAILABLE', 503);
          current = state;
          onStatus(true);
          return state;
        } catch (e) {
          discard(state, e);
          throw e;
        }
      })();
      // Retire stalled setup so the NEXT request can reconnect. A late connection
      // is closed and cannot replace a newer channel.
      opening = Promise.race([build, new Promise((_, reject) => {
        setupTimer = setTimeout(() => {
          attempt.expired = true;
          if (attempt.state) discard(attempt.state);
          reject(failure('BROKER_UNAVAILABLE', 503));
        }, timeoutMs);
      })]).finally(() => { clearTimeout(setupTimer); opening = undefined; });
    }
    return opening;
  }

  async function send(parkingId, type, body, opts = {}) {
    const key = routingKey(parkingId, type);
    const messageId = opts.messageId ?? randomUUID();
    const correlationId = opts.correlationId ?? messageId;
    if (![messageId, correlationId].every((s) => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= 255)) {
      throw failure('INVALID_COMMAND', 400);
    }
    const headers = { ...opts.headers };
    const carrier = {};
    propagation.inject(context.active(), carrier);
    const envelope = { type, parkingId, schemaVersion: opts.schemaVersion ?? headers.schemaVersion ?? 1, payload: body };
    for (const k of ['issuedAt','deadlineAt']) if (opts[k] !== undefined) envelope[k]=opts[k];
    for (const field of ['causationId', 'fencingToken', 'hlc', 'traceparent', 'actor']) {
      const value = field === 'traceparent'
        ? carrier.traceparent ?? opts.traceparent ?? headers.traceparent
        : opts[field] ?? headers[field];
      if (value !== undefined) envelope[field] = headers[field] = value;
    }
    headers.schemaVersion = envelope.schemaVersion;
    // Unique per attempt, even when concurrent retries share the same business messageId.
    const attempt = randomUUID();
    headers[ATTEMPT_HEADER] = attempt;
    const content = Buffer.from(JSON.stringify(envelope));
    const properties = {
      mandatory: true, persistent: true, contentType: 'application/json',
      messageId, correlationId, type, headers,
      ...(opts.replyTo !== undefined && { replyTo: opts.replyTo }),
      ...(opts.expiration !== undefined && { expiration: String(opts.expiration) }),
    };
    let state;
    let timer;
    try {
      state = await Promise.race([
        channel(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('BROKER_UNAVAILABLE', 503)), timeoutMs); }),
      ]);
    } catch (e) { throw failure('BROKER_UNAVAILABLE', 503, e); }
    finally { clearTimeout(timer); }
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        if (!state.pending.delete(attempt)) return;
        clearTimeout(publishTimer);
        error ? reject(error) : resolve({ messageId, correlationId, status: 'BROKER_CONFIRMED' });
      };
      const publishTimer = setTimeout(() => discard(state, new Error('Publisher confirm timeout')), timeoutMs);
      state.pending.set(attempt, { finish });
      if (state.dead) return finish(failure('BROKER_UNAVAILABLE', 503));
      if (opts.deadlineAt !== undefined) {
        const remaining=opts.deadlineAt-Date.now();
        if (!Number.isSafeInteger(remaining)||remaining<=0) return finish(failure('COMMAND_DEADLINE_BEFORE_SEND',410));
        properties.expiration=String(remaining);
      }
      if (signingKey) headers['x-command-signature']=signature(signingKey,envelope,properties);
      try {
        // RabbitMQ sends basic.return BEFORE the confirm for an unroutable mandatory message.
        // Individual confirm callbacks avoid waitForConfirms() mixing concurrent sends.
        state.ch.publish(EXCHANGE, key, content, properties, (e) => {
          if (e) {
            // amqplib uses this exact error for a broker basic.nack. Channel-close errors
            // do not establish whether the broker accepted the message.
            finish(failure(e.message === 'message nacked' ? 'PUBLISH_NACKED' : 'PUBLISH_UNKNOWN_RESULT', e.message === 'message nacked' ? 503 : 504, e));
          } else finish();
        });
      } catch (e) { discard(state, e); }
    });
  }

  async function close() {
    stopped = true;
    if (current) discard(current);
    // A concurrent connection attempt is closed by channel() when it completes.
    await opening?.catch(() => {});
  }
  return { send, connect: channel, close };
}

module.exports = { makeCommands, routingKey, EXCHANGE, ATTEMPT_HEADER };
