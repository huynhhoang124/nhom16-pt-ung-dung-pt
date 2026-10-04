// Nghiệp vụ của một bãi. Mọi thay đổi trạng thái slot đi kèm 1 dòng parking_events (outbox)
// trong CÙNG giao dịch => có sự kiện khi và chỉ khi DB đã commit.

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
     { event: 'SLOT_UPDATED', type, parkingId, slot: slotCode, status, version: Number(version) }]);
}

const findByRequest = (pool, requestId) =>
  pool.query(
    `SELECT r.*, s.slot_code FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
     WHERE r.request_id = $1`, [requestId]);

async function reserve(pool, parkingId, { requestId, userId, slotCode, licensePlate }, minutes = 15) {
  // Đã có bản ghi với requestId này (retry, hoặc request trùng chạy song song đã thắng) -> trả lại bản đó.
  const replayOr = async (fallback) => {
    const prior = await findByRequest(pool, requestId);
    return prior.rowCount ? { code: 200, body: prior.rows[0], replayed: true } : fallback;
  };
  const prior = await replayOr(null);
  if (prior) return prior;

  try {
    const out = await tx(pool, async (c) => {
      // compare-and-swap nguyên tử: chỉ một request thấy 1 dòng bị ảnh hưởng
      const s = await c.query(
        `UPDATE parking_slots SET status='RESERVED', version=version+1, updated_at=now()
         WHERE slot_code=$1 AND status='AVAILABLE' RETURNING id, version`, [slotCode]);
      if (!s.rowCount) throw new Abort(409, { error: 'SLOT_TAKEN' });
      const r = await c.query(
        `INSERT INTO reservations(request_id, user_id, slot_id, license_plate, expire_time)
         VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5)) RETURNING *`,
        [requestId, userId, s.rows[0].id, licensePlate, minutes]);
      await emit(c, parkingId, 'RESERVED', slotCode, 'RESERVED', s.rows[0].version, licensePlate);
      return { code: 201, body: { ...r.rows[0], slot_code: slotCode } };
    });
    // 409 có thể do chính request trùng của mình vừa giữ slot: chờ khoá xong thì slot đã RESERVED.
    return out.code === 409 ? await replayOr(out) : out;
  } catch (e) {
    if (e.code !== '23505') throw e;
    // vi phạm UNIQUE(request_id) khi đua nhau, hoặc ux_one_active_per_slot
    return replayOr({ code: 409, body: { error: 'SLOT_TAKEN' } });
  }
}

const SESSION_COLS = `ps.id, s.slot_code AS "slotCode", ps.license_plate AS "licensePlate", ps.user_id AS "userId",
  ps.reservation_id AS "reservationId", ps.entered_at AS "enteredAt", ps.exited_at AS "exitedAt",
  ps.fee, ps.paid_at AS "paidAt", ps.payment_method AS "paymentMethod"`;

// Đổi trạng thái slot from -> to (enter/exit/maintenance) kèm sự kiện.
// Xe vào mở phiên gửi xe, xe ra đóng phiên, cùng giao dịch với đổi trạng thái slot.
function moveSlot(pool, parkingId, slotCode, from, to, type, plate) {
  return tx(pool, async (c) => {
    const s = await c.query(
      `UPDATE parking_slots SET status=$3, version=version+1, updated_at=now()
       WHERE slot_code=$1 AND status = ANY($2) RETURNING id, version`, [slotCode, from, to]);
    if (!s.rowCount) throw new Abort(409, { error: 'INVALID_STATE' });
    const slotId = s.rows[0].id;
    let session = null;
    if (type === 'CAR_ENTER') {
      const r = (await c.query(
        `UPDATE reservations SET status='USED' WHERE status='ACTIVE' AND slot_id=$1
         RETURNING id, user_id, license_plate`, [slotId])).rows[0];
      plate = plate || r?.license_plate || null;          // xe đặt trước: lấy biển số từ đặt chỗ
      const id = (await c.query(
        `INSERT INTO parking_sessions(slot_id, license_plate, reservation_id, user_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [slotId, plate, r?.id ?? null, r?.user_id ?? null])).rows[0].id;
      session = await getSession(c, id);
    } else if (type === 'CAR_EXIT') {
      const open = (await c.query(
        `UPDATE parking_sessions SET exited_at=now() WHERE slot_id=$1 AND exited_at IS NULL RETURNING id, license_plate`,
        [slotId])).rows[0];
      plate = plate || open?.license_plate;
      session = open ? await getSession(c, open.id) : null;  // xe vào trước khi có bảng phiên thì không có phiên
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
       AND ($3::text IS NULL OR user_id=$3) RETURNING slot_id, license_plate`, [id, status, userId ?? null]);
    if (!r.rowCount) throw new Abort(404, { error: 'RESERVATION_NOT_ACTIVE' });
    const s = await c.query(
      `UPDATE parking_slots SET status='AVAILABLE', version=version+1, updated_at=now()
       WHERE id=$1 AND status='RESERVED' RETURNING slot_code, version`, [r.rows[0].slot_id]);
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

// Tổng chỗ trống + theo từng loại xe (CAR/MOTO).
const availability = async (pool, parkingId) => {
  const rows = (await pool.query(
    `SELECT type, count(*) FILTER (WHERE status='AVAILABLE')::int AS available, count(*)::int AS total
     FROM parking_slots GROUP BY type ORDER BY type`)).rows;
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  return {
    parkingId, available: sum('available'), total: sum('total'),
    byType: Object.fromEntries(rows.map((r) => [r.type, { available: r.available, total: r.total }])),
  };
};

const listSlots = async (pool, onlyAvailable, type) => (await pool.query(
  `SELECT slot_code AS "slotCode", floor, type, status, version::int AS version
   FROM parking_slots
   WHERE ($1::bool IS NOT TRUE OR status='AVAILABLE') AND ($2::text IS NULL OR type=$2)
   ORDER BY slot_code`, [!!onlyAvailable, type ?? null])).rows;

const listReservations = async (pool, userId) => (await pool.query(
  `SELECT r.id, r.request_id AS "requestId", r.user_id AS "userId", s.slot_code AS "slotCode",
          r.license_plate AS "licensePlate", r.start_time AS "startTime", r.expire_time AS "expireTime", r.status
   FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
   WHERE ($1::text IS NULL OR r.user_id = $1) ORDER BY r.created_at DESC`, [userId ?? null])).rows;

module.exports = { reserve, moveSlot, endReservation, expireDue, availability, listSlots, listReservations, listSessions, emit };
