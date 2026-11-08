// Nghiệp vụ của một bãi. Mọi thay đổi trạng thái slot đi kèm 1 dòng parking_events (outbox)
// trong CÙNG giao dịch => có sự kiện khi và chỉ khi DB đã commit.

const { randomUUID } = require('node:crypto');
const { calcFee, fromRow } = require('./pricing');
const { requestId } = require('./log');
const hlc = require('./hlc');
const { context, propagation } = require('@opentelemetry/api');
const { fenceIn } = require('./fencing');
const { guardAdminIn, checkAdminIn, ADMIN_GATE_SQL } = require('./admin-guards');

// Dừng giao dịch với kết quả nghiệp vụ (409, 404...) thay vì lỗi hệ thống.
class Abort {
  constructor(code, body) { this.code = code; this.body = body; }
}

async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // PD-14b: DB không khớp epoch trên etcd (primary cũ sống lại) thì từ chối ghi
    if (typeof pool.checkEpoch === 'function') await pool.checkEpoch(c);
    // PD-10: lệnh của leader (có fencing token) kiểm token trong CÙNG giao dịch với lệnh ghi
    const fence = await fenceIn(c);
    if (!fence.ok) throw new Abort(fence.code, { error: fence.error, job: fence.job, token: fence.token });
    const out = await fn(c);
    // Kiểm lại trước COMMIT: giao dịch chậm qua lúc failover không được commit vào primary cũ
    if (typeof pool.checkEpoch === 'function') await pool.checkEpoch(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    if (e instanceof Abort) return { code: e.code, body: e.body };
    if (e.code === 'ETCD_UNREACHABLE' || e.status === 503) {
      return { code: 503, body: { error: 'ETCD_UNREACHABLE', message: e.message, ...e.details } };
    }
    if (e.code === 'STALE_DB_EPOCH' || e.status === 409) {
      return { code: 409, body: { error: 'STALE_DB_EPOCH', message: e.message, ...e.details } };
    }
    throw e;
  } finally {
    c.release();
  }
}

// Ghi sự kiện vào outbox. Kèm số chỗ trống hiện tại của bãi (để báo "sắp đầy") và `extra`
// (userId, reservationId... để dịch vụ thông báo biết gửi cho ai). Chỉ THÊM trường, không đổi trường cũ.
// Ghi HLC cùng sự kiện outbox trong giao dịch nghiệp vụ.
// HLC chỉ sắp thứ tự nhân quả, không dùng để tính phí hay hết hạn.
async function emit(c, parkingId, type, slotCode, status, version, plate,extra = {}, eventHlc = null) {
  const timestamp = eventHlc ?? hlc.now();

  const payload = {
    event: 'SLOT_UPDATED',
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    type,
    parkingId,
    slot: slotCode,
    status,
    version: Number(version),
    ...extra,
    hlc: timestamp,
    requestId: requestId(),
  };

  const carrier = {};
  propagation.inject(context.active(), carrier);
  return c.query(
    `WITH occupancy AS (
       SELECT count(*) FILTER (WHERE status='AVAILABLE')::int AS available,
              count(*) FILTER (WHERE status <> 'HIDDEN')::int AS total,
              count(*) FILTER (WHERE status='OCCUPIED')::int AS occupied
       FROM parking_slots
     )
     INSERT INTO parking_events(event_type, slot_code, license_plate, payload, hlc, traceparent)
     SELECT $1, $2, $3, to_jsonb(occupancy) || $4::jsonb, $5, $6 FROM occupancy`,
    [type, slotCode, plate ?? null, payload, timestamp, carrier.traceparent ?? null],
  );
}


const findByRequest = (pool, requestId) =>
  pool.query(
    `SELECT r.*, s.slot_code FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
     WHERE r.request_id = $1`, [requestId]);

