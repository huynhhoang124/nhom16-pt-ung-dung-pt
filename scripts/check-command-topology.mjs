// Read-only Management API verification. No queue deletion, purge or message consumption.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const definitions = JSON.parse(await readFile(new URL('../rabbitmq/definitions.json', import.meta.url)));
const base = process.env.RABBITMQ_MANAGEMENT_URL ?? 'http://localhost:15672';
const user = process.env.RABBITMQ_MANAGEMENT_USER ?? 'parking';
const password = process.env.RABBITMQ_MANAGEMENT_PASSWORD ?? 'parking';
const headers = { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
const get = async (path) => {
  const response = await fetch(base + '/api/' + path, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, path);
  return response.json();
};
for (const expected of definitions.exchanges) {
  const actual = await get(`exchanges/${encodeURIComponent(expected.vhost)}/${expected.name}`);
  for (const field of ['type', 'durable', 'auto_delete', 'internal']) assert.equal(actual[field], expected[field], `${expected.name}.${field}`);
}
for (const expected of definitions.queues) {
  const actual = await get(`queues/${encodeURIComponent(expected.vhost)}/${expected.name}`);
  assert.equal(actual.durable, true); assert.equal(actual.type, 'quorum');
  assert.deepEqual(actual.arguments, expected.arguments, `${expected.name}.arguments`);
  const policy = definitions.policies.find((p) => p.vhost === expected.vhost && new RegExp(p.pattern).test(expected.name));
  if (policy) {
    assert.equal(actual.policy, policy.name, `${expected.name}.policy`);
    assert.deepEqual(actual.effective_policy_definition, policy.definition, `${expected.name}.effective_policy_definition`);
  }
}
for (const expected of definitions.policies) {
  const actual = await get(`policies/${encodeURIComponent(expected.vhost)}/${expected.name}`);
  for (const field of ['pattern', 'priority', 'apply-to']) assert.equal(actual[field], expected[field], `policy.${field}`);
  assert.deepEqual(actual.definition, expected.definition);
}
for (const expected of definitions.bindings) {
  const bindings = await get(`bindings/${encodeURIComponent(expected.vhost)}/e/${expected.source}/q/${expected.destination}`);
  assert(bindings.some((b) => b.routing_key === expected.routing_key), `${expected.destination}: ${expected.routing_key}`);
}
const permission = await get('permissions/%2F/parking');
for (const field of ['configure', 'write', 'read']) assert.equal(permission[field], '.*');
if (process.argv.includes('--default-mode')) {
  const queues = await get('queues/%2F');
  for (const name of ['aggregator.slot-updates.2', 'aggregator.notifications.2']) {
    assert(!queues.some((q) => q.name === name), `Default mode must not pre-create ${name}; existing queues require manual migration`);
  }
  for (const name of ['aggregator.slot-updates.1', 'aggregator.notifications.1', 'notification.events']) {
    const q = queues.find((q) => q.name === name);
    assert(q, `${name} must be created by the running service`);
    assert.equal(q.type, 'quorum'); assert.equal(q.durable, true);
    assert(q.consumers > 0, `${name} must have a consumer`);
  }
  console.log('Default mode verified: active runtime event queues have consumers; no aggregator-2 queues');
}
console.log(`PD-01 Management API verified: vhost /, ${definitions.exchanges.length} exchanges, ${definitions.queues.length} quorum queues, ${definitions.bindings.length} bindings, ${definitions.policies.length} policy, parking permissions`);
