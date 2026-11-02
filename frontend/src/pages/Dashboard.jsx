import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, message, rememberNodes, useLive } from '../api.js';
import { clock, Icon, Meter, NodeBadge, TYPE_ICON } from '../ui.jsx';

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
    if (list.ok) rememberNodes(list.data);
    if (!list.ok || !avail.ok) return setError(message((list.ok ? avail : list).data));
    setError('');
    const counts = Object.fromEntries(avail.data.map((a) => [a.parkingId, a]));
    setItems(list.data.map((p) => ({ ...p, ...counts[p.parkingId] })));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load);

  if (!items) return error
    ? <div className="empty" style={{ borderColor: 'var(--bad)' }}><Icon name="alert" /><strong>Không tải được danh sách bãi</strong>{error} Đang thử lại…</div>
    : <><h2>Tổng quan các bãi</h2><div className="cards">{[0, 1, 2].map((i) => <span key={i} className="skeleton" style={{ height: 190 }} />)}</div></>;
  // Đang lọc theo loại xe thì số chỗ lấy theo loại đó.
  let shown = items.map((p) => ({
    ...p,
    ...(type && p.status !== 'OFFLINE' ? p.byType?.[type] ?? { available: 0, total: 0 } : {}),
    distance: me && p.lat != null ? km(me, [p.lat, p.lng]) : null,
  }));
  // Có vị trí: bãi còn chỗ và đang chạy lên trước, rồi gần trước.
  if (me) shown = [...shown].sort((a, b) => ((b.status !== 'OFFLINE' && b.available > 0) - (a.status !== 'OFFLINE' && a.available > 0))
    || (a.distance ?? Infinity) - (b.distance ?? Infinity));
  const online = shown.filter((p) => p.status !== 'OFFLINE');
  const free = online.reduce((s, p) => s + p.available, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Tổng quan các bãi</h2>
          <p className="muted" style={{ margin: 0 }}>
            {online.length}/{items.length} bãi đang hoạt động · <b className="mono">{free}</b> chỗ trống{type && ` cho ${TYPE_LABEL[type].toLowerCase()}`}
          </p>
        </div>
      </div>
      <div className="legend" style={{ alignItems: 'center', marginBottom: 'var(--space-5)' }}>
        <div className="seg" role="group" aria-label="Loại xe">
          {[['', 'Tất cả'], ...Object.entries(TYPE_LABEL)].map(([k, v]) => (
            <button key={k} className={type === k ? 'tab active' : 'tab'} onClick={() => setType(k)}>{v}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Cách xem">
          <button className={view === 'list' ? 'tab active' : 'tab'} onClick={() => setView('list')}>Danh sách</button>
          <button className={view === 'map' ? 'tab active' : 'tab'} onClick={() => setView('map')}>Bản đồ</button>
        </div>
        <button className="link" onClick={locate}><Icon name="pin" /> Tìm bãi gần tôi</button>
        {geoNote && <span className="muted small">{geoNote}</span>}
      </div>
      {view === 'map' && (
        <Suspense fallback={<span className="skeleton map" />}>
          <ParkingMap items={shown} me={me} onOpen={onOpen} />
        </Suspense>
      )}
      {view === 'list' && <div className="cards">
        {shown.map((p) => {
          const on = p.status !== 'OFFLINE';
          const cap = type ? [[type, p]] : Object.entries(TYPE_LABEL).map(([k]) => [k, p.byType?.[k]]).filter(([, c]) => c);
          return (
            <button key={p.parkingId} className={`card parking ${on ? '' : 'offline'}`} onClick={() => onOpen(p.parkingId)}>
              <div className="lot-head">
                <span className="lot-name">{p.name}</span>
                <NodeBadge status={p.status} />
              </div>
              <div className="muted small">{p.address}{p.distance != null && ` · ${p.distance.toFixed(1)} km`}</div>
              {on ? (
                <div className="lot-cap">
                  {cap.map(([k, c]) => (
                    <div key={k}>
                      <div className="kicker"><Icon name={TYPE_ICON[k]} /> {TYPE_LABEL[k]}</div>
                      <div className="big">{c.available}<span className="muted"> / {c.total}</span></div>
                      <Meter available={c.available} total={c.total} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="lot-cap"><div className="muted small" style={{ gridColumn: '1 / -1' }}>Mất kết nối: tạm không nhận đặt chỗ.</div></div>
              )}
              <div className="lot-foot">
                <Icon name={on ? 'radio' : 'clock'} />
                {on ? `Cập nhật lúc ${clock(p.lastSeen)}` : p.lastSeen ? `Thấy lần cuối lúc ${clock(p.lastSeen)}` : 'Chưa liên lạc được với bãi'}
              </div>
            </button>
          );
        })}
      </div>}
    </>
  );
}
