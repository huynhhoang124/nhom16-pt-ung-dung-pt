// Wire contract shared with aggregator-service/src/command-signature.js.
const { createHmac, timingSafeEqual } = require('node:crypto');
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter((k) => value[k] !== undefined).map((k) => [k, ordered(value[k])]));
  return value;
}
const canonical = (value) => JSON.stringify(ordered(value));
function signature(key, body, properties) {
  const fields = Object.fromEntries(['messageId', 'correlationId', 'replyTo', 'expiration', 'type']
    .map((k) => [k, properties[k] ?? null]));
  return createHmac('sha256', key).update(canonical({ body, properties: fields })).digest('hex');
}
function verifySignature(key, body, properties) {
  const received = properties.headers?.['x-command-signature'];
  if (!key || typeof received !== 'string' || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(signature(key, body, properties), 'hex'), Buffer.from(received, 'hex'));
}
module.exports = { canonical, signature, verifySignature };
