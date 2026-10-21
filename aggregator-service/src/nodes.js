// Danh sách bãi + failure detector (health check) + circuit breaker + gọi node có timeout/retry.
//
// Health check chỉ là failure detector "eventually perfect": không phân biệt được node chết / chậm / mất tin.
// Vì vậy chỉ đánh dấu OFFLINE sau `failThreshold` lần lỗi liên tiếp, và mọi quyết định khi OFFLINE
// đều an toàn nếu báo nhầm (chỉ từ chối thừa, không bao giờ đặt trùng).
//
// Circuit breaker (PT-04): lỗi của request thật cũng cộng vào `fails`. Đủ ngưỡng thì "mở mạch" (OFFLINE) ngay,
// request sau bị từ chối tức thì thay vì chờ timeout. Health check định kỳ là phép thử "nửa mở":
// thành công thì "đóng mạch" (ONLINE) và đối soát.

const dns = require('node:dns');
const { requestId } = require('./log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tra DNS tên bãi -> IP mỗi vòng health check, request thật gọi thẳng IP. Lý do: fetch mở kết nối mới nào cũng
// tra DNS bằng getaddrinfo, chạy trên thread pool 4 luồng của Node; 250 người vào cùng lúc = vài trăm lần tra
// xếp hàng (đo được 375 lần mất 4,2 s) -> vượt timeout 2 s -> cả 3 bãi bị đánh dấu OFFLINE dù bãi vẫn khoẻ.
// Container đổi IP (khởi động lại) thì vòng health check sau (≤ 5 s) tra lại; tra lỗi thì dùng tên như cũ.
async function resolveUrl(url) {
  const u = new URL(url);
  if (!/^[\d.]+$/.test(u.hostname)) {
    try { u.hostname = (await dns.promises.lookup(u.hostname, { family: 4 })).address; } catch { return url; }
  }
  return u.href.replace(/\/$/, '');
}

function makeRegistry({ internalKey, timeoutMs = 2000, failThreshold = 3 }) {
  const nodes = new Map();

  function computeStatus(n) {
    const httpOk = n.fails < failThreshold;
    if (!httpOk) return 'OFFLINE';
    if (n.hasLease === false) return 'DEGRADED';
    return 'ONLINE';
  }

  function setStatus(n, status) {
    const prev = n.status;
    n.status = status;
    if (prev !== status) api.onChange?.(n, prev);
  }

  function setLease(id, hasLease) {
    const n = nodes.get(id);
    if (!n) return;
    n.hasLease = hasLease;
    setStatus(n, computeStatus(n));
  }

  // Bãi mới bắt đầu ở OFFLINE: lần health check thành công đầu tiên = chuyển ONLINE = đối soát luôn.
  const add = (row) => {
    let n = nodes.get(row.parking_id);
    if (n) {
      if (row.api_url) n.url = row.api_url;
      if (row.name) n.name = row.name;
      if (row.address !== undefined) n.address = row.address;
      if (row.lat !== undefined) n.lat = row.lat;
      if (row.lng !== undefined) n.lng = row.lng;
      if (row.public_url !== undefined) n.publicUrl = row.public_url;
      if (row.zone !== undefined) n.zone = row.zone;
      if (row.hasLease !== undefined) n.hasLease = row.hasLease;
      setStatus(n, computeStatus(n));
      return n;
    }
    n = {
      id: row.parking_id,
      name: row.name || `Bãi ${row.parking_id}`,
      url: row.api_url,
      address: row.address ?? null,
      lat: row.lat ?? null,
      lng: row.lng ?? null,
      publicUrl: row.public_url ?? null,
      status: 'OFFLINE',
      fails: failThreshold,
      lastSeen: null,
      zone: row.zone ?? null,
      hasLease: row.hasLease,
    };
    nodes.set(row.parking_id, n);
    setStatus(n, computeStatus(n));
    return n;
  };

  // Timeout dùng AbortSignal.timeout: bộ đếm của runtime, không phụ thuộc giờ hệ thống bị chỉnh.
  const raw = (n, path, { method = 'GET', body, ms = timeoutMs } = {}) =>
    fetch((n.target ?? n.url) + path, {
      method,
      // gửi tiếp mã truy vết sang node (GS-03)
      headers: { 'content-type': 'application/json', 'x-internal-key': internalKey, ...(requestId() && { 'x-request-id': requestId() }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });

  const failed = (n) => {
    if (++n.fails >= failThreshold) {
      setStatus(n, computeStatus(n));
    }
  };

  // Gọi node. Lỗi = mất kết nối, timeout hoặc 5xx. Retry tối đa 1 lần, chờ ngẫu nhiên 100–300 ms (jitter để
  // nhiều client không dồn vào cùng lúc), và CHỈ khi thao tác idempotent: GET (mặc định) hoặc ghi có
  // Idempotency-Key (người gọi truyền retry: true). Xe vào/ra không idempotent nên không bao giờ tự retry.
  // Cả 2 lần thử nằm trong CÙNG ngân sách `ms`: retry không kéo dài thời gian chờ của người dùng.
  async function call(n, path, { method = 'GET', body, ms = timeoutMs, retry = method === 'GET' } = {}) {
    const deadline = Date.now() + ms;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await raw(n, path, { method, body, ms: Math.max(1, deadline - Date.now()) });
        if (res.status < 500) { n.fails = 0; return res; }
      } catch (e) {
        res = e;
      }
      failed(n);
      const wait = 100 + Math.random() * 200;
      if (!retry || attempt >= 1 || n.status === 'OFFLINE' || Date.now() + wait >= deadline) {
        if (res instanceof Error) throw res;
        return res;   // 5xx: trả nguyên phản hồi của node cho người gọi
      }
      await sleep(wait);
    }
  }

  const json = async (n, path, opts) => {
    const r = await call(n, path, opts);
    if (!r.ok) throw new Error(`${n.id} ${path} -> ${r.status}`);
    return r.json();
  };

  async function checkOne(n) {
    n.target = await resolveUrl(n.url);
    const ok = await raw(n, '/health').then((r) => r.ok).catch(() => false);
    if (ok) {
      n.fails = 0;
      n.lastSeen = new Date().toISOString();
    } else {
      n.fails++;
    }
    setStatus(n, computeStatus(n));
  }

  // onChange(n, prev): báo khi bãi đổi ONLINE/OFFLINE/DEGRADED, do health check hoặc do mạch mở khi gọi lỗi.
  const check = (onChange) => {
    if (onChange) api.onChange = onChange;
    return Promise.all([...nodes.values()].map(checkOne));
  };

  // Scatter–gather: gọi song song, bãi lỗi/chậm thì bỏ qua và gắn nhãn, vẫn trả phần còn lại.
  const gather = (fn) => Promise.all([...nodes.values()].map(async (n) => {
    if (n.status === 'OFFLINE') return { parkingId: n.id, status: 'OFFLINE' };
    try { return { parkingId: n.id, status: n.status, ...(await fn(n)) }; }
    catch { return { parkingId: n.id, status: 'OFFLINE' }; }
  }));

  // PT-01: nhiều bản Aggregator dùng chung DB điều phối -> mỗi vòng health check nạp bãi mới do bản khác thêm.
  const sync = (rows) => rows.filter((r) => !nodes.has(r.parking_id)).map((r) => (add(r), r.parking_id));

  const api = {
    nodes,
    add,
    sync,
    get: (id) => nodes.get(id),
    all: () => [...nodes.values()],
    call,
    json,
    check,
    checkOne,
    gather,
    setStatus,
    setLease,
    computeStatus,
    onChange: null,
  };
  return api;
}

module.exports = { makeRegistry, resolveUrl };
