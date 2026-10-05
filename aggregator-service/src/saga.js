// PT-07: Saga đặt chỗ cho NHIỀU xe ở NHIỀU bãi (mỗi bãi một DB riêng) — giao dịch phân tán không dùng 2PC.
//   - Đặt lần lượt từng bước; mỗi bước là một giao dịch CỤC BỘ ở một bãi, khoá idempotent "<sagaId>:<i>".
//   - Ghi trạng thái saga xuống DB Aggregator SAU MỖI BƯỚC (nhật ký để khôi phục).
//   - Một bước lỗi -> COMPENSATING: huỷ ngược các bước đã xong (bước bù trừ). Huỷ trả 404 = đã huỷ rồi -> coi là xong.
//   - Bước "không rõ kết quả" (timeout) -> gửi lại đúng khoá đó để biết kết quả (node trả lại bản cũ nếu đã tạo), rồi huỷ.
//   - Aggregator khởi động lại: saga còn RUNNING/COMPENSATING được bù trừ nốt (khôi phục lùi, an toàn nhất).
// Đánh đổi so với 2PC: có trạng thái trung gian nhìn thấy được (chỗ ở bãi A bị giữ vài trăm ms rồi nhả),
// đổi lại không bên nào phải khoá chờ khi một bãi chết.

const save = (pool, saga) => pool.query(
  `UPDATE sagas SET status=$2, steps=$3, updated_at=now() WHERE id=$1`, [saga.id, saga.status, JSON.stringify(saga.steps)]);

const view = (row) => ({ id: row.id, status: row.status, steps: row.steps, createdAt: row.created_at, updatedAt: row.updated_at });

function makeSagas({ pool, reg, timeoutMs = 3000 }) {
  // Gọi node; trả { status, body } hoặc { status: 0 } nếu không gọi được / timeout (không rõ kết quả).
  async function call(parkingId, path, opts) {
    const n = reg.get(parkingId);
    if (!n) return { status: 404, body: { error: 'PARKING_NOT_FOUND' } };
    if (n.status === 'OFFLINE') return { status: 503, body: { error: 'PARKING_OFFLINE' } };
    try {
      const r = await reg.call(n, path, { ms: timeoutMs, ...opts });
      return { status: r.status, body: await r.json() };
    } catch {
      return { status: 0 };
    }
  }

  const reserveStep = (saga, i) => {
    const s = saga.steps[i];
    return call(s.parkingId, '/api/reservations', {
      method: 'POST', retry: true,   // an toàn: requestId idempotent
      body: { requestId: `${saga.id}:${i}`, userId: saga.userId, slotCode: s.slotCode, licensePlate: s.licensePlate },
    });
  };

  async function compensate(saga) {
    saga.status = 'COMPENSATING';
    await save(pool, saga);
    for (let i = saga.steps.length - 1; i >= 0; i--) {
      const s = saga.steps[i];
      if (s.state === 'UNKNOWN') {                      // hỏi lại bằng chính khoá cũ để biết đã tạo hay chưa
        const r = await reserveStep(saga, i);
        if (r.status === 200 || r.status === 201) Object.assign(s, { state: 'DONE', reservationId: r.body.id });
        else if (r.status === 409 || r.status === 400) s.state = 'FAILED';
        else continue;                                   // vẫn không rõ: để lần khôi phục sau
      }
      if (s.state !== 'DONE') continue;
      const r = await call(s.parkingId, `/api/reservations/${encodeURIComponent(s.reservationId)}`, { method: 'DELETE' });
      if (r.status === 200 || r.status === 404) s.state = 'COMPENSATED';
      await save(pool, saga);
    }
    const left = saga.steps.some((s) => s.state === 'DONE' || s.state === 'UNKNOWN');
    saga.status = left ? 'COMPENSATING' : 'FAILED';   // còn bước chưa bù được -> giữ COMPENSATING, khởi động lại sẽ làm tiếp
    await save(pool, saga);
    return saga;
  }

  async function run(saga) {
    for (let i = 0; i < saga.steps.length; i++) {
      const s = saga.steps[i];
      if (s.state !== 'PENDING') continue;
      const r = await reserveStep(saga, i);
      if (r.status === 200 || r.status === 201) Object.assign(s, { state: 'DONE', reservationId: r.body.id });
      else Object.assign(s, { state: r.status === 0 ? 'UNKNOWN' : 'FAILED', error: r.body?.error ?? 'TIMEOUT_UNKNOWN_RESULT' });
      await save(pool, saga);
      if (s.state !== 'DONE') return compensate(saga);
    }
    saga.status = 'COMPLETED';
    await save(pool, saga);
    return saga;
  }

  // Tạo + chạy. Cùng request_id (userId:Idempotency-Key) -> trả lại saga cũ, không chạy lần hai.
  async function start(userId, key, items) {
    const steps = items.map((x) => ({ parkingId: x.parkingId, slotCode: x.slotCode, licensePlate: x.licensePlate, state: 'PENDING' }));
    const row = (await pool.query(
      `INSERT INTO sagas(request_id, user_id, status, steps) VALUES ($1,$2,'RUNNING',$3)
       ON CONFLICT (request_id) DO NOTHING RETURNING *`, [`${userId}:${key}`, userId, JSON.stringify(steps)])).rows[0];
    if (!row) return { replayed: true, saga: view((await pool.query('SELECT * FROM sagas WHERE request_id=$1', [`${userId}:${key}`])).rows[0]) };
    const saga = { id: row.id, userId, status: 'RUNNING', steps };
    await run(saga);
    return { replayed: false, saga: view((await pool.query('SELECT * FROM sagas WHERE id=$1', [saga.id])).rows[0]) };
  }

  // Khởi động lại: bù trừ mọi saga dở dang.
  async function recover() {
    const rows = (await pool.query(`SELECT * FROM sagas WHERE status IN ('RUNNING','COMPENSATING') ORDER BY created_at`)).rows;
    for (const row of rows) await compensate({ id: row.id, userId: row.user_id, status: row.status, steps: row.steps });
    return rows.length;
  }

  const get = async (id, userId) =>
    (await pool.query('SELECT * FROM sagas WHERE id=$1 AND user_id=$2', [id, userId])).rows.map(view)[0] ?? null;

  return { start, recover, get, run, compensate };
}

module.exports = { makeSagas };
