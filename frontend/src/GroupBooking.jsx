import { useEffect, useState } from 'react';
import { api, message, newKey } from './api.js';

const STEP = { DONE: 'Đã giữ', FAILED: 'Lỗi', UNKNOWN: 'Chưa rõ', COMPENSATED: 'Đã trả lại', PENDING: 'Chờ' };
const row = () => ({ parkingId: 'A', slotCode: '', licensePlate: '' });

// PT-07: đặt cho đoàn xe ở nhiều bãi trong MỘT lần (Saga): được hết hoặc không giữ chỗ nào.
export default function GroupBooking({ onDone }) {
  const [parkings, setParkings] = useState([]);
  const [items, setItems] = useState([row(), { ...row(), parkingId: 'B' }]);
  const [key, setKey] = useState(newKey);
  const [saga, setSaga] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/parkings').then((r) => r.ok && setParkings(r.data)); }, []);

  const set = (i, k, v) => { setItems(items.map((x, j) => (j === i ? { ...x, [k]: k === 'slotCode' ? v.toUpperCase() : v } : x))); setKey(newKey()); };

  async function submit(e) {
    e.preventDefault();
    const r = await api('/api/group-reservations', { method: 'POST', headers: { 'idempotency-key': key }, body: { items } });
    setError(r.ok ? '' : message(r.data));
    if (r.ok) { setSaga(r.data); onDone?.(); if (r.data.status === 'COMPLETED') setKey(newKey()); }
  }

  return (
    <form className="card panel" onSubmit={submit}>
      <strong>Đặt cho nhiều xe, nhiều bãi (cùng lúc)</strong>
      <p className="muted small">Được giữ đủ tất cả mới thành công; một chỗ lỗi thì các chỗ đã giữ được tự trả lại.</p>
      {items.map((x, i) => (
        <div className="inline" key={i}>
          <select value={x.parkingId} onChange={(e) => set(i, 'parkingId', e.target.value)}>
            {parkings.map((p) => <option key={p.parkingId} value={p.parkingId}>{p.name}</option>)}
          </select>
          <input placeholder="Slot, vd A05" value={x.slotCode} onChange={(e) => set(i, 'slotCode', e.target.value)} required />
          <input placeholder="Biển số" value={x.licensePlate} onChange={(e) => set(i, 'licensePlate', e.target.value)} required />
        </div>
      ))}
      <div className="inline">
        {items.length < 5 && <button type="button" onClick={() => { setItems([...items, row()]); setKey(newKey()); }}>+ Thêm xe</button>}
        {items.length > 2 && <button type="button" onClick={() => { setItems(items.slice(0, -1)); setKey(newKey()); }}>− Bớt</button>}
        <button className="primary">Đặt tất cả</button>
      </div>
      {error && <p className="error">{error}</p>}
      {saga && (
        <p className={saga.status === 'COMPLETED' ? 'success' : 'error'}>
          {saga.status === 'COMPLETED' ? 'Đã giữ đủ chỗ.' : 'Không giữ được đủ chỗ, các chỗ đã giữ đã được trả lại.'}{' '}
          {saga.steps.map((s) => `${s.slotCode}: ${STEP[s.state] ?? s.state}${s.error ? ` (${message({ error: s.error })})` : ''}`).join(' · ')}
        </p>
      )}
    </form>
  );
}
