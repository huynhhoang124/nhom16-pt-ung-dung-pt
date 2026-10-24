const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeConfig, parseKey, parseValue, PREFIX, DEFAULTS } = require('../src/config');
const { makeRegistry } = require('../src/nodes');
const { makeApp } = require('../src/routes');
const { makeAuth } = require('../src/auth');

test('PD-11 config: parseKey trích xuất đúng key, section, prop', () => {
  assert.deepEqual(parseKey('/nhom16/config/aggregator/timeoutMs'), {
    key: '/nhom16/config/aggregator/timeoutMs',
    section: 'aggregator',
    prop: 'timeoutMs',
    subKey: 'aggregator/timeoutMs',
  });
  assert.deepEqual(parseKey('/nhom16/config/aggregator/ttlMs'), {
    key: '/nhom16/config/aggregator/ttlMs',
    section: 'aggregator',
    prop: 'ttlMs',
    subKey: 'aggregator/ttlMs',
  });
  assert.deepEqual(parseKey('/custom/key'), {
    key: '/custom/key',
    section: 'aggregator',
    prop: '/custom/key',
    subKey: '/custom/key',
  });
});

test('PD-11 config: parseValue chuyển đổi đúng kiểu dữ liệu (số, boolean, JSON, chuỗi)', () => {
  assert.equal(parseValue('500'), 500);
  assert.equal(parseValue('0'), 0);
  assert.equal(parseValue('true'), true);
  assert.equal(parseValue('false'), false);
  assert.deepEqual(parseValue('{"maxRetries":3}'), { maxRetries: 3 });
  assert.equal(parseValue('hello-world'), 'hello-world');
  assert.equal(parseValue(null), null);
  assert.equal(parseValue(undefined), undefined);
});

test('PD-11 config: giá trị mặc định lấy từ DEFAULTS / env', () => {
  const config = makeConfig({
    etcdEndpoints: '',
    defaults: { timeoutMs: 2500, failThreshold: 4, ttlMs: 6000, replyWaitMs: 3500 },
  });

  assert.equal(config.active, false);
  assert.equal(config.get('timeoutMs'), 2500);
  assert.equal(config.get('failThreshold'), 4);
  assert.equal(config.get('ttlMs'), 6000);
  assert.equal(config.get('replyWaitMs'), 3500);
  assert.equal(config.get('nonExistent', 'fallback'), 'fallback');
});

test('PD-11 config: cập nhật qua watch (applyPut) và xoá (applyDelete) kèm log JSON và revision', () => {
  const logs = [];
  const mockLog = {
    info: (msg, data) => logs.push({ msg, ...data }),
    error: (msg, data) => logs.push({ level: 'error', msg, ...data }),
  };

  const config = makeConfig({
    etcdEndpoints: 'http://localhost:2379',
    log: mockLog,
    defaults: { timeoutMs: 2000, failThreshold: 3, ttlMs: 5000 },
  });

  assert.equal(config.active, true);
  assert.equal(config.get('timeoutMs'), 2000);

  // 1. Cập nhật timeoutMs qua etcd watch (revision 42)
  const keyTimeout = '/nhom16/config/aggregator/timeoutMs';
  config.applyPut(keyTimeout, '500', 42);

  assert.equal(config.get('timeoutMs'), 500);
  assert.equal(config.get(keyTimeout), 500);
  assert.equal(config.get('aggregator/timeoutMs'), 500);

  // Kiểm tra log có đủ key, oldValue, newValue, revision
  const logTimeout = logs.find((l) => l.key === keyTimeout);
  assert.ok(logTimeout, 'Phải có log ghi nhận thay đổi timeoutMs');
  assert.equal(logTimeout.oldValue, 2000);
  assert.equal(logTimeout.newValue, 500);
  assert.equal(logTimeout.revision, 42);

  // 2. Cập nhật failThreshold (revision 43)
  const keyThreshold = '/nhom16/config/aggregator/failThreshold';
  config.applyPut(keyThreshold, '5', 43);
  assert.equal(config.get('failThreshold'), 5);

  const logThreshold = logs.find((l) => l.key === keyThreshold);
  assert.ok(logThreshold);
  assert.equal(logThreshold.oldValue, 3);
  assert.equal(logThreshold.newValue, 5);
  assert.equal(logThreshold.revision, 43);

  // 3. Cập nhật aggregator/ttlMs (revision 44)
  const keyTtl = '/nhom16/config/aggregator/ttlMs';
  config.applyPut(keyTtl, '8000', 44);
  assert.equal(config.get('ttlMs'), 8000);

  // 4. Xoá khoá (applyDelete, revision 45) -> khôi phục giá trị mặc định
  config.applyDelete(keyTimeout, 45);
  assert.equal(config.get('timeoutMs'), 2000);

  const logDelete = logs.find((l) => l.msg && l.msg.includes('Xoá') && l.key === keyTimeout);
  assert.ok(logDelete, 'Phải có log xoá khoá');
  assert.equal(logDelete.oldValue, 500);
  assert.equal(logDelete.newValue, 2000);
  assert.equal(logDelete.revision, 45);

  config.client.close();
});

