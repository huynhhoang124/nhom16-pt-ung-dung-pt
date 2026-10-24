// PD-09: Đăng ký dịch vụ lên etcd bằng lease
//   - Chỉ kích hoạt khi có biến ETCD_ENDPOINTS.
//   - Tạo lease TTL (mặc định 5 giây) kèm auto keepalive.
//   - Ghi khoá /nhom16/parking/nodes/<PARKING_ID>/<HOSTNAME> gắn với lease.
//   - Tự động thử lại liên tục khi mất lease (lease lost) cho tới khi thành công.
//   - Khi tắt node (graceful shutdown), revoke lease; nếu đứt kết nối, lease tự hết hạn sau 5s.

const os = require('node:os');
const { Etcd3 } = require('etcd3');

function makeRegistryClient({
  etcdEndpoints = process.env.ETCD_ENDPOINTS,
  parkingId = process.env.PARKING_ID || 'A',
  hostname = os.hostname(),
  port = Number(process.env.PORT || 8001),
  url = process.env.NODE_URL || `http://${hostname}:${port}`,
  zone = process.env.ZONE || 'bac',
  leaseTtlS = Number(process.env.LEASE_TTL_S || 5),
  log = console,
  client: injectedClient,
} = {}) {
  if (!etcdEndpoints && !injectedClient) {
    return {
      active: false,
      register: async () => {},
      start: async () => {},
      stop: async () => {},
      simulatePartition: async () => {},
      scheduleRetry: () => {},
    };
  }

  const hosts = etcdEndpoints ? etcdEndpoints.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const client = injectedClient || new Etcd3({ hosts });
  let lease = null;
  let partitionTimer = null;
  let retryTimer = null;
  let stopped = false;
  let partitioning = false;

  const key = `/nhom16/parking/nodes/${parkingId}/${hostname}`;
  const payload = JSON.stringify({
    url,
    zone,
    parkingId,
    hostname,
    registeredAt: new Date().toISOString(),
  });

  function scheduleRetry(delayMs = 1000) {
    if (stopped || retryTimer || partitioning) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (stopped || partitioning) return;
      try {
        await register();
      } catch (err) {
        log.error?.('[registry] Thử đăng ký lại lease etcd thất bại, sẽ thử tiếp...', { error: err.message, parkingId });
        scheduleRetry(Math.min(delayMs * 1.5, 5000));
      }
    }, delayMs);
  }

  async function register() {
    if (stopped) return;
    if (lease) {
      try { await lease.revoke(); } catch { /* bỏ qua */ }
      lease = null;
    }

    lease = client.lease(leaseTtlS);
    lease.on('lost', (err) => {
      log.error?.('Mất lease etcd', { error: err?.message, parkingId, key });
      lease = null;
      if (!stopped && !partitioning) {
        api.scheduleRetry(1000);
      }
    });

    try {
      await lease.put(key).value(payload);
      log.info?.(`Đã đăng ký bãi ${parkingId} lên etcd với lease TTL ${leaseTtlS}s`, { key, url, zone });
    } catch (err) {
      if (lease) {
        try { lease.release(); } catch { /* bỏ qua */ }
        lease = null;
      }
      throw err;
    }
  }

  async function start() {
    if (stopped) return;
    try {
      await register();
    } catch (err) {
      log.warn?.('[registry] Đăng ký etcd ban đầu thất bại, sẽ tự động thử lại trong nền...', { error: err.message, parkingId });
      api.scheduleRetry(1000);
    }
  }

  async function stop() {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (partitionTimer) {
      clearTimeout(partitionTimer);
      partitionTimer = null;
    }
    if (lease) {
      try {
        await lease.revoke();
        log.info?.(`Đã revoke lease etcd cho ${key}`);
      } catch (e) {
        log.error?.('Lỗi revoke lease etcd', { error: e.message });
      }
      lease = null;
    }
    if (!injectedClient) {
      client.close();
    }
  }

  // Phục vụ kiểm thử lỗi (fault injection / TC64)
  // Tạm dừng keepalive bằng lease.release() để etcd server tự đếm ngược và expire lease sau 5s
  async function simulatePartition(durationMs = 6000) {
    if (!lease) return;
    partitioning = true;
    try { lease.release(); } catch { /* bỏ qua */ }
    lease = null;
    log.info?.(`Giả lập đứt kết nối etcd cho bãi ${parkingId} (lease sẽ tự hết hạn sau ${leaseTtlS}s)`);

    if (durationMs > 0) {
      partitionTimer = setTimeout(async () => {
        partitioning = false;
        partitionTimer = null;
        try {
          await register();
          log.info?.(`Đã phục hồi đăng ký etcd cho bãi ${parkingId}`);
        } catch (e) {
          log.error?.('Lỗi phục hồi đăng ký etcd, lập lịch thử lại', { error: e.message });
          scheduleRetry(1000);
        }
      }, durationMs);
    }
  }

  const api = {
    active: true,
    client,
    key,
    payload,
    register,
    start,
    stop,
    simulatePartition,
    scheduleRetry: (delayMs) => scheduleRetry(delayMs),
  };
  return api;
}

module.exports = { makeRegistryClient };
