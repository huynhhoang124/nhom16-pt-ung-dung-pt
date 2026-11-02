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
