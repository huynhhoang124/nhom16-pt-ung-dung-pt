import { useEffect, useState } from 'react';
import { session, socket } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ParkingDetail from './pages/ParkingDetail.jsx';
import MyReservations from './pages/MyReservations.jsx';
import Admin from './pages/Admin.jsx';
import EventLog from './pages/EventLog.jsx';
import { href } from './ui.jsx';

const ROLE_LABEL = { USER: 'Người dùng', STAFF: 'Nhân viên', ADMIN: 'Quản trị' };

// Định tuyến bằng hash (#/bai/A, #/dat-cho, #/quan-tri): F5 và nút Back của trình duyệt vẫn đúng trang, nginx không cần cấu hình thêm.
const PAGES = { bai: 'parking', 'dat-cho': 'mine', 'quan-tri': 'admin', 'nhat-ky': 'log' };
const readHash = () => {
  const [seg, id] = location.hash.replace(/^#\/?/, '').split('/');
  return { page: PAGES[seg] ?? 'dashboard', parkingId: id ? decodeURIComponent(id) : null };
};

function useRoute() {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const f = () => setRoute(readHash());
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return route;
}

export default function App() {
  const [user, setUser] = useState(() => session.get()?.user ?? null);
  const [live, setLive] = useState(socket.connected);
  const route = useRoute();

  useEffect(() => {
    const on = () => setLive(true);
    const off = () => setLive(false);
    socket.on('connect', on);
    socket.on('disconnect', off);
    return () => { socket.off('connect', on); socket.off('disconnect', off); };
  }, []);

  if (!user) return <Login onLogin={(s) => { session.set(s); setUser(s.user); }} />;

  // Trang không đúng vai trò (gõ tay URL) thì về Tổng quan.
  const allowed = { dashboard: true, parking: !!route.parkingId, mine: user.role === 'USER', admin: user.role === 'ADMIN', log: user.role !== 'USER' };
  const page = allowed[route.page] ? route.page : 'dashboard';

  const tabs = [
    ['dashboard', href.dashboard, 'Tổng quan'],
    ...(user.role === 'USER' ? [['mine', href.mine, 'Đặt chỗ của tôi']] : []),
    ...(user.role === 'STAFF' ? [['own', href.parking(user.parkingId), `Bãi ${user.parkingId} của tôi`]] : []),
    ...(user.role === 'ADMIN' ? [['admin', href.admin, 'Quản trị']] : []),
    ...(user.role !== 'USER' ? [['log', href.log, 'Nhật ký sự kiện']] : []),
  ];
  const active = page === 'parking' && route.parkingId === user.parkingId ? 'own' : page;

  return (
    <div className="app">
      <header className="bar">
        <a className="brand" href={href.dashboard}><span className="sign" aria-hidden="true">P</span>Smart Parking</a>
        <nav>
          {tabs.map(([key, to, label]) => (
            <a key={key} href={to} className="tab" aria-current={active === key ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
        <div className="who">
          <span className={live ? 'dot on' : 'dot'} title={live ? 'Đang nhận cập nhật trực tiếp' : 'Mất kết nối cập nhật trực tiếp'} />
          <span>
            <strong>{user.username}</strong>
            <span className="muted"> {ROLE_LABEL[user.role]}{user.parkingId ? ` bãi ${user.parkingId}` : ''}</span>
          </span>
          <button className="link" onClick={() => { session.set(null); setUser(null); location.hash = '#/'; }}>Đăng xuất</button>
        </div>
      </header>
      <main>
        {page === 'dashboard' && <Dashboard />}
        {page === 'parking' && <ParkingDetail key={route.parkingId} parkingId={route.parkingId} user={user} />}
        {page === 'mine' && <MyReservations />}
        {page === 'admin' && <Admin />}
        {page === 'log' && <EventLog />}
      </main>
    </div>
  );
}
