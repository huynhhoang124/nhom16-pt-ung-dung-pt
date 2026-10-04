const test = require('node:test');
const assert = require('node:assert/strict');
const { makePool, one } = require('./helpers');
const s = require('../src/slots');

const P = 'A';
const req = (id, slot = 'A01', user = 'u1') => ({ requestId: id, userId: user, slotCode: slot, licensePlate: `30A-${id}` });
const slot = (pool, code) => one(pool, 'SELECT status, version::int AS version FROM parking_slots WHERE slot_code=$1', [code]);
const count = async (pool, sql) => (await one(pool, `SELECT count(*)::int AS c FROM ${sql}`)).c;

test('seed tạo đủ slot, chạy init lần 2 không nhân đôi', async () => {
  const pool = await makePool('A', 12);
  await require('../src/db').init(pool, 'A', 12);
  assert.equal(await count(pool, 'parking_slots'), 12);
  assert.deepEqual(await one(pool, `SELECT floor FROM parking_slots WHERE slot_code='A11'`), { floor: 2 });
});

test('TC15 SLOTS: đúng số slot từng loại/tầng, mã ô tô A01.., xe máy AM01..; init lần 2 không nhân đôi', async () => {
  const { init, slotPlan } = require('../src/db');
  const pool = await makePool('A', 0);
  await init(pool, 'A', 'CAR:1:3,CAR:2:2,MOTO:1:4');
  await init(pool, 'A', 'CAR:1:3,CAR:2:2,MOTO:1:4');
  const rows = (await pool.query(`SELECT type, floor, count(*)::int AS n FROM parking_slots GROUP BY type, floor ORDER BY type, floor`)).rows;
  assert.deepEqual(rows, [{ type: 'CAR', floor: 1, n: 3 }, { type: 'CAR', floor: 2, n: 2 }, { type: 'MOTO', floor: 1, n: 4 }]);
  assert.deepEqual(await one(pool, `SELECT floor, type FROM parking_slots WHERE slot_code='A04'`), { floor: 2, type: 'CAR' });
  assert.ok(await one(pool, `SELECT 1 FROM parking_slots WHERE slot_code='AM04'`));
  assert.throws(() => slotPlan('A', 'BUS:1:3'), /SLOTS sai/);
});

test('TC16 tra cứu theo loại xe: byType và lọc type=MOTO', async () => {
  const pool = await makePool('A', 0);
  await require('../src/db').init(pool, 'A', 'CAR:1:2,MOTO:1:3');
  await s.reserve(pool, P, req('r1', 'AM01'));
  assert.deepEqual(await s.availability(pool, P), {
    parkingId: 'A', available: 4, total: 5,
    byType: { CAR: { available: 2, total: 2 }, MOTO: { available: 2, total: 3 } },
  });
  assert.deepEqual((await s.listSlots(pool, true, 'MOTO')).map((x) => x.slotCode), ['AM02', 'AM03']);
  assert.equal((await s.listSlots(pool, false, 'CAR')).length, 2);
});

test('đặt chỗ: 201, slot RESERVED, version 1, sinh 1 sự kiện', async () => {
  const pool = await makePool();
  const r = await s.reserve(pool, P, req('r1'));
  assert.equal(r.code, 201);
  assert.equal(r.body.slot_code, 'A01');
  assert.deepEqual(await slot(pool, 'A01'), { status: 'RESERVED', version: 1 });
  const ev = await one(pool, 'SELECT payload FROM parking_events');
  assert.deepEqual(ev.payload, { event: 'SLOT_UPDATED', type: 'RESERVED', parkingId: 'A', slot: 'A01', status: 'RESERVED', version: 1 });
});

