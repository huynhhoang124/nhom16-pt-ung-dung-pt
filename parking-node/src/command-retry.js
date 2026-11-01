const { signature, trusted, proof } = require('./retry-contract');
const { makeTransfer } = require('./command-transfer');
const route = b => `cmd.${b.parkingId}.${b.type}`;
const error = code => Object.assign(new Error(code), { code });

// PD-02 integration: wrap its processor; no second business transaction here.
function withDeadline(processCommand, { internalKey, parkingId, pool, now = Date.now, beforeDispatch } = {}) {
  return async m => {
    if (m.content.length > 10240) throw error('INVALID_COMMAND_SIZE');
    if (m.content.length > 10240) throw error('INVALID_COMMAND_SIZE');
    let b;
    try { b = JSON.parse(m.content); } catch { throw error('INVALID_JSON'); }
    if (!b || !trusted(internalKey,b,m.properties)) throw error('UNTRUSTED_COMMAND');
    if (b.parkingId !== parkingId || !/^[A-Za-z0-9_-]{1,64}$/.test(b.type ?? '')) throw error('INVALID_ENVELOPE');
    if (!Number.isSafeInteger(b.deadlineAt) || !Number.isSafeInteger(b.issuedAt) || b.deadlineAt < b.issuedAt) throw error('INVALID_DEADLINE');
    if (now() >= b.deadlineAt) {
      // A previously committed inbox result is safe to return after its deadline.
      // A new effect still fails the DB clock guards inside the processor.
      const prior = pool && await pool.query("SELECT 1 FROM inbox_messages WHERE message_id=$1 AND processed_at IS NOT NULL", [m.properties.messageId]);
      if (!prior?.rowCount) throw error('COMMAND_EXPIRED');
    }
    // Broker keeps retry.N as fields.routingKey. Only a signed envelope determines destination.
    const key = route(b);
    if (m.fields.routingKey !== key && !(/^retry\.[12]$/.test(m.fields.routingKey) && m.properties.headers?.['x-original-routing-key'] === key)) throw error('INVALID_ROUTING');
    await beforeDispatch?.(m);
    return processCommand({ ...m, fields:{ ...m.fields,routingKey:key } });
  };
}

function makeRetryOrDead({ url, internalKey, publish = makeTransfer(url), markFailed = async () => {}, now = Date.now }) {
  const transfer = async ({ message:m, error:e, permanent = false }) => {
    let b; try { b = JSON.parse(m.content); } catch { /* retain original bytes */ }
    const signed = b && trusted(internalKey,b,m.properties);
    const original = signed ? route(b) : (m.properties.headers?.['x-original-routing-key'] ?? m.fields.routingKey);
    const raw = m.properties.headers?.['x-retry'] ?? 0;
    const retry = Number.isInteger(raw) && raw >= 0 && raw <= 2 ? raw : 2;
    const expired = signed && Number.isSafeInteger(b.deadlineAt) && now() >= b.deadlineAt;
    const invalid = permanent || !signed || /^INVALID_|^UNTRUSTED_/.test(e.code ?? e.message);
    const reason = expired ? 'COMMAND_EXPIRED' : invalid ? 'INVALID_SCHEMA' : retry >= 2 ? 'RETRY_EXHAUSTED' : 'TRANSIENT';
    const key = expired ? 'expired' : invalid || retry >= 2 ? 'dead' : `retry.${retry+1}`;
    const headers = { ...m.properties.headers, 'x-original-routing-key': original, 'x-failure-reason':reason,
      'x-retry': key.startsWith('retry.') ? retry+1 : retry };
    delete headers.CC; delete headers.BCC; delete headers['x-transfer-id'];
    const properties = { ...m.properties, headers };
    delete properties.expiration; // Never renew the total deadline or shorten the queue delay.
    if (key.startsWith('retry.')) headers.CC = [original];
    if (signed) headers['x-command-signature'] = signature(internalKey,b,properties);
    headers['x-dlq-signature'] = proof(internalKey,m.content,properties,reason,original);
    await publish('parking.dlx',key,m.content,properties);
    // PD-03 optional hook must be idempotent. Failure leaves the source unacked.
    if (key === 'dead') await markFailed(m.properties.messageId,reason);
    return true; // PD-02 consumer owns ack after this confirmed transfer.
  };
  transfer.close = () => publish.close?.();
  return transfer;
}

function testFailures({ enabled = process.env.NODE_ENV === 'test', messageId = process.env.RETRY_TEST_MESSAGE_ID,
  count = Number(process.env.RETRY_TEST_FAILURES ?? 0) } = {}) {
  const seen = new Map();
  return m => {
    if (!enabled || !messageId || m.properties.messageId !== messageId || !Number.isInteger(count) || count<1 || count>2) return;
    const n = seen.get(messageId) ?? 0; seen.set(messageId,n+1);
    if (n<count) throw error('TEST_TRANSIENT');
  };
}
module.exports = { makeRetryOrDead, withDeadline, testFailures };