test('PD-11 config: fallback an toàn khi không có ETCD_ENDPOINTS (tương thích ngược 100%)', async () => {
  const config = makeConfig({ etcdEndpoints: '' });
  assert.equal(config.active, false);
  assert.equal(typeof config.get('timeoutMs'), 'number');
  assert.equal(typeof config.get('failThreshold'), 'number');

  // Gọi start/stop không bị lỗi
  await config.start();
  await config.stop();
});

test('PD-11 nodes registry: makeRegistry đọc động qua config.get ngay lập tức mà không cần khởi động lại', () => {
  const config = makeConfig({
    etcdEndpoints: 'http://localhost:2379',
    defaults: { timeoutMs: 2000, failThreshold: 3 },
  });

  const reg = makeRegistry({
    internalKey: 'dev',
    config,
  });

  const nodeA = reg.add({ parking_id: 'A', name: 'Bãi A', api_url: 'http://localhost:8001' });

  // Ban đầu fails = 3, failThreshold = 3 -> OFFLINE
  nodeA.fails = 3;
  assert.equal(reg.computeStatus(nodeA), 'OFFLINE');

  // Đổi failThreshold trên etcd lên 5 mà không tạo lại registry
  config.applyPut('/nhom16/config/aggregator/failThreshold', '5', 100);

  // Ngay lập tức computeStatus nhận threshold mới 5 -> fails = 3 < 5 -> ONLINE!
  assert.equal(reg.computeStatus(nodeA), 'ONLINE');

  // Đổi timeoutMs trên etcd về 500ms
  config.applyPut('/nhom16/config/aggregator/timeoutMs', '500', 101);
  assert.equal(config.get('timeoutMs'), 500);

  config.client.close();
});

