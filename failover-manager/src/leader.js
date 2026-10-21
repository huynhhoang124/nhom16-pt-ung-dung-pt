// PD-14b: Bầu Leader Failover Manager qua etcd (Issue #32)
//   - Tranh cử trên khoá /nhom16/election/failover bằng lease TTL = 5s và giao dịch CAS.
//   - Chỉ bản đang là Leader mới chạy vòng lặp giám sát primary/replica và thực hiện failover.
//   - Tương thích ngược: khi không có ETCD_ENDPOINTS, isLeader() = true.

const os = require('node:os');
const { Etcd3 } = require('etcd3');

const ELECTION_KEY = '/nhom16/election/failover';

function makeLeaderElector({
  etcdEndpoints = process.env.ETCD_ENDPOINTS,
  instanceId = process.env.INSTANCE_ID || '1',
  hostname = os.hostname(),
  leaseTtlS = 5,
  log = console,
  etcdClient = null,
} = {}) {
  let leader = false;
  const startCallbacks = new Set();
  const stopCallbacks = new Set();
  let stopped = false;
  let demotedUntil = 0;
  let activeLease = null;
  let watcher = null;
  let campaignTimer = null;
  let safetyInterval = null;

  function isLeader() {
    return leader;
  }

  function onLeaderStart(fn) {
    startCallbacks.add(fn);
    if (leader) {
      try { fn(); } catch (e) { log.error?.('Lỗi onLeaderStart callback', { error: e.message }); }
    }
    return () => startCallbacks.delete(fn);
  }

  function onLeaderStop(fn) {
    stopCallbacks.add(fn);
    return () => stopCallbacks.delete(fn);
  }

  // Tương thích khi không cấu hình ETCD_ENDPOINTS
  if (!etcdEndpoints && !etcdClient) {
    leader = true;
    return {
      active: false,
      isLeader: () => true,
      getInstanceId: () => instanceId,
      getPayload: () => JSON.stringify({ instanceId, hostname, pid: process.pid }),
      getElectionKey: () => ELECTION_KEY,
      onLeaderStart: (fn) => {
        try { fn(); } catch (e) { log.error?.('Lỗi onLeaderStart callback', { error: e.message }); }
        return () => {};
      },
      onLeaderStop: () => () => {},
      demote: async () => {},
      start: async () => {},
      stop: async () => {},
    };
  }

  const client = etcdClient || new Etcd3({
    hosts: etcdEndpoints.split(',').map((s) => s.trim()).filter(Boolean),
  });

  const payload = JSON.stringify({
    instanceId,
    hostname,
    pid: process.pid,
    electedAt: new Date().toISOString(),
  });

  function handleLoseLeadership() {
    if (!leader) return;
    leader = false;
    activeLease = null;
    log.info?.(`[failover-leader] Instance ${instanceId} mất quyền Leader`);

    for (const fn of stopCallbacks) {
      try { fn(); } catch (e) { log.error?.('Lỗi onLeaderStop callback', { error: e.message }); }
    }

    scheduleCampaign(1000);
  }

  function scheduleCampaign(delayMs = 500) {
    if (stopped || leader) return;
    if (campaignTimer) clearTimeout(campaignTimer);
    campaignTimer = setTimeout(() => {
      campaignTimer = null;
      tryCampaign().catch((e) => log.error?.('[failover-leader] Lỗi khi tranh cử', { error: e.message }));
    }, delayMs);
  }

  async function tryCampaign() {
    if (stopped || leader) return;
    if (Date.now() < demotedUntil) {
      scheduleCampaign(1000);
      return;
    }

    let lease = null;
    try {
      lease = client.lease(leaseTtlS);
      lease.on('lost', (err) => {
        log.error?.('[failover-leader] Lease etcd bị mất', { error: err?.message, instanceId });
        if (activeLease === lease) {
          handleLoseLeadership();
        }
      });

      // CAS transaction: Nếu ELECTION_KEY chưa tồn tại (Version == 0) thì ghi đè với lease
      const tx = client.if(ELECTION_KEY, 'Version', '==', 0);
      const res = await tx
        .then(client.put(ELECTION_KEY).value(payload).lease(lease))
        .else(client.get(ELECTION_KEY))
        .commit();

      if (res.succeeded) {
        activeLease = lease;
        leader = true;
        log.info?.(`[failover-leader] Instance ${instanceId} đã thắng cử Leader!`);

        for (const fn of startCallbacks) {
          try { fn(); } catch (e) { log.error?.('Lỗi onLeaderStart callback', { error: e.message }); }
        }
      } else {
        try { await lease.revoke(); } catch { /* ignore */ }
      }
    } catch (e) {
      if (lease) {
        try { await lease.revoke(); } catch { /* ignore */ }
      }
      log.error?.('[failover-leader] Lỗi trong lúc thực hiện tranh cử', { error: e.message });
      scheduleCampaign(2000);
    }
  }

  async function demote() {
    if (!leader) return;
    log.info?.(`[failover-leader] Instance ${instanceId} tự rút lui (demote)`);
    demotedUntil = Date.now() + 2500;
    const lease = activeLease;
    handleLoseLeadership();
    if (lease) {
      try { await lease.revoke(); } catch { /* ignore */ }
    }
  }

  async function start() {
    try {
      watcher = await client.watch().key(ELECTION_KEY).create();
      watcher.on('delete', () => {
        log.info?.('[failover-leader] Khoá election bị xoá -> bắt đầu tranh cử');
        scheduleCampaign(100);
      });
      watcher.on('error', (err) => {
        log.error?.('[failover-leader] Watcher election lỗi', { error: err.message });
      });

      await tryCampaign();

      safetyInterval = setInterval(() => {
        if (!stopped && !leader && Date.now() >= demotedUntil) {
          tryCampaign().catch(() => {});
        }
      }, 3000);
    } catch (e) {
      log.error?.('[failover-leader] Không thể khởi động election', { error: e.message });
    }
  }

  async function stop() {
    stopped = true;
    if (campaignTimer) {
      clearTimeout(campaignTimer);
      campaignTimer = null;
    }
    if (safetyInterval) {
      clearInterval(safetyInterval);
      safetyInterval = null;
    }
    if (watcher) {
      try { await watcher.cancel(); } catch { /* ignore */ }
      watcher = null;
    }
    if (leader && activeLease) {
      try {
        await activeLease.revoke();
        log.info?.(`[failover-leader] Instance ${instanceId} đã revoke lease election`);
      } catch { /* ignore */ }
      activeLease = null;
      leader = false;
    }
    if (!etcdClient) {
      client.close();
    }
  }

  return {
    active: true,
    client,
    isLeader,
    getInstanceId: () => instanceId,
    getPayload: () => (leader ? payload : null),
    getLease: () => (leader ? activeLease : null),
    getElectionKey: () => ELECTION_KEY,
    onLeaderStart,
    onLeaderStop,
    demote,
    start,
    stop,
    tryCampaign,
  };
}

module.exports = { makeLeaderElector, ELECTION_KEY };
