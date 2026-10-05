const test = require('node:test');
const assert = require('node:assert/strict');
const { startNode, startStub, startFlaky, startAggregator } = require('./helpers');

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
  const url = `http://127.0.0.1:${agg.server.address().port}/metrics`;
  const text = await (await fetch(url)).text();
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
