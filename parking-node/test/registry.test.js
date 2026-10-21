const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRegistryClient } = require('../src/registry');

test('PD-09 registry: khi không có ETCD_ENDPOINTS thì inactive, không lỗi', async () => {
  const reg = makeRegistryClient({ etcdEndpoints: '' });
  assert.equal(reg.active, false);
  await reg.register();
  await reg.stop();
  await reg.simulatePartition();
});

test('PD-09 registry: cấu hình key và payload đúng định dạng', () => {
  const reg = makeRegistryClient({
    etcdEndpoints: 'http://localhost:2379',
    parkingId: 'TEST',
    hostname: 'host-1',
    url: 'http://host-1:8001',
    zone: 'bac',
    leaseTtlS: 5,
  });

  assert.equal(reg.active, true);
  assert.equal(reg.key, '/nhom16/parking/nodes/TEST/host-1');
  const payload = JSON.parse(reg.payload);
  assert.equal(payload.url, 'http://host-1:8001');
  assert.equal(payload.zone, 'bac');
  assert.equal(payload.parkingId, 'TEST');
  assert.equal(payload.hostname, 'host-1');
  assert.ok(payload.registeredAt);
  reg.client.close();
});
