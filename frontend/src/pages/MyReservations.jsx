import { useCallback, useEffect, useState } from 'react';
import { api, commandRequest, message, useLive } from '../api.js';
import QrCode from '../QrCode.jsx';
import GroupBooking from '../GroupBooking.jsx';
import { Icon, Plate, ResStatus } from '../ui.jsx';

const dt = (t) => new Date(t).toLocaleString('vi-VN');
const tm = (t) => new Date(t).toLocaleTimeString('vi-VN');

export default function MyReservations() {
  const [data, setData] = useState(null);
  const [note, setNote] = useState(null);   // { kind: 'ok'|'error', text }

  const load = useCallback(async () => {
    const r = await api('/api/me/reservations');
    if (r.ok) setData(r.data);
  }, []);
  useEffect(() => { load(); }, [load]);
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load);

  async function cancel(r) {
    const res = await commandRequest(`/api/parkings/${r.parkingId}/reservations/${r.id}`, { method: 'DELETE' });
    setNote(res.ok ? { kind: 'ok', text: 'Đã huỷ.' } : { kind: 'error', text: message(res.data) });
    load();
  }

  if (!data) return <><h2>Đặt chỗ của tôi</h2><span className="skeleton" style={{ height: 220 }} /></>;
  // Còn dùng được QR (chưa vào hoặc đã vào, cần QR để ra) thì hiện thẻ; còn lại vào bảng.
  const live = data.reservations.filter((r) => r.status === 'ACTIVE' || r.status === 'USED');
  const past = data.reservations.filter((r) => !live.includes(r));
  return (
    <>
      <h2>Đặt chỗ của tôi</h2>
      {data.unavailable.length > 0 && (
        <div className="banner"><Icon name="alert" />
          <div><strong>Thiếu dữ liệu bãi {data.unavailable.join(', ')}</strong>Bãi đang mất kết nối nên danh sách dưới đây có thể thiếu.</div>
        </div>
      )}
      {note && <p className={note.kind === 'ok' ? 'success' : 'error'}><Icon name={note.kind === 'ok' ? 'check' : 'x'} /> {note.text}</p>}
      <div className="duo" style={{ marginTop: 'var(--space-4)' }}>
        <div className="stack">
          <span className="kicker">Đang hiệu lực · quét QR ở cổng</span>
          {live.map((r) => {
            const left = Math.ceil((new Date(r.expireTime) - Date.now()) / 60000);
            const expiring = r.status === 'ACTIVE' && left > 0 && left <= 10;
            return (
              <div key={r.id} className={`card qr-card${expiring ? ' expiring' : ''}`}>
                <div className="stack" style={{ gap: 'var(--space-2)' }}>
                  <div className="legend" style={{ alignItems: 'center' }}><ResStatus status={r.status} /><span className="muted small">Bãi {r.parkingId}</span></div>
                  <div className="legend" style={{ alignItems: 'center', gap: 'var(--space-3)' }}><span className="ticket-slot">{r.slotCode}</span><Plate value={r.licensePlate} /></div>
                  <dl>
                    <dt>Khung giờ</dt><dd>{dt(r.startTime)}{r.endTime && ` – ${tm(r.endTime)}`}</dd>
                    <dt>Đến trước</dt><dd>{tm(r.expireTime)}</dd>
                  </dl>
                  {expiring && (
                    <div className="banner"><Icon name="alert" />
                      <div><strong>Sắp hết giờ giữ chỗ – còn {left} phút</strong>Sau {tm(r.expireTime)} chỗ tự trả lại nếu xe chưa vào bãi.</div>
                    </div>
                  )}
                  {r.status === 'ACTIVE' && <div><button className="danger" onClick={() => cancel(r)}><Icon name="x" /> Huỷ</button></div>}
                </div>
                {r.qrToken && <div className="qr-wrap"><QrCode value={r.qrToken} /><span className="muted small">QR vào cổng · chạm để phóng to</span></div>}
              </div>
            );
          })}
          {!live.length && <div className="empty"><Icon name="qr" /><strong>Bạn chưa có đặt chỗ nào đang hiệu lực</strong>Chọn bãi ở mục Tổng quan để đặt chỗ.</div>}
          {past.length > 0 && (
            <>
              <span className="kicker" style={{ marginTop: 'var(--space-3)' }}>Đã dùng</span>
              <div className="scroll"><table>
                <thead><tr><th>Bãi</th><th>Slot</th><th>Biển số</th><th>Khung giờ</th><th>Đến trước</th><th>Trạng thái</th></tr></thead>
                <tbody>
                  {past.map((r) => (
                    <tr key={r.id}>
                      <td>{r.parkingId}</td><td className="mono">{r.slotCode}</td><td><Plate value={r.licensePlate} /></td>
                      <td className="mono small">{dt(r.startTime)}{r.endTime && ` – ${tm(r.endTime)}`}</td>
                      <td className="mono small">{tm(r.expireTime)}</td><td><ResStatus status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </>
          )}
        </div>
        <GroupBooking onDone={load} />
      </div>
    </>
  );
}
