const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makePool } = require('./helpers');
const { checkFencing } = require('../src/fencing');
const { makeApp } = require('../src/app');

test('PD-10 fencing: chấp nhận token tăng dần (41 -> 42), từ chối token cũ (41 < 42)', async () => {
  const pool = await makePool('A', 5);

  // 1. Token ban đầu 41: thành công
  const r1 = await checkFencing(pool, 'reconcile', 41);
  assert.equal(r1.ok, true);
  assert.equal(r1.maxToken, 41);

  // 2. Token tăng lên 42: thành công
  const r2 = await checkFencing(pool, 'reconcile', 42);
  assert.equal(r2.ok, true);
  assert.equal(r2.maxToken, 42);

  // 3. Token lặp lại 42: vẫn chấp nhận
  const r3 = await checkFencing(pool, 'reconcile', 42);
  assert.equal(r3.ok, true);
  assert.equal(r3.maxToken, 42);

  // 4. Token cũ 41 gửi lại: từ chối với STALE_LEADER (409)
  const r4 = await checkFencing(pool, 'reconcile', 41);
  assert.equal(r4.ok, false);
  assert.equal(r4.error, 'STALE_LEADER');
  assert.equal(r4.code, 409);
  assert.equal(r4.token, 41);

  // 5. Job khác ('stats') hoạt động độc lập
  const rStats = await checkFencing(pool, 'stats', 10);
  assert.equal(rStats.ok, true);
  assert.equal(rStats.maxToken, 10);

  // Stats gửi token cũ 5: bị từ chối
  const rStatsOld = await checkFencing(pool, 'stats', 5);
  assert.equal(rStatsOld.ok, false);
  assert.equal(rStatsOld.error, 'STALE_LEADER');

  // 6. Tương thích ngược: không truyền token thì cho qua (skipped)
  const rSkip = await checkFencing(pool, 'reconcile', undefined);
  assert.equal(rSkip.ok, true);
  assert.equal(rSkip.skipped, true);
});

test('PD-10 fencing HTTP: lệnh ghi kiểm token trong cùng giao dịch, token cũ không ghi được gì', async (t) => {
  const pool = await makePool('A', 5);
  const server = http.createServer(makeApp({ pool, readPool: pool, parkingId: 'A', internalKey: 'dev' })).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, token, { method = 'GET', key = 'dev' } = {}) => fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': key, ...(token !== undefined && { 'x-fencing-token': String(token), 'x-fencing-job': 'reconcile' }) },
    body: method === 'GET' ? undefined : '{}',
  });
  const slot = async (code) => (await pool.query('SELECT status FROM parking_slots WHERE slot_code=$1', [code])).rows[0].status;

  // 1. Leader mới (token 200) ghi được và nâng max_token trong cùng giao dịch
  assert.equal((await call('/api/slots/A01/maintenance', 200, { method: 'POST' })).status, 200);
  assert.equal(await slot('A01'), 'MAINTENANCE');
  assert.equal((await checkFencing(pool, 'reconcile', 200)).maxToken, 200);

  // 2. Leader cũ (token 150): 409 STALE_LEADER, giao dịch ROLLBACK -> slot không đổi, không có sự kiện outbox
  const events = async () => Number((await pool.query('SELECT count(*) AS n FROM parking_events')).rows[0].n);
  const before = await events();
  const stale = await call('/api/slots/A01/unmaintenance', 150, { method: 'POST' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'STALE_LEADER');
  assert.equal(await slot('A01'), 'MAINTENANCE');
  assert.equal(await events(), before);

  // 3. Đọc với token cũ cũng bị báo để leader cũ sớm tự rút lui; token sai định dạng -> 400
  assert.equal((await call('/api/slots', 150)).status, 409);
  assert.equal((await call('/api/slots', 'abc')).status, 400);

  // 4. Không có token (request thường) -> chạy như cũ
  assert.equal((await call('/api/slots/A01/unmaintenance', undefined, { method: 'POST' })).status, 200);

  // 5. Metric fencing_rejected_total có trên /metrics
  assert.ok((await (await fetch(`${base}/metrics`)).text()).includes('fencing_rejected_total'));
});

test('PD-10 fencing: nhân viên có JWT gửi x-fencing-token thì bị bỏ qua, không chặn được leader thật', async (t) => {
  const crypto = require('node:crypto');
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ role: 'STAFF', parkingId: 'A', exp: Date.now() / 1000 + 600 })}`;
  const staff = `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), k.privateKey).toString('base64url')}`;
  const pool = await makePool('A', 5);
  const server = http.createServer(makeApp({ pool, readPool: pool, parkingId: 'A', internalKey: 'dev', jwtPublicKey: k.publicKey })).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  await checkFencing(pool, 'reconcile', 42);   // leader thật đang giữ token 42
  const r = await fetch(`${base}/api/slots`, {
    headers: { authorization: `Bearer ${staff}`, 'x-fencing-token': '999999999', 'x-fencing-job': 'reconcile' },
  });
  assert.equal(r.status, 200);
  // max_token không bị đẩy lên -> leader thật (42) vẫn được chấp nhận
  assert.equal((await checkFencing(pool, 'reconcile', 42)).ok, true);
});
