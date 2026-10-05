const test = require('node:test');
const assert = require('node:assert/strict');
const { startNode, startStub, startAggregator } = require('./helpers');
const { applyEvent } = require('../src/events');

async function system(t) {
  const a = await startNode('A', 3);
  const b = await startNode('B', 3);
  const slow = await startStub(Infinity);
  const agg = await startAggregator({ A: a.url, B: b.url, S: slow.url });
  t.after(() => { a.server.close(); b.server.close(); slow.server.close(); agg.server.close(); });
  for (const n of agg.reg.all()) n.status = 'ONLINE';
  const tokens = Object.fromEntries(await Promise.all(
    ['user1', 'user2', 'staff-a', 'admin'].map(async (u) => [u, await agg.login(u)])));
  return { a, b, agg, tokens };
}

const reserveBody = (slotCode) => ({ slotCode, licensePlate: '30A-123.45' });

test('đăng nhập: sai mật khẩu 401, đúng thì có token', async (t) => {
  const { agg, tokens } = await system(t);
  assert.equal((await agg.call('/api/auth/login', { method: 'POST', body: { username: 'user1', password: 'x' } })).status, 401);
  assert.ok(tokens.user1);
});

test('đặt chỗ qua Aggregator: cần đăng nhập + Idempotency-Key; retry an toàn; key không dùng chéo giữa người', async (t) => {
  const { agg, tokens } = await system(t);
  const post = (token, key, slot = 'A01') =>
    agg.call('/api/parkings/A/reservations', { method: 'POST', token, key, body: reserveBody(slot) });

  assert.equal((await post(undefined, 'k1')).status, 401);
  assert.equal((await post(tokens['staff-a'], 'k1')).status, 403);
  assert.equal((await post(tokens.user1, undefined)).status, 400);

  const first = await post(tokens.user1, 'k1');
  assert.equal(first.status, 201);
  const retry = await post(tokens.user1, 'k1');                // TC08 qua cả Aggregator
  assert.deepEqual([retry.status, retry.body.id], [200, first.body.id]);

  const other = await post(tokens.user2, 'k1');                // cùng key nhưng người khác: không được "đọc trộm"
  assert.deepEqual([other.status, other.body.error], [409, 'SLOT_TAKEN']);

  const notFound = await agg.call('/api/parkings/Z/reservations', { method: 'POST', token: tokens.user1, key: 'k2', body: reserveBody('Z01') });
  assert.equal(notFound.status, 404);
});

test('TC04 bãi OFFLINE: ghi bị từ chối ngay (503); chi tiết bãi trả bản cache cũ có stale=true', async (t) => {
  const { agg, tokens } = await system(t);
  applyEvent(agg.cache, { parkingId: 'B', slot: 'B01', status: 'OCCUPIED', version: 2 });
  agg.reg.get('B').status = 'OFFLINE';

  const r = await agg.call('/api/parkings/B/reservations', { method: 'POST', token: tokens.user1, key: 'k', body: reserveBody('B02') });
  assert.deepEqual([r.status, r.body.error], [503, 'PARKING_OFFLINE']);

  const detail = await agg.call('/api/parkings/B');
  assert.equal(detail.body.stale, true);
  assert.deepEqual(detail.body.slots, [{ slotCode: 'B01', status: 'OCCUPIED', version: 2 }]);

  const online = await agg.call('/api/parkings/A');
  assert.equal(online.body.stale, false);
  assert.equal(online.body.slots.length, 3);
});

test('TC12 node treo khi đang ghi: 504 TIMEOUT_UNKNOWN_RESULT (không biết đã đặt hay chưa)', async (t) => {
  const { agg, tokens } = await system(t);
  const r = await agg.call('/api/parkings/S/reservations', { method: 'POST', token: tokens.user1, key: 'k', body: reserveBody('S01') });
  assert.deepEqual([r.status, r.body.error], [504, 'TIMEOUT_UNKNOWN_RESULT']);
});

