import { useCallback, useEffect, useState } from 'react';
import { api, message, newKey, toast, useLive } from '../api.js';
import { Icon, Plate } from '../ui.jsx';

const time = (t) => (t ? new Date(t).toLocaleString('vi-VN') : '—');
const money = (v) => (v == null ? '—' : `${v.toLocaleString('vi-VN')} đ`);

// Lịch sử gửi xe. USER: phiên của mình. STAFF/ADMIN: tra biển số trên toàn hệ thống.
export default function History({ user }) {
  const mine = user.role === 'USER';
  const [plate, setPlate] = useState('');
  const [searched, setSearched] = useState('');   // biển số của lần tra gần nhất (để hiện tiêu đề kết quả)
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
    if (r.ok) { toast(`Đã thanh toán ${money(paying.quote.fee)} · phiên ${x.slotCode}`, 'ok'); setPaying(null); setError(''); load(); }
    else if (r.status === 504 || r.status === 0) setPaying({ ...paying, unknown: true });   // chưa rõ: thử lại cùng key
    else { setPaying(null); setError(message(r.data)); load(); }
  }

  return (
    <>
      <h2>{mine ? 'Lịch sử gửi xe' : 'Tra cứu biển số'}</h2>
      {!mine && (
        <form className="inline" style={{ marginBottom: 'var(--space-4)' }} onSubmit={(e) => { e.preventDefault(); setSearched(plate); load(plate); }}>
          <input className="mono" placeholder="Biển số, vd 30A-123.45" aria-label="Biển số" value={plate} onChange={(e) => setPlate(e.target.value)} required />
          <button className="primary"><Icon name="search" /> Tra cứu</button>
        </form>
      )}
      {error && <div className="banner bad"><Icon name="x" /><div>{error}</div></div>}
      {data?.unavailable.length > 0 && (
        <div className="banner"><Icon name="alert" />
          <div><strong>Thiếu dữ liệu bãi {data.unavailable.join(', ')}</strong>Bãi đang mất kết nối nên kết quả có thể thiếu.</div>
        </div>
      )}
      {!mine && data && searched && (
        <div className="legend" style={{ alignItems: 'center', margin: 'var(--space-4) 0' }}>
          <Plate value={searched.toUpperCase()} lg />
          <span className="muted small">{data.sessions.length} phiên gửi{data.unavailable.length > 0 && ` · không tra được bãi ${data.unavailable.join(', ')}`}</span>
        </div>
      )}
      {paying && (
        <div className="dialog-backdrop" onClick={() => setPaying(null)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="pay-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="pay-title">Thanh toán phiên gửi xe</h3>
            <div className="legend" style={{ alignItems: 'center' }}><Plate value={paying.x.licensePlate} /><span className="mono">{paying.x.parkingId} · {paying.x.slotCode}</span></div>
            <ul className="small mono" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
              {paying.quote.breakdown.map((b) => <li key={b.label}>{b.label}: {money(b.amount)}</li>)}
            </ul>
            <div className="big" style={{ fontSize: 44 }}>{(paying.quote.fee ?? 0).toLocaleString('vi-VN')}<span className="muted"> đ</span></div>
            {paying.quote.fee > 0 ? (
              paying.unknown && (
                <div className="cmd timeout" role="status">
                  <span className="ic"><Icon name="wifi-off" /></span>
                  <span className="cmd-title">Chưa rõ đã trả tiền chưa</span>
                  <span className="cmd-sub">{message({ error: 'TIMEOUT_UNKNOWN_RESULT' })}</span>
                </div>
              )
            ) : <p className="muted" style={{ margin: 0 }}>Gửi dưới 5 phút: miễn phí.</p>}
            <div className="dialog-actions">
              <button onClick={() => setPaying(null)}>Để sau</button>
              {paying.quote.fee > 0 && (
                <button className="primary" onClick={pay}>{paying.unknown ? <><Icon name="retry" /> Thử lại (cùng giao dịch)</> : <><Icon name="card" /> Thanh toán (giả lập)</>}</button>
              )}
            </div>
          </div>
        </div>
      )}
      {data && data.sessions.length > 0 && (
        <div className="scroll"><table>
          <thead><tr><th>Bãi</th><th>Slot</th><th>Biển số</th><th>Vào</th><th>Ra</th><th className="tnum">Phí</th><th>Đã trả</th><th /></tr></thead>
          <tbody>
            {data.sessions.map((x) => (
              <tr key={`${x.parkingId}:${x.id}`}>
                <td>{x.parkingId}</td><td className="mono">{x.slotCode}</td><td><Plate value={x.licensePlate} /></td>
                <td className="mono small">{time(x.enteredAt)}</td>
                <td>{x.exitedAt ? <span className="mono small">{time(x.exitedAt)}</span> : <span className="st info"><Icon name="car" />Đang gửi</span>}</td>
                <td className="tnum">{money(x.fee)}</td>
                <td>{x.paidAt ? <span className="st ok"><Icon name="check" />Đã trả</span> : x.fee ? <span className="st warn"><Icon name="clock" />Chưa trả</span> : <span className="muted">—</span>}</td>
                <td>{mine && !x.paidAt && !x.exitedAt && <button className="primary" onClick={() => startPay(x)}><Icon name="card" /> Thanh toán</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {data && !data.sessions.length && (
        <div className="empty"><Icon name="search" /><strong>Không có phiên gửi nào</strong>
          {mine ? 'Bạn chưa gửi xe ở bãi nào.' : `Biển số ${searched} chưa gửi ở bãi nào đang kết nối.`}
        </div>
      )}
    </>
  );
}
