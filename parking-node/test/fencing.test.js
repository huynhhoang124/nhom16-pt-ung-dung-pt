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

test('PD-10 fencing HTTP: middleware chặn request mang token cũ và endpoint /api/internal/fenced-job', async () => {
  const pool = await makePool('A', 5);
  const app = makeApp({
    pool,
    readPool: pool,
    parkingId: 'A',
    internalKey: 'dev',
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    // 1. Gọi fenced-job với token 100 -> 200
    const res1 = await fetch(`http://127.0.0.1:${port}/api/internal/fenced-job`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'dev' },
      body: JSON.stringify({ job: 'expireSweep', token: 100 }),
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.maxToken, 100);

    // 2. Gọi fenced-job với token 99 -> 409 STALE_LEADER
    const res2 = await fetch(`http://127.0.0.1:${port}/api/internal/fenced-job`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'dev' },
      body: JSON.stringify({ job: 'expireSweep', token: 99 }),
    });
    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.error, 'STALE_LEADER');

    // 3. Gọi endpoint nghiệp vụ thông qua header X-Fencing-Token: 200
    const res3 = await fetch(`http://127.0.0.1:${port}/api/slots`, {
      headers: {
        'x-internal-key': 'dev',
        'x-fencing-token': '200',
        'x-fencing-job': 'reconcile-slots',
      },
    });
    assert.equal(res3.status, 200);

    // 4. Gọi lại với header X-Fencing-Token cũ 150 -> 409 STALE_LEADER
    const res4 = await fetch(`http://127.0.0.1:${port}/api/slots`, {
      headers: {
        'x-internal-key': 'dev',
        'x-fencing-token': '150',
        'x-fencing-job': 'reconcile-slots',
      },
    });
    assert.equal(res4.status, 409);
    const body4 = await res4.json();
    assert.equal(body4.error, 'STALE_LEADER');

    // 5. Kiểm tra metric /metrics có chứa fencing_rejected_total
    const mRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    const mText = await mRes.text();
    assert.ok(mText.includes('fencing_rejected_total'));
  } finally {
    server.close();
  }
});