test('nhân viên chỉ thao tác bãi của mình; lịch sử và huỷ của người dùng', async (t) => {
  const { agg, tokens } = await system(t);
  const act = (token, park, slot, action) => agg.call(`/api/parkings/${park}/slots/${slot}/${action}`, { method: 'POST', token, body: {} });

  assert.equal((await act(tokens['staff-a'], 'B', 'B01', 'enter')).status, 403);
  assert.equal((await act(tokens.user1, 'A', 'A02', 'enter')).status, 403);
  assert.equal((await act(tokens['staff-a'], 'A', 'A02', 'fly')).status, 404);
  assert.equal((await act(tokens['staff-a'], 'A', 'A02', 'enter')).body.status, 'OCCUPIED');
  assert.equal((await act(tokens.admin, 'B', 'B03', 'maintenance')).body.status, 'MAINTENANCE');

  const ra = await agg.call('/api/parkings/A/reservations', { method: 'POST', token: tokens.user1, key: 'x1', body: reserveBody('A01') });
  await agg.call('/api/parkings/B/reservations', { method: 'POST', token: tokens.user1, key: 'x2', body: reserveBody('B01') });
  await agg.call('/api/parkings/B/reservations', { method: 'POST', token: tokens.user2, key: 'x3', body: reserveBody('B02') });

  const mine = await agg.call('/api/me/reservations', { token: tokens.user1 });
  assert.deepEqual(mine.body.reservations.map((r) => [r.parkingId, r.slotCode]).sort(), [['A', 'A01'], ['B', 'B01']]);
  assert.deepEqual(mine.body.unavailable, ['S']);                  // bãi treo: báo thiếu, không làm hỏng cả kết quả

  assert.equal((await agg.call(`/api/parkings/A/reservations/${ra.body.id}`, { method: 'DELETE', token: tokens.user2 })).status, 404);
  assert.equal((await agg.call(`/api/parkings/A/reservations/${ra.body.id}`, { method: 'DELETE', token: tokens.user1 })).status, 200);
  const staffList = await agg.call('/api/parkings/A/reservations', { token: tokens['staff-a'] });
  assert.deepEqual(staffList.body.map((r) => r.status), ['CANCELLED']);
});

test('TC19 lịch sử gửi xe: tra biển số gom từ mọi bãi, bãi treo báo thiếu; USER chỉ thấy của mình', async (t) => {
  const { agg, tokens } = await system(t);
  const enter = (id, slot, licensePlate) =>
    agg.call(`/api/parkings/${id}/slots/${slot}/enter`, { method: 'POST', token: tokens.admin, body: { licensePlate } });
  assert.equal((await enter('A', 'A02', '30A-999.99')).status, 200);
  await agg.call('/api/parkings/B/reservations', { method: 'POST', token: tokens.user1, key: 'k', body: reserveBody('B01') });
  assert.equal((await enter('B', 'B01')).body.session.licensePlate, '30A12345');

  const found = await agg.call('/api/sessions/search?plate=30a99999', { token: tokens['staff-a'] });
  assert.deepEqual(found.body.sessions.map((x) => [x.parkingId, x.slotCode]), [['A', 'A02']]);
  assert.deepEqual(found.body.unavailable, ['S']);
  assert.equal((await agg.call('/api/sessions/search?plate=30', { token: tokens.admin })).status, 400);
  assert.equal((await agg.call('/api/sessions/search?plate=30A999', { token: tokens.user1 })).status, 403);

  const mine = await agg.call('/api/me/sessions', { token: tokens.user1 });
  assert.deepEqual(mine.body.sessions.map((x) => [x.parkingId, x.slotCode]), [['B', 'B01']]);
  assert.deepEqual((await agg.call('/api/me/sessions', { token: tokens.user2 })).body.sessions, []);
  assert.equal((await agg.call('/api/parkings/B/sessions', { token: tokens['staff-a'] })).status, 403);
  assert.equal((await agg.call('/api/parkings/A/sessions', { token: tokens['staff-a'] })).body.length, 1);
});

test('quản trị: xem trạng thái node, thêm bãi mới (không sửa code)', async (t) => {
  const { agg, tokens } = await system(t);
  assert.equal((await agg.call('/api/admin/nodes', { token: tokens.user1 })).status, 403);
  assert.equal((await agg.call('/api/admin/nodes', { token: tokens.admin })).body.length, 3);

  const add = (body) => agg.call('/api/admin/nodes', { method: 'POST', token: tokens.admin, body });
  assert.equal((await add({ parkingId: 'd', name: 'x', apiUrl: 'http://x' })).status, 400);
  assert.equal((await add({ parkingId: 'A', name: 'x', apiUrl: 'http://x' })).status, 409);
  const ok = await add({ parkingId: 'D', name: 'Bãi D', apiUrl: 'http://parking-d:8004' });
  assert.deepEqual([ok.status, ok.body.status], [201, 'OFFLINE']);  // chờ health check đầu tiên
  assert.deepEqual((await agg.call('/api/parkings')).body.map((p) => p.parkingId), ['A', 'B', 'S', 'D']);
});

