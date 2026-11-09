import { useCallback, useEffect, useState } from 'react';
import { api, commandRequest, message, useLive } from '../api.js';
import QrCode from '../QrCode.jsx';
import GroupBooking from '../GroupBooking.jsx';
import { ConfirmDialog, Icon, Plate, ResStatus } from '../ui.jsx';

const p2 = (n) => String(n).padStart(2, '0');
const hm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
// "hôm nay 10:00" / "mai 10:00" / "Thứ Bảy 07/11 10:00" — dễ đọc hơn "10:00:00 5/11/2026".
function when(t) {
  const d = new Date(t);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400000);
  if (diff === 0) return `hôm nay ${hm(d)}`;
  if (diff === 1) return `mai ${hm(d)}`;
  const thu = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'][d.getDay()];
  return `${thu} ${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${hm(d)}`;
}
const left = (t, now) => Math.ceil((new Date(t) - now) / 60000);
const mapsLink = (lot) => (lot?.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${lot.lat},${lot.lng}` : null);

export default function MyReservations({ onGo }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [lots, setLots] = useState({});          // mã bãi -> { name, address, lat, lng }
  const [note, setNote] = useState(null);         // { kind: 'ok'|'error', text }
  const [ask, setAsk] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const r = await api('/api/me/reservations');
    if (r.ok) { setData(r.data); setError(''); } else setError(message(r.data));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api('/api/parkings').then((r) => r.ok && setLots(Object.fromEntries(r.data.map((p) => [p.parkingId, p])))); }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);   // đếm ngược tự chạy
  useLive(['SLOT_UPDATED', 'NODE_STATUS'], load);

  async function cancel(r) {
    const res = await commandRequest(`/api/parkings/${r.parkingId}/reservations/${r.id}`, { method: 'DELETE' },
      () => setNote({ kind: 'ok', text: 'Đang xử lý yêu cầu huỷ…' }));
    setNote(res.ok ? { kind: 'ok', text: `Đã huỷ vé ô ${r.slotCode}.` } : { kind: 'error', text: message(res.data) });
    load();
  }
  const askCancel = (r) => setAsk({
    title: `Huỷ vé ô ${r.slotCode}?`,
    body: <>Vé của <Plate value={r.licensePlate} /> ({when(r.startTime)}) sẽ bị huỷ, chỗ được trả lại cho người khác. Không hoàn tác được.</>,
    label: 'Huỷ vé', danger: true, run: () => cancel(r),
  });

  if (!data) return (
    <>
      <h2>Đặt chỗ của tôi</h2>
      {error
        ? <div className="empty" style={{ borderColor: 'var(--bad)' }}><Icon name="alert" /><strong>Không tải được vé của bạn</strong>{error}<button onClick={load}><Icon name="retry" /> Thử lại</button></div>
        : <span className="skeleton" style={{ height: 220 }} />}
    </>
  );

  // Nhóm vé: đang trong bãi (cần QR để ra) · đang giữ chỗ (đến ngay) · sắp tới (đặt trước) · lịch sử.
  const inside = data.reservations.filter((r) => r.status === 'USED');
  const holding = data.reservations.filter((r) => r.status === 'ACTIVE' && new Date(r.startTime) - now <= 15 * 60000);
  const upcoming = data.reservations.filter((r) => r.status === 'ACTIVE' && new Date(r.startTime) - now > 15 * 60000)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const past = data.reservations.filter((r) => !['ACTIVE', 'USED'].includes(r.status));

  const lotLine = (r) => {
    const lot = lots[r.parkingId];
    return (
      <div className="ticket-lot">
        <Icon name="pin" />
        <span><b>{lot?.name ?? `Bãi ${r.parkingId}`}</b>{lot?.address && <span className="muted small"> · {lot.address}</span>}</span>
        {mapsLink(lot) && <a href={mapsLink(lot)} target="_blank" rel="noopener noreferrer" className="small">Chỉ đường</a>}
      </div>
    );
  };

  const ticket = (r, kind) => {
    const mins = left(r.expireTime, now);
    const expiring = kind === 'holding' && mins > 0 && mins <= 10;
    return (
      <div key={r.id} className={`card qr-card${expiring ? ' expiring' : ''}${kind === 'upcoming' ? ' upcoming' : ''}`}>
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <div className="legend" style={{ alignItems: 'center' }}>
            {kind === 'upcoming' ? <span className="st info"><Icon name="calendar" />Sắp tới · {when(r.startTime)}</span> : <ResStatus status={r.status} />}
          </div>
          {lotLine(r)}
          <div className="legend" style={{ alignItems: 'center', gap: 'var(--space-3)' }}><span className="ticket-slot">{r.slotCode}</span><Plate value={r.licensePlate} /></div>
          <dl>
            <dt>Khung giờ</dt><dd>{when(r.startTime)}{r.endTime && ` – ${hm(r.endTime)}`}</dd>
            {kind !== 'inside' && <><dt>Đến trước</dt><dd>{when(r.expireTime)}{kind === 'holding' && mins > 0 && <span className="muted"> · còn {mins} phút</span>}</dd></>}
          </dl>
          {expiring && (
            <div className="banner"><Icon name="alert" />
              <div><strong>Sắp hết giờ giữ chỗ – còn {mins} phút</strong>Sau {hm(r.expireTime)} chỗ tự trả lại nếu xe chưa vào bãi.</div>
            </div>
          )}
          {kind === 'inside' && (
            <div className="banner info"><Icon name="info" />
              <div><strong>Khi ra về</strong>Thanh toán phí ở mục “Lịch sử gửi xe” rồi ra cổng trong 15 phút, quét mã QR này ở cổng ra. Chưa trả thì nhân viên cổng thu tiền mặt.
                {onGo && <div style={{ marginTop: 'var(--space-2)' }}><button className="primary" onClick={() => onGo('history')}><Icon name="card" /> Xem phí &amp; thanh toán</button></div>}
              </div>
            </div>
          )}
          {r.status === 'ACTIVE' && <div><button className="danger" onClick={() => askCancel(r)}><Icon name="x" /> Huỷ vé</button></div>}
        </div>
        {r.qrToken && kind !== 'upcoming' && <div className="qr-wrap"><QrCode value={r.qrToken} /><span className="muted small">{kind === 'inside' ? 'QR ra cổng' : 'QR vào cổng'} · chạm để phóng to</span></div>}
        {r.qrToken && kind === 'upcoming' && <div className="qr-wrap"><span className="muted small">Mã QR vào cổng sẽ hiện ở đây trước giờ đến.</span></div>}
      </div>
    );
  };

  const section = (title, list, kind) => list.length > 0 && (
    <>
      <span className="kicker">{title} ({list.length})</span>
      {list.map((r) => ticket(r, kind))}
    </>
  );

  return (
    <>
      <h2>Đặt chỗ của tôi</h2>
      {data.unavailable.length > 0 && (
        <div className="banner"><Icon name="alert" />
          <div><strong>Thiếu dữ liệu bãi {data.unavailable.join(', ')}</strong>Bãi đang mất kết nối nên danh sách dưới đây có thể thiếu.</div>
        </div>
      )}
      {note && <p className={note.kind === 'ok' ? 'success' : 'error'} role="status"><Icon name={note.kind === 'ok' ? 'check' : 'x'} /> {note.text}</p>}
      <div className="stack" style={{ marginTop: 'var(--space-4)', maxWidth: 760 }}>
        {section('Đang trong bãi · dùng QR để ra', inside, 'inside')}
        {section('Đang giữ chỗ · quét QR ở cổng vào', holding, 'holding')}
        {section('Sắp tới', upcoming, 'upcoming')}
        {!inside.length && !holding.length && !upcoming.length && (
          <div className="empty"><Icon name="qr" /><strong>Bạn chưa có vé nào</strong>Chọn bãi ở mục Tổng quan để đặt chỗ.
            {onGo && <button className="primary" onClick={() => onGo('dashboard')}><Icon name="pin" /> Tìm bãi</button>}
          </div>
        )}
        {past.length > 0 && (
          <details className="history-block">
            <summary>Vé đã dùng / đã huỷ ({past.length})</summary>
            <div className="scroll" style={{ marginTop: 'var(--space-2)' }}><table>
              <thead><tr><th>Bãi</th><th>Ô</th><th>Biển số</th><th>Khung giờ</th><th>Trạng thái</th></tr></thead>
              <tbody>
                {past.map((r) => (
                  <tr key={r.id}>
                    <td>{lots[r.parkingId]?.name ?? r.parkingId}</td><td className="mono">{r.slotCode}</td><td><Plate value={r.licensePlate} /></td>
                    <td className="small">{when(r.startTime)}{r.endTime && ` – ${hm(r.endTime)}`}</td><td><ResStatus status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </details>
        )}
        <details className="history-block">
          <summary>Đặt cho nhiều xe cùng lúc (đoàn xe, nhiều bãi)</summary>
          <div style={{ marginTop: 'var(--space-3)' }}><GroupBooking onDone={load} /></div>
        </details>
      </div>
      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </>
  );
}
