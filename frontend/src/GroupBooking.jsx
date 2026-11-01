import { useEffect, useState } from 'react';
import { api, message, newKey } from './api.js';
import { Icon, Plate } from './ui.jsx';

// Trạng thái từng bước của saga: [nhãn, class của dòng, class của chip, biểu tượng]
const STEP = {
  DONE: ['Đã giữ', 'done', 'ok', 'check'],
  FAILED: ['Lỗi', 'failed', 'bad', 'x'],
  UNKNOWN: ['Chưa rõ', 'running', 'warn', 'hourglass'],
  COMPENSATED: ['Đã trả lại', 'undoing', 'warn', 'undo'],
  PENDING: ['Chờ', 'running', 'info', 'clock'],
};
const row = () => ({ parkingId: 'A', slotCode: '', licensePlate: '' });

// PT-07: đặt cho đoàn xe ở nhiều bãi trong MỘT lần (Saga): được hết hoặc không giữ chỗ nào.
export default function GroupBooking({ onDone }) {
  const [parkings, setParkings] = useState([]);
  const [items, setItems] = useState([row(), { ...row(), parkingId: 'B' }]);
  const [key, setKey] = useState(newKey);
  const [saga, setSaga] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/parkings').then((r) => r.ok && setParkings(r.data)); }, []);

  const set = (i, k, v) => { setItems(items.map((x, j) => (j === i ? { ...x, [k]: k === 'slotCode' ? v.toUpperCase() : v } : x))); setKey(newKey()); };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const r = await api('/api/group-reservations', { method: 'POST', headers: { 'idempotency-key': key }, body: { items } });
    setBusy(false);
    setError(r.ok ? '' : message(r.data));
    if (r.ok) { setSaga(r.data); onDone?.(); if (r.data.status === 'COMPLETED') setKey(newKey()); }
  }

  return (
    <form className="card stack" style={{ gap: 'var(--space-3)' }} onSubmit={submit}>
      <div>
        <h3 style={{ marginBottom: 'var(--space-1)' }}>Đặt cho nhiều xe, nhiều bãi (cùng lúc)</h3>
        <p className="muted small" style={{ margin: 0 }}>Được giữ đủ tất cả mới thành công; một chỗ lỗi thì các chỗ đã giữ được tự trả lại.</p>
      </div>
      {items.map((x, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 'var(--space-2)' }}>
          <select value={x.parkingId} onChange={(e) => set(i, 'parkingId', e.target.value)} aria-label={`Bãi của xe ${i + 1}`}>
            {parkings.map((p) => <option key={p.parkingId} value={p.parkingId}>{p.name}</option>)}
          </select>
          <input className="mono" placeholder="Slot, vd A05" value={x.slotCode} onChange={(e) => set(i, 'slotCode', e.target.value)} aria-label={`Slot của xe ${i + 1}`} required />
          <input className="mono" placeholder="Biển số" value={x.licensePlate} onChange={(e) => set(i, 'licensePlate', e.target.value)} aria-label={`Biển số xe ${i + 1}`} required />
        </div>
      ))}
      <div className="inline" style={{ marginTop: 0 }}>
        {items.length < 5 && <button type="button" onClick={() => { setItems([...items, row()]); setKey(newKey()); }}><Icon name="plus" /> Thêm xe</button>}
        {items.length > 2 && <button type="button" onClick={() => { setItems(items.slice(0, -1)); setKey(newKey()); }}>− Bớt</button>}
        <button className="primary" disabled={busy}>{busy && <Icon name="loader" spin />} Đặt tất cả</button>
      </div>
      {error && <div className="banner bad"><Icon name="x" /><div>{error}</div></div>}
      {saga && saga.status !== 'COMPLETED' && (
        <div className="banner bad"><Icon name="x" />
          <div><strong>Không giữ được đủ chỗ</strong>Các chỗ đã giữ đã được trả lại.</div>
        </div>
      )}
      {saga && saga.status === 'COMPLETED' && <p className="success" style={{ margin: 0 }}><Icon name="circle-check" /> Đã giữ đủ chỗ.</p>}
      {saga && (
        <ol className="steps">
          {saga.steps.map((s, i) => {
            const [label, cls, chip, icon] = STEP[s.state] ?? [s.state, 'running', 'info', 'info'];
            return (
              <li key={i} className={cls}>
                <span className="step-n">{i + 1}</span>
                <span className="small">
                  {s.parkingId && `Bãi ${s.parkingId} · `}<span className="mono">{s.slotCode}</span>{s.licensePlate && <> · <Plate value={s.licensePlate} /></>}
                  {s.error && <span className="error"> · {message({ error: s.error })}</span>}
                </span>
                <span className={`st ${chip}`}><Icon name={icon} />{label}</span>
              </li>
            );
          })}
        </ol>
      )}
    </form>
  );
}