test('TC33–TC35 đăng ký, đổi mật khẩu, khoá tạm khi sai mật khẩu nhiều lần', async (t) => {
  const { agg } = await system(t);
  const reg = (username, password) => agg.call('/api/auth/register', { method: 'POST', body: { username, password } });
  const login = (username, password) => agg.call('/api/auth/login', { method: 'POST', body: { username, password } });

  // TC33: đăng ký xong có token vai trò USER, đăng nhập lại được
  const r = await reg('nguyen.van_a', 'matkhau123');
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'USER');
  assert.equal((await login('nguyen.van_a', 'matkhau123')).status, 200);
  // TC34: trùng tên 409; tên/mật khẩu không hợp lệ 400
  assert.equal((await reg('nguyen.van_a', 'khac12345')).status, 409);
  assert.equal((await reg('Ab', 'matkhau123')).status, 400);
  assert.equal((await reg('hople123', 'ngan')).status, 400);

  const token = r.body.token;
  const change = (oldPassword, newPassword) => agg.call('/api/me/password', { method: 'PUT', token, body: { oldPassword, newPassword } });
  assert.equal((await change('sai', 'moi123456')).status, 400);
  assert.equal((await change('matkhau123', 'moi123456')).status, 200);
  assert.equal((await login('nguyen.van_a', 'matkhau123')).status, 401);
  assert.equal((await login('nguyen.van_a', 'moi123456')).status, 200);

  // TC35: sai 5 lần thì lần thứ 6 bị 429, kể cả mật khẩu đúng; tài khoản khác không ảnh hưởng
  for (let i = 0; i < 5; i++) assert.equal((await login('user2', 'sai')).status, 401);
  assert.equal((await login('user2', 'pw')).status, 429);
  assert.equal((await login('user1', 'pw')).status, 200);
});

test('NV-04 người dùng trả tiền qua Aggregator: cần Idempotency-Key, bấm lại cùng key không trả lần 2', async (t) => {
  const { a, agg, tokens } = await system(t);
  await agg.call('/api/parkings/A/reservations', { method: 'POST', token: tokens.user1, key: 'r', body: reserveBody('A01') });
  const sid = (await agg.call('/api/parkings/A/slots/A01/enter', { method: 'POST', token: tokens.admin, body: {} })).body.session.id;
  await a.pool.query(`UPDATE pricing_rules SET overnight_fee=0`);
  await a.pool.query(`UPDATE parking_sessions SET entered_at = now() - interval '150 minutes' WHERE id=$1`, [sid]);

  const pay = (token, key) => agg.call(`/api/me/sessions/A/${sid}/pay`, { method: 'POST', token, key });
  assert.equal((await pay(tokens.user1)).status, 400);                    // thiếu key
  assert.equal((await pay(tokens.user2, 'p1')).status, 404);              // phiên của người khác
  const first = await pay(tokens.user1, 'p1');
  assert.deepEqual([first.status, first.body.fee], [200, 35000]);
  assert.equal((await pay(tokens.user1, 'p1')).body.paidAt, first.body.paidAt);
  // nhân viên: chưa trả thì 402, thu tiền mặt thì cho ra (ở đây đã trả online nên ra luôn)
  assert.equal((await agg.call('/api/parkings/A/slots/A01/exit', { method: 'POST', token: tokens.admin, body: {} })).status, 200);
});

test('NV-09 quản lý slot qua Aggregator: nhân viên chỉ bãi mình, người dùng không được', async (t) => {
  const { agg, tokens } = await system(t);
  const add = (token, id) => agg.call(`/api/parkings/${id}/slots`, { method: 'POST', token, body: { slotCode: `${id}09`, floor: 2, type: 'MOTO' } });
  assert.equal((await add(tokens.user1, 'A')).status, 403);
  assert.equal((await add(tokens['staff-a'], 'B')).status, 403);
  assert.equal((await add(tokens['staff-a'], 'A')).status, 201);
  assert.equal((await agg.call('/api/parkings/A/slots/A09', { method: 'PATCH', token: tokens.admin, body: { floor: 3 } })).body.floor, 3);
  assert.equal((await agg.call('/api/parkings/A/slots/A09', { method: 'DELETE', token: tokens['staff-a'] })).body.status, 'HIDDEN');
});

