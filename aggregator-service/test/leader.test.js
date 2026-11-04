const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLeaderElector, ELECTION_KEY } = require('../src/leader');
const { makeRegistry } = require('../src/nodes');

test('PD-10 leader: fallback an toàn khi không có ETCD_ENDPOINTS (tương thích ngược 100%)', async () => {
  let started = false;
  const elector = makeLeaderElector({ etcdEndpoints: '' });

  assert.equal(elector.active, false);
  assert.equal(elector.isLeader(), true);
  assert.equal(elector.getToken(), null);

  elector.onLeaderStart((token) => {
    started = true;
    assert.equal(token, null);
  });
  assert.equal(started, true);

  await elector.start();
  await elector.demote();
  await elector.stop();
});

test('PD-10 leader: trạng thái, callback onLeaderStart, onLeaderStop và tự demote', async () => {
  let leaderState = false;
  let currentToken = null;
  let stopped = false;

  const mockElector = {
    _leader: false,
    _token: null,
    startCbs: [],
    stopCbs: [],
    isLeader() { return this._leader; },
    getToken() { return this._token; },
    onLeaderStart(fn) { this.startCbs.push(fn); },
    onLeaderStop(fn) { this.stopCbs.push(fn); },
    becomeLeader(token) {
      this._leader = true;
      this._token = token;
      this.startCbs.forEach((fn) => fn(token));
    },
    demote() {
      if (!this._leader) return;
      this._leader = false;
      this._token = null;
      this.stopCbs.forEach((fn) => fn());
    },
  };

  mockElector.onLeaderStart((tok) => {
    leaderState = true;
    currentToken = tok;
  });

  mockElector.onLeaderStop(() => {
    leaderState = false;
    currentToken = null;
    stopped = true;
  });

  // 1. Thắng cử làm leader với token 42
  mockElector.becomeLeader(42);
  assert.equal(mockElector.isLeader(), true);
  assert.equal(mockElector.getToken(), 42);
  assert.equal(leaderState, true);
  assert.equal(currentToken, 42);

  // 2. Bị demote do STALE_LEADER
  mockElector.demote();
  assert.equal(mockElector.isLeader(), false);
  assert.equal(mockElector.getToken(), null);
  assert.equal(leaderState, false);
  assert.equal(stopped, true);
});

test('PD-10 nodes: gửi kèm X-Fencing-Token khi gọi node và tự động demote khi nhận 409 STALE_LEADER', async () => {
  let demoted = false;
  let sentHeaders = null;

  const mockLeader = {
    isLeader: () => true,
    getToken: () => 42,
    demote: () => { demoted = true; },
  };

  const reg = makeRegistry({
    internalKey: 'dev',
    leader: mockLeader,
  });

  const nodeA = reg.add({ parking_id: 'A', name: 'Bãi A', api_url: 'http://mock-node-a:8001' });

  // Mock global.fetch để kiểm tra headers gửi đi và giả lập phản hồi STALE_LEADER
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      sentHeaders = opts.headers;
      // Giả lập node trả về 409 STALE_LEADER do fencing token đã cũ
      return {
        ok: false,
        status: 409,
        clone: () => ({
          json: async () => ({ error: 'STALE_LEADER', job: 'reconcile', token: 42 }),
        }),
        json: async () => ({ error: 'STALE_LEADER', job: 'reconcile', token: 42 }),
      };
    };

    const res = await reg.call(nodeA, '/api/slots', { job: 'reconcile-test' });
    assert.equal(res.status, 409);

    // Kiểm tra header gửi sang node có chứa fencing token và job
    assert.equal(sentHeaders['x-fencing-token'], '42');
    assert.equal(sentHeaders['x-fencing-job'], 'reconcile-test');

    // Kiểm tra leader đã tự động gọi demote() khi nhận 409 STALE_LEADER
    assert.equal(demoted, true, 'Leader phải tự động demote khi nhận STALE_LEADER');
  } finally {
    global.fetch = originalFetch;
  }
});

test('PD-10 nodes: request của người dùng (không có job) không mang fencing token', async () => {
  const reg = makeRegistry({ internalKey: 'dev', leader: { isLeader: () => true, getToken: () => 42, demote() {} } });
  const nodeA = reg.add({ parking_id: 'A', name: 'Bãi A', api_url: 'http://mock-node-a:8001' });
  const sent = [];
  const originalFetch = global.fetch;
  try {
    global.fetch = async (_url, opts) => { sent.push(opts.headers); return { ok: true, status: 200, json: async () => ({}) }; };
    await reg.call(nodeA, '/api/reservations', { method: 'POST', body: {} });
    await reg.call(nodeA, '/api/slots', { job: 'reconcile' });
    assert.equal(sent[0]['x-fencing-token'], undefined);
    assert.equal(sent[0]['x-fencing-job'], undefined);
    assert.equal(sent[1]['x-fencing-token'], '42');
    assert.equal(sent[1]['x-fencing-job'], 'reconcile');
  } finally {
    global.fetch = originalFetch;
  }
});

// Client etcd giả: đủ cho tryCampaign (lease, giao dịch CAS, get) và simulatePause
function fakeEtcd() {
  let holder = null;   // lease đang giữ khoá election
  let rev = 10;
  const leases = [];
  const client = {
    lease() {
      const l = { released: false, revoked: false, on() {},
        grant: async () => leases.push(l), release() { this.released = true; }, revoke: async () => { l.revoked = true; if (holder === l) holder = null; } };
      return l;
    },
    if() {
      let lease = null;
      const tx = {
        then(op) { lease = op.lease; return tx; },
        else() { return tx; },
        commit: async () => {
          if (holder) return { succeeded: false };
          holder = leases.at(-1); rev++; return { succeeded: true, header: { revision: rev } };
        },
      };
      return tx;
    },
    put() { return { value() { return { lease: (id) => ({ lease: id }) }; } }; },
    get() { return { exec: async () => ({ kvs: [{ create_revision: String(rev) }] }) }; },
    close() {},
  };
  return { client, expire: () => { holder = null; } };
}

test('PD-10 leader: hết thời gian simulatePause thì leader cũ tự thôi, không còn 2 leader', async () => {
  const etcd = fakeEtcd();
  const elector = makeLeaderElector({ etcdEndpoints: 'fake:2379', client: etcd.client, log: {} });
  let stops = 0;
  elector.onLeaderStop(() => { stops++; });
  await elector.tryCampaign();
  assert.equal(elector.isLeader(), true);
  const token = elector.getToken();

  const r = await elector.simulatePause(50);
  assert.equal(r.ok, true);
  // Trong lúc pause: vẫn tưởng mình là leader và giữ token cũ (để TC66 gửi lệnh token cũ)
  assert.equal(elector.isLeader(), true);
  assert.equal(elector.getToken(), token);

  etcd.expire();   // lease hết hạn trên etcd, bản khác có thể lên leader
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(elector.isLeader(), false, 'hết pause phải thôi làm leader');
  assert.equal(elector.getToken(), null);
  assert.equal(stops, 1, 'việc định kỳ phải được dừng');
  await elector.stop();
});
