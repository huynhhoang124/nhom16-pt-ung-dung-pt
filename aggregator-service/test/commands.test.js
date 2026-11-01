const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { makeCommands, routingKey, ATTEMPT_HEADER } = require('../src/commands');

function broker() {
  const connections = [];
  const sent = [];
  const connect = async () => {
    const conn = new EventEmitter();
    const ch = new EventEmitter();
    ch.assertExchange = async (...args) => { ch.exchange = args; };
    ch.publish = (...args) => { sent.push(args); return false; }; // false is buffer pressure, NOT nack.
    conn.createConfirmChannel = async () => ch;
    conn.close = async () => { conn.emit('close'); ch.emit('close'); };
    conn.ch = ch;
    connections.push(conn);
    return conn;
  };
  return { connect, connections, sent };
}
const tick = () => new Promise((r) => setImmediate(r));
const ack = (m, error) => m[4](error);
const returned = (b, m, code = 312) => b.connections.at(-1).ch.emit('return', { properties: m[3], fields: { replyCode: code } });
const rejects = (p, code) => assert.rejects(p, { code });

test('routing key rejects wildcards, dots and empty segments without restricting parking registry', () => {
  assert.equal(routingKey('UNKNOWN', 'reserve'), 'cmd.UNKNOWN.reserve');
  for (const [id, type] of [['A.#', 'reserve'], ['*', 'reserve'], ['', 'reserve'], ['A', 'x.y'], ['A', undefined]]) {
    assert.throws(() => routingKey(id, type), { code: 'INVALID_COMMAND' });
  }
});

test('envelope and properties preserved; only resolve after individual publisher confirm', async (t) => {
  const b = broker(); const pub = makeCommands('amqp://test/%2F', { connect: b.connect });
  t.after(() => pub.close());
  let resolved = false;
  const p = pub.send('A', 'reserve', { slotCode: 'A07' }, {
    messageId: 'u42:key', correlationId: 'correlation', replyTo: 'agg.2', expiration: '10000',
    causationId: 'saga:2', fencingToken: 42, hlc: '123.4', actor: { userId: 'u42', role: 'USER' },
    headers: { traceparent: '00-trace', custom: 'keep' },
  }).then((r) => { resolved = true; return r; });
  await tick(); assert.equal(resolved, false);
  const [exchange, key, content, props] = b.sent[0];
  assert.equal(exchange, 'parking.commands'); assert.equal(key, 'cmd.A.reserve');
  assert.deepEqual(b.connections[0].ch.exchange, ['parking.commands', 'topic', { durable: true }]);
  assert.equal(props.mandatory, true); assert.equal(props.persistent, true);
  assert.equal(props.messageId, 'u42:key'); assert.equal(props.correlationId, 'correlation');
  assert.equal(props.replyTo, 'agg.2'); assert.equal(props.expiration, '10000');
  assert.equal(props.contentType, 'application/json'); assert.equal(props.headers.custom, 'keep');
  const env = JSON.parse(content);
  assert.deepEqual(env, { type: 'reserve', parkingId: 'A', schemaVersion: 1, payload: { slotCode: 'A07' }, causationId: 'saga:2', fencingToken: 42, hlc: '123.4', traceparent: '00-trace', actor: { userId: 'u42', role: 'USER' } });
  ack(b.sent[0]); assert.equal((await p).status, 'BROKER_CONFIRMED');
});

test('concurrent duplicate business IDs: return and out-of-order confirms match the exact attempt', async (t) => {
  const b = broker(); const pub = makeCommands('amqp://test', { connect: b.connect }); t.after(() => pub.close());
  const first = pub.send('A', 'reserve', {}, { messageId: 'same' });
  const second = pub.send('UNKNOWN', 'reserve', {}, { messageId: 'same' });
  const third = pub.send('C', 'cancel', {});
  const rejected = rejects(second, 'PARKING_NOT_FOUND');
  await tick();
  assert.equal(b.connections.length, 1);
  assert.notEqual(b.sent[0][3].headers[ATTEMPT_HEADER], b.sent[1][3].headers[ATTEMPT_HEADER]);
  returned(b, b.sent[1]); ack(b.sent[2]); ack(b.sent[1]); ack(b.sent[0]);
  await rejected; await first; await third;
  const fourth = pub.send('B', 'reserve', {}); await tick(); ack(b.sent[3]); await fourth;
  assert.equal(b.connections.length, 1);
});

test('default expiration follows dynamic configuration', async (t) => {
  const b = broker(); let ttl = 10000;
  const pub = makeCommands('amqp://test', { connect: b.connect, config: { get: () => ttl } });
  t.after(() => pub.close());
  const first = pub.send('A', 'reserve', {}); await tick();
  assert.equal(b.sent[0][3].expiration, '10000'); ack(b.sent[0]); await first;
  ttl = 20000;
  const second = pub.send('A', 'reserve', {}); await tick();
  assert.equal(b.sent[1][3].expiration, '20000'); ack(b.sent[1]); await second;
});

