import { useEffect, useState } from 'react';
import { api, message } from '../api.js';
import { TYPE_LABEL } from './Dashboard.jsx';

const FIELDS = [
  ['firstBlockMin', 'Block đầu (phút)'], ['firstBlockFee', 'Giá block đầu'], ['nextHourFee', 'Mỗi giờ tiếp'],
  ['overnightFee', 'Phụ thu qua đêm'], ['maxDayFee', 'Trần mỗi ngày'],
];

// Bảng giá của một bãi (NV-03). canEdit: nhân viên bãi đó hoặc quản trị.
export default function Pricing({ parkingId, canEdit }) {
  const [rules, setRules] = useState(null);
  const [note, setNote] = useState(null);

  useEffect(() => {
    api(`/api/parkings/${parkingId}/pricing`).then((r) => setRules(r.ok ? r.data : null));
  }, [parkingId]);

  if (!rules) return null;
  const set = (i, k, v) => setRules(rules.map((r, j) => (j === i ? { ...r, [k]: v === '' && k === 'maxDayFee' ? null : Number(v) } : r)));

  async function save(e) {
    e.preventDefault();
    const r = await api(`/api/parkings/${parkingId}/pricing`, { method: 'PUT', body: rules });
    setNote(r.ok ? { kind: 'ok', text: 'Đã lưu bảng giá.' } : { kind: 'error', text: message(r.data) });
    if (r.ok) setRules(r.data);
  }

  return (
    <form onSubmit={save}>
      <h3>Bảng giá (VND)</h3>
      <div className="scroll"><table>
        <thead><tr><th>Loại xe</th>{FIELDS.map(([k, label]) => <th key={k}>{label}</th>)}</tr></thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={r.vehicleType}>
              <td>{TYPE_LABEL[r.vehicleType]}</td>
              {FIELDS.map(([k]) => (
                <td key={k}>
                  {canEdit
                    ? <input type="number" min="0" step="1000" className="num" value={r[k] ?? ''} onChange={(e) => set(i, k, e.target.value)} />
                    : (r[k] ?? '—').toLocaleString('vi-VN')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table></div>
      <p className="muted small">Quá block đầu, chưa đủ giờ tính tròn 1 giờ. Qua đêm: phiên chạm khung 22:00–06:00.</p>
      {note && <p className={note.kind === 'ok' ? 'success' : 'error'}>{note.text}</p>}
      {canEdit && <button className="primary">Lưu bảng giá</button>}
    </form>
  );
}
