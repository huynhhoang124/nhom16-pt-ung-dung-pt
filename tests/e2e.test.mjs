// Kiểm thử toàn hệ thống trên Docker (Postgres thật, RabbitMQ thật, mạng thật).
//   docker compose up -d --build
//   node --test tests/e2e.test.mjs
// Test có tắt/bật container (parking-b, aggregator, rabbitmq, notification) và tự bật lại khi xong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* chưa có .env: dùng biến môi trường / mặc định */ }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { io } = createRequire(new URL('../frontend/package.json', import.meta.url))('socket.io-client');
const AGG = 'http://localhost:8000';
const NODE = { A: 'http://localhost:8001', B: 'http://localhost:8002', C: 'http://localhost:8003', D: 'http://localhost:8004' };
const KEY = process.env.INTERNAL_KEY ?? 'dev';
const T = { timeout: 120_000 };

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const compose = (args) => sh(`docker compose ${args}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => compose(`exec -T ${db} psql -U postgres -d parking -tAc "${q}"`);

// GET lỗi kết nối thì thử lại 1 lần: kết nối keep-alive cũ có thể vừa bị server đóng (gặp trên CI sau khi
// stop/start container). Ghi không tự thử lại (không idempotent) -> status 0.
async function http(url, { method = 'GET', body, headers = {} } = {}, retry = method === 'GET') {
  try {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    if (retry) { await sleep(300); return http(url, { method, body, headers }, false); }
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
// biển số ngẫu nhiên: lần chạy trước hỏng giữa chừng để xe còn trong bãi thì lần sau không bị PLATE_ALREADY_INSIDE
const plate = () => `30A-${String(Math.random()).slice(2, 5)}.${String(Math.random()).slice(2, 4)}`;
const freeSlot = async (id) => (await node(id, '/api/slots/available')).body[0].slotCode;
const login = async (u) => (await until(`đăng nhập ${u}`, async () => (await agg('/api/auth/login', { method: 'POST', body: { username: u, password: process.env.DEMO_PASSWORD ?? '123456' } })).body?.token, 10_000));

// Dọn sau test (huỷ đặt chỗ, cho xe ra) để chạy lặp lại được nhiều lần.
const undo = [];
const cancelLater = (id, rid) => undo.push(() => node(id, `/api/reservations/${rid}`, { method: 'DELETE' }));
const exitLater = (id, slot) => undo.push(() => node(id, `/api/slots/${slot}/exit`, { method: 'POST', body: { cash: true } }));
test.after(async () => { for (const f of undo) await f(); });

let tok;
test.before(async () => {
  await until('3 bãi ONLINE', async () => (await Promise.all(['A', 'B', 'C'].map(statusOf))).every((s) => s === 'ONLINE'), 120_000);
  tok = { user1: await login('user1'), user2: await login('user2'), staffA: await login('staff-a'), admin: await login('admin') };
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

test('TC56 mandatory return từ RabbitMQ: bãi không tồn tại trả 404 nhanh', T, async () => {
  const admin = await login('admin');
  const started = performance.now();
  const r = await agg(`/api/admin/parkings/MISSING-${randomUUID()}/commands`, {
    method: 'POST', token: admin, body: { type: 'reserve', payload: { slotCode: 'UNKNOWN' } },
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'PARKING_NOT_FOUND');
  assert(performance.now() - started < 2500, 'mandatory return phải tới trước timeout publish 3s');
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
    method: 'POST', body: { requestId: `race-${randomUUID()}`, userId: `u${i}`, slotCode: slot, licensePlate: `29A-${String(i).padStart(5, '0')}` },
  })));
  results.filter((r) => r.status === 201).forEach((r) => cancelLater('C', r.body.id));
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, ...Array(19).fill(409)]);
});

test('10 lần gửi đồng thời CÙNG một Idempotency-Key: chỉ 1 reservation, mọi phản hồi cùng id', T, async () => {
  const slot = await freeSlot('C');
  const key = randomUUID();
  const rs = await Promise.all(Array.from({ length: 10 }, () => agg('/api/parkings/C/reservations', {
    method: 'POST', token: tok.user2, key, body: { slotCode: slot, licensePlate: '29A-999.99' },
  })));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201), rs.map((r) => r.status).join(','));
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  cancelLater('C', rs[0].body.id);
});

test('TC27 hai lần trả tiền song song khác key cho cùng một phiên (Postgres thật): đúng 1 thành công', T, async () => {
  const slot = await freeSlot('A');
  const enter = await node('A', `/api/slots/${slot}/enter`, { method: 'POST', body: { licensePlate: plate() } });
  const sid = enter.body.session.id;
  sql('db-a', `UPDATE parking_sessions SET entered_at = now() - interval '3 hours' WHERE id='${sid}'`);
  const pay = (k) => node('A', `/api/sessions/${sid}/pay`, { method: 'POST', body: { method: 'CASH', paymentKey: `staff:${k}-${sid}` } });
  const codes = (await Promise.all(Array.from({ length: 10 }, (_, i) => pay(`k${i}`)))).map((r) => r.status);
  assert.deepEqual([codes.filter((c) => c === 200).length, codes.filter((c) => c === 409).length], [1, 9]);
  assert.equal((await node('A', `/api/slots/${slot}/exit`, { method: 'POST', body: {} })).status, 200);   // đã trả: cho ra
});

test('TC06 + TC07 nhân viên cho xe vào/ra; sự kiện đi qua outbox -> RabbitMQ -> Aggregator -> Socket.IO', T, async () => {
  const { slotCode: slot, version: v0 } = (await node('A', '/api/slots/available')).body[0];
  const socket = io(AGG, { transports: ['websocket'] });
  const got = [];
  // chỉ đếm sự kiện mới hơn lúc bắt đầu: sự kiện của test trước trên cùng slot có thể đến muộn (giao nhận cuối cùng)
  socket.on('SLOT_UPDATED', (e) => e.slot === slot && e.version > v0 && got.push(e.status));
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

test('TC37 notification dừng: vẫn đặt chỗ được, bật lại nhận đúng thông báo tồn', T, async () => {
  // Payload NOTIFICATION chưa có reservationId: dùng slot riêng, không tái sử dụng,
  // để thông báo cũ của cùng user/bãi không thể làm test pass nhầm.
  const slot = `T37-${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`;
  const key = randomUUID();
  let slotCreated = false;
  let rid;
  let socket;
  const queueState = () => compose('exec -T rabbitmq rabbitmqctl -q list_queues name messages_ready consumers')
    .match(/^notification\.events\s+(\d+)\s+(\d+)\s*$/m);
  try {
    // Queue phải được khai báo/bind trước khi dừng consumer, kể cả trên môi trường mới.
    compose('start notification');
    await until('notification có consumer', () => Number(queueState()?.[2]) > 0, 20_000);
    compose('stop notification');
    await until('notification không còn consumer', () => queueState()?.[2] === '0', 10_000);

    const token = await login('user1');
    assert.ok(token, 'user1 đăng nhập thành công');
    const added = await node('A', '/api/slots', { method: 'POST', body: { slotCode: slot, floor: 1, type: 'CAR' } });
    slotCreated = added.status === 201;
    assert.equal(added.status, 201, 'tạo slot riêng cho TC37');
    const r = await agg('/api/parkings/A/reservations', {
      method: 'POST', token, key, body: { slotCode: slot, licensePlate: plate() },
    });
    rid = r.body?.id;
    // Tạo mới trả 201; 200 trong tài liệu là mô tả thành công / replay cùng key.
    assert.equal(r.status, 201, 'đặt chỗ vẫn thành công khi notification dừng');
    assert.ok(rid);
    assert.equal(r.body.slot_code, slot);
    assert.equal(r.body.status, 'ACTIVE');
    const userId = r.body.user_id;
    assert.ok(userId);
    assert.equal(r.body.request_id, `${userId}:${key}`, 'đúng request vừa tạo');
    assert.equal(userId, JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub, 'đúng user1');
    await until('sự kiện RESERVED của đúng reservation đã rời outbox', () => sql('db-a',
      `SELECT count(*) FROM parking_events WHERE event_type='RESERVED' AND payload->>'reservationId'='${rid}' AND published_at IS NOT NULL`) === '1', 20_000);
    await until('tin tồn trong notification.events khi không có consumer', () => {
      const q = queueState();
      return Number(q?.[1]) > 0 && q?.[2] === '0';
    }, 10_000);

    let received;
    socket = io(AGG, { transports: ['websocket'], auth: { token }, autoConnect: false });
    socket.on('NOTIFICATION', (n) => {
      if (n.to === userId && n.parkingId === 'A' && n.kind === 'ok'
          && n.text === `Đã giữ chỗ ${slot} (bãi A) cho bạn.`) received = n;
    });
    socket.connect();
    await until('socket user1 kết nối', () => socket.connected, 10_000);
    assert.equal(received, undefined, 'chưa gửi thông báo khi notification còn dừng');
    compose('start notification');
    await until('NOTIFICATION của đặt chỗ TC37 từ queue tồn', () => received, 30_000);
    assert.equal(received.to, userId);
  } finally {
    // Dọn độc lập: lỗi bật service / huỷ đặt chỗ không được ngăn đóng socket / gỡ slot.
    try {
      compose('start notification');
    } finally {
      socket?.close();
      try {
        if (rid) {
          const cancelled = await node('A', `/api/reservations/${rid}`, { method: 'DELETE' });
          assert.equal(cancelled.status, 200, 'huỷ đặt chỗ TC37');
        }
      } finally {
        if (slotCreated) {
          const hidden = await node('A', `/api/slots/${slot}`, { method: 'DELETE' });
          assert.equal(hidden.status, 200, 'gỡ slot TC37 qua API (giữ lịch sử)');
        }
      }
    }
  }
});

test('TC04 + TC05 tắt bãi B: A, C vẫn chạy, ghi B bị 503, chi tiết B trả dữ liệu cũ; bật lại thì ONLINE', T, async () => {
  compose('stop parking-b');
  try {
    await until('B OFFLINE', async () => (await statusOf('B')) === 'OFFLINE');
    const avail = await agg('/api/parkings/availability');
    assert.deepEqual(avail.body.map((p) => [p.parkingId, p.status]), [['A', 'ONLINE'], ['B', 'OFFLINE'], ['C', 'ONLINE']]);
    const r = await agg('/api/parkings/B/reservations', { method: 'POST', token: tok.user1, key: randomUUID(), body: { slotCode: 'B02', licensePlate: '30A-555.55' } });
    assert.deepEqual([r.status, r.body.error], [503, 'PARKING_OFFLINE']);
    const detail = await agg('/api/parkings/B');
    assert.equal(detail.body.stale, true);
    const ok = await agg('/api/parkings/A/reservations', { method: 'POST', token: tok.user1, key: randomUUID(), body: { slotCode: await freeSlot('A'), licensePlate: '30A-555.55' } });
    assert.equal(ok.status, 201);
    cancelLater('A', ok.body.id);
  } finally {
    compose('start parking-b');
  }
  await until('B ONLINE lại', async () => (await statusOf('B')) === 'ONLINE');
  assert.equal((await agg('/api/parkings/B')).body.stale, false);
});

test('DB bãi C khởi động lại: node C không sập, DB về thì tự kết nối lại và ghi được', T, async () => {
  compose('restart db-c');   // kết nối nhàn rỗi trong pool bị cắt -> trước đây làm sập cả tiến trình node
  await until('node C khoẻ lại', async () => (await node('C', '/health')).status === 200, 60_000);
  assert.match(compose('ps parking-c --format "{{.Status}}"'), /^Up/);
  const slot = await freeSlot('C');
  assert.equal((await node('C', `/api/slots/${slot}/enter`, { method: 'POST', body: {} })).status, 200);
  exitLater('C', slot);
});

test('TC10 Aggregator tắt: sự kiện nằm chờ trong queue RabbitMQ, bật lại thì được xử lý hết', T, async () => {
  compose('stop aggregator');
  try {
    const slot = await freeSlot('A');
    assert.equal((await node('A', `/api/slots/${slot}/enter`, { method: 'POST', body: {} })).status, 200);
    exitLater('A', slot);   // bãi vẫn chạy
    await until('tin vào queue', () => Number(compose('exec -T rabbitmq rabbitmqctl -q list_queues name messages').match(/aggregator\.slot-updates\.1\s+(\d+)/)?.[1]) > 0, 20_000);
  } finally {
    compose('start aggregator');
  }
  await until('queue rỗng', () => compose('exec -T rabbitmq rabbitmqctl -q list_queues name messages').match(/aggregator\.slot-updates\.1\s+(\d+)/)?.[1] === '0', 60_000);
  await until('3 bãi ONLINE', async () => (await Promise.all(['A', 'B', 'C'].map(statusOf))).every((s) => s === 'ONLINE'));
});

test('Broker tắt: sự kiện nằm trong outbox của bãi, broker bật lại thì relay gửi hết', T, async () => {
  compose('stop rabbitmq');
  try {
    const slot = await freeSlot('A');
    assert.equal((await node('A', `/api/slots/${slot}/enter`, { method: 'POST', body: {} })).status, 200);
    exitLater('A', slot);   // nghiệp vụ không bị chặn
    await sleep(1500);
    // 1 nút: tin nằm chờ trong outbox. Có cụm (--profile ha): relay chuyển sang rabbitmq-2/3 nên KHÔNG được ứ lại.
    const cluster = compose('ps -q rabbitmq-2') !== '';
    if (!cluster) assert.ok(Number(sql('db-a', 'SELECT count(*) FROM parking_events WHERE published_at IS NULL')) >= 1);
    else await until('outbox gửi hết qua nút khác khi rabbitmq còn tắt', () => sql('db-a', 'SELECT count(*) FROM parking_events WHERE published_at IS NULL') === '0', 30_000);
  } finally {
    compose('start rabbitmq');
  }
  await until('outbox gửi hết', () => sql('db-a', 'SELECT count(*) FROM parking_events WHERE published_at IS NULL') === '0', 90_000);
});

// PT-06 (TC47): chỉ chạy khi dựng kèm toxiproxy: CHAOS=1 node --test tests/e2e.test.mjs
// (docker compose -f docker-compose.yml -f docker-compose.chaos.yml --profile chaos up -d)
test('TC47 mạng chậm vượt timeout khi đặt chỗ: 504, thử lại cùng key -> đúng 1 lượt đặt', { ...T, skip: !process.env.CHAOS }, async () => {
  const net = (...a) => sh(`node scripts/net.mjs ${a.join(' ')}`);
  const slot = await freeSlot('B');
  const key = randomUUID();
  const lp = plate();
  const body = { slotCode: slot, licensePlate: lp };
  try {
    net('B', 'latency', 3500);
    const slow = await agg('/api/parkings/B/reservations', { method: 'POST', token: tok.user1, key, body });
    assert.equal(slow.status, 504);
  } finally {
    net('B', 'reset');
  }
  await sleep(4000);   // yêu cầu chậm vẫn tới bãi B và được xử lý
  const again = await agg('/api/parkings/B/reservations', { method: 'POST', token: tok.user1, key, body });
  assert.ok([200, 201].includes(again.status), String(again.status));
  assert.equal(sql('db-b', `SELECT count(*) FROM reservations WHERE license_plate='${lp.replace(/[^0-9A-Z]/g, '')}'`), '1');
  cancelLater('B', again.body.id);
});


test('TC43 HA: tắt Aggregator 1, 20 request qua Nginx vẫn trả 200',
  { ...T, skip: !process.env.HA },
  async () => {
    try {
      // Dừng Aggregator 1
      compose('stop aggregator');

      // Chờ Nginx chuyển request sang Aggregator 2
      await until('Nginx phục vụ qua Aggregator 2',
        async () => {
          const r = await http('http://localhost:3000/api/parkings');
          return r.status === 200;
        }, 20_000);

      // Gửi 20 request và kiểm tra từng response
      const statuses = [];

      for (let i = 0; i < 20; i++) {
        const r = await http('http://localhost:3000/api/parkings');
        statuses.push(r.status);

        assert.equal(r.status, 200,
          `Request ${i + 1}/20 trả ${r.status}, mong đợi 200`);
      }

      console.log('TC43 - HTTP statuses:', statuses);
      assert.equal(statuses.length, 20);

    } finally {
      // Luôn bật lại Aggregator 1
      compose('start aggregator');

      await until('Aggregator 1 phục hồi',
        async () => (await http(AGG + '/api/parkings')).status === 200,
        60_000);
    }
  }
);


test('TC44 HA: xe vào qua Aggregator 1, socket Aggregator 2 nhận SLOT_UPDATED',
  { ...T, skip: !process.env.HA },
  async () => {
    const AGG2 = 'http://localhost:8010';

    // Lấy slot trống và version hiện tại
    const available = await node('A', '/api/slots/available');
    assert.equal(available.status, 200);

    const { slotCode: slot, version: v0 } = available.body[0];

    // Socket kết nối trực tiếp Aggregator 2
    const socket = io(AGG2, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 10000
    });

    const events = [];
    let entered = false;

    try {
      socket.on('SLOT_UPDATED', (event) => {
        if (
          event.slot === slot &&
          event.version > v0
        ) {
          events.push(event);
        }
      });

      // Đảm bảo socket đã kết nối trước khi cho xe vào
      await until('Socket Aggregator 2 kết nối',
        () => socket.connected, 10_000);

      // Cho xe vào thông qua Aggregator 1
      const enter = await agg(
        `/api/parkings/A/slots/${slot}/enter`,
        {
          method: 'POST',
          token: tok.staffA,
          body: {}
        }
      );

      assert.equal(enter.status, 200);
      assert.equal(enter.body.status, 'OCCUPIED');
      entered = true;

      // Đợi Aggregator 2 nhận sự kiện
      await until('Aggregator 2 nhận SLOT_UPDATED',
        () => events.some(e => e.status === 'OCCUPIED'),
        15_000);

      console.log('TC44 - Aggregator 2 nhận:', events);

      assert.ok(
        events.some(e => e.status === 'OCCUPIED'),
        'Aggregator 2 không nhận được SLOT_UPDATED'
      );

    } finally {
      // Đóng socket để test không bị treo
      socket.close();

      // Trả slot về AVAILABLE nếu đã cho xe vào
      if (entered) {
        const exit = await node(
          'A',
          `/api/slots/${slot}/exit`,
          { method: 'POST', body: { cash: true } }
        );

        assert.equal(exit.status, 200);
      }
    }
  }
);


// PT-05 cần cặp khoá RS256 (node scripts/gen-keys.mjs); không có khoá thì node không tự kiểm được token -> 401.
test('TC46: Staff thao tác khi Aggregator sập', { ...T, skip: !process.env.JWT_PUBLIC_KEY_B64 }, async () => {
  let slot;

  const call = (action) => http(
    `${NODE.A}/api/slots/${slot}/${action}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.staffA}` },
      body: {}
    }
  );

  try {
    compose('stop aggregator aggregator-2');
    // Lấy slot SAU khi dừng: kết nối keep-alive tới node A để rỗi trong lúc dừng container đã bị server đóng,
    // POST không tự thử lại nên dùng lại kết nối đó sẽ ra status 0. GET mở lại kết nối mới ngay trước enter/exit.
    slot = await freeSlot('A');

    const enter = await call('enter');
    assert.equal(enter.status, 200);

    const exit = await call('exit');
    assert.equal(exit.status, 200);

    // Cho xe vào lần nữa và để xe trong bãi: bật lại Aggregator phải thấy OCCUPIED. Nếu để slot về AVAILABLE
    // thì trạng thái giống hệt lúc trước khi tắt, test qua cả khi Aggregator không cập nhật gì.
    const again = await call('enter');
    assert.equal(again.status, 200);
    exitLater('A', slot);

    console.log('TC46 - Enter:', enter.status, 'Exit:', exit.status, 'Enter lại:', again.status);
  } finally {
    compose('start aggregator aggregator-2');
  }

  await until('Aggregator thấy slot OCCUPIED giống node A', async () => {
    const r = await agg('/api/parkings/A');
    return r.status === 200 && r.body?.slots?.some((s) => s.slotCode === slot && s.status === 'OCCUPIED');
  });

  console.log('TC46 - PASS:', slot, 'OCCUPIED');
});

test('TC48 cụm RabbitMQ: tắt nút rabbitmq, chuyển nút < 10s, outbox về 0 và Aggregator nhận sự kiện',
  { ...T, skip: !process.env.HA },
  async () => {
    const socket = io(AGG, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000,
    });
    const events = [];
    let slot;

    try {
      socket.on('SLOT_UPDATED', (e) => events.push(e));
      await until('Socket Aggregator kết nối', () => socket.connected, 10_000);

      // Dùng compose('stop rabbitmq')
      compose('stop rabbitmq');

      slot = await freeSlot('A');
      const enter = await node('A', `/api/slots/${slot}/enter`, { method: 'POST', body: {} });
      assert.equal(enter.status, 200);
      exitLater('A', slot);

      // Kiểm tra trong vòng < 10 giây outbox của db-a về 0 (đã gửi qua nút 2 hoặc nút 3)
      await until(
        'outbox db-a về 0 trong < 10 giây',
        () => sql('db-a', 'SELECT count(*) FROM parking_events WHERE published_at IS NULL') === '0',
        10_000
      );

      // và Aggregator nhận được sự kiện
      await until(
        'Aggregator nhận được sự kiện SLOT_UPDATED',
        () => events.some((e) => e.parkingId === 'A' && e.slot === slot && e.status === 'OCCUPIED'),
        10_000
      );
    } finally {
      socket.close();
      compose('start rabbitmq');
      await until('rabbitmq phục hồi vào cụm', () => {
        try {
          return compose('exec -T rabbitmq rabbitmqctl cluster_status').includes('rabbit@rabbitmq-2');
        } catch {
          return false;
        }
      }, 30_000).catch(() => {});
    }
  }
);

test('TC49 cụm RabbitMQ: dừng cả rabbitmq và rabbitmq-2 (mất quorum), outbox giữ tin; bật lại thì xả về 0',
  { ...T, skip: !process.env.HA },
  async () => {
    let slot;
    try {
      // Dừng cả rabbitmq và rabbitmq-2 (mất quorum trên cụm 3 nút)
      compose('stop rabbitmq rabbitmq-2');

      // Cho xe vào bãi A
      slot = await freeSlot('A');
      const enter = await node('A', `/api/slots/${slot}/enter`, { method: 'POST', body: {} });
      assert.equal(enter.status, 200);
      exitLater('A', slot);

      // Đợi relay thử gửi nhưng không thể do mất quorum
      await sleep(2500);

      // Kiểm tra outbox giữ tin (> 0)
      const unsent = Number(sql('db-a', 'SELECT count(*) FROM parking_events WHERE published_at IS NULL'));
      assert.ok(unsent > 0, `Outbox phải giữ tin khi mất quorum (thực tế: ${unsent})`);

      // Sau đó bật lại 2 nút
      compose('start rabbitmq rabbitmq-2');

      // Xác nhận outbox xả về 0
      await until(
        'outbox db-a xả về 0 sau khi bật lại 2 nút',
        () => sql('db-a', 'SELECT count(*) FROM parking_events WHERE published_at IS NULL') === '0',
        60_000
      );
    } finally {
      // Khối finally phải luôn bật lại các nút đã dừng
      compose('start rabbitmq rabbitmq-2');
      await until('cụm rabbitmq phục hồi', () => {
        try {
          const s = compose('exec -T rabbitmq rabbitmqctl cluster_status');
          return s.includes('rabbit@rabbitmq-2') && s.includes('rabbit@rabbitmq-3');
        } catch {
          return false;
        }
      }, 45_000).catch(() => {});
    }
  }
);

// --- PD-09: Khám phá dịch vụ qua etcd (COORD=1 node --test tests/e2e.test.mjs) ---
test('TC63 etcd service discovery: khởi động bãi mới có đăng ký etcd -> tự động hiện trên API danh sách bãi trong <= 2s',
  { ...T, skip: !process.env.COORD },
  async () => {
    try {
      compose('--profile extra up -d db-d parking-d');
      await until('parking-d sẵn sàng', async () => {
        const r = await node('D', '/health');
        return r.status === 200;
      }, 30_000);
      const start = Date.now();
      await until('bãi D xuất hiện trong danh sách bãi của Aggregator <= 2s', async () => {
        const r = await agg('/api/parkings');
        const d = r.body?.find((p) => p.parkingId === 'D');
        return d && d.status === 'ONLINE';
      }, 5000);
      const elapsed = Date.now() - start;
      console.log(`TC63 - Bãi D xuất hiện và ONLINE sau ${elapsed}ms`);
      assert.ok(elapsed <= 2000, `Bãi mới phải hiện trong danh sách bãi kịp thời <= 2s (thực tế: ${elapsed}ms)`);
    } finally {
      compose('--profile extra stop parking-d db-d');
    }
  }
);

test('TC64 phân hoạch mạng node <-> etcd: mất lease nhưng HTTP còn sống -> trạng thái chuyển DEGRADED',
  { ...T, skip: !process.env.COORD },
  async () => {
    try {
      process.env.ENABLE_TEST_FAULTS = '1';
      compose('--profile extra up -d db-d parking-d');
      await until('bãi D ONLINE', async () => {
        const r = await agg('/api/parkings');
        return r.body?.find((p) => p.parkingId === 'D')?.status === 'ONLINE';
      }, 10_000);

      // Giả lập bãi D mất kết nối tới etcd trong 8 giây (lease TTL 5s sẽ hết hạn trên etcd)
      const part = await node('D', '/api/test/fault/etcd-partition', {
        method: 'POST',
        body: { ms: 8000 },
      });
      assert.equal(part.status, 200);

      // Node D HTTP vẫn sống
      const h = await node('D', '/health');
      assert.equal(h.status, 200);

      // Chờ lease 5s hết hạn trên etcd -> Aggregator nhận DELETE event -> chuyển sang DEGRADED
      await until('bãi D chuyển sang DEGRADED khi mất lease', async () => {
        const r = await agg('/api/parkings');
        const d = r.body?.find((p) => p.parkingId === 'D');
        return d && d.status === 'DEGRADED';
      }, 15_000);

      console.log('TC64 - PASS: Bãi D chuyển sang DEGRADED khi mất lease etcd nhưng HTTP vẫn sống');

      // Sau 8 giây partition kết thúc, bãi D đăng ký lại lease -> phục hồi ONLINE
      await until('bãi D phục hồi ONLINE sau khi có lại lease', async () => {
        const r = await agg('/api/parkings');
        const d = r.body?.find((p) => p.parkingId === 'D');
        return d && d.status === 'ONLINE';
      }, 15_000);

      console.log('TC64 - PASS: Bãi D tự động phục hồi ONLINE');
    } finally {
      delete process.env.ENABLE_TEST_FAULTS;
      compose('--profile extra stop parking-d db-d');
    }
  }
);

// --- PD-11: Cấu hình động qua etcd watch (COORD=1 node --test tests/e2e.test.mjs) ---
test('TC67 cấu hình động qua etcd watch: đổi timeoutMs thành 500ms -> Aggregator nhận ngay không cần restart',
  { ...T, skip: !process.env.COORD },
  async () => {
    const etcdPut = (k, v) => compose(`exec -T etcd-1 etcdctl put "${k}" "${v}"`);
    const adminToken = tok?.admin ?? await login('admin');

    try {
      // 1. Cập nhật cấu hình timeoutMs trên etcd thành 500
      etcdPut('/nhom16/config/aggregator/timeoutMs', '500');

      // 2. Chờ Aggregator nhận cấu hình mới qua watch trong <= 2s mà không cần restart container
      await until('Aggregator nhận timeoutMs = 500', async () => {
        const r = await agg('/api/config/timeoutMs', { token: adminToken });
        return r.status === 200 && r.body?.value === 500;
      }, 5000);

      // 3. Kiểm tra log của Aggregator có chứa sự kiện cập nhật cấu hình kèm revision
      const logs = compose('logs --tail 50 aggregator');
      assert.match(logs, /\[etcd-config\] Cập nhật \/nhom16\/config\/aggregator\/timeoutMs|timeoutMs.*500/);
      assert.match(logs, /revision/);

      console.log('TC67 - PASS: Aggregator cập nhật timeoutMs = 500ms qua etcd watch tức thì và ghi log kèm revision');
    } finally {
      // Khôi phục giá trị mặc định 2000
      try {
        etcdPut('/nhom16/config/aggregator/timeoutMs', '2000');
        await until('Aggregator khôi phục timeoutMs = 2000', async () => {
          const r = await agg('/api/config/timeoutMs', { token: adminToken });
          return r.status === 200 && r.body?.value === 2000;
        }, 5000);
      } catch { /* bỏ qua */ }
    }
  }
);


