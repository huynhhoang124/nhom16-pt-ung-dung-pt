import { useEffect, useState } from 'react';
import { session, socket } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ParkingDetail from './pages/ParkingDetail.jsx';
import MyReservations from './pages/MyReservations.jsx';
import Admin from './pages/Admin.jsx';

const ROLE_LABEL = { USER: 'Người dùng', STAFF: 'Nhân viên', ADMIN: 'Quản trị' };

export default function App() {
  const [user, setUser] = useState(() => session.get()?.user ?? null);
  const [view, setView] = useState({ page: 'dashboard' });
  const [live, setLive] = useState(socket.connected);

  useEffect(() => {
    const on = () => setLive(true);
    const off = () => setLive(false);
    socket.on('connect', on);
    socket.on('disconnect', off);
    return () => { socket.off('connect', on); socket.off('disconnect', off); };
  }, []);

  if (!user) return <Login onLogin={(s) => { session.set(s); setUser(s.user); }} />;

  const tabs = [
    ['dashboard', 'Tổng quan'],
    ...(user.role === 'USER' ? [['mine', 'Đặt chỗ của tôi']] : []),
    ...(user.role === 'STAFF' ? [['parking', `Bãi ${user.parkingId}`]] : []),
    ...(user.role === 'ADMIN' ? [['admin', 'Quản trị']] : []),
  ];
  const go = (page) => setView(page === 'parking' ? { page, parkingId: user.parkingId } : { page });

  return (
    <div className="app">
      <header className="bar">
        <strong className="brand">Smart Parking</strong>
        <nav>
          {tabs.map(([page, label]) => (
            <button key={page} className={view.page === page ? 'tab active' : 'tab'} onClick={() => go(page)}>{label}</button>
          ))}
        </nav>
        <span className="who">
          <span className={live ? 'dot on' : 'dot'} title={live ? 'Đang nhận realtime' : 'Mất kết nối realtime'} />
          {user.username} · {ROLE_LABEL[user.role]}{user.parkingId ? ` bãi ${user.parkingId}` : ''}
          <button className="link" onClick={() => { session.set(null); setUser(null); setView({ page: 'dashboard' }); }}>Đăng xuất</button>
        </span>
      </header>
      <main>
        {view.page === 'dashboard' && <Dashboard onOpen={(parkingId) => setView({ page: 'parking', parkingId })} />}
        {view.page === 'parking' && <ParkingDetail key={view.parkingId} parkingId={view.parkingId} user={user} onBack={() => go('dashboard')} />}
        {view.page === 'mine' && <MyReservations />}
        {view.page === 'admin' && <Admin />}
      </main>
    </div>
  );
}
