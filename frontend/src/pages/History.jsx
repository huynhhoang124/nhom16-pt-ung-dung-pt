import { useCallback, useEffect, useState } from 'react';
import { api, formatPlate, message, newKey, useLive } from '../api.js';

const time = (t) => (t ? new Date(t).toLocaleString('vi-VN') : '—');
const money = (v) => (v == null ? '—' : `${v.toLocaleString('vi-VN')} đ`);

// Lịch sử gửi xe. USER: phiên của mình. STAFF/ADMIN: tra biển số trên toàn hệ thống.
export default function History({ user }) {
  const mine = user.role === 'USER';
  const [plate, setPlate] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(null);   // { x: phiên, quote, key, unknown } – key giữ nguyên khi "Thử lại"

  const load = useCallback(async (q) => {
    const r = await api(mine ? '/api/me/sessions' : `/api/sessions/search?plate=${encodeURIComponent(q)}`);
    setError(r.ok ? '' : message(r.data));
    setData(r.ok ? r.data : null);
  }, [mine]);
  useEffect(() => { if (mine) load(); }, [mine, load]);
  useLive(['SLOT_UPDATED'], () => (mine ? load() : plate && data && load(plate)));

  async function startPay(x) {
    const q = await api(`/api/parkings/${x.parkingId}/sessions/${x.id}/quote`);
    if (!q.ok) return setError(message(q.data));
    setPaying({ x, quote: q.data, key: newKey(), unknown: false });
  }

  async function pay() {
    const { x } = paying;
    const r = await api(`/api/me/sessions/${x.parkingId}/${x.id}/pay`, { method: 'POST', headers: { 'idempotency-key': paying.key } });
    if (r.ok) { setPaying(null); setError(''); load(); }
    else if (r.status === 504 || r.status === 0) setPaying({ ...paying, unknown: true });   // chưa rõ: thử lại cùng key
    else { setPaying(null); setError(message(r.data)); load(); }
  }

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
      {paying && (
        <div className="card panel">
          <strong>Thanh toán phiên {paying.x.slotCode} (bãi {paying.x.parkingId}): {money(paying.quote.fee)}</strong>
          <ul className="small">{paying.quote.breakdown.map((b) => <li key={b.label}>{b.label}: {money(b.amount)}</li>)}</ul>
          {paying.quote.fee > 0 ? (
            <>
              {paying.unknown && <p className="error">{message({ error: 'TIMEOUT_UNKNOWN_RESULT' })}</p>}
              <button className="primary" onClick={pay}>{paying.unknown ? 'Thử lại (cùng giao dịch)' : 'Thanh toán (giả lập)'}</button>
            </>
          ) : <p className="muted">Gửi dưới 5 phút: miễn phí.</p>}
          <button className="link" onClick={() => setPaying(null)}>Đóng</button>
        </div>
      )}
      {data && (
        <div className="scroll"><table>
          <thead><tr><th>Bãi</th><th>Slot</th><th>Biển số</th><th>Vào</th><th>Ra</th><th>Phí</th><th /></tr></thead>
          <tbody>
            {data.sessions.map((x) => (
              <tr key={`${x.parkingId}:${x.id}`}>
                <td>{x.parkingId}</td><td>{x.slotCode}</td><td>{formatPlate(x.licensePlate)}</td>
                <td>{time(x.enteredAt)}</td><td>{x.exitedAt ? time(x.exitedAt) : <strong>Đang gửi</strong>}</td>
                <td>{money(x.fee)}{x.paidAt && <span className="muted small"> · đã trả</span>}</td>
                <td>{mine && !x.paidAt && !x.exitedAt && <button className="link" onClick={() => startPay(x)}>Thanh toán</button>}</td>
              </tr>
            ))}
            {!data.sessions.length && <tr><td colSpan="7" className="muted">Không có phiên gửi xe nào.</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}
