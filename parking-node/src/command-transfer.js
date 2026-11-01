const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');
const { makeConnector } = require('./amqp-connect');

// A separate ID per publish correlates returns even for duplicate business IDs.
function makeTransfer(url, { connect = u => amqp.connect(u,{timeout:2000}), timeoutMs = 3000 } = {}) {
  const connectAny = makeConnector(url, connect);
  let active, opening, stopped = false;
  function retire(s) {
    if (s.dead) return;
    s.dead = true;
    if (active === s) active = undefined;
    for (const finish of s.pending.values()) finish(new Error('PUBLISH_UNKNOWN'));
    s.conn.close().catch(() => {});
  }
  async function channel() {
    if (stopped) throw new Error('PUBLISH_STOPPED');
    if (active && !active.dead) return active;
    if (!opening) {
      const attempt={expired:false,state:null};let timer;
      const build=(async () => {
      const conn = await connectAny();
      const s = { conn, pending: new Map(), dead: false };
      attempt.state=s;
      conn.on('error', () => retire(s)); conn.on('close', () => retire(s));
      try {
        if(attempt.expired||stopped) throw new Error('PUBLISH_SETUP_TIMEOUT');
        s.ch = await conn.createConfirmChannel();
        s.ch.on('error', () => retire(s)); s.ch.on('close', () => retire(s));
        s.ch.on('return', m => s.pending.get(m.properties.headers?.['x-transfer-id'])?.(new Error('PUBLISH_RETURNED')));
        if (s.dead || stopped || attempt.expired) throw new Error('PUBLISH_CLOSED');
        active = s; return s;
      } catch (e) { retire(s); throw e; }
      })();
      opening=Promise.race([build,new Promise((_,reject)=>{timer=setTimeout(()=>{
        attempt.expired=true;if(attempt.state)retire(attempt.state);reject(new Error('PUBLISH_SETUP_TIMEOUT'));
      },timeoutMs);})]).finally(()=>{clearTimeout(timer);opening=undefined;});
    }
    return opening;
  }
  async function publish(exchange, key, content, properties) {
    const s = await channel();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = e => {
        if (!s.pending.delete(id)) return;
        clearTimeout(timer); e ? reject(e) : resolve();
      };
      const timer = setTimeout(() => retire(s), timeoutMs);
      s.pending.set(id, finish);
      if (s.dead) return finish(new Error('PUBLISH_CLOSED'));
      try {
        s.ch.publish(exchange, key, content, { ...properties, mandatory: true, persistent: true,
          headers: { ...properties.headers, 'x-transfer-id': id } }, e => finish(e));
      } catch { retire(s); }
    });
  }
  publish.close = async () => { stopped = true; if (active) retire(active); await opening?.catch(() => {}); };
  return publish;
}
module.exports = { makeTransfer };
