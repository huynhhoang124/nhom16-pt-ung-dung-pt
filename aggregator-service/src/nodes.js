// Danh sách bãi + failure detector (health check) + gọi node có timeout.
//
// Health check chỉ là failure detector "eventually perfect": không phân biệt được node chết / chậm / mất tin.
// Vì vậy chỉ đánh dấu OFFLINE sau `failThreshold` lần lỗi liên tiếp, và mọi quyết định khi OFFLINE
// đều an toàn nếu báo nhầm (chỉ từ chối thừa, không bao giờ đặt trùng).

function makeRegistry({ internalKey, timeoutMs = 2000, failThreshold = 3 }) {
  const nodes = new Map();

  // Bãi mới bắt đầu ở OFFLINE: lần health check thành công đầu tiên = chuyển ONLINE = đối soát luôn.
  const add = (row) => nodes.set(row.parking_id, {
    id: row.parking_id, name: row.name, url: row.api_url, address: row.address ?? null,
    status: 'OFFLINE', fails: failThreshold, lastSeen: null,
  });

  // Timeout dùng AbortSignal.timeout: bộ đếm của runtime, không phụ thuộc giờ hệ thống bị chỉnh.
  const call = (n, path, { method = 'GET', body, ms = timeoutMs } = {}) =>
    fetch(n.url + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-internal-key': internalKey },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });

  const json = async (n, path, opts) => {
    const r = await call(n, path, opts);
    if (!r.ok) throw new Error(`${n.id} ${path} -> ${r.status}`);
    return r.json();
  };

  async function checkOne(n, onChange) {
    const ok = await call(n, '/health').then((r) => r.ok).catch(() => false);
    const prev = n.status;
    if (ok) {
      n.fails = 0;
      n.status = 'ONLINE';
      n.lastSeen = new Date().toISOString();
    } else if (++n.fails >= failThreshold) {
      n.status = 'OFFLINE';
    }
    if (prev !== n.status) onChange?.(n, prev);
  }

  const check = (onChange) => Promise.all([...nodes.values()].map((n) => checkOne(n, onChange)));

  // Scatter–gather: gọi song song, bãi lỗi/chậm thì bỏ qua và gắn nhãn, vẫn trả phần còn lại.
  const gather = (fn) => Promise.all([...nodes.values()].map(async (n) => {
    if (n.status === 'OFFLINE') return { parkingId: n.id, status: 'OFFLINE' };
    try { return { parkingId: n.id, status: 'ONLINE', ...(await fn(n)) }; }
    catch { return { parkingId: n.id, status: 'OFFLINE' }; }
  }));

  return { nodes, add, get: (id) => nodes.get(id), all: () => [...nodes.values()], call, json, check, gather };
}

module.exports = { makeRegistry };
