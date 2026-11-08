import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { makeCommandClient } from './command-client.js';

const KEY = 'parking.session';

export const session = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* bỏ qua */ } },
};

// keepSession: lỗi 401 từ node (không phải Aggregator) không được làm đăng xuất người dùng.
export async function api(path, { method = 'GET', body, headers = {}, keepSession = false } = {}) {
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
  // Proxy/nginx trả trang lỗi (không phải JSON) khi trung tâm sập -> gắn mã để báo lỗi rõ ràng thay vì "Có lỗi xảy ra".
  const data = await r.json().catch(() => (r.status >= 500 ? { error: 'SERVER_UNAVAILABLE' } : {}));
  // Chỉ coi là hết phiên khi Aggregator từ chối chính token (UNAUTHORIZED). 401 nghiệp vụ — vd cổng báo
  // INVALID_QR / QR_EXPIRED — không được làm nhân viên bị đăng xuất giữa lúc xe đang chờ.
  if (r.status === 401 && s && !keepSession && data?.error === 'UNAUTHORIZED') { session.set(null); location.reload(); }
  return { ok: r.ok, status: r.status, data };
}

// PT-05: nhớ địa chỉ công khai của từng bãi (lấy từ Aggregator khi còn sống) để nhân viên gọi thẳng bãi khi trung tâm sập.
const NODES_KEY = 'parking.nodes';
export function rememberNodes(list) {
  try {
    const m = JSON.parse(localStorage.getItem(NODES_KEY) ?? '{}');
    for (const n of list) if (n.publicUrl) m[n.parkingId] = { url: n.publicUrl, name: n.name };
    localStorage.setItem(NODES_KEY, JSON.stringify(m));
  } catch { /* bỏ qua */ }
}
export function knownNode(parkingId) {
  try { return JSON.parse(localStorage.getItem(NODES_KEY) ?? '{}')[parkingId] ?? null; } catch { return null; }
}
// Gọi thẳng node của bãi bằng JWT của nhân viên (node tự kiểm chữ ký RS256).
export async function nodeApi(parkingId, path, opts = {}) {
  const n = knownNode(parkingId);
  if (!n) return { ok: false, status: 0, data: { error: 'NETWORK' } };
  return api(n.url + path, { ...opts, keepSession: true });
}
// Aggregator không trả lời (sập / proxy báo lỗi) — khác với bãi trả lỗi nghiệp vụ.
export const centralDown = (r) => r.status === 0 || r.status === 500 || r.status === 502 || r.status === 503 && !r.data?.parkingId;

