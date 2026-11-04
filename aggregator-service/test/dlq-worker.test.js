const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startDlq } = require('../src/dlq');
const tick = () => new Promise(setImmediate);

test('DLQ worker persists before ack, does not overlap cycles, and stops its timer', async () => {
  const conn = new EventEmitter(), ch = new EventEmitter(), message = { id: 1 };
  let cycle, release, entered, gets = 0, acks = 0, relays = 0, closed = false;
  const started = new Promise((r) => { entered = r; });
  conn.close = async () => { closed = true; conn.emit('close'); };
  conn.createChannel = async () => ch;
  ch.checkQueue = async () => {};
  ch.get = async () => { gets++; return message; };
  ch.ack = () => { acks++; };
  const worker = startDlq({ url: 'amqp://test', connect: async () => conn,
    timers: { setInterval(fn) { cycle = fn; return 1; }, clearInterval() { cycle = undefined; } },
    dlq: { store: async () => { entered(); await new Promise((r) => { release = r; }); }, relay: async () => { relays++; }, close: async () => {} },
  });
  await started;
  const active = cycle(); assert.equal(gets, 1); assert.equal(acks, 0);
  release(); await active;
  assert.equal(acks, 1); assert.equal(relays, 1);
  const oldCycle = cycle; await worker.stop();
  assert.equal(cycle, undefined); assert.equal(closed, true);
  await oldCycle(); assert.equal(gets, 1);
});

test('DLQ storage failure closes connection without ack; subsequent cycle can recover', async () => {
  const connections = []; let cycle, fail = true, acks = 0;
  const worker = startDlq({ url: 'amqp://test',
    connect: async () => {
      const conn = new EventEmitter(), ch = new EventEmitter(); connections.push(conn);
      conn.close = async () => { conn.closed = true; conn.emit('close'); };
      conn.createChannel = async () => ch;
      ch.checkQueue = async () => {}; ch.get = async () => ({ content: Buffer.from('{}') });
      ch.ack = () => { acks++; }; return conn;
    },
    timers: { setInterval(fn) { cycle = fn; return 1; }, clearInterval() {} },
    log: { error() {} },
    dlq: { store: async () => { if (fail) throw new Error('DB down'); }, relay: async () => {}, close: async () => {} },
  });
  await tick(); assert.equal(acks, 0); assert.equal(connections[0].closed, true);
  fail = false; await cycle(); assert.equal(acks, 1); assert.equal(connections.length, 2);
  await worker.stop();
});
