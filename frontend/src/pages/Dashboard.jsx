import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, message, useLive } from '../api.js';

export const TYPE_LABEL = { CAR: 'Ô tô', MOTO: 'Xe máy' };

const ParkingMap = lazy(() => import('../ParkingMap.jsx'));   // Leaflet chỉ tải khi mở bản đồ

// Khoảng cách đường chim bay (km), công thức haversine.
export function km([lat1, lng1], [lat2, lng2]) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export default function Dashboard({ onOpen }) {
  const [items, setItems] = useState(null);
  const [type, setType] = useState('');   // '' = mọi loại xe
  const [error, setError] = useState('');
  const [view, setView] = useState('list');   // list | map
  const [me, setMe] = useState(null);          // [lat, lng] khi người dùng cho phép lấy vị trí
  const [geoNote, setGeoNote] = useState('');

  function locate() {
    if (!navigator.geolocation) return setGeoNote('Trình duyệt không hỗ trợ lấy vị trí.');
    setGeoNote('Đang lấy vị trí…');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setMe([pos.coords.latitude, pos.coords.longitude]); setGeoNote(''); },
      () => setGeoNote('Không lấy được vị trí (chưa cho phép?). Danh sách xếp theo tên.'),
      { timeout: 10000 });
  }

  const load = useCallback(async () => {
    const [list, avail] = await Promise.all([api('/api/parkings'), api('/api/parkings/availability')]);
    if (!list.ok || !avail.ok) return setError(message((list.ok ? avail : list).data));
    setError('');
    const counts = Object.fromEntries(avail.data.map((a) => [a.parkingId, a]));
    setItems(list.data.map((p) => ({ ...p, ...counts[p.parkingId] })));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load);

  if (!items) return error ? <p className="error">{error} Đang thử lại…</p> : <p className="muted">Đang tải…</p>;
  // Đang lọc theo loại xe thì số chỗ lấy theo loại đó.
  let shown = items.map((p) => ({
    ...p,
    ...(type && p.status === 'ONLINE' ? p.byType?.[type] ?? { available: 0, total: 0 } : {}),
    distance: me && p.lat != null ? km(me, [p.lat, p.lng]) : null,
  }));
  // Có vị trí: bãi còn chỗ và đang chạy lên trước, rồi gần trước.
  if (me) shown = [...shown].sort((a, b) => ((b.status === 'ONLINE' && b.available > 0) - (a.status === 'ONLINE' && a.available > 0))
    || (a.distance ?? Infinity) - (b.distance ?? Infinity));
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
      <p className="legend">
        <button className={view === 'list' ? 'tab active' : 'tab'} onClick={() => setView('list')}>Danh sách</button>
        <button className={view === 'map' ? 'tab active' : 'tab'} onClick={() => setView('map')}>Bản đồ</button>
        <button className="link" onClick={locate}>📍 Tìm bãi gần tôi</button>
        {geoNote && <span className="muted small">{geoNote}</span>}
      </p>
      <p className="muted">{online.length}/{items.length} bãi đang hoạt động · {free} chỗ trống{type && ` cho ${TYPE_LABEL[type].toLowerCase()}`}</p>
      {view === 'map' && (
        <Suspense fallback={<p className="muted">Đang tải bản đồ…</p>}>
          <ParkingMap items={shown} me={me} onOpen={onOpen} />
        </Suspense>
      )}
      {view === 'list' && <div className="cards">
        {shown.map((p) => (
          <button key={p.parkingId} className={`card parking ${p.status === 'ONLINE' ? '' : 'offline'}`} onClick={() => onOpen(p.parkingId)}>
            <div className="row">
              <strong>{p.name}</strong>
              <span className={`badge ${p.status}`}>{p.status}</span>
            </div>
            <div className="muted small">{p.address}{p.distance != null && ` · ${p.distance.toFixed(1)} km`}</div>
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
      </div>}
    </>
  );
}
