const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startAggregator } = require('./helpers');

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('PD-19 availability/search call local nodes and exactly one regional peer; zone scope does not recurse', async (t) => {
  const localHits = { A: 0, D: 0 };
  const parkingNode = (id) => listen((req, res) => {
    if (req.url === '/health') return sendJson(res, 200, { status: 'UP' });
    if (req.url === '/api/availability') {
      localHits[id]++;
      return sendJson(res, 200, {
        available: 1,
        total: 2,
        byType: { CAR: { available: 1, total: 2 } },
      });
    }
    sendJson(res, 404, {});
  });
  const a = await parkingNode('A');
  const d = await parkingNode('D');
  let peerHits = 0;
  let peerFails = false;
  const peer = await listen((req, res) => {
    peerHits++;
    if (req.url !== '/api/parkings/availability?scope=zone') {
      return sendJson(res, 400, { error: 'unexpected peer route' });
    }
    if (peerFails) return sendJson(res, 503, { error: 'peer unavailable' });
    sendJson(res, 200, {
      results: [{
        parkingId: 'D',
        status: 'ONLINE',
        available: 2,
        total: 4,
        byType: { CAR: { available: 2, total: 4 } },
      }],
      unavailable: [],
    });
  });
  const agg = await startAggregator({
    A: { url: a.url, zone: 'bac' },
    D: { url: d.url, zone: 'nam' },
  }, { zone: 'bac', regionAggregatorUrl: peer.url });
  t.after(() => {
    a.server.close();
    d.server.close();
    peer.server.close();
    agg.server.close();
  });
  for (const node of agg.reg.all()) node.status = 'ONLINE';

  const availability = await agg.call('/api/parkings/availability');
  assert.deepEqual(availability.body.map((node) => node.parkingId), ['A', 'D']);
  assert.deepEqual([localHits.A, localHits.D, peerHits], [1, 0, 1]);

  const search = await agg.call('/api/parkings/search?type=CAR&available=true');
  assert.deepEqual(search.body.map((node) => [node.parkingId, node.available]), [['A', 1], ['D', 2]]);
  assert.deepEqual([localHits.A, localHits.D, peerHits], [2, 0, 2]);

  const scoped = await agg.call('/api/parkings/availability?scope=zone');
  assert.deepEqual(scoped.body.results.map((node) => node.parkingId), ['A']);
  assert.deepEqual(scoped.body.unavailable, []);
  assert.deepEqual([localHits.A, localHits.D, peerHits], [3, 0, 2]);

  const scopedSearch = await agg.call('/api/parkings/search?scope=zone&type=CAR');
  assert.deepEqual(scopedSearch.body.results.map((node) => node.parkingId), ['A']);
  assert.deepEqual(scopedSearch.body.unavailable, []);
  assert.deepEqual([localHits.A, localHits.D, peerHits], [4, 0, 2]);

  peerFails = true;
  const partial = await agg.call('/api/parkings/availability');
  assert.deepEqual(partial.body.map((node) => [node.parkingId, node.status]), [['A', 'ONLINE'], ['D', 'OFFLINE']]);
  assert.deepEqual([localHits.A, localHits.D, peerHits], [5, 0, 3]);

  const metrics = await fetch(`${agg.url}/metrics`).then((res) => res.text());
  assert.match(metrics, /regional_scatter_requests_total\{source_zone="bac",target_zone="nam"[^}]*\} 3/);
});
