const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');
const { makeConnector } = require('./amqp-connect');
const { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } = require('@opentelemetry/api');

const EXCHANGE = 'parking.replies';
const tracer = trace.getTracer('parking-node/command-replies');

function makeReplyPublisher(url, {
  connect = (target) => amqp.connect(target, { timeout: 2000 }),
  timeoutMs = 3000,
} = {}) {
  const connectAny = makeConnector(url, connect);
  let current;
  let opening;
  let stopped = false;
  function discard(state) {
    if (state.dead) return;
    state.dead = true;
    if (current === state) current = undefined;
    for (const finish of state.pending.values()) finish(false);
    state.conn.close().catch(() => {});
  }
  async function channel() {
    if (stopped) throw new Error('Reply publisher stopped');
    if (current) return current;
    if (!opening) {
      let timer;
      let state;
      let expired = false;
      const setup = (async () => {
        const conn = await connectAny();
        conn.on('error', () => { if (state) discard(state); });
        if (expired || stopped) {
          conn.close().catch(() => {});
          throw new Error('Reply setup expired');
        }
        state = { conn, pending: new Map(), dead: false };
        conn.on('close', () => discard(state));
        try {
          state.channel = await conn.createConfirmChannel();
          state.channel.on('error', () => discard(state));
          state.channel.on('close', () => discard(state));
          state.channel.on('return', (message) =>
            state.pending.get(message.properties.headers?.['x-reply-publish-id'])?.(false));
          await state.channel.assertExchange(EXCHANGE, 'direct', { durable: true });
          if (state.dead || stopped || expired) throw new Error('Reply channel closed');
          current = state;
          return state;
        } catch (error) {
          discard(state);
          throw error;
        }
      })();
      opening = Promise.race([setup, new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          if (state) discard(state);
          reject(new Error('Reply setup timeout'));
        }, timeoutMs);
      })]).finally(() => {
        clearTimeout(timer);
        opening = undefined;
      });
    }
    return opening;
  }
  async function publish(replyTo, payload, properties) {
    let state;
    try { state = await channel(); } catch { return false; }
    if (state.dead || stopped) return false;
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => discard(state), timeoutMs);
      const done = (success) => {
        if (!state.pending.delete(id)) return;
        clearTimeout(timer);
        resolve(success);
      };
      state.pending.set(id, done);
      try {
        state.channel.publish(EXCHANGE, replyTo, Buffer.from(JSON.stringify(payload)), {
          ...properties,
          contentType: 'application/json',
          persistent: true,
          mandatory: true,
          headers: { ...properties.headers, 'x-reply-publish-id': id },
        }, (error) => done(!error));
      } catch {
        discard(state);
      }
    });
  }
  return {
    publish,
    async close() {
      stopped = true;
      if (current) discard(current);
      await opening?.catch(() => {});
    },
  };
}

function makeReplyRelay(pool, publish) {
  let running = false;
  return async function relayOnce() {
    if (running) return 0;
    running = true;
    let count = 0;
    try {
      const { rows } = await pool.query(`SELECT id, reply_to, payload, properties
        FROM command_reply_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100`);
      for (const row of rows) {
        const parent = propagation.extract(ROOT_CONTEXT, row.properties.headers ?? {});
        const published = await tracer.startActiveSpan('command.reply.publish', {
          kind: SpanKind.PRODUCER,
          attributes: {
            'messaging.system': 'rabbitmq',
            'messaging.destination.name': EXCHANGE,
            'messaging.operation.type': 'publish',
            'messaging.message.id': row.properties.messageId,
          },
        }, parent, async (span) => {
          try {
            const headers = { ...row.properties.headers };
            propagation.inject(context.active(), headers);
            if (!(await publish(row.reply_to, row.payload, { ...row.properties, headers }))) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: 'RabbitMQ publisher confirm failed' });
              return false;
            }
            await pool.query('UPDATE command_reply_outbox SET published_at=now() WHERE id=$1', [row.id]);
            return true;
          } catch (error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
            throw error;
          } finally {
            span.end();
          }
        });
        if (!published) break;
        count++;
      }
      return count;
    } finally {
      running = false;
    }
  };
}

module.exports = { makeReplyPublisher, makeReplyRelay, EXCHANGE };
