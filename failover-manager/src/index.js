// PD-14b: Entrypoint của Failover Manager Service (Issue #32)

const express = require('express');
const { Etcd3 } = require('etcd3');
const { makeLeaderElector } = require('./leader');
const { makeFailoverManager } = require('./manager');

const log = console;
const env = (k, d) => process.env[k] ?? d;

const port = Number(env('PORT', 8051));
const instanceId = env('INSTANCE_ID', '1');
const etcdEndpoints = env('ETCD_ENDPOINTS', '');
const enableTestFaults = env('ENABLE_TEST_FAULTS', '0') === '1';

// Cấu hình các bãi cần giám sát
function loadParkingsConfig() {
  if (process.env.PARKINGS) {
    try {
      const parsed = JSON.parse(process.env.PARKINGS);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
      log.warn('[failover-manager] Không thể parse PARKINGS json, dùng cấu hình mặc định', { error: e.message });
    }
  }

  // Mặc định bãi A có sẵn primary db-a và replica db-a-replica (PT-02)
  return [
    {
      parkingId: 'A',
      primaryUrl: env('PARKING_A_PRIMARY_URL', 'postgres://postgres:dev@db-a/parking'),
      replicaUrl: env('PARKING_A_REPLICA_URL', 'postgres://postgres:dev@db-a-replica/parking'),
      sync: env('PARKING_A_SYNC', 'true') === 'true',
    },
  ];
}

async function main() {
  const parkings = loadParkingsConfig();
  log.info(`[failover-manager] Khởi động Instance ${instanceId} với ${parkings.length} bãi được cấu hình:`, parkings.map((p) => p.parkingId));

  const elector = makeLeaderElector({
    etcdEndpoints,
    instanceId,
    log,
  });

  const etcdClient = elector.client || (etcdEndpoints ? new Etcd3({ hosts: etcdEndpoints.split(',') }) : null);

  const manager = makeFailoverManager({
    etcdClient,
    parkings,
    elector,
    checkIntervalMs: 1000,
    log,
  });

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'UP',
      service: 'failover-manager',
      instanceId,
      isLeader: elector.isLeader(),
    });
  });

  app.get('/status', (_req, res) => {
    res.json({
      service: 'failover-manager',
      instanceId,
      ...manager.getStatus(),
    });
  });

  // PD-25: số đo cho Prometheus, viết tay dạng text (2 số, không cần thêm prom-client)
  app.get('/metrics', (_req, res) => {
    const st = manager.getStatus();
    const lines = [
      '# HELP failover_is_leader 1 nếu bản failover-manager này giữ khoá leader', '# TYPE failover_is_leader gauge',
      `failover_is_leader{instance_id="${instanceId}"} ${st.isLeader ? 1 : 0}`,
      '# HELP failover_total Số lần failover thành công do bản này thực hiện', '# TYPE failover_total counter',
      ...st.parkings.map((p) => `failover_total{instance_id="${instanceId}",parking="${p.parkingId}"} ${p.failovers}`),
      '# HELP failover_degraded_async 1 nếu bãi đồng bộ đã hạ xuống bất đồng bộ', '# TYPE failover_degraded_async gauge',
      ...st.parkings.map((p) => `failover_degraded_async{instance_id="${instanceId}",parking="${p.parkingId}"} ${p.degradedToAsync ? 1 : 0}`),
    ];
    res.set('content-type', 'text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });

  // Endpoints kiểm thử có kiểm soát lỗi
  if (enableTestFaults) {
    app.post('/api/test/failover/:parkingId', async (req, res) => {
      const state = manager.parkingStates.find((p) => p.parkingId === req.params.parkingId);
      if (!state) return res.status(404).json({ error: 'PARKING_NOT_FOUND' });
      const result = await manager.doFailover(state);
      res.json(result);
    });

    app.post('/api/test/degrade/:parkingId', async (req, res) => {
      const state = manager.parkingStates.find((p) => p.parkingId === req.params.parkingId);
      if (!state) return res.status(404).json({ error: 'PARKING_NOT_FOUND' });
      await manager.degradeToAsync(state);
      res.json({ ok: true, degradedToAsync: state.degradedToAsync });
    });
  }

  const server = app.listen(port, () => {
    log.info(`[failover-manager] Instance ${instanceId} đang lắng nghe tại cổng ${port}`);
  });

  await elector.start();
  manager.start();

  const cleanup = async () => {
    log.info('[failover-manager] Đang dừng service...');
    manager.stop();
    await elector.stop();
    server.close();
    process.exit(0);
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
}

main().catch((err) => {
  log.error('[failover-manager] Khởi động thất bại', err);
  process.exit(1);
});
