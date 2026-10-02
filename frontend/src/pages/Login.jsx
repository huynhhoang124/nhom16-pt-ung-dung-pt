import { useState } from 'react';
import { api, message } from '../api.js';

const DEMO = [['user1', 'Người dùng'], ['staff-a', 'Nhân viên bãi A'], ['admin', 'Quản trị']];

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ username: 'user1', password: '123456' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const r = await api('/api/auth/login', { method: 'POST', body: form });
    setBusy(false);
    r.ok ? onLogin(r.data) : setError(message(r.data));
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Smart Parking</h1>
        <p className="muted">Hệ thống bãi đỗ xe liên kết nhiều bãi – Nhóm 16</p>
        <label>Tên đăng nhập
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoFocus />
        </label>
        <label>Mật khẩu
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
        <p className="muted small">
          Tài khoản demo (mật khẩu 123456):{' '}
          {DEMO.map(([u, label]) => (
            <button type="button" key={u} className="link" onClick={() => setForm({ username: u, password: '123456' })}>{u} ({label})</button>
          ))}
        </p>
      </form>
    </div>
  );
}
