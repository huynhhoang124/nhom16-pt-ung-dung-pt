import { useState } from 'react';
import { api, message, useBusy } from '../api.js';

const DEMO = [
  ['user1', 'Người dùng'], ['user2', 'Người dùng'],
  ['staff-a', 'Nhân viên bãi A'], ['staff-b', 'Nhân viên bãi B'], ['staff-c', 'Nhân viên bãi C'],
  ['admin', 'Quản trị'],
];

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ username: 'user1', password: '123456' });
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/api/auth/login', { method: 'POST', body: form });
      r.ok ? onLogin(r.data) : setError(message(r.data));
    });
  };

  return (
    <div className="login">
      <div className="login-intro">
        <span className="sign big" aria-hidden="true">P</span>
        <h1>Smart Parking</h1>
        <p>Tìm chỗ trống và đặt chỗ ở mọi bãi trong hệ thống bằng một tài khoản. Nhóm 16, môn Ứng dụng phân tán.</p>
      </div>
      <form className="login-form" onSubmit={submit}>
        <h2>Đăng nhập</h2>
        <label className="field">Tên đăng nhập
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="username" autoFocus required />
        </label>
        <label className="field">Mật khẩu
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
        <div className="demo">
          <p className="muted small">Tài khoản demo, mật khẩu 123456. Bấm để điền sẵn:</p>
          <ul>
            {DEMO.map(([u, label]) => (
              <li key={u}>
                <button type="button" className="link" onClick={() => { setForm({ username: u, password: '123456' }); setError(''); }}>{u}</button>
                <span className="muted small">{label}</span>
              </li>
            ))}
          </ul>
        </div>
      </form>
    </div>
  );
}
