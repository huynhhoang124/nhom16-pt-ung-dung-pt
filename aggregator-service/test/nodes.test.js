const test = require('node:test');
const assert = require('node:assert/strict');
const { startNode, startStub, startFlaky, startAggregator } = require('./helpers');
const http = require('node:http');
const { makeRegistry } = require('../src/nodes');

test('health check: OFFLINE chỉ sau 3 lần lỗi liên tiếp; sống lại thì ONLINE ngay, báo onChange', async (t) => {
  const stub = await startStub(0);
  const agg = await startAggregator({ X: stub.url }, { timeoutMs: 200 });
  t.after(() => { stub.server.close(); agg.server.close(); });
  const changes = [];
  const onChange = (n, prev) => changes.push(`${prev}->${n.status}`);
  const n = agg.reg.get('X');

  assert.equal(n.status, 'OFFLINE');                 // mới thêm: chưa biết, coi như OFFLINE
  await agg.reg.check(onChange);
  assert.equal(n.status, 'ONLINE');

  stub.setDelay(Infinity);                           // bãi treo
  await agg.reg.check(onChange);
  await agg.reg.check(onChange);
  assert.equal(n.status, 'ONLINE');                  // 2 lần lỗi: chưa kết luận (có thể chỉ chậm)
  await agg.reg.check(onChange);
  assert.equal(n.status, 'OFFLINE');

  stub.setDelay(0);
  await agg.reg.check(onChange);
  assert.equal(n.status, 'ONLINE');
  assert.deepEqual(changes, ['OFFLINE->ONLINE', 'ONLINE->OFFLINE', 'OFFLINE->ONLINE']);
});

test('TC01/TC04 tra cứu song song: bãi chậm bị bỏ qua, vẫn trả kết quả các bãi còn lại kịp thời', async (t) => {
  const a = await startNode('A', 4);
  const b = await startNode('B', 2);
  const slow = await startStub(5000);
  const agg = await startAggregator({ A: a.url, B: b.url, C: slow.url }, { timeoutMs: 300 });
  t.after(() => { a.server.close(); b.server.close(); slow.server.close(); agg.server.close(); });
  for (const n of agg.reg.all()) n.status = 'ONLINE';   // giả sử health check trước đó đều ổn

  const started = performance.now();
  const r = await agg.call('/api/parkings/availability');
  const ms = performance.now() - started;
  assert.deepEqual(r.body, [
    { parkingId: 'A', status: 'ONLINE', available: 4, total: 4, byType: { CAR: { available: 4, total: 4 } } },
    { parkingId: 'B', status: 'ONLINE', available: 2, total: 2, byType: { CAR: { available: 2, total: 2 } } },
    { parkingId: 'C', status: 'OFFLINE' },
  ]);
  assert.ok(ms < 1500, `phải trả trong khoảng timeout, mất ${ms.toFixed(0)}ms`);

  const search = await agg.call('/api/parkings/search?available=true');
  assert.deepEqual(search.body.map((p) => p.parkingId), ['A', 'B']);
  // TC16 (Aggregator): bãi chỉ có ô tô -> lọc xe máy không còn bãi nào; type lạ -> 400
  assert.deepEqual((await agg.call('/api/parkings/search?available=true&type=MOTO')).body, []);
  assert.equal((await agg.call('/api/parkings/search?type=BUS')).status, 400);
});

// ---- PT-04: circuit breaker + retry ----
async function flakySystem(t, failures) {
  const x = await startFlaky(failures);
  const agg = await startAggregator({ X: x.url }, { timeoutMs: 1000, reserveTimeoutMs: 1000 });
  t.after(() => { x.server.close(); agg.server.close(); });
  const n = agg.reg.get('X');
  n.status = 'ONLINE'; n.fails = 0;
  return { x, agg, n };
}

