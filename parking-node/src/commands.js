const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const amqp = require('amqplib');
const { makeConnector } = require('./amqp-connect');
const { canonical, signature, verifySignature } = require('./command-signature');
const { reserveIn, endReservationIn, payIn } = require('./slots');
const { normalizePlate, isPlate } = require('./plate');
const { tokenFor } = require('./gate');
const { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } = require('@opentelemetry/api');

class InvalidCommand extends Error {}
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const str = (value, maxLength = 128) => typeof value === 'string' && value.length > 0 &&
  value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META = ['causationId', 'traceparent', 'hlc', 'fencingToken'];
const tracer = trace.getTracer('parking-node/commands');

function decodeCommand(message, parkingId, internalKey) {
  if (message.content.length > 10240) throw new InvalidCommand('COMMAND_TOO_LARGE');
  let body;
  try { body = JSON.parse(message.content.toString()); } catch { throw new InvalidCommand('INVALID_JSON'); }
  const properties = message.properties ?? {};
  if (!object(body) || !verifySignature(internalKey, body, properties)) throw new InvalidCommand('UNTRUSTED_COMMAND');
  if (body.schemaVersion !== 1 || !['reserve', 'cancel', 'pay'].includes(body.type) ||
      body.parkingId !== parkingId || !object(body.payload)) throw new InvalidCommand('INVALID_ENVELOPE');
  if (!object(body.actor) || !str(body.actor.userId, 64) || !/^[A-Za-z0-9_-]+$/.test(body.actor.userId) ||
      !['USER', 'STAFF', 'ADMIN'].includes(body.actor.role)) throw new InvalidCommand('INVALID_ACTOR');
  const prefix = `${body.actor.userId}:`;
  if (!str(properties.messageId) || !properties.messageId.startsWith(prefix) ||
      !str(properties.messageId.slice(prefix.length), 64) || !str(properties.correlationId, 255) ||
      !str(properties.replyTo) || !/^[A-Za-z0-9._-]+$/.test(properties.replyTo) ||
      (properties.expiration !== undefined && !/^\d+$/.test(properties.expiration))) {
    throw new InvalidCommand('INVALID_PROPERTIES');
  }
  for (const key of ['messageId', 'correlationId', 'replyTo', 'expiration']) {
    if (body[key] !== undefined && body[key] !== properties[key]) throw new InvalidCommand('PROPERTY_MISMATCH');
  }
  if (properties.type !== undefined && properties.type !== body.type) throw new InvalidCommand('TYPE_MISMATCH');
  if (message.fields?.routingKey && message.fields.routingKey !== `cmd.${parkingId}.${body.type}`) {
    throw new InvalidCommand('ROUTING_MISMATCH');
  }
  for (const key of ['schemaVersion', 'actor', ...META]) {
    if (properties.headers?.[key] !== undefined && canonical(properties.headers[key]) !== canonical(body[key])) {
      throw new InvalidCommand('HEADER_MISMATCH');
    }
  }
  if (META.some((key) => body[key] !== undefined && (key === 'fencingToken'
    ? !((Number.isSafeInteger(body[key]) && body[key] >= 0) ||
      (typeof body[key] === 'string' && /^\d{1,20}$/.test(body[key])))
    : !str(body[key], 512)))) throw new InvalidCommand('INVALID_METADATA');
  return {
    ...body,
    messageId: properties.messageId,
    correlationId: properties.correlationId,
    replyTo: properties.replyTo,
    expiration: properties.expiration,
  };
}

