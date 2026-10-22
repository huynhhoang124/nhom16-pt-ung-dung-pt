const { createHmac, timingSafeEqual, createHash } = require('node:crypto');
function ordered(v) {
  if (Array.isArray(v)) return v.map(ordered);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, ordered(v[k])]));
  return v;
}
const canonical = v => JSON.stringify(ordered(v));
function signature(key, body, p) {
  return createHmac('sha256', key).update(canonical({ body, properties: Object.fromEntries(
    ['messageId','correlationId','replyTo','expiration','type'].map(k => [k,p[k] ?? null])) })).digest('hex');
}
function equal(a,b) { return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex')); }
const trusted = (key, body, p) => !!key && equal(p.headers?.['x-command-signature'], signature(key,body,p));
function proof(key, content, properties, reason, routingKey) {
  return createHmac('sha256',key).update(canonical({ hash:createHash('sha256').update(content).digest('hex'),
    messageId:properties.messageId ?? null, reason, routingKey })).digest('hex');
}
module.exports = { canonical, signature, trusted, proof, equal };
