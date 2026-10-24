const test = require('node:test');
const assert = require('node:assert/strict');
const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');
const { makeCommands } = require('../src/commands');

test('isolated RabbitMQ: policy routing can change with a command already queued, without recreating cmd.C', {
  skip: !process.env.PD01_AMQP_URL || !process.env.PD01_POLICY_MANAGEMENT_URL,
}, async (t) => {
  // Standalone opt-in test: changes the policy temporarily; never run against real command traffic.
  const base = process.env.PD01_POLICY_MANAGEMENT_URL;
  const user = process.env.RABBITMQ_MANAGEMENT_USER ?? 'parking';
  const password = process.env.RABBITMQ_MANAGEMENT_PASSWORD ?? 'parking';
  const headers = { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, 'content-type': 'application/json' };
  const api = async (path, method = 'GET', body) => {
    const r = await fetch(`${base}/api/${path}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    assert(r.ok, `${method} ${path}: ${r.status}`);
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
  const policyPath = 'policies/%2F/command-delivery';
  const original = await api(policyPath);
  const policyBody = (definition) => ({ pattern: original.pattern, priority: original.priority, 'apply-to': original['apply-to'], definition });
  async function effectiveRoutingKey(key) {
    // Management stats are cached; policy application is not synchronously visible in GET /queues.
    for (let i = 0; i < 100; i++) {
      const q = await api('queues/%2F/cmd.C');
      if (q.effective_policy_definition?.['dead-letter-routing-key'] === key) return q;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`Policy routing key did not become ${key}`);
  }
  // Register restore before any mutation so assertion failures cannot leave the policy changed.
  t.after(async () => {
    await api(policyPath, 'PUT', policyBody(original.definition));
    await effectiveRoutingKey(original.definition['dead-letter-routing-key']);
  });
  const conn = await amqp.connect(process.env.PD01_AMQP_URL); t.after(() => conn.close());
  const ch = await conn.createChannel();
  const { messageCount, consumerCount } = await ch.checkQueue('cmd.C');
  assert.equal(messageCount, 0, 'cmd.C must be empty in this isolated stack');
  assert.equal(consumerCount, 0, 'cmd.C must not have a business consumer');
  const { queue } = await ch.assertQueue('', { exclusive: true });
  const key = `test.dead.${randomUUID()}`;
  await ch.bindQueue(queue, 'parking.dlx', key);
  const pub = makeCommands(process.env.PD01_AMQP_URL); t.after(() => pub.close());
  const messageId = `policy-test:${randomUUID()}`;
  await pub.send('C', 'policy-probe', {}, { messageId });
  assert.equal((await ch.checkQueue('cmd.C')).messageCount, 1);
  await api(policyPath, 'PUT', policyBody({ ...original.definition, 'dead-letter-routing-key': key }));
  const changed = await effectiveRoutingKey(key);
  assert.equal(changed.effective_policy_definition['dead-letter-routing-key'], key);
  assert.equal(changed.arguments['x-dead-letter-routing-key'], undefined);
  assert.equal((await ch.checkQueue('cmd.C')).messageCount, 1, 'queued command survived policy update');
  await ch.prefetch(1);
  const readOne = (name) => new Promise((resolve, reject) => {
    const consumerTag = randomUUID();
    const timer = setTimeout(() => { ch.cancel(consumerTag).catch(() => {}); reject(new Error(`Timeout ${name}`)); }, 5000);
    ch.consume(name, (m) => {
      clearTimeout(timer);
      ch.cancel(consumerTag).then(() => resolve(m), reject);
    }, { consumerTag }).catch((e) => { clearTimeout(timer); reject(e); });
  });
  const command = await readOne('cmd.C');
  assert.equal(command.properties.messageId, messageId);
  ch.nack(command, false, false);
  const dead = await readOne(queue);
  assert.equal(dead.properties.messageId, messageId);
  assert.equal(dead.fields.routingKey, key);
  assert.equal(dead.properties.headers['x-death'][0].reason, 'rejected');
  ch.ack(dead);
  await ch.close();
  // Original policy is restored by t.after even if this test fails.
});