// NV-01: đặt chỗ theo khung giờ. Mỗi reservation chiếm khoảng [start_time, end_time) của một slot; ràng buộc
// EXCLUDE ex_no_overlap của Postgres chặn 2 khoảng giao nhau trên cùng slot (không cần khoá ở code, không 2PC).
//   - Đặt NGAY (giờ đến <= now + `minutes`): giữ chỗ luôn, slot AVAILABLE -> RESERVED (compare-and-swap như cũ).
//   - Đặt TRƯỚC: chỉ ghi reservation; job activateDue giữ chỗ khi gần đến giờ.
// expire_time = giờ đến + `minutes`: quá giờ này chưa đến thì hết hạn (no-show).
// Mốc thời gian lấy theo now() của DB bãi.
// Bodies below use the caller's transaction; no BEGIN/COMMIT inside inbox processing.
async function business(c, fn, recover) {
  await c.query('SAVEPOINT business_operation; ' + ADMIN_GATE_SQL);
  try {
    // The transaction owner commits/rolls back after this operation, releasing the savepoint there.
    return await fn();
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT business_operation');
    await c.query('RELEASE SAVEPOINT business_operation');
    if (recover) return recover(e);
    if (e instanceof Abort) return { code: e.code, body: e.body };
    throw e;
  }
}

async function reserveIn(c, parkingId, input, minutes = 15) {
  const { requestId, userId, slotCode, licensePlate, startTime, durationMinutes = 120 } = input;
  const replayOr = async (fallback) => {
    const prior = await findByRequest(c, requestId);
    return prior.rowCount ? { code: 200, body: prior.rows[0], replayed: true } : fallback;
  };
  const prior = await replayOr(null);
  if (prior) return prior;
  return business(c, async () => {
    const denied = await checkAdminIn(c, { slotCode, licensePlate });
    if (denied) throw new Abort(denied.code, denied.body);
    // An immediate reservation uses the transaction clock in INSERT, avoiding a separate round trip.
    const now = startTime ? (await c.query('SELECT now() AS now')).rows[0].now : null;
    const start = startTime ? (new Date(startTime) > now ? new Date(startTime) : now) : null;
    const instant = !startTime || start - now <= minutes * 60_000;
    // Một biển số không giữ hai ô khác nhau trùng giờ trong cùng bãi (bấm nhầm / giữ chỗ hộ). Biển số đã chuẩn hoá ở
    // app.js; đặt ngay (start null) thì lấy now() của giao dịch. Cùng ô thì để ràng buộc khung giờ báo TIME_CONFLICT.
    const dup = (await c.query(
      `SELECT s.slot_code FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
       WHERE r.status IN ('ACTIVE','PENDING_SAGA') AND r.license_plate = $1 AND s.slot_code <> $4
         AND r.start_time < COALESCE($2::timestamptz, now()) + make_interval(mins => $3)
         AND r.end_time > COALESCE($2::timestamptz, now())
       LIMIT 1`, [licensePlate, start, durationMinutes, slotCode])).rows[0];
    if (dup) throw new Abort(409, { error: 'PLATE_ALREADY_BOOKED', slotCode: dup.slot_code });
    // compare-and-swap nguyên tử: chỉ một request thấy 1 dòng bị ảnh hưởng
    // The held row feeds the INSERT: a losing CAS creates no reservation, and a failed INSERT rolls back the CAS.
    const hold = instant
      ? `UPDATE parking_slots SET status='RESERVED',version=version+1,updated_at=now()
         WHERE slot_code=$3 AND status='AVAILABLE' RETURNING id,version`
      : `SELECT id,version FROM parking_slots WHERE slot_code=$3 AND status NOT IN ('MAINTENANCE','HIDDEN')`;
    const r = await c.query(
      `WITH held AS (${hold})
       INSERT INTO reservations(request_id,user_id,slot_id,license_plate,start_time,end_time,expire_time,status)
       SELECT $1,$2,held.id,$4,COALESCE($5::timestamptz,now()),
         COALESCE($5::timestamptz,now()) + make_interval(mins => $6),
         COALESCE($5::timestamptz,now()) + make_interval(mins => $7),$8 FROM held
       RETURNING *, (SELECT version FROM held) AS slot_version`,
      [requestId,userId,slotCode,licensePlate,start,durationMinutes,minutes,input.sagaId ? 'PENDING_SAGA' : 'ACTIVE']);
    if (!r.rowCount) throw new Abort(409, { error: 'SLOT_TAKEN' });
    const { slot_version: version, ...reservation } = r.rows[0];
    if (instant) await emit(c, parkingId, 'RESERVED', slotCode, 'RESERVED', version, licensePlate, { userId, reservationId: reservation.id });
    return { code: 201, body: { ...reservation, slot_code: slotCode },
      ...(instant && { replySlot: { slotCode, status: 'RESERVED', version: Number(version) } }) };
  }, async (e) => {
    if (e instanceof Abort) return replayOr({ code: e.code, body: e.body });
    if (e.code === '23P01') return replayOr({ code: 409, body: { error: 'TIME_CONFLICT' } });
    if (e.code === '23505') return replayOr({ code: 409, body: { error: 'SLOT_TAKEN' } });
    throw e;
  });
}

