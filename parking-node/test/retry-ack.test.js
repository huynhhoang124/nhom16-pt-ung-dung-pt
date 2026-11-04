const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startCommandConsumer, InvalidCommand } = require('../src/commands');
const tick = () => new Promise(setImmediate);

test('source ack waits for confirmed transfer; false transfer keeps even invalid commands unacked', async () => {
  const conn = new EventEmitter(), ch = new EventEmitter();
  const acks = [], nacks = [], timers = new Map();
  let close = false, opens = 0, release, entered;
  const waiting = new Promise((r) => { entered = r; });
  conn.close = async () => { if (!close) { close = true; conn.emit('close'); } };
  conn.createChannel = async () => ch;
  ch.checkQueue = async (queue) => { if (queue.endsWith('.admin')) throw new Error('missing optional queue'); };
  ch.close = async () => {};
  ch.prefetch = async () => {};
  ch.consume = async (_queue, handler) => { ch.deliver = handler; return { consumerTag: 'one' }; };
  ch.cancel = async () => {};
  ch.ack = (m) => acks.push(m);
  ch.nack = (m) => nacks.push(m);
  let transfers = 0;
  const consumer = startCommandConsumer({ url: 'amqp://test', parkingId: 'A',
    connect: async () => { opens++; return conn; },
    timers: { setTimeout(fn) { timers.set(1, fn); return 1; }, clearTimeout(id) { timers.delete(id); } },
    log: { error() {}, info() {} },
    processCommand: async () => { throw new InvalidCommand('bad schema'); }, afterCommit() {},
    retryOrDead: async ({ permanent }) => {
      assert.equal(permanent, true);
      if (transfers++) return false;
      entered(); return new Promise((r) => { release = r; });
    },
  });
  try {
    await tick(); const first = { id: 1 };
    ch.deliver(first); await waiting;
    assert.equal(acks.length, 0);
    release(true); await tick(); assert.deepEqual(acks, [first]);
    ch.deliver({ id: 2 }); await tick();
    assert.deepEqual(acks, [first]); assert.equal(nacks.length, 0);
    assert.equal(close, true); assert.equal(opens, 1);
    assert.equal(timers.size, 1, 'one delayed reconnect, no hot requeue');
  } finally { await consumer.stop(); }
  assert.equal(timers.size, 0);
});
