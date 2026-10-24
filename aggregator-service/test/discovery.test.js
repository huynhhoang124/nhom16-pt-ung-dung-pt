const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRegistry } = require('../src/nodes');
const { startDiscovery, parseKey } = require('../src/discovery');

test('PD-09 discovery: parseKey trích xuất đúng parkingId và hostname', () => {
  assert.deepEqual(parseKey('/nhom16/parking/nodes/A/parking-a'), { parkingId: 'A', hostname: 'parking-a' });
  assert.deepEqual(parseKey('/nhom16/parking/nodes/D/host-123'), { parkingId: 'D', hostname: 'host-123' });
  assert.equal(parseKey('/invalid/key'), null);
});

test('PD-09 trạng thái phân tán: kết hợp lease etcd và HTTP health check', () => {
  const reg = makeRegistry({ internalKey: 'dev', failThreshold: 3 });

  // 1. Chế độ giai đoạn 1 (không có etcd, hasLease === undefined)
  const n1 = reg.add({ parking_id: 'N1', name: 'Bãi N1', api_url: 'http://localhost:8001' });
  assert.equal(n1.hasLease, undefined);
  assert.equal(reg.computeStatus(n1), 'OFFLINE'); // fails = 3 >= failThreshold

  n1.fails = 0; // HTTP OK
  assert.equal(reg.computeStatus(n1), 'ONLINE');

  n1.fails = 3; // HTTP FAIL
  assert.equal(reg.computeStatus(n1), 'OFFLINE');

  // 2. Chế độ có etcd (hasLease là boolean)
  const n2 = reg.add({ parking_id: 'N2', name: 'Bãi N2', api_url: 'http://localhost:8002', hasLease: true });
  n2.fails = 0; // Còn lease VÀ health check đạt
  assert.equal(reg.computeStatus(n2), 'ONLINE');

  // Mất lease NHƯNG Aggregator vẫn gọi HTTP được
  reg.setLease('N2', false);
  assert.equal(n2.hasLease, false);
  assert.equal(n2.status, 'DEGRADED');

  // Hỏng cả hai (mất lease VÀ HTTP hỏng)
  n2.fails = 3;
  reg.setStatus(n2, reg.computeStatus(n2));
  assert.equal(n2.status, 'OFFLINE');

  // Còn lease NHƯNG HTTP hỏng -> ngắt mạch ngay lập tức (OFFLINE)
  reg.setLease('N2', true);
  assert.equal(n2.hasLease, true);
  assert.equal(n2.status, 'OFFLINE');

  // Phục hồi cả hai
  n2.fails = 0;
  reg.setStatus(n2, reg.computeStatus(n2));
  assert.equal(n2.status, 'ONLINE');
});

test('PD-09 dynamic discovery: phát hiện bãi mới qua applyPut và thu hồi qua applyDelete', () => {
  const reg = makeRegistry({ internalKey: 'dev' });
  const changes = [];
  reg.check((n, prev) => changes.push({ id: n.id, prev, status: n.status }));

  const disc = startDiscovery({
    etcdEndpoints: 'http://localhost:2379',
    reg,
  });

  // Giả lập nhận sự kiện PUT khoá bãi D
  const keyD = '/nhom16/parking/nodes/D/parking-d';
  disc.applyPut(keyD, JSON.stringify({ url: 'http://parking-d:8004', zone: 'bac', name: 'Bãi D' }));

  const nodeD = reg.get('D');
  assert.ok(nodeD, 'Bãi D phải được tự động thêm vào registry');
  assert.equal(nodeD.url, 'http://parking-d:8004');
  assert.equal(nodeD.zone, 'bac');
  assert.equal(nodeD.hasLease, true);

  // Giả lập nodeD HTTP thành công
  nodeD.fails = 0;
  reg.setStatus(nodeD, reg.computeStatus(nodeD));
  assert.equal(nodeD.status, 'ONLINE');

  // Giả lập nhận sự kiện DELETE khoá bãi D (hết hạn lease)
  disc.applyDelete(keyD);
  assert.equal(nodeD.hasLease, false);
  assert.equal(nodeD.status, 'DEGRADED', 'Mất lease nhưng HTTP còn sống -> chuyển DEGRADED');

  // Giả lập khoá được PUT lại (node re-register)
  disc.applyPut(keyD, JSON.stringify({ url: 'http://parking-d:8004', zone: 'bac', name: 'Bãi D' }));
  assert.equal(nodeD.hasLease, true);
  assert.equal(nodeD.status, 'ONLINE', 'Có lại lease -> phục hồi ONLINE');

  disc.client.close();
});

test('PD-09 discovery: khởi tạo watch với startRevision(revision + 1) từ snapshot', async () => {
  const reg = makeRegistry({ internalKey: 'dev' });
  let watchedPrefix = null;
  let startedRevision = null;
  const mockWatcher = {
    on: () => {},
    cancel: async () => {},
  };
  const mockClient = {
    getAll: () => ({
      prefix: () => ({
        exec: async () => ({
          header: { revision: '42' },
          kvs: [
            {
              key: Buffer.from('/nhom16/parking/nodes/E/parking-e'),
              value: Buffer.from(JSON.stringify({ url: 'http://parking-e:8005', zone: 'nam', name: 'Bãi E' })),
            },
          ],
        }),
      }),
    }),
    watch: () => ({
      prefix: (p) => {
        watchedPrefix = p;
        return {
          startRevision: (rev) => {
            startedRevision = rev;
            return {
              create: async () => mockWatcher,
            };
          },
        };
      },
    }),
    close: () => {},
  };

  const disc = startDiscovery({
    reg,
    client: mockClient,
  });

  await disc.syncAndWatch();

  assert.equal(startedRevision, 43, 'startRevision phải là revision + 1 từ snapshot etcd');
  assert.equal(watchedPrefix, '/nhom16/parking/nodes/');
  const nodeE = reg.get('E');
  assert.ok(nodeE, 'Node E phải được nạp từ snapshot');
  assert.equal(nodeE.hasLease, true);

  await disc.stop();
});

test('PD-09 discovery: khi không có ETCD_ENDPOINTS thì inactive, không lỗi', async () => {
  const reg = makeRegistry({ internalKey: 'dev' });
  const disc = startDiscovery({ etcdEndpoints: '', reg });
  assert.equal(disc.active, false);
  await disc.start();
  await disc.stop();
});
