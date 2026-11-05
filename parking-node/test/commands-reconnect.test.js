const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startCommandConsumer } = require('../src/commands');
const tick = () => new Promise(setImmediate);
const quiet = { info() {}, error() {} };

function clock() {
  const pending = new Map(), delays = [];
  let id = 0;
  return {
    pending, delays,
    setTimeout(fn, delay) { delays.push(delay); pending.set(++id, fn); return id; },
    clearTimeout(key) { pending.delete(key); },
    async next() {
      assert.equal(pending.size, 1, 'exactly one reconnect timer');
      const [key, fn] = pending.entries().next().value;
      pending.delete(key); fn(); await tick();
    },
  };
}
function broker({ missing = false } = {}) {
  const conn = new EventEmitter(), channels = [];
  conn.close = async () => { if (!conn.closed) { conn.closed = true; conn.emit('close'); } };
  conn.createChannel = async () => {
    const ch = new EventEmitter(); channels.push(ch);
    ch.checkQueue = async () => {
      if (missing) {
        const error = new Error('queue missing');
        ch.emit('error', error); ch.emit('close'); throw error;
      }
    };
    ch.prefetch = async () => {};
    ch.consume = async (q) => { ch.queue = q; return { consumerTag: q }; };
    ch.cancel = async () => { ch.cancelled = true; };
    return ch;
  };
  return { conn, channels };
}
const start = (timers, connect) => startCommandConsumer({ url: 'amqp://test', parkingId: 'A',
  connect, timers, log: quiet, processCommand: async () => {}, afterCommit() {} });

test('reconnect grows 5/10/20/40/60 seconds, stays capped, resets only after full consumer setup', async (t) => {
  const timers = clock(), connected = [];
  let attempts = 0, fail = true;
  const consumer = start(timers, async () => {
    attempts++;
    if (fail) throw new Error('offline');
    const b = broker(); connected.push(b); return b.conn;
  });
  t.after(() => consumer.stop());
  await tick();
  for (let i = 0; i < 5; i++) await timers.next();
  assert.deepEqual(timers.delays, [5000, 10000, 20000, 40000, 60000, 60000]);
  fail = false; await timers.next();
  assert.equal(attempts, 7);
  assert.deepEqual(connected[0].channels.map((c) => c.queue), ['cmd.A', 'cmd.A.admin']);
  assert.equal(timers.pending.size, 0);
  connected[0].conn.emit('error', new Error('disconnect'));
  connected[0].conn.emit('close'); // duplicate notification must not create a second timer.
  await tick();
  assert.equal(timers.delays.at(-1), 5000);
  fail = true; await timers.next();
  assert.equal(timers.delays.at(-1), 10000);
  const before = attempts;
  await consumer.stop();
  assert.equal(timers.pending.size, 0);
  await tick(); assert.equal(attempts, before);
});

test('missing queue despite a TCP connection also increases backoff; successful reconnect owns one consumer per queue', async (t) => {
  const timers = clock(), connections = [];
  let missing = true;
  const consumer = start(timers, async () => { const b = broker({ missing }); connections.push(b); return b.conn; });
  t.after(() => consumer.stop()); await tick();
  await timers.next(); await timers.next();
  assert.deepEqual(timers.delays, [5000, 10000, 20000]);
  assert.ok(connections.every((b) => b.conn.closed));
  missing = false; await timers.next();
  assert.equal(connections.at(-1).channels.filter((c) => c.queue).length, 2);
  assert.equal(timers.pending.size, 0);
  await consumer.stop();
  assert.ok(connections.at(-1).channels.every((c) => c.cancelled));
  assert.equal(connections.at(-1).conn.closed, true);
});

test('shutdown while connecting closes the late connection without consumers or reconnect timers', async () => {
  const timers = clock(), b = broker(); let resolve;
  const consumer = start(timers, () => new Promise((r) => { resolve = r; }));
  const stopped = consumer.stop(); resolve(b.conn); await stopped;
  assert.equal(b.conn.closed, true);
  assert.equal(b.channels.length, 0);
  assert.equal(timers.pending.size, 0);
  assert.deepEqual(timers.delays, []);
});
