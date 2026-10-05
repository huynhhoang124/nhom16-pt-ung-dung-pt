import { useCallback, useEffect, useState } from 'react';
import { api, formatPlate, message, RESERVATION_LABEL, useLive } from '../api.js';
import QrCode from '../QrCode.jsx';

export default function MyReservations() {
  const [data, setData] = useState(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const r = await api('/api/me/reservations');
    if (r.ok) setData(r.data);
  }, []);
  useEffect(() => { load(); }, [load]);
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load);

  async function cancel(r) {
    const res = await api(`/api/parkings/${r.parkingId}/reservations/${r.id}`, { method: 'DELETE' });
    setNote(res.ok ? 'Đã huỷ.' : message(res.data));
    load();
  }

  if (!data) return <p className="muted">Đang tải…</p>;
  return (
    <>
      <h2>Đặt chỗ của tôi</h2>
      {data.unavailable.length > 0 && (
        <p className="banner">Không lấy được dữ liệu từ bãi {data.unavailable.join(', ')} (đang mất kết nối). Danh sách dưới đây có thể thiếu.</p>
      )}
      {note && <p className="muted">{note}</p>}
      <div className="scroll"><table>
        <thead><tr><th>Bãi</th><th>Slot</th><th>Biển số</th><th>Khung giờ</th><th>Đến trước</th><th>Trạng thái</th><th>QR vào cổng</th><th /></tr></thead>
        <tbody>
          {data.reservations.map((r) => (
            <tr key={r.id}>
              <td>{r.parkingId}</td><td>{r.slotCode}</td><td>{formatPlate(r.licensePlate)}</td>
              <td>{new Date(r.startTime).toLocaleString('vi-VN')} – {r.endTime ? new Date(r.endTime).toLocaleTimeString('vi-VN') : ''}</td>
              <td>{new Date(r.expireTime).toLocaleTimeString('vi-VN')}</td><td>{RESERVATION_LABEL[r.status] ?? r.status}</td>
              <td>{r.qrToken && <QrCode value={r.qrToken} />}</td>
              <td>{r.status === 'ACTIVE' && <button className="link" onClick={() => cancel(r)}>Huỷ</button>}</td>
            </tr>
          ))}
          {!data.reservations.length && <tr><td colSpan="8" className="muted">Bạn chưa đặt chỗ nào.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
