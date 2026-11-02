import { useState } from 'react';
import { api, message } from '../api.js';
import { Icon } from '../ui.jsx';

const DEMO = [['user1', 'Người dùng'], ['staff-a', 'Nhân viên bãi A'], ['admin', 'Quản trị']];

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ username: 'user1', password: '123456' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState(false);   // true = form đăng ký

  async function submit(e) {
    e.preventDefault();
    if (signup && form.password !== form.confirm) return setError('Hai mật khẩu không khớp.');
    setBusy(true);
    const r = await api(signup ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST', body: { username: form.username, password: form.password },
    });
    setBusy(false);
    r.ok ? onLogin(r.data) : setError(message(r.data));
  }

  const toggle = () => { setSignup(!signup); setError(''); setForm({ username: '', password: '', confirm: '' }); };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div>
          <h1><span className="brand-mark" aria-hidden="true">P</span>Smart Parking</h1>
          <p className="muted">Hệ thống bãi đỗ xe liên kết nhiều bãi – Nhóm 16</p>
        </div>
        {error && (
          <div className="banner bad" role="alert"><Icon name="x" />
            <div><strong>{signup ? 'Không đăng ký được' : 'Không đăng nhập được'}</strong>{error}</div>
          </div>
        )}
        <label>Tên đăng nhập
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} aria-invalid={error ? 'true' : undefined} autoFocus />
        </label>
        <label>Mật khẩu
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        {signup && (
          <label>Nhập lại mật khẩu
            <input type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </label>
        )}
        {signup && <p className="muted small">Tên 4–32 ký tự (chữ thường, số, dấu chấm, gạch dưới). Mật khẩu ít nhất 8 ký tự.</p>}
        <button className="primary" disabled={busy}>
          {busy && <Icon name="loader" spin />}
          {busy ? 'Đang xử lý…' : signup ? 'Đăng ký' : 'Đăng nhập'}
        </button>
        <button type="button" className="link" onClick={toggle}>
          {signup ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký'}
        </button>
        {!signup && <div className="small" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--space-3)' }}>
          <p className="muted">Tài khoản demo (mật khẩu 123456):</p>
          <div className="legend">
            {DEMO.map(([u, label]) => (
              <button type="button" key={u} className="chip" onClick={() => setForm({ username: u, password: '123456' })}>{u} ({label})</button>
            ))}
          </div>
        </div>}
      </form>
    </div>
  );
}
