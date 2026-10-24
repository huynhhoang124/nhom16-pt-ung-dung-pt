const test = require('node:test');
const assert = require('node:assert/strict');
const { makePool } = require('./helpers');
const { makeDynamicPool } = require('../src/dynamic-pool');
const { reserve } = require('../src/slots');

test('PD-14b dynamic pool: chuyển đổi primary url và đóng pool cũ', async () => {
  const pool1 = await makePool('A', 5);
  const pool2 = await makePool('B', 5);

  const pools = {
    'postgres://db1': pool1,
    'postgres://db2': pool2,
  };

  const store = new Map();
  store.set('/nhom16/parking/A/db/primary', 'postgres://db1');
  store.set('/nhom16/parking/A/db/epoch', '1');

  const mockEtcd = {
    get(k) {
      return {
        string: async () => store.get(k) ?? null,
      };
    },
    watch() {
      return {
        key(k) {
          return {
            async create() {
              return {
                on: () => {},
                cancel: async () => {},
              };
            },
          };
        },
      };
    },
  };

  const dynPool = await makeDynamicPool({
    parkingId: 'A',
    defaultDatabaseUrl: 'postgres://db1',
    poolFactory: (opts) => pools[opts.connectionString],
    etcdClient: mockEtcd,
  });

  assert.equal(dynPool.getPrimaryUrl(), 'postgres://db1');
  assert.equal(dynPool.getEpoch(), 1);

  // Truy vấn lần 1 đi vào db1
  const r1 = await dynPool.query('SELECT slot_code FROM parking_slots LIMIT 1');
  assert.equal(r1.rows[0].slot_code, 'A01');

  // Chuyển primary sang db2
  dynPool.switchPrimary('postgres://db2');
  assert.equal(dynPool.getPrimaryUrl(), 'postgres://db2');

  // Truy vấn lần 2 đi vào db2
  const r2 = await dynPool.query('SELECT slot_code FROM parking_slots LIMIT 1');
  assert.equal(r2.rows[0].slot_code, 'B01');

  await dynPool.end();
});

test('PD-14b zombie primary fencing: chặn ghi khi db_epoch lệch với etcd_epoch (STALE_DB_EPOCH)', async () => {
  const basePool = await makePool('A', 5);

  const dynPool = await makeDynamicPool({
    parkingId: 'A',
    defaultDatabaseUrl: 'postgres://db1',
    poolFactory: () => basePool,
    etcdClient: {
      get: () => ({ string: async () => null }),
      watch: () => ({ key: () => ({ create: async () => ({ on: () => {}, cancel: async () => {} }) }) }),
    },
  });

  // DB đang mang epoch = 4 (primary cũ)
  await basePool.query('UPDATE db_epoch SET epoch = 4');

  // Mô phỏng failover-manager đã tăng etcd epoch lên 5
  dynPool.setEpoch(5);

  // Cố gắng đặt chỗ trên DB có epoch 4 khi cluster epoch là 5 -> bị từ chối STALE_DB_EPOCH
  const res = await reserve(dynPool, 'A', {
    requestId: 'u1:req-1',
    userId: 'u1',
    slotCode: 'A01',
    licensePlate: '30A-123.45',
  }, 15);

  assert.equal(res.code, 409);
  assert.equal(res.body.error, 'STALE_DB_EPOCH');
  assert.equal(res.body.dbEpoch, 4);
  assert.equal(res.body.etcdEpoch, 5);

  // Không có reservation nào được ghi vào DB
  const count = (await basePool.query('SELECT count(*) AS c FROM reservations')).rows[0].c;
  assert.equal(Number(count), 0);

  // Khi DB được cập nhật đúng epoch 5 -> ghi thành công
  await basePool.query('UPDATE db_epoch SET epoch = 5');
  const okRes = await reserve(dynPool, 'A', {
    requestId: 'u1:req-1',
    userId: 'u1',
    slotCode: 'A01',
    licensePlate: '30A-123.45',
  }, 15);

  assert.equal(okRes.code, 201);
  assert.equal(okRes.body.status, 'ACTIVE');

  await dynPool.end();
});

test('PD-14b fallback: khi không có etcd thì hoạt động như pool tĩnh thông thường', async () => {
  const basePool = await makePool('A', 5);

  const pool = await makeDynamicPool({
    etcdEndpoints: undefined,
    defaultDatabaseUrl: 'postgres://db1',
    poolFactory: () => basePool,
  });

  assert.equal(pool.isDynamic, undefined);
  const okRes = await reserve(pool, 'A', {
    requestId: 'u1:req-no-etcd',
    userId: 'u1',
    slotCode: 'A02',
    licensePlate: '30A-999.99',
  }, 15);

  assert.equal(okRes.code, 201);
});

test('PD-14b safety window: node từ chối ghi khi mất kết nối watch etcd quá cửa sổ X giây (503 ETCD_UNREACHABLE)', async () => {
  const basePool = await makePool('A', 5);

  const dynPool = await makeDynamicPool({
    parkingId: 'A',
    defaultDatabaseUrl: 'postgres://db1',
    poolFactory: () => basePool,
    watchWindowMs: 200,
    etcdClient: {
      get: () => ({ string: async () => null }),
      watch: () => ({ key: () => ({ create: async () => ({ on: () => {}, cancel: async () => {} }) }) }),
    },
  });

  // 1. Khi vừa có liên lạc etcd (trong vòng 200ms) -> ghi thành công
  dynPool.setLastEtcdContact(Date.now());
  const res1 = await reserve(dynPool, 'A', {
    requestId: 'u1:contact-fresh',
    userId: 'u1',
    slotCode: 'A03',
    licensePlate: '30A-111.11',
  }, 15);
  assert.equal(res1.code, 201);
  assert.equal(res1.body.status, 'ACTIVE');

  // 2. Mô phỏng mất kết nối etcd quá cửa sổ 200ms (ví dụ trôi qua 500ms)
  dynPool.setLastEtcdContact(Date.now() - 500);

  // Giao dịch ghi bị chặn với mã 503 ETCD_UNREACHABLE
  const resRejected = await reserve(dynPool, 'A', {
    requestId: 'u1:contact-lost',
    userId: 'u1',
    slotCode: 'A04',
    licensePlate: '30A-222.22',
  }, 15);

  assert.equal(resRejected.code, 503);
  assert.equal(resRejected.body.error, 'ETCD_UNREACHABLE');
  assert.ok(resRejected.body.message.includes('Mất kết nối etcd'));

  // 3. Khi liên lạc etcd phục hồi -> ghi trở lại bình thường
  dynPool.setLastEtcdContact(Date.now());
  const resRecovered = await reserve(dynPool, 'A', {
    requestId: 'u1:contact-recovered',
    userId: 'u1',
    slotCode: 'A04',
    licensePlate: '30A-222.22',
  }, 15);
  assert.equal(resRecovered.code, 201);
  assert.equal(resRecovered.body.status, 'ACTIVE');

  await dynPool.end();
});

