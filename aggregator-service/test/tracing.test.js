const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { context, propagation, ROOT_CONTEXT, trace } = require('@opentelemetry/api');

// Real OTel context/SDK; only RabbitMQ I/O is replaced with a controlled confirm.
test('command.publish ends at broker confirm and signs the producer context, not the reply wait', async (t) => {
  const spans = [];
  const sdk = new NodeSDK({ instrumentations: [], spanProcessors: [{
    onStart() {}, onEnd(span) { spans.push(span); }, async forceFlush() {}, async shutdown() {},
  }] });
  sdk.start();
  t.after(() => sdk.shutdown());
  const { makeCommands } = require('../src/commands');
  const { verifySignature } = require('../src/command-signature');
  const connection = new EventEmitter(), channel = new EventEmitter();
  const sent = [];
  channel.assertExchange = async () => {};
  channel.publish = (...args) => { sent.push(args); };
  connection.createConfirmChannel = async () => channel;
  connection.close = async () => {};
  const publisher = makeCommands('amqp://test', { connect: async () => connection, signingKey: 'key' });
  t.after(() => publisher.close());
  const parent = propagation.extract(ROOT_CONTEXT, {
    traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
  });
  let finishRequest;
  const request = trace.getTracer('test').startActiveSpan('http.request', {}, parent, async (span) => {
    const published = publisher.send('A', 'reserve', { slotCode: 'A01' }, {
      messageId: 'u:key', correlationId: 'u:key', replyTo: 'agg.1', actor: { userId: 'u', role: 'USER' },
    });
    await published;
    await new Promise((resolve) => { finishRequest = resolve; });
    span.end();
  });
  request.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spans.length, 0, 'publisher span must remain open before confirm');
  const [, , content, properties, confirm] = sent[0];
  const body = JSON.parse(content);
  assert.equal(properties.headers.traceparent, body.traceparent);
  assert.ok(verifySignature('key', body, properties));
  assert.match(body.traceparent, /^00-11111111111111111111111111111111-[a-f0-9]{16}-01$/);
  confirm(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(spans.map((span) => span.name), ['command.publish']);
  assert.equal(spans[0].spanContext().traceId, '11111111111111111111111111111111');
  assert.equal(body.traceparent.split('-')[2], spans[0].spanContext().spanId);
  assert.ok(finishRequest, 'HTTP request is still waiting after the producer ended');
  finishRequest();
  await request;
  assert.equal(spans[1].name, 'http.request');
  assert.equal(trace.getSpan(context.active()), undefined);
});