function reserve(pool, parkingId, input, minutes = 15) {
  return tx(pool, (c) => reserveIn(c, parkingId, input, minutes));
}

// Xe vãng lai không được vào slot sắp có người đặt trong khoảng này (phút).
const WALK_IN_GUARD_MIN = 120;

const SESSION_COLS = `ps.id, s.slot_code AS "slotCode", ps.license_plate AS "licensePlate", ps.user_id AS "userId",
  ps.reservation_id AS "reservationId", ps.entered_at AS "enteredAt", ps.hlc AS "hlc", ps.exited_at AS "exitedAt",
  ps.fee, ps.paid_at AS "paidAt", ps.payment_method AS "paymentMethod"`;

// Đổi trạng thái slot from -> to (enter/exit/maintenance) kèm sự kiện.
// Xe vào mở phiên gửi xe, xe ra đóng phiên, cùng giao dịch với đổi trạng thái slot.
function moveSlot(pool, parkingId, slotCode, from, to, type, plate, opts = {}) {
  return tx(pool, async (c) => {
    if (type === 'CAR_ENTER' || type === 'MAINTENANCE_OFF') {
      const denied = await guardAdminIn(c, { slotCode, licensePlate: plate, unlock: type === 'MAINTENANCE_OFF' });
      if (denied) throw new Abort(denied.code, denied.body);
    }
    const cur = (await c.query(`SELECT id, status FROM parking_slots WHERE slot_code=$1 FOR UPDATE`, [slotCode])).rows[0];
    if (!cur || !from.includes(cur.status)) throw new Abort(409, { error: 'INVALID_STATE' });
    const slotId = cur.id;
    if (type === 'CAR_ENTER' && cur.status === 'AVAILABLE') {
      const soon = (await c.query(
        `SELECT start_time FROM reservations WHERE slot_id=$1 AND status='ACTIVE'
           AND start_time < now() + make_interval(mins => $2) ORDER BY start_time LIMIT 1`, [slotId, WALK_IN_GUARD_MIN])).rows[0];
      if (soon) throw new Abort(409, { error: 'SLOT_RESERVED_SOON', startTime: soon.start_time });
    }
    const s = await c.query(
      `UPDATE parking_slots SET status=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING id, version`, [slotId, to]);
    let session = null;
    let sessionHlc = null;

    if (type === 'CAR_ENTER') {
      // Xe vào slot đang giữ chỗ = xe của lượt đặt đã được giữ (lượt ACTIVE sớm nhất của slot).
      const r = cur.status !== 'RESERVED' ? null : (await c.query(
        `UPDATE reservations SET status='USED' WHERE id = (
           SELECT id FROM reservations WHERE slot_id=$1 AND status='ACTIVE' ORDER BY start_time LIMIT 1)
         RETURNING id, user_id, license_plate`, [slotId])).rows[0];
      plate = plate || r?.license_plate || null;          // xe đặt trước: lấy biển số từ đặt chỗ
      const denied = await guardAdminIn(c, { licensePlate: plate });
      if (denied) throw new Abort(denied.code, denied.body);
      sessionHlc = hlc.now();

      const id = (await c.query(
        `INSERT INTO parking_sessions(
          slot_id, license_plate, reservation_id, user_id, hlc
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id`,
        [slotId, plate, r?.id ?? null, r?.user_id ?? null, sessionHlc]
      )).rows[0].id;

      session = await getSession(c, id);
    } else if (type === 'CAR_EXIT') {
      // Xe vào trước khi có bảng phiên thì không có phiên -> cho ra như cũ.
      const open = (await c.query(
        `SELECT id, license_plate, paid_at, fee, reservation_id FROM parking_sessions WHERE slot_id=$1 AND exited_at IS NULL FOR UPDATE`,
        [slotId])).rows[0];
      if (open) {
        plate = plate || open.license_plate;
        const q = await quoteIn(c, open.id);
        // NV-04: còn tiền phải trả thì không cho ra; nhân viên thu tiền mặt = trả CASH + cho ra trong một giao dịch.
        // Đã trả trong bãi: trong 15 phút giữ số đã trả; quá hạn mà phí tăng thì phải trả thêm phần chênh (q.due).
        if (q.due > 0 && !opts.cash) {
          throw new Abort(402, { error: 'PAYMENT_REQUIRED', sessionId: open.id, fee: q.due, total: q.fee, paid: q.paid,
            extra: !!open.paid_at, breakdown: q.breakdown });
        }
        const fee = q.due > 0 || !open.paid_at ? q.fee : open.fee;
        await c.query(
          `UPDATE parking_sessions SET exited_at=now(), fee=$2,
             paid_at = COALESCE(paid_at, CASE WHEN $2 > 0 THEN now() END),
             payment_method = COALESCE(payment_method, CASE WHEN $2 > 0 THEN 'CASH' END)
           WHERE id=$1`, [open.id, fee]);
        // xe ra: lượt đặt kết thúc, phần khung giờ còn lại trả cho người khác
        await c.query(`UPDATE reservations SET status='DONE' WHERE id=$1 AND status='USED'`, [open.reservation_id]);
        session = { ...(await getSession(c, open.id)), breakdown: q.breakdown };
      }
    }
    const eventExtra = session?.id
      ? {
          sessionId: session.id,
          ...(session.userId ? { userId: session.userId } : {}),
          ...(session.reservationId
            ? { reservationId: session.reservationId }
            : {}),
        }
      : {};

    await emit(
      c,
      parkingId,
      type,
      slotCode,
      to,
      s.rows[0].version,
      plate,
      {
        ...eventExtra,
        ...(session && {
          enteredAt: session.enteredAt,
          exitedAt: session.exitedAt,
          fee: Number(session.fee || 0),
          paidAt: session.paidAt,
          paymentMethod: session.paymentMethod,
        }),
      },
      sessionHlc,
    );
    return { code: 200, body: { slot: slotCode, status: to, version: Number(s.rows[0].version), ...(session && { session }) } };
  }).catch((e) => {
    // ux_open_session_plate: biển số này đang có xe trong bãi
    if (e.code === '23505') return { code: 409, body: { error: 'PLATE_ALREADY_INSIDE' } };
    throw e;
  });
}

