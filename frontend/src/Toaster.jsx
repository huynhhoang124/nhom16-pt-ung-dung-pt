import { useEffect, useState } from 'react';
import { Icon } from './ui.jsx';

const KIND_ICON = { ok: 'check', error: 'x', info: 'info' };

// Hiện các toast từ toast() trong api.js, mỗi cái tự tắt sau 5 giây.
export default function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const on = (e) => {
      const id = Math.random();
      setItems((xs) => [...xs.slice(-3), { id, ...e.detail }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 5000);
    };
    window.addEventListener('toast', on);
    return () => window.removeEventListener('toast', on);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="ti"><Icon name={KIND_ICON[t.kind] ?? 'info'} /></span>
          <div>{t.text}</div>
        </div>
      ))}
    </div>
  );
}
