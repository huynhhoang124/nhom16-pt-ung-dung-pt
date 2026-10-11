import { NODE_LABEL } from './api.js';

export const href = { dashboard: '#/', parking: (id) => `#/bai/${encodeURIComponent(id)}`, mine: '#/dat-cho', admin: '#/quan-tri', log: '#/nhat-ky' };

export const Plate = ({ children }) => (children ? <span className="plate">{children}</span> : <span className="muted">–</span>);

export const NodeBadge = ({ status }) => <span className={`badge ${status}`}>{NODE_LABEL[status] ?? status}</span>;

// Chưa có dữ liệu: đang tải, hoặc báo lỗi kèm nút tải lại.
export function Pending({ error, retry }) {
  if (!error) return <p className="muted">Đang tải…</p>;
  return (
    <div className="notice">
      <p className="error">{error}</p>
      <button onClick={retry}>Tải lại</button>
    </div>
  );
}

// Đã có dữ liệu nhưng lần làm mới gần nhất lỗi.
export const Stale = ({ error }) => (error ? <p className="banner">Không làm mới được dữ liệu: {error} Bạn đang xem dữ liệu của lần tải trước.</p> : null);

// "14:05 ngày 11/10" (vi-VN tự định dạng ngày thành "11-10" nên ghép tay).
const pad = (n) => String(n).padStart(2, '0');
export const time = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ngày ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
};
export const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

export const ago = (t, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - new Date(t)) / 1000));
  return s < 60 ? `${s} giây trước` : s < 3600 ? `${Math.round(s / 60)} phút trước` : `${Math.round(s / 3600)} giờ trước`;
};

// Giờ hết hạn kèm đếm ngược cho đặt chỗ đang giữ. Bãi tự huỷ đặt chỗ quá hạn (quét mỗi 30 giây theo đồng hồ của bãi).
export function Expiry({ t, active, now }) {
  if (!active) return time(t);
  const min = Math.ceil((new Date(t) - now) / 60000);
  return <>{time(t)} <span className={min <= 3 ? 'error' : 'muted'}>({min > 0 ? `còn ${min} phút` : 'đã quá hạn, bãi sắp tự huỷ'})</span></>;
}

export const Updated = ({ at }) => (at ? <span className="muted small">Cập nhật lúc {clock(at)}</span> : null);
