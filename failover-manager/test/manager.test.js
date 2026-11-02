const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFailoverManager } = require('../src/manager');

// Mock Etcd3 Client
function makeMockEtcd() {
  const store = new Map();
  return {
    store,
    get(k) {
      return {
        string: async () => store.get(k) ?? null,
      };
    },
    put(k) {
      return {
        value(v) {
          const obj = {
            op: 'put',
            key: k,
            val: v,
            then(resolve) {
              store.set(k, v);
              if (typeof resolve === 'function') resolve({ ok: true });
            },
          };
          return obj;
        },
      };
    },
    if(k, field, op, val) {
      const conds = [{ k, field, op, val }];
      let thenOps = [];
      let elseOps = [];

      function checkCond(c) {
        const cur = store.get(c.k);
        if (c.field === 'Version' && c.op === '==' && c.val === 0) {
          return cur === undefined;
        } else if (c.field === 'Value' && c.op === '==') {
          return String(cur) === String(c.val);
        }
        return false;
      }

      const builder = {
        and(k2, field2, op2, val2) {
          conds.push({ k: k2, field: field2, op: op2, val: val2 });
          return builder;
        },
        then(...ops) {
          thenOps = ops;
          return builder;
        },
        else(...ops) {
          elseOps = ops;
          return builder;
        },
        async commit() {
          const allPassed = conds.every(checkCond);
          if (allPassed) {
            for (const opItem of thenOps) {
              if (opItem.op === 'put') {
                store.set(opItem.key, opItem.val);
              }
            }
            return { succeeded: true };
          }
          return { succeeded: false };
        },
      };
      return builder;
    },
  };
}

