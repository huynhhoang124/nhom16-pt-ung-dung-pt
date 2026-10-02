import { useCallback, useEffect, useState } from 'react';
import { api, message, useLive } from '../api.js';

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
        <thead><tr><th>Bãi</th><th>Slot</th><th>Biển số</th><th>Hết hạn</th><th>Trạng thái</th><th /></tr></thead>
        <tbody>
          {data.reservations.map((r) => (
            <tr key={r.id}>
              <td>{r.parkingId}</td><td>{r.slotCode}</td><td>{r.licensePlate}</td>
              <td>{new Date(r.expireTime).toLocaleString('vi-VN')}</td><td>{r.status}</td>
              <td>{r.status === 'ACTIVE' && <button className="link" onClick={() => cancel(r)}>Huỷ</button>}</td>
            </tr>
          ))}
          {!data.reservations.length && <tr><td colSpan="6" className="muted">Bạn chưa đặt chỗ nào.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