async function dispatch(client, envelope, { parkingId, reservationMinutes, qrSecret }) {
  const body = envelope.payload;
  const actor = envelope.actor;
  const error = (code, message) => ({ code, body: { error: message } });
  if ((body.userId !== undefined && body.userId !== actor.userId) ||
      (body.requestId !== undefined && body.requestId !== envelope.messageId) ||
      (body.paymentKey !== undefined && body.paymentKey !== envelope.messageId)) {
    return error(403, 'IDENTITY_MISMATCH');
  }
  if (actor.role === 'STAFF' && actor.parkingId !== parkingId) return error(403, 'FORBIDDEN');
  if (envelope.type === 'reserve') {
    if (!['USER', 'ADMIN'].includes(actor.role)) return error(403, 'FORBIDDEN');
    if (!str(body.slotCode) || !str(body.licensePlate)) return error(400, 'INVALID_RESERVATION');
    const licensePlate = normalizePlate(body.licensePlate);
    if (!isPlate(licensePlate)) return error(400, 'INVALID_PLATE');
    if (body.startTime !== undefined && !(Date.parse(body.startTime) < Date.now() + 7 * 86400_000)) {
      return error(400, 'INVALID_START_TIME');
    }
    const durationMinutes = body.durationMinutes ?? 120;
    if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 1440) {
      return error(400, 'INVALID_DURATION');
    }
    const result = await reserveIn(client, parkingId, {
      ...body, licensePlate, durationMinutes, requestId: envelope.messageId, userId: actor.userId,
    }, reservationMinutes);
    if (result.code < 300) result.body = { ...result.body, qrToken: tokenFor(qrSecret, parkingId, result.body) };
    return result;
  }
  if (envelope.type === 'cancel') {
    if (!UUID.test(body.reservationId ?? '')) return error(404, 'RESERVATION_NOT_ACTIVE');
    return endReservationIn(client, parkingId, body.reservationId, 'CANCELLED',
      actor.role === 'USER' ? actor.userId : undefined);
  }
  if (!['USER', 'ADMIN'].includes(actor.role)) return error(403, 'FORBIDDEN');
  if (!UUID.test(body.sessionId ?? '')) return error(404, 'SESSION_NOT_FOUND');
  if (body.method !== undefined && body.method !== 'ONLINE') return error(400, 'INVALID_PAYMENT_METHOD');
  return payIn(client, {
    sessionId: body.sessionId, method: 'ONLINE', paymentKey: envelope.messageId, userId: actor.userId,
  });
}