test('TC08 gửi lại cùng requestId: trả bản cũ, vẫn 1 reservation, không thêm sự kiện', async () => {
  const pool = await makePool();
  const a = await s.reserve(pool, P, req('r1'));
  const b = await s.reserve(pool, P, req('r1'));
  assert.equal(b.code, 200);
  assert.equal(b.replayed, true);
  assert.equal(b.body.id, a.body.id);
  assert.equal(await count(pool, 'reservations'), 1);
  assert.equal(await count(pool, 'parking_events'), 1);
});

test('TC03 người thứ hai đặt cùng slot: 409, không sinh reservation/sự kiện', async () => {
  const pool = await makePool();
  await s.reserve(pool, P, req('r1'));
  const r = await s.reserve(pool, P, req('r2', 'A01', 'u2'));
  assert.deepEqual([r.code, r.body], [409, { error: 'SLOT_TAKEN' }]);
  assert.equal(await count(pool, 'reservations'), 1);
  assert.equal(await count(pool, 'parking_events'), 1);
});

test('ràng buộc DB ex_no_overlap: chèn thẳng một khung giờ chồng lên khung đang giữ -> lỗi 23P01', async () => {
  const pool = await makePool();
  await s.reserve(pool, P, req('r1'));
  await assert.rejects(
    pool.query(`INSERT INTO reservations(request_id,user_id,slot_id,license_plate,start_time,end_time,expire_time)
                VALUES ('x','u9',(SELECT id FROM parking_slots WHERE slot_code='A01'),'p', now(), now() + interval '1 hour', now())`),
    (e) => e.code === '23P01');
});

// ---- NV-01: đặt theo khung giờ ----
const inHours = async (pool, h) => (await one(pool, `SELECT now() + make_interval(hours => $1) AS t`, [h])).t;
const book = (pool, id, startTime, durationMinutes = 120, slot = 'A01') =>
  s.reserve(pool, P, { ...req(id, slot), startTime, durationMinutes });

test('TC20 đặt trước: hai khung giờ chồng nhau trên cùng slot -> cái sau 409 TIME_CONFLICT; slot vẫn AVAILABLE', async () => {
  const pool = await makePool();
  const t = await inHours(pool, 5);
  const a = await book(pool, 'f1', t);
  assert.equal(a.code, 201);
  assert.equal((await slot(pool, 'A01')).status, 'AVAILABLE');          // đặt trước: chưa giữ chỗ
  assert.equal(await count(pool, 'parking_events'), 0);
  const t2 = await inHours(pool, 6);                                       // 6h < 5h + 2h -> chồng
  assert.deepEqual(await book(pool, 'f2', t2), { code: 409, body: { error: 'TIME_CONFLICT' } });
  assert.equal((await book(pool, 'f3', t2, 120, 'A02')).code, 201);      // slot khác thì được
  // đặt ngay mà khung 120' chạm lượt đặt trước lúc +1h -> cũng chồng giờ, slot không bị giữ
  const t3 = await inHours(pool, 1);
  await book(pool, 'f4', t3, 60, 'A03');
  assert.deepEqual(await s.reserve(pool, P, req('f5', 'A03')), { code: 409, body: { error: 'TIME_CONFLICT' } });
  assert.equal((await slot(pool, 'A03')).status, 'AVAILABLE');
});

test('TC21 hai khung nối tiếp (10–12, 12–14) đều được; huỷ lượt sau không nhả chỗ lượt trước đang giữ', async () => {
  const pool = await makePool();
  const first = await s.reserve(pool, P, req('n1'));                      // đặt ngay, 120'
  assert.equal((await slot(pool, 'A01')).status, 'RESERVED');
  const second = await book(pool, 'n2', first.body.end_time);            // bắt đầu đúng lúc lượt 1 kết thúc
  assert.equal(second.code, 201);
  assert.equal((await s.endReservation(pool, P, second.body.id, 'CANCELLED', 'u1')).code, 200);
  assert.equal((await slot(pool, 'A01')).status, 'RESERVED');           // vẫn giữ cho lượt 1
});

