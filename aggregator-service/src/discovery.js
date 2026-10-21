// PD-09: Khám phá dịch vụ động qua etcd
//   - Khi có ETCD_ENDPOINTS, đọc toàn bộ tiền tố /nhom16/parking/nodes/ lúc khởi động rồi watch tiền tố đó.
//   - PUT: cập nhật hoặc thêm bãi vào registry, đánh dấu hasLease = true, kích hoạt health check tức thời.
//   - DELETE: gỡ lease khỏi bãi, chuyển trạng thái sang DEGRADED (nếu HTTP vẫn sống) hoặc OFFLINE (nếu cả 2 đều hỏng).

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
  pool,
  log = console,
} = {}) {
  if (!etcdEndpoints) {
    return {
      active: false,
      start: async () => {},
      stop: async () => {},
    };
  }

  const hosts = etcdEndpoints.split(',').map((s) => s.trim()).filter(Boolean);
  const client = new Etcd3({ hosts });
  let watcher = null;
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
    const zone = data.zone ?? 'bac';

    if (pool) {
      pool.query(
        `INSERT INTO parking_nodes(parking_id, name, api_url, zone, managed_by_etcd) VALUES ($1,$2,$3,$4,TRUE)
         ON CONFLICT (parking_id) DO UPDATE SET api_url = EXCLUDED.api_url, zone = EXCLUDED.zone, managed_by_etcd = TRUE`,
        [parkingId, data.name || `Bãi ${parkingId}`, url, zone]
      ).catch((e) => log.error?.('[etcd-discovery] Lỗi lưu bãi mới vào DB', { error: e.message }));
    }

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

  async function start() {
    try {
      // 1. Nạp toàn bộ khoá hiện có lúc khởi động
      const all = await client.getAll().prefix(PREFIX).strings();
      for (const [k, v] of Object.entries(all)) {
        applyPut(k, v);
      }

      // Đánh dấu bãi chưa có lease trên etcd
      for (const n of reg.all()) {
        if (!activeLeaseKeys.has(n.id) || activeLeaseKeys.get(n.id).size === 0) {
          reg.setLease(n.id, false);
        }
      }

      // 2. Watch sự kiện thay đổi
      watcher = await client.watch().prefix(PREFIX).create();
      watcher.on('put', (kv) => {
        applyPut(kv.key.toString(), kv.value.toString());
      });
      watcher.on('delete', (kv) => {
        applyDelete(kv.key.toString());
      });
      watcher.on('error', (err) => {
        log.error?.('[etcd-discovery] Watcher gặp lỗi', { error: err.message });
      });

      log.info?.(`[etcd-discovery] Đã kích hoạt watcher trên tiền tố ${PREFIX}`);
    } catch (e) {
      log.error?.('[etcd-discovery] Không thể khởi động etcd discovery', { error: e.message });
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
    start,
    stop,
    applyPut,
    applyDelete,
    activeLeaseKeys,
  };
}

module.exports = { startDiscovery, parseKey, PREFIX };
