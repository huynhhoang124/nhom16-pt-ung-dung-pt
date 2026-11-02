const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');
const { makeConnector } = require('./amqp-connect');
const EXCHANGE = 'parking.replies';

function makeReplyPublisher(url, { connect = (u) => amqp.connect(u, { timeout: 2000 }), timeoutMs = 3000 } = {}) {
  const connectAny = makeConnector(url, connect);
  let current;
  let opening;
  let stopped = false;
  function discard(s) {
    if (s.dead) return;
    s.dead = true;
    if (current === s) current = undefined;
    for (const done of s.pending.values()) done(false);
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
          s.ch.on('return', (m) => s.pending.get(m.properties.headers?.['x-reply-publish-id'])?.(false));
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
  async function publish(replyTo, payload, properties) {
    let s;
    try { s = await channel(); } catch { return false; }
    if (s.dead || stopped) return false;
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => discard(s), timeoutMs);
      const done = (ok) => { if (!s.pending.delete(id)) return; clearTimeout(timer); resolve(ok); };
      s.pending.set(id, done);
      try {
        s.ch.publish(EXCHANGE, replyTo, Buffer.from(JSON.stringify(payload)), {
          ...properties, contentType: 'application/json', persistent: true, mandatory: true,
          headers: { ...properties.headers, 'x-reply-publish-id': id },
        }, (e) => done(!e));
      } catch { discard(s); }
    });
  }
  return { publish, async close() { stopped = true; if (current) discard(current); await opening?.catch(() => {}); } };
}

function makeReplyRelay(pool, publish) {
  let running = false;
  return async function relayOnce() {
    if (running) return 0;
    running = true;
    let count = 0;
    try {
      const { rows } = await pool.query('SELECT id, reply_to, payload, properties FROM command_reply_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100');
      for (const r of rows) {
        if (!await publish(r.reply_to, r.payload, r.properties)) break;
        await pool.query('UPDATE command_reply_outbox SET published_at=now() WHERE id=$1', [r.id]);
        count++;
      }
      return count;
    } finally { running = false; }
  };
}
module.exports = { makeReplyPublisher, makeReplyRelay, EXCHANGE };
