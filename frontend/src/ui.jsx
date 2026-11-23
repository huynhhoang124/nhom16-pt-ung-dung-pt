// Thành phần giao diện dùng chung theo thiết kế "Biển báo bãi đỗ": biểu tượng, biển số, chip trạng thái.
// Trạng thái luôn có màu + chữ + biểu tượng (không chỉ dựa vào màu).
import { useEffect, useRef, useState } from 'react';
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

// Hộp xác nhận cho thao tác khó hoàn tác (gỡ ô, huỷ đặt chỗ...). Esc / bấm nền = huỷ; nút huỷ được focus sẵn.
// Giữ focus trong hộp (Tab / Shift+Tab xoay vòng) và trả focus về nút đã mở hộp khi đóng.
export function ConfirmDialog({ ask, onClose }) {
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const opener = useRef(null);
  const live = useRef({ busy, onClose });
  live.current = { busy, onClose };
  // Ghi nhớ nút đã mở hộp ngay lúc render — trước khi autoFocus chuyển focus vào nút "Không".
  if (ask && !opener.current) opener.current = document.activeElement;
  useEffect(() => {
    if (!ask) return undefined;
    const keys = (e) => {
      if (e.key === 'Escape' && !live.current.busy) { e.preventDefault(); live.current.onClose(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll('button:not([disabled]), input, select, textarea, [href]')];
      if (!f.length) return;
      const [first, last] = [f[0], f[f.length - 1]];
      if (!box.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('keydown', keys);
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) setTimeout(() => back.focus(), 0);
    };
  }, [ask]);
  if (!ask) return null;
  const run = async () => { setBusy(true); try { await ask.run(); } finally { setBusy(false); onClose(); } };
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div ref={box} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="confirm-title">{ask.title}</h3>
        {ask.body && <div className="muted">{ask.body}</div>}
        <div className="dialog-actions">
          <button autoFocus onClick={onClose} disabled={busy}>Không</button>
          <button className={ask.danger ? 'danger solid' : 'primary'} onClick={run} disabled={busy}>
            {busy && <Icon name="loader" spin />}{ask.label}
          </button>
        </div>
      </div>
    </div>
  );
}

export const clock =(iso) => (iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour12: false }) : '');
