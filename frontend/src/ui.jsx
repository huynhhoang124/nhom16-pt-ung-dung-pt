// Thành phần giao diện dùng chung theo thiết kế "Biển báo bãi đỗ": biểu tượng, biển số, chip trạng thái.
// Trạng thái luôn có màu + chữ + biểu tượng (không chỉ dựa vào màu).
import { formatPlate, RESERVATION_LABEL, STATUS_LABEL } from './api.js';

export const Icon = ({ name, spin = false, label }) => (
  <i className={`i i-${name}${spin ? ' i-spin' : ''}`} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })} />
);

// Biển số dạng tấm biển thật; không có biển số thì hiện gạch ngang.
export function Plate({ value, lg = false }) {
  if (!value) return <span className="muted">—</span>;
  return <span className={lg ? 'plate lg' : 'plate'}>{formatPlate(value)}</span>;
}

export const TYPE_ICON = { CAR: 'car', MOTO: 'bike' };
export const TYPE_NAME = { CAR: 'Ô tô', MOTO: 'Xe máy' };
export const TypeTag = ({ type }) => <span className="chip"><Icon name={TYPE_ICON[type] ?? 'car'} />{TYPE_NAME[type] ?? type}</span>;

// Trạng thái kết nối của bãi (failure detector của Aggregator). DEGRADED dành cho PD-09 (lease etcd).
const NODE = {
  ONLINE: ['Đang kết nối', 'wifi', 'ONLINE'],
  DEGRADED: ['Kết nối một phần', 'wifi-low', 'PARTIAL'],
  OFFLINE: ['Mất kết nối', 'wifi-off', 'OFFLINE'],
};
export function NodeBadge({ status }) {
  const [label, icon, cls] = NODE[status] ?? NODE.OFFLINE;
  return <span className={`badge ${cls}`}><Icon name={icon} />{label}</span>;
}

// Ô chỗ đỗ: biểu tượng theo trạng thái (ô có xe máy dùng biểu tượng xe máy).
const SLOT_ICON = { AVAILABLE: 'check', RESERVED: 'clock', OCCUPIED: 'car', MAINTENANCE: 'wrench' };
export const slotIcon = (status, type) => (status === 'OCCUPIED' && type === 'MOTO' ? 'bike' : SLOT_ICON[status] ?? 'check');
export function SlotStatus({ status, type }) {
  const cls = { AVAILABLE: 'ok', RESERVED: 'warn', OCCUPIED: 'bad', MAINTENANCE: 'off' }[status] ?? 'off';
  return <span className={`st ${cls}`}><Icon name={slotIcon(status, type)} />{STATUS_LABEL[status] ?? status}</span>;
}

// Trạng thái đặt chỗ.
const RES = { ACTIVE: ['info', 'clock'], USED: ['ok', 'login'], DONE: ['off', 'check'], CANCELLED: ['off', 'x'], EXPIRED: ['bad', 'hourglass'] };
export function ResStatus({ status }) {
  const [cls, icon] = RES[status] ?? ['off', 'info'];
  return <span className={`st ${cls}`}><Icon name={icon} />{RESERVATION_LABEL[status] ?? status}</span>;
}

// Thanh đo chỗ trống: ≥ 50 % xanh, 20–49 % vàng, < 20 % đỏ.
export function Meter({ available, total, off = false }) {
  const pct = total > 0 ? (100 * available) / total : 0;
  const cls = off ? 'meter off' : pct < 20 ? 'meter low' : pct < 50 ? 'meter mid' : 'meter';
  return <div className={cls}><span style={{ width: `${pct}%` }} /></div>;
}

export const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour12: false }) : '');
