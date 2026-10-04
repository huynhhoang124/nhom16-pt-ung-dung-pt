// Kiểm thử toàn hệ thống trên Docker (Postgres thật, RabbitMQ thật, mạng thật).
//   docker compose up -d --build
//   node --test tests/e2e.test.mjs
// Test có tắt/bật container (parking-b, aggregator, rabbitmq) và tự bật lại khi xong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { io } = createRequire(new URL('../frontend/package.json', import.meta.url))('socket.io-client');
const AGG = 'http://localhost:8000';
const NODE = { A: 'http://localhost:8001', B: 'http://localhost:8002', C: 'http://localhost:8003' };
const KEY = process.env.INTERNAL_KEY ?? 'dev';
const T = { timeout: 120_000 };

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const compose = (args) => sh(`docker compose ${args}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => compose(`exec -T ${db} psql -U postgres -d parking -tAc "${q}"`);

async function http(url, { method = 'GET', body, headers = {} } = {}) {
  try {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}
const agg = (path, { token, key, ...o } = {}) => http(AGG + path, {
  ...o, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) },
});
const node = (id, path, o = {}) => http(NODE[id] + path, { ...o, headers: { 'x-internal-key': KEY } });

async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Hết thời gian chờ: ${what}`);
    await sleep(500);
  }
}
const statusOf = async (id) => (await agg('/api/parkings')).body?.find((p) => p.parkingId === id)?.status;
const freeSlot = async (id) => (await node(id, '/api/slots/available')).body[0].slotCode;
const login = async (u) => (await agg('/api/auth/login', { method: 'POST', body: { username: u, password: process.env.DEMO_PASSWORD ?? '123456' } })).body.token;

// Dọn sau test (huỷ đặt chỗ, cho xe ra) để chạy lặp lại được nhiều lần.
const undo = [];
const cancelLater = (id, rid) => undo.push(() => node(id, `/api/reservations/${rid}`, { method: 'DELETE' }));
const exitLater = (id, slot) => undo.push(() => node(id, `/api/slots/${slot}/exit`, { method: 'POST', body: {} }));
test.after(async () => { for (const f of undo) await f(); });

let tok;
test.before(async () => {
  await until('3 bãi ONLINE', async () => (await Promise.all(['A', 'B', 'C'].map(statusOf))).every((s) => s === 'ONLINE'), 120_000);
  tok = { user1: await login('user1'), user2: await login('user2'), staffA: await login('staff-a') };
});

test('cô lập dữ liệu: node bãi A không biết địa chỉ DB của bãi khác', T, () => {
  const env = compose('exec -T parking-a env');
  assert.match(env, /DATABASE_URL=postgres:\/\/postgres:dev@db-a\//);
  assert.doesNotMatch(env, /db-b|db-c/);
});

test('TC01 tra cứu tổng hợp 3 bãi', T, async () => {
  const r = await agg('/api/parkings/availability');
  assert.deepEqual(r.body.map((p) => [p.parkingId, p.status, p.total]), [['A', 'ONLINE', 40], ['B', 'ONLINE', 60], ['C', 'ONLINE', 30]]);
});

test('TC02 + TC08 đặt chỗ, gửi lại cùng Idempotency-Key không tạo bản thứ hai', T, async () => {
  const slot = await freeSlot('A');
  const key = randomUUID();
  const body = { slotCode: slot, licensePlate: '30A-111.11' };
  const a = await agg('/api/parkings/A/reservations', { method: 'POST', token: tok.user1, key, body });
  assert.equal(a.status, 201);
  cancelLater('A', a.body.id);
  const b = await agg('/api/parkings/A/reservations', { method: 'POST', token: tok.user1, key, body });
  assert.deepEqual([b.status, b.body.id], [200, a.body.id]);
  assert.equal(sql('db-a', `SELECT count(*) FROM reservations r JOIN parking_slots s ON s.id=r.slot_id WHERE s.slot_code='${slot}' AND r.status='ACTIVE'`), '1');
});

test('TC09 20 request đồng thời cùng một slot (Postgres thật): đúng 1 thành công', T, async () => {
  const slot = await freeSlot('C');
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => node('C', '/api/reservations', {
    method: 'POST', body: { requestId: `race-${randomUUID()}`, userId: `u${i}`, slotCode: slot, licensePlate: `29A-${i}` },
  })));
  results.filter((r) => r.status === 201).forEach((r) => cancelLater('C', r.body.id));
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, ...Array(19).fill(409)]);
});

test('10 lần gửi đồng thời CÙNG một Idempotency-Key: chỉ 1 reservation, mọi phản hồi cùng id', T, async () => {
  const slot = await freeSlot('C');
  const key = randomUUID();
  const rs = await Promise.all(Array.from({ length: 10 }, () => agg('/api/parkings/C/reservations', {
    method: 'POST', token: tok.user2, key, body: { slotCode: slot, licensePlate: '29A-999' },
  })));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201), rs.map((r) => r.status).join(','));
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  cancelLater('C', rs[0].body.id);
});

