import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';

const KEY = 'parking.session';

// sessionStorage: mỗi tab một phiên, nên demo mở 2 cửa sổ (user1 + staff-a) không ghi đè token của nhau. F5 vẫn giữ phiên.
export const session = {
  get() { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(KEY, JSON.stringify(v)) : sessionStorage.removeItem(KEY); } catch { /* bỏ qua */ } },
};

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const s = session.get();
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}), ...headers },
      body: body && JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: { error: 'NETWORK' } };
  }
  // Không phải JSON: lỗi từ proxy (nginx/Vite) khi Aggregator sập -> 502/503/504.
  const data = await r.json().catch(() => (r.ok ? {} : { error: r.status >= 502 ? 'NETWORK' : `HTTP_${r.status}` }));
  if (r.status === 401 && s) { session.set(null); location.reload(); }
  return { ok: r.ok, status: r.status, data };
}

// Idempotency-Key: sinh MỘT lần cho mỗi lượt đặt, giữ nguyên khi bấm "Thử lại".
export const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const MESSAGES = {
  SLOT_TAKEN: 'Slot vừa có người khác đặt. Chọn slot trống khác.',
  PARKING_OFFLINE: 'Bãi đang mất kết nối, tạm thời không nhận thao tác.',
  PARKING_NOT_FOUND: 'Không tìm thấy bãi này.',
  TIMEOUT_UNKNOWN_RESULT: 'Bãi phản hồi chậm, chưa rõ đã đặt được chưa. Bấm "Thử lại" để gửi lại đúng yêu cầu này, không bị đặt trùng.',
  INVALID_STATE: 'Slot vừa đổi trạng thái, thao tác này không còn hợp lệ.',
  FORBIDDEN: 'Tài khoản của bạn không có quyền làm việc này.',
  UNAUTHORIZED: 'Phiên đăng nhập đã hết. Đăng nhập lại để tiếp tục.',
  RESERVATION_NOT_ACTIVE: 'Đặt chỗ này đã hết hiệu lực.',
  IDEMPOTENCY_KEY_REQUIRED: 'Yêu cầu đặt chỗ thiếu mã chống trùng. Tải lại trang rồi thử lại.',
  INVALID_CREDENTIALS: 'Sai tên đăng nhập hoặc mật khẩu.',
  PARKING_EXISTS: 'Mã bãi này đã có trong hệ thống.',
  INTERNAL_ERROR: 'Máy chủ gặp lỗi. Thử lại sau ít phút.',
  NETWORK: 'Không kết nối được máy chủ. Kiểm tra Aggregator còn chạy không.',
};
export const message = (data) => MESSAGES[data?.error] ?? (data?.error ? `Có lỗi xảy ra (${data.error}).` : 'Có lỗi xảy ra.');

export const STATUS_LABEL = { AVAILABLE: 'Trống', RESERVED: 'Đã đặt', OCCUPIED: 'Có xe', MAINTENANCE: 'Bảo trì' };
export const RES_LABEL = { ACTIVE: 'Đang giữ chỗ', USED: 'Đã vào bãi', CANCELLED: 'Đã huỷ', EXPIRED: 'Hết hạn' };
export const NODE_LABEL = { ONLINE: 'Hoạt động', OFFLINE: 'Mất kết nối' };

// Realtime: Aggregator đẩy SLOT_UPDATED / NODE_STATUS. Gộp các tin dồn dập rồi tải lại từ API (nguồn sự thật).
export const socket = io();

export function useLive(events, reload, ms = 300) {
  const ref = useRef(reload);
  ref.current = reload;
  useEffect(() => {
    let t;
    const handler = () => { clearTimeout(t); t = setTimeout(() => ref.current(), ms); };
    events.forEach((e) => socket.on(e, handler));
    return () => { clearTimeout(t); events.forEach((e) => socket.off(e, handler)); };
  }, [events.join(','), ms]);
}

// Tải dữ liệu, làm mới định kỳ (every ms), khi có sự kiện realtime và khi socket nối lại (bù các tin đã lỡ).
// Lần tải sau lỗi thì giữ dữ liệu cũ kèm lỗi, để trang báo "đang xem bản cũ" thay vì trắng trang.
export function useData(load, { events = [], every = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, at: null });
  const seq = useRef(0);
  const run = useCallback(async () => {
    const mine = ++seq.current;
    const r = await load();
    if (mine !== seq.current) return;   // đã có lượt tải mới hơn: bỏ phản hồi cũ về muộn, tránh sơ đồ nháy về trạng thái cũ
    setState((s) => (r.ok ? { data: r.data, error: null, at: new Date() } : { ...s, error: message(r.data) }));
  }, [load]);
  useEffect(() => {
    run();
    if (!every) return;
    const t = setInterval(run, every);
    return () => clearInterval(t);
  }, [run, every]);
  useLive([...events, 'connect'], run);
  return { ...state, reload: run };
}

// Đồng hồ cho đếm ngược: render lại mỗi `ms`.
export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// Nhật ký realtime: ghi mọi tin Aggregator đẩy xuống từ lúc mở trang (tối đa 200 dòng, mới nhất trước).
let log = [];
let logId = 0;
const logSubs = new Set();
const record = (kind) => (e) => {
  log = [{ id: ++logId, at: new Date(), kind, ...(e && typeof e === 'object' ? e : {}) }, ...log].slice(0, 200);
  logSubs.forEach((f) => f());
};
['SLOT_UPDATED', 'NODE_STATUS', 'connect', 'disconnect'].forEach((k) => socket.on(k, record(k)));
export const useEventLog = () => useSyncExternalStore((f) => { logSubs.add(f); return () => logSubs.delete(f); }, () => log);

// Khoá nút trong lúc gửi để bấm đúp không gửi hai lần.
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  return [busy, run];
}
