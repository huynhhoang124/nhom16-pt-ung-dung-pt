const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startExpiredConsumer, makeExpiredHandler } = require('../src/expired-commands');

// pool giả: chỉ cần câu UPDATE commands ... RETURNING
function fakePool(rows) {
  return { query: async (_sql, [id]) => ({ rows: rows[id] ? [{ ...rows[id], id, status: 'EXPIRED' }] : [] }) };
}
function fakeChannel() {
  const ch = { acks: [], sent: [], consumers: 0 };
  ch.ack = (m) => ch.acks.push(m);
  ch.sendToQueue = (...a) => ch.sent.push(a);
  ch.checkQueue = async () => {};
  ch.consume = async (_q, cb) => { ch.deliver = cb; ch.consumers++; return { consumerTag: `t${ch.consumers}` }; };
  ch.cancel = async () => { ch.consumers--; };
  return ch;
}
const msg = (reason, messageId = 'u1:k1') => ({
  content: Buffer.from('{}'), properties: { messageId, headers: { 'x-death': [{ reason }] } },
});

test('PD-06 lệnh hết hạn -> EXPIRED và báo người dùng; quá số lần giao -> cmd.dead', async () => {
  const notified = [];
  const handle = makeExpiredHandler({ pool: fakePool({ 'u1:k1': { user_id: 'u1' } }), notify: (r) => notified.push(r), log: { info() {} } });
  const ch = fakeChannel();
  await handle(ch, msg('expired'));
  assert.equal(notified.length, 1);
  assert.equal(notified[0].status, 'EXPIRED');
  await handle(ch, msg('delivery_limit'));
  assert.equal(ch.sent[0][0], 'cmd.dead');
  assert.equal(ch.sent[0][2].persistent, true);
  await handle(ch, msg('expired', 'khong-co'));   // lệnh đã xong từ trước: không báo lại
  assert.equal(notified.length, 1);
  assert.equal(ch.acks.length, 3);
});

test('PD-06 chỉ leader nghe cmd.expired; mất leader thì huỷ, lên lại thì nghe tiếp', async () => {
  const ch = fakeChannel();
  const conn = Object.assign(new EventEmitter(), { createChannel: async () => ch, close: async () => {} });
  let leading = false;
  const c = startExpiredConsumer({ url: 'amqp://x', pool: fakePool({}), leader: { isLeader: () => leading },
    connect: async () => conn, log: { error() {}, info() {} }, checkMs: 60_000 });
  await c.ready;
  assert.equal(c.isConsuming(), false);
  leading = true; await c.sync();
  assert.equal(c.isConsuming(), true);
  leading = false; await c.sync();
  assert.equal(c.isConsuming(), false);
  assert.equal(ch.consumers, 0);
  await c.stop();
});
