import { useState } from 'react';
import { api, message } from '../api.js';

export default function Account({ user }) {
  const [form, setForm] = useState({ oldPassword: '', newPassword: '', confirm: '' });
  const [note, setNote] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) return setNote({ kind: 'error', text: 'Hai mật khẩu mới không khớp.' });
    const r = await api('/api/me/password', { method: 'PUT', body: { oldPassword: form.oldPassword, newPassword: form.newPassword } });
    setNote(r.ok ? { kind: 'ok', text: 'Đã đổi mật khẩu.' } : { kind: 'error', text: message(r.data) });
    if (r.ok) setForm({ oldPassword: '', newPassword: '', confirm: '' });
  }

  const field = (k, label) => (
    <label>{label}
      <input type="password" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} required />
    </label>
  );

  return (
    <>
      <h2>Tài khoản {user.username}</h2>
      <form className="card panel" onSubmit={submit}>
        {field('oldPassword', 'Mật khẩu hiện tại')}
        {field('newPassword', 'Mật khẩu mới (ít nhất 8 ký tự)')}
        {field('confirm', 'Nhập lại mật khẩu mới')}
        {note && <p className={note.kind === 'ok' ? 'success' : 'error'}>{note.text}</p>}
        <button className="primary">Đổi mật khẩu</button>
      </form>
    </>
  );
}
