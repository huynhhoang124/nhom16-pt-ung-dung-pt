const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const amqp = require('amqplib');

test('notification consumer traces processing and preserves publish-confirm/ack behavior', async (t) => {
  const connection = new EventEmitter(), channel = new EventEmitter();
  let consume, resolveConfirm, rejectConfirm;
  const sent = [], acked = [];
  let publishError;
  for (const name of ['assertExchange', 'assertQueue', 'bindQueue', 'prefetch']) channel[name] = async () => {};
  channel.consume = async (_queue, callback) => { consume = callback; };
  channel.publish = (...args) => { if (publishError) throw publishError; sent.push(args); };
  channel.waitForConfirms = () => new Promise((resolve, reject) => { resolveConfirm = resolve; rejectConfirm = reject; });
  channel.ack = (message) => acked.push(message);
  connection.createConfirmChannel = async () => channel;
  t.mock.method(amqp, 'connect', async () => connection);
  require('../src/index');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof consume, 'function');
  const event = { type: 'RESERVED', parkingId: 'A', slot: 'A01', userId: 'u1', requestId: 'r1' };
  const message = (body = JSON.stringify(event), headers = {}) => ({ content: Buffer.from(body), properties: { headers } });

  await t.test('SDK disabled: still publishes and only acks after confirm', async () => {
    const m = message();
    const pending = consume(m);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acked.length, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][3].headers?.traceparent, undefined);
    resolveConfirm();
    await pending;
    assert.deepEqual(acked, [m]);
  });

  const spans = [];
  const sdk = new NodeSDK({ instrumentations: [], spanProcessors: [{
    onStart() {}, onEnd(span) { spans.push(span); }, async forceFlush() {}, async shutdown() {},
  }] });
  sdk.start();
  t.after(() => sdk.shutdown());
  const traceId = '11111111111111111111111111111111';
  const parentId = '2222222222222222';
  for (const failure of [null, 'confirm', 'publish', 'json']) {
    await t.test(failure ?? 'confirmed', async () => {
      spans.length = sent.length = acked.length = 0;
      const error = new Error(`${failure} failed`);
      publishError = failure === 'publish' ? error : null;
      const m = message(failure === 'json' ? '{' : JSON.stringify(event), {
        traceparent: `00-${traceId}-${parentId}-01`,
      });
      const pending = consume(m);
      await new Promise((resolve) => setImmediate(resolve));
      if (!['publish', 'json'].includes(failure)) {
        assert.equal(spans.length, 0, 'consumer must include publisher confirm');
        assert.equal(acked.length, 0);
        assert.equal(sent[0][0], 'user.notifications');
        assert.equal(sent[0][1], 'user.u1');
        assert.equal(sent[0][3].correlationId, event.requestId);
        if (failure) rejectConfirm(error); else resolveConfirm();
      }
      await pending;
      assert.deepEqual(acked, [m], 'success and errors both keep the existing single ack');
      assert.equal(spans.length, 1);
      const [span] = spans;
      assert.equal(span.name, 'notification.process');
      assert.equal(span.kind, SpanKind.CONSUMER);
      assert.equal(span.spanContext().traceId, traceId);
      assert.equal(span.parentSpanContext.spanId, parentId);
      if (sent.length) assert.equal(sent[0][3].headers.traceparent, `00-${traceId}-${span.spanContext().spanId}-01`);
      if (failure) {
        assert.equal(span.status.code, SpanStatusCode.ERROR);
        assert.ok(span.events.some((event) => event.name === 'exception'));
      } else {
        assert.notEqual(span.status.code, SpanStatusCode.ERROR);
      }
    });
  }
  await consume(null);
  assert.equal(spans.length, 1, 'consumer cancellation is not a message');
});
