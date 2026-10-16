const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyRS256 } = require('../src/jwt');

const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(privateKey, payload, alg = 'RS256') {
  const data = `${b64({ alg, typ: 'JWT' })}.${b64(payload)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

test('PT-05 kiểm JWT RS256 bằng khoá công khai: đúng / sai khoá / sửa nội dung / hết hạn / đổi alg', () => {
  const k = pair();
  const other = pair();
  const t = sign(k.privateKey, { role: 'STAFF', parkingId: 'A', exp: 2000 });
  assert.deepEqual(verifyRS256(t, k.publicKey, 1000), { role: 'STAFF', parkingId: 'A', exp: 2000 });
  assert.equal(verifyRS256(t, other.publicKey, 1000), null);
  const [h, , s] = t.split('.');
  assert.equal(verifyRS256(`${h}.${b64({ role: 'ADMIN', exp: 2000 })}.${s}`, k.publicKey, 1000), null);
  assert.equal(verifyRS256(t, k.publicKey, 3000), null);
  assert.equal(verifyRS256(sign(k.privateKey, { role: 'ADMIN' }, 'none'), k.publicKey), null);
  for (const bad of ['', 'a.b', 'a.b.c.d', null]) assert.equal(verifyRS256(bad, k.publicKey), null);
});
