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

const reserveBody = (slotCode) => ({ slotCode, licensePlate: '30A-123' });

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
  assert.equal((await enter('B', 'B01')).body.session.licensePlate, '30A-123');

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
