// PD-09: Đăng ký dịch vụ lên etcd bằng lease
//   - Chỉ kích hoạt khi có biến ETCD_ENDPOINTS.
//   - Tạo lease TTL (mặc định 5 giây) kèm auto keepalive.
//   - Ghi khoá /nhom16/parking/nodes/<PARKING_ID>/<HOSTNAME> gắn với lease.
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
} = {}) {
  if (!etcdEndpoints) {
    return {
      active: false,
      register: async () => {},
      stop: async () => {},
      simulatePartition: async () => {},
    };
  }

  const hosts = etcdEndpoints.split(',').map((s) => s.trim()).filter(Boolean);
  const client = new Etcd3({ hosts });
  let lease = null;
  let partitionTimer = null;
  const key = `/nhom16/parking/nodes/${parkingId}/${hostname}`;
  const payload = JSON.stringify({
    url,
    zone,
    parkingId,
    hostname,
    registeredAt: new Date().toISOString(),
  });

  async function register() {
    if (lease) {
      try { await lease.revoke(); } catch { /* bỏ qua */ }
      lease = null;
    }
    lease = client.lease(leaseTtlS);
    lease.on('lost', (err) => {
      log.error?.('Mất lease etcd', { error: err?.message, parkingId, key });
    });

    await lease.put(key).value(payload);
    log.info?.(`Đã đăng ký bãi ${parkingId} lên etcd với lease TTL ${leaseTtlS}s`, { key, url, zone });
  }

  async function stop() {
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
    client.close();
  }

  // Phục vụ kiểm thử lỗi (fault injection / TC64)
  // Tạm dừng keepalive bằng lease.release() để etcd server tự đếm ngược và expire lease sau 5s
  async function simulatePartition(durationMs = 6000) {
    if (!lease) return;
    lease.release();
    lease = null;
    log.info?.(`Giả lập đứt kết nối etcd cho bãi ${parkingId} (lease sẽ tự hết hạn sau ${leaseTtlS}s)`);

    if (durationMs > 0) {
      partitionTimer = setTimeout(async () => {
        try {
          await register();
          log.info?.(`Đã phục hồi đăng ký etcd cho bãi ${parkingId}`);
        } catch (e) {
          log.error?.('Lỗi phục hồi đăng ký etcd', { error: e.message });
        }
      }, durationMs);
    }
  }

  return {
    active: true,
    client,
    key,
    payload,
    register,
    stop,
    simulatePartition,
  };
}

module.exports = { makeRegistryClient };