test('PD-11 config: đặt giá trị sai (failThreshold=0, timeoutMs=abc) bị từ chối, giữ nguyên giá trị cũ và bãi vẫn ONLINE', () => {
  const warnLogs = [];
  const mockLog = {
    info: () => {},
    warn: (msg, data) => warnLogs.push({ msg, ...data }),
    error: () => {},
  };

  const config = makeConfig({
    etcdEndpoints: 'http://localhost:2379',
    log: mockLog,
    defaults: { timeoutMs: 2000, failThreshold: 3 },
  });

  const reg = makeRegistry({
    internalKey: 'dev',
    config,
  });

  const nodeA = reg.add({ parking_id: 'A', name: 'Bãi A', api_url: 'http://localhost:8001' });
  nodeA.fails = 0;
  reg.setStatus(nodeA, reg.computeStatus(nodeA));
  assert.equal(nodeA.status, 'ONLINE');

  // 1. Đặt failThreshold = 0 (ngoài khoảng 1..20) -> bị từ chối, giữ nguyên giá trị cũ 3
  config.applyPut('/nhom16/config/aggregator/failThreshold', '0', 101);
  assert.equal(config.get('failThreshold'), 3, 'Giá trị failThreshold cũ phải được giữ nguyên');
  assert.equal(nodeA.status, 'ONLINE', 'Bãi đang sống vẫn phải giữ trạng thái ONLINE, không bị ngắt mạch nhầm');

  // 2. Đặt timeoutMs = "abc" (không phải số) -> bị từ chối, giữ nguyên giá trị cũ 2000
  config.applyPut('/nhom16/config/aggregator/timeoutMs', 'abc', 102);
  assert.equal(config.get('timeoutMs'), 2000, 'Giá trị timeoutMs cũ phải được giữ nguyên');

  // 3. Đặt timeoutMs = -50 (ngoài khoảng 100..30000) -> bị từ chối
  config.applyPut('/nhom16/config/aggregator/timeoutMs', '-50', 103);
  assert.equal(config.get('timeoutMs'), 2000);

  // 4. Khoá không nằm trong whitelist -> bị từ chối
  config.applyPut('/nhom16/config/aggregator/unknownKey', '123', 104);
  assert.equal(config.get('unknownKey'), undefined);

  assert.ok(warnLogs.length >= 4, 'Phải có log warning khi nhận giá trị không hợp lệ hoặc khoá ngoài whitelist');

  config.client.close();
});

test('PD-11 config: khởi tạo watch với startRevision(revision + 1) từ snapshot và retry', async () => {
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
          header: { revision: '88' },
          kvs: [
            {
              key: Buffer.from('/nhom16/config/aggregator/timeoutMs'),
              value: Buffer.from('1200'),
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

  const config = makeConfig({
    client: mockClient,
  });

  await config.syncAndWatch();

  assert.equal(startedRevision, 89, 'startRevision phải là revision + 1 từ snapshot etcd');
  assert.equal(watchedPrefix, '/nhom16/config/aggregator/');
  assert.equal(config.get('timeoutMs'), 1200);

  await config.stop();
});

test('PD-11 config: resync sau khi mất watch đưa khoá đã bị xoá về giá trị mặc định', async () => {
  let kvs = [{ key: Buffer.from('/nhom16/config/aggregator/timeoutMs'), value: Buffer.from('1200') }];
  const mockClient = {
    getAll: () => ({ prefix: () => ({ exec: async () => ({ header: { revision: '10' }, kvs }) }) }),
    watch: () => ({ prefix: () => ({ startRevision: () => ({ create: async () => ({ on: () => {}, cancel: async () => {} }) }) }) }),
    close: () => {},
  };
  const config = makeConfig({ client: mockClient, log: { info() {}, warn() {}, error() {} } });

  await config.syncAndWatch();
  assert.equal(config.get('timeoutMs'), 1200);

  kvs = [];   // khoá bị xoá trong lúc watch đứt
  await config.syncAndWatch();
  assert.equal(config.get('timeoutMs'), DEFAULTS.timeoutMs);

  await config.stop();
});

test('PD-11 config routes: GET /api/config yêu cầu quyền ADMIN, không có token nhận 401', async () => {
  const jwt = require('jsonwebtoken');
  const config = makeConfig({ defaults: { timeoutMs: 2000 } });
  const auth = makeAuth('secret-test-key');
  const reg = makeRegistry({ internalKey: 'dev', config });
  const app = makeApp({ pool: {}, reg, cache: new Map(), auth, config });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Không có token -> 401 Unauthorized
    const rNoToken = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(rNoToken.status, 401);

    // 2. Token USER -> 403 Forbidden
    const userToken = jwt.sign({ sub: 'user-1', role: 'USER' }, 'secret-test-key');
    const rUser = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(rUser.status, 403);

    // 3. Token ADMIN -> 200 OK
    const adminToken = jwt.sign({ sub: 'admin-1', role: 'ADMIN' }, 'secret-test-key');
    const rAdmin = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(rAdmin.status, 200);
    const body = await rAdmin.json();
    assert.equal(body.timeoutMs, 2000);
  } finally {
    server.close();
  }
});
