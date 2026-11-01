// PD-14b: Failover Manager Core Logic (Issue #32)
//   - Giám sát primary mỗi 1 giây (SELECT 1 timeout 500ms).
//   - 3 lần lỗi liên tiếp -> đọc replay LSN của replica -> Bước A (CAS tăng epoch trên etcd) -> Bước B (chờ cửa sổ an toàn
//     để node ngừng ghi vào primary cũ) -> Bước C (pg_promote trên replica) -> Bước 4 (ghi db_epoch vào primary mới).
//   - CAS thất bại -> dừng ngay, KHÔNG promote. Promote lỗi -> giữ epoch N+1 (không giảm), báo FAILOVER_PROMOTE_FAILED.
//   - Giám sát replica của bãi đồng bộ (sync=true): chết quá 3s -> ALTER SYSTEM RESET synchronous_standby_names trên primary.

const { Client } = require('pg');

function defaultPgClientFactory(url, timeoutMs = 10000) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: Math.max(10000, timeoutMs),
  });
  return {
    async connect() {
      await client.connect();
      return this;
    },
    query(...args) {
      return client.query(...args);
    },
    end() {
      return client.end().catch(() => {});
    },
  };
}

function makeFailoverManager({
  etcdClient,
  parkings = [],
  elector,
  checkIntervalMs = 1000,
  waitWindowMs = process.env.FAILOVER_WAIT_WINDOW_MS !== undefined
    ? Number(process.env.FAILOVER_WAIT_WINDOW_MS)
    : (process.env.NODE_ENV === 'test' ? 10 : 3500),
  log = console,
  pgClientFactory = defaultPgClientFactory,
} = {}) {
  let timer = null;
  let running = false;
  let isChecking = false;

  // Khởi tạo trạng thái cho từng bãi
  const parkingStates = parkings.map((p) => ({
    parkingId: p.parkingId,
    primaryUrl: p.primaryUrl,
    replicaUrl: p.replicaUrl,
    sync: Boolean(p.sync),
    primaryFailures: 0,
    replicaFailures: 0,
    replicaDownSince: null,
    degradedToAsync: false,
    isFailingOver: false,
  }));

  // Đồng bộ primary/epoch từ etcd để follower instance cũng luôn biết primary hiện tại
  if (etcdClient) {
    for (const state of parkingStates) {
      const primaryKey = `/nhom16/parking/${state.parkingId}/db/primary`;
      const updateFromEtcd = (val) => {
        if (val && val !== state.primaryUrl) {
          log.info?.(`[failover-manager] Cập nhật primary bãi ${state.parkingId} từ etcd: ${state.primaryUrl} -> ${val}`);
          state.primaryUrl = val;
        }
      };

      etcdClient.get(primaryKey).string().then(updateFromEtcd).catch(() => {});
      if (typeof etcdClient.watch === 'function') {
        etcdClient.watch().key(primaryKey).create().then((w) => {
          w.on('put', (res) => updateFromEtcd(res.value?.toString()));
        }).catch(() => {});
      }
    }
  }

  async function checkPrimary(state) {
    let client = null;
    try {
      client = await pgClientFactory(state.primaryUrl, 3000);
      await client.connect();
      await client.query('SELECT 1');
      state.primaryFailures = 0;
      return true;
    } catch (err) {
      state.primaryFailures += 1;
      log.warn?.(`[failover-manager] Ping primary bãi ${state.parkingId} thất bại (${state.primaryFailures}/3): ${err.message}`);
      return false;
    } finally {
      if (client) await client.end();
    }
  }

  async function checkReplica(state) {
    if (!state.replicaUrl) return true;
    let client = null;
    try {
      client = await pgClientFactory(state.replicaUrl, 3000);
      await client.connect();
      await client.query('SELECT 1');
      state.replicaFailures = 0;
      state.replicaDownSince = null;
      return true;
    } catch (err) {
      state.replicaFailures += 1;
      if (!state.replicaDownSince) {
        state.replicaDownSince = Date.now();
      }
      const downDuration = Date.now() - state.replicaDownSince;
      log.warn?.(`[failover-manager] Ping replica bãi ${state.parkingId} thất bại (${downDuration}ms): ${err.message}`);

      // Mục 7.2 - TC70: Bãi đồng bộ có replica chết quá 3s -> hạ cấp sang async
      if (state.sync && !state.degradedToAsync && (downDuration >= 3000 || state.replicaFailures >= 3) && state.primaryFailures === 0) {
        await degradeToAsync(state);
      }
      return false;
    } finally {
      if (client) await client.end();
    }
  }

  async function degradeToAsync(state) {
    let client = null;
    try {
      log.warn?.(`WARN: degraded sync replication to async for parking ${state.parkingId}. Trade-off: Consistency -> Availability after 3s down. RPO > 0: transactions committed during async window may be lost if primary crashes`);
      client = await pgClientFactory(state.primaryUrl, 2000);
      await client.connect();
      await client.query('ALTER SYSTEM RESET synchronous_standby_names');
      await client.query('SELECT pg_reload_conf()');
      state.degradedToAsync = true;
      log.info?.(`[failover-manager] Đã chuyển bãi ${state.parkingId} sang chế độ async thành công`);
    } catch (err) {
      log.error?.(`[failover-manager] Lỗi khi hạ cấp sync->async cho bãi ${state.parkingId}: ${err.message}`);
    } finally {
      if (client) await client.end();
    }
  }

  async function doFailover(state) {
    if (state.isFailingOver) return { ok: false, reason: 'ALREADY_FAILING_OVER' };
    if (!state.replicaUrl) return { ok: false, reason: 'NO_REPLICA' };

    const targetReplicaUrl = state.replicaUrl;
    state.isFailingOver = true;
    log.info?.(`[failover-manager] === BẮT ĐẦU FAILOVER CHO BÃI ${state.parkingId} ===`);

    try {
      let replicaClient = null;
      let nextEpoch = 2;
      try {
        // Bước 1: Kết nối sang replica, đọc SELECT pg_last_wal_replay_lsn() để kiểm tra replica còn sống
        log.info?.(`[failover-manager] Bước 1: Kiểm tra replica còn sống (SELECT pg_last_wal_replay_lsn)...`);
        replicaClient = await pgClientFactory(targetReplicaUrl, 5000);
        await replicaClient.connect();
        const lsnRes = await replicaClient.query('SELECT pg_last_wal_replay_lsn() AS lsn');
        const lsn = lsnRes.rows?.[0]?.lsn;
        log.info?.(`[failover-manager] Replica bãi ${state.parkingId} còn sống, last replay LSN: ${lsn}`);

        // Bước A (Giao dịch CAS nguyên tử trên etcd TRƯỚC KHI promote):
        // Gộp cả 2 điều kiện:
        // 1) Khoá bầu leader /nhom16/election/failover vẫn đang thuộc về bản failover-manager hiện tại
        // 2) Khoá /nhom16/parking/<bãi>/db/epoch hiện tại bằng N
        // Nếu giao dịch CAS thất bại -> dừng ngay lập tức, tuyệt đối KHÔNG gọi pg_promote()
        log.info?.(`[failover-manager] Bước A: Giao dịch CAS trên etcd tăng epoch cho bãi ${state.parkingId}...`);
        if (elector && !elector.isLeader()) {
          log.warn?.(`[failover-manager] Bản thân không còn là Leader -> huỷ failover bãi ${state.parkingId}`);
          return { ok: false, reason: 'NOT_LEADER' };
        }

        const epochKey = `/nhom16/parking/${state.parkingId}/db/epoch`;
        const primaryKey = `/nhom16/parking/${state.parkingId}/db/primary`;
        const electionKey = elector?.getElectionKey?.() || '/nhom16/election/failover';
        const leaderPayload = elector?.getPayload?.();

        const currentEpochStr = await etcdClient.get(epochKey).string();
        const N = currentEpochStr ? Number(currentEpochStr) : 1;
        nextEpoch = N + 1;

        let casCondition = currentEpochStr
          ? etcdClient.if(epochKey, 'Value', '==', String(N))
          : etcdClient.if(epochKey, 'Version', '==', 0);

        if (leaderPayload) {
          casCondition = casCondition.and(electionKey, 'Value', '==', leaderPayload);
        }

        const casRes = await casCondition
          .then(etcdClient.put(epochKey).value(String(nextEpoch)))
          .else(etcdClient.get(epochKey))
          .commit();

        if (!casRes.succeeded) {
          log.warn?.(`[failover-manager] Giao dịch CAS trên etcd thất bại cho bãi ${state.parkingId} (mất quyền leader hoặc epoch đã đổi) -> Dừng ngay, KHÔNG promote replica.`);
          return { ok: false, reason: 'CAS_FAILED' };
        }
        log.info?.(`[failover-manager] Bước A: CAS etcd thành công: epoch=${nextEpoch} cho bãi ${state.parkingId}`);

        // Bước B: Chờ một khoảng waitWindowMs (> X giây) nhằm đảm bảo mọi kết nối ở Node đang giữ epoch = N cũ hoặc đã nhận được watch epoch = N + 1, hoặc đã hết hạn cửa sổ X giây và ngừng ghi vào Primary cũ.
        if (waitWindowMs > 0) {
          log.info?.(`[failover-manager] Bước B: Chờ cửa sổ an toàn ${waitWindowMs}ms trước khi promote replica...`);
          await new Promise((resolve) => setTimeout(resolve, waitWindowMs));
        }

        // Bước C: Gọi SELECT pg_promote() trên Replica
        log.info?.(`[failover-manager] Bước C: Thăng cấp replica thành primary (SELECT pg_promote)...`);
        try {
          await replicaClient.query('SELECT pg_promote()');
          log.info?.(`[failover-manager] Đã gọi pg_promote() thành công trên replica bãi ${state.parkingId}`);
        } catch (promoteErr) {
          // Bước D (Xử lý khi pg_promote() thất bại): Nếu pg_promote() ném lỗi, giữ nguyên epoch = N + 1 (không bao giờ giảm epoch), ghi log cảnh báo CRITICAL: FAILOVER_PROMOTE_FAILED và không trỏ primary sang replica lỗi.
          log.error?.(`CRITICAL: FAILOVER_PROMOTE_FAILED cho bãi ${state.parkingId}: ${promoteErr.message}`);
          return { ok: false, error: 'FAILOVER_PROMOTE_FAILED', epoch: nextEpoch, message: promoteErr.message };
        }

        // Cập nhật primary trên etcd sau khi promote thành công
        await etcdClient.put(primaryKey).value(targetReplicaUrl);
      } finally {
        if (replicaClient) await replicaClient.end().catch(() => {});
      }

      // Bước 4: Ghi epoch mới (nextEpoch) vào bảng db_epoch trên primary mới (replica vừa thăng cấp)
      log.info?.(`[failover-manager] Bước 4: Ghi epoch ${nextEpoch} vào bảng db_epoch trên primary mới...`);
      let updateOk = false;
      for (let attempt = 1; attempt <= 10; attempt++) {
        let newPrimaryClient = null;
        try {
          newPrimaryClient = await pgClientFactory(targetReplicaUrl, 5000);
          await newPrimaryClient.connect();
          const updateRes = await newPrimaryClient.query('UPDATE db_epoch SET epoch = $1', [nextEpoch]);
          if ((updateRes.rowCount ?? 0) === 0) {
            await newPrimaryClient.query('INSERT INTO db_epoch(epoch) VALUES ($1)', [nextEpoch]);
          }
          log.info?.(`[failover-manager] Cập nhật db_epoch thành công với epoch ${nextEpoch}`);
          updateOk = true;
          break;
        } catch (upErr) {
          log.warn?.(`[failover-manager] Thử cập nhật db_epoch lần ${attempt}/10: ${upErr.message}`);
          await new Promise((r) => setTimeout(r, 500));
        } finally {
          if (newPrimaryClient) await newPrimaryClient.end().catch(() => {});
        }
      }
      if (!updateOk) {
        throw new Error(`Không thể cập nhật db_epoch lên primary mới sau 10 lần thử`);
      }

      // Cập nhật cấu hình bãi trong bộ nhớ
      const oldPrimary = state.primaryUrl;
      state.primaryUrl = targetReplicaUrl;
      state.replicaUrl = null;
      state.primaryFailures = 0;
      log.info?.(`[failover-manager] === HOÀN TẤT FAILOVER BÃI ${state.parkingId}! ${oldPrimary} -> ${state.primaryUrl} (epoch ${nextEpoch}) ===`);
      return { ok: true, newPrimary: state.primaryUrl, epoch: nextEpoch };
    } catch (err) {
      log.error?.(`[failover-manager] Lỗi trong lúc thực hiện failover bãi ${state.parkingId}: ${err?.message || err}`);
      return { ok: false, error: err?.message || String(err) };
    } finally {
      state.isFailingOver = false;
    }
  }

  async function checkParking(state) {
    if (state.isFailingOver) return;

    const primaryAlive = await checkPrimary(state);
    if (!primaryAlive) {
      if (state.primaryFailures >= 3 && state.replicaUrl) {
        await doFailover(state);
      }
      return;
    }

    // Nếu primary sống, kiểm tra replica
    await checkReplica(state);
  }

  async function checkOnce() {
    if (isChecking) return;
    isChecking = true;
    try {
      if (!elector || !elector.isLeader()) return;
      for (const state of parkingStates) {
        try {
          await checkParking(state);
        } catch (err) {
          log.error?.(`[failover-manager] Lỗi khi kiểm tra bãi ${state.parkingId}`, { error: err.message });
        }
      }
    } finally {
      isChecking = false;
    }
  }

  function start() {
    if (running) return;
    running = true;

    if (elector) {
      elector.onLeaderStart(() => {
        log.info?.('[failover-manager] Nhận quyền Leader -> Bắt đầu vòng lặp kiểm tra failover');
        if (!timer) {
          timer = setInterval(() => {
            checkOnce().catch(() => {});
          }, checkIntervalMs);
        }
      });

      elector.onLeaderStop(() => {
        log.info?.('[failover-manager] Mất quyền Leader -> Dừng vòng lặp kiểm tra failover');
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      });

      if (elector.isLeader()) {
        timer = setInterval(() => {
          checkOnce().catch(() => {});
        }, checkIntervalMs);
      }
    } else {
      timer = setInterval(() => {
        checkOnce().catch(() => {});
      }, checkIntervalMs);
    }
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return {
      isLeader: elector ? elector.isLeader() : true,
      parkings: parkingStates.map((s) => ({
        parkingId: s.parkingId,
        primaryUrl: s.primaryUrl,
        replicaUrl: s.replicaUrl,
        sync: s.sync,
        primaryFailures: s.primaryFailures,
        replicaFailures: s.replicaFailures,
        degradedToAsync: s.degradedToAsync,
        isFailingOver: s.isFailingOver,
      })),
    };
  }

  return {
    start,
    stop,
    checkOnce,
    checkParking,
    checkPrimary,
    checkReplica,
    doFailover,
    degradeToAsync,
    getStatus,
    parkingStates,
  };
}

module.exports = { makeFailoverManager };
