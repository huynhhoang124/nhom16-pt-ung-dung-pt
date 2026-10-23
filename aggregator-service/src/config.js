// PD-11: Cấu hình động qua etcd watch (Issue #28)
//   - Đọc các cấu hình từ biến môi trường làm mặc định (NODE_TIMEOUT_MS, FAIL_THRESHOLD, COMMAND_TTL_MS, REPLY_WAIT_MS...).
//   - Khi có ETCD_ENDPOINTS: đọc các khoá tại tiền tố /nhom16/config/aggregator/* lúc khởi động,
//     sau đó watch tiền tố /nhom16/config/aggregator/ để cập nhật bộ nhớ ngay lập tức.
//   - Validation whitelist: chỉ nhận các khoá đã biết, giá trị trong ngưỡng an toàn; giá trị sai bị từ chối, giữ nguyên giá trị cũ.
//   - Ghi log JSON có đủ: key, oldValue, newValue, revision khi có sự kiện watch.
//   - Khi ETCD_ENDPOINTS trống: dùng giá trị từ biến môi trường, không mở kết nối etcd (tương thích ngược 100%).

const { Etcd3 } = require('etcd3');

const PREFIX = '/nhom16/config/aggregator/';

const DEFAULTS = {
  timeoutMs: Number(process.env.NODE_TIMEOUT_MS || 2000),
  failThreshold: Number(process.env.FAIL_THRESHOLD || 3),
  reserveTimeoutMs: Number(process.env.RESERVE_TIMEOUT_MS || 3000),
  ttlMs: Number(process.env.COMMAND_TTL_MS || 5000),
  replyWaitMs: Number(process.env.REPLY_WAIT_MS || 3000),
  healthIntervalMs: Number(process.env.HEALTH_INTERVAL_MS || 5000),
};

