import { useCallback, useEffect, useState } from 'react';
import { api, message, useLive } from '../api.js';
import DeadLetters from '../DeadLetters.jsx';
import { clock, Icon, NodeBadge } from '../ui.jsx';

const EMPTY = { parkingId: '', name: '', apiUrl: '', address: '', lat: '', lng: '' };

export default function Admin() {
  const [nodes, setNodes] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [note, setNote] = useState(null);   // { kind: 'ok'|'error', text }

  const load = useCallback(async () => {
    const r = await api('/api/admin/nodes');
    if (r.ok) setNodes(r.data);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  useLive(['NODE_STATUS'], load, 0);

  async function add(e) {
    e.preventDefault();
    const r = await api('/api/admin/nodes', { method: 'POST', body: form });
    setNote(r.ok ? { kind: 'ok', text: `Đã thêm bãi ${r.data.parkingId}. Health check sẽ đưa bãi lên ONLINE nếu node chạy.` } : { kind: 'error', text: message(r.data) });
    if (r.ok) setForm(EMPTY);
    load();
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const down = nodes.filter((n) => n.status === 'OFFLINE');
  return (
    <>
      <DeadLetters />
      <div className="page-head">
        <div>
          <h2>Giám sát các Parking Node</h2>
          <p className="muted" style={{ margin: 0 }}>Health check mỗi 5 giây; đánh dấu OFFLINE sau 3 lần lỗi liên tiếp.</p>
        </div>
      </div>
      {down.length > 0 && (
        <div className="banner"><Icon name="alert" />
          <div>
            <strong>{down.map((n) => `Bãi ${n.parkingId} mất kết nối${n.lastSeen ? ` từ ${clock(n.lastSeen)}` : ''}`).join(' · ')}</strong>
            Người dùng thấy dữ liệu cũ của các bãi này và tạm không đặt được chỗ.
          </div>
        </div>
      )}
      <div className="scroll" style={{ marginTop: 'var(--space-4)' }}><table>
        <thead><tr><th>Bãi</th><th>Tên</th><th>Địa chỉ API</th><th>Trạng thái</th><th className="tnum">Lỗi liên tiếp</th><th>Lần cuối thấy</th></tr></thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.parkingId}>
              <td><b>{n.parkingId}</b></td><td>{n.name}</td><td className="mono">{n.url}</td>
              <td><NodeBadge status={n.status} /></td>
              <td className="tnum">{n.fails}</td>
              <td className="mono">{n.lastSeen ? clock(n.lastSeen) : '–'}</td>
            </tr>
          ))}
          {!nodes.length && <tr><td colSpan="6" className="muted">Đang tải…</td></tr>}
        </tbody>
      </table></div>

      <h3 style={{ marginTop: 'var(--space-6)' }}>Thêm bãi mới</h3>
      <form className="card form" onSubmit={add}>
        <input className="mono" placeholder="Mã bãi (vd D)" aria-label="Mã bãi" value={form.parkingId} onChange={set('parkingId')} required />
        <input placeholder="Tên bãi" aria-label="Tên bãi" value={form.name} onChange={set('name')} required />
        <input className="mono" placeholder="API URL (vd http://parking-d:8004)" aria-label="API URL" value={form.apiUrl} onChange={set('apiUrl')} required />
        <input placeholder="Địa chỉ" aria-label="Địa chỉ" value={form.address} onChange={set('address')} />
        <input className="mono" placeholder="Vĩ độ (vd 21.0285)" aria-label="Vĩ độ" value={form.lat} onChange={set('lat')} inputMode="decimal" />
        <input className="mono" placeholder="Kinh độ (vd 105.8542)" aria-label="Kinh độ" value={form.lng} onChange={set('lng')} inputMode="decimal" />
        <button className="primary"><Icon name="plus" /> Thêm</button>
      </form>
      {note && <p className={note.kind === 'ok' ? 'success' : 'error'}><Icon name={note.kind === 'ok' ? 'check' : 'x'} /> {note.text}</p>}
    </>
  );
}
