import { useState } from 'react';
import { api, message } from '../api.js';
import { Icon } from '../ui.jsx';

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

  const mismatch = form.confirm && form.newPassword !== form.confirm;
  const field = (k, label) => (
    <label className="field">{label}
      <input type="password" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        aria-invalid={k === 'confirm' && mismatch ? 'true' : undefined} required />
      {k === 'confirm' && mismatch && <span className="error">Mật khẩu nhập lại không khớp.</span>}
    </label>
  );

  return (
    <>
      <h2>Tài khoản {user.username}</h2>
      <form className="card stack" style={{ maxWidth: 440 }} onSubmit={submit}>
        {field('oldPassword', 'Mật khẩu hiện tại')}
        {field('newPassword', 'Mật khẩu mới (ít nhất 8 ký tự)')}
        {field('confirm', 'Nhập lại mật khẩu mới')}
        {note && <p className={note.kind === 'ok' ? 'success' : 'error'} style={{ margin: 0 }}><Icon name={note.kind === 'ok' ? 'check' : 'x'} /> {note.text}</p>}
        <button className="primary"><Icon name="lock" /> Đổi mật khẩu</button>
      </form>
    </>
  );
}