const getSession = async (c, id) => (await c.query(
  `SELECT ${SESSION_COLS} FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id WHERE ps.id=$1`, [id])).rows[0];

// Trả tiền trong bãi xong có PAY_GRACE_MIN phút để ra. Quá hạn mà phí đã lên mức cao hơn -> phải trả thêm phần chênh
// (trước đây trả sớm là khoá số tiền: trả lúc 1 giờ rồi ở thêm 5 giờ vẫn ra với giá 1 giờ).
const PAY_GRACE_MIN = 15;

// Phí của một phiên: đã ra thì tính đến giờ ra; còn trong bãi thì tạm tính đến now() của DB bãi.
// paid: số đã trả; due: số còn phải trả bây giờ (0 nếu đã trả và còn trong 15 phút, hoặc phí chưa tăng).
async function quoteIn(c, sessionId) {
  const r = (await c.query(
    `SELECT ps.entered_at, COALESCE(ps.exited_at, now()) AS until, ps.exited_at, ps.paid_at, ps.fee AS paid_fee,
            (ps.paid_at IS NOT NULL AND now() - ps.paid_at > make_interval(mins => $2)) AS pay_expired,
            ps.paid_at + make_interval(mins => $2) AS pay_deadline, pr.*
     FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id
     LEFT JOIN pricing_rules pr ON pr.vehicle_type = s.type WHERE ps.id=$1`, [sessionId, PAY_GRACE_MIN])).rows[0];
  if (!r) return null;
  const q = r.vehicle_type ? calcFee(fromRow(r), r.entered_at, r.until) : { fee: 0, minutes: 0, breakdown: [] };
  const paid = r.paid_at ? (r.paid_fee ?? 0) : 0;
  const due = !r.paid_at ? q.fee : (!r.exited_at && r.pay_expired && q.fee > paid ? q.fee - paid : 0);
  return { sessionId, ...q, final: !!r.exited_at, paid, due, paidAt: r.paid_at, payDeadline: r.pay_deadline };
}
const quote = (pool, sessionId) => quoteIn(pool, sessionId);

const listPricing = async (pool) => (await pool.query('SELECT * FROM pricing_rules ORDER BY vehicle_type')).rows.map(fromRow);

