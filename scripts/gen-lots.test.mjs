import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProxyConfig, makeScaleCompose } from './gen-lots.mjs';

test('PD-12 sinh đúng ba bãi Nam với DB, node, zone và lease etcd riêng', () => {
  const { services, volumes } = makeScaleCompose();
  for (const [id, port, slots] of [
    ['D', 8004, 'CAR:1:10,CAR:2:10'],
    ['E', 8005, 'CAR:1:10,MOTO:1:10'],
    ['F', 8006, 'CAR:1:10,MOTO:1:10'],
  ]) {
    const key = id.toLowerCase();
    const parking = services[`parking-${key}`];
    assert.ok(services[`db-${key}`]);
    assert.equal(parking.environment.PARKING_ID, id);
    assert.equal(parking.environment.PORT, port);
    assert.equal(parking.environment.ZONE, 'nam');
    assert.equal(parking.environment.SLOTS, slots);
    assert.match(parking.environment.ETCD_ENDPOINTS, /etcd-3:2379/);
    assert.equal(volumes[`db-${key}-data`] !== undefined, true);
  }
  assert.equal(services.aggregator.environment.ZONE, 'bac');
  assert.equal(services['parking-a'].environment.ZONE, 'bac');
  assert.deepEqual(
    ['aggregator-bac-1', 'aggregator-bac-2', 'aggregator-nam-1', 'aggregator-nam-2']
      .map((name) => services[name].environment.ZONE),
    ['bac', 'bac', 'nam', 'nam'],
  );
  assert.equal(services['aggregator-bac-1'].environment.REGION_AGGREGATOR_URL, 'http://aggregator-nam:8000');
  assert.equal(services['aggregator-nam-1'].environment.REGION_AGGREGATOR_URL, 'http://aggregator-bac:8000');
  assert.deepEqual(services['aggregator-bac-1'].networks.default.aliases, ['aggregator', 'aggregator-bac']);
  assert.deepEqual(services['frontend-regional'].depends_on, [
    'aggregator-bac-1', 'aggregator-bac-2', 'aggregator-nam-1', 'aggregator-nam-2',
  ]);
  assert.deepEqual(services.aggregator.profiles, ['legacy']);
  assert.deepEqual(services.frontend.profiles, ['legacy']);
  for (const id of ['a', 'b', 'c', 'agg', 'd', 'e', 'f']) {
    assert.equal(services[`db-${id}`].mem_limit, '192m');
    assert.deepEqual(services[`db-${id}`].command, ['postgres', '-c', 'shared_buffers=32MB']);
  }
});

test('PD-12 proxy tạo một tuyến liên vùng cho mỗi bãi D-F', () => {
  assert.deepEqual(makeProxyConfig(), [
    { name: 'parking-d', listen: '0.0.0.0:18004', upstream: 'parking-d:8004', enabled: true },
    { name: 'parking-e', listen: '0.0.0.0:18005', upstream: 'parking-e:8005', enabled: true },
    { name: 'parking-f', listen: '0.0.0.0:18006', upstream: 'parking-f:8006', enabled: true },
  ]);
});
