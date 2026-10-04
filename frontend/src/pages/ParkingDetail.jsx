import { useCallback, useEffect, useState } from 'react';
import { api, message, newKey, STATUS_LABEL, useLive } from '../api.js';
import { TYPE_LABEL } from './Dashboard.jsx';
import Pricing from './Pricing.jsx';

// Thao tác nhân viên theo trạng thái slot.
const STAFF_ACTIONS = {
  AVAILABLE: [['enter', 'Xe vào'], ['maintenance', 'Khoá bảo trì']],
  RESERVED: [['enter', 'Xe vào']],
  OCCUPIED: [['exit', 'Xe ra']],
  MAINTENANCE: [['unmaintenance', 'Mở khoá']],
};

export default function ParkingDetail({ parkingId, user, onBack }) {
  const [p, setP] = useState(null);
  const [selected, setSelected] = useState(null);    // slot đang chọn
  const [pending, setPending] = useState(null);      // lượt đặt chỗ: { slotCode, key, plate, unknown }
  const [plate, setPlate] = useState('');
  const [note, setNote] = useState(null);            // { kind: 'ok'|'error', text }
  const [reservations, setReservations] = useState([]);
  const [type, setType] = useState('');               // lọc loại xe, '' = tất cả
  const isStaff = user.role === 'ADMIN' || (user.role === 'STAFF' && user.parkingId === parkingId);

  const load = useCallback(async () => {
    const r = await api(`/api/parkings/${parkingId}`);
    if (r.ok) setP(r.data);
    if (isStaff) {
      const rs = await api(`/api/parkings/${parkingId}/reservations`);
      setReservations(rs.ok ? rs.data : []);
    }
  }, [parkingId, isStaff]);

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load);

  function pick(slot) {
    setNote(null);
    setSelected(slot.slotCode);
    if (user.role === 'USER' && slot.status === 'AVAILABLE') setPending({ slotCode: slot.slotCode, key: newKey(), unknown: false });
    else setPending(null);
  }

  async function reserve(e) {
    e.preventDefault();
    const r = await api(`/api/parkings/${parkingId}/reservations`, {
      method: 'POST', headers: { 'idempotency-key': pending.key },
      body: { slotCode: pending.slotCode, licensePlate: plate },
    });
    if (r.ok) {
      setNote({ kind: 'ok', text: `Đã đặt ${pending.slotCode}, giữ chỗ đến ${new Date(r.data.expire_time ?? r.data.expireTime).toLocaleTimeString('vi-VN')}.` });
      setPending(null);
    } else if (r.status === 504 || r.status === 0) {
      setPending({ ...pending, unknown: true });   // giữ nguyên key để thử lại an toàn
      setNote({ kind: 'error', text: message(r.status ? r.data : { error: 'TIMEOUT_UNKNOWN_RESULT' }) });
    } else {
      setNote({ kind: 'error', text: message(r.data) });
      setPending(null);
    }
    load();
  }

  async function act(action, cash = false) {
    const r = await api(`/api/parkings/${parkingId}/slots/${selected}/${action}`, { method: 'POST', body: { licensePlate: plate || undefined, cash } });
    const fee = r.data?.session?.fee;
    if (r.status === 402) {   // chưa trả tiền: nhân viên thu tiền mặt rồi cho ra
      setNote({ kind: 'error', text: `Chưa thanh toán ${r.data.fee.toLocaleString('vi-VN')} đ.`, cash: true });
    } else {
      setNote(r.ok
        ? { kind: 'ok', text: `${selected}: ${STATUS_LABEL[r.data.status]}${fee != null ? ` · Phí gửi xe: ${fee.toLocaleString('vi-VN')} đ` : ''}` }
        : { kind: 'error', text: message(r.data) });
    }
    load();
  }

  async function cancel(id) {
    const r = await api(`/api/parkings/${parkingId}/reservations/${id}`, { method: 'DELETE' });
    setNote(r.ok ? { kind: 'ok', text: 'Đã huỷ đặt chỗ.' } : { kind: 'error', text: message(r.data) });
    load();
  }

  if (!p) return <p className="muted">Đang tải…</p>;
  const slot = p.slots.find((s) => s.slotCode === selected);
  const slots = p.slots.filter((s) => !type || s.type === type);
  const counts = slots.reduce((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {});
  // Nhóm theo tầng. Bản cache khi bãi mất kết nối không có tầng -> một nhóm chung.
  const floors = Object.entries(slots.reduce((m, s) => ({ ...m, [s.floor ?? '']: [...(m[s.floor ?? ''] ?? []), s] }), {}));

  return (
    <>
      <button className="link" onClick={onBack}>← Tổng quan</button>
      <div className="row">
        <h2>{p.name}</h2>
        <span className={`badge ${p.status}`}>{p.status}</span>
      </div>
      {p.stale && (
        <p className="banner">Bãi đang mất kết nối. Đây là trạng thái cuối cùng Aggregator biết (có thể đã cũ); tạm thời không nhận đặt chỗ.</p>
      )}
      <p className="legend">
        {[['', 'Tất cả'], ...Object.entries(TYPE_LABEL)].map(([k, v]) => (
          <button key={k} className={type === k ? 'tab active' : 'tab'} onClick={() => setType(k)}>{v}</button>
        ))}
      </p>
      <p className="legend">
        {Object.entries(STATUS_LABEL).map(([k, v]) => <span key={k} className={`chip ${k}`}>{v}: {counts[k] ?? 0}</span>)}
      </p>

      {floors.map(([floor, list]) => (
        <section key={floor}>
          {floor && <h3 className="floor">Tầng {floor}</h3>}
          <div className="grid">
            {list.map((s) => (
              <button key={s.slotCode} className={`slot ${s.status} ${s.slotCode === selected ? 'sel' : ''}`} onClick={() => pick(s)}
                title={`${s.slotCode} – ${TYPE_LABEL[s.type] ?? ''} – ${STATUS_LABEL[s.status]} (v${s.version})`}>
                {s.slotCode}
              </button>
            ))}
          </div>
        </section>
      ))}
      {!slots.length && <p className="muted">Chưa có dữ liệu slot.</p>}

      {note && (
        <p className={note.kind === 'ok' ? 'success' : 'error'}>
          {note.text} {note.cash && <button className="primary" onClick={() => act('exit', true)}>Thu tiền mặt và cho ra</button>}
        </p>
      )}

      {slot && !p.stale && (
        <div className="card panel">
          <strong>{slot.slotCode}</strong> · {TYPE_LABEL[slot.type] ?? ''} · {STATUS_LABEL[slot.status]}
          {pending && (
            <form onSubmit={reserve} className="inline">
              <input placeholder="Biển số, vd 30A-123.45" value={plate} onChange={(e) => setPlate(e.target.value)} required />
              <button className="primary">{pending.unknown ? 'Thử lại (cùng yêu cầu)' : 'Đặt chỗ'}</button>
            </form>
          )}
          {isStaff && (
            <div className="inline">
              <input placeholder="Biển số (tuỳ chọn)" value={plate} onChange={(e) => setPlate(e.target.value)} />
              {(STAFF_ACTIONS[slot.status] ?? []).map(([a, label]) => <button key={a} onClick={() => act(a)}>{label}</button>)}
            </div>
          )}
          {!pending && !isStaff && <span className="muted"> – chọn slot trống để đặt.</span>}
        </div>
      )}

      {p.status === 'ONLINE' && <Pricing parkingId={parkingId} canEdit={isStaff} />}

      {isStaff && (
        <>
          <h3>Đặt chỗ tại bãi</h3>
          <div className="scroll"><table>
            <thead><tr><th>Slot</th><th>Biển số</th><th>Hết hạn</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>
              {reservations.map((r) => (
                <tr key={r.id}>
                  <td>{r.slotCode}</td><td>{r.licensePlate}</td>
                  <td>{new Date(r.expireTime).toLocaleString('vi-VN')}</td><td>{r.status}</td>
                  <td>{r.status === 'ACTIVE' && <button className="link" onClick={() => cancel(r.id)}>Huỷ</button>}</td>
                </tr>
              ))}
              {!reservations.length && <tr><td colSpan="5" className="muted">Chưa có.</td></tr>}
            </tbody>
          </table></div>
        </>
      )}
    </>
  );
}