// NV-04: thanh toán (giả lập). paymentKey = "<userId>:<Idempotency-Key>": bấm lại / retry trả lại kết quả cũ,
// không ghi nhận lần hai. Trả khi xe còn trong bãi thì khoá số tiền theo phí tạm tính lúc trả.
async function payIn(c, { sessionId, method, paymentKey, userId, parkingId }) {
  const replay = async (fallback) => {
    const r = (await c.query(`SELECT ${SESSION_COLS} FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id
      WHERE ps.payment_key=$1 AND ps.id=$2 AND ($3::text IS NULL OR ps.user_id=$3)`, [paymentKey, sessionId, userId ?? null])).rows[0];
    return r ? { code: 200, body: r, replayed: true } : fallback;
  };
  const prior = await replay(null);
  if (prior) return prior;
  return business(c, async () => {
    const cur = (await c.query(
      `SELECT paid_at, user_id FROM parking_sessions WHERE id=$1 FOR UPDATE`, [sessionId])).rows[0];
    if (!cur || (userId && cur.user_id !== userId)) throw new Abort(404, { error: 'SESSION_NOT_FOUND' });
    const q = await quoteIn(c, sessionId);
    // Đã trả và chưa phát sinh thêm -> ALREADY_PAID; quá 15 phút mà phí tăng -> trả phần chênh (ghi tổng mới).
    if (q.due <= 0) throw new Abort(409, { error: cur.paid_at ? 'ALREADY_PAID' : 'NOTHING_TO_PAY' });
    await c.query(
      `UPDATE parking_sessions SET paid_at=now(), payment_method=$2, payment_key=$3, fee=$4 WHERE id=$1`,
      [sessionId, method, paymentKey, q.fee],
    );
    const session = await getSession(c, sessionId);
    if (parkingId) {
      await emit(c, parkingId, 'PAYMENT_COMPLETED', session.slotCode, undefined, 0, null, {
        event: 'PAYMENT_COMPLETED',
        sessionId,
        fee: Number(session.fee),
        occurredAt: session.paidAt,
      });
    }
    return { code: 200, body: session };
  }, (e) => {
    if (e instanceof Abort) {
      const out = { code: e.code, body: e.body };
      return e.code === 409 && e.body.error === 'ALREADY_PAID' ? replay(out) : out;
    }
    if (e.code === '23505') return replay({ code: 422, body: { error: 'IDEMPOTENCY_KEY_REUSED' } });
    throw e;
  });
}
function pay(pool, input) { return tx(pool, (c) => payIn(c, input)); }

// Lịch sử phiên gửi xe: chuẩn hoá biển số và sắp xếp theo HLC của lần CAR_ENTER.
// Phiên cũ chưa có HLC được xếp sau các phiên có HLC; entered_at là tiêu chí phụ.
// Biển số khớp MỘT PHẦN sau khi bỏ dấu cách/chấm/gạch, không phân biệt hoa thường: "12345" tìm ra 30A-123.45.
const listSessions = async (pool, { plate, userId, from, to } = {}) =>
  (await pool.query(
    `SELECT ${SESSION_COLS}
     FROM parking_sessions ps
     JOIN parking_slots s ON s.id = ps.slot_id
     WHERE ($1::text IS NULL OR position(regexp_replace(upper($1), '[^A-Z0-9]', '', 'g')
                                         in regexp_replace(upper(ps.license_plate), '[^A-Z0-9]', '', 'g')) > 0)
       AND ($2::text IS NULL OR ps.user_id = $2)
       AND ($3::timestamptz IS NULL OR ps.entered_at >= $3)
       AND ($4::timestamptz IS NULL OR ps.entered_at < $4)
     ORDER BY ps.hlc DESC NULLS LAST, ps.entered_at DESC
     LIMIT 200`,
    [plate || null, userId || null, from || null, to || null],
  )).rows;
