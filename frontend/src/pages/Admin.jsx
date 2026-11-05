import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, message, useLive } from '../api.js';
import { clock, ConfirmDialog, Icon, NodeBadge } from '../ui.jsx';

const LocationPicker = lazy(() => import('../LocationPicker.jsx'));   // Leaflet chỉ tải khi mở form

const EMPTY = { parkingId: '', name: '', apiUrl: '', address: '', lat: '', lng: '' };

// Kiểm tra ngay trên giao diện (cùng luật với máy chủ) để báo đúng ô nhập, trước khi gửi.
function validate(f, { isNew }) {
  const e = {};
  if (isNew && !/^[A-Z0-9]{1,8}$/.test(f.parkingId)) e.parkingId = 'Mã 1–8 ký tự, chỉ chữ in hoa và số (vd D, B2).';
  if (!f.name.trim()) e.name = 'Nhập tên bãi.';
  if (!/^https?:\/\/[^\s/]+/.test(f.apiUrl)) e.apiUrl = 'Địa chỉ phải bắt đầu bằng http:// hoặc https:// (vd http://parking-d:8004).';
  const num = (v, max) => v === '' || (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= max);
  if (!num(f.lat, 90)) e.lat = 'Vĩ độ từ -90 đến 90.';
  if (!num(f.lng, 180)) e.lng = 'Kinh độ từ -180 đến 180.';
  if ((f.lat === '') !== (f.lng === '')) e[f.lat === '' ? 'lat' : 'lng'] = 'Nhập đủ cả vĩ độ và kinh độ (hoặc bỏ trống cả hai).';
  return e;
}
const SERVER_FIELD = { INVALID_PARKING_ID: 'parkingId', PARKING_EXISTS: 'parkingId', INVALID_NAME: 'name', INVALID_API_URL: 'apiUrl', INVALID_COORDS: 'lat' };

// "vừa xong" / "3 phút trước" / giờ cụ thể nếu đã lâu.
function ago(iso) {
  if (!iso) return 'Chưa phản hồi lần nào';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  return s < 15 ? 'vừa xong' : s < 3600 ? `${Math.round(s / 60) || 1} phút trước` : `lúc ${clock(iso)}`;
}

// Gợi ý địa chỉ máy chủ theo quy ước docker-compose: bãi A -> http://parking-a:8001, B -> :8002, D -> :8004...
const suggestUrl = (id) => (/^[A-Z]$/.test(id) ? `http://parking-${id.toLowerCase()}:${8001 + id.charCodeAt(0) - 65}` : '');