// Idempotency-Key: sinh MỘT lần cho mỗi lượt đặt, giữ nguyên khi bấm "Thử lại".
export const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const MESSAGES = {
  SLOT_TAKEN: 'Slot vừa có người khác đặt.',
  PARKING_OFFLINE: 'Bãi đang mất kết nối, tạm thời không nhận thao tác.',
  TIMEOUT_UNKNOWN_RESULT: 'Bãi phản hồi chậm, chưa rõ đã thực hiện được chưa. Bấm "Thử lại": an toàn, không bị đặt trùng.',
  INVALID_STATE: 'Trạng thái slot không cho phép thao tác này.',
  FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này.',
  RESERVATION_NOT_ACTIVE: 'Đặt chỗ không còn hiệu lực.',
  INVALID_CREDENTIALS: 'Sai tên đăng nhập hoặc mật khẩu.',
  PARKING_EXISTS: 'Mã bãi đã tồn tại.',
  INVALID_PARKING_ID: 'Mã bãi 1–8 ký tự, chỉ chữ in hoa và số.',
  INVALID_NAME: 'Nhập tên bãi.',
  INVALID_API_URL: 'Địa chỉ máy chủ phải bắt đầu bằng http:// hoặc https://.',
  INVALID_COORDS: 'Toạ độ không hợp lệ (vĩ độ -90…90, kinh độ -180…180).',
  PARKING_ONLINE: 'Bãi đang hoạt động, không gỡ được. Chỉ gỡ được bãi đang mất kết nối.',
  PARKING_NOT_FOUND: 'Không tìm thấy bãi.',
  NETWORK: 'Không kết nối được máy chủ.',
  SERVER_UNAVAILABLE: 'Máy chủ trung tâm đang mất kết nối. Hệ thống sẽ hoạt động lại khi kết nối được, vui lòng thử lại sau ít phút.',
  PLATE_ALREADY_INSIDE: 'Biển số này đang có xe gửi trong bãi.',
  PLATE_ALREADY_BOOKED: 'Biển số này đã giữ một chỗ khác trong khung giờ này.',
  PLATE_TOO_SHORT: 'Nhập ít nhất 3 ký tự biển số.',
  TOO_MANY_ATTEMPTS: 'Thử sai quá nhiều lần. Vui lòng đợi 15 phút.',
  USERNAME_TAKEN: 'Tên đăng nhập đã có người dùng.',
  INVALID_USERNAME: 'Tên đăng nhập 4–32 ký tự: chữ thường, số, dấu chấm, gạch dưới.',
  WEAK_PASSWORD: 'Mật khẩu cần 8–72 ký tự.',
  WRONG_PASSWORD: 'Mật khẩu hiện tại không đúng.',
  ALREADY_PAID: 'Phiên này đã được thanh toán.',
  NOTHING_TO_PAY: 'Chưa phát sinh phí (gửi dưới 5 phút).',
  SESSION_NOT_FOUND: 'Không tìm thấy phiên gửi xe.',
  PAYMENT_REQUIRED: 'Xe chưa thanh toán phí gửi.',
  TIME_CONFLICT: 'Khung giờ này slot đã có người đặt. Chọn giờ khác hoặc slot khác.',
  SLOT_RESERVED_SOON: 'Slot sắp có người đặt trước, chọn slot khác.',
  INVALID_START_TIME: 'Giờ đến phải trong 7 ngày tới.',
  INVALID_DURATION: 'Thời lượng từ 30 phút đến 24 giờ.',
  SLOT_EXISTS: 'Mã slot đã tồn tại.',
  SLOT_IN_USE: 'Slot đang có xe hoặc có lượt đặt còn hiệu lực.',
  INVALID_QR: 'Mã QR không hợp lệ.',
  QR_EXPIRED: 'Mã QR đã hết hạn.',
  IDEMPOTENCY_KEY_REUSED: 'Khoá yêu cầu đã được dùng cho thao tác khác.',
  BROKER_UNAVAILABLE: 'Kênh lệnh đang gián đoạn. Hãy thử lại cùng yêu cầu.',
  COMMAND_EXPIRED: 'Lệnh đã hết hạn.',
  COMMAND_DEADLINE_BEFORE_SEND: 'Lệnh hết hạn trước khi được gửi.',
  QR_USED: 'Mã QR đã được dùng.',
  WRONG_PARKING: 'Mã QR của bãi khác.',
  NOT_INSIDE: 'Xe không có trong bãi.',
  INVALID_PLATE: 'Biển số không hợp lệ (vd 30A-123.45).',
};
export const message = (data) => {
  if (data?.error === 'PLATE_ALREADY_BOOKED' && data.slotCode) return `Biển số này đã giữ ô ${data.slotCode} trong khung giờ này. Huỷ vé đó ở "Đặt chỗ của tôi" nếu muốn đổi ô.`;
  if (data?.error === 'PLATE_ALREADY_INSIDE' && data.slotCode) return `Biển số này đang có xe gửi ở ô ${data.slotCode}.`;
  return MESSAGES[data?.error] ?? data?.error ?? 'Có lỗi xảy ra.';
};