test('TC40 mạch mở: lỗi liên tiếp đủ ngưỡng thì OFFLINE ngay, request sau bị từ chối tức thì; health check đóng mạch', async (t) => {
  const { x, agg, n } = await flakySystem(t, Infinity);
  const changes = [];
  agg.reg.onChange = (node, prev) => changes.push(`${prev}->${node.status}`);
  await assert.rejects(agg.reg.json(n, '/api/slots'));     // 2 lần thử (GET có retry)
  assert.equal(n.status, 'ONLINE');
  await assert.rejects(agg.reg.json(n, '/api/slots'));     // lần lỗi thứ 3 -> mở mạch, không retry nữa
  assert.equal(n.status, 'OFFLINE');
  assert.equal(x.state.hits, 3);
  assert.deepEqual(changes, ['ONLINE->OFFLINE']);

  const token = await agg.login('user1');
  const started = performance.now();
  const r = await agg.call('/api/parkings/X/reservations', { method: 'POST', token, key: 'k1', body: { slotCode: 'X01', licensePlate: '30A-111.11' } });
  assert.equal(r.status, 503);
  assert.ok(performance.now() - started < 50, 'mạch mở: từ chối ngay, không gọi node');
  assert.equal(x.state.hits, 3);

  await agg.reg.check();                                   // /health của node giả vẫn UP -> nửa mở thành công
  assert.equal(n.status, 'ONLINE');
  assert.deepEqual(changes, ['ONLINE->OFFLINE', 'OFFLINE->ONLINE']);
});

test('TC41 retry 1 lần cứu được lỗi thoáng qua: GET và đặt chỗ (có Idempotency-Key)', async (t) => {
  const { x, agg, n } = await flakySystem(t, 1);
  assert.deepEqual(await agg.reg.json(n, '/api/slots'), { ok: true });
  assert.equal(x.state.hits, 2);
  assert.equal(n.fails, 0);                                // thành công thì xoá đếm lỗi

  x.state.failures = 1;
  const token = await agg.login('user1');
  const r = await agg.call('/api/parkings/X/reservations', { method: 'POST', token, key: 'k1', body: { slotCode: 'X01', licensePlate: '30A-111.11' } });
  assert.equal(r.status, 201);
  assert.equal(x.state.hits, 4);
});

test('TC42 xe vào/ra không idempotent: lỗi thì KHÔNG retry, trả nguyên lỗi của node', async (t) => {
  const { x, agg } = await flakySystem(t, Infinity);
  const token = await agg.login('admin');
  const r = await agg.call('/api/parkings/X/slots/X01/enter', { method: 'POST', token, body: {} });
  assert.equal(r.status, 500);
  assert.equal(x.state.hits, 1);
});

test('GS-04 /metrics của Aggregator: trạng thái và số lần lỗi từng bãi', async (t) => {
  const { x, agg, n } = await flakySystem(t, 0);
  n.fails = 2;
  const metrics = require('../src/metrics');
  metrics.observeCommand({ type: 'reserve', parking_id: 'X', status: 'DONE', created_at: new Date(Date.now() - 200) });
  metrics.incCmdDead();
  const url = `http://127.0.0.1:${agg.server.address().port}/metrics`;
  const text = await (await fetch(url)).text();
  // PD-25: số đo kênh lệnh
  assert.match(text, /command_duration_seconds_count\{aggregator="aggregator-1",type="reserve",parking_id="X",status="DONE"\} \d+/);
  assert.match(text, /cmd_dead_total\{aggregator="aggregator-1"\} [1-9]/);
  assert.match(text, /cmd_oldest_age_seconds\{aggregator="aggregator-1"\} 0/);
  assert.match(text, /aggregator_is_leader/);
  assert.match(text, /parking_node_up\{node="X",aggregator="aggregator-1"\} 1/);
  assert.match(text, /parking_node_fails\{node="X",aggregator="aggregator-1"\} 2/);
  assert.ok(x);
});

