import { useEffect, useState } from 'react';
import { api, message } from '../api.js';
import { TYPE_LABEL } from './Dashboard.jsx';
import { Icon, TYPE_ICON } from '../ui.jsx';

// [khoá, nhãn dễ hiểu, gợi ý, cho phép bỏ trống]
const FIELDS = [
  ['firstBlockMin', 'Thời gian giá mở đầu', 'phút', false],
  ['firstBlockFee', 'Giá mở đầu', 'đ', false],
  ['nextHourFee', 'Mỗi giờ tiếp theo', 'đ/giờ', false],
  ['overnightFee', 'Phụ thu qua đêm', 'đ', false],
  ['maxDayFee', 'Tối đa mỗi ngày', 'đ · để trống = không giới hạn', true],
];

// Bảng giá của một bãi (NV-03). canEdit: nhân viên bãi đó hoặc quản trị.
export default function Pricing({ parkingId, canEdit }) {
  const [saved, setSaved] = useState(null);   // bản đang có trên máy chủ
  const [rules, setRules] = useState(null);   // bản đang sửa
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/api/parkings/${parkingId}/pricing`).then((r) => { if (r.ok) { setSaved(r.data); setRules(r.data); } });
  }, [parkingId]);

  if (!rules) return null;
  const set = (i, k, v) => { setNote(null); setRules(rules.map((r, j) => (j === i ? { ...r, [k]: v === '' ? (k === 'maxDayFee' ? null : '') : Number(v) } : r))); };
  const invalid = (r, k, optional) => (r[k] === '' || r[k] == null ? !optional : !Number.isFinite(r[k]) || r[k] < 0);
  const errors = rules.some((r) => FIELDS.some(([k, , , opt]) => invalid(r, k, opt)) || (r.firstBlockMin !== '' && r.firstBlockMin < 1));
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);

  async function save(e) {
    e.preventDefault();
    if (!dirty || errors) return;
    setBusy(true);
    const r = await api(`/api/parkings/${parkingId}/pricing`, { method: 'PUT', body: rules });
    setBusy(false);
    setNote(r.ok ? { kind: 'ok', text: 'Đã lưu bảng giá. Giá mới áp cho các lượt tính phí từ bây giờ.' } : { kind: 'error', text: message(r.data) });
    if (r.ok) { setSaved(r.data); setRules(r.data); }
  }

  return (
    // noValidate: tự kiểm (errors) và báo lỗi rõ ràng; kiểm tra step/min của trình duyệt chặn gửi mà không nói gì.
    <form onSubmit={save} noValidate>
      <h3>Bảng giá (VND)</h3>
      <div className="scroll"><table>
        <thead><tr><th>Loại xe</th>{FIELDS.map(([k, label, hint]) => <th key={k} className={canEdit ? undefined : 'tnum'}>{label}<div className="th-hint">{hint}</div></th>)}</tr></thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={r.vehicleType}>
              <td><Icon name={TYPE_ICON[r.vehicleType]} /> {TYPE_LABEL[r.vehicleType]}</td>
              {FIELDS.map(([k, label, , opt]) => (
                <td key={k} className={canEdit ? undefined : 'tnum'}>
                  {canEdit
                    ? <input type="number" min={k === 'firstBlockMin' ? 1 : 0} step={k === 'firstBlockMin' ? 1 : 1000} className="num" value={r[k] ?? ''}
                        aria-label={`${label} – ${TYPE_LABEL[r.vehicleType]}`} placeholder={opt ? 'Không giới hạn' : undefined}
                        aria-invalid={invalid(r, k, opt) ? 'true' : undefined} onChange={(e) => set(i, k, e.target.value)} />
                    : (r[k] ?? '—').toLocaleString('vi-VN')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table></div>
      <p className="muted small">Hết thời gian giá mở đầu thì tính theo giờ, chưa đủ giờ làm tròn lên 1 giờ. Phụ thu qua đêm khi lượt gửi chạm khung 22:00–06:00.</p>
      {canEdit && (
        <div className="inline" style={{ alignItems: 'center' }}>
          <button className="primary" disabled={!dirty || errors || busy}>{busy && <Icon name="loader" spin />} Lưu bảng giá</button>
          {dirty && <button type="button" onClick={() => { setRules(saved); setNote(null); }} disabled={busy}>Hoàn tác</button>}
          {errors ? <span className="error"><Icon name="x" /> Giá phải là số không âm; thời gian mở đầu ít nhất 1 phút.</span>
            : dirty ? <span className="st warn"><Icon name="pencil" />Có thay đổi chưa lưu</span> : null}
          {note && <span className={note.kind === 'ok' ? 'success' : 'error'}><Icon name={note.kind === 'ok' ? 'check' : 'x'} /> {note.text}</span>}
        </div>
      )}
    </form>
  );
}
