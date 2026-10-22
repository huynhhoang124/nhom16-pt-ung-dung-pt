const test = require('node:test');
const assert = require('node:assert/strict');
const { makeConfig, parseKey, parseValue, PREFIX, DEFAULTS } = require('../src/config');
const { makeRegistry } = require('../src/nodes');

test('PD-11 config: parseKey trích xuất đúng key, section, prop', () => {
  assert.deepEqual(parseKey('/nhom16/config/aggregator/timeoutMs'), {
    key: '/nhom16/config/aggregator/timeoutMs',
    section: 'aggregator',
    prop: 'timeoutMs',
    subKey: 'aggregator/timeoutMs',
  });
  assert.deepEqual(parseKey('/nhom16/config/commands/ttlMs'), {
    key: '/nhom16/config/commands/ttlMs',
    section: 'commands',
    prop: 'ttlMs',
    subKey: 'commands/ttlMs',
  });
  assert.deepEqual(parseKey('/custom/key'), {
    key: '/custom/key',
    section: null,
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

  // 3. Cập nhật commands/ttlMs (revision 44)
  const keyTtl = '/nhom16/config/commands/ttlMs';
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
