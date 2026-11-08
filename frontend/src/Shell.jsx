import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

const ROLE_LABEL = { USER: 'Người dùng', STAFF: 'Nhân viên', ADMIN: 'Quản trị' };
const roleLine = (u) => `${ROLE_LABEL[u.role] ?? u.role}${u.parkingId ? ` · bãi ${u.parkingId}` : ''}`;
const initials = (name) => String(name ?? '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?';

function Brand({ sub }) {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">P</span>
      <span className="brand-text">
        <span className="brand-name">Smart Parking</span>
        {sub && <span className="brand-sub">{sub}</span>}
      </span>
    </span>
  );
}

// Nút tài khoản + menu thả xuống (Tài khoản / Đăng xuất). Đóng khi bấm ra ngoài hoặc Esc; mở bằng bàn phím được.
function AccountMenu({ user, onAccount, onLogout }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && (setOpen(false), box.current?.querySelector('.acct-btn')?.focus());
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    box.current?.querySelector('.acct-menu button')?.focus();
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pick = (fn) => () => { setOpen(false); fn(); };
  return (
    <div className="acct" ref={box}>
      <button type="button" className={open ? 'acct-btn open' : 'acct-btn'} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden="true">{initials(user.username)}</span>
        <span className="acct-text">
          <span className="acct-name">{user.username}</span>
          <span className="acct-role">{roleLine(user)}</span>
        </span>
        <span className="caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="acct-menu" role="menu">
          <div className="acct-head">
            <span className="avatar lg" aria-hidden="true">{initials(user.username)}</span>
            <span><b>{user.username}</b><span className="muted small">{roleLine(user)}</span></span>
          </div>
          <button type="button" role="menuitem" onClick={pick(onAccount)}><Icon name="user" /> Tài khoản &amp; mật khẩu</button>
          <button type="button" role="menuitem" className="acct-out" onClick={pick(onLogout)}><Icon name="logout" /> Đăng xuất</button>
        </div>
      )}
    </div>
  );
}

export function SiteHeader({ user, tabs, isActive, onGo, live, onAccount, onLogout }) {
  return (
    <header className="bar">
      <div className="bar-in">
        <button type="button" className="brand-btn" onClick={() => onGo(tabs[0][0])} aria-label="Smart Parking – về trang đầu">
          <Brand sub={user.role === 'USER' ? 'Bãi đỗ xe thông minh' : `Khu vực ${ROLE_LABEL[user.role].toLowerCase()}`} />
        </button>
        <nav aria-label="Điều hướng chính">
          {tabs.map(([page, label]) => (
            <button key={page} className={isActive(page) ? 'tab active' : 'tab'} aria-current={isActive(page) ? 'page' : undefined} onClick={() => onGo(page)}>{label}</button>
          ))}
        </nav>
        <div className="bar-right">
          <span className={live ? 'live' : 'live off'} role="status" title={live ? 'Đang nhận cập nhật trực tiếp' : 'Mất kết nối cập nhật trực tiếp – dữ liệu có thể chậm'}>
            <span className="dot" aria-hidden="true" />
            <span className="live-text">{live ? 'Trực tuyến' : 'Mất kết nối'}</span>
          </span>
          <AccountMenu user={user} onAccount={onAccount} onLogout={onLogout} />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ user, tabs, onGo }) {
  const about = {
    USER: 'Tìm chỗ trống theo thời gian thực ở nhiều bãi, đặt trước và vào cổng bằng mã QR.',
    STAFF: 'Cho xe vào/ra, thu phí, quản lý ô và cổng của bãi bạn phụ trách — vẫn làm việc được khi trung tâm gián đoạn.',
    ADMIN: 'Giám sát các bãi, thêm bãi mới, phát lệnh quản trị và theo dõi thống kê toàn hệ thống.',
  }[user.role];
  return (
    <footer className="site-foot">
      <div className="site-foot-in">
        <div className="foot-col foot-about">
          <Brand />
          <p>{about}</p>
        </div>
        <nav className="foot-col" aria-label="Đi nhanh">
          <h4>Đi nhanh</h4>
          {tabs.map(([page, label]) => <button key={page} type="button" className="foot-link" onClick={() => onGo(page)}>{label}</button>)}
          <button type="button" className="foot-link" onClick={() => onGo('account')}>Tài khoản</button>
        </nav>
        <div className="foot-col">
          <h4>Về dự án</h4>
          <p>Bài tập lớn học phần Hệ thống / Ứng dụng phân tán</p>
          <p>Học viện Công nghệ Bưu chính Viễn thông (PTIT)</p>
          <p>Thực hiện: Nhóm 16</p>
        </div>
      </div>
      <div className="foot-bottom">
        <div className="foot-bottom-in">
          <span>© {new Date().getFullYear()} Smart Parking · Nhóm 16 – PTIT</span>
          <button type="button" className="foot-link" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>Lên đầu trang ↑</button>
        </div>
      </div>
    </footer>
  );
}
