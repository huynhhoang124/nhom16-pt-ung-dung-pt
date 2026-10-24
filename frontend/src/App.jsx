import { useEffect, useState } from 'react';
import { session, socket, toast } from './api.js';
import Toaster from './Toaster.jsx';
import { Icon } from './ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ParkingDetail from './pages/ParkingDetail.jsx';
import MyReservations from './pages/MyReservations.jsx';
import Admin from './pages/Admin.jsx';
import History from './pages/History.jsx';
import Account from './pages/Account.jsx';
import Stats from './pages/Stats.jsx';
import Gate from './pages/Gate.jsx';

const ROLE_LABEL = { USER: 'Người dùng', STAFF: 'Nhân viên', ADMIN: 'Quản trị' };

export default function App() {
  const [user, setUser] = useState(() => session.get()?.user ?? null);
  const [view, setView] = useState({ page: 'dashboard' });
  const [live, setLive] = useState(socket.connected);

  useEffect(() => {
    const on = () => setLive(true);
    const off = () => setLive(false);
    const node = (e) => toast(
      e.status === 'ONLINE' ? `Bãi ${e.parkingId} đã hoạt động lại.`
        : e.status === 'DEGRADED' ? `Bãi ${e.parkingId} kết nối một phần (mất lease etcd).`
        : `Bãi ${e.parkingId} mất kết nối.`,
      e.status === 'ONLINE' ? 'ok' : e.status === 'DEGRADED' ? 'warn' : 'error'
    );
    socket.on('connect', on);
    socket.on('disconnect', off);
    socket.on('NODE_STATUS', node);
    const notify = (n) => toast(n.text, n.kind);   // NV-08
    socket.on('NOTIFICATION', notify);
    setLive(socket.connected);   // socket có thể đã nối xong trước khi gắn listener
    return () => { socket.off('connect', on); socket.off('disconnect', off); socket.off('NODE_STATUS', node); socket.off('NOTIFICATION', notify); };
  }, []);

  // đổi người dùng -> nối lại socket để gửi token mới (vào đúng phòng thông báo)
  const relogin = () => { socket.disconnect(); socket.connect(); };
  if (!user) return <><Login onLogin={(s) => { session.set(s); setUser(s.user); relogin(); }} /><Toaster /></>;

  const tabs = [
    ['dashboard', 'Tổng quan'],
    ...(user.role === 'USER' ? [['mine', 'Đặt chỗ của tôi'], ['history', 'Lịch sử gửi xe']] : [['history', 'Tra biển số']]),
    ...(user.role === 'STAFF' ? [['parking', `Bãi ${user.parkingId}`], ['gate', 'Cổng']] : []),
    ...(user.role !== 'USER' ? [['stats', 'Thống kê']] : []),
    ...(user.role === 'ADMIN' ? [['admin', 'Quản trị']] : []),
  ];
  const go = (page) => setView(page === 'parking' ? { page, parkingId: user.parkingId } : { page });
  const logout = () => { session.set(null); setUser(null); relogin(); setView({ page: 'dashboard' }); };

  return (
    <div className="app">
      <header className="bar">
        <strong className="brand"><span className="brand-mark" aria-hidden="true">P</span> Smart Parking</strong>
        <nav>
          {tabs.map(([page, label]) => (
            <button key={page} className={view.page === page ? 'tab active' : 'tab'} onClick={() => go(page)}>{label}</button>
          ))}
        </nav>
        <span className="who">
          <span className={live ? 'rt' : 'rt off'} title={live ? 'Đang nhận realtime' : 'Mất kết nối realtime'}>
            <span className={live ? 'dot on' : 'dot'} />
            <span className="hide-sm">{live ? 'Đang nhận realtime' : 'Mất kết nối realtime'}</span>
          </span>
          <span>{user.username} <span className="role hide-sm">· {ROLE_LABEL[user.role]}{user.parkingId ? ` bãi ${user.parkingId}` : ''}</span></span>
          <button className="link hide-sm" onClick={() => setView({ page: 'account' })}>Tài khoản</button>
          <button className="link hide-sm" onClick={logout}>Đăng xuất</button>
          <button className="show-sm" title="Tài khoản" aria-label="Tài khoản" onClick={() => setView({ page: 'account' })}><Icon name="user" /></button>
          <button className="show-sm" title="Đăng xuất" aria-label="Đăng xuất" onClick={logout}><Icon name="logout" /></button>
        </span>
      </header>
      <main className={user.role === 'USER' ? undefined : 'dense'}>
        {view.page === 'dashboard' && <Dashboard onOpen={(parkingId) => setView({ page: 'parking', parkingId })} />}
        {view.page === 'parking' && <ParkingDetail key={view.parkingId} parkingId={view.parkingId} user={user} onBack={() => go('dashboard')} />}
        {view.page === 'mine' && <MyReservations />}
        {view.page === 'admin' && <Admin />}
        {view.page === 'account' && <Account user={user} />}
        {view.page === 'stats' && <Stats />}
        {view.page === 'gate' && <Gate parkingId={user.parkingId} />}
        {view.page === 'history' && <History key={user.role} user={user} />}
      </main>
      <Toaster />
    </div>
  );
}
