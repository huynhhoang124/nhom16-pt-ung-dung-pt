import { useCallback, useRef, useState } from 'react';
import { api, message, newKey, RES_LABEL, STATUS_LABEL, useBusy, useData, useNow } from '../api.js';
import { ago, clock, Expiry, href, NodeBadge, Pending, Plate, Stale, time, Updated } from '../ui.jsx';

// Thao tác nhân viên theo trạng thái slot: [action, nhãn nút, thông báo khi xong].
const STAFF_ACTIONS = {
  AVAILABLE: [['enter', 'Xe vào', 'Đã ghi nhận xe vào'], ['maintenance', 'Khoá bảo trì', 'Đã khoá bảo trì']],
  RESERVED: [['enter', 'Xe vào', 'Đã ghi nhận xe vào']],
  OCCUPIED: [['exit', 'Xe ra', 'Đã ghi nhận xe ra khỏi']],
  MAINTENANCE: [['unmaintenance', 'Mở khoá', 'Đã mở khoá']],
};
const LIVE = { events: ['SLOT_UPDATED', 'NODE_STATUS'], every: 10000 };
const CAR_COLORS = ['#c9ced3', '#f4f5f6', '#2d4f7c', '#a3302a', '#5b6168'];
// Mở trang với ?demo (vd http://localhost:3000/?demo#/bai/B) để hiện nút thử tranh chấp khi bảo vệ.
const DEMO = new URLSearchParams(location.search).has('demo');
const norm = (v) => v.replace(/[^0-9a-z]/gi, '').toUpperCase();

// Mỗi tầng vẽ như một khu bãi: nửa đầu dãy trên, nửa sau dãy dưới, lối đi ở giữa.
// base: version lúc mở trang. Slot có version mới hơn thì gắn lớp nháy, key theo version nên mỗi lần đổi nháy lại một lần.
function Floor({ label, slots, selected, onPick, base }) {
  const half = Math.ceil(slots.length / 2);
  const bay = (s) => (
    <button
      key={s.slotCode}
      className={`bay ${s.status}`}
      aria-pressed={s.slotCode === selected}
      aria-label={`${s.slotCode}, ${STATUS_LABEL[s.status]}`}
      title={`${s.slotCode}: ${STATUS_LABEL[s.status]} (phiên bản ${s.version})`}
      onClick={() => onPick(s)}
      style={{ '--car': CAR_COLORS[[...s.slotCode].reduce((n, c) => n + c.charCodeAt(0), 0) % CAR_COLORS.length] }}
    >
      {s.version > (base[s.slotCode] ?? Infinity) && <span key={s.version} className="flash" aria-hidden="true" />}
      <span className="led" />
      {s.status === 'OCCUPIED' && <span className="car" />}
      <span className="code">{s.slotCode}</span>
    </button>
  );
  return (
    <figure className="floor">
      {label && <figcaption>{label}</figcaption>}
      <div className="lot-map" style={{ '--cols': half }}>
        <div className="bays top">{slots.slice(0, half).map(bay)}</div>
        <div className="lane" aria-hidden="true" />
        <div className="bays bottom">{slots.slice(half).map(bay)}</div>
      </div>
    </figure>
  );
}