test('PT-01 X-Instance và nạp bãi do bản Aggregator khác thêm (dùng chung DB)', async (t) => {
  const { agg } = await flakySystem(t, 0);
  const r = await fetch(`http://127.0.0.1:${agg.server.address().port}/api/parkings`);
  assert.equal(r.headers.get('x-instance'), 'aggregator-1');
  assert.deepEqual(agg.reg.sync([{ parking_id: 'X', name: 'X', api_url: 'http://x' }, { parking_id: 'Z', name: 'Z', api_url: 'http://z' }]), ['Z']);
  assert.equal(agg.reg.get('Z').status, 'OFFLINE');   // bãi mới: chờ health check
});

test('resolveUrl: tên -> IP; IP giữ nguyên; DNS lỗi thì giữ tên', async () => {
  const dns = require('node:dns');
  const { resolveUrl } = require('../src/nodes');

  const originalLookup = dns.promises.lookup;

  try {
    dns.promises.lookup = async (hostname) => {
      if (hostname === 'localhost') {
        return { address: '127.0.0.1', family: 4 };
      }
      throw new Error('DNS lookup failed');
    };

    assert.equal(
      await resolveUrl('http://localhost:8001'),
      'http://127.0.0.1:8001',
    );

    assert.equal(
      await resolveUrl('http://10.0.0.5:8002'),
      'http://10.0.0.5:8002',
    );

    assert.equal(
      await resolveUrl('http://khong-ton-tai.invalid:8003'),
      'http://khong-ton-tai.invalid:8003',
    );
  } finally {
    dns.promises.lookup = originalLookup;
  }
});

test('PD-20 hedged GET: gọi replica thứ hai sau 120ms và hủy request chậm', async (t) => {
  let firstAborted = false;
  let secondHits = 0;
  let resolveFirstClosed;

  const firstClosed = new Promise((resolve) => {
    resolveFirstClosed = resolve;
  });

  const firstServer = http.createServer((req, res) => {
    res.on('close', () => {
      if (!res.writableEnded) {
        firstAborted = true;
        resolveFirstClosed();
      }
    });

    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ replica: 1 }));
      }
    }, 1000);
  });

  const secondServer = http.createServer((req, res) => {
    secondHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ replica: 2 }));
  });

  await Promise.all([
    new Promise((resolve) => firstServer.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => secondServer.listen(0, '127.0.0.1', resolve)),
  ]);

  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => firstServer.close(resolve)),
      new Promise((resolve) => secondServer.close(resolve)),
    ]);
  });

  const reg = makeRegistry({ internalKey: 'dev', timeoutMs: 2000 });

  const n = reg.add({
    parking_id: 'A',
    name: 'Bãi A',
    api_url: `http://127.0.0.1:${firstServer.address().port}`,
  });

  n.replicas = new Map([
    ['replica-1', {
      url: `http://127.0.0.1:${firstServer.address().port}`,
    }],
    ['replica-2', {
      url: `http://127.0.0.1:${secondServer.address().port}`,
    }],
  ]);

  const started = performance.now();
  const response = await reg.hedgedGet(n, '/api/slots');
  const elapsed = performance.now() - started;

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { replica: 2 });

  assert.ok(elapsed >= 100, `Request dự phòng không được gửi quá sớm: ${elapsed}ms`);
  assert.ok(elapsed < 1000, `Phải nhận kết quả từ replica thứ hai sớm: ${elapsed}ms`);

  assert.equal(secondHits, 1, 'Replica thứ hai phải được gọi đúng một lần');
  await Promise.race([
    firstClosed,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);

  assert.equal(firstAborted, true, 'Request đến replica đầu tiên phải bị hủy');
});

