const test = require('node:test');
const assert = require('node:assert/strict');
const { startNode, startStub, startAggregator } = require('./helpers');

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
