import { useCallback, useEffect, useState } from 'react';
import { api, message, useLive } from '../api.js';
import { Icon, Meter } from '../ui.jsx';

const money = (v) => `${v.toLocaleString('vi-VN')} đ`;
// Một cách ghi thời lượng cho cả trang: "45 phút" / "2 giờ 05 phút".
const dur = (m) => (m < 60 ? `${m} phút` : `${Math.floor(m / 60)} giờ ${String(m % 60).padStart(2, '0')} phút`);
const dateInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const normalizeStats = (data) => ({
  ...data,
  total: data.total
    ? {
        ...data.total,
        entries: data.total.entries ?? data.total.sessions ?? 0,
        exits: data.total.exits ?? data.total.exited ?? 0,
        byHour: data.total.byHour ?? Array(24).fill(0),
      }
    : data.total,
  parkings: (data.parkings ?? []).map((p) => ({
    ...p,
    entries: p.entries ?? p.sessions ?? 0,
    exits: p.exits ?? p.exited ?? 0,
  })),
  unavailable: data.unavailable ?? [],
});

// UX-02: thống kê gom từ các bãi (ADMIN: mọi bãi; STAFF: bãi mình). Bãi mất kết nối -> số liệu một phần, ghi rõ.
export default function Stats() {
  const [range, setRange] = useState(() => ({ from: dateInput(new Date(Date.now() - 6 * 86400_000)), to: dateInput(new Date()) }));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [lot, setLot] = useState('');          // '' = gộp mọi bãi; mã bãi = xem riêng bãi đó
  const [names, setNames] = useState({});      // mã bãi -> tên (bảng "Theo bãi" hiện tên, không chỉ mã)
  useEffect(() => { api('/api/parkings').then((r) => r.ok && setNames(Object.fromEntries(r.data.map((p) => [p.parkingId, p.name])))); }, []);
  const preset = (days) => setRange({ from: dateInput(new Date(Date.now() - (days - 1) * 86400_000)), to: dateInput(new Date()) });
  const isPreset = (days) => range.to === dateInput(new Date()) && range.from === dateInput(new Date(Date.now() - (days - 1) * 86400_000));

  const load = useCallback(async () => {
    // khoảng [00:00 ngày "từ", 00:00 sau ngày "đến") theo giờ máy người xem
    const from = new Date(`${range.from}T00:00`).toISOString();
    const to = new Date(new Date(`${range.to}T00:00`).getTime() + 86400_000).toISOString();
    const r = await api(`/api/admin/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    setError(r.ok ? '' : message(r.data));
    if (r.ok) setData(normalizeStats(r.data));
  }, [range]);
  useEffect(() => { load(); }, [load]);
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load, 2000);

  const multi = (data?.parkings.length ?? 0) + (data?.unavailable.length ?? 0) > 1;   // quản trị: nhiều bãi
  const picked = lot && data?.parkings.find((p) => p.parkingId === lot);
  const t = picked || data?.total;
  const peak = t ? Math.max(...t.byHour, 1) : 1;
  return (
    <>
      <div className="page-head">
        <h2>Thống kê{picked ? ` · ${names[lot] ?? `Bãi ${lot}`}` : ''}</h2>
        <div className="inline" style={{ marginTop: 0, alignItems: 'flex-end' }}>
          <div className="seg" role="group" aria-label="Khoảng thời gian nhanh">
            {[[1, 'Hôm nay'], [7, '7 ngày'], [30, '30 ngày']].map(([d, l]) => (
              <button key={d} className={isPreset(d) ? 'tab active' : 'tab'} aria-pressed={isPreset(d)} onClick={() => preset(d)}>{l}</button>
            ))}
          </div>
          <label className="field">Từ <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="field">Đến <input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          {multi && (
            <label className="field">Bãi
              <select value={lot} onChange={(e) => setLot(e.target.value)}>
                <option value="">Tất cả bãi</option>
                {data.parkings.map((p) => <option key={p.parkingId} value={p.parkingId}>{names[p.parkingId] ?? `Bãi ${p.parkingId}`}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
      {error && <div className="banner bad"><Icon name="x" /><div>{error}</div></div>}
      {data?.unavailable.length > 0 && (
        <div className="banner"><Icon name="alert" />
          <div><strong>Số liệu thiếu bãi {data.unavailable.join(', ')}</strong>Bãi đang mất kết nối: đây là kết quả một phần.</div>
        </div>
      )}
      {!t && !error && <div className="stats">{[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" style={{ height: 120 }} />)}</div>}
      {t && (
        <>
          <div className="stats" style={{ marginTop: 'var(--space-4)' }}>
            <div className="card">
              <div className="kicker">Lượt xe vào / ra</div>
              <div className="big">{t.entries} / {t.exits}</div>
            </div>
            <div className="card"><div className="kicker">Doanh thu (đã thu)</div><div className="big">{t.revenue.toLocaleString('vi-VN')}<span className="muted"> đ</span></div></div>
            <div className="card"><div className="kicker">Thời gian gửi TB</div><div className="big" style={{ fontSize: 28 }}>{dur(t.avgMinutes)}</div></div>
            <div className="card">
              <div className="kicker">Đang lấp đầy</div>
              <div className="big">{t.total ? Math.round((100 * t.occupied) / t.total) : 0}%</div>
              <div className="muted small">{t.occupied}/{t.total} chỗ có xe</div>
              <Meter available={t.occupied} total={t.total} />
            </div>
          </div>

          <div className="row" style={{ marginTop: 'var(--space-6)', marginBottom: 'var(--space-3)' }}>
            <h3 style={{ margin: 0 }}>Lượt xe vào theo giờ</h3>
            <span className="muted small">
              {Math.max(...t.byHour) > 0
                ? <>Cao điểm <b className="mono">{t.byHour.indexOf(Math.max(...t.byHour))}:00–{t.byHour.indexOf(Math.max(...t.byHour)) + 1}:00</b> · {Math.max(...t.byHour)} lượt (cột cao nhất). Rê chuột lên cột để xem số lượt.</>
                : 'Chưa có lượt xe nào trong khoảng ngày này.'}
            </span>
          </div>
          <div className="bars" role="img" aria-label={`Biểu đồ lượt xe vào theo giờ, cao nhất ${Math.max(...t.byHour)} lượt lúc ${t.byHour.indexOf(Math.max(...t.byHour))} giờ`}>
            {t.byHour.map((n, h) => (
              <div key={h} className="barcol" title={`${h}:00–${h + 1}:00: ${n} lượt`}>
                <div className="hbar" style={{ height: `${(100 * n) / peak}%` }} />
                <span>{h % 3 === 0 ? h : ' '}</span>
              </div>
            ))}
          </div>

          {multi && !picked && <>
          <h3 style={{ marginTop: 'var(--space-6)' }}>Theo bãi</h3>
          <div className="scroll"><table>
            <thead><tr><th>Bãi</th><th className="tnum">Lượt vào / ra</th><th className="tnum">Doanh thu</th><th className="tnum">TG gửi TB</th><th className="tnum">Lấp đầy</th></tr></thead>
            <tbody>
              {data.parkings.map((p) => (
                <tr key={p.parkingId} className="clickable" onClick={() => setLot(p.parkingId)} title="Bấm để xem riêng bãi này">
                  <td><button className="link" onClick={(e) => { e.stopPropagation(); setLot(p.parkingId); }}><b className="mono">{p.parkingId}</b> · {names[p.parkingId] ?? ""}</button></td><td className="tnum">{p.entries} / {p.exits}</td><td className="tnum">{money(p.revenue)}</td><td className="tnum">{dur(p.avgMinutes)}</td>
                  <td className="tnum">{p.occupied}/{p.total}</td>
                </tr>
              ))}
              {data.unavailable.map((id) => <tr key={id}><td><b className="mono">{id}</b> · {names[id] ?? ""}</td><td colSpan="4" className="muted">Mất kết nối, không có số liệu</td></tr>)}
            </tbody>
          </table></div>
          </>}
          <div className="banner info" style={{ marginTop: 'var(--space-4)' }}><Icon name="info" /><div>Số liệu tự cập nhật khi có xe vào/ra, chậm tối đa khoảng 2 giây.</div></div>
        </>
      )}
    </>
  );
}
