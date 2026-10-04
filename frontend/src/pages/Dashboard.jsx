import { useCallback, useEffect, useState } from 'react';
import { api, useLive } from '../api.js';

export const TYPE_LABEL = { CAR: 'Ô tô', MOTO: 'Xe máy' };

export default function Dashboard({ onOpen }) {
  const [items, setItems] = useState(null);
  const [type, setType] = useState('');   // '' = mọi loại xe

  const load = useCallback(async () => {
    const [list, avail] = await Promise.all([api('/api/parkings'), api('/api/parkings/availability')]);
    if (!list.ok || !avail.ok) return;
    const counts = Object.fromEntries(avail.data.map((a) => [a.parkingId, a]));
    setItems(list.data.map((p) => ({ ...p, ...counts[p.parkingId] })));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load);

  if (!items) return <p className="muted">Đang tải…</p>;
  // Đang lọc theo loại xe thì số chỗ lấy theo loại đó.
  const shown = items.map((p) => (type && p.status === 'ONLINE' ? { ...p, ...(p.byType?.[type] ?? { available: 0, total: 0 }) } : p));
  const online = shown.filter((p) => p.status === 'ONLINE');
  const free = online.reduce((s, p) => s + p.available, 0);

  return (
    <>
      <h2>Tổng quan các bãi</h2>
      <p className="legend">
        {[['', 'Tất cả'], ...Object.entries(TYPE_LABEL)].map(([k, v]) => (
          <button key={k} className={type === k ? 'tab active' : 'tab'} onClick={() => setType(k)}>{v}</button>
        ))}
      </p>
      <p className="muted">{online.length}/{items.length} bãi đang hoạt động · {free} chỗ trống{type && ` cho ${TYPE_LABEL[type].toLowerCase()}`}</p>
      <div className="cards">
        {shown.map((p) => (
          <button key={p.parkingId} className={`card parking ${p.status === 'ONLINE' ? '' : 'offline'}`} onClick={() => onOpen(p.parkingId)}>
            <div className="row">
              <strong>{p.name}</strong>
              <span className={`badge ${p.status}`}>{p.status}</span>
            </div>
            <div className="muted small">{p.address}</div>
            {p.status === 'ONLINE' ? (
              <>
                <div className="big">{p.available}<span className="muted"> / {p.total} chỗ trống</span></div>
                <div className="meter"><span style={{ width: `${(100 * p.available) / Math.max(p.total, 1)}%` }} /></div>
              </>
            ) : (
              <div className="big muted">Mất kết nối</div>
            )}
          </button>
        ))}
      </div>
    </>
  );
}
