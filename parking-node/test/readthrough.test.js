
const test = require('node:test');
const assert = require('node:assert/strict');
const { readThrough } = require('../src/db');

function fixture({
  age = 100,
  caughtUp = true,
  backoffMs = 1_000,
} = {}) {
  let clock = 10_000;
  let replayAge = age;
  let replicaCaughtUp = caughtUp;
  let replicaUnavailable = false;

  let statusReads = 0;
  let lsnReads = 0;
  let replicaReads = 0;
  let primaryReads = 0;
  let fallbacks = 0;

  const replica = {
    async query(sql, params) {
      if (sql.includes('pg_last_xact_replay_timestamp')) {
        statusReads++;

        if (replicaUnavailable) {
          throw new Error('replica down');
        }

        return { rows: [{ replay_age_ms: replayAge }] };
      }

      if (sql.includes('pg_last_wal_replay_lsn')) {
        lsnReads++;

        return { rows: [{ caught_up: replicaCaughtUp }] };
      }

      replicaReads++;
      return { rows: [{ source: 'replica' }] };
    },
  };

  const primary = {
    async query() {
      primaryReads++;
      return { rows: [{ source: 'primary' }] };
    },
  };

  const ro = readThrough(replica, primary, {
    backoffMs,
    maxStalenessMs: 1_000,
    statusCacheMs: 200,
    now: () => clock,
    onFallback: () => fallbacks++,
  });

  return {
    ro,
    advance(ms) { clock += ms; },
    setAge(value) { replayAge = value; },
    setCaughtUp(value) { replicaCaughtUp = value; },
    setReplicaUnavailable(value) { replicaUnavailable = value; },
    get statusReads() { return statusReads; },
    get lsnReads() { return lsnReads; },
    get replicaReads() { return replicaReads; },
    get primaryReads() { return primaryReads; },
    get fallbacks() { return fallbacks; },
  };
}

test('PD-15 replica đủ mới: đọc replica và cache trạng thái 200 ms', async () => {
  const f = fixture();

  assert.equal((await f.ro.query('SELECT 1')).rows[0].source, 'replica');

  f.advance(100);

  assert.equal((await f.ro.query('SELECT 2')).rows[0].source, 'replica');

  assert.equal(f.statusReads, 1);
  assert.equal(f.replicaReads, 2);
  assert.equal(f.primaryReads, 0);
});

test('PD-15 replica vượt 1 giây: fallback primary, không dùng trạng thái cache đã hết hạn', async () => {
  const f = fixture({ age: 900 });

  assert.equal((await f.ro.query('SELECT 1')).rows[0].source, 'replica');

  // 900 ms + 101 ms = 1.001 giây.
  f.advance(101);

  assert.equal((await f.ro.query('SELECT 2')).rows[0].source, 'primary');
  assert.equal(f.statusReads, 1);

  // Cache hết hạn: kiểm tra lại trạng thái replica.
  f.setAge(300);
  f.advance(100);

  assert.equal((await f.ro.query('SELECT 3')).rows[0].source, 'replica');
  assert.equal(f.statusReads, 2);
});

test('PD-15 X-Min-LSN chưa theo kịp: primary; theo kịp: replica', async () => {
  const f = fixture({ caughtUp: false });
  const minLSN = '0/16B6C50';

  assert.equal(
    (await f.ro.query('SELECT 1', [], { minLSN })).rows[0].source,
    'primary',
  );

  f.setCaughtUp(true);

  assert.equal(
    (await f.ro.query('SELECT 2', [], { minLSN })).rows[0].source,
    'replica',
  );

  assert.equal(f.lsnReads, 2);
  assert.equal(f.primaryReads, 1);
  assert.equal(f.replicaReads, 1);
});

test('PT-02/PD-15 replica lỗi: fallback primary và backoff', async () => {
  const f = fixture();

  f.setReplicaUnavailable(true);

  assert.equal((await f.ro.query('SELECT 1')).rows[0].source, 'primary');
  assert.equal((await f.ro.query('SELECT 2')).rows[0].source, 'primary');

  assert.equal(f.statusReads, 1);
  assert.equal(f.fallbacks, 1);

  // Replica phục hồi nhưng vẫn đang trong backoff.
  f.setReplicaUnavailable(false);

  assert.equal((await f.ro.query('SELECT 3')).rows[0].source, 'primary');
  assert.equal(f.statusReads, 1);

  // Hết backoff, quay lại replica.
  f.advance(1_001);

  assert.equal((await f.ro.query('SELECT 4')).rows[0].source, 'replica');
  assert.equal(f.statusReads, 2);
});
