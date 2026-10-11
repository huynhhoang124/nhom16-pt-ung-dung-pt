import { useState } from 'react';
import { api, message, RES_LABEL, useBusy, useData, useNow } from '../api.js';
import { Expiry, href, Pending, Plate, Stale, Updated } from '../ui.jsx';

const load = () => api('/api/me/reservations');

export default function MyReservations() {
  const { data, error, at, reload } = useData(load, { events: ['SLOT_UPDATED', 'NODE_STATUS'] });
  const [note, setNote] = useState(null);
  const [busy, run] = useBusy();
  const now = useNow();

  const cancel = (r) => confirm(`Huỷ đặt chỗ ${r.slotCode} ở bãi ${r.parkingId}?`) && run(async () => {
    const res = await api(`/api/parkings/${encodeURIComponent(r.parkingId)}/reservations/${r.id}`, { method: 'DELETE' });
    setNote(res.ok ? { kind: 'ok', text: `Đã huỷ đặt chỗ ${r.slotCode} ở bãi ${r.parkingId}.` } : { kind: 'error', text: message(res.data) });
    reload();
  });

  if (!data) return <Pending error={error} retry={reload} />;
  // Đang giữ chỗ lên đầu, sau đó mới nhất trước.
  const rows = [...data.reservations].sort((a, b) =>
    (b.status === 'ACTIVE') - (a.status === 'ACTIVE') || new Date(b.startTime) - new Date(a.startTime));

  return (
    <>
      <Stale error={error} />
      <div className="title-row"><h1>Đặt chỗ của tôi</h1><Updated at={at} /></div>
      {data.unavailable.length > 0 && (
        <p className="banner">Bãi {data.unavailable.join(', ')} đang mất kết nối nên chưa lấy được đặt chỗ ở đó. Danh sách dưới đây có thể còn thiếu.</p>
      )}
      {note && <p className={note.kind === 'ok' ? 'success' : 'error'} aria-live="polite">{note.text}</p>}
      <div className="scroll"><table>
        <thead><tr><th>Bãi</th><th>Slot</th><th>Biển số</th><th>Giữ chỗ đến</th><th>Trạng thái</th><th><span className="sr">Thao tác</span></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><a href={href.parking(r.parkingId)}>Bãi {r.parkingId}</a></td>
              <td><b>{r.slotCode}</b></td><td><Plate>{r.licensePlate}</Plate></td>
              <td><Expiry t={r.expireTime} active={r.status === 'ACTIVE'} now={now} /></td>
              <td><span className={`state ${r.status}`}>{RES_LABEL[r.status] ?? r.status}</span></td>
              <td>{r.status === 'ACTIVE' && <button className="link" disabled={busy} onClick={() => cancel(r)}>Huỷ đặt chỗ</button>}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan="6" className="muted">Bạn chưa đặt chỗ nào. Vào <a href={href.dashboard}>Tổng quan</a>, chọn một bãi rồi chọn chỗ còn đèn xanh.</td></tr>
          )}
        </tbody>
      </table></div>
    </>
  );
}
