const test = require('node:test');
const assert = require('node:assert/strict');
const { startNode, startAggregator } = require('./helpers');

test('tra cứu theo vùng gộp một lần liên vùng và giữ bãi lỗi', async (t) => {
  const a = await startNode('A', 2);
  const d = await startNode('D', 1);
  const nodes = {
    A: { url: a.url, zone: 'bac' },
    D: { url: d.url, zone: 'nam' },
    E: { url: 'http://127.0.0.1:1', zone: 'nam' },
  };
  const nam = await startAggregator(nodes, { zone: 'nam' });
  const bac = await startAggregator(nodes, { zone: 'bac', peerUrl: `http://127.0.0.1:${nam.server.address().port}` });
  t.after(() => { a.server.close(); d.server.close(); nam.server.close(); bac.server.close(); });
  for (const agg of [bac, nam]) for (const node of agg.reg.all()) node.status = node.id === 'E' ? 'OFFLINE' : 'ONLINE';

  const scoped = await nam.call('/api/parkings/availability?scope=zone');
  assert.deepEqual(scoped.body.parkings.map((p) => p.parkingId), ['D', 'E']);
  assert.deepEqual(scoped.body.failed, ['E']);

  const result = await bac.call('/api/parkings/availability');
  assert.deepEqual(result.body.map((p) => [p.parkingId, p.status]), [['A', 'ONLINE'], ['D', 'ONLINE'], ['E', 'OFFLINE']]);
  const search = await bac.call('/api/parkings/search?type=CAR&available=true');
  assert.deepEqual(search.body.map((p) => p.parkingId), ['A', 'D']);
  const metrics = await (await fetch(`http://127.0.0.1:${bac.server.address().port}/metrics`)).text();
  assert.match(metrics, /cross_zone_requests_total\{[^}]*\} 2/);
});

test('vùng kia không phản hồi thì đánh dấu các bãi vùng đó OFFLINE', async (t) => {
  const a = await startNode('A', 1);
  const agg = await startAggregator({ A: { url: a.url, zone: 'bac' }, D: { url: a.url, zone: 'nam' } },
    { peerUrl: 'http://127.0.0.1:1' });
  t.after(() => { a.server.close(); agg.server.close(); });
  for (const node of agg.reg.all()) node.status = 'ONLINE';
  const result = await agg.call('/api/parkings/availability');
  assert.deepEqual(result.body.map((p) => [p.parkingId, p.status]), [['A', 'ONLINE'], ['D', 'OFFLINE']]);
});