function makeCommandProcessor({
  pool, parkingId, internalKey, reservationMinutes = 15,
  qrSecret = `${internalKey}:qr:${parkingId}`,
}) {
  return async (message) => {
    const envelope = decodeCommand(message, parkingId, internalKey);
    const parent = propagation.extract(ROOT_CONTEXT, { traceparent: envelope.traceparent });
    return tracer.startActiveSpan('command.process', {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': `cmd.${parkingId}`,
        'messaging.operation.type': 'process',
        'messaging.message.id': envelope.messageId,
        'parking.id': parkingId,
        'command.type': envelope.type,
      },
    }, parent, async (span) => {
      let client;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        const hash = createHash('sha256')
          .update(canonical({ type: envelope.type, parkingId, actor: envelope.actor, payload: envelope.payload }))
          .digest('hex');
        const inserted = await client.query(`INSERT INTO inbox_messages(message_id, command_type, request_hash)
          VALUES ($1,$2,$3) ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
        [envelope.messageId, envelope.type, hash]);
        let result;
        if (!inserted.rowCount) {
          const prior = (await client.query(
            'SELECT command_type, request_hash, result, status_code FROM inbox_messages WHERE message_id=$1',
            [envelope.messageId])).rows[0];
          if (!prior) throw new Error('Inbox row disappeared');
          result = prior.request_hash !== hash || prior.command_type !== envelope.type
            ? { code: 422, body: { error: 'IDEMPOTENCY_KEY_REUSED' } }
            : { code: prior.status_code, body: prior.result };
          if (result.code == null || result.body == null) throw new Error('Incomplete inbox result');
        } else {
          result = await dispatch(client, envelope, { parkingId, reservationMinutes, qrSecret });
          result.body = JSON.parse(JSON.stringify(result.body));
          await client.query(
            'UPDATE inbox_messages SET result=$2, status_code=$3, processed_at=now() WHERE message_id=$1',
            [envelope.messageId, result.body, result.code]);
        }

        const metadata = Object.fromEntries(META.filter((key) => envelope[key] !== undefined)
          .map((key) => [key, envelope[key]]));
        const payload = {
          schemaVersion: 1,
          type: 'COMMAND_RESULT',
          commandType: envelope.type,
          parkingId,
          commandId: envelope.messageId,
          actor: envelope.actor,
          statusCode: result.code,
          result: result.body,
          ...metadata,
        };
        const headers = {
          schemaVersion: 1,
          ...metadata,
          causationId: envelope.causationId ?? envelope.messageId,
        };
        const carrier = {};
        propagation.inject(context.active(), carrier);
        if (carrier.traceparent) headers.traceparent = carrier.traceparent;
        const properties = {
          messageId: randomUUID(),
          correlationId: envelope.correlationId,
          type: 'COMMAND_RESULT',
          headers,
        };
        headers['x-reply-signature'] = signature(internalKey, payload, properties);
        await client.query(
          'INSERT INTO command_reply_outbox(command_id, reply_to, payload, properties) VALUES ($1,$2,$3,$4)',
          [envelope.messageId, envelope.replyTo, payload, properties]);
        await client.query('COMMIT');
        return { ...result, messageId: envelope.messageId, duplicate: !inserted.rowCount };
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        if (client) await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client?.release();
        span.end();
      }
    });
  };
}

function crashAfterCommitOnce(result) {
  if (process.env.NODE_ENV !== 'test' || process.env.COMMAND_TEST_CRASH_MESSAGE_ID !== result.messageId) return;
  const name = createHash('sha256').update(result.messageId).digest('hex');
  try { fs.closeSync(fs.openSync(path.join(os.tmpdir(), `pd02-crash-${name}`), 'wx')); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  process.exit(86);
}

function startCommandConsumer({
  url, pool, parkingId, internalKey, log = console,
  connect = (target) => amqp.connect(target, { timeout: 2000 }),
  retryMs = 5000, processCommand = makeCommandProcessor({ pool, parkingId, internalKey }),
  afterCommit = crashAfterCommitOnce, retryOrDead,
}) {
  const connectAny = makeConnector(url, connect);
  let stopped = false;
  let state;
  let wake;
  let retryTimer;
  const end = (current) => {
    if (current.dead) return;
    current.dead = true;
    current.closed();
    current.conn.close().catch(() => {});
  };
  const loop = (async () => {
    while (!stopped) {
      let current;
      try {
        const conn = await connectAny();
        current = { conn, dead: false, tail: Promise.resolve() };
        state = current;
        const closed = new Promise((resolve) => { current.closed = resolve; });
        conn.on('error', () => end(current));
        conn.on('close', () => end(current));
        if (stopped) { end(current); break; }
        const channel = await conn.createChannel();
        current.channel = channel;
        channel.on('error', () => end(current));
        channel.on('close', () => end(current));
        await channel.checkQueue(`cmd.${parkingId}`);
        await channel.prefetch(20);
        if (stopped) { end(current); break; }
        if (current.dead) throw new Error('Command channel closed during setup');
        const { consumerTag } = await channel.consume(`cmd.${parkingId}`, (message) => {
          if (!message) { end(current); return; }
          current.tail = current.tail.then(async () => {
            if (current.dead || stopped) return;
            try {
              const result = await processCommand(message);
              await afterCommit(result);
              if (!current.dead) channel.ack(message);
            } catch (error) {
              log.error('command processing failed', { parkingId, error: error.message });
              if (current.dead) return;
              const transferred = await retryOrDead?.({
                ch: channel, message, error, permanent: error instanceof InvalidCommand,
              });
              if (transferred === true) channel.ack(message);
              else if (error instanceof InvalidCommand) channel.nack(message, false, false);
              else end(current);
            }
          }).catch((error) => {
            log.error('command consumer failed', { error: error.message });
            end(current);
          });
        }, { noAck: false });
        current.tag = consumerTag;
        log.info?.('command consumer ready', { parkingId, consumerTag, prefetch: 20 });
        await closed;
      } catch (error) {
        log.error('command consumer reconnect', { parkingId, error: error.message });
        if (current) end(current);
      }
      if (current) await current.tail;
      if (!stopped) await new Promise((resolve) => {
        wake = resolve;
        retryTimer = setTimeout(resolve, retryMs);
      });
      wake = undefined;
    }
  })();
  return {
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      wake?.();
      const current = state;
      if (current && !current.dead) {
        if (current.tag) await current.channel.cancel(current.tag).catch(() => {});
        await current.tail;
        end(current);
      }
      await loop;
    },
  };
}

const cleanupInbox = (pool) =>
  pool.query("DELETE FROM inbox_messages WHERE processed_at < now() - interval '7 days'");

module.exports = {
  decodeCommand, makeCommandProcessor, startCommandConsumer, cleanupInbox, InvalidCommand, crashAfterCommitOnce,
};
