const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { SpanStatusCode } = require('@opentelemetry/api');
const amqp = require('amqplib');

// Real SDK; replace only broker I/O so confirm timing and propagation are observable.
test('outbox.publish propagates its own context and stays open until confirm', async (t) => {
  const started = [], ended = [];
  const sdk = new NodeSDK({ instrumentations: [], spanProcessors: [{
    onStart(span) { started.push(span); }, onEnd(span) { ended.push(span); },
    async forceFlush() {}, async shutdown() {},
  }] });
  sdk.start();
  t.after(() => sdk.shutdown());
  const { amqpPublisher } = require('../src/relay');
  const traceId = '11111111111111111111111111111111';
  const parentId = '2222222222222222';
  const traceparent = `00-${traceId}-${parentId}-01`;

  for (const batch of [false, true]) {
    for (const failure of [null, 'confirm', 'publish']) {
      await t.test(`${batch ? 'batch' : 'single'}: ${failure ?? 'confirmed'}`, async (t) => {
        started.length = ended.length = 0;
        const connection = new EventEmitter(), channel = new EventEmitter();
        const sent = [];
        const error = new Error(`${failure} failed`);
        let publishCalls = 0, confirmCalls = 0, resolveConfirm, rejectConfirm;
        const confirm = new Promise((resolve, reject) => { resolveConfirm = resolve; rejectConfirm = reject; });
        channel.assertExchange = async () => {};
        channel.publish = (...args) => {
          publishCalls++;
          if (failure === 'publish' && publishCalls === (batch ? 2 : 1)) throw error;
          sent.push(args);
        };
        channel.waitForConfirms = () => { confirmCalls++; return confirm; };
        connection.createConfirmChannel = async () => channel;
        connection.close = async () => {};
        t.mock.method(amqp, 'connect', async () => connection);
        const publish = amqpPublisher('amqp://test');
        t.after(() => publish.close());
        const events = [1, 2].map((version) => ({ traceparent, payload: {
          parkingId: 'A', slot: 'A01', version, requestId: `r${version}`,
        } }));
        const result = batch ? publish.publishBatch(events)
          : publish('parking.A.slot.A01', events[0].payload, traceparent);
        await new Promise((resolve) => setImmediate(resolve));

        if (failure !== 'publish') {
          assert.equal(started.length, batch ? 2 : 1);
          assert.equal(ended.length, 0, 'no producer may end before confirm');
          assert.equal(confirmCalls, 1, 'the batch shares a single confirm');
          assert.deepEqual(sent.map(([, , body]) => JSON.parse(body).version), batch ? [1, 2] : [1]);
          for (const [i, span] of started.entries()) {
            assert.equal(span.name, 'outbox.publish');
            assert.equal(span.spanContext().traceId, traceId);
            assert.equal(span.parentSpanContext.spanId, parentId);
            assert.equal(sent[i][3].headers.traceparent, `00-${traceId}-${span.spanContext().spanId}-01`);
            assert.equal(sent[i][3].correlationId, events[i].payload.requestId);
          }
          if (failure) rejectConfirm(error); else resolveConfirm();
        } else {
          assert.equal(started.length, batch ? 2 : 1);
          assert.equal(confirmCalls, 0);
          assert.equal(sent.length, batch ? 1 : 0);
        }
        assert.equal(await result, !failure);
        assert.equal(ended.length, started.length);
        assert.ok(ended.length > 0);
        for (const span of ended) {
          if (failure) {
            assert.equal(span.status.code, SpanStatusCode.ERROR);
            assert.equal(span.events.find((event) => event.name === 'exception').attributes['exception.message'], error.message);
          } else {
            assert.notEqual(span.status.code, SpanStatusCode.ERROR);
          }
        }
      });
    }
  }
});