const VALIDATORS = {
  timeoutMs: (v) => Number.isInteger(v) && v >= 100 && v <= 30000,
  failThreshold: (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  reserveTimeoutMs: (v) => Number.isInteger(v) && v >= 100 && v <= 60000,
  ttlMs: (v) => Number.isInteger(v) && v >= 100 && v <= 60000,
  replyWaitMs: (v) => Number.isInteger(v) && v >= 100 && v <= 60000,
  healthIntervalMs: (v) => Number.isInteger(v) && v >= 500 && v <= 60000,
};

function parseValue(val) {
  if (val === undefined || val === null) return val;
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed === '') return NaN;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function getProp(fullKey) {
  if (typeof fullKey !== 'string') return null;
  if (fullKey.startsWith(PREFIX)) return fullKey.slice(PREFIX.length);
  if (fullKey.startsWith('aggregator/')) return fullKey.slice('aggregator/'.length);
  if (VALIDATORS[fullKey]) return fullKey;
  return null;
}

function parseKey(fullKey) {
  const prop = getProp(fullKey);
  return {
    key: fullKey,
    section: 'aggregator',
    prop: prop || fullKey,
    subKey: prop ? `aggregator/${prop}` : fullKey,
  };
}

function makeConfig({
  etcdEndpoints = process.env.ETCD_ENDPOINTS,
  log = console,
  defaults = DEFAULTS,
  client: injectedClient,
} = {}) {
  const store = new Map();

  // Khởi tạo giá trị mặc định từ defaults
  for (const [k, v] of Object.entries(defaults)) {
    store.set(k, v);
  }

  function get(key, fallback) {
    const prop = getProp(key) || key;
    if (store.has(prop)) return store.get(prop);
    return fallback !== undefined ? fallback : defaults[prop];
  }

  function all() {
    const obj = {};
    for (const [k, v] of store.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  function applyPut(fullKey, rawVal, revision, { isInitial = false } = {}) {
    const prop = getProp(fullKey);
    if (!prop || !VALIDATORS[prop]) {
      log.warn?.(`[etcd-config] Bỏ qua khoá không nằm trong whitelist: ${fullKey}`);
      return;
    }

    const val = parseValue(rawVal);
    const validator = VALIDATORS[prop];
    if (!validator(val)) {
      log.warn?.(`[etcd-config] Giá trị cấu hình không hợp lệ cho ${fullKey}: ${rawVal}, giữ nguyên giá trị cũ`, {
        key: fullKey,
        value: rawVal,
        currentValue: store.get(prop),
      });
      return;
    }

    const oldValue = store.get(prop);
    store.set(prop, val);

    if (!isInitial) {
      log.info?.(`[etcd-config] Cập nhật ${fullKey}`, {
        key: fullKey,
        oldValue: oldValue !== undefined ? oldValue : null,
        newValue: val,
        revision: revision !== undefined ? Number(revision) : null,
      });
    }
  }

  function applyDelete(fullKey, revision) {
    const prop = getProp(fullKey);
    if (!prop || !VALIDATORS[prop]) return;

    const oldValue = store.get(prop);
    store.delete(prop);
    if (defaults[prop] !== undefined) {
      store.set(prop, defaults[prop]);
    }

    log.info?.(`[etcd-config] Xoá ${fullKey}`, {
      key: fullKey,
      oldValue: oldValue !== undefined ? oldValue : null,
      newValue: defaults[prop] ?? null,
      revision: revision !== undefined ? Number(revision) : null,
    });
  }

  if (!etcdEndpoints && !injectedClient) {
    return {
      active: false,
      get,
      all,
      applyPut,
      applyDelete,
      start: async () => {},
      stop: async () => {},
      store,
    };
  }

  const hosts = etcdEndpoints ? etcdEndpoints.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const client = injectedClient || new Etcd3({ hosts });
  let watcher = null;
  let retryTimer = null;
  let stopped = false;

  function scheduleSyncRetry(delayMs = 3000) {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      syncAndWatch().catch((e) => {
        log.warn?.('[etcd-config] Kết nối lại etcd chưa thành công, thử lại sau...', { error: e.message });
        scheduleSyncRetry(3000);
      });
    }, delayMs);
  }

  async function syncAndWatch() {
    if (stopped) return;

    if (watcher) {
      try { await watcher.cancel(); } catch { /* ignore */ }
      watcher = null;
    }

    // 1. Đọc toàn bộ snapshot ban đầu và lấy revision để chống race condition
    const rangeRes = await client.getAll().prefix(PREFIX).exec();
    const revision = Number(rangeRes.header?.revision || 0);

    if (rangeRes.kvs) {
      for (const kv of rangeRes.kvs) {
        const k = kv.key.toString();
        const v = kv.value.toString();
        applyPut(k, v, revision, { isInitial: true });
      }
    }

    // 2. Khởi tạo watcher bắt đầu từ revision + 1 để không sót sự kiện nào
    let watchBuilder = client.watch().prefix(PREFIX);
    if (revision > 0) {
      watchBuilder = watchBuilder.startRevision(revision + 1);
    }
    watcher = await watchBuilder.create();

    watcher.on('put', (kv) => {
      const key = kv.key.toString();
      const val = kv.value.toString();
      const rev = Number(kv.mod_revision || 0);
      applyPut(key, val, rev, { isInitial: false });
    });
    watcher.on('delete', (kv) => {
      const key = kv.key.toString();
      const rev = Number(kv.mod_revision || 0);
      applyDelete(key, rev);
    });
    watcher.on('error', (err) => {
      log.error?.('[etcd-config] Watcher gặp lỗi, sẽ tự động kết nối lại...', { error: err.message });
      if (!stopped) {
        scheduleSyncRetry(2000);
      }
    });

    log.info?.(`[etcd-config] Đã đồng bộ và kích hoạt watcher trên tiền tố ${PREFIX} (bắt đầu từ revision ${revision + 1})`);
  }

  async function start() {
    try {
      await syncAndWatch();
    } catch (e) {
      log.error?.('[etcd-config] Không thể kết nối etcd lúc khởi động, sẽ thử lại trong nền...', { error: e.message });
      scheduleSyncRetry(2000);
    }
  }

  async function stop() {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (watcher) {
      try { await watcher.cancel(); } catch { /* ignore */ }
      watcher = null;
    }
    if (!injectedClient) {
      client.close();
    }
  }

  return {
    active: true,
    client,
    get,
    all,
    applyPut,
    applyDelete,
    syncAndWatch,
    start,
    stop,
    store,
  };
}

module.exports = { makeConfig, parseKey, parseValue, PREFIX, DEFAULTS, VALIDATORS };