test('TC06 + TC07 nhân viên cho xe vào/ra; sự kiện đi qua outbox -> RabbitMQ -> Aggregator -> Socket.IO', T, async () => {
  const slot = await freeSlot('A');
  const socket = io(AGG, { transports: ['websocket'] });
  const got = [];
  socket.on('SLOT_UPDATED', (e) => e.slot === slot && got.push(e.status));
  await until('socket kết nối', () => socket.connected, 10_000);

  const enter = await agg(`/api/parkings/A/slots/${slot}/enter`, { method: 'POST', token: tok.staffA, body: {} });
  assert.equal(enter.body.status, 'OCCUPIED');
  // Barrier gọi thẳng node (không qua Aggregator)
  assert.equal((await node('A', `/api/slots/${slot}/exit`, { method: 'POST', body: {} })).body.status, 'AVAILABLE');
  await until('nhận đủ 2 sự kiện realtime', () => got.length >= 2, 15_000);
  socket.close();
  assert.deepEqual(got, ['OCCUPIED', 'AVAILABLE']);
  assert.equal((await agg(`/api/parkings/A/slots/${slot}/enter`, { method: 'POST', token: tok.staffA, body: {} })).status, 200);
  exitLater('A', slot);
  assert.equal((await agg(`/api/parkings/B/slots/B01/enter`, { method: 'POST', token: tok.staffA, body: {} })).status, 403);
});

test('TC04 + TC05 tắt bãi B: A, C vẫn chạy, ghi B bị 503, chi tiết B trả dữ liệu cũ; bật lại thì ONLINE', T, async () => {
  compose('stop parking-b');
  try {
    await until('B OFFLINE', async () => (await statusOf('B')) === 'OFFLINE');
    const avail = await agg('/api/parkings/availability');
    assert.deepEqual(avail.body.map((p) => [p.parkingId, p.status]), [['A', 'ONLINE'], ['B', 'OFFLINE'], ['C', 'ONLINE']]);
    const r = await agg('/api/parkings/B/reservations', { method: 'POST', token: tok.user1, key: randomUUID(), body: { slotCode: 'B02', licensePlate: 'x' } });
    assert.deepEqual([r.status, r.body.error], [503, 'PARKING_OFFLINE']);
    const detail = await agg('/api/parkings/B');
    assert.equal(detail.body.stale, true);
    const ok = await agg('/api/parkings/A/reservations', { method: 'POST', token: tok.user1, key: randomUUID(), body: { slotCode: await freeSlot('A'), licensePlate: 'x' } });
    assert.equal(ok.status, 201);
    cancelLater('A', ok.body.id);
  } finally {
    compose('start parking-b');
  }
  await until('B ONLINE lại', async () => (await statusOf('B')) === 'ONLINE');
  assert.equal((await agg('/api/parkings/B')).body.stale, false);
});

test('TC10 Aggregator tắt: sự kiện nằm chờ trong queue RabbitMQ, bật lại thì được xử lý hết', T, async () => {
  compose('stop aggregator');
  try {
    const slot = await freeSlot('A');
    assert.equal((await node('A', `/api/slots/${slot}/enter`, { method: 'POST', body: {} })).status, 200);
    exitLater('A', slot);   // bãi vẫn chạy
    await until('tin vào queue', () => Number(compose('exec -T rabbitmq rabbitmqctl -q list_queues name messages').match(/aggregator\.slot-updates\s+(\d+)/)?.[1]) > 0, 20_000);
  } finally {
    compose('start aggregator');
  }
  await until('queue rỗng', () => compose('exec -T rabbitmq rabbitmqctl -q list_queues name messages').match(/aggregator\.slot-updates\s+(\d+)/)?.[1] === '0', 60_000);
  await until('3 bãi ONLINE', async () => (await Promise.all(['A', 'B', 'C'].map(statusOf))).every((s) => s === 'ONLINE'));
});

test('Broker tắt: sự kiện nằm trong outbox của bãi, broker bật lại thì relay gửi hết', T, async () => {
  compose('stop rabbitmq');
  try {
    const slot = await freeSlot('A');
    assert.equal((await node('A', `/api/slots/${slot}/enter`, { method: 'POST', body: {} })).status, 200);
    exitLater('A', slot);   // nghiệp vụ không bị chặn
    await sleep(1500);
    assert.ok(Number(sql('db-a', 'SELECT count(*) FROM parking_events WHERE published_at IS NULL')) >= 1);
  } finally {
    compose('start rabbitmq');
  }
  await until('outbox gửi hết', () => sql('db-a', 'SELECT count(*) FROM parking_events WHERE published_at IS NULL') === '0', 90_000);
});
