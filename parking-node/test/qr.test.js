const test = require('node:test');
const assert = require('node:assert/strict');
const { sign, verify } = require('../src/qr');

test('QR: ký rồi kiểm đúng; sửa 1 ký tự, sai khoá, hết hạn đều bị từ chối', () => {
  const t = sign('k', { p: 'A', r: 'id-1', e: 2000 });
  assert.deepEqual(verify('k', t, 1000), { payload: { p: 'A', r: 'id-1', e: 2000 } });
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  assert.deepEqual(verify('k', flip(t, 3), 1000), { error: 'INVALID_QR' });            // sửa phần dữ liệu
  assert.deepEqual(verify('k', flip(t, t.length - 2), 1000), { error: 'INVALID_QR' }); // sửa chữ ký
  assert.deepEqual(verify('khac', t, 1000), { error: 'INVALID_QR' });
  assert.deepEqual(verify('k', t, 3000), { error: 'QR_EXPIRED' });
  for (const bad of ['', 'abc', 'a.b.c', null]) assert.deepEqual(verify('k', bad, 1000), { error: 'INVALID_QR' });
});
