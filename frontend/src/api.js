import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const KEY = 'parking.session';

export const session = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* bỏ qua */ } },
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
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && s) { session.set(null); location.reload(); }
  return { ok: r.ok, status: r.status, data };
}

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
  NETWORK: 'Không kết nối được máy chủ.',
  PLATE_ALREADY_INSIDE: 'Biển số này đang có xe gửi trong bãi.',
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
  INVALID_QR: 'Mã QR không hợp lệ.',
  QR_EXPIRED: 'Mã QR đã hết hạn.',
  QR_USED: 'Mã QR đã được dùng.',
  WRONG_PARKING: 'Mã QR của bãi khác.',
  NOT_INSIDE: 'Xe không có trong bãi.',
  INVALID_PLATE: 'Biển số không hợp lệ (vd 30A-123.45).',
};
export const message = (data) => MESSAGES[data?.error] ?? data?.error ?? 'Có lỗi xảy ra.';

export const STATUS_LABEL = { AVAILABLE: 'Trống', RESERVED: 'Đã đặt', OCCUPIED: 'Có xe', MAINTENANCE: 'Bảo trì' };

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
