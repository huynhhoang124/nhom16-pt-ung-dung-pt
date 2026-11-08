import { useState } from 'react';
import { api, message } from '../api.js';
import { Icon } from '../ui.jsx';

const DEMO = [['user1', 'Người dùng'], ['staff-a', 'Nhân viên bãi A'], ['admin', 'Quản trị']];
// Nút tài khoản demo: hiện mặc định (đồ án), ẩn khi build với VITE_HIDE_DEMO=1. Không còn điền sẵn user1/123456.
const SHOW_DEMO = import.meta.env.VITE_HIDE_DEMO !== '1';

// Kiểm tra đăng ký ngay khi gõ (cùng luật với máy chủ).
function signupErrors(f) {
  const e = {};
  if (f.username && !/^[a-z0-9._]{4,32}$/.test(f.username)) e.username = 'Tên 4–32 ký tự: chữ thường không dấu, số, dấu chấm, gạch dưới.';
  if (f.password && (f.password.length < 8 || f.password.length > 72)) e.password = 'Mật khẩu cần 8–72 ký tự.';
  if (f.confirm && f.confirm !== f.password) e.confirm = 'Hai mật khẩu chưa khớp.';
  return e;
}

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState(false);   // true = form đăng ký
  const [show, setShow] = useState(false);       // hiện mật khẩu

  const errs = signup ? signupErrors(form) : {};
  const ready = form.username && form.password && (!signup || (form.confirm && !Object.keys(errs).length));

  async function submit(e) {
    e.preventDefault();
    if (!ready) return setError(signup ? 'Kiểm tra lại các ô đang báo đỏ.' : 'Nhập tên đăng nhập và mật khẩu.');
    setBusy(true);
    const r = await api(signup ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST', body: { username: form.username.trim(), password: form.password },
    });
    setBusy(false);
    r.ok ? onLogin(r.data) : setError(message(r.data));
  }

  const toggle = () => { setSignup(!signup); setError(''); setForm({ username: '', password: '', confirm: '' }); };
  // Đăng ký: tên tự chuyển thành chữ thường, bỏ khoảng trắng (máy chủ chỉ nhận chữ thường).
  const setUser = (v) => setForm({ ...form, username: signup ? v.toLowerCase().replace(/\s+/g, '') : v });

  const pw = (k, label, auto) => (
    <label>{label}
      <span className="pw">
        <input type={show ? 'text' : 'password'} value={form[k]} autoComplete={auto} aria-invalid={errs[k] ? 'true' : undefined}
          onChange={(e) => { setForm({ ...form, [k]: e.target.value }); setError(''); }} />
        {k === 'password' && (
          <button type="button" className="pw-toggle" onClick={() => setShow(!show)} aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} aria-pressed={show}>
            <Icon name={show ? 'eye-off' : 'search'} />{show ? 'Ẩn' : 'Hiện'}
          </button>
        )}
      </span>
      {errs[k] && <span className="error small">{errs[k]}</span>}
    </label>
  );

  return (
    <div className="login theme-brand">
      <form className="card" onSubmit={submit} noValidate>
        <div>
          <h1><span className="brand-mark" aria-hidden="true">P</span>Smart Parking</h1>
          <p className="muted">{signup ? 'Tạo tài khoản để đặt chỗ và nhận mã QR vào bãi.' : 'Hệ thống bãi đỗ xe liên kết nhiều bãi – Nhóm 16'}</p>
        </div>
        {error && (
          <div className="banner bad" role="alert"><Icon name="x" />
            <div><strong>{signup ? 'Không đăng ký được' : 'Không đăng nhập được'}</strong>{error}</div>
          </div>
        )}
        <label>Tên đăng nhập
          <input value={form.username} onChange={(e) => { setUser(e.target.value); setError(''); }} autoComplete="username"
            aria-invalid={errs.username ? 'true' : undefined} autoFocus autoCapitalize="none" spellCheck="false" />
          {errs.username ? <span className="error small">{errs.username}</span>
            : signup && <span className="muted small" style={{ fontWeight: 400 }}>4–32 ký tự: chữ thường không dấu, số, dấu chấm, gạch dưới.</span>}
        </label>
        {pw('password', 'Mật khẩu', signup ? 'new-password' : 'current-password')}
        {signup && pw('confirm', 'Nhập lại mật khẩu', 'new-password')}
        <button className="primary" disabled={busy}>
          {busy && <Icon name="loader" spin />}
          {busy ? 'Đang xử lý…' : signup ? 'Tạo tài khoản' : 'Đăng nhập'}
        </button>
        <button type="button" className="link" onClick={toggle}>
          {signup ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký'}
        </button>
        {!signup && SHOW_DEMO && <div className="small" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--space-3)' }}>
          <p className="muted">Tài khoản demo (mật khẩu 123456) – bấm để điền:</p>
          <div className="legend">
            {DEMO.map(([u, label]) => (
              <button type="button" key={u} className="chip" onClick={() => { setForm({ username: u, password: '123456', confirm: '' }); setError(''); }}>{u} ({label})</button>
            ))}
          </div>
        </div>}
      </form>
    </div>
  );
}