test('TC22 activateDue: gần đến giờ thì giữ chỗ + phát sự kiện; xe vào chỉ dùng lượt đang giữ; xe ra -> DONE', async () => {
  const pool = await makePool();
  const r = await book(pool, 'a1', await inHours(pool, 3));
  const later = await book(pool, 'a2', await inHours(pool, 30));
  assert.equal(await s.activateDue(pool, P), 0);                           // còn xa
  await pool.query(`UPDATE reservations SET start_time=now() + interval '10 minutes', end_time=now() + interval '130 minutes',
                    expire_time=now() + interval '25 minutes' WHERE id=$1`, [r.body.id]);
  assert.equal(await s.activateDue(pool, P), 1);
  assert.equal(await s.activateDue(pool, P), 0);                           // chạy lại không làm gì thêm
  assert.equal((await slot(pool, 'A01')).status, 'RESERVED');
  assert.equal((await one(pool, `SELECT event_type FROM parking_events ORDER BY id DESC LIMIT 1`)).event_type, 'RESERVED');
  const enter = await s.moveSlot(pool, P, 'A01', ['RESERVED', 'AVAILABLE'], 'OCCUPIED', 'CAR_ENTER');
  assert.equal(enter.body.session.reservationId, r.body.id);
  const st = async (id) => (await one(pool, `SELECT status FROM reservations WHERE id=$1`, [id])).status;
  assert.deepEqual([await st(r.body.id), await st(later.body.id)], ['USED', 'ACTIVE']);
  await s.moveSlot(pool, P, 'A01', ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT');
  assert.equal(await st(r.body.id), 'DONE');
});

test('TC23 đến giờ mà slot còn xe (xe trước ở quá giờ) -> chuyển lượt đặt sang slot trống cùng loại', async () => {
  const pool = await makePool();
  const r = await book(pool, 'm1', await inHours(pool, 3));
  await s.moveSlot(pool, P, 'A01', ['AVAILABLE'], 'OCCUPIED', 'CAR_ENTER');   // xe vãng lai vào (lượt đặt còn xa)
  await pool.query(`UPDATE reservations SET start_time=now() + interval '5 minutes', end_time=now() + interval '2 hours' WHERE id=$1`, [r.body.id]);
  assert.equal(await s.activateDue(pool, P), 1);
  const moved = await one(pool, `SELECT s.slot_code FROM reservations r JOIN parking_slots s ON s.id=r.slot_id WHERE r.id=$1`, [r.body.id]);
  assert.equal(moved.slot_code, 'A02');
  assert.equal((await slot(pool, 'A02')).status, 'RESERVED');
  assert.equal((await one(pool, `SELECT event_type FROM parking_events ORDER BY id DESC LIMIT 1`)).event_type, 'RESERVATION_MOVED');
});

test('xe vãng lai không được vào slot sắp có người đặt (trong 2 giờ)', async () => {
  const pool = await makePool();
  await book(pool, 'w1', await inHours(pool, 1));
  const r = await s.moveSlot(pool, P, 'A01', ['AVAILABLE'], 'OCCUPIED', 'CAR_ENTER');
  assert.deepEqual([r.code, r.body.error], [409, 'SLOT_RESERVED_SOON']);
  assert.equal((await s.moveSlot(pool, P, 'A02', ['AVAILABLE'], 'OCCUPIED', 'CAR_ENTER')).code, 200);
});

test('lịch slot theo ngày (giờ VN)', async () => {
  const pool = await makePool();
  const r = await book(pool, 'l1', await inHours(pool, 3));
  const date = new Date(new Date(r.body.start_time).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  const sch = await s.slotSchedule(pool, 'A01', date);
  assert.equal(sch.length, 1);
  assert.deepEqual(Object.keys(sch[0]), ['startTime', 'endTime', 'status']);   // không lộ biển số / người đặt
});

test('xe vào/ra: RESERVED -> OCCUPIED -> AVAILABLE, reservation thành USED, version tăng', async () => {
  const pool = await makePool();
  await s.reserve(pool, P, req('r1'));
  const enter = await s.moveSlot(pool, P, 'A01', ['RESERVED', 'AVAILABLE'], 'OCCUPIED', 'CAR_ENTER', 'x');
  const { session, ...enterBody } = enter.body;
  assert.deepEqual(enterBody, { slot: 'A01', status: 'OCCUPIED', version: 2 });
  assert.equal(session.licensePlate, 'x');
  assert.equal((await one(pool, `SELECT status FROM reservations WHERE request_id='r1'`)).status, 'USED');
  const exit = await s.moveSlot(pool, P, 'A01', ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT');
  assert.deepEqual({ ...exit.body, session: undefined }, { slot: 'A01', status: 'AVAILABLE', version: 3, session: undefined });
  // ra khi slot đang trống: sai trạng thái, không sinh sự kiện
  const bad = await s.moveSlot(pool, P, 'A01', ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT');
  assert.equal(bad.code, 409);
  const versions = (await pool.query(`SELECT (payload->>'version')::int AS v FROM parking_events ORDER BY id`)).rows.map((r) => r.v);
  assert.deepEqual(versions, [1, 2, 3]);
});

test('xe vào không đặt trước (AVAILABLE -> OCCUPIED); slot bảo trì không đặt được', async () => {
  const pool = await makePool();
  assert.equal((await s.moveSlot(pool, P, 'A02', ['RESERVED', 'AVAILABLE'], 'OCCUPIED', 'CAR_ENTER')).code, 200);
  assert.equal((await s.moveSlot(pool, P, 'A03', ['AVAILABLE'], 'MAINTENANCE', 'MAINTENANCE_ON')).code, 200);
  assert.equal((await s.reserve(pool, P, req('r3', 'A03'))).code, 409);
  assert.equal((await s.moveSlot(pool, P, 'A03', ['MAINTENANCE'], 'AVAILABLE', 'MAINTENANCE_OFF')).code, 200);
  assert.equal((await s.reserve(pool, P, req('r3', 'A03'))).code, 201);
});

test('TC17 vào bằng đặt chỗ rồi ra: đúng 1 phiên, lấy biển số + user từ đặt chỗ, có exitedAt', async () => {
  const pool = await makePool();
  const r = await s.reserve(pool, P, req('r1'));
  const enter = await s.moveSlot(pool, P, 'A01', ['RESERVED', 'AVAILABLE'], 'OCCUPIED', 'CAR_ENTER');
  assert.equal(enter.body.session.licensePlate, '30A-r1');
  assert.equal(enter.body.session.userId, 'u1');
  assert.equal(enter.body.session.reservationId, r.body.id);
  assert.equal(enter.body.session.exitedAt, null);
  const exit = await s.moveSlot(pool, P, 'A01', ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT');
  assert.equal(exit.body.session.id, enter.body.session.id);
  assert.ok(exit.body.session.exitedAt);
  assert.equal(await count(pool, 'parking_sessions'), 1);
  // tra theo biển số không phân biệt cách viết; theo user
  assert.equal((await s.listSessions(pool, { plate: '30a r1' })).length, 1);
  assert.equal((await s.listSessions(pool, { userId: 'u1' })).length, 1);
  assert.equal((await s.listSessions(pool, { userId: 'u2' })).length, 0);
});

test('TC25 xe ra: phiên có phí theo bảng giá của bãi; xem phí tạm tính khi xe còn trong bãi', async () => {
  const pool = await makePool();
  await pool.query(`UPDATE pricing_rules SET overnight_fee=0`);   // test không phụ thuộc giờ chạy
  const enter = await s.moveSlot(pool, P, 'A01', ['AVAILABLE'], 'OCCUPIED', 'CAR_ENTER', '30A12345');
  const id = enter.body.session.id;
  await pool.query(`UPDATE parking_sessions SET entered_at = now() - interval '150 minutes' WHERE id=$1`, [id]);
  const q = await s.quote(pool, id);
  assert.equal(q.final, false);
  assert.equal(q.fee, 25000 + 10000);                              // 150 phút = 2 giờ đầu + 1 giờ (tròn lên)
  const exit = await s.moveSlot(pool, P, 'A01', ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT', undefined, { cash: true });
  assert.equal(exit.body.session.fee, 35000);
  assert.equal(exit.body.session.paymentMethod, 'CASH');
  assert.ok(exit.body.session.breakdown.length);
  assert.equal((await s.quote(pool, id)).final, true);
  assert.equal((await one(pool, `SELECT fee FROM parking_sessions WHERE id=$1`, [id])).fee, 35000);
});

// ---- NV-04: thanh toán ----
async function parkedFor(pool, minutes, plate = '30A12345') {
  await pool.query(`UPDATE pricing_rules SET overnight_fee=0`);
  const r = await s.reserve(pool, P, { ...req('rs'), licensePlate: plate });
  const id = (await s.moveSlot(pool, P, 'A01', ['RESERVED'], 'OCCUPIED', 'CAR_ENTER')).body.session.id;
  await pool.query(`UPDATE parking_sessions SET entered_at = now() - make_interval(mins => $2) WHERE id=$1`, [id, minutes]);
  return { id, userId: r.body.user_id };
}
const exitA01 = (pool, opts) => s.moveSlot(pool, P, 'A01', ['OCCUPIED'], 'AVAILABLE', 'CAR_EXIT', undefined, opts);

test('TC28 chưa trả tiền thì không cho ra (402, kèm số tiền); thu tiền mặt thì ra được; slot không đổi khi 402', async () => {
  const pool = await makePool();
  await parkedFor(pool, 150);
  const r = await exitA01(pool);
  assert.equal(r.code, 402);
  assert.deepEqual([r.body.error, r.body.fee], ['PAYMENT_REQUIRED', 35000]);
  assert.equal((await slot(pool, 'A01')).status, 'OCCUPIED');
  assert.equal((await exitA01(pool, { cash: true })).code, 200);
  // vào rồi ra ngay (phí 0) thì không cần trả
  await s.moveSlot(pool, P, 'A01', ['AVAILABLE'], 'OCCUPIED', 'CAR_ENTER');
  assert.equal((await exitA01(pool)).code, 200);
});

test('TC26 trả 2 lần cùng key: chỉ ghi nhận 1 lần, lần 2 trả lại kết quả cũ; key khác thì 409 ALREADY_PAID', async () => {
  const pool = await makePool();
  const { id, userId } = await parkedFor(pool, 150);
  const pay = (key, uid = userId) => s.pay(pool, { sessionId: id, method: 'ONLINE', paymentKey: `${uid}:${key}`, userId: uid });
  assert.equal((await pay('k1', 'u-khac')).code, 404);           // không phải phiên của mình
  const a = await pay('k1');
  assert.deepEqual([a.code, a.body.fee, a.body.paymentMethod], [200, 35000, 'ONLINE']);
  const b = await pay('k1');
  assert.deepEqual([b.code, b.replayed, b.body.paidAt], [200, true, a.body.paidAt]);
  assert.deepEqual(await pay('k2'), { code: 409, body: { error: 'ALREADY_PAID' } });
  // đã trả thì cho ra, giữ đúng số tiền đã trả
  const exit = await exitA01(pool);
  assert.deepEqual([exit.code, exit.body.session.fee, exit.body.session.paymentMethod], [200, 35000, 'ONLINE']);
});

// TC27 (2 lần trả song song khác key) cần nhiều kết nối thật -> nằm ở tests/e2e.test.mjs.
test('chưa đến phí (gửi dưới 5 phút) thì không cho trả', async () => {
  const pool = await makePool();
  const id = (await s.moveSlot(pool, P, 'A01', ['AVAILABLE'], 'OCCUPIED', 'CAR_ENTER')).body.session.id;
  assert.deepEqual(await s.pay(pool, { sessionId: id, method: 'CASH', paymentKey: 'staff:1' }), { code: 409, body: { error: 'NOTHING_TO_PAY' } });
});

test('TC18 cùng biển số vào lần 2 khi chưa ra: 409, slot thứ hai không bị chiếm', async () => {
  const pool = await makePool();
  const enter = (code) => s.moveSlot(pool, P, code, ['RESERVED', 'AVAILABLE'], 'OCCUPIED', 'CAR_ENTER', '29A-111.22');
  assert.equal((await enter('A01')).code, 200);
  assert.deepEqual(await enter('A02'), { code: 409, body: { error: 'PLATE_ALREADY_INSIDE' } });
  assert.equal((await slot(pool, 'A02')).status, 'AVAILABLE');
  // xe không rõ biển số (NULL) thì vào nhiều slot được
  assert.equal((await s.moveSlot(pool, P, 'A03', ['AVAILABLE'], 'OCCUPIED', 'CAR_ENTER')).code, 200);
  assert.equal((await s.moveSlot(pool, P, 'A04', ['AVAILABLE'], 'OCCUPIED', 'CAR_ENTER')).code, 200);
});

test('huỷ: chỉ chủ reservation huỷ được; slot về AVAILABLE; huỷ lần 2 -> 404', async () => {
  const pool = await makePool();
  const r = await s.reserve(pool, P, req('r1'));
  assert.equal((await s.endReservation(pool, P, r.body.id, 'CANCELLED', 'someone-else')).code, 404);
  assert.equal((await s.endReservation(pool, P, r.body.id, 'CANCELLED', 'u1')).code, 200);
  assert.deepEqual(await slot(pool, 'A01'), { status: 'AVAILABLE', version: 2 });
  assert.equal((await one(pool, `SELECT status FROM reservations WHERE id=$1`, [r.body.id])).status, 'CANCELLED');
  assert.equal((await s.endReservation(pool, P, r.body.id, 'CANCELLED', 'u1')).code, 404);
  assert.equal((await s.reserve(pool, P, req('r2', 'A01', 'u2'))).code, 201);   // đặt lại được
});

test('hết hạn: reservation quá giờ -> EXPIRED, slot AVAILABLE; chưa quá giờ thì giữ nguyên', async () => {
  const pool = await makePool();
  const old = await s.reserve(pool, P, req('r1', 'A01'));
  await s.reserve(pool, P, req('r2', 'A02'));
  await pool.query(`UPDATE reservations SET expire_time = now() - interval '1 minute' WHERE id=$1`, [old.body.id]);
  assert.equal(await s.expireDue(pool, P), 1);
  assert.deepEqual(await slot(pool, 'A01'), { status: 'AVAILABLE', version: 2 });
  assert.equal((await slot(pool, 'A02')).status, 'RESERVED');
  assert.equal(await s.expireDue(pool, P), 0);
});

test('availability, danh sách slot và reservation của user', async () => {
  const pool = await makePool('A', 5);
  await s.reserve(pool, P, req('r1', 'A01', 'u1'));
  await s.reserve(pool, P, req('r2', 'A02', 'u2'));
  assert.deepEqual(await s.availability(pool, P), { parkingId: 'A', available: 3, total: 5, byType: { CAR: { available: 3, total: 5 } } });
  assert.equal((await s.listSlots(pool, true)).length, 3);
  assert.deepEqual((await s.listSlots(pool, false))[0], { slotCode: 'A01', floor: 1, type: 'CAR', status: 'RESERVED', version: 1 });
  const mine = await s.listReservations(pool, 'u1');
  assert.deepEqual(mine.map((r) => [r.slotCode, r.status]), [['A01', 'ACTIVE']]);
});