test('nack is unavailable, non-NO_ROUTE return is not 404', async (t) => {
  const b = broker(); const pub = makeCommands('amqp://test', { connect: b.connect }); t.after(() => pub.close());
  const p = pub.send('A', 'reserve', {}); const check = rejects(p, 'QUEUE_FULL');
  await tick(); ack(b.sent[0], new Error('message nacked')); await check;
  const q = pub.send('B', 'reserve', {}); const checkQ = rejects(q, 'PUBLISH_RETURNED');
  await tick(); returned(b, b.sent[1], 313); ack(b.sent[1]); await checkQ;
});

test('disconnect settles all in-flight sends as unknown; next send reconnects without automatic replay', async (t) => {
  const b = broker(); const pub = makeCommands('amqp://test', { connect: b.connect }); t.after(() => pub.close());
  const checks = [pub.send('A', 'reserve', {}), pub.send('B', 'reserve', {})].map((p) => rejects(p, 'PUBLISH_UNKNOWN_RESULT'));
  await tick(); await b.connections[0].close(); await Promise.all(checks);
  const p = pub.send('C', 'reserve', {}); await tick();
  assert.equal(b.connections.length, 2); assert.equal(b.sent.length, 3);
  // Late callbacks from the old channel cannot settle a new message.
  ack(b.sent[0]); ack(b.sent[2]); await p;
});

test('connection failure and stalled connect are 503 before publish; connector tries next broker', async () => {
  const unavailable = makeCommands('amqp://one', { connect: async () => { throw new Error('offline'); } });
  await rejects(unavailable.send('A', 'reserve', {}), 'BROKER_UNAVAILABLE'); await unavailable.close();
  const stalled = makeCommands('amqp://one', { connect: () => new Promise(() => {}), timeoutMs: 20 });
  await rejects(stalled.send('A', 'reserve', {}), 'BROKER_UNAVAILABLE');
  await stalled.close();
  const b = broker(); const urls = [];
  const pub = makeCommands('amqp://one,amqp://two', { connect: async (u) => {
    urls.push(u); if (u.endsWith('one')) throw new Error('offline'); return b.connect();
  } });
  const p = pub.send('A', 'reserve', {}); await tick(); ack(b.sent[0]); await p;
  assert.deepEqual(urls, ['amqp://one', 'amqp://two']); await pub.close();
});

test('stalled setup is retired; late connection cannot replace a reconnected channel', async () => {
  const b = broker(); let release; let calls = 0;
  const pub = makeCommands('amqp://test', { timeoutMs: 25, connect: () => {
    if (calls++ === 0) return new Promise((r) => { release = r; });
    return b.connect();
  } });
  await rejects(pub.send('A', 'reserve', {}), 'BROKER_UNAVAILABLE');
  const next = pub.send('B', 'reserve', {}); await tick(); ack(b.sent[0]); await next;
  const late = await b.connect(); let closed = false;
  late.close = async () => { closed = true; late.emit('close'); };
  release(late); await tick(); assert.equal(closed, true);
  const third = pub.send('C', 'reserve', {}); await tick(); ack(b.sent[1]); await third;
  assert.equal(calls, 2); await pub.close();
});

test('confirm timeout / closed channel callback / publish throw are unknown, never 404', async () => {
  for (const mode of ['timeout', 'callback', 'throw']) {
    const b = broker(); const pub = makeCommands('amqp://test', { connect: b.connect, timeoutMs: 25 });
    if (mode === 'throw') {
      const connect = b.connect; b.connect = async () => { const c = await connect(); c.ch.publish = () => { throw new Error('closed'); }; return c; };
      await pub.close();
      const throwing = makeCommands('amqp://test', { connect: b.connect });
      await rejects(throwing.send('A', 'reserve', {}), 'PUBLISH_UNKNOWN_RESULT'); await throwing.close(); continue;
    }
    const p = pub.send('A', 'reserve', {}); const check = rejects(p, 'PUBLISH_UNKNOWN_RESULT');
    await tick(); if (mode === 'callback') ack(b.sent[0], new Error('channel closed'));
    await check; await pub.close();
  }
});

test('channel error invalidates publisher and does not become unhandled EventEmitter error', async () => {
  const b = broker(); const pub = makeCommands('amqp://test', { connect: b.connect });
  const p = pub.send('A', 'reserve', {}); const check = rejects(p, 'PUBLISH_UNKNOWN_RESULT');
  await tick(); b.connections[0].ch.emit('error', new Error('channel failure')); await check; await pub.close();
});