// "Xe của tôi": các biển số đã dùng gần đây, lưu trên máy này theo từng tài khoản (tiện ích, không phải dữ liệu chính).
const vehiclesKey = () => `parking.vehicles.${session.get()?.user?.id ?? 'guest'}`;
export const vehicles = {
  list() { try { return JSON.parse(localStorage.getItem(vehiclesKey())) ?? []; } catch { return []; } },
  remember(plate) {
    const p = formatPlate(String(plate).toUpperCase().replace(/[^0-9A-Z]/g, ''));
    try { localStorage.setItem(vehiclesKey(), JSON.stringify([p, ...vehicles.list().filter((x) => x !== p)].slice(0, 5))); } catch { /* bỏ qua */ }
  },
  forget(plate) { try { localStorage.setItem(vehiclesKey(), JSON.stringify(vehicles.list().filter((x) => x !== plate))); } catch { /* bỏ qua */ } },
};

// Ước tính phí theo bảng giá của bãi — cùng công thức với parking-node/src/pricing.js (chỉ để khách tham khảo khi đặt).
export function estimateFee(rule, minutes, start = new Date()) {
  if (!rule || minutes < 5) return 0;
  const block = (m) => {
    if (m <= 0) return 0;
    const fee = rule.firstBlockFee + Math.max(0, Math.ceil((m - rule.firstBlockMin) / 60)) * rule.nextHourFee;
    return rule.maxDayFee == null ? fee : Math.min(fee, rule.maxDayFee);
  };
  const days = Math.floor(minutes / 1440);
  const from = new Date(start); const to = new Date(from.getTime() + minutes * 60000);
  let nights = 0;   // số đêm 22:00–06:00 (giờ VN) mà khung giờ chạm vào
  const VN = 7 * 3600_000;
  for (let d = Math.floor((from.getTime() + VN) / 86400_000) - 1; ; d++) {
    const s = d * 86400_000 + 22 * 3600_000 - VN;
    if (s >= to.getTime()) break;
    if (s + 8 * 3600_000 > from.getTime()) nights++;
  }
  return days * block(1440) + block(minutes % 1440) + nights * (rule.overnightFee ?? 0);
}

export const STATUS_LABEL = { AVAILABLE: 'Trống', RESERVED: 'Đã đặt', OCCUPIED: 'Có xe', MAINTENANCE: 'Bảo trì', DEGRADED: 'Suy giảm', ONLINE: 'Hoạt động', OFFLINE: 'Ngoại tuyến' };
export const RESERVATION_LABEL = { ACTIVE: 'Đang hiệu lực', USED: 'Đã vào bãi', DONE: 'Hoàn tất', CANCELLED: 'Đã huỷ', EXPIRED: 'Hết hạn' };

// Biển số lưu dạng chuẩn "30A12345" -> hiển thị "30A-123.45" (đuôi 5 số) / "30A-1234" (đuôi 4 số).
export const formatPlate = (p) => (p ?? '—')
  .replace(/^(\d{2}[A-Z]{1,2}\d?)(\d{3})(\d{2})$/, '$1-$2.$3')
  .replace(/^(\d{2}[A-Z]{1,2}\d?)(\d{4})$/, '$1-$2');

// Thông báo nổi (toast): gọi toast('...', 'ok'|'error'|'info') ở bất kỳ đâu, <Toaster/> trong App hiển thị.
export const toast = (text, kind = 'info') => window.dispatchEvent(new CustomEvent('toast', { detail: { text, kind } }));

// Realtime: Aggregator đẩy SLOT_UPDATED / NODE_STATUS. Gộp các tin dồn dập rồi tải lại từ API (nguồn sự thật).
// auth là hàm: mỗi lần (re)connect lấy token mới nhất (NV-08: nhận thông báo riêng của mình)
// transports websocket: một kết nối gắn chặt với một bản Aggregator, không cần sticky session khi có nhiều bản (PT-01)
export const socket = io({ transports: ['websocket'], auth: (cb) => cb({ token: session.get()?.token }) });
export const commandTracker=makeCommandClient({api,socket,storage:localStorage,user:()=>session.get()?.user,newKey,
  digest:async value=>{
    if(crypto.subtle)return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
    let a=2166136261,b=5381;for(const ch of value){a=Math.imul(a^ch.charCodeAt(0),16777619);b=Math.imul(b,33)^ch.charCodeAt(0);}return `${a>>>0}:${b>>>0}`;
  }});
export const commandRequest=(...args)=>commandTracker.request(...args);

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