test('PD-14b manager: phát hiện 3 lần lỗi primary -> promote replica -> CAS etcd -> update db_epoch', async () => {
  const etcd = makeMockEtcd();
  etcd.store.set('/nhom16/parking/A/db/epoch', '1');
  etcd.store.set('/nhom16/parking/A/db/primary', 'postgres://primary-a');

  const executedQueries = [];
  const primaryDown = { value: false };

  const pgClientFactory = (url) => {
    return {
      async connect() {
        if (url === 'postgres://primary-a' && primaryDown.value) {
          throw new Error('Connection refused to primary-a');
        }
      },
      async query(sql, params) {
        executedQueries.push({ url, sql, params });
        if (sql === 'SELECT pg_last_wal_replay_lsn() AS lsn') {
          return { rows: [{ lsn: '0/3000060' }] };
        }
        if (sql.includes('UPDATE db_epoch')) {
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
      async end() {},
    };
  };

  const elector = {
    isLeader: () => true,
    getPayload: () => '{"instanceId":"1"}',
    getElectionKey: () => '/nhom16/election/failover',
    onLeaderStart: () => () => {},
    onLeaderStop: () => () => {},
  };
  etcd.store.set('/nhom16/election/failover', '{"instanceId":"1"}');

  const manager = makeFailoverManager({
    etcdClient: etcd,
    parkings: [
      {
        parkingId: 'A',
        primaryUrl: 'postgres://primary-a',
        replicaUrl: 'postgres://replica-a',
        sync: true,
      },
    ],
    elector,
    pgClientFactory,
    waitWindowMs: 10,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  // Lần 1: Primary còn sống
  await manager.checkOnce();
  assert.equal(manager.parkingStates[0].primaryFailures, 0);

  // Đánh dấu Primary chết
  primaryDown.value = true;

  // Lỗi lần 1
  await manager.checkOnce();
  assert.equal(manager.parkingStates[0].primaryFailures, 1);
  assert.equal(manager.parkingStates[0].primaryUrl, 'postgres://primary-a');

  // Lỗi lần 2
  await manager.checkOnce();
  assert.equal(manager.parkingStates[0].primaryFailures, 2);
  assert.equal(manager.parkingStates[0].primaryUrl, 'postgres://primary-a');

  // Lỗi lần 3 -> Kích hoạt failover!
  await manager.checkOnce();

  // Kiểm tra replica được promote
  const promoteQuery = executedQueries.find((q) => q.url === 'postgres://replica-a' && q.sql === 'SELECT pg_promote()');
  assert.ok(promoteQuery, 'Phải gọi pg_promote trên replica');

  // Kiểm tra etcd epoch tăng lên 2 và primary trỏ sang replica-a
  assert.equal(etcd.store.get('/nhom16/parking/A/db/epoch'), '2');
  assert.equal(etcd.store.get('/nhom16/parking/A/db/primary'), 'postgres://replica-a');

  // Kiểm tra db_epoch được ghi lên primary mới với epoch = 2
  const epochUpdateQuery = executedQueries.find((q) => q.url === 'postgres://replica-a' && q.sql.includes('UPDATE db_epoch'));
  assert.ok(epochUpdateQuery, 'Phải cập nhật db_epoch trên primary mới');
  assert.deepEqual(epochUpdateQuery.params, [2]);

  // Kiểm tra cấu hình trong bộ nhớ đã chuyển sang primary mới
  assert.equal(manager.parkingStates[0].primaryUrl, 'postgres://replica-a');
  assert.equal(manager.parkingStates[0].replicaUrl, null);
  assert.equal(manager.parkingStates[0].primaryFailures, 0);
});

test('PD-14b manager: dừng ngay nếu giao dịch CAS trên etcd thất bại', async () => {
  const etcd = makeMockEtcd();
  // Giả sử epoch trên etcd đã bị ai đó đổi thành 9
  etcd.store.set('/nhom16/parking/A/db/epoch', '9');

  // Tạo mock etcd mà commit luôn trả về false (CAS thất bại)
  const failingCasEtcd = {
    get: etcd.get,
    put: etcd.put,
    if: () => ({
      then: () => ({
        else: () => ({
          commit: async () => ({ succeeded: false }),
        }),
      }),
    }),
  };

  const executedQueries = [];
  const pgClientFactory = (url) => ({
    async connect() {},
    async query(sql, params) {
      executedQueries.push({ url, sql, params });
      if (sql === 'SELECT pg_last_wal_replay_lsn() AS lsn') {
        return { rows: [{ lsn: '0/123' }] };
      }
      return { rows: [] };
    },
    async end() {},
  });

  const state = {
    parkingId: 'A',
    primaryUrl: 'postgres://primary-a',
    replicaUrl: 'postgres://replica-a',
    sync: true,
    primaryFailures: 3,
    isFailingOver: false,
  };

  const elector = { isLeader: () => true };
  const manager = makeFailoverManager({
    etcdClient: failingCasEtcd,
    parkings: [state],
    elector,
    pgClientFactory,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const res = await manager.doFailover(manager.parkingStates[0]);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'CAS_FAILED');

  // Tuyệt đối không được gọi pg_promote và không được cập nhật db_epoch vì CAS thất bại
  const promoteCalled = executedQueries.some((q) => q.sql === 'SELECT pg_promote()');
  assert.equal(promoteCalled, false, 'Tuyệt đối không được gọi pg_promote khi CAS thất bại');
  const epochUpdated = executedQueries.some((q) => q.sql.includes('UPDATE db_epoch'));
  assert.equal(epochUpdated, false, 'Không được cập nhật db_epoch khi CAS thất bại');
});

test('PD-14b manager: huỷ failover và không promote nếu mất quyền leader key trên etcd', async () => {
  const etcd = makeMockEtcd();
  etcd.store.set('/nhom16/parking/A/db/epoch', '1');
  etcd.store.set('/nhom16/parking/A/db/primary', 'postgres://primary-a');
  // Khoá election trên etcd đã bị instance khác chiếm (instanceId 2)
  etcd.store.set('/nhom16/election/failover', '{"instanceId":"2"}');

  const executedQueries = [];
  const pgClientFactory = (url) => ({
    async connect() {},
    async query(sql, params) {
      executedQueries.push({ url, sql, params });
      if (sql === 'SELECT pg_last_wal_replay_lsn() AS lsn') {
        return { rows: [{ lsn: '0/100' }] };
      }
      return { rows: [] };
    },
    async end() {},
  });

  const elector = {
    isLeader: () => true,
    getPayload: () => '{"instanceId":"1"}', // payload bản thân khác trên etcd
    getElectionKey: () => '/nhom16/election/failover',
  };

  const manager = makeFailoverManager({
    etcdClient: etcd,
    parkings: [{ parkingId: 'A', primaryUrl: 'postgres://primary-a', replicaUrl: 'postgres://replica-a', sync: true }],
    elector,
    pgClientFactory,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const res = await manager.doFailover(manager.parkingStates[0]);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'CAS_FAILED');

  const promoteCalled = executedQueries.some((q) => q.sql === 'SELECT pg_promote()');
  assert.equal(promoteCalled, false, 'Không được promote khi mất quyền leader key trên etcd');
});

test('PD-14b manager: tự động hạ cấp sync replication sang async khi replica chết quá 3s', async () => {
  const etcd = makeMockEtcd();
  const executedQueries = [];
  const replicaDown = { value: true };

  const pgClientFactory = (url) => ({
    async connect() {
      if (url === 'postgres://replica-a' && replicaDown.value) {
        throw new Error('Connection refused to replica-a');
      }
    },
    async query(sql, params) {
      executedQueries.push({ url, sql, params });
      return { rows: [] };
    },
    async end() {},
  });

  const elector = { isLeader: () => true };
  const manager = makeFailoverManager({
    etcdClient: etcd,
    parkings: [
      {
        parkingId: 'A',
        primaryUrl: 'postgres://primary-a',
        replicaUrl: 'postgres://replica-a',
        sync: true,
      },
    ],
    elector,
    pgClientFactory,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  // Check 1: replica fail lần 1
  await manager.checkOnce();
  assert.equal(manager.parkingStates[0].degradedToAsync, false);

  // Check 2: replica fail lần 2
  await manager.checkOnce();
  assert.equal(manager.parkingStates[0].degradedToAsync, false);

  // Check 3: replica fail lần 3 (hoặc >= 3s) -> hạ cấp sang async
  await manager.checkOnce();
  assert.equal(manager.parkingStates[0].degradedToAsync, true);

  const alterQuery = executedQueries.find(
    (q) => q.url === 'postgres://primary-a' && q.sql.includes('ALTER SYSTEM RESET synchronous_standby_names')
  );
  assert.ok(alterQuery, 'Phải chạy ALTER SYSTEM trên primary');

  const reloadQuery = executedQueries.find(
    (q) => q.url === 'postgres://primary-a' && q.sql === 'SELECT pg_reload_conf()'
  );
  assert.ok(reloadQuery, 'Phải gọi pg_reload_conf trên primary');
});

test('PD-14b manager: follower không thực hiện kiểm tra failover', async () => {
  let pingCount = 0;
  const pgClientFactory = () => ({
    async connect() {},
    async query() {
      pingCount++;
      return { rows: [] };
    },
    async end() {},
  });

  const elector = { isLeader: () => false };
  const manager = makeFailoverManager({
    etcdClient: makeMockEtcd(),
    parkings: [{ parkingId: 'A', primaryUrl: 'postgres://primary-a', replicaUrl: 'postgres://replica-a' }],
    elector,
    pgClientFactory,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  await manager.checkOnce();
  assert.equal(pingCount, 0, 'Follower không được ping kiểm tra');
});

test('PD-14b manager: cửa sổ an toàn waitWindowMs được tuân thủ trước khi gọi pg_promote()', async () => {
  const etcd = makeMockEtcd();
  etcd.store.set('/nhom16/parking/A/db/epoch', '1');
  etcd.store.set('/nhom16/parking/A/db/primary', 'postgres://primary-a');

  const timeline = [];
  const pgClientFactory = (url) => ({
    async connect() {},
    async query(sql) {
      if (sql === 'SELECT pg_last_wal_replay_lsn() AS lsn') {
        timeline.push({ event: 'check_lsn', time: Date.now() });
        return { rows: [{ lsn: '0/100' }] };
      }
      if (sql === 'SELECT pg_promote()') {
        timeline.push({ event: 'promote', time: Date.now() });
        return { rows: [] };
      }
      if (sql.includes('UPDATE db_epoch')) {
        timeline.push({ event: 'update_db_epoch', time: Date.now() });
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
    async end() {},
  });

  const elector = { isLeader: () => true };
  const waitWindowMs = 60;
  const manager = makeFailoverManager({
    etcdClient: etcd,
    parkings: [{ parkingId: 'A', primaryUrl: 'postgres://primary-a', replicaUrl: 'postgres://replica-a' }],
    elector,
    pgClientFactory,
    waitWindowMs,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const start = Date.now();
  const res = await manager.doFailover(manager.parkingStates[0]);
  const elapsed = Date.now() - start;

  assert.equal(res.ok, true);
  assert.ok(elapsed >= waitWindowMs - 5, `Phải chờ tối thiểu ${waitWindowMs}ms (thực tế: ${elapsed}ms)`);

  const lsnEv = timeline.find((e) => e.event === 'check_lsn');
  const promoteEv = timeline.find((e) => e.event === 'promote');
  assert.ok(lsnEv && promoteEv, 'Cả hai sự kiện phải diễn ra');
  assert.ok(promoteEv.time - lsnEv.time >= waitWindowMs - 5, 'Khoảng cách giữa check_lsn và promote phải >= waitWindowMs');
});

test('PD-14b manager: xử lý an toàn khi CAS thành công nhưng pg_promote() thất bại (giữ epoch=N+1, log CRITICAL, không đổi primary)', async () => {
  const etcd = makeMockEtcd();
  etcd.store.set('/nhom16/parking/A/db/epoch', '3');
  etcd.store.set('/nhom16/parking/A/db/primary', 'postgres://primary-a');

  const errorLogs = [];
  const log = {
    info: () => {},
    warn: () => {},
    error: (msg) => errorLogs.push(msg),
  };

  const pgClientFactory = (url) => ({
    async connect() {},
    async query(sql) {
      if (sql === 'SELECT pg_last_wal_replay_lsn() AS lsn') {
        return { rows: [{ lsn: '0/200' }] };
      }
      if (sql === 'SELECT pg_promote()') {
        throw new Error('promote rejected: replica split-brain');
      }
      return { rows: [] };
    },
    async end() {},
  });

  const elector = { isLeader: () => true };
  const manager = makeFailoverManager({
    etcdClient: etcd,
    parkings: [{ parkingId: 'A', primaryUrl: 'postgres://primary-a', replicaUrl: 'postgres://replica-a' }],
    elector,
    pgClientFactory,
    waitWindowMs: 10,
    log,
  });

  const state = manager.parkingStates[0];
  const res = await manager.doFailover(state);

  // Kết quả thất bại do pg_promote
  assert.equal(res.ok, false);
  assert.equal(res.error, 'FAILOVER_PROMOTE_FAILED');
  assert.equal(res.epoch, 4);

  // Epoch trên etcd vẫn giữ nguyên N + 1 = 4 (tuyệt đối không giảm epoch)
  assert.equal(etcd.store.get('/nhom16/parking/A/db/epoch'), '4');

  // Primary trên etcd KHÔNG được trỏ sang replica lỗi
  assert.equal(etcd.store.get('/nhom16/parking/A/db/primary'), 'postgres://primary-a');

  // State bộ nhớ vẫn giữ primary cũ
  assert.equal(state.primaryUrl, 'postgres://primary-a');

  // Đã ghi log cảnh báo CRITICAL
  const hasCriticalLog = errorLogs.some((l) => l.includes('CRITICAL: FAILOVER_PROMOTE_FAILED'));
  assert.ok(hasCriticalLog, 'Phải có log CRITICAL: FAILOVER_PROMOTE_FAILED');
});

