import { useCallback, useEffect, useState } from 'react';
import { api, message, useLive } from '../api.js';

const EMPTY = { parkingId: '', name: '', apiUrl: '', address: '' };

export default function Admin() {
  const [nodes, setNodes] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const r = await api('/api/admin/nodes');
    if (r.ok) setNodes(r.data);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  useLive(['NODE_STATUS'], load, 0);

  async function add(e) {
    e.preventDefault();
    const r = await api('/api/admin/nodes', { method: 'POST', body: form });
    setNote(r.ok ? `Đã thêm bãi ${r.data.parkingId}. Health check sẽ đưa bãi lên ONLINE nếu node chạy.` : message(r.data));
    if (r.ok) setForm(EMPTY);
    load();
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <h2>Giám sát các Parking Node</h2>
      <p className="muted">Health check mỗi 5 giây; đánh dấu OFFLINE sau 3 lần lỗi liên tiếp.</p>
      <div className="scroll"><table>
        <thead><tr><th>Bãi</th><th>Tên</th><th>Địa chỉ API</th><th>Trạng thái</th><th>Lỗi liên tiếp</th><th>Lần cuối thấy</th></tr></thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.parkingId}>
              <td>{n.parkingId}</td><td>{n.name}</td><td className="mono">{n.url}</td>
              <td><span className={`badge ${n.status}`}>{n.status}</span></td>
              <td>{n.fails}</td>
              <td>{n.lastSeen ? new Date(n.lastSeen).toLocaleTimeString('vi-VN') : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <h3>Thêm bãi mới</h3>
      <form className="card form" onSubmit={add}>
        <input placeholder="Mã bãi (vd D)" value={form.parkingId} onChange={set('parkingId')} required />
        <input placeholder="Tên bãi" value={form.name} onChange={set('name')} required />
        <input placeholder="API URL (vd http://parking-d:8004)" value={form.apiUrl} onChange={set('apiUrl')} required />
        <input placeholder="Địa chỉ" value={form.address} onChange={set('address')} />
        <button className="primary">Thêm</button>
      </form>
      {note && <p className="muted">{note}</p>}
    </>
  );
}
