// PD-09: Khám phá dịch vụ động qua etcd
//   - Khi có ETCD_ENDPOINTS, đọc toàn bộ tiền tố /nhom16/parking/nodes/ lúc khởi động rồi watch tiền tố đó.
//   - Chống mất sự kiện: lấy revision từ phản hồi snapshot và khởi tạo watcher bắt đầu từ revision + 1.
//   - Tự động thử lại định kỳ khi mất kết nối etcd.
//   - PUT: cập nhật hoặc thêm bãi vào registry, đánh dấu hasLease = true, kích hoạt health check tức thời.
//   - DELETE: gỡ lease khỏi bãi, chuyển trạng thái sang DEGRADED (nếu HTTP vẫn sống) hoặc OFFLINE (nếu cả 2 đều hỏng).
//   - KHÔNG ghi ngược vào DB (Issue 6).

const { Etcd3 } = require('etcd3');

const PREFIX = '/nhom16/parking/nodes/';

function parseKey(key) {
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash === -1) {
    return { parkingId: rest, hostname: 'unknown' };
  }
  return {
    parkingId: rest.slice(0, slash),
    hostname: rest.slice(slash + 1),
  };
}

function startDiscovery({
  etcdEndpoints = process.env.ETCD_ENDPOINTS,
  reg,
  log = console,
  client: injectedClient,
} = {}) {
  if (!etcdEndpoints && !injectedClient) {
    return {
      active: false,
      start: async () => {},
      stop: async () => {},
    };
  }

  const hosts = etcdEndpoints ? etcdEndpoints.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const client = injectedClient || new Etcd3({ hosts });
  let watcher = null;
  let retryTimer = null;
  let stopped = false;
  // Map lưu danh sách các active key theo parkingId: parkingId -> Set<key>
  const activeLeaseKeys = new Map();

  function applyPut(key, valStr) {
    const parsed = parseKey(key);
    if (!parsed) return;
    const { parkingId, hostname } = parsed;

    let data;
    try {
      data = typeof valStr === 'string' ? JSON.parse(valStr) : valStr;
    } catch {
      data = { url: String(valStr) };
    }

    if (!activeLeaseKeys.has(parkingId)) {
      activeLeaseKeys.set(parkingId, new Set());
    }
    activeLeaseKeys.get(parkingId).add(key);

    const url = data.url || `http://${hostname}:8001`;
    const zone = data.zone ?? null;

    let n = reg.get(parkingId);
    if (!n) {
      log.info?.(`[etcd-discovery] Phát hiện bãi mới: ${parkingId} (${url}, zone: ${zone})`);
      n = reg.add({
        parking_id: parkingId,
        name: data.name || `Bãi ${parkingId}`,
        api_url: url,
        zone,
        hasLease: true,
      });
    } else {
      n.url = url;
      if (zone) n.zone = zone;
      reg.setLease(parkingId, true);
    }

    // Lập tức kiểm tra HTTP để hoàn tất chuyển sang ONLINE trong <= 2s
    reg.checkOne(n).catch((e) => log.error?.('[etcd-discovery] Lỗi health check node mới', { error: e.message }));
  }

  function applyDelete(key) {
    const parsed = parseKey(key);
    if (!parsed) return;
    const { parkingId } = parsed;

    const set = activeLeaseKeys.get(parkingId);
    if (set) {
      set.delete(key);
    }

    if (!set || set.size === 0) {
      log.info?.(`[etcd-discovery] Bãi ${parkingId} mất toàn bộ etcd lease`);
      reg.setLease(parkingId, false);
    }
  }

  function scheduleSyncRetry(delayMs = 3000) {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      syncAndWatch().catch((e) => {
        log.warn?.('[etcd-discovery] Kết nối lại etcd chưa thành công, thử lại sau...', { error: e.message });
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

    // 1. Đọc toàn bộ snapshot ban đầu và lấy revision để chống race condition (Issue 5)
    const rangeRes = await client.getAll().prefix(PREFIX).exec();
    const revision = Number(rangeRes.header?.revision || 0);

    const seenKeys = new Set();
    if (rangeRes.kvs) {
      for (const kv of rangeRes.kvs) {
        const k = kv.key.toString();
        const v = kv.value.toString();
        seenKeys.add(k);
        applyPut(k, v);
      }
    }

    // Dọn dẹp key cũ không còn trong etcd
    for (const [pId, keySet] of activeLeaseKeys.entries()) {
      for (const k of keySet) {
        if (!seenKeys.has(k)) {
          applyDelete(k);
        }
      }
    }

    // Đánh dấu các bãi chưa có lease trên etcd
    for (const n of reg.all()) {
      if (!activeLeaseKeys.has(n.id) || activeLeaseKeys.get(n.id).size === 0) {
        reg.setLease(n.id, false);
      }
    }

    // 2. Khởi tạo watcher bắt đầu từ revision + 1 để không sót sự kiện nào (Issue 5)
    let watchBuilder = client.watch().prefix(PREFIX);
    if (revision > 0) {
      watchBuilder = watchBuilder.startRevision(revision + 1);
    }
    watcher = await watchBuilder.create();

    watcher.on('put', (kv) => {
      applyPut(kv.key.toString(), kv.value.toString());
    });
    watcher.on('delete', (kv) => {
      applyDelete(kv.key.toString());
    });
    watcher.on('error', (err) => {
      log.error?.('[etcd-discovery] Watcher gặp lỗi, sẽ tự động kết nối lại...', { error: err.message });
      if (!stopped) {
        scheduleSyncRetry(2000);
      }
    });

    log.info?.(`[etcd-discovery] Đã đồng bộ và kích hoạt watcher trên tiền tố ${PREFIX} (bắt đầu từ revision ${revision + 1})`);
  }

  async function start() {
    try {
      await syncAndWatch();
    } catch (e) {
      log.error?.('[etcd-discovery] Không thể kết nối etcd lúc khởi động, sẽ thử lại trong nền...', { error: e.message });
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
      try { await watcher.cancel(); } catch { /* bỏ qua */ }
      watcher = null;
    }
    if (!injectedClient) {
      client.close();
    }
  }

  return {
    active: true,
    client,
    start,
    stop,
    applyPut,
    applyDelete,
    syncAndWatch,
    activeLeaseKeys,
  };
}

module.exports = { startDiscovery, parseKey, PREFIX };
