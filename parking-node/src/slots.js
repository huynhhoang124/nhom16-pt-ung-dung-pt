// Nghiệp vụ của một bãi. Mọi thay đổi trạng thái slot đi kèm 1 dòng parking_events (outbox)
// trong CÙNG giao dịch => có sự kiện khi và chỉ khi DB đã commit.

const { calcFee, fromRow } = require('./pricing');
const { requestId } = require('./log');

// Dừng giao dịch với kết quả nghiệp vụ (409, 404...) thay vì lỗi hệ thống.
class Abort {
  constructor(code, body) { this.code = code; this.body = body; }
}

async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    if (e instanceof Abort) return { code: e.code, body: e.body };
    throw e;
  } finally {
    c.release();
  }
}

function emit(c, parkingId, type, slotCode, status, version, plate) {
  return c.query(
    `INSERT INTO parking_events(event_type, slot_code, license_plate, payload) VALUES ($1,$2,$3,$4)`,
    [type, slotCode, plate ?? null,
     { event: 'SLOT_UPDATED', type, parkingId, slot: slotCode, status, version: Number(version), requestId: requestId() }]);
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
async function reserve(pool, parkingId, { requestId, userId, slotCode, licensePlate, startTime, durationMinutes = 120 }, minutes = 15) {
  // Đã có bản ghi với requestId này (retry, hoặc request trùng chạy song song đã thắng) -> trả lại bản đó.
  const replayOr = async (fallback) => {
    const prior = await findByRequest(pool, requestId);
    return prior.rowCount ? { code: 200, body: prior.rows[0], replayed: true } : fallback;
  };
  const prior = await replayOr(null);
  if (prior) return prior;

  try {
    const out = await tx(pool, async (c) => {
      const now = (await c.query('SELECT now() AS now')).rows[0].now;
      const start = startTime && new Date(startTime) > now ? new Date(startTime) : now;
      const instant = start - now <= minutes * 60_000;
      let slot;
      if (instant) {
        // compare-and-swap nguyên tử: chỉ một request thấy 1 dòng bị ảnh hưởng
        slot = (await c.query(
          `UPDATE parking_slots SET status='RESERVED', version=version+1, updated_at=now()
           WHERE slot_code=$1 AND status='AVAILABLE' RETURNING id, version`, [slotCode])).rows[0];
      } else {
        slot = (await c.query(`SELECT id FROM parking_slots WHERE slot_code=$1 AND status NOT IN ('MAINTENANCE','HIDDEN')`, [slotCode])).rows[0];
      }
      if (!slot) throw new Abort(409, { error: 'SLOT_TAKEN' });
      const r = await c.query(
        `INSERT INTO reservations(request_id, user_id, slot_id, license_plate, start_time, end_time, expire_time)
         VALUES ($1,$2,$3,$4, $5::timestamptz, $5::timestamptz + make_interval(mins => $6), $5::timestamptz + make_interval(mins => $7)) RETURNING *`,
        [requestId, userId, slot.id, licensePlate, start, durationMinutes, minutes]);
      if (instant) await emit(c, parkingId, 'RESERVED', slotCode, 'RESERVED', slot.version, licensePlate);
      return { code: 201, body: { ...r.rows[0], slot_code: slotCode } };
    });
    // 409 có thể do chính request trùng của mình vừa giữ slot: chờ khoá xong thì slot đã RESERVED.
    return out.code === 409 ? await replayOr(out) : out;
  } catch (e) {
    // 23P01: khung giờ giao với một đặt chỗ khác của slot này (ex_no_overlap)
    if (e.code === '23P01') return replayOr({ code: 409, body: { error: 'TIME_CONFLICT' } });
    if (e.code !== '23505') throw e;
    // vi phạm UNIQUE(request_id) khi đua nhau
    return replayOr({ code: 409, body: { error: 'SLOT_TAKEN' } });
  }
}

// Xe vãng lai không được vào slot sắp có người đặt trong khoảng này (phút).
const WALK_IN_GUARD_MIN = 120;

const SESSION_COLS = `ps.id, s.slot_code AS "slotCode", ps.license_plate AS "licensePlate", ps.user_id AS "userId",
  ps.reservation_id AS "reservationId", ps.entered_at AS "enteredAt", ps.exited_at AS "exitedAt",
  ps.fee, ps.paid_at AS "paidAt", ps.payment_method AS "paymentMethod"`;

// Đổi trạng thái slot from -> to (enter/exit/maintenance) kèm sự kiện.
// Xe vào mở phiên gửi xe, xe ra đóng phiên, cùng giao dịch với đổi trạng thái slot.
function moveSlot(pool, parkingId, slotCode, from, to, type, plate, opts = {}) {
  return tx(pool, async (c) => {
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
    if (type === 'CAR_ENTER') {
      // Xe vào slot đang giữ chỗ = xe của lượt đặt đã được giữ (lượt ACTIVE sớm nhất của slot).
      const r = cur.status !== 'RESERVED' ? null : (await c.query(
        `UPDATE reservations SET status='USED' WHERE id = (
           SELECT id FROM reservations WHERE slot_id=$1 AND status='ACTIVE' ORDER BY start_time LIMIT 1)
         RETURNING id, user_id, license_plate`, [slotId])).rows[0];
      plate = plate || r?.license_plate || null;          // xe đặt trước: lấy biển số từ đặt chỗ
      const id = (await c.query(
        `INSERT INTO parking_sessions(slot_id, license_plate, reservation_id, user_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [slotId, plate, r?.id ?? null, r?.user_id ?? null])).rows[0].id;
      session = await getSession(c, id);
    } else if (type === 'CAR_EXIT') {
      // Xe vào trước khi có bảng phiên thì không có phiên -> cho ra như cũ.
      const open = (await c.query(
        `SELECT id, license_plate, paid_at, fee, reservation_id FROM parking_sessions WHERE slot_id=$1 AND exited_at IS NULL FOR UPDATE`,
        [slotId])).rows[0];
      if (open) {
        plate = plate || open.license_plate;
        const q = await quoteIn(c, open.id);
        const fee = open.paid_at ? open.fee : q.fee;     // đã trả trước thì giữ số tiền đã trả
        // NV-04: chưa trả thì không cho ra; nhân viên thu tiền mặt = trả CASH + cho ra trong một giao dịch.
        if (!open.paid_at && fee > 0 && !opts.cash) {
          throw new Abort(402, { error: 'PAYMENT_REQUIRED', sessionId: open.id, fee, breakdown: q.breakdown });
        }
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
    await emit(c, parkingId, type, slotCode, to, s.rows[0].version, plate);
    return { code: 200, body: { slot: slotCode, status: to, version: Number(s.rows[0].version), ...(session && { session }) } };
  }).catch((e) => {
    // ux_open_session_plate: biển số này đang có xe trong bãi
    if (e.code === '23505') return { code: 409, body: { error: 'PLATE_ALREADY_INSIDE' } };
    throw e;
  });
}

const getSession = async (c, id) => (await c.query(
  `SELECT ${SESSION_COLS} FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id WHERE ps.id=$1`, [id])).rows[0];

// Phí của một phiên: đã ra thì tính đến giờ ra; còn trong bãi thì tạm tính đến now() của DB bãi.
async function quoteIn(c, sessionId) {
  const r = (await c.query(
    `SELECT ps.entered_at, COALESCE(ps.exited_at, now()) AS until, ps.exited_at, pr.*
     FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id
     LEFT JOIN pricing_rules pr ON pr.vehicle_type = s.type WHERE ps.id=$1`, [sessionId])).rows[0];
  if (!r) return null;
  const q = r.vehicle_type ? calcFee(fromRow(r), r.entered_at, r.until) : { fee: 0, minutes: 0, breakdown: [] };
  return { sessionId, ...q, final: !!r.exited_at };
}
const quote = (pool, sessionId) => quoteIn(pool, sessionId);

const listPricing = async (pool) => (await pool.query('SELECT * FROM pricing_rules ORDER BY vehicle_type')).rows.map(fromRow);

// NV-04: thanh toán (giả lập). paymentKey = "<userId>:<Idempotency-Key>": bấm lại / retry trả lại kết quả cũ,
// không ghi nhận lần hai. Trả khi xe còn trong bãi thì khoá số tiền theo phí tạm tính lúc trả.
async function pay(pool, { sessionId, method, paymentKey, userId }) {
  const replay = async (fallback) => {
    const r = (await pool.query(`SELECT ${SESSION_COLS} FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id
                                 WHERE ps.payment_key=$1`, [paymentKey])).rows[0];
    return r ? { code: 200, body: r, replayed: true } : fallback;
  };
  const prior = await replay(null);
  if (prior) return prior;
  try {
    return await tx(pool, async (c) => {
      const cur = (await c.query(
        `SELECT paid_at, user_id FROM parking_sessions WHERE id=$1 FOR UPDATE`, [sessionId])).rows[0];
      if (!cur || (userId && cur.user_id !== userId)) throw new Abort(404, { error: 'SESSION_NOT_FOUND' });
      if (cur.paid_at) throw new Abort(409, { error: 'ALREADY_PAID' });
      const q = await quoteIn(c, sessionId);
      if (q.fee <= 0) throw new Abort(409, { error: 'NOTHING_TO_PAY' });
      await c.query(
        `UPDATE parking_sessions SET paid_at=now(), payment_method=$2, payment_key=$3, fee=$4 WHERE id=$1`,
        [sessionId, method, paymentKey, q.fee]);
      return { code: 200, body: await getSession(c, sessionId) };
    }).then((out) => (out.code === 409 && out.body.error === 'ALREADY_PAID' ? replay(out) : out));
  } catch (e) {
    if (e.code !== '23505') throw e;   // payment_key trùng do 2 request cùng key chạy song song
    return replay({ code: 409, body: { error: 'ALREADY_PAID' } });
  }
}

// Lịch sử phiên gửi xe. Biển số so khớp sau khi bỏ dấu cách/chấm/gạch, không phân biệt hoa thường.
const listSessions = async (pool, { plate, userId, from, to } = {}) => (await pool.query(
  `SELECT ${SESSION_COLS} FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id
   WHERE ($1::text IS NULL OR regexp_replace(upper(ps.license_plate), '[^A-Z0-9]', '', 'g')
                              = regexp_replace(upper($1), '[^A-Z0-9]', '', 'g'))
     AND ($2::text IS NULL OR ps.user_id = $2)
     AND ($3::timestamptz IS NULL OR ps.entered_at >= $3)
     AND ($4::timestamptz IS NULL OR ps.entered_at < $4)
   ORDER BY ps.entered_at DESC LIMIT 200`, [plate || null, userId || null, from || null, to || null])).rows;

// Kết thúc một reservation ACTIVE (huỷ hoặc hết hạn): không xoá cứng, đổi status (dấu vết để đối soát).
function endReservation(pool, parkingId, id, status, userId) {
  return tx(pool, async (c) => {
    const r = await c.query(
      `UPDATE reservations SET status=$2 WHERE id=$1 AND status='ACTIVE'
       AND ($3::text IS NULL OR user_id=$3) RETURNING slot_id, license_plate, start_time`, [id, status, userId ?? null]);
    if (!r.rowCount) throw new Abort(404, { error: 'RESERVATION_NOT_ACTIVE' });
    // Chỉ trả slot khi lượt này là lượt đang giữ chỗ (không còn lượt ACTIVE nào giờ sớm hơn).
    // Huỷ lượt đặt cho ngày mai không được nhả chỗ đang giữ cho người khác hôm nay.
    const s = await c.query(
      `UPDATE parking_slots SET status='AVAILABLE', version=version+1, updated_at=now()
       WHERE id=$1 AND status='RESERVED'
         AND NOT EXISTS (SELECT 1 FROM reservations WHERE slot_id=$1 AND status='ACTIVE' AND start_time < $2)
       RETURNING slot_code, version`, [r.rows[0].slot_id, r.rows[0].start_time]);
    if (s.rowCount) {
      await emit(c, parkingId, status, s.rows[0].slot_code, 'AVAILABLE', s.rows[0].version, r.rows[0].license_plate);
    }
    return { code: 200, body: { id, status } };
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
      await emit(c, parkingId, type, s.slot_code, 'RESERVED', s.version, r.license_plate);
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

module.exports = { reserve, moveSlot, endReservation, expireDue, activateDue, slotSchedule, stats, addSlot, updateSlot, hideSlot, availability, listSlots, listReservations, listSessions, quote, pay, listPricing, emit };
