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
const { SpanStatusCode, trace } = require('@opentelemetry/api');
const tracer = trace.getTracer('aggregator/saga');

function makeSagas({ pool, reg, timeoutMs = 3000 }) {
  // Gọi node; trả { status, body } hoặc { status: 0 } nếu không gọi được / timeout (không rõ kết quả).
  async function call(parkingId, path, opts, { sagaId, step, action }) {
    return tracer.startActiveSpan('saga.step', {
      attributes: { 'saga.id': sagaId, 'saga.step': step, 'saga.action': action, 'parking.id': parkingId },
    }, async (span) => {
      try {
        const n = reg.get(parkingId);
        if (!n) {
          span.setAttribute('http.response.status_code', 404);
          return { status: 404, body: { error: 'PARKING_NOT_FOUND' } };
        }
        if (n.status === 'OFFLINE') {
          span.setAttribute('http.response.status_code', 503);
          return { status: 503, body: { error: 'PARKING_OFFLINE' } };
        }
        try {
          const r = await reg.call(n, path, { ms: timeoutMs, ...opts });
          const body = await r.json();
          span.setAttribute('http.response.status_code', r.status);
          if (r.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${r.status}` });
          return { status: r.status, body };
        } catch (error) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          return { status: 0 };
        }
      } finally {
        span.end();
      }
    });
  }

  const reserveStep = (saga, i) => {
    const s = saga.steps[i];
    return call(s.parkingId, '/api/reservations', {
      method: 'POST', retry: true,   // an toàn: requestId idempotent
      body: { requestId: `${saga.id}:${i}`, userId: saga.userId, slotCode: s.slotCode, licensePlate: s.licensePlate },
    }, { sagaId: saga.id, step: i, action: 'reserve' });
  };

  async function compensate(saga) {
    return tracer.startActiveSpan('saga.compensate', {
      attributes: { 'saga.id': saga.id, 'saga.steps.count': saga.steps.length },
    }, async (span) => {
      try {
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
          const r = await call(s.parkingId, `/api/reservations/${encodeURIComponent(s.reservationId)}`, { method: 'DELETE' },
            { sagaId: saga.id, step: i, action: 'compensate' });
          if (r.status === 200 || r.status === 404) s.state = 'COMPENSATED';
          await save(pool, saga);
        }
        const left = saga.steps.some((s) => s.state === 'DONE' || s.state === 'UNKNOWN');
        saga.status = left ? 'COMPENSATING' : 'FAILED';   // còn bước chưa bù được -> giữ COMPENSATING, khởi động lại sẽ làm tiếp
        span.setAttribute('saga.status', saga.status);
        await save(pool, saga);
        return saga;
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async function run(saga) {
    return tracer.startActiveSpan('saga.execute', {
      attributes: { 'saga.id': saga.id, 'saga.steps.count': saga.steps.length },
    }, async (span) => {
      try {
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
        span.setAttribute('saga.status', saga.status);
        await save(pool, saga);
        return saga;
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // Tạo + chạy. Cùng request_id (userId:Idempotency-Key) -> trả lại saga cũ, không chạy lần hai.
  async function start(userId, key, items) {
    return tracer.startActiveSpan('saga.start', { attributes: { 'saga.steps.count': items.length } }, async (span) => {
      try {
        const steps = items.map((x) => ({ parkingId: x.parkingId, slotCode: x.slotCode, licensePlate: x.licensePlate, state: 'PENDING' }));
        const row = (await pool.query(
          `INSERT INTO sagas(request_id, user_id, status, steps) VALUES ($1,$2,'RUNNING',$3)
           ON CONFLICT (request_id) DO NOTHING RETURNING *`, [`${userId}:${key}`, userId, JSON.stringify(steps)])).rows[0];
        if (!row) {
          span.setAttribute('saga.replayed', true);
          return { replayed: true, saga: view((await pool.query('SELECT * FROM sagas WHERE request_id=$1', [`${userId}:${key}`])).rows[0]) };
        }
        span.setAttribute('saga.id', row.id);
        const saga = { id: row.id, userId, status: 'RUNNING', steps };
        await run(saga);
        return { replayed: false, saga: view((await pool.query('SELECT * FROM sagas WHERE id=$1', [saga.id])).rows[0]) };
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: 2, message: error.message });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // Khởi động lại: bù trừ mọi saga dở dang.
  async function recover(staleMs = 60_000) {
    // Chỉ saga đứng yên quá `staleMs`: nhiều bản Aggregator dùng chung bảng, saga mới cập nhật là của bản khác đang chạy.
    const rows = (await pool.query(
      `SELECT * FROM sagas WHERE status IN ('RUNNING','COMPENSATING') AND updated_at < now() - make_interval(secs => $1)
       ORDER BY created_at`, [staleMs / 1000])).rows;
    for (const row of rows) await compensate({ id: row.id, userId: row.user_id, status: row.status, steps: row.steps });
    return rows.length;
  }

  const get = async (id, userId) =>
    (await pool.query('SELECT * FROM sagas WHERE id=$1 AND user_id=$2', [id, userId])).rows.map(view)[0] ?? null;

  return { start, recover, get, run, compensate };
}

module.exports = { makeSagas };
