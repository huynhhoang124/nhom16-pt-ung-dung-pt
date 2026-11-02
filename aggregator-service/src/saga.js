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

// timeoutMs: hàm trả timeout hiện tại (PD-11 đổi được qua etcd khi đang chạy)
function makeSagas({ pool, reg, timeoutMs = () => 3000 }) {
  // Gọi node; trả { status, body } hoặc { status: 0 } nếu không gọi được / timeout (không rõ kết quả).
  async function call(parkingId, path, opts, fence) {
    const n = reg.get(parkingId);
    if (!n) return { status: 404, body: { error: 'PARKING_NOT_FOUND' } };
    if (n.status === 'OFFLINE') return { status: 503, body: { error: 'PARKING_OFFLINE' } };
    try {
      const r = await reg.call(n, path, { ms: timeoutMs(), ...fence, ...opts });
      return { status: r.status, body: await r.json() };
    } catch {
      return { status: 0 };
    }
  }

  const reserveStep = (saga, i, fence) => {
    const s = saga.steps[i];
    return call(s.parkingId, '/api/reservations', {
      method: 'POST', retry: true,   // an toàn: requestId idempotent
      body: { requestId: `${saga.id}:${i}`, userId: saga.userId, slotCode: s.slotCode, licensePlate: s.licensePlate },
    }, fence);
  };

  async function compensate(saga, fence) {
    saga.status = 'COMPENSATING';
    await save(pool, saga);
    for (let i = saga.steps.length - 1; i >= 0; i--) {
      const s = saga.steps[i];
      if (s.state === 'UNKNOWN') {                      // hỏi lại bằng chính khoá cũ để biết đã tạo hay chưa
        const r = await reserveStep(saga, i, fence);
        if (r.body?.error === 'STALE_LEADER') return saga;   // PD-10: đã mất quyền leader, leader mới làm tiếp
        if (r.status === 200 || r.status === 201) Object.assign(s, { state: 'DONE', reservationId: r.body.id });
        else if (r.status === 409 || r.status === 400) s.state = 'FAILED';
        else continue;                                   // vẫn không rõ: để lần khôi phục sau
      }
      if (s.state !== 'DONE') continue;
      const r = await call(s.parkingId, `/api/reservations/${encodeURIComponent(s.reservationId)}`, { method: 'DELETE' }, fence);
      if (r.body?.error === 'STALE_LEADER') return saga;
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

  // Khởi động lại: bù trừ mọi saga dở dang. PD-10: leader truyền fencingToken lúc lên leader và isActive;
  // mất quyền leader thì dừng ngay, lệnh đang gửi mang token cũ nên node từ chối nếu leader mới đã ghi.
  async function recover(staleMs = 60_000, { fencingToken, isActive = () => true } = {}) {
    // Chỉ saga đứng yên quá `staleMs`: nhiều bản Aggregator dùng chung bảng, saga mới cập nhật là của bản khác đang chạy.
    const rows = (await pool.query(
      `SELECT * FROM sagas WHERE status IN ('RUNNING','COMPENSATING') AND updated_at < now() - make_interval(secs => $1)
       ORDER BY created_at`, [staleMs / 1000])).rows;
    let done = 0;
    for (const row of rows) {
      if (!isActive()) break;
      await compensate({ id: row.id, userId: row.user_id, status: row.status, steps: row.steps }, fencingToken ? { fencingToken } : undefined);
      done++;
    }
    return done;
  }

  const get = async (id, userId) =>
    (await pool.query('SELECT * FROM sagas WHERE id=$1 AND user_id=$2', [id, userId])).rows.map(view)[0] ?? null;

  return { start, recover, get, run, compensate };
}

// PD-07: khi bật broker, chỉ leader gửi bước đã ghi vào nhật ký.
function makeBrokerSagas({ pool, commandFlow, leader }) {
  const active = () => !leader || leader.isLeader();
  const token = () => leader?.getToken() ?? 0;
  const load = async (id) => (await pool.query('SELECT * FROM sagas WHERE id=$1', [id])).rows[0];
  const persist = async (saga) => save(pool, saga);
  const claims = new Set();

  async function call(saga, i, type, payload, fence) {
    const step = saga.steps[i];
    const messageId = `${saga.id}:${i}:${type}`;
    step.messageId = messageId;
    step.action = type;
    await persist(saga);  // Ghi ý định trước khi phát lệnh.
    if (!active() || token() !== fence) return null;
    try {
      const out = await commandFlow.execute({ parkingId: step.parkingId, type,
        user: { sub: saga.userId, role: 'USER' }, payload: { ...payload, sagaId: saga.id, step: i },
        key: messageId, fencingToken: fence });
      if (out.code === 202) return { status: 0 };
      return { status: out.code, body: out.body };
    } catch (e) {
      if (e.code === 'IDEMPOTENCY_KEY_REUSED') return { status: 409, body: { error: e.code } };
      return { status: 0 };
    }
  }

  const reserve = (saga, i, fence) => call(saga, i, 'reserve', {
    slotCode: saga.steps[i].slotCode, licensePlate: saga.steps[i].licensePlate,
  }, fence);

  async function compensate(saga, fence = token()) {
    saga.status = 'COMPENSATING';
    await persist(saga);
    for (let i = saga.steps.length - 1; i >= 0; i--) {
      if (!active() || token() !== fence) return saga;
      const step = saga.steps[i];
      if (step.state === 'UNKNOWN') {
        const r = await reserve(saga, i, fence);
        if (!r || r.body?.error === 'STALE_LEADER') return saga;
        if ([200, 201].includes(r.status)) Object.assign(step, { state: 'DONE', reservationId: r.body.id });
        else if ([400, 409].includes(r.status)) step.state = 'FAILED';
        else continue;
        await persist(saga);
      }
      if (step.state !== 'DONE' && step.state !== 'CONFIRMED') continue;
      const r = await call(saga, i, 'cancel', { reservationId: step.reservationId }, fence);
      if (!r || r.body?.error === 'STALE_LEADER') return saga;
      if (r.status === 200 || r.status === 404) step.state = 'COMPENSATED';
      await persist(saga);
    }
    saga.status = saga.steps.some((s) => ['DONE', 'UNKNOWN', 'CONFIRMED'].includes(s.state)) ? 'COMPENSATING' : 'FAILED';
    await persist(saga);
    return saga;
  }

  async function run(saga, fence = token()) {
    if (!active() || token() !== fence) return saga;
    if (saga.status === 'COMPENSATING') return compensate(saga, fence);
    if (saga.status === 'PENDING') saga.status = 'RUNNING';
    await persist(saga);
    if (saga.status === 'RUNNING') {
      for (let i = 0; i < saga.steps.length; i++) {
        if (!active() || token() !== fence) return saga;
        const step = saga.steps[i];
        if (step.state === 'DONE') continue;
        const r = await reserve(saga, i, fence);
        if (!r || r.body?.error === 'STALE_LEADER') return saga;
        if ([200, 201].includes(r.status)) Object.assign(step, { state: 'DONE', reservationId: r.body.id });
        else Object.assign(step, { state: r.status === 0 ? 'UNKNOWN' : 'FAILED', error: r.body?.error ?? 'TIMEOUT_UNKNOWN_RESULT' });
        await persist(saga);
        if (step.state !== 'DONE') return compensate(saga, fence);
      }
      saga.status = 'CONFIRMING';
      await persist(saga);
    }
    for (let i = 0; i < saga.steps.length; i++) {
      if (!active() || token() !== fence) return saga;
      const step = saga.steps[i];
      if (step.state === 'CONFIRMED') continue;
      const r = await call(saga, i, 'confirm', { reservationId: step.reservationId }, fence);
      if (!r || r.body?.error === 'STALE_LEADER') return saga;
      if (r.status !== 200) {
        if (r.status === 0) return saga; // Lệnh đã nhận có thể hoàn tất sau timeout; gửi lại cùng ID khi recover.
        step.error = r.body?.error ?? 'CONFIRM_FAILED';
        await persist(saga);
        return compensate(saga, fence);
      }
      step.state = 'CONFIRMED';
      await persist(saga);
    }
    saga.steps.forEach((step) => { step.state = 'DONE'; });
    saga.status = 'COMPLETED';
    await persist(saga);
    return saga;
  }

  async function start(userId, key, items) {
    const steps = items.map((x) => ({ ...x, state: 'PENDING' }));
    const requestId = `${userId}:${key}`;
    const row = (await pool.query(
      `INSERT INTO sagas(request_id, user_id, status, steps) VALUES ($1,$2,'PENDING',$3)
       ON CONFLICT (request_id) DO NOTHING RETURNING *`, [requestId, userId, JSON.stringify(steps)])).rows[0];
    if (!row) return { replayed: true, saga: view((await pool.query('SELECT * FROM sagas WHERE request_id=$1', [requestId])).rows[0]) };
    if (active()) {
      claims.add(row.id);
      try { await run({ id: row.id, userId, status: 'PENDING', steps }); }
      finally { claims.delete(row.id); }
    }
    return { replayed: false, saga: view(await load(row.id)) };
  }

  let recovering = false;
  async function recover(staleMs = 60_000, { fencingToken = token(), isActive = active } = {}) {
    if (!isActive() || recovering) return 0;
    recovering = true;
    try {
      const rows = (await pool.query(
        `SELECT * FROM sagas WHERE status='PENDING' OR
         (status IN ('RUNNING','CONFIRMING','COMPENSATING') AND updated_at < now() - make_interval(secs => $1))
         ORDER BY created_at`, [staleMs / 1000])).rows;
      let done = 0;
      for (const row of rows) {
        if (!isActive() || token() !== fencingToken) break;
        if (claims.has(row.id)) continue;
        claims.add(row.id);
        try {
          const saga = { id: row.id, userId: row.user_id, status: row.status, steps: row.steps };
          if (saga.status === 'COMPENSATING' || saga.status === 'RUNNING' || saga.steps.some((s) => s.state === 'UNKNOWN')) {
            await compensate(saga, fencingToken);
          } else await run(saga, fencingToken);
          done++;
        } finally { claims.delete(row.id); }
      }
      return done;
    } finally { recovering = false; }
  }

  const get = async (id, userId) =>
    (await pool.query('SELECT * FROM sagas WHERE id=$1 AND user_id=$2', [id, userId])).rows.map(view)[0] ?? null;
  return { start, recover, get, run, compensate };
}

const legacySagas = makeSagas;
module.exports = { makeSagas: (options) => options.commandFlow ? makeBrokerSagas(options) : legacySagas(options) };
