import { useCallback, useEffect, useState } from 'react';
import { api, message, useLive } from '../api.js';

const time = (t) => (t ? new Date(t).toLocaleString('vi-VN') : '—');
const money = (v) => (v == null ? '—' : `${v.toLocaleString('vi-VN')} đ`);

// Lịch sử gửi xe. USER: phiên của mình. STAFF/ADMIN: tra biển số trên toàn hệ thống.
export default function History({ user }) {
  const mine = user.role === 'USER';
  const [plate, setPlate] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async (q) => {
    const r = await api(mine ? '/api/me/sessions' : `/api/sessions/search?plate=${encodeURIComponent(q)}`);
    setError(r.ok ? '' : message(r.data));
    setData(r.ok ? r.data : null);
  }, [mine]);
  useEffect(() => { if (mine) load(); }, [mine, load]);
  useLive(['SLOT_UPDATED'], () => (mine ? load() : plate && data && load(plate)));

  return (
    <>
      <h2>{mine ? 'Lịch sử gửi xe' : 'Tra cứu biển số'}</h2>
      {!mine && (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); load(plate); }}>
          <input placeholder="Biển số, vd 30A-123.45" value={plate} onChange={(e) => setPlate(e.target.value)} required />
          <button className="primary">Tra cứu</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {data?.unavailable.length > 0 && (
        <p className="banner">Không lấy được dữ liệu từ bãi {data.unavailable.join(', ')} (đang mất kết nối). Kết quả có thể thiếu.</p>
      )}
      {data && (
        <div className="scroll"><table>
          <thead><tr><th>Bãi</th><th>Slot</th><th>Biển số</th><th>Vào</th><th>Ra</th><th>Phí</th></tr></thead>
          <tbody>
            {data.sessions.map((x) => (
              <tr key={`${x.parkingId}:${x.id}`}>
                <td>{x.parkingId}</td><td>{x.slotCode}</td><td>{x.licensePlate ?? '—'}</td>
                <td>{time(x.enteredAt)}</td><td>{x.exitedAt ? time(x.exitedAt) : <strong>Đang gửi</strong>}</td>
                <td>{money(x.fee)}</td>
              </tr>
            ))}
            {!data.sessions.length && <tr><td colSpan="6" className="muted">Không có phiên gửi xe nào.</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}
