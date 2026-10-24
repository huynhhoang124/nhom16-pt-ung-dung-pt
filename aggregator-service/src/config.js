// PD-11: Cấu hình động qua etcd watch (Issue #28)
//   - Đọc các cấu hình từ biến môi trường làm mặc định (NODE_TIMEOUT_MS, FAIL_THRESHOLD, COMMAND_TTL_MS, REPLY_WAIT_MS...).
//   - Khi có ETCD_ENDPOINTS: đọc các khoá tại tiền tố /nhom16/config/aggregator/* và /nhom16/config/commands/*
//     lúc khởi động, sau đó watch tiền tố /nhom16/config/ để cập nhật bộ nhớ ngay lập tức.
//   - Ghi log JSON có đủ: key, oldValue, newValue, revision khi có sự kiện watch.
//   - Khi ETCD_ENDPOINTS trống: dùng giá trị từ biến môi trường, không mở kết nối etcd (tương thích ngược 100%).

const { Etcd3 } = require('etcd3');

const PREFIX = '/nhom16/config/';

const DEFAULTS = {
  timeoutMs: Number(process.env.NODE_TIMEOUT_MS || 2000),
  failThreshold: Number(process.env.FAIL_THRESHOLD || 3),
  ttlMs: Number(process.env.COMMAND_TTL_MS || 5000),
  replyWaitMs: Number(process.env.REPLY_WAIT_MS || 3000),
  healthIntervalMs: Number(process.env.HEALTH_INTERVAL_MS || 5000),
  reserveTimeoutMs: Number(process.env.RESERVE_TIMEOUT_MS || 3000),
};

function parseValue(val) {
  if (val === undefined || val === null) return val;
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (!Number.isNaN(Number(trimmed)) && trimmed !== '') return Number(trimmed);
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseKey(fullKey) {
  if (!fullKey.startsWith(PREFIX)) return { key: fullKey, section: null, prop: fullKey, subKey: fullKey };
  const rest = fullKey.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash === -1) {
    return { key: fullKey, section: null, prop: rest, subKey: rest };
  }
  return {
    key: fullKey,
    section: rest.slice(0, slash),
    prop: rest.slice(slash + 1),
    subKey: rest,
  };
}

function makeConfig({
  etcdEndpoints = process.env.ETCD_ENDPOINTS,
  log = console,
  defaults = DEFAULTS,
} = {}) {
  const store = new Map();

  // Khởi tạo giá trị mặc định từ defaults / env
  for (const [k, v] of Object.entries(defaults)) {
    store.set(k, v);
  }

  function get(key, fallback) {
    if (store.has(key)) return store.get(key);
    // Tra cứu theo prop name nếu truyền full key hoặc ngược lại
    if (key.startsWith(PREFIX)) {
      const { prop, subKey } = parseKey(key);
      if (store.has(key)) return store.get(key);
      if (subKey && store.has(subKey)) return store.get(subKey);
      if (prop && store.has(prop)) return store.get(prop);
    } else {
      const aggKey = `${PREFIX}aggregator/${key}`;
      if (store.has(aggKey)) return store.get(aggKey);
      const cmdKey = `${PREFIX}commands/${key}`;
      if (store.has(cmdKey)) return store.get(cmdKey);
    }
    return fallback !== undefined ? fallback : defaults[key];
  }

  function all() {
    const obj = {};
    for (const [k, v] of store.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  if (!etcdEndpoints) {
    return {
      active: false,
      get,
      all,
      start: async () => {},
      stop: async () => {},
      store,
    };
  }

  const hosts = etcdEndpoints.split(',').map((s) => s.trim()).filter(Boolean);
  const client = new Etcd3({ hosts });
  let watcher = null;

  function applyPut(fullKey, rawVal, revision, { isInitial = false } = {}) {
    const val = parseValue(rawVal);
    const parsed = parseKey(fullKey);
    const oldValue = get(parsed.prop) ?? get(fullKey);

    store.set(fullKey, val);
    if (parsed.subKey) store.set(parsed.subKey, val);
    if (parsed.prop) store.set(parsed.prop, val);

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
    const parsed = parseKey(fullKey);
    const oldValue = get(parsed.prop) ?? get(fullKey);

    store.delete(fullKey);
    if (parsed.subKey) store.delete(parsed.subKey);
    if (parsed.prop) {
      store.delete(parsed.prop);
      if (defaults[parsed.prop] !== undefined) {
        store.set(parsed.prop, defaults[parsed.prop]);
      }
    }

    log.info?.(`[etcd-config] Xoá ${fullKey}`, {
      key: fullKey,
      oldValue: oldValue !== undefined ? oldValue : null,
      newValue: defaults[parsed.prop] ?? null,
      revision: revision !== undefined ? Number(revision) : null,
    });
  }

  async function start() {
    try {
      // 1. Đọc toàn bộ cấu hình hiện có lúc khởi động
      const allKvs = await client.getAll().prefix(PREFIX).strings();
      for (const [k, v] of Object.entries(allKvs)) {
        applyPut(k, v, null, { isInitial: true });
      }

      // 2. Thiết lập watcher trên tiền tố
      watcher = await client.watch().prefix(PREFIX).withPreviousKV().create();
      watcher.on('put', (kv) => {
        const key = kv.key.toString();
        const value = kv.value.toString();
        const revision = Number(kv.mod_revision || watcher.lastRevision?.() || 0);
        applyPut(key, value, revision, { isInitial: false });
      });

      watcher.on('delete', (kv) => {
        const key = kv.key.toString();
        const revision = Number(kv.mod_revision || watcher.lastRevision?.() || 0);
        applyDelete(key, revision);
      });

      watcher.on('error', (err) => {
        log.error?.('[etcd-config] Watcher gặp lỗi', { error: err.message });
      });

      log.info?.(`[etcd-config] Đã kích hoạt watcher trên tiền tố ${PREFIX}`);
    } catch (e) {
      log.error?.('[etcd-config] Không thể nạp cấu hình từ etcd', { error: e.message });
    }
  }

  async function stop() {
    if (watcher) {
      try { await watcher.cancel(); } catch { /* bỏ qua */ }
      watcher = null;
    }
    client.close();
  }

  return {
    active: true,
    client,
    get,
    all,
    applyPut,
    applyDelete,
    start,
    stop,
    store,
  };
}

module.exports = { makeConfig, parseKey, parseValue, PREFIX, DEFAULTS };
