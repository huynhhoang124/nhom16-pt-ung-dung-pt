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

test('PD-09 fault injection endpoint: mặc định tắt (403), chỉ bật khi ENABLE_TEST_FAULTS=1', async () => {
  const http = require('node:http');
  const { makeApp } = require('../src/app');

  let simulated = false;
  const mockReg = {
    simulatePartition: async () => { simulated = true; }
  };
  const app = makeApp({
    pool: {}, readPool: {}, parkingId: 'TEST', internalKey: 'dev',
    regClient: mockReg,
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const prevEnv = process.env.ENABLE_TEST_FAULTS;
  try {
    delete process.env.ENABLE_TEST_FAULTS;
    const r1 = await fetch(`http://127.0.0.1:${port}/api/test/fault/etcd-partition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'dev' },
      body: JSON.stringify({ ms: 1000 }),
    });
    assert.equal(r1.status, 403);
    assert.equal(simulated, false);

    process.env.ENABLE_TEST_FAULTS = '1';
    const r2 = await fetch(`http://127.0.0.1:${port}/api/test/fault/etcd-partition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'dev' },
      body: JSON.stringify({ ms: 1000 }),
    });
    assert.equal(r2.status, 200);
    assert.equal(simulated, true);

    // Kiểm tra FAULT_INJECTION=1 cũng hoạt động
    delete process.env.ENABLE_TEST_FAULTS;
    process.env.FAULT_INJECTION = '1';
    simulated = false;
    const r3 = await fetch(`http://127.0.0.1:${port}/api/test/fault/etcd-partition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'dev' },
      body: JSON.stringify({ ms: 1000 }),
    });
    assert.equal(r3.status, 200);
    assert.equal(simulated, true);
  } finally {
    if (prevEnv !== undefined) process.env.ENABLE_TEST_FAULTS = prevEnv;
    else delete process.env.ENABLE_TEST_FAULTS;
    delete process.env.FAULT_INJECTION;
    server.close();
  }
});

test('PD-09 registry: tự động lập lịch thử lại khi mất lease (lease on lost)', async () => {
  const EventEmitter = require('node:events');
  let registerCount = 0;
  const mockLeaseEmitter = new EventEmitter();
  mockLeaseEmitter.put = () => ({
    value: async () => {},
  });
  mockLeaseEmitter.revoke = async () => {};

  const mockClient = {
    lease: () => {
      registerCount++;
      return mockLeaseEmitter;
    },
    close: () => {},
  };

  const reg = makeRegistryClient({
    client: mockClient,
    parkingId: 'TEST',
  });

  await reg.register();
  assert.equal(registerCount, 1);

  // Giả lập lease bị mất (etcd phân hoạch tạm thời)
  let retryScheduled = false;
  reg.scheduleRetry = () => { retryScheduled = true; };
  mockLeaseEmitter.emit('lost', new Error('lease expired'));

  assert.equal(retryScheduled, true, 'Phải tự động gọi scheduleRetry khi nhận sự kiện lost');
  await reg.stop();
});

test('PD-09 registry: start() tự động gọi scheduleRetry khi khởi tạo lỗi ban đầu', async () => {
  let retryScheduled = false;
  const mockClient = {
    lease: () => {
      throw new Error('connection refused');
    },
    close: () => {},
  };

  const reg = makeRegistryClient({
    client: mockClient,
    parkingId: 'TEST',
  });
  reg.scheduleRetry = () => { retryScheduled = true; };

  await reg.start();
  assert.equal(retryScheduled, true, 'start() phải tự động scheduleRetry khi lỗi ban đầu');
  await reg.stop();
});

