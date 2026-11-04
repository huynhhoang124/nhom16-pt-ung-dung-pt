import { useCallback, useEffect, useRef, useState } from 'react';
import { api, centralDown, formatPlate, knownNode, message, newKey, nodeApi, rememberNodes, STATUS_LABEL, useLive } from '../api.js';
import { TYPE_LABEL } from './Dashboard.jsx';
import Pricing from './Pricing.jsx';
import { commandRequest } from '../api.js';
import { clock, ConfirmDialog, Icon, NodeBadge, Plate, ResStatus, slotIcon, SlotStatus, TypeTag, TYPE_ICON } from '../ui.jsx';

// Thao tác nhân viên theo trạng thái slot.
const STAFF_ACTIONS = {
  AVAILABLE: [['enter', 'Xe vào'], ['maintenance', 'Khoá bảo trì']],
  RESERVED: [['enter', 'Xe vào']],
  OCCUPIED: [['exit', 'Xe ra']],
  MAINTENANCE: [['unmaintenance', 'Mở khoá']],
};

// Chú thích sơ đồ: chỉ trạng thái của ô (không lẫn trạng thái kết nối của bãi).
const SLOT_STATUSES = ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'MAINTENANCE'];
const fmt = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())} · ${p(d.getDate())}/${p(d.getMonth() + 1)}`;
};

const normPlate = (v) => String(v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
// Thời gian đã gửi: "45 phút" / "2 giờ 05 phút".
const since = (iso) => {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
  return m < 60 ? `${m} phút` : `${Math.floor(m / 60)} giờ ${String(m % 60).padStart(2, '0')} phút`;
};

export default function ParkingDetail({ parkingId, user, onBack, onMine, initialSlot = null }) {
  const [p, setP] = useState(null);
  const [selected, setSelected] = useState(initialSlot);    // slot đang chọn (mở từ "Tra biển số" thì chọn sẵn)
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
  const [booked, setBooked] = useState(null);         // lượt vừa đặt thành công (hiện thẻ xác nhận)
  const [acting, setActing] = useState(false);        // nhân viên đang gửi xe vào/ra: khoá nút, chống bấm đúp
  const [occupant, setOccupant] = useState(null);     // phiên gửi của ô đang có xe: biển số, giờ vào, phí tạm tính
  const [charge, setCharge] = useState(null);         // bước thu tiền mặt khi xe ra mà chưa trả: { slotCode, fee, breakdown, received }
  const [ask, setAsk] = useState(null);               // hộp xác nhận đang mở (gỡ ô, huỷ đặt chỗ)
  const [resFilter, setResFilter] = useState('ACTIVE'); // bảng đặt chỗ tại bãi: 'ACTIVE' | 'ALL'
  const asideRef = useRef(null);
  const isStaff = user.role === 'ADMIN' || (user.role === 'STAFF' && user.parkingId === parkingId);

  // PT-05: Aggregator sập -> nhân viên đọc/ghi thẳng node của bãi (p.direct = true)
  const load = useCallback(async () => {
    const r = await api(`/api/parkings/${parkingId}`);
    if (r.ok) { setP(r.data); rememberNodes([r.data]); setLoadedAt(new Date().toISOString()); }
    else if (isStaff && centralDown(r) && knownNode(parkingId)) {
      const slots = await nodeApi(parkingId, '/api/slots');
      if (slots.ok) {
        setP({ parkingId, name: knownNode(parkingId).name, status: 'ONLINE', stale: false, direct: true, slots: slots.data });
        setLoadedAt(new Date().toISOString());
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
  // byKeyboard: chọn bằng Enter/Space (click có detail = 0) -> đưa focus sang panel thao tác.
  function pick(slot, byKeyboard = false) {
    setNote(null);
    setBooked(null);
    setCharge(null);
    setSelected(slot.slotCode);
    if (user.role === 'USER' && slot.status !== 'MAINTENANCE') setPending({ slotCode: slot.slotCode, key: newKey(), unknown: false });
    else setPending(null);
    // Màn hẹp: panel nằm dưới sơ đồ -> cuộn tới để người dùng thấy ngay form.
    setTimeout(() => {   // chờ React vẽ panel của ô mới chọn
      const el = asideRef.current;
      if (byKeyboard) el?.querySelector('.card input:not([disabled]), .card select:not([disabled]), .card button:not([disabled])')?.focus({ preventScroll: true });
      if (!el || el.getBoundingClientRect().top <= window.innerHeight * 0.6) return;
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    }, 50);
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
      setNote(null);
      setBooked({ slotCode: pending.slotCode, plate, start: r.data.start_time, end: r.data.end_time, expire: r.data.expire_time });
      setPending(null);
    } else if (r.status === 504 || r.status === 0) {
      setPending({ ...pending, unknown: true });   // giữ nguyên key để thử lại an toàn
      setNote({ kind: 'error', text: message(r.status ? r.data : { error: 'TIMEOUT_UNKNOWN_RESULT' }) });
    } else {
      // Bãi đã từ chối: giữ form để sửa và gửi lại (key mới vì là yêu cầu mới).
      setNote({ kind: 'error', text: message(r.data), field: ['INVALID_PLATE', 'PLATE_ALREADY_INSIDE'].includes(r.data?.error) ? 'plate' : null });
      setPending({ ...pending, key: newKey(), unknown: false });
    }
    load();
  }

  // Ô đang có xe: tải phiên đang mở + phí tạm tính để nhân viên biết đúng xe nào trước khi cho ra.
  const cur = p?.slots.find((s) => s.slotCode === selected);
  const curKey = cur ? `${cur.slotCode}:${cur.status}:${cur.version}` : '';
  useEffect(() => {
    setOccupant(null);
    if (!isStaff || cur?.status !== 'OCCUPIED') return undefined;
    let stop = false;
    (async () => {
      const get = (path, nodePath) => (p.direct ? nodeApi(parkingId, nodePath) : api(path));
      const list = await get(`/api/parkings/${parkingId}/sessions`, '/api/sessions');
      const s = list.ok && list.data.find((x) => x.slotCode === cur.slotCode && !x.exitedAt);
      if (!s) { if (!stop) setOccupant({ missing: true }); return; }
      const q = await get(`/api/parkings/${parkingId}/sessions/${s.id}/quote`, `/api/sessions/${s.id}/quote`);
      if (!stop) setOccupant({ ...s, quote: q.ok ? q.data : null });
    })();
    return () => { stop = true; };
  }, [curKey, isStaff, p?.direct]);

  async function act(action, cash = false) {
    if (acting) return;
    setActing(true);
    try { await doAct(action, cash); }
    // Giữ khoá thêm một nhịp: nút "Xe ra" hiện đúng chỗ nút "Xe vào", nháy đúp không được ghi thành vào rồi ra.
    finally { setTimeout(() => setActing(false), 700); }
  }

  async function doAct(action, cash) {
    const body = { licensePlate: plate || undefined, cash };
    let r = p.direct ? { status: 0 } : await api(`/api/parkings/${parkingId}/slots/${selected}/${action}`, { method: 'POST', body });
    // Trung tâm không trả lời -> làm thẳng với bãi. An toàn kể cả khi lệnh trước thực ra đã tới bãi:
    // xe vào/ra kiểm trạng thái slot (compare-and-swap), lặp lại chỉ nhận 409 chứ không làm hai lần.
    if (isStaff && centralDown(r)) r = await nodeApi(parkingId, `/api/slots/${selected}/${action}`, { method: 'POST', body });
    if (r.status === 402) {   // chưa trả tiền: bước thu tiền bình thường, không phải lỗi
      setNote(null);
      setCharge({ slotCode: selected, fee: r.data.fee, plate: occupant?.licensePlate, breakdown: occupant?.quote?.breakdown ?? [], received: false });
    } else {
      setCharge(null);
      setNote(r.ok ? { kind: 'ok', text: doneText(action, r.data, cash) } : { kind: 'error', text: message(r.data) });
    }
    if (r.ok) setPlate('');
    load();
  }

  // Câu báo kết quả theo nghĩa nghiệp vụ ("Xe … đã ra · thu …"), không phải nhãn trạng thái ô.
  function doneText(action, d, cash) {
    const pl = d?.session?.licensePlate ?? (action === 'exit' ? occupant?.licensePlate : plate);
    const car = pl ? `Xe ${formatPlate(normPlate(pl))}` : 'Xe';
    const money = (v) => `${Number(v).toLocaleString('vi-VN')} đ`;
    if (action === 'enter') return `${car} đã vào ô ${selected}.`;
    if (action === 'exit') {
      const fee = d?.session?.fee ?? 0;
      const how = !fee ? 'miễn phí' : cash ? `đã thu ${money(fee)} tiền mặt` : `đã thanh toán ${money(fee)} trên ứng dụng`;
      return `${car} đã ra khỏi ô ${selected} · ${how}.`;
    }
    return action === 'maintenance' ? `Đã khoá ô ${selected} để bảo trì.` : `Đã mở khoá ô ${selected}, ô sẵn sàng nhận xe.`;
  }

  // NV-09: quản lý slot (nhân viên bãi này, quản trị)
  async function manage(method, body, code = '') {
    const r = await api(`/api/parkings/${parkingId}/slots${code && `/${code}`}`, { method, body });
    const text = method === 'DELETE' ? `Đã gỡ ô ${code}.` : method === 'POST' ? `Đã thêm ô ${r.data?.slotCode}.` : `Đã lưu ô ${r.data?.slotCode}.`;
    setNote(r.ok ? { kind: 'ok', text } : { kind: 'error', text: message(r.data) });
    if (r.ok && method === 'DELETE') setSelected(null);
    if (r.ok && method === 'POST') setSelected(r.data.slotCode);   // chọn sẵn ô vừa thêm
    await load();
    return r;
  }

  const askRemove = (code) => setAsk({
    title: `Gỡ ô ${code}?`, body: 'Ô sẽ ẩn khỏi sơ đồ và không nhận đặt chỗ nữa. Lịch sử gửi xe của ô vẫn được giữ.',
    label: 'Gỡ ô', danger: true, run: () => manage('DELETE', undefined, code),
  });

  const askCancel = (r) => setAsk({
    title: `Huỷ đặt chỗ ô ${r.slotCode}?`,
    body: <>Vé của <Plate value={r.licensePlate} /> ({fmt(r.startTime)}) sẽ bị huỷ và ô được trả lại. Không hoàn tác được.</>,
    label: 'Huỷ đặt chỗ', danger: true, run: () => cancel(r.id),
  });

  async function cancel(id) {
    const r = await commandRequest(`/api/parkings/${parkingId}/reservations/${id}`, { method: 'DELETE' },()=>setNote({kind:'ok',text:'Đang xử lý yêu cầu huỷ…'}));
    setNote(r.ok ? { kind: 'ok', text: 'Đã huỷ đặt chỗ.' } : { kind: 'error', text: message(r.data) });
    load();
  }

  if (!p) return loadError
    ? <div className="empty" style={{ borderColor: 'var(--bad)' }}><Icon name="alert" /><strong>Không tải được bãi</strong>{loadError}</div>
    : <div className="stack"><span className="skeleton" style={{ height: 40, width: 280 }} /><span className="skeleton" style={{ height: 320 }} /></div>;
  const slot = p.slots.find((s) => s.slotCode === selected);
  // Đã tải được trước đó nhưng lần tải gần nhất thất bại (trung tâm và bãi đều không trả lời): sơ đồ có thể đã cũ.
  const lost = !!loadError;
  // Ô đã đặt: vé đang giữ ô (ACTIVE, đến sớm nhất). Cho xe vào phải đúng biển số trên vé.
  const holder = isStaff && slot?.status === 'RESERVED'
    ? reservations.filter((r) => r.slotCode === slot.slotCode && r.status === 'ACTIVE')
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))[0] ?? null
    : null;
  // Các lượt đặt còn hiệu lực của ô đang chọn (trừ vé đang giữ ô) — nhân viên phải thấy trước khi khoá bảo trì / sửa ô.
  const upcoming = isStaff && slot
    ? reservations.filter((r) => r.slotCode === slot.slotCode && r.status === 'ACTIVE' && new Date(r.endTime) > Date.now() && r.id !== holder?.id)
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    : [];
  const resLine = (r) => <><Plate value={r.licensePlate} /> <span className="mono small">{fmt(r.startTime)} – {new Date(r.endTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span></>;
  // Khoá bảo trì ô còn vé đặt: hỏi lại, nói rõ vé nào bị ảnh hưởng (vé KHÔNG tự huỷ).
  function staffAction(a) {
    if (a !== 'maintenance' || !upcoming.length) return act(a);
    setAsk({
      title: `Ô ${slot.slotCode} còn ${upcoming.length} lượt đặt`,
      body: (
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <ul className="res-list">{upcoming.map((r) => <li key={r.id}>{resLine(r)}</li>)}</ul>
          <span>Khoá bảo trì <b>không tự huỷ</b> các vé này: khách vẫn sẽ đến ô {slot.slotCode}. Hãy huỷ vé ở bảng “Đặt chỗ tại bãi” hoặc báo khách đổi ô.</span>
        </div>
      ),
      label: 'Vẫn khoá bảo trì', danger: true, run: () => act('maintenance'),
    });
  }
  const shownRes =(resFilter === 'ACTIVE' ? reservations.filter((r) => r.status === 'ACTIVE') : reservations)
    .slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const plateMatch = !!holder && normPlate(plate) === normPlate(holder.licensePlate);
  const plateMismatch = !!holder && !plateMatch && normPlate(plate).length >= normPlate(holder.licensePlate).length;
  const slots = p.slots.filter((s) => s.status !== 'HIDDEN' && (!type || s.type === type));
  const counts = slots.reduce((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {});
  // Nhóm theo tầng. Bản cache khi bãi mất kết nối không có tầng -> một nhóm chung.
  const floors = Object.entries(slots.reduce((m, s) => ({ ...m, [s.floor ?? '']: [...(m[s.floor ?? ''] ?? []), s] }), {}));
  const hhmm = (d) => new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  // Lịch 24 giờ của ô: giờ nào có lượt đặt chồng lên thì tô vàng; vạch đỏ = giờ hiện tại (nếu là hôm nay).
  const dayStart = new Date(`${day}T00:00`).getTime();
  const busyHour = (h) => schedule.some((x) => new Date(x.startTime).getTime() < dayStart + (h + 1) * 3600e3 && new Date(x.endTime).getTime() > dayStart + h * 3600e3);
  const nowHour = Date.now() >= dayStart && Date.now() < dayStart + 86400e3 ? new Date().getHours() : -1;

  // Bàn phím: cả sơ đồ chỉ là MỘT điểm dừng Tab (ô đang chọn, hoặc ô đầu tiên); mũi tên đi giữa các ô.
  const tabCode = slots.some((s) => s.slotCode === selected) ? selected : slots[0]?.slotCode;
  function slotKeys(e) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const all = [...e.currentTarget.closest('main').querySelectorAll('button.slot')];
    const i = all.indexOf(e.currentTarget);
    const cur = e.currentTarget.getBoundingClientRect();
    let next;
    if (e.key === 'ArrowRight') next = all[i + 1];
    else if (e.key === 'ArrowLeft') next = all[i - 1];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else {
      // Lên/xuống: hàng gần nhất phía trên/dưới, chọn ô có tâm ngang gần nhất.
      const down = e.key === 'ArrowDown';
      const rows = all.map((b) => [b, b.getBoundingClientRect()]).filter(([, r]) => (down ? r.top > cur.top + 4 : r.top < cur.top - 4));
      const rowTop = rows.length ? (down ? Math.min(...rows.map(([, r]) => r.top)) : Math.max(...rows.map(([, r]) => r.top))) : null;
      const cx = cur.left + cur.width / 2;
      next = rows.filter(([, r]) => Math.abs(r.top - rowTop) < 4)
        .sort(([, a], [, b]) => Math.abs(a.left + a.width / 2 - cx) - Math.abs(b.left + b.width / 2 - cx))[0]?.[0];
    }
    if (next) { all.forEach((b) => { b.tabIndex = -1; }); next.tabIndex = 0; next.focus(); }
  }

  const slotButton = (s) => (
    <button key={s.slotCode} className={`slot ${s.status} ${s.slotCode === selected ? 'sel' : ''}`}
      onClick={(e) => pick(s, e.detail === 0)} onKeyDown={slotKeys} tabIndex={s.slotCode === tabCode ? 0 : -1}
      aria-pressed={s.slotCode === selected}
      aria-label={`${s.slotCode}, ${TYPE_LABEL[s.type] ?? ''}, ${STATUS_LABEL[s.status]}`}
      title={`${s.slotCode} – ${TYPE_LABEL[s.type] ?? ''} – ${STATUS_LABEL[s.status]} (v${s.version})`}>
      {s.slotCode}<Icon name={slotIcon(s.status, s.type)} />
    </button>
  );

  const noteBox = note && !note.field && (
    <div className={note.kind === 'ok' ? 'cmd ok' : 'cmd bad'} role="status">
      <span className="ic"><Icon name={note.kind === 'ok' ? 'circle-check' : 'circle-x'} /></span>
      <span className="cmd-title">{note.kind === 'ok' ? 'Thành công' : 'Không thực hiện được'}</span>
      <span className="cmd-sub">{note.text}</span>
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
          <div><strong>Máy chủ trung tâm đang mất kết nối</strong>Bạn đang làm việc trực tiếp với bãi {parkingId}. Xe vào/ra vẫn ghi vào bãi; trung tâm sẽ tự đồng bộ khi hoạt động lại.</div>
        </div>
      )}
      {lost && (
        <div className="banner bad" role="alert"><Icon name="wifi-off" />
          <div>
            <strong>Mất kết nối – sơ đồ có thể đã cũ</strong>
            Không liên lạc được máy chủ{isStaff ? ' trung tâm lẫn máy chủ của bãi' : ''}. Đang hiển thị dữ liệu lúc {clock(loadedAt)}; hệ thống tự thử lại mỗi 10 giây.
            {isStaff && ' Tạm khoá thao tác xe vào/ra để tránh ghi sai.'}
          </div>
        </div>
      )}
      {p.stale && (
        <div className="banner"><Icon name="alert" />
          <div><strong>Bãi đang mất kết nối</strong>Đây là trạng thái cuối cùng hệ thống biết về bãi (có thể đã cũ); tạm thời không nhận đặt chỗ.</div>
        </div>
      )}
      <div className="legend" style={{ alignItems: 'center', margin: 'var(--space-4) 0' }}>
        <div className="seg" role="group" aria-label="Loại xe">
          {[['', 'Tất cả'], ...Object.entries(TYPE_LABEL)].map(([k, v]) => (
            <button key={k} className={type === k ? 'tab active' : 'tab'} aria-pressed={type === k} onClick={() => setType(k)}>{v}</button>
          ))}
        </div>
        {SLOT_STATUSES.map((k) => <span key={k} className={`chip ${k}`}><Icon name={slotIcon(k)} />{STATUS_LABEL[k]}: <b>{counts[k] ?? 0}</b></span>)}
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
          <aside className="stack" ref={asideRef}>
            {!slot && (
              <div className="card">
                <div className="empty" style={{ border: 0, padding: 'var(--space-5) var(--space-2)' }}>
                  <Icon name="pin" /><strong>Chọn một ô trên sơ đồ</strong>
                  {user.role === 'USER' ? 'Bấm vào ô để xem lịch và đặt chỗ.' : isStaff ? 'Bấm vào ô để cho xe vào/ra hoặc sửa ô.' : `Chế độ chỉ xem: bạn thao tác được ở bãi ${user.parkingId}.`}
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
                {user.role === 'STAFF' && !isStaff && (
                  <p className="muted small" style={{ margin: 0 }}><Icon name="info" /> Chế độ chỉ xem: bãi {parkingId} do nhân viên bãi {parkingId} thao tác. Bạn làm việc ở <b>bãi {user.parkingId}</b>.</p>
                )}
                {pending && (
                  <form onSubmit={reserve} className="stack" style={{ gap: 'var(--space-3)' }}>
                    <label className="field">Biển số
                      <input placeholder="vd 30A-123.45" value={plate} required autoComplete="off"
                        aria-invalid={note?.field === 'plate' ? 'true' : undefined}
                        onChange={(e) => { setPlate(e.target.value); if (note?.field === 'plate') setNote(null); }} />
                      {note?.field === 'plate' && <span className="error">{note.text}</span>}
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
                    ) : slot.status !== 'AVAILABLE' && !when ? (
                      <button className="primary" type="button" disabled>Ô đang bận – chọn giờ đến</button>
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
                {isStaff && slot.status === 'OCCUPIED' && (
                  <div className="occupant">
                    {!occupant ? <span className="skeleton" style={{ height: 72 }} />
                      : occupant.missing ? <p className="muted small" style={{ margin: 0 }}>Không tìm thấy phiên gửi của ô này.</p>
                      : (
                        <dl>
                          <dt>Biển số</dt><dd><Plate value={occupant.licensePlate} /></dd>
                          <dt>Vào lúc</dt><dd>{fmt(occupant.enteredAt)} <span className="muted small">· đã gửi {since(occupant.enteredAt)}</span></dd>
                          <dt>Phí tạm tính</dt>
                          <dd>
                            <b className="tnum-inline">{(occupant.paidAt ? occupant.fee : occupant.quote?.fee ?? 0).toLocaleString('vi-VN')} đ</b>
                            {occupant.paidAt ? <span className="st ok"><Icon name="check" />Đã trả</span>
                              : (occupant.quote?.fee ?? 0) > 0 ? <span className="st warn"><Icon name="clock" />Chưa trả</span>
                              : <span className="muted small">miễn phí dưới 5 phút</span>}
                          </dd>
                        </dl>
                      )}
                  </div>
                )}
                {isStaff && slot.status === 'RESERVED' && holder && (
                  <div className="occupant">
                    <dl>
                      <dt>Vé đặt cho</dt><dd><Plate value={holder.licensePlate} /></dd>
                      <dt>Khung giờ</dt><dd>{fmt(holder.startTime)} – {new Date(holder.endTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</dd>
                    </dl>
                  </div>
                )}
                {upcoming.length > 0 && (
                  <div className="occupant">
                    <span className="kicker">{slot.status === 'RESERVED' ? 'Lượt đặt khác của ô' : 'Lượt đặt sắp tới'} ({upcoming.length})</span>
                    <ul className="res-list">{upcoming.map((r) => <li key={r.id}>{resLine(r)}</li>)}</ul>
                  </div>
                )}
                {isStaff && ['AVAILABLE', 'RESERVED'].includes(slot.status) && (
                  <label className="field">{holder ? 'Biển số xe đang vào (đối chiếu với vé)' : 'Biển số (tuỳ chọn)'}
                    <input placeholder="vd 30A-123.45" value={plate} onChange={(e) => setPlate(e.target.value)} autoComplete="off"
                      aria-invalid={plateMismatch ? 'true' : undefined} />
                    {plateMismatch && <span className="error">Không khớp vé đặt ({formatPlate(normPlate(holder.licensePlate))}). Kiểm tra lại xe.</span>}
                  </label>
                )}
                {isStaff && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
                    {(STAFF_ACTIONS[slot.status] ?? []).map(([a, label], i) => {
                      const needMatch = a === 'enter' && holder && !plateMatch;
                      return (
                        <button key={a} className={i === 0 ? 'primary' : undefined} onClick={() => staffAction(a)} disabled={acting || needMatch || lost}
                          title={needMatch ? 'Nhập đúng biển số trên vé để cho xe vào' : undefined}>
                          {acting && i === 0 ? <Icon name="loader" spin /> : <Icon name={{ enter: 'login', exit: 'logout', maintenance: 'wrench', unmaintenance: 'wrench' }[a]} />}
                          {a === 'enter' && holder ? (plateMatch ? 'Đúng xe – cho vào' : 'Nhập biển số để đối chiếu') : label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {isStaff && charge && charge.slotCode === slot.slotCode && (
                  <div className="charge" role="status">
                    <span className="kicker">Thu phí trước khi cho ra</span>
                    {charge.plate && <Plate value={charge.plate} />}
                    <div className="charge-amount">{charge.fee.toLocaleString('vi-VN')}<span> đ</span></div>
                    {charge.breakdown.length > 0 && (
                      <ul className="charge-lines">{charge.breakdown.map((b) => <li key={b.label}><span>{b.label}</span><b>{b.amount.toLocaleString('vi-VN')} đ</b></li>)}</ul>
                    )}
                    <label className="check">
                      <input type="checkbox" checked={charge.received} onChange={(e) => setCharge({ ...charge, received: e.target.checked })} />
                      Đã nhận đủ {charge.fee.toLocaleString('vi-VN')} đ tiền mặt
                    </label>
                    <div className="charge-actions">
                      <button onClick={() => setCharge(null)} disabled={acting}>Huỷ</button>
                      <button className="primary" disabled={!charge.received || acting} onClick={() => act('exit', true)}>
                        {acting ? <Icon name="loader" spin /> : <Icon name="card" />} Xác nhận đã thu &amp; cho ra
                      </button>
                    </div>
                  </div>
                )}
                {isStaff && ['AVAILABLE', 'MAINTENANCE'].includes(slot.status) && (
                  <SlotEditor key={`${slot.slotCode}:${slot.version}`} slot={slot}
                    onSave={(patch) => manage('PATCH', patch, slot.slotCode)} onRemove={() => askRemove(slot.slotCode)} />
                )}
                {booked && booked.slotCode === slot.slotCode && (
                  <div className="booked" role="status">
                    <div className="booked-head"><Icon name="circle-check" /><strong>Đã giữ chỗ {booked.slotCode}</strong></div>
                    <dl>
                      <dt>Biển số</dt><dd><Plate value={booked.plate.toUpperCase().replace(/[^0-9A-Z]/g, '')} /></dd>
                      <dt>Khung giờ</dt><dd>{fmt(booked.start)} – {new Date(booked.end).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</dd>
                      <dt>Đến trước</dt><dd><b>{fmt(booked.expire)}</b> <span className="muted small">(quá giờ sẽ mất chỗ)</span></dd>
                    </dl>
                    <div className="booked-actions">
                      {onMine && <button className="primary" onClick={onMine}><Icon name="qr" /> Xem vé &amp; mã QR</button>}
                      <button onClick={() => { setBooked(null); setSelected(null); }}>Đặt thêm ô khác</button>
                    </div>
                  </div>
                )}
                {!pending && !booked && !isStaff && slot.status === 'MAINTENANCE' && <p className="muted" style={{ margin: 0 }}>Ô đang bảo trì, tạm không nhận đặt chỗ.</p>}
              </div>
            )}
            {noteBox}
            {isStaff && p.status !== 'OFFLINE' && !p.direct && (
              <form className="card stack" style={{ gap: 'var(--space-2)' }} onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const f = new FormData(form);
                const r = await manage('POST', { slotCode: f.get('code').trim().toUpperCase(), floor: Number(f.get('floor')), type: f.get('type') });
                if (r.ok) { form.elements.code.value = ''; form.elements.code.focus(); }   // giữ tầng/loại để thêm tiếp nhanh
              }}>
                <h4 style={{ margin: 0 }}>Thêm ô mới</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 70px 110px', gap: 'var(--space-2)' }}>
                  <label className="field">Mã ô<input name="code" placeholder="vd A22" required maxLength="10" autoComplete="off" /></label>
                  <label className="field">Tầng<input name="floor" type="number" className="num" style={{ width: '100%' }} defaultValue="1" required /></label>
                  <label className="field">Loại<select name="type">{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                </div>
                <button><Icon name="plus" /> Thêm ô</button>
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
            <div className="row" style={{ marginBottom: 'var(--space-3)' }}>
              <h3 style={{ margin: 0 }}>Đặt chỗ tại bãi</h3>
              <div className="seg" role="group" aria-label="Lọc đặt chỗ">
                {[['ACTIVE', `Đang hiệu lực (${reservations.filter((r) => r.status === 'ACTIVE').length})`], ['ALL', `Tất cả (${reservations.length})`]].map(([k, v]) => (
                  <button key={k} className={resFilter === k ? 'tab active' : 'tab'} aria-pressed={resFilter === k} onClick={() => setResFilter(k)}>{v}</button>
                ))}
              </div>
            </div>
            <div className="scroll"><table>
              <thead><tr><th>Ô</th><th>Biển số</th><th>Khung giờ</th><th>Trạng thái</th><th /></tr></thead>
              <tbody>
                {shownRes.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.slotCode}</td><td><Plate value={r.licensePlate} /></td>
                    <td className="mono small">{fmt(r.startTime)} – {new Date(r.endTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</td>
                    <td><ResStatus status={r.status} /></td>
                    <td>{r.status === 'ACTIVE' && <button className="link danger-link" onClick={() => askCancel(r)}>Huỷ</button>}</td>
                  </tr>
                ))}
                {!shownRes.length && <tr><td colSpan="5" className="muted">{resFilter === 'ACTIVE' ? 'Không có đặt chỗ nào đang hiệu lực.' : 'Chưa có.'}</td></tr>}
              </tbody>
            </table></div>
          </div>
        )}
      </div>
      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </>
  );
}

// NV-09: sửa ô (tầng, loại) — đổi xong mới lưu bằng nút, không tự lưu khi vừa chọn; gỡ ô qua hộp xác nhận.
function SlotEditor({ slot, onSave, onRemove }) {
  const [floor, setFloor] = useState(String(slot.floor ?? ''));
  const [type, setType] = useState(slot.type);
  const [saving, setSaving] = useState(false);
  const dirty = Number(floor) !== slot.floor || type !== slot.type;
  const bad = floor === '' || !Number.isInteger(Number(floor));
  async function save(e) {
    e.preventDefault();
    if (!dirty || bad) return;
    setSaving(true);
    await onSave({ ...(Number(floor) !== slot.floor && { floor: Number(floor) }), ...(type !== slot.type && { type }) });
    setSaving(false);
  }
  return (
    <details className="slot-edit">
      <summary><Icon name="pencil" /> Sửa ô {slot.slotCode}</summary>
      <form onSubmit={save} className="stack" style={{ gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '90px minmax(0, 1fr)', gap: 'var(--space-2)' }}>
          <label className="field">Tầng
            <input type="number" className="num" style={{ width: '100%' }} value={floor} onChange={(e) => setFloor(e.target.value)} aria-invalid={bad ? 'true' : undefined} />
          </label>
          <label className="field">Loại
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <button type="button" className="danger" onClick={onRemove}><Icon name="eye-off" /> Gỡ ô</button>
          <button className="primary" disabled={!dirty || bad || saving}>{saving && <Icon name="loader" spin />} Lưu thay đổi</button>
        </div>
      </form>
    </details>
  );
}
