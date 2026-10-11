import { useState } from 'react';
import { api, message, useBusy, useData } from '../api.js';
import { href, NodeBadge, Pending, Stale } from '../ui.jsx';

const EMPTY = { parkingId: '', name: '', apiUrl: '', address: '' };
const load = () => api('/api/admin/nodes');

export default function Admin() {
  const { data: nodes, error, reload } = useData(load, { events: ['NODE_STATUS'], every: 5000 });
  const [form, setForm] = useState(EMPTY);
  const [note, setNote] = useState(null);
  const [busy, run] = useBusy();

  const add = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/api/admin/nodes', { method: 'POST', body: { ...form, address: form.address || undefined } });
      setNote(r.ok
        ? { kind: 'ok', text: `Đã thêm bãi ${r.data.parkingId}. Nếu node đang chạy, bãi sẽ chuyển sang Hoạt động sau lần kiểm tra kế tiếp.` }
        : { kind: 'error', text: message(r.data) });
      if (r.ok) setForm(EMPTY);
      reload();
    });
  };

  const set = (k, fix = (v) => v) => (e) => setForm({ ...form, [k]: fix(e.target.value) });

  return (
    <>
      <h1>Giám sát các bãi</h1>
      <p className="muted">Aggregator kiểm tra từng bãi mỗi 5 giây và đánh dấu mất kết nối sau 3 lần lỗi liên tiếp.</p>
      {nodes ? (
        <>
          <Stale error={error} />
          <div className="scroll"><table>
            <thead><tr><th>Bãi</th><th>Tên</th><th>Địa chỉ API</th><th>Trạng thái</th><th>Lỗi liên tiếp</th><th>Phản hồi gần nhất</th></tr></thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.parkingId}>
                  <td><a href={href.parking(n.parkingId)}><b>{n.parkingId}</b></a></td><td>{n.name}</td><td>{n.url}</td>
                  <td><NodeBadge status={n.status} /></td>
                  <td className={n.fails ? 'error' : ''}>{n.fails}</td>
                  <td>{n.lastSeen ? new Date(n.lastSeen).toLocaleTimeString('vi-VN') : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      ) : <Pending error={error} retry={reload} />}

      <h2>Thêm bãi mới</h2>
      <p className="muted">Bãi mới được đăng ký ngay mà không cần sửa code hay khởi động lại Aggregator.</p>
      <form className="add-node" onSubmit={add}>
        <label className="field">Mã bãi
          <input placeholder="D" value={form.parkingId} onChange={set('parkingId', (v) => v.toUpperCase())}
            required maxLength={8} pattern="[A-Z0-9]{1,8}" title="1–8 chữ cái in hoa hoặc chữ số" />
        </label>
        <label className="field">Tên bãi
          <input placeholder="Bãi D – Thanh Xuân" value={form.name} onChange={set('name')} required />
        </label>
        <label className="field">Địa chỉ API của node
          <input type="url" placeholder="http://parking-d:8004" value={form.apiUrl} onChange={set('apiUrl')}
            required pattern="https?://.+" title="Bắt đầu bằng http:// hoặc https://" />
        </label>
        <label className="field">Địa chỉ bãi (không bắt buộc)
          <input placeholder="Nguyễn Trãi, Thanh Xuân" value={form.address} onChange={set('address')} />
        </label>
        <button className="primary" disabled={busy}>{busy ? 'Đang thêm…' : 'Thêm bãi'}</button>
      </form>
      {note && <p className={note.kind === 'ok' ? 'success' : 'error'} aria-live="polite">{note.text}</p>}
    </>
  );
}
