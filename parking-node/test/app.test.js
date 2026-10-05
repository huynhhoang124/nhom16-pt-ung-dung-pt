const test = require('node:test');
const assert = require('node:assert/strict');
const { makePool } = require('./helpers');
const { makeApp } = require('../src/app');

async function start() {
  const pool = await makePool('B', 3);
  const server = makeApp({ pool, parkingId: 'B', internalKey: 'k' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { key = 'k', method = 'GET', body } = {}) =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { 'x-internal-key': key } : {}) },
      body: body && JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { call, pool, close: () => server.close() };
}

test('HTTP: health mở, API cần khoá nội bộ, luồng đặt/vào/ra/huỷ', async (t) => {
  const { call, close } = await start();
  t.after(close);

  assert.deepEqual(await call('/health', { key: null }), { status: 200, body: { status: 'UP', parkingId: 'B' } });
  assert.equal((await call('/api/availability', { key: null })).status, 401);
  assert.equal((await call('/api/availability', { key: 'sai' })).status, 401);
  assert.deepEqual((await call('/api/availability')).body, { parkingId: 'B', available: 3, total: 3, byType: { CAR: { available: 3, total: 3 } } });

  assert.equal((await call('/api/reservations', { method: 'POST', body: { slotCode: 'B01' } })).status, 400);
  const body = { requestId: 'q1', userId: 'u1', slotCode: 'B01', licensePlate: '29A-111.11' };
  const r = await call('/api/reservations', { method: 'POST', body });
  assert.equal(r.status, 201);
  assert.equal((await call('/api/reservations', { method: 'POST', body })).status, 200);   // retry
  assert.equal((await call('/api/reservations', { method: 'POST', body: { ...body, requestId: 'q2' } })).status, 409);
  // TC54: biển số sai định dạng -> 400; đúng thì lưu dạng chuẩn
  assert.deepEqual((await call('/api/reservations', { method: 'POST', body: { ...body, requestId: 'q3', slotCode: 'B03', licensePlate: 'abc' } })).body, { error: 'INVALID_PLATE' });
  assert.equal(r.body.license_plate, '29A11111');
  assert.equal((await call('/api/slots/B03/enter', { method: 'POST', body: { licensePlate: '12' } })).status, 400);

  assert.equal((await call('/api/slots/B02/fly', { method: 'POST' })).status, 404);
  assert.equal((await call('/api/slots/B02/exit', { method: 'POST' })).status, 409);
  assert.equal((await call('/api/slots/B02/enter', { method: 'POST' })).body.status, 'OCCUPIED');
  assert.deepEqual((await call('/api/slots/available')).body.map((x) => x.slotCode), ['B03']);

  assert.equal((await call('/api/reservations/not-a-uuid', { method: 'DELETE' })).status, 404);
  assert.equal((await call(`/api/reservations/${r.body.id}?userId=u1`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await call('/api/reservations?userId=u1')).body.map((x) => x.status), ['CANCELLED']);
});

test('bảng giá: xem, sửa (kiểm dữ liệu), seed không ghi đè giá đã sửa', async (t) => {
  const { call, pool, close } = await start();
  t.after(close);
  const list = await call('/api/pricing');
  assert.deepEqual(list.body.map((r) => r.vehicleType), ['CAR', 'MOTO']);
  const car = { ...list.body[0], firstBlockFee: 30000 };
  assert.equal((await call('/api/pricing', { method: 'PUT', body: [{ ...car, nextHourFee: -5 }] })).status, 400);
  assert.equal((await call('/api/pricing', { method: 'PUT', body: [car] })).body[0].firstBlockFee, 30000);
  await require('../src/db').init(pool, 'B', 3);
  assert.equal((await call('/api/pricing')).body[0].firstBlockFee, 30000);
});

test('TC29–TC32 QR ở cổng: đúng thì vào/ra được; sửa ký tự 401; QR bãi khác 403; dùng lại 409', async (t) => {
  const { call, close } = await start();
  t.after(close);
  const res = await call('/api/reservations', { method: 'POST', body: { requestId: 'qr1', userId: 'u1', slotCode: 'B01', licensePlate: '30A-123.45' } });
  const { qrToken } = res.body;
  assert.ok(qrToken);
  const scan = (token, action = 'enter') => call('/api/gate/scan', { method: 'POST', body: { token, action } });

  assert.equal((await scan(qrToken.slice(0, 5) + (qrToken[5] === 'x' ? 'y' : 'x') + qrToken.slice(6))).status, 401);   // TC30
  const other = require('../src/qr').sign('k:qr:A', { p: 'A', r: res.body.id, e: 9e9 });
  assert.equal((await scan(other)).status, 401);                                       // khoá bãi A không hợp lệ ở bãi B
  const forged = require('../src/qr').sign('k:qr:B', { p: 'A', r: res.body.id, e: 9e9 });
  assert.deepEqual((await scan(forged)).body, { error: 'WRONG_PARKING' });             // TC31

  const enter = await scan(qrToken);                                                   // TC29
  assert.deepEqual([enter.status, enter.body.status, enter.body.session.licensePlate], [200, 'OCCUPIED', '30A12345']);
  assert.deepEqual([(await scan(qrToken)).status, (await scan(qrToken)).body.error], [409, 'QR_USED']);   // TC32
  assert.equal((await scan(qrToken, 'exit')).body.status, 'AVAILABLE');               // ra bằng QR (dưới 5 phút: miễn phí)
  assert.deepEqual((await scan(qrToken, 'exit')).body, { error: 'NOT_INSIDE' });
  // danh sách đặt chỗ: chỉ reservation ACTIVE mới có QR
  assert.equal((await call('/api/reservations')).body[0].qrToken, undefined);
});

test('NV-01 HTTP: kiểm giờ đến / thời lượng; đặt trước rồi xem lịch slot', async (t) => {
  const { call, close } = await start();
  t.after(close);
  const body = (id, extra) => ({ requestId: id, userId: 'u1', slotCode: 'B01', licensePlate: '30A-123.45', ...extra });
  const post = (b) => call('/api/reservations', { method: 'POST', body: b });
  assert.deepEqual((await post(body('t1', { startTime: 'hôm qua' }))).body, { error: 'INVALID_START_TIME' });
  assert.deepEqual((await post(body('t2', { startTime: new Date(Date.now() + 8 * 86400_000).toISOString() }))).body, { error: 'INVALID_START_TIME' });
  assert.deepEqual((await post(body('t3', { durationMinutes: 10 }))).body, { error: 'INVALID_DURATION' });
  const at = new Date(Date.now() + 3 * 3600_000);
  const r = await post(body('t4', { startTime: at.toISOString(), durationMinutes: 90 }));
  assert.equal(r.status, 201);
  assert.equal(new Date(r.body.end_time) - new Date(r.body.start_time), 90 * 60_000);
  const date = new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  assert.equal((await call(`/api/slots/B01/schedule?date=${date}`)).body.length, 1);
  assert.equal((await call('/api/slots/B01/schedule')).status, 400);
});

test('PT-05 nhân viên gọi thẳng node bằng JWT: chỉ bãi mình, chỉ thao tác được phép; CORS cho trang web', async (t) => {
  const crypto = require('node:crypto');
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = (p) => {
    const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ ...p, exp: Date.now() / 1000 + 600 })}`;
    return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), k.privateKey).toString('base64url')}`;
  };
  const pool = await makePool('B', 3);
  const server = makeApp({ pool, parkingId: 'B', internalKey: 'k', jwtPublicKey: k.publicKey }).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, token, { method = 'GET', body } = {}) => fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), origin: 'http://localhost:3000' },
    body: body && JSON.stringify(body) });

  const staffB = tok({ role: 'STAFF', parkingId: 'B' });
  const enter = await call('/api/slots/B01/enter', staffB, { method: 'POST', body: {} });
  assert.equal(enter.status, 200);
  assert.equal(enter.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal((await call('/api/slots', staffB)).status, 200);
  assert.equal((await call('/api/slots/B02/enter', tok({ role: 'STAFF', parkingId: 'A' }), { method: 'POST', body: {} })).status, 403);
  assert.equal((await call('/api/slots/B02/enter', tok({ role: 'USER' }), { method: 'POST', body: {} })).status, 403);
  assert.equal((await call('/api/pricing', staffB, { method: 'PUT', body: [] })).status, 403);   // không nằm trong danh sách được phép
  assert.equal((await call('/api/slots/B02/enter', tok({ role: 'ADMIN' }), { method: 'POST', body: {} })).status, 200);
  assert.equal((await call('/api/slots', 'rác')).status, 401);
  const pre = await fetch(`${base}/api/slots`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });
  assert.equal(pre.status, 204);
});