function NodeForm({ initial, isNew, submitLabel, onSubmit, onCancel, others = [] }) {
  const [f, setF] = useState(initial);
  const [touched, setTouched] = useState({});
  const [serverErr, setServerErr] = useState(null);   // { field, text }
  const [busy, setBusy] = useState(false);
  const [urlAuto, setUrlAuto] = useState(isNew && !initial.apiUrl);   // còn tự gợi ý URL theo mã cho tới khi người dùng sửa URL
  const [autoAddr, setAutoAddr] = useState(null);     // địa chỉ vừa tự điền từ bản đồ (được ghi đè khi cắm ghim lại)
  const [check, setCheck] = useState(null);           // kết quả "Kiểm tra kết nối"
  const errs = validate(f, { isNew });
  const set = (k) => (e) => {
    const v = k === 'parkingId' ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') : e.target.value;
    const next = { ...f, [k]: v };
    if (k === 'parkingId' && urlAuto) next.apiUrl = suggestUrl(v);
    if (k === 'apiUrl') { setUrlAuto(false); setCheck(null); }
    if (k === 'parkingId' || k === 'apiUrl') setCheck(null);
    setF(next); setServerErr(null);
  };
  // Vị trí chọn từ bản đồ: luôn cập nhật toạ độ; địa chỉ chỉ điền khi ô đang trống hoặc là địa chỉ tự điền trước đó.
  const onPick = ({ lat, lng, address }) => setF((cur) => {
    const next = { ...cur, lat, lng };
    if (address && (!cur.address.trim() || cur.address === autoAddr)) { next.address = address; setAutoAddr(address); }
    return next;
  });
  async function runCheck() {
    if (errs.apiUrl) { setTouched({ ...touched, apiUrl: true }); return; }
    setCheck({ busy: true });
    const r = await api('/api/admin/nodes/check', { method: 'POST', body: { apiUrl: f.apiUrl } });
    setCheck(r.ok ? r.data : { ok: false, error: r.data?.error });
  }
  const checkView = () => {
    if (!check) return null;
    if (check.busy) return <span className="muted small"><Icon name="loader" spin /> Đang thử kết nối…</span>;
    if (!check.ok) return <span className="st bad"><Icon name="wifi-off" />{check.error === 'TIMEOUT' ? 'Quá 3 giây không phản hồi' : 'Không kết nối được tới địa chỉ này'}</span>;
    const want = f.parkingId || initial.parkingId;
    if (check.parkingId && want && check.parkingId !== want) {
      return <span className="st warn"><Icon name="alert" />Kết nối được, nhưng đây là máy chủ của bãi {check.parkingId}{check.registered ? ' (đã có trong hệ thống)' : ''}</span>;
    }
    return <span className="st ok"><Icon name="check" />Kết nối được{check.parkingId ? ` · máy chủ bãi ${check.parkingId}` : ''} · {check.ms} ms</span>;
  };
  const show = (k) => (touched[k] || touched.all) && errs[k];
  const fieldErr = (k) => show(k) || (serverErr?.field === k ? serverErr.text : null);
  async function submit(e) {
    e.preventDefault();
    setTouched({ all: true });
    if (Object.keys(errs).length) return;
    setBusy(true);
    const r = await onSubmit(f);
    setBusy(false);
    if (!r.ok) setServerErr({ field: SERVER_FIELD[r.data?.error] ?? null, text: message(r.data) });
  }
  const field = (k, label, props = {}) => (
    <label className="field">{label}
      <input value={f[k]} onChange={set(k)} onBlur={() => setTouched({ ...touched, [k]: true })} aria-invalid={fieldErr(k) ? 'true' : undefined} {...props} />
      {fieldErr(k) ? <span className="error">{fieldErr(k)}</span> : props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
  return (
    <form onSubmit={submit} noValidate className="node-form">
      <fieldset className="node-section">
        <legend>Thông tin bãi</legend>
        {isNew && field('parkingId', 'Mã bãi', { className: 'mono', placeholder: 'vd D', maxLength: 8, autoComplete: 'off', hint: 'Không đổi được sau khi thêm.' })}
        {field('name', 'Tên bãi', { placeholder: 'vd Bãi D – Long Biên' })}
        <div className="url-row">
          {field('apiUrl', 'Địa chỉ máy chủ của bãi', { className: 'mono', placeholder: 'http://parking-d:8004',
            hint: urlAuto && f.apiUrl ? 'Gợi ý theo mã bãi (quy ước docker-compose) — sửa nếu khác.' : 'Nơi máy chủ của bãi đang chạy; trung tâm gọi tới địa chỉ này.' })}
          <button type="button" onClick={runCheck} disabled={check?.busy}><Icon name="wifi" /> Kiểm tra kết nối</button>
        </div>
        <div aria-live="polite">{checkView()}</div>
      </fieldset>
      <fieldset className="node-section">
        <legend>Vị trí trên bản đồ <span className="muted small">(tuỳ chọn)</span></legend>
        <Suspense fallback={<span className="skeleton" style={{ height: 300 }} />}>
          <LocationPicker lat={f.lat} lng={f.lng} others={others} onPick={onPick} />
        </Suspense>
        {field('address', 'Địa chỉ hiển thị cho khách', { placeholder: 'Tự điền khi chọn trên bản đồ, sửa được',
          hint: f.address && f.address === autoAddr ? 'Lấy tự động theo vị trí — sửa cho gọn nếu cần.' : undefined })}
        <details className="manual-coords" open={!!(errs.lat || errs.lng) && touched.all}>
          <summary>Nhập toạ độ bằng tay</summary>
          <div className="coords">
            {field('lat', 'Vĩ độ', { className: 'mono', placeholder: '21.0285', inputMode: 'decimal' })}
            {field('lng', 'Kinh độ', { className: 'mono', placeholder: '105.8542', inputMode: 'decimal' })}
          </div>
        </details>
      </fieldset>
      {serverErr && !serverErr.field && <p className="error" style={{ gridColumn: '1 / -1', margin: 0 }}><Icon name="x" /> {serverErr.text}</p>}
      <div className="node-form-actions">
        {onCancel && <button type="button" onClick={onCancel} disabled={busy}>Huỷ</button>}
        <button className="primary" disabled={busy}>{busy ? <Icon name="loader" spin /> : <Icon name={isNew ? 'plus' : 'check'} />} {submitLabel}</button>
      </div>
    </form>
  );
}

export default function Admin({ onOpenLot }) {
  const [nodes, setNodes] = useState(null);
  const [note, setNote] = useState(null);   // { kind: 'ok'|'error', text }
  const [editing, setEditing] = useState(null);
  const [ask, setAsk] = useState(null);
  const [formKey, setFormKey] = useState(0);   // đổi key = làm mới form thêm bãi sau khi thêm xong
  const editBox = useRef(null);

  const load = useCallback(async () => {
    const r = await api('/api/admin/nodes');
    if (r.ok) setNodes(r.data);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  useLive(['NODE_STATUS'], load, 0);
  useEffect(() => { if (editing) editBox.current?.querySelector('input')?.focus(); }, [editing]);

  async function add(f) {
    const r = await api('/api/admin/nodes', { method: 'POST', body: f });
    if (r.ok) {
      setNote({ kind: 'ok', text: `Đã thêm ${r.data.name} (${r.data.parkingId}). Bãi sẽ chuyển sang "Đang kết nối" khi máy chủ của bãi phản hồi lần đầu (vài giây).` });
      setFormKey((k) => k + 1);
      load();
    }
    return r;
  }
  async function save(f) {
    const { parkingId, ...body } = f;
    const r = await api(`/api/admin/nodes/${editing.parkingId}`, { method: 'PATCH', body });
    if (r.ok) { setNote({ kind: 'ok', text: `Đã lưu thông tin bãi ${editing.parkingId}.` }); setEditing(null); load(); }
    return r;
  }
  const askRemove = (n) => setAsk({
    title: `Gỡ ${n.name} (${n.parkingId})?`,
    body: 'Bãi sẽ biến khỏi danh sách của khách và nhân viên. Chỉ gỡ được bãi đang mất kết nối (thêm nhầm hoặc đã ngừng chạy); dữ liệu trên máy chủ của bãi không bị xoá.',
    label: 'Gỡ bãi', danger: true,
    run: async () => {
      const r = await api(`/api/admin/nodes/${n.parkingId}`, { method: 'DELETE' });
      setNote(r.ok ? { kind: 'ok', text: `Đã gỡ bãi ${n.parkingId}.` } : { kind: 'error', text: message(r.data) });
      load();
    },
  });

  const list = nodes ?? [];
  const down = list.filter((n) => n.status === 'OFFLINE');
  const never = down.filter((n) => !n.lastSeen);
  const lost = down.filter((n) => n.lastSeen);
  const online = list.filter((n) => n.status === 'ONLINE').length;
  return (
    <>
      <div className="page-head">
        <div>
          <h2>Giám sát bãi</h2>
          <p className="muted" style={{ margin: 0 }}>Trung tâm hỏi thăm từng bãi mỗi 5 giây; 3 lần liền không phản hồi thì coi là mất kết nối.</p>
        </div>
        {nodes && (
          <div className="legend">
            <span className="st ok"><Icon name="wifi" />{online} đang kết nối</span>
            {down.length > 0 && <span className="st bad"><Icon name="wifi-off" />{down.length} mất kết nối</span>}
          </div>
        )}
      </div>
      {lost.length > 0 && (
        <div className="banner bad"><Icon name="wifi-off" />
          <div>
            <strong>{lost.map((n) => `Bãi ${n.parkingId} mất kết nối từ ${clock(n.lastSeen)}`).join(' · ')}</strong>
            Khách thấy dữ liệu cũ của các bãi này và tạm không đặt được chỗ. Kiểm tra máy chủ của bãi hoặc mạng giữa bãi và trung tâm.
          </div>
        </div>
      )}
      {never.length > 0 && (
        <div className="banner"><Icon name="alert" />
          <div>
            <strong>{never.map((n) => `Bãi ${n.parkingId}`).join(', ')} chưa kết nối được lần nào</strong>
            Có thể địa chỉ máy chủ bị nhập sai hoặc máy chủ bãi chưa chạy. Bấm “Sửa” để kiểm tra địa chỉ, hoặc “Gỡ” nếu thêm nhầm.
          </div>
        </div>
      )}
      <div className="scroll" style={{ marginTop: 'var(--space-4)' }}><table>
        <thead><tr><th>Bãi</th><th>Địa chỉ máy chủ</th><th>Trạng thái</th><th className="tnum" title="Số lần hỏi thăm liền nhau không được trả lời (ngưỡng 3)">Lần lỗi liền</th><th>Phản hồi gần nhất</th><th /></tr></thead>
        <tbody>
          {list.map((n) => (
            <tr key={n.parkingId}>
              <td><b className="mono">{n.parkingId}</b> · {n.name}{n.address && <div className="muted small">{n.address}</div>}</td>
              <td className="mono small">{n.url}</td>
              <td><NodeBadge status={n.status} /></td>
              <td className="tnum">{n.fails}</td>
              <td className="small">{ago(n.lastSeen)}</td>
              <td>
                <div className="row-actions">
                  {onOpenLot && n.status !== 'OFFLINE' && <button className="link" onClick={() => onOpenLot(n.parkingId)}>Xem bãi</button>}
                  <button className="link" onClick={() => setEditing(n)}><Icon name="pencil" /> Sửa</button>
                  {n.status === 'OFFLINE' && <button className="link danger-link" onClick={() => askRemove(n)}><Icon name="eye-off" /> Gỡ</button>}
                </div>
              </td>
            </tr>
          ))}
          {!nodes && <tr><td colSpan="6" className="muted">Đang tải…</td></tr>}
        </tbody>
      </table></div>
      {note && <p className={note.kind === 'ok' ? 'success' : 'error'} role="status"><Icon name={note.kind === 'ok' ? 'check' : 'x'} /> {note.text}</p>}

      <h3 style={{ marginTop: 'var(--space-6)' }}>Thêm bãi mới</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        <Icon name="info" /> Nếu hệ thống chạy với etcd (biến <span className="mono">ETCD_ENDPOINTS</span>), máy chủ bãi tự đăng ký khi khởi động
        và hiện trong bảng trên; khi đó chỉ cần bấm “Sửa” để đặt tên và vị trí.
      </p>
      <div className="card">
        <NodeForm key={formKey} initial={EMPTY} isNew submitLabel="Thêm bãi" onSubmit={add} others={list} />
      </div>

      {editing && (
        <div className="dialog-backdrop" onClick={() => setEditing(null)}>
          <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="edit-title" ref={editBox}
            onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}>
            <h3 id="edit-title">Sửa bãi {editing.parkingId}</h3>
            <NodeForm
              initial={{ parkingId: editing.parkingId, name: editing.name ?? '', apiUrl: editing.url ?? '', address: editing.address ?? '',
                lat: editing.lat == null ? '' : String(editing.lat), lng: editing.lng == null ? '' : String(editing.lng) }}
              submitLabel="Lưu thay đổi" onSubmit={save} onCancel={() => setEditing(null)}
              others={list.filter((n) => n.parkingId !== editing.parkingId)} />
          </div>
        </div>
      )}
      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </>
  );
}