// Kết thúc một reservation ACTIVE (huỷ hoặc hết hạn): không xoá cứng, đổi status (dấu vết để đối soát).
function endReservationIn(c, parkingId, id, status, userId, sagaId, step) {
  return business(c, async () => {
    const r = await c.query(
      `UPDATE reservations SET status=$2 WHERE id=$1 AND status IN ('ACTIVE','PENDING_SAGA')
       AND ($3::text IS NULL OR user_id=$3)
       AND ($4::text IS NULL OR request_id=$4 || ':' || $5::int || ':reserve')
       RETURNING slot_id, license_plate, start_time, user_id`, [id, status, userId ?? null, sagaId ?? null, step ?? null]);
    if (!r.rowCount) throw new Abort(404, { error: 'RESERVATION_NOT_ACTIVE' });
    // Chỉ trả slot khi lượt này là lượt đang giữ chỗ (không còn lượt ACTIVE nào giờ sớm hơn).
    // Huỷ lượt đặt cho ngày mai không được nhả chỗ đang giữ cho người khác hôm nay.
    const s = await c.query(
      `UPDATE parking_slots SET status='AVAILABLE', version=version+1, updated_at=now()
       WHERE id=$1 AND status='RESERVED'
         AND NOT EXISTS (SELECT 1 FROM reservations WHERE slot_id=$1 AND status IN ('ACTIVE','PENDING_SAGA') AND start_time <= $2)
       RETURNING slot_code, version`, [r.rows[0].slot_id, r.rows[0].start_time]);
    if (s.rowCount) {
      await emit(c, parkingId, status, s.rows[0].slot_code, 'AVAILABLE', s.rows[0].version, r.rows[0].license_plate,
        { userId: r.rows[0].user_id, reservationId: id });
    }
    return { code: 200, body: { id, status },
      ...(s.rowCount && { replySlot: { slotCode: s.rows[0].slot_code, status: 'AVAILABLE', version: Number(s.rows[0].version) } }) };
  });
}

function endReservation(pool, parkingId, id, status, userId) {
  return tx(pool, (c) => endReservationIn(c, parkingId, id, status, userId));
}

function confirmSagaIn(c, id, userId, sagaId, step) {
  return business(c, async () => {
    const r = await c.query(
      `UPDATE reservations SET status='ACTIVE' WHERE id=$1 AND user_id=$2
       AND status='PENDING_SAGA' AND request_id=$3 || ':' || $4::int || ':reserve' RETURNING id`, [id, userId, sagaId, step]);
    if (!r.rowCount) throw new Abort(404, { error: 'RESERVATION_NOT_PENDING_SAGA' });
    return { code: 200, body: { id, status: 'ACTIVE' } };
  });
}

// Hết hạn theo đồng hồ DB của CHÍNH bãi này (một nguồn thời gian duy nhất, không tin giờ client).
async function expireDue(pool, parkingId) {
  const due = await pool.query(`SELECT id FROM reservations WHERE status='ACTIVE' AND expire_time < now()`);
  for (const { id } of due.rows) await endReservation(pool, parkingId, id, 'EXPIRED');
  return due.rows.length;
}

// NV-01: gần đến giờ (<= `minutes` phút) thì giữ chỗ cho lượt đặt trước. Slot vẫn có xe (xe trước ở quá giờ)
// hoặc đang bảo trì -> chuyển lượt đặt sang slot trống cùng loại (ex_no_overlap tự kiểm khung giờ ở slot mới).
async function activateDue(pool, parkingId, minutes = 15) {
  const due = (await pool.query(
    `SELECT r.id FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
     WHERE r.status='ACTIVE' AND s.status <> 'RESERVED' AND r.start_time <= now() + make_interval(mins => $1)
     ORDER BY r.start_time`, [minutes])).rows;
  let done = 0;
  for (const { id } of due) {
    const out = await tx(pool, async (c) => {
      const r = (await c.query(
        `SELECT r.*, s.status AS slot_status, s.type FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
         WHERE r.id=$1 AND r.status='ACTIVE' FOR UPDATE OF r`, [id])).rows[0];
      if (!r || r.slot_status === 'RESERVED') return null;
      let slotId = r.slot_id;
      let type = 'RESERVED';
      if (r.slot_status !== 'AVAILABLE') {
        const alt = (await c.query(
          `SELECT s.id FROM parking_slots s
           WHERE s.type=$1 AND s.status='AVAILABLE' AND NOT EXISTS (
             SELECT 1 FROM reservations o WHERE o.slot_id=s.id AND o.status IN ('ACTIVE','USED')
               AND tstzrange(o.start_time, o.end_time) && tstzrange($2, $3))
           ORDER BY s.slot_code LIMIT 1 FOR UPDATE`, [r.type, r.start_time, r.end_time])).rows[0];
        // ponytail: hết chỗ thì chờ vòng sau (xe trước có thể ra); muốn báo nhân viên thì phát sự kiện ở đây (NV-08)
        if (!alt) return null;
        await c.query(`UPDATE reservations SET slot_id=$2 WHERE id=$1`, [id, alt.id]);
        slotId = alt.id;
        type = 'RESERVATION_MOVED';
      }
      const s = (await c.query(
        `UPDATE parking_slots SET status='RESERVED', version=version+1, updated_at=now()
         WHERE id=$1 AND status='AVAILABLE' RETURNING slot_code, version`, [slotId])).rows[0];
      if (!s) return null;
      await emit(c, parkingId, type, s.slot_code, 'RESERVED', s.version, r.license_plate, { userId: r.user_id, reservationId: id });
      return s.slot_code;
    }).catch((e) => { if (e.code === '23P01') return null; throw e; });   // slot mới vừa bị đặt chồng giờ: thử vòng sau
    if (out) done++;
  }
  return done;
}

