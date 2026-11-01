const test = require('node:test');
const assert = require('node:assert/strict');
const { makePool, one } = require('./helpers');
const s = require('../src/slots');
const { makeRelay } = require('../src/relay');
const { withRequestId } = require('../src/log');

test('GS-03 relay ghi đúng request ID từ outbox chỉ sau broker confirm và đánh dấu đã gửi', async () => {
  const pool = await makePool();
  await new Promise((resolve, reject) => withRequestId(
    { get: () => 'gs03-relay-trace' }, { set() {}, on() {} },
    () => s.reserve(pool, 'A', { requestId: 'idempotency-key-khac', userId: 'u', slotCode: 'A01', licensePlate: 'p' }).then(resolve, reject),
  ));
  const logs = [];
  let confirmed = false;
  const relay = makeRelay(pool, async () => confirmed, { info: (msg, fields) => logs.push({ msg, ...fields }) });
  assert.equal(await relay(), 0);
  assert.deepEqual(logs, []);
  confirmed = true;
  assert.equal(await relay(), 1);
  const event = await one(pool, 'SELECT id, published_at FROM parking_events');
  assert.ok(event.published_at);
  assert.deepEqual(logs, [{ msg: 'outbox đã gửi', requestId: 'gs03-relay-trace', eventId: event.id,
    type: 'RESERVED', routingKey: 'parking.A.slot.A01' }]);
  assert.equal(await relay(), 0);
  assert.equal(logs.length, 1);
});

const unpublished = async (pool) =>
  (await one(pool, 'SELECT count(*)::int AS c FROM parking_events WHERE published_at IS NULL')).c;

async function poolWith3Events() {
  const pool = await makePool();
  await s.reserve(pool, 'A', { requestId: 'r1', userId: 'u', slotCode: 'A01', licensePlate: 'p' });
  await s.moveSlot(pool, 'A', 'A01', ['RESERVED'], 'OCCUPIED', 'CAR_ENTER');
  await s.moveSlot(pool, 'A', 'A01', ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT');
  return pool;
}

test('broker lỗi: không đánh dấu gì; broker khoẻ lại: gửi đủ theo thứ tự, không gửi lặp', async () => {
  const pool = await poolWith3Events();
  const sent = [];
  let up = false;
  const relayOnce = makeRelay(pool, async (key, payload) => (up ? (sent.push([key, payload.version]), true) : false));

  assert.equal(await relayOnce(), 0);
  assert.equal(await unpublished(pool), 3);

  up = true;
  assert.equal(await relayOnce(), 3);
  assert.deepEqual(sent, [['parking.A.slot.A01', 1], ['parking.A.slot.A01', 2], ['parking.A.slot.A01', 3]]);
  assert.equal(await unpublished(pool), 0);
  assert.equal(await relayOnce(), 0);
});


test('broker lỗi khi publish theo lô: không đánh dấu sự kiện; lần sau gửi đủ theo thứ tự', async () => {
  const pool = await poolWith3Events();
  const sent = [];
  let up = false;

  const publish = async (_key, payload) => {
    sent.push(payload.version);
    return up;
  };

  publish.publishBatch = async (events) => {
    sent.push(...events.map((e) => e.payload.version));
    return up;
  };

  const relayOnce = makeRelay(pool, publish);

  assert.equal(await relayOnce(), 0);
  assert.equal(await unpublished(pool), 3);

  up = true;
  assert.equal(await relayOnce(), 3);
  assert.equal(await unpublished(pool), 0);
  assert.deepEqual(sent, [1, 2, 3, 1, 2, 3]);
});


test('không chạy chồng khi lần trước chưa xong', async () => {
  const pool = await poolWith3Events();
  let release;
  const gate = new Promise((r) => { release = r; });
  const relayOnce = makeRelay(pool, async () => { await gate; return true; });
  const first = relayOnce();
  assert.equal(await relayOnce(), 0);   // lần gọi thứ hai bỏ qua ngay
  release();
  assert.equal(await first, 3);
});



test('relay gửi theo lô, giới hạn 100 sự kiện mỗi lần', async () => {
  const pool = await makePool();
  const batches = [];

  // Tạo 205 sự kiện outbox để kiểm tra giới hạn mỗi batch.
  for (let i = 1; i <= 205; i++) {
    await pool.query(
      `INSERT INTO parking_events
        (event_type, slot_code, license_plate, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        'CAR_ENTER',
        `A${String(i).padStart(3, '0')}`,
        null,
        {
          event: 'SLOT_UPDATED',
          type: 'CAR_ENTER',
          parkingId: 'A',
          slot: `A${String(i).padStart(3, '0')}`,
          status: 'OCCUPIED',
          version: i,
          requestId: `pd18-batch-${i}`,
        },
      ],
    );
  }

  const publish = async () => true;
  publish.publishBatch = async (events) => {
    batches.push(events.map((e) => e.id));
    return true;
  };

  const relayOnce = makeRelay(pool, publish);

  assert.equal(await relayOnce(), 100);
  assert.equal(await relayOnce(), 100);
  assert.equal(await relayOnce(), 5);

  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 5],
  );

  assert.equal(new Set(batches.flat()).size, 205);
  assert.equal(await unpublished(pool), 0);
});


test('relay dùng transaction và SKIP LOCKED để lấy batch', async () => {
  const queries = [];
  const events = [{
    id: 1,
    payload: {
      parkingId: 'A',
      slot: 'A01',
      type: 'CAR_ENTER',
      requestId: 'pd18-test',
    },
    created_at: new Date(),
  }];

  const client = {
    async query(sql) {
      queries.push(sql);

      if (sql.includes('SELECT id, payload, created_at')) {
        return { rows: events };
      }

      return { rows: [], rowCount: 1 };
    },
    release() {},
  };

  const pool = { connect: async () => client };
  const publish = async () => true;
  publish.publishBatch = async (batch) => batch.length === 1;

  const relayOnce = makeRelay(pool, publish);

  assert.equal(await relayOnce(), 1);
  assert.ok(queries.some((q) => q === 'BEGIN'));
  assert.ok(queries.some((q) => /FOR UPDATE\s+SKIP LOCKED/i.test(q)));
  assert.ok(queries.some((q) => q === 'COMMIT'));
});
