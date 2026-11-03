import { useCallback, useEffect, useState } from 'react';
import { api, centralDown, knownNode, message, newKey, nodeApi, rememberNodes, STATUS_LABEL, useLive } from '../api.js';
import { TYPE_LABEL } from './Dashboard.jsx';
import Pricing from './Pricing.jsx';
import { commandRequest } from '../api.js';
import { clock, Icon, NodeBadge, Plate, ResStatus, slotIcon, SlotStatus, TypeTag, TYPE_ICON } from '../ui.jsx';

// Thao tác nhân viên theo trạng thái slot.
const STAFF_ACTIONS = {
  AVAILABLE: [['enter', 'Xe vào'], ['maintenance', 'Khoá bảo trì']],
  RESERVED: [['enter', 'Xe vào']],
  OCCUPIED: [['exit', 'Xe ra']],
  MAINTENANCE: [['unmaintenance', 'Mở khoá']],
};

export default function ParkingDetail({ parkingId, user, onBack }) {
  const [p, setP] = useState(null);
  const [selected, setSelected] = useState(null);    // slot đang chọn
  const [pending, setPending] = useState(null);      // lượt đặt chỗ: { slotCode, key, plate, unknown }
  const [plate, setPlate] = useState('');
  const [when, setWhen] = useState('');               // giờ đến (datetime-local), '' = đặt ngay
  const [duration, setDuration] = useState(120);      // phút
  const [schedule, setSchedule] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [note, setNote] = useState(null);            // { kind: 'ok'|'error', text }
  const [reservations, setReservations] = useState([]);
  const [type, setType] = useState('');               // lọc loại xe, '' = tất cả
  const [busy, setBusy] = useState(false);            // đang chờ bãi trả lời lượt đặt
  const [loadedAt, setLoadedAt] = useState(null);     // giờ tải dữ liệu bãi gần nhất
  const isStaff = user.role === 'ADMIN' || (user.role === 'STAFF' && user.parkingId === parkingId);

  // PT-05: Aggregator sập -> nhân viên đọc/ghi thẳng node của bãi (p.direct = true)
  const load = useCallback(async () => {
    const r = await api(`/api/parkings/${parkingId}`);
    if (r.ok) { setP(r.data); rememberNodes([r.data]); setLoadedAt(new Date().toISOString()); }
    else if (isStaff && centralDown(r) && knownNode(parkingId)) {
      const slots = await nodeApi(parkingId, '/api/slots');
      if (slots.ok) {
        setP({ parkingId, name: knownNode(parkingId).name, status: 'ONLINE', stale: false, direct: true, slots: slots.data });
        setLoadError('');
        const rs = await nodeApi(parkingId, '/api/reservations');
        setReservations(rs.ok ? rs.data : []);
        return;
      }
    }
    setLoadError(r.ok ? '' : message(r.data));
    if (isStaff && r.ok) {
      const rs = await api(`/api/parkings/${parkingId}/reservations`);
      setReservations(rs.ok ? rs.data : []);
    }
  }, [parkingId, isStaff]);

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load);

  // NV-01: đặt trước được cả slot đang bận (khác khung giờ); đặt ngay thì slot phải trống.
  function pick(slot) {
    setNote(null);
    setSelected(slot.slotCode);
    if (user.role === 'USER' && slot.status !== 'MAINTENANCE') setPending({ slotCode: slot.slotCode, key: newKey(), unknown: false });
    else setPending(null);
  }

  // Lịch đã đặt của slot đang chọn, theo ngày của giờ đến.
  const day = (when || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString()).slice(0, 10);
  useEffect(() => {
    if (!selected || user.role !== 'USER') return setSchedule([]);
    api(`/api/parkings/${parkingId}/slots/${selected}/schedule?date=${day}`).then((r) => setSchedule(r.ok ? r.data : []));
  }, [parkingId, selected, day, user.role]);

  async function reserve(e) {
    e.preventDefault();
    if (busy) return;
    // Đổi giờ/thời lượng = yêu cầu mới -> key mới; chỉ "Thử lại" mới dùng lại key cũ.
    setBusy(true);
    const r = await commandRequest(`/api/parkings/${parkingId}/reservations`, {
      method: 'POST', headers: { 'idempotency-key': pending.key },
      body: { slotCode: pending.slotCode, licensePlate: plate, durationMinutes: duration, ...(when && { startTime: new Date(when).toISOString() }) },
    }, () => setNote({ kind: 'ok', text: 'Đang xử lý yêu cầu đặt chỗ…' }));
    setBusy(false);
    if (r.ok) {
      const t = (k) => new Date(r.data[k]).toLocaleString('vi-VN');
      setNote({ kind: 'ok', text: `Đã đặt ${pending.slotCode} từ ${t('start_time')} đến ${t('end_time')}. Đến muộn quá ${t('expire_time')} sẽ mất chỗ. Mã QR vào cổng ở mục "Đặt chỗ của tôi".` });
      setPending(null);
    } else if (r.status === 504 || r.status === 0) {
      setPending({ ...pending, unknown: true });   // giữ nguyên key để thử lại an toàn
      setNote({ kind: 'error', text: message(r.status ? r.data : { error: 'TIMEOUT_UNKNOWN_RESULT' }) });
    } else {
      setNote({ kind: 'error', text: message(r.data) });
      setPending(null);
    }
    load();
  }

  async function act(action, cash = false) {
    const body = { licensePlate: plate || undefined, cash };
    let r = p.direct ? { status: 0 } : await api(`/api/parkings/${parkingId}/slots/${selected}/${action}`, { method: 'POST', body });
    // Trung tâm không trả lời -> làm thẳng với bãi. An toàn kể cả khi lệnh trước thực ra đã tới bãi:
    // xe vào/ra kiểm trạng thái slot (compare-and-swap), lặp lại chỉ nhận 409 chứ không làm hai lần.
    if (isStaff && centralDown(r)) r = await nodeApi(parkingId, `/api/slots/${selected}/${action}`, { method: 'POST', body });
    const fee = r.data?.session?.fee;
    if (r.status === 402) {   // chưa trả tiền: nhân viên thu tiền mặt rồi cho ra
      setNote({ kind: 'error', text: `Chưa thanh toán ${r.data.fee.toLocaleString('vi-VN')} đ.`, cash: true });
    } else {
      setNote(r.ok
        ? { kind: 'ok', text: `${selected}: ${STATUS_LABEL[r.data.status]}${fee != null ? ` · Phí gửi xe: ${fee.toLocaleString('vi-VN')} đ` : ''}` }
        : { kind: 'error', text: message(r.data) });
    }
    load();
  }

  // NV-09: quản lý slot (nhân viên bãi này, quản trị)
  async function manage(method, body, code = '') {
    const r = await api(`/api/parkings/${parkingId}/slots${code && `/${code}`}`, { method, body });
    setNote(r.ok ? { kind: 'ok', text: method === 'DELETE' ? `Đã gỡ ${code}.` : `Đã lưu ${r.data.slotCode}.` } : { kind: 'error', text: message(r.data) });
    if (r.ok && method === 'DELETE') setSelected(null);
    load();
  }

  async function cancel(id) {
    const r = await commandRequest(`/api/parkings/${parkingId}/reservations/${id}`, { method: 'DELETE' },()=>setNote({kind:'ok',text:'Đang xử lý yêu cầu huỷ…'}));
    setNote(r.ok ? { kind: 'ok', text: 'Đã huỷ đặt chỗ.' } : { kind: 'error', text: message(r.data) });
    load();
  }

  if (!p) return loadError
    ? <div className="empty" style={{ borderColor: 'var(--bad)' }}><Icon name="alert" /><strong>Không tải được bãi</strong>{loadError}</div>
    : <div className="stack"><span className="skeleton" style={{ height: 40, width: 280 }} /><span className="skeleton" style={{ height: 320 }} /></div>;
  const slot = p.slots.find((s) => s.slotCode === selected);
  const slots = p.slots.filter((s) => s.status !== 'HIDDEN' && (!type || s.type === type));
  const counts = slots.reduce((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {});
  // Nhóm theo tầng. Bản cache khi bãi mất kết nối không có tầng -> một nhóm chung.
  const floors = Object.entries(slots.reduce((m, s) => ({ ...m, [s.floor ?? '']: [...(m[s.floor ?? ''] ?? []), s] }), {}));
  const hhmm = (d) => new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  // Lịch 24 giờ của ô: giờ nào có lượt đặt chồng lên thì tô vàng; vạch đỏ = giờ hiện tại (nếu là hôm nay).
  const dayStart = new Date(`${day}T00:00`).getTime();
  const busyHour = (h) => schedule.some((x) => new Date(x.startTime).getTime() < dayStart + (h + 1) * 3600e3 && new Date(x.endTime).getTime() > dayStart + h * 3600e3);
  const nowHour = Date.now() >= dayStart && Date.now() < dayStart + 86400e3 ? new Date().getHours() : -1;

  const slotButton = (s) => (
    <button key={s.slotCode} className={`slot ${s.status} ${s.slotCode === selected ? 'sel' : ''}`} onClick={() => pick(s)}
      aria-label={`${s.slotCode}, ${TYPE_LABEL[s.type] ?? ''}, ${STATUS_LABEL[s.status]}`}
      title={`${s.slotCode} – ${TYPE_LABEL[s.type] ?? ''} – ${STATUS_LABEL[s.status]} (v${s.version})`}>
      {s.slotCode}<Icon name={slotIcon(s.status, s.type)} />
    </button>
  );

  const noteBox = note && (
    <div className={note.kind === 'ok' ? 'cmd ok' : 'cmd bad'} role="status">
      <span className="ic"><Icon name={note.kind === 'ok' ? 'circle-check' : 'circle-x'} /></span>
      <span className="cmd-title">{note.kind === 'ok' ? 'Thành công' : 'Không thực hiện được'}</span>
      <span className="cmd-sub">{note.text}</span>
      {note.cash && <div className="cmd-actions"><button className="primary" onClick={() => act('exit', true)}><Icon name="card" /> Thu tiền mặt và cho ra</button></div>}
    </div>
  );

  return (
    <>
      <button className="link" onClick={onBack}><Icon name="back" /> Tổng quan</button>
      <div className="page-head" style={{ marginTop: 'var(--space-2)' }}>
        <div>
          <h2>{p.name}</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {p.address && `${p.address} · `}{p.direct ? 'đọc thẳng từ bãi' : loadedAt && `dữ liệu lúc ${clock(loadedAt)}`}
          </p>
        </div>
        <NodeBadge status={p.status} />
      </div>
      {p.direct && (
        <div className="banner bad"><Icon name="wifi-off" />
          <div><strong>Trung tâm (Aggregator) đang mất kết nối</strong>Bạn đang làm việc trực tiếp với bãi {parkingId}. Xe vào/ra vẫn ghi vào bãi; trung tâm sẽ tự đồng bộ khi hoạt động lại.</div>
        </div>
      )}
      {p.stale && (
        <div className="banner"><Icon name="alert" />
          <div><strong>Bãi đang mất kết nối</strong>Đây là trạng thái cuối cùng Aggregator biết (có thể đã cũ); tạm thời không nhận đặt chỗ.</div>
        </div>
      )}
      <div className="legend" style={{ alignItems: 'center', margin: 'var(--space-4) 0' }}>
        <div className="seg" role="group" aria-label="Loại xe">
          {[['', 'Tất cả'], ...Object.entries(TYPE_LABEL)].map(([k, v]) => (
            <button key={k} className={type === k ? 'tab active' : 'tab'} onClick={() => setType(k)}>{v}</button>
          ))}
        </div>
        {Object.entries(STATUS_LABEL).map(([k, v]) => <span key={k} className={`chip ${k}`}><Icon name={slotIcon(k)} />{v}: <b>{counts[k] ?? 0}</b></span>)}
      </div>

      <div className={p.stale ? undefined : 'split'}>
        <div>
          {floors.map(([floor, list]) => {
            const cars = list.filter((s) => s.type !== 'MOTO');
            const motos = list.filter((s) => s.type === 'MOTO');
            return (
              <section key={floor}>
                {floor && <h3 className="floor">Tầng {floor} <span className="small">{[cars.length && `${cars.length} ô tô`, motos.length && `${motos.length} xe máy`].filter(Boolean).join(' · ')}</span></h3>}
                <div className="lot">
                  {cars.length > 0 && <><div className="lot-label"><Icon name={TYPE_ICON.CAR} /> Ô tô</div><div className="grid">{cars.map(slotButton)}</div></>}
                  {cars.length > 0 && motos.length > 0 && <div className="aisle" />}
                  {motos.length > 0 && <><div className="lot-label"><Icon name={TYPE_ICON.MOTO} /> Xe máy</div><div className="grid moto">{motos.map(slotButton)}</div></>}
                </div>
              </section>
            );
          })}
          {!slots.length && <div className="empty"><Icon name="inbox" /><strong>Chưa có dữ liệu slot</strong></div>}
        </div>

        {!p.stale && (
          <aside className="stack">
            {!slot && (
              <div className="card">
                <div className="empty" style={{ border: 0, padding: 'var(--space-5) var(--space-2)' }}>
                  <Icon name="pin" /><strong>Chọn một ô trên sơ đồ</strong>
                  {user.role === 'USER' ? 'Bấm vào ô để xem lịch và đặt chỗ.' : 'Bấm vào ô để cho xe vào/ra hoặc sửa ô.'}
                </div>
              </div>
            )}
            {slot && (
              <div className="card stack" style={{ gap: 'var(--space-3)' }}>
                <div className="sheet-head">
                  <span className="sheet-code">{slot.slotCode}</span>
                  <TypeTag type={slot.type} />
                  <SlotStatus status={slot.status} type={slot.type} />
                  {slot.floor != null && <span className="muted small">Tầng {slot.floor}</span>}
                </div>
                {pending && (
                  <form onSubmit={reserve} className="stack" style={{ gap: 'var(--space-3)' }}>
                    <label className="field">Biển số
                      <input placeholder="vd 30A-123.45" value={plate} onChange={(e) => setPlate(e.target.value)} required />
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px', gap: 'var(--space-2)' }}>
                      <label className="field">Giờ đến
                        <input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); setPending({ ...pending, key: newKey(), unknown: false }); }} />
                      </label>
                      <label className="field">Thời lượng
                        <select value={duration} onChange={(e) => { setDuration(Number(e.target.value)); setPending({ ...pending, key: newKey(), unknown: false }); }}>
                          {[60, 120, 180, 240, 480, 720, 1440].map((m) => <option key={m} value={m}>{m / 60} giờ</option>)}
                        </select>
                      </label>
                    </div>
                    {slot.status !== 'AVAILABLE' && !when && <p className="muted small" style={{ margin: 0 }}>Ô đang bận: chọn giờ đến khác để đặt trước.</p>}
                    {busy ? (
                      <div className="cmd pending" role="status">
                        <span className="ic"><Icon name="loader" spin /></span>
                        <span className="cmd-title">Đang xử lý</span>
                        <span className="cmd-sub">Đang gửi lượt đặt tới bãi {parkingId}, có thể mất vài giây. Kết quả tự hiện khi về.</span>
                        <span className="cmd-meta">#{pending.key.slice(0, 8)}</span>
                        <span className="track" />
                      </div>
                    ) : pending.unknown ? (
                      <div className="cmd timeout" role="status">
                        <span className="ic"><Icon name="wifi-off" /></span>
                        <span className="cmd-title">Mạng chậm, quá thời gian chờ</span>
                        <span className="cmd-sub">Bấm Thử lại để gửi lại đúng lượt cũ, không bị đặt trùng.</span>
                        <span className="cmd-meta">#{pending.key.slice(0, 8)}</span>
                        <div className="cmd-actions"><button className="primary"><Icon name="retry" /> Thử lại</button></div>
                      </div>
                    ) : (
                      <button className="primary">{when ? 'Đặt trước' : 'Đặt ngay'}</button>
                    )}
                    <div>
                      <div className="row" style={{ marginBottom: 'var(--space-1)' }}>
                        <span className="kicker">Lịch của ô · {day.split('-').reverse().join('/')}</span>
                        <span className="mono small muted">0h – 24h</span>
                      </div>
                      <div className="timeline" aria-hidden="true">
                        {Array.from({ length: 24 }, (_, h) => <i key={h} className={[busyHour(h) && 'busy', h === nowHour && 'now'].filter(Boolean).join(' ') || undefined} />)}
                      </div>
                      <p className="muted small" style={{ margin: 'var(--space-1) 0 0' }}>
                        Đã có người đặt ngày {day.split('-').reverse().join('/')}:{' '}
                        {schedule.length ? schedule.map((x) => `${hhmm(x.startTime)}–${hhmm(x.endTime)}`).join(', ') : 'chưa có'}
                      </p>
                    </div>
                  </form>
                )}
                {isStaff && (
                  <>
                    <label className="field">Biển số (tuỳ chọn)
                      <input placeholder="vd 30A-123.45" value={plate} onChange={(e) => setPlate(e.target.value)} />
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
                      {(STAFF_ACTIONS[slot.status] ?? []).map(([a, label], i) => (
                        <button key={a} className={i === 0 ? 'primary' : undefined} onClick={() => act(a)}>
                          <Icon name={{ enter: 'login', exit: 'logout', maintenance: 'wrench', unmaintenance: 'wrench' }[a]} />{label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {isStaff && ['AVAILABLE', 'MAINTENANCE'].includes(slot.status) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '90px minmax(0, 1fr) auto', gap: 'var(--space-2)', alignItems: 'end' }}>
                    <label className="field">Tầng
                      <input type="number" className="num" style={{ width: '100%' }} defaultValue={slot.floor} key={`f${slot.slotCode}`}
                        onBlur={(e) => Number(e.target.value) !== slot.floor && manage('PATCH', { floor: Number(e.target.value) }, slot.slotCode)} />
                    </label>
                    <label className="field">Loại
                      <select value={slot.type} onChange={(e) => manage('PATCH', { type: e.target.value }, slot.slotCode)}>
                        {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </label>
                    <button className="danger" onClick={() => confirm(`Gỡ slot ${slot.slotCode}?`) && manage('DELETE', undefined, slot.slotCode)}><Icon name="eye-off" /> Gỡ slot</button>
                  </div>
                )}
                {!pending && !isStaff && <p className="muted" style={{ margin: 0 }}>Ô đang bảo trì, tạm không nhận đặt chỗ.</p>}
              </div>
            )}
            {noteBox}
            {isStaff && p.status !== 'OFFLINE' && !p.direct && (
              <form className="card stack" style={{ gap: 'var(--space-2)' }} onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.target);
                manage('POST', { slotCode: f.get('code').toUpperCase(), floor: Number(f.get('floor')), type: f.get('type') });
              }}>
                <h4 style={{ margin: 0 }}>Thêm slot</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 70px 110px', gap: 'var(--space-2)' }}>
                  <input name="code" placeholder="Mã, vd A21" aria-label="Mã slot" required maxLength="10" />
                  <input name="floor" type="number" className="num" style={{ width: '100%' }} aria-label="Tầng" defaultValue="1" required />
                  <select name="type" aria-label="Loại xe">{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </div>
                <button><Icon name="plus" /> Thêm</button>
              </form>
            )}
          </aside>
        )}
      </div>
      {p.stale && noteBox}

      <div className={isStaff ? 'duo' : undefined} style={{ marginTop: 'var(--space-6)' }}>
        {p.status !== 'OFFLINE' && !p.direct && <Pricing parkingId={parkingId} canEdit={isStaff} />}
        {isStaff && (
          <div>
            <h3>Đặt chỗ tại bãi</h3>
            <div className="scroll"><table>
              <thead><tr><th>Slot</th><th>Biển số</th><th>Khung giờ</th><th>Trạng thái</th><th /></tr></thead>
              <tbody>
                {reservations.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.slotCode}</td><td><Plate value={r.licensePlate} /></td>
                    <td className="mono small">{new Date(r.startTime).toLocaleString('vi-VN')} – {new Date(r.endTime).toLocaleTimeString('vi-VN')}</td>
                    <td><ResStatus status={r.status} /></td>
                    <td>{r.status === 'ACTIVE' && <button className="link" onClick={() => cancel(r.id)}>Huỷ</button>}</td>
                  </tr>
                ))}
                {!reservations.length && <tr><td colSpan="5" className="muted">Chưa có.</td></tr>}
              </tbody>
            </table></div>
          </div>
        )}
      </div>
    </>
  );
}
