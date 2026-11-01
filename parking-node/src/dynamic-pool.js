// PD-14b: Dynamic Pool & Zombie Primary Fencing (Issue #32)
//   - Đọc và watch /nhom16/parking/<PARKING_ID>/db/primary và /nhom16/parking/<PARKING_ID>/db/epoch trên etcd.
//   - Khi primary đổi: tự động chuyển Pool sang DB mới mà không cần khởi động lại tiến trình.
//   - Chặn ghi (Zombie Primary Fencing): kiểm tra db_epoch == etcd_epoch trước mỗi transaction.
//   - Tương thích ngược 100%: khi không có ETCD_ENDPOINTS, hoạt động như Pool tĩnh thông thường.

const { Pool } = require('pg');
const { Etcd3 } = require('etcd3');

async function makeDynamicPool({
  etcdEndpoints = process.env.ETCD_ENDPOINTS,
  parkingId = process.env.PARKING_ID || 'A',
  defaultDatabaseUrl = process.env.DATABASE_URL,
  log = console,
  poolFactory = (opts) => new Pool(opts),
  etcdClient = null,
  watchWindowMs = Number(process.env.ETCD_WATCH_WINDOW_MS || 3000),
} = {}) {
  // Tương thích ngược 100% khi không có etcd
  if (!etcdEndpoints && !etcdClient) {
    const pool = poolFactory({ connectionString: defaultDatabaseUrl });
    return pool;
  }

  let currentUrl = defaultDatabaseUrl;
  let currentEpoch = 1;
  let lastEtcdContact = Date.now();
  const listeners = [];

  const client = etcdClient || new Etcd3({
    hosts: etcdEndpoints.split(',').map((s) => s.trim()).filter(Boolean),
  });

  const primaryKey = `/nhom16/parking/${parkingId}/db/primary`;
  const epochKey = `/nhom16/parking/${parkingId}/db/epoch`;

  let currentPool = poolFactory({ connectionString: currentUrl });

  // Đọc giá trị ban đầu từ etcd nếu có
  try {
    const [etcdPrimary, etcdEpoch] = await Promise.all([
      client.get(primaryKey).string(),
      client.get(epochKey).string(),
    ]);
    lastEtcdContact = Date.now();
    if (etcdPrimary && etcdPrimary !== currentUrl) {
      log.info?.(`[dynamic-pool] Khởi tạo primary từ etcd: ${etcdPrimary}`);
      currentUrl = etcdPrimary;
      const old = currentPool;
      currentPool = poolFactory({ connectionString: currentUrl });
      old.end?.().catch(() => {});
    }
    if (etcdEpoch) {
      currentEpoch = Number(etcdEpoch);
      log.info?.(`[dynamic-pool] Khởi tạo epoch từ etcd: ${currentEpoch}`);
    }
  } catch (e) {
    log.warn?.('[dynamic-pool] Không thể đọc etcd ban đầu, dùng cấu hình mặc định', { error: e.message });
  }

  let primaryWatcher = null;
  let epochWatcher = null;
  let heartbeatTimer = null;

  try {
    primaryWatcher = await client.watch().key(primaryKey).create();
    primaryWatcher.on('put', (res) => {
      lastEtcdContact = Date.now();
      const val = res.value?.toString();
      if (val && val !== currentUrl) {
        log.info?.(`[dynamic-pool] DB primary thay đổi trên etcd: ${currentUrl} -> ${val}`);
        wrapper.switchPrimary(val);
      }
    });
    primaryWatcher.on('error', (err) => log.error?.('[dynamic-pool] Watcher primary lỗi', { error: err.message }));

    epochWatcher = await client.watch().key(epochKey).create();
    epochWatcher.on('put', (res) => {
      lastEtcdContact = Date.now();
      const val = res.value?.toString();
      if (val) {
        const newEp = Number(val);
        log.info?.(`[dynamic-pool] DB epoch thay đổi trên etcd: ${currentEpoch} -> ${newEp}`);
        currentEpoch = newEp;
      }
    });
    epochWatcher.on('error', (err) => log.error?.('[dynamic-pool] Watcher epoch lỗi', { error: err.message }));

  } catch (e) {
    log.warn?.('[dynamic-pool] Không thể tạo etcd watcher', { error: e.message });
  }

  // Heartbeat chạy kể cả khi tạo watcher lỗi (etcd chưa sẵn sàng lúc khởi động): không có nó thì lastEtcdContact
  // đứng yên và mọi lệnh ghi bị 503 ETCD_UNREACHABLE mãi sau watchWindowMs
    if (!etcdClient) {
      const pingInterval = Math.min(1000, Math.max(500, Math.floor(watchWindowMs / 2)));
      heartbeatTimer = setInterval(async () => {
        try {
          await client.get(epochKey).string();
          lastEtcdContact = Date.now();
        } catch (err) {
          log.warn?.('[dynamic-pool] Heartbeat etcd thất bại', { error: err.message });
        }
      }, pingInterval);
    }

  const wrapper = {
    isDynamic: true,

    get currentUrl() {
      return currentUrl;
    },

    get currentEpoch() {
      return currentEpoch;
    },

    getPrimaryUrl() {
      return currentUrl;
    },

    getEpoch() {
      return currentEpoch;
    },

    setEpoch(n) {
      currentEpoch = Number(n);
    },

    setLastEtcdContact(ts) {
      lastEtcdContact = ts;
    },

    setWatchWindow(ms) {
      watchWindowMs = ms;
    },

    getLastEtcdContact() {
      return lastEtcdContact;
    },

    switchPrimary(newUrl) {
      if (!newUrl || newUrl === currentUrl) return;
      log.info?.(`[dynamic-pool] Đổi kết nối Pool: ${currentUrl} -> ${newUrl}`);
      const oldPool = currentPool;
      currentUrl = newUrl;
      currentPool = poolFactory({ connectionString: newUrl });

      // Gắn lại các listener (error, connect...) sang pool mới
      for (const { event, listener } of listeners) {
        currentPool.on(event, listener);
      }

      // Đóng pool cũ an toàn
      oldPool.end?.().catch(() => {});
    },

    async checkEpoch(clientConn) {
      if (currentEpoch == null) return;

      // Điểm 1: Kiểm tra cửa sổ an toàn Lease/Watch X giây chống đọc cache etcd_epoch cũ
      const elapsed = Date.now() - lastEtcdContact;
      if (elapsed > watchWindowMs) {
        const err = new Error(`ETCD_UNREACHABLE: Mất kết nối etcd quá ${elapsed}ms (> ${watchWindowMs}ms), từ chối ghi vì etcd_epoch có thể đã cũ`);
        err.code = 'ETCD_UNREACHABLE';
        err.status = 503;
        err.details = { elapsed, watchWindowMs, etcdEpoch: currentEpoch };
        throw err;
      }

      const res = await clientConn.query('SELECT epoch FROM db_epoch LIMIT 1');
      const dbEpoch = res.rows.length ? Number(res.rows[0].epoch) : 1;
      if (dbEpoch !== currentEpoch) {
        const err = new Error(`STALE_DB_EPOCH: db_epoch (${dbEpoch}) != etcd_epoch (${currentEpoch})`);
        err.code = 'STALE_DB_EPOCH';
        err.status = 409;
        err.details = { dbEpoch, etcdEpoch: currentEpoch };
        throw err;
      }
    },

    query(...args) {
      return currentPool.query(...args);
    },

    connect(...args) {
      return currentPool.connect(...args);
    },

    on(event, listener) {
      listeners.push({ event, listener });
      currentPool.on(event, listener);
      return wrapper;
    },

    async end() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (primaryWatcher) {
        try { await primaryWatcher.cancel(); } catch { /* ignore */ }
        primaryWatcher = null;
      }
      if (epochWatcher) {
        try { await epochWatcher.cancel(); } catch { /* ignore */ }
        epochWatcher = null;
      }
      if (!etcdClient) {
        client.close();
      }
      await currentPool.end?.().catch(() => {});
    },
  };

  return wrapper;
}

module.exports = { makeDynamicPool };