export default function ParkingDetail({ parkingId, user }) {
  const isStaff = user.role === 'ADMIN' || (user.role === 'STAFF' && user.parkingId === parkingId);
  const pid = encodeURIComponent(parkingId);
  const lot = useData(useCallback(() => api(`/api/parkings/${pid}`), [pid]), LIVE);
  const res = useData(useCallback(async () => (isStaff ? api(`/api/parkings/${pid}/reservations`) : { ok: true, data: [] }), [pid, isStaff]), LIVE);

  const [selected, setSelected] = useState(null);
  const [pending, setPending] = useState(null);   // lượt đặt chỗ đang mở: { slotCode, key, unknown }
  const [plate, setPlate] = useState('');
  const [note, setNote] = useState(null);         // { kind: 'ok'|'error', text }
  const [busy, run] = useBusy();
  const [q, setQ] = useState('');                 // tìm theo biển số trong bảng đặt chỗ
  const now = useNow(5000);
  const base = useRef(null);
  // Key của các lượt đặt chưa rõ kết quả (timeout). Chọn lại slot đó vẫn dùng key cũ để "Thử lại" không đặt trùng.
  const unknownKeys = useRef({});

  const refresh = () => { lot.reload(); res.reload(); };
  const reservations = res.data ?? [];
  const activeAt = (code) => reservations.find((r) => r.slotCode === code && r.status === 'ACTIVE');

  function pick(s) {
    setNote(null);
    setSelected(s.slotCode);
    if (user.role === 'USER') {
      const key = unknownKeys.current[s.slotCode];
      setPending({ slotCode: s.slotCode, key: key ?? newKey(), unknown: !!key });
    }
    if (isStaff) setPlate(activeAt(s.slotCode)?.licensePlate ?? '');
  }

  const reserve = (e) => {
    e.preventDefault();
    run(async () => {
      const { slotCode, key } = pending;
      const r = await api(`/api/parkings/${pid}/reservations`, {
        method: 'POST', headers: { 'idempotency-key': key },
        body: { slotCode, licensePlate: plate.trim() },
      });
      if (r.status === 504 || r.status === 0) {
        unknownKeys.current[slotCode] = key;   // giữ nguyên key để thử lại an toàn
        setPending({ slotCode, key, unknown: true });
        setNote({ kind: 'error', text: message({ error: 'TIMEOUT_UNKNOWN_RESULT' }) });
      } else {
        // Đã có kết quả chắc chắn: lượt sau (nếu slot còn trống) là yêu cầu mới, dùng key mới.
        delete unknownKeys.current[slotCode];
        setPending(r.ok ? null : { slotCode, key: newKey(), unknown: false });
        setNote(r.ok
          ? { kind: 'ok', text: `Đã đặt ${slotCode}. Chỗ được giữ đến ${time(r.data.expire_time ?? r.data.expireTime)}.` }
          : { kind: 'error', text: message(r.data) });
      }
      refresh();
    });
  };

  // Demo tranh chấp: 5 yêu cầu đặt CÙNG slot gửi song song, mỗi yêu cầu một key riêng (như 5 người bấm cùng lúc).
  // Node chỉ để một lệnh UPDATE ... WHERE status='AVAILABLE' thành công, các yêu cầu còn lại nhận SLOT_TAKEN.
  const race = () => {
    if (!plate.trim()) return setNote({ kind: 'error', text: 'Nhập biển số trước khi thử tranh chấp.' });
    run(async () => {
      const { slotCode } = pending;
      const rs = await Promise.all(Array.from({ length: 5 }, () => api(`/api/parkings/${pid}/reservations`, {
        method: 'POST', headers: { 'idempotency-key': newKey() }, body: { slotCode, licensePlate: plate.trim() },
      })));
      const won = rs.filter((r) => r.ok).length;
      const taken = rs.filter((r) => r.data?.error === 'SLOT_TAKEN').length;
      const other = rs.length - won - taken;
      setNote({
        kind: won === 1 ? 'ok' : 'error',
        text: `Gửi 5 yêu cầu đặt ${slotCode} cùng lúc: ${won} thành công, ${taken} bị từ chối vì slot đã có người đặt${other ? `, ${other} lỗi khác` : ''}.`,
      });
      setPending({ slotCode, key: newKey(), unknown: false });
      refresh();
    });
  };

  const act = (action, done) => run(async () => {
    const code = selected;
    const r = await api(`/api/parkings/${pid}/slots/${encodeURIComponent(code)}/${action}`, {
      method: 'POST', body: { licensePlate: plate.trim() || undefined },
    });
    setNote(r.ok ? { kind: 'ok', text: `${done} ${code}.` } : { kind: 'error', text: message(r.data) });
    if (r.ok) setPlate('');
    refresh();
  });

  const cancel = (r) => confirm(`Huỷ đặt chỗ ${r.slotCode} của xe ${r.licensePlate}?`) && run(async () => {
    const out = await api(`/api/parkings/${pid}/reservations/${r.id}`, { method: 'DELETE' });
    setNote(out.ok ? { kind: 'ok', text: `Đã huỷ đặt chỗ ${r.slotCode}.` } : { kind: 'error', text: message(out.data) });
    refresh();
  });

  const back = <a className="crumb" href={href.dashboard}>Tổng quan</a>;
  if (!lot.data) return <>{back}<Pending error={lot.error} retry={lot.reload} /></>;

  const p = lot.data;
  base.current ??= Object.fromEntries(p.slots.map((s) => [s.slotCode, s.version]));
  const slot = p.slots.find((s) => s.slotCode === selected);
  const counts = p.slots.reduce((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {});
  const floors = Object.entries(p.slots.reduce((m, s) => ({ ...m, [s.floor ?? '']: [...(m[s.floor ?? ''] ?? []), s] }), {}));
  const held = slot && activeAt(slot.slotCode);
  const shown = q ? reservations.filter((r) => norm(r.licensePlate).includes(norm(q))) : reservations;
  // Form đặt chỗ chỉ hiện khi slot còn trống, hoặc đang chờ "Thử lại" sau timeout.
  const canReserve = slot && pending?.slotCode === slot.slotCode && (slot.status === 'AVAILABLE' || pending.unknown);

  return (
    <>
      {back}
      <Stale error={lot.error} />
      <div className="title-row">
        <h1>{p.name}</h1>
        <NodeBadge status={p.status} />
        <Updated at={lot.at} />
      </div>
      {p.address && <p className="muted">{p.address}</p>}
      {p.stale && (
        <p className="banner">
          Bãi đang mất kết nối{p.lastSeen ? `, lần cuối liên lạc được lúc ${clock(p.lastSeen)} (${ago(p.lastSeen, now)})` : ''}.
          Sơ đồ dưới đây là trạng thái cuối cùng hệ thống nhận được qua sự kiện, có thể đã cũ. Tạm thời không nhận đặt chỗ hay thao tác xe vào/ra.
        </p>
      )}

      <ul className="legend">
        {Object.entries(STATUS_LABEL).map(([k, v]) => (
          <li key={k}><span className={`key ${k}`} aria-hidden="true" />{v} <b>{counts[k] ?? 0}</b></li>
        ))}
      </ul>

      <div className="floors">
        {floors.map(([f, slots]) => (
          <Floor key={f} label={f ? `Tầng ${f}` : null} slots={slots} selected={selected} onPick={pick} base={base.current} />
        ))}
      </div>
      {!p.slots.length && <p className="muted">Chưa có dữ liệu slot của bãi này.</p>}

      <section className="panel" aria-live="polite">
        {note && <p className={note.kind === 'ok' ? 'success' : 'error'}>{note.text}</p>}
        {!slot && !p.stale && (
          <p className="muted">
            {user.role === 'USER' && 'Chọn một chỗ còn đèn xanh trên sơ đồ để đặt.'}
            {isStaff && 'Chọn một slot để ghi nhận xe vào, xe ra hoặc khoá bảo trì.'}
            {!isStaff && user.role !== 'USER' && 'Bạn chỉ xem được bãi này. Thao tác xe vào/ra do nhân viên của bãi thực hiện.'}
          </p>
        )}
        {slot && (
          <>
            <h2>Slot {slot.slotCode} <span className="muted">{STATUS_LABEL[slot.status]}</span></h2>
            {held && (
              <p>Đặt bởi xe <Plate>{held.licensePlate}</Plate>, giữ chỗ đến <Expiry t={held.expireTime} active now={now} />.</p>
            )}
            {p.stale ? null : canReserve ? (
              <form onSubmit={reserve} className="inline">
                <label className="field">Biển số xe
                  <input placeholder="30A-123.45" value={plate} onChange={(e) => setPlate(e.target.value)} required maxLength={20} />
                </label>
                <button className="primary" disabled={busy}>
                  {busy ? 'Đang gửi…' : pending.unknown ? `Thử lại đặt ${pending.slotCode}` : `Đặt chỗ ${pending.slotCode}`}
                </button>
                {DEMO && !pending.unknown && (
                  <button type="button" disabled={busy} onClick={race}>Thử tranh chấp (5 yêu cầu cùng lúc)</button>
                )}
                {pending.unknown && !note && (
                  <p className="muted small">Lần gửi trước chưa rõ kết quả. Thử lại sẽ gửi đúng yêu cầu cũ nên không bị đặt trùng.</p>
                )}
              </form>
            ) : isStaff ? (
              <div className="inline">
                <label className="field">Biển số xe (không bắt buộc)
                  <input value={plate} onChange={(e) => setPlate(e.target.value)} maxLength={20} />
                </label>
                {(STAFF_ACTIONS[slot.status] ?? []).map(([a, label, done]) => (
                  <button key={a} className={a === 'maintenance' || a === 'unmaintenance' ? '' : 'primary'} disabled={busy} onClick={() => act(a, done)}>{label}</button>
                ))}
              </div>
            ) : user.role === 'USER' && note?.kind !== 'ok' ? (
              <p className="muted">Slot này không còn trống. Chọn một chỗ còn đèn xanh để đặt.</p>
            ) : null}
          </>
        )}
      </section>

      {isStaff && (
        <section>
          <h2>Đặt chỗ tại bãi</h2>
          {res.error && <p className="error">{res.error}</p>}
          <label className="field find">Tìm theo biển số
            <input type="search" placeholder="30A12345" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="scroll"><table>
            <thead><tr><th>Slot</th><th>Biển số</th><th>Giữ chỗ đến</th><th>Trạng thái</th><th><span className="sr">Thao tác</span></th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.slotCode}</b></td><td><Plate>{r.licensePlate}</Plate></td>
                  <td><Expiry t={r.expireTime} active={r.status === 'ACTIVE'} now={now} /></td>
                  <td><span className={`state ${r.status}`}>{RES_LABEL[r.status] ?? r.status}</span></td>
                  <td>{r.status === 'ACTIVE' && <button className="link" disabled={busy} onClick={() => cancel(r)}>Huỷ đặt chỗ</button>}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan="5" className="muted">{q ? 'Không có đặt chỗ nào khớp biển số này.' : 'Chưa có ai đặt chỗ ở bãi này.'}</td></tr>}
            </tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
