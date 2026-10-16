import { useCallback, useEffect, useState } from 'react';
import { api, message, useLive } from '../api.js';

const money = (v) => `${v.toLocaleString('vi-VN')} đ`;
const dateInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// UX-02: thống kê gom từ các bãi (ADMIN: mọi bãi; STAFF: bãi mình). Bãi mất kết nối -> số liệu một phần, ghi rõ.
export default function Stats() {
  const [range, setRange] = useState(() => ({ from: dateInput(new Date(Date.now() - 6 * 86400_000)), to: dateInput(new Date()) }));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    // khoảng [00:00 ngày "từ", 00:00 sau ngày "đến") theo giờ máy người xem
    const from = new Date(`${range.from}T00:00`).toISOString();
    const to = new Date(new Date(`${range.to}T00:00`).getTime() + 86400_000).toISOString();
    const r = await api(`/api/admin/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    setError(r.ok ? '' : message(r.data));
    if (r.ok) setData(r.data);
  }, [range]);
  useEffect(() => { load(); }, [load]);
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load, 2000);

  const t = data?.total;
  const peak = t ? Math.max(...t.byHour, 1) : 1;
  return (
    <>
      <h2>Thống kê</h2>
      <p className="inline small">
        <label>Từ <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label>Đến <input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
      </p>
      {error && <p className="error">{error}</p>}
      {data?.unavailable.length > 0 && (
        <p className="banner">Số liệu thiếu bãi {data.unavailable.join(', ')} (đang mất kết nối): đây là kết quả một phần.</p>
      )}
      {t && (
        <>
          <div className="cards stats">
            <div className="card"><div className="muted small">Lượt xe</div><div className="big">{t.sessions}</div></div>
            <div className="card"><div className="muted small">Doanh thu (đã thu)</div><div className="big">{money(t.revenue)}</div></div>
            <div className="card"><div className="muted small">Thời gian gửi TB</div><div className="big">{Math.floor(t.avgMinutes / 60)}h{String(t.avgMinutes % 60).padStart(2, '0')}</div></div>
            <div className="card"><div className="muted small">Đang lấp đầy</div><div className="big">{t.total ? Math.round((100 * t.occupied) / t.total) : 0}%</div><div className="muted small">{t.occupied}/{t.total} chỗ có xe</div></div>
          </div>

          <h3>Lượt xe vào theo giờ</h3>
          <div className="bars" role="img" aria-label="Biểu đồ lượt xe vào theo giờ trong ngày">
            {t.byHour.map((n, h) => (
              <div key={h} className="barcol" title={`${h}:00–${h + 1}:00: ${n} lượt`}>
                <div className="hbar" style={{ height: `${(100 * n) / peak}%` }} />
                <span className="small muted">{h % 3 === 0 ? h : ' '}</span>
              </div>
            ))}
          </div>

          <h3>Theo bãi</h3>
          <div className="scroll"><table>
            <thead><tr><th>Bãi</th><th>Lượt xe</th><th>Doanh thu</th><th>TG gửi TB</th><th>Lấp đầy</th></tr></thead>
            <tbody>
              {data.parkings.map((p) => (
                <tr key={p.parkingId}>
                  <td>{p.parkingId}</td><td>{p.sessions}</td><td>{money(p.revenue)}</td><td>{p.avgMinutes} phút</td>
                  <td>{p.occupied}/{p.total}</td>
                </tr>
              ))}
              {data.unavailable.map((id) => <tr key={id}><td>{id}</td><td colSpan="4" className="muted">Mất kết nối, không có số liệu</td></tr>)}
            </tbody>
          </table></div>
        </>
      )}
    </>
  );
}