test('GS-03 mã truy vết: X-Request-Id từ client đi qua Aggregator -> node -> sự kiện outbox; trả lại trong response', async (t) => {
  const { a, agg, tokens } = await system(t);
  const url = agg.server.address();
  const r = await fetch(`http://127.0.0.1:${url.port}/api/parkings/A/reservations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.user1}`, 'idempotency-key': 'trace', 'x-request-id': 'trace-123' },
    body: JSON.stringify({ slotCode: 'A01', licensePlate: '30A-123.45' }),
  });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('x-request-id'), 'trace-123');
  const ev = (await a.pool.query(`SELECT payload FROM parking_events ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(ev.payload.requestId, 'trace-123');
  // không gửi thì tự sinh
  assert.match((await fetch(`http://127.0.0.1:${url.port}/api/parkings`)).headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('UX-01 toạ độ bãi: thêm bãi kèm lat/lng, /api/parkings trả toạ độ; toạ độ sai -> 400', async (t) => {
  const { agg, tokens } = await system(t);
  const add = (body) => agg.call('/api/admin/nodes', { method: 'POST', token: tokens.admin, body: { name: 'Bãi E', apiUrl: 'http://e', ...body } });
  assert.equal((await add({ parkingId: 'E', lat: 95, lng: 105 })).status, 400);
  assert.equal((await add({ parkingId: 'E', lat: '21.03', lng: 105.85 })).status, 201);
  const e = (await agg.call('/api/parkings')).body.find((p) => p.parkingId === 'E');
  assert.deepEqual([e.lat, e.lng], [21.03, 105.85]);
});

test('UX-02 thống kê gom các bãi: bãi treo báo thiếu; STAFF chỉ thấy bãi mình; USER bị chặn', async (t) => {
  const { agg, tokens } = await system(t);
  await agg.call('/api/parkings/A/slots/A01/enter', { method: 'POST', token: tokens.admin, body: {} });
  await agg.call('/api/parkings/B/slots/B01/enter', { method: 'POST', token: tokens.admin, body: {} });
  const all = await agg.call('/api/admin/stats', { token: tokens.admin });
  assert.deepEqual([all.body.total.sessions, all.body.total.occupied, all.body.total.total], [2, 2, 6]);
  assert.deepEqual(all.body.unavailable, ['S']);
  const mine = await agg.call('/api/admin/stats', { token: tokens['staff-a'] });
  assert.deepEqual(mine.body.parkings.map((p) => p.parkingId), ['A']);
  assert.deepEqual(mine.body.unavailable, []);
  assert.equal((await agg.call('/api/admin/stats', { token: tokens.user1 })).status, 403);
});

test('PT-05 Aggregator ký RS256 -> node tự kiểm được bằng khoá công khai (không cần Aggregator)', async () => {
  const crypto = require('node:crypto');
  const { makeAuth } = require('../src/auth');
  const { verifyRS256 } = require('../../parking-node/src/jwt');
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const auth = makeAuth('secret', k);
  const pool = { query: async () => ({ rows: [{ id: 'u', username: 'staff-a', role: 'STAFF', parking_id: 'A',
    password_hash: await require('bcryptjs').hash('pw', 4) }] }) };
  const { token } = await auth.login(pool, 'staff-a', 'pw');
  assert.deepEqual([verifyRS256(token, k.publicKey).role, verifyRS256(token, k.publicKey).parkingId], ['STAFF', 'A']);
  // middleware need() của Aggregator vẫn chấp nhận token RS256 và từ chối HS256 giả mạo
  const req = (t) => ({ get: () => `Bearer ${t}` });
  let ok = false;
  auth.need('STAFF')(req(token), {}, () => { ok = true; });
  assert.ok(ok);
  // tấn công đổi thuật toán: ký HS256 với "secret" là chính khoá công khai
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'ADMIN' })}`;
  const forged = `${data}.${crypto.createHmac('sha256', k.publicKey).update(data).digest('base64url')}`;
  let status;
  auth.need()(req(forged), { status: (c) => { status = c; return { json: () => {} }; } }, () => {});
  assert.equal(status, 401);
});
