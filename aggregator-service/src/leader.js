// PD-10: Bầu Leader Aggregator & Fencing Token qua etcd (Issue #27)
//   - Tranh cử trên khoá /nhom16/election/aggregator-jobs bằng lease TTL = 5s và giao dịch CAS.
//   - Khi thắng cử: Lấy revision tạo khoá trên etcd làm fencingToken (tăng đơn điệu).
//   - Cung cấp API: isLeader(), getToken(), onLeaderStart(fn), onLeaderStop(fn), demote(), stop().
//   - Khi mất lease hoặc nhận lỗi STALE_LEADER: lập tức dừng các việc định kỳ, đặt lại token.
//   - Tương thích ngược 100%: Khi ETCD_ENDPOINTS trống, isLeader() = true, getToken() = null.

const os = require('node:os');
const { Etcd3 } = require('etcd3');

const ELECTION_KEY = '/nhom16/election/aggregator-jobs';

function makeLeaderElector({
  etcdEndpoints = process.env.ETCD_ENDPOINTS,
  instanceId = process.env.INSTANCE_ID || '1',
  hostname = os.hostname(),
  leaseTtlS = 5,
  log = console,
} = {}) {
  let leader = false;
  let fencingToken = null;
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

  function getToken() {
    return fencingToken;
  }

  function onLeaderStart(fn) {
    startCallbacks.add(fn);
    if (leader) {
      try { fn(fencingToken); } catch (e) { log.error?.('Lỗi onLeaderStart callback', { error: e.message }); }
    }
    return () => startCallbacks.delete(fn);
  }

  function onLeaderStop(fn) {
    stopCallbacks.add(fn);
    return () => stopCallbacks.delete(fn);
  }

  // Tương thích ngược 100% khi không cấu hình ETCD_ENDPOINTS
  if (!etcdEndpoints) {
    leader = true;
    return {
      active: false,
      isLeader: () => true,
      getToken: () => null,
      getInstanceId: () => instanceId,
      onLeaderStart: (fn) => {
        try { fn(null); } catch (e) { log.error?.('Lỗi onLeaderStart callback', { error: e.message }); }
        return () => {};
      },
      onLeaderStop: () => () => {},
      demote: async () => {},
      start: async () => {},
      stop: async () => {},
      simulatePause: async () => ({ ok: false, message: 'etcd not enabled' }),
    };
  }

  const hosts = etcdEndpoints.split(',').map((s) => s.trim()).filter(Boolean);
  const client = new Etcd3({ hosts });

  const payload = JSON.stringify({
    instanceId,
    hostname,
    pid: process.pid,
    electedAt: new Date().toISOString(),
  });

  function handleLoseLeadership() {
    if (!leader) return;
    leader = false;
    const oldToken = fencingToken;
    fencingToken = null;
    activeLease = null;
    log.info?.(`[leader-election] Instance ${instanceId} mất quyền Leader (token cũ: ${oldToken})`);

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
      tryCampaign().catch((e) => log.error?.('[leader-election] Lỗi khi tranh cử', { error: e.message }));
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
        log.error?.('[leader-election] Lease etcd bị mất', { error: err?.message, instanceId });
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

        // Lấy revision tạo khoá trên etcd làm fencing token
        const getRes = await client.get(ELECTION_KEY).exec();
        const kv = getRes.kvs?.[0];
        fencingToken = Number(kv?.create_revision || res.header?.revision || 1);

        log.info?.(`[leader-election] Instance ${instanceId} đã thắng cử Leader! Fencing token: ${fencingToken}`);

        for (const fn of startCallbacks) {
          try { fn(fencingToken); } catch (e) { log.error?.('Lỗi onLeaderStart callback', { error: e.message }); }
        }
      } else {
        // Không thắng cử: thu hồi lease tạm này
        try { await lease.revoke(); } catch { /* ignore */ }
      }
    } catch (e) {
      if (lease) {
        try { await lease.revoke(); } catch { /* ignore */ }
      }
      log.error?.('[leader-election] Lỗi trong lúc thực hiện tranh cử', { error: e.message });
      scheduleCampaign(2000);
    }
  }

  async function demote() {
    if (!leader) return;
    log.info?.(`[leader-election] Instance ${instanceId} tự rút lui (demote) do STALE_LEADER (token: ${fencingToken})`);
    demotedUntil = Date.now() + 2500; // Cooldown 2.5s để bản kia lên làm leader
    const lease = activeLease;
    handleLoseLeadership();
    if (lease) {
      try { await lease.revoke(); } catch { /* ignore */ }
    }
  }

  // Phục vụ kiểm thử TC66: Giả lập leader bị pause/treo (ngắt keepalive, giữ token cũ trong RAM)
  async function simulatePause(durationMs = 15000) {
    if (!leader || !activeLease) return { ok: false, message: 'Not current leader' };
    log.info?.(`[leader-election] Instance ${instanceId} giả lập pause leader ${durationMs}ms`);
    const oldToken = fencingToken;
    activeLease.release();
    activeLease = null;
    demotedUntil = Date.now() + durationMs;
    return { ok: true, durationMs, oldToken };
  }

  async function start() {
    try {
      // 1. Watcher trên khoá election để biết khi nào leader cũ từ chức / hết hạn lease
      watcher = await client.watch().key(ELECTION_KEY).create();
      watcher.on('delete', () => {
        log.info?.('[leader-election] Khoá election bị xoá -> bắt đầu tranh cử');
        scheduleCampaign(100);
      });
      watcher.on('error', (err) => {
        log.error?.('[leader-election] Watcher election lỗi', { error: err.message });
      });

      // 2. Chạy tranh cử ngay lúc khởi động
      await tryCampaign();

      // 3. Vòng lặp an toàn kiểm tra định kỳ
      safetyInterval = setInterval(() => {
        if (!stopped && !leader && Date.now() >= demotedUntil) {
          tryCampaign().catch(() => {});
        }
      }, 3000);
    } catch (e) {
      log.error?.('[leader-election] Không thể khởi động election', { error: e.message });
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
        log.info?.(`[leader-election] Instance ${instanceId} đã revoke lease election`);
      } catch { /* ignore */ }
      activeLease = null;
      leader = false;
      fencingToken = null;
    }
    client.close();
  }

  return {
    active: true,
    client,
    isLeader,
    getToken,
    getInstanceId: () => instanceId,
    onLeaderStart,
    onLeaderStop,
    demote,
    simulatePause,
    start,
    stop,
    tryCampaign,
  };
}

module.exports = { makeLeaderElector, ELECTION_KEY };