// NV-09: quản lý slot. Gỡ slot = xoá mềm (status HIDDEN): giữ lịch sử phiên/đặt chỗ, thêm lại được.
// Mọi thay đổi đi kèm sự kiện để cache của Aggregator cập nhật.
function addSlot(pool, parkingId, { slotCode, floor, type }) {
  return tx(pool, async (c) => {
    // mã đã từng có nhưng đang ẩn -> bật lại với tầng/loại mới; đang dùng -> 409
    const s = (await c.query(
      `INSERT INTO parking_slots(slot_code, floor, type) VALUES ($1,$2,$3)
       ON CONFLICT (slot_code) DO UPDATE SET status='AVAILABLE', floor=$2, type=$3, version=parking_slots.version+1, updated_at=now()
         WHERE parking_slots.status='HIDDEN'
       RETURNING slot_code, floor, type, status, version`, [slotCode, floor, type])).rows[0];
    if (!s) throw new Abort(409, { error: 'SLOT_EXISTS' });
    await emit(c, parkingId, 'SLOT_ADDED', s.slot_code, s.status, s.version);
    return { code: 201, body: { slotCode: s.slot_code, floor: s.floor, type: s.type, status: s.status, version: Number(s.version) } };
  });
}

// Đổi tầng/loại: chỉ khi slot không có xe và không có lượt đặt còn hiệu lực (tránh đổi loại xe dưới chân người đã đặt).
function updateSlot(pool, parkingId, slotCode, { floor, type }) {
  return tx(pool, async (c) => {
    const s = (await c.query(
      `UPDATE parking_slots p SET floor=COALESCE($2, floor), type=COALESCE($3, type), version=version+1, updated_at=now()
       WHERE slot_code=$1 AND status IN ('AVAILABLE','MAINTENANCE')
         AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id=p.id AND r.status IN ('ACTIVE','USED'))
       RETURNING slot_code, floor, type, status, version`, [slotCode, floor ?? null, type ?? null])).rows[0];
    if (!s) throw new Abort(409, { error: 'SLOT_IN_USE' });
    await emit(c, parkingId, 'SLOT_CHANGED', s.slot_code, s.status, s.version);
    return { code: 200, body: { slotCode: s.slot_code, floor: s.floor, type: s.type, status: s.status, version: Number(s.version) } };
  });
}

// Gỡ slot bằng MỘT câu UPDATE có điều kiện: không có xe, không có lượt đặt còn hiệu lực.
function hideSlot(pool, parkingId, slotCode) {
  return tx(pool, async (c) => {
    const s = (await c.query(
      `UPDATE parking_slots p SET status='HIDDEN', version=version+1, updated_at=now()
       WHERE slot_code=$1 AND status IN ('AVAILABLE','MAINTENANCE')
         AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id=p.id AND r.status IN ('ACTIVE','USED'))
       RETURNING slot_code, version`, [slotCode])).rows[0];
    if (!s) throw new Abort(409, { error: 'SLOT_IN_USE' });
    await emit(c, parkingId, 'SLOT_HIDDEN', s.slot_code, 'HIDDEN', s.version);
    return { code: 200, body: { slotCode: s.slot_code, status: 'HIDDEN', version: Number(s.version) } };
  });
}