test('PD-17 HLC truyền từ Aggregator sang Parking Node qua HTTP', async (t) => {
  // Dựng Parking Node thật với database PGlite.
  const node = await startNode('D', 3);

  // Dựng Aggregator thật, kết nối đến Parking Node qua HTTP.
  const agg = await startAggregator({ D: node.url });

  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => node.server.close(resolve)),
      new Promise((resolve) => agg.server.close(resolve)),
      node.pool.end(),
      agg.pool.end(),
    ]);
  });

  const target = agg.reg.get('D');
  target.status = 'ONLINE';

  // Giả lập HLC của event CAR_EXIT mà Aggregator đã quan sát.
  // Dùng thời điểm tương lai để chứng minh D thực sự nhận HLC cha.
  const parentHlc =
    `${String(Date.now() + 60_000).padStart(13, '0')}-0000`;

  const { applyEvent } = require('../src/events');

  applyEvent(agg.cache, {
    parkingId: 'A',
    slot: 'A01',
    status: 'AVAILABLE',
    version: 1,
    hlc: parentHlc,
  });

  // Gửi xe vào D qua API Aggregator, không gọi trực tiếp Parking Node.
  const token = await agg.login('admin');

  const result = await agg.call(
    '/api/parkings/D/slots/D01/enter',
    {
      method: 'POST',
      token,
      body: { licensePlate: '30A-123.45' },
    },
  );

  assert.equal(result.status, 200, JSON.stringify(result.body));

  const sessionHlc = result.body.session.hlc;

  assert.ok(sessionHlc, 'Session phải có HLC');

  const { compareHlc } = require('../src/hlc');

  assert.ok(
    compareHlc(sessionHlc, parentHlc) > 0,
    `HLC của session D phải lớn hơn HLC cha: ${sessionHlc} <= ${parentHlc}`,
  );

  // Kiểm tra HLC thực sự được ghi vào parking_events.
  const event = await node.pool.query(
    `SELECT hlc
     FROM parking_events
     WHERE event_type = 'CAR_ENTER' AND slot_code = 'D01'
     ORDER BY id DESC
     LIMIT 1`,
  );

  assert.equal(
    event.rows[0]?.hlc,
    sessionHlc,
    'HLC của CAR_ENTER phải trùng với HLC đã lưu trong session',
  );
});

test('PD-20 hedged GET: vượt tỷ lệ request bổ sung 5% thì tạm ngừng Hedging', async (t) => {
  const servers = [];
  let delayFirstReplica = false;
  let secondHits = 0;

  const firstServer = http.createServer((req, res) => {
    const delay = delayFirstReplica ? 1000 : 0;

    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ replica: 1 }));
      }
    }, delay);
  });

  const secondServer = http.createServer((req, res) => {
    secondHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ replica: 2 }));
  });

  await Promise.all([
    new Promise((resolve) => firstServer.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => secondServer.listen(0, '127.0.0.1', resolve)),
  ]);

  servers.push(firstServer, secondServer);

  t.after(async () => {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  const url1 = `http://127.0.0.1:${firstServer.address().port}`;
  const url2 = `http://127.0.0.1:${secondServer.address().port}`;

  const reg = makeRegistry({
    internalKey: 'dev',
    timeoutMs: 2000,
    hedgeWindowMs: 60_000,
    hedgeDisableMs: 60_000,
  });

  const n = reg.add({
    parking_id: 'A',
    name: 'Bãi A',
    api_url: url1,
  });

  n.replicas = new Map([
    ['replica-1', { url: url1 }],
    ['replica-2', { url: url2 }],
  ]);

  // Tạo 17 GET request thông thường.
  for (let i = 0; i < 17; i++) {
    await reg.call(n, '/api/slots', {
      method: 'GET',
      retry: false,
    });
  }

  delayFirstReplica = true;

  // Request hedged tạo thêm một request đến replica thứ hai.
  const originalNow = Date.now;
  const response = await reg.hedgedGet(n, '/api/slots');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { replica: 2 });
  assert.equal(secondHits, 1);

  let stats = reg.getHedgeStats();

  assert.equal(stats.totalGetRequests, 18);
  assert.equal(stats.additionalRequests, 1);
  assert.ok(stats.additionalRatio > 0.05);
  assert.equal(stats.hedgingDisabled, true);

  // During cooldown, use the known fast replica without launching a second request.
  const preferred = await reg.hedgedGet(n, '/api/slots');
  assert.deepEqual(await preferred.json(), { replica: 2 });

  stats = reg.getHedgeStats();

  assert.equal(secondHits, 2);
  assert.equal(stats.additionalRequests, 1);
  assert.equal(stats.hedgingDisabled, true);

  // Giả lập thời gian đã trôi qua 60 giây.
  try {
    Date.now = () => originalNow() + 60_001;

    stats = reg.getHedgeStats();

    assert.equal(stats.hedgingDisabled, false);
  } finally {
    Date.now = originalNow;
  }
});

