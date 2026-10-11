import { useState } from 'react';
import { api, useData } from '../api.js';
import { href, NodeBadge, Pending, Stale, Updated } from '../ui.jsx';

async function load() {
  const [list, avail] = await Promise.all([api('/api/parkings'), api('/api/parkings/availability')]);
  if (!list.ok) return list;
  if (!avail.ok) return avail;
  const counts = Object.fromEntries(avail.data.map((a) => [a.parkingId, a]));
  return { ok: true, data: list.data.map((p) => ({ ...p, ...counts[p.parkingId] })) };
}

export default function Dashboard() {
  const [onlyFree, setOnlyFree] = useState(false);
  const { data: items, error, at, reload } = useData(load, { events: ['SLOT_UPDATED', 'NODE_STATUS'], every: 10000 });
  if (!items) return <Pending error={error} retry={reload} />;

  const online = items.filter((p) => p.status === 'ONLINE');
  const free = online.reduce((s, p) => s + p.available, 0);
  const shown = onlyFree ? online.filter((p) => p.available > 0) : items;

  return (
    <>
      <Stale error={error} />
      <h1 className="headline"><span className="num">{free}</span> chỗ trống</h1>
      <p className="muted">
        Trong {online.length} bãi đang hoạt động{online.length < items.length ? `, ${items.length - online.length} bãi mất kết nối` : ''}. Chọn một bãi để xem sơ đồ và đặt chỗ.
      </p>
      <div className="toolbar">
        <label className="check"><input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} /> Chỉ hiện bãi còn chỗ</label>
        <Updated at={at} />
      </div>

      <ul className="board">
        {shown.map((p) => {
          const up = p.status === 'ONLINE';
          return (
            <li key={p.parkingId}>
              <a className={up ? 'lot' : 'lot offline'} href={href.parking(p.parkingId)}>
                <span className="sign">{p.parkingId}</span>
                <span className="lot-name">
                  <strong>{p.name}</strong>
                  <span className="muted small">{p.address}</span>
                </span>
                {!up ? (
                  <span className="free"><b>--</b><small>không rõ</small></span>
                ) : p.available > 0 ? (
                  <span className="free"><b>{p.available}</b><small>/ {p.total} chỗ trống</small></span>
                ) : (
                  <span className="free full"><b>Hết chỗ</b><small>{p.total} chỗ đều có xe</small></span>
                )}
                <NodeBadge status={p.status} />
                {up && <span className="meter" style={{ '--fill': `${(100 * p.available) / Math.max(p.total, 1)}%` }} />}
              </a>
            </li>
          );
        })}
      </ul>
      {!items.length && <p className="muted">Chưa có bãi nào. Quản trị viên thêm bãi ở trang Quản trị.</p>}
      {items.length > 0 && !shown.length && <p className="muted">Hiện không bãi nào còn chỗ trống. Bỏ chọn bộ lọc để xem tất cả các bãi.</p>}
    </>
  );
}