// NV-08: lượt đang giữ chỗ còn <= `minutes` phút là hết hạn mà xe chưa đến -> phát RESERVATION_EXPIRING một lần
// (warned_at). Sự kiện giữ nguyên version slot nên cache Aggregator bỏ qua, chỉ dịch vụ thông báo dùng.
async function warnExpiring(pool, parkingId, minutes = 5) {
  const due = (await pool.query(
    `UPDATE reservations r SET warned_at = now() FROM parking_slots s
     WHERE s.id = r.slot_id AND r.status='ACTIVE' AND r.warned_at IS NULL AND s.status='RESERVED'
       AND r.expire_time <= now() + make_interval(mins => $1)
     RETURNING r.id, r.user_id, r.license_plate, r.expire_time, s.slot_code, s.version`, [minutes])).rows;
  for (const r of due) {
    await emit(pool, parkingId, 'RESERVATION_EXPIRING', r.slot_code, 'RESERVED', r.version, r.license_plate,
      { userId: r.user_id, reservationId: r.id, expireTime: r.expire_time });
  }
  return due.length;
}

// Lịch đặt của một slot trong một ngày (giờ VN), không kèm thông tin cá nhân.
const slotSchedule = async (pool, slotCode, date) => (await pool.query(
  `SELECT r.start_time AS "startTime", r.end_time AS "endTime", r.status
   FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
   WHERE s.slot_code=$1 AND r.status IN ('ACTIVE','USED')
     AND tstzrange(r.start_time, r.end_time) && tstzrange(($2::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh',
                                                          ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
   ORDER BY r.start_time`, [slotCode, date])).rows;

// UX-02: thống kê của bãi trong [from, to): lượt xe (theo giờ vào), doanh thu (đã trả), thời gian gửi TB, lấp đầy hiện tại.
// Giờ trong ngày tính theo giờ Việt Nam.
async function stats(pool, from, to) {
  const t = (await pool.query(
    `SELECT count(*)::int AS sessions,
            COALESCE(sum(fee) FILTER (WHERE paid_at IS NOT NULL), 0)::int AS revenue,
            count(*) FILTER (WHERE exited_at IS NOT NULL)::int AS exited,
            COALESCE(round(avg(EXTRACT(EPOCH FROM exited_at - entered_at) / 60) FILTER (WHERE exited_at IS NOT NULL)), 0)::int AS "avgMinutes"
     FROM parking_sessions WHERE entered_at >= $1 AND entered_at < $2`, [from, to])).rows[0];
  const byHour = Array(24).fill(0);
  for (const r of (await pool.query(
    `SELECT EXTRACT(HOUR FROM entered_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS h, count(*)::int AS n
     FROM parking_sessions WHERE entered_at >= $1 AND entered_at < $2 GROUP BY h`, [from, to])).rows) byHour[r.h] = r.n;
  const occ = (await pool.query(
    `SELECT count(*) FILTER (WHERE status='OCCUPIED')::int AS occupied, count(*)::int AS total
     FROM parking_slots WHERE status <> 'HIDDEN'`)).rows[0];
  return { ...t, byHour, ...occ };
}

// Tổng chỗ trống + theo từng loại xe (CAR/MOTO).
const availability = async (pool, parkingId) => {
  const rows = (await pool.query(
    `SELECT type, count(*) FILTER (WHERE status='AVAILABLE')::int AS available, count(*)::int AS total
     FROM parking_slots WHERE status <> 'HIDDEN' GROUP BY type ORDER BY type`)).rows;
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  return {
    parkingId, available: sum('available'), total: sum('total'),
    byType: Object.fromEntries(rows.map((r) => [r.type, { available: r.available, total: r.total }])),
  };
};

const listSlots = async (pool, onlyAvailable, type) => (await pool.query(
  `SELECT slot_code AS "slotCode", floor, type, status, version::int AS version
   FROM parking_slots
   WHERE status <> 'HIDDEN' AND ($1::bool IS NOT TRUE OR status='AVAILABLE') AND ($2::text IS NULL OR type=$2)
   ORDER BY slot_code`, [!!onlyAvailable, type ?? null])).rows;

const listReservations = async (pool, userId) => (await pool.query(
  `SELECT r.id, r.request_id AS "requestId", r.user_id AS "userId", s.slot_code AS "slotCode",
          r.license_plate AS "licensePlate", r.start_time AS "startTime", r.end_time AS "endTime",
          r.expire_time AS "expireTime", r.status
   FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
   WHERE ($1::text IS NULL OR r.user_id = $1) ORDER BY r.created_at DESC`, [userId ?? null])).rows;

module.exports = { tx, reserveIn, endReservationIn, confirmSagaIn, payIn, reserve, moveSlot, endReservation, expireDue, activateDue, warnExpiring, slotSchedule, stats, addSlot, updateSlot, hideSlot, availability, listSlots, listReservations, listSessions, quote, pay, listPricing, emit };