test('PD-20 hedged GET: chặn các hedge đang chờ khi tỷ lệ vượt 5%', async (t) => {
  const servers = [];
  let delayFirstReplica = false;
  let secondHits = 0;

  const firstServer = http.createServer((req, res) => {
    const delay = delayFirstReplica ? 1000 : 0;

    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ replica: 1 }));
      }
    }, delay);
  });

  const secondServer = http.createServer((req, res) => {
    secondHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ replica: 2 }));
  });

  await Promise.all([
    new Promise((resolve) => firstServer.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => secondServer.listen(0, '127.0.0.1', resolve)),
  ]);

  servers.push(firstServer, secondServer);

  t.after(async () => {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  const url1 = `http://127.0.0.1:${firstServer.address().port}`;
  const url2 = `http://127.0.0.1:${secondServer.address().port}`;

  const reg = makeRegistry({
    internalKey: 'dev',
    timeoutMs: 2000,
    hedgeWindowMs: 60_000,
    hedgeDisableMs: 60_000,
  });

  const n = reg.add({
    parking_id: 'A',
    name: 'Bãi A',
    api_url: url1,
  });

  n.replicas = new Map([
    ['replica-1', { url: url1 }],
    ['replica-2', { url: url2 }],
  ]);

  // Tạo 15 GET request thông thường.
  for (let i = 0; i < 15; i++) {
    await reg.call(n, '/api/slots', {
      method: 'GET',
      retry: false,
    });
  }

  delayFirstReplica = true;

  // Khởi chạy 3 request hedging gần như đồng thời.
  const responses = await Promise.all([
    reg.hedgedGet(n, '/api/slots'),
    reg.hedgedGet(n, '/api/slots'),
    reg.hedgedGet(n, '/api/slots'),
  ]);

  const bodies = await Promise.all(responses.map((r) => r.json()));

  assert.equal(responses.length, 3);
  assert.equal(secondHits, 1, 'Chỉ hedge đầu tiên vượt ngưỡng được gửi');
  assert.equal(
    bodies.filter((body) => body.replica === 2).length,
    1,
    'Chỉ một request nhận kết quả từ replica thứ hai',
  );

  const stats = reg.getHedgeStats();

  assert.equal(stats.additionalRequests, 1);
  assert.ok(stats.additionalRatio > 0.05);
  assert.equal(stats.hedgingDisabled, true);
});
test('PD-20 rejects a fast 503 and uses the healthy replica', async t => {
  const failed = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
  const healthy = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  for (const server of [failed, healthy]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { failed.close(); healthy.close(); });
  const url = server => `http://127.0.0.1:${server.address().port}`;
  const reg = makeRegistry({ internalKey: 'dev' });
  const node = reg.add({ parking_id: 'A', api_url: url(failed) });
  node.replicas = new Map([['primary', { url: url(failed) }], ['secondary', { url: url(healthy) }]]);
  assert.deepEqual(await (await reg.hedgedGet(node, '/api/slots')).json(), { ok: true });
});
