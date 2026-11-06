import { useCallback, useEffect, useState } from 'react';
import { api, centralDown, commandRequest, knownNode, message, newKey, nodeApi, toast, useLive } from '../api.js';
import { Icon, Plate } from '../ui.jsx';

const time = (t) => (t ? new Date(t).toLocaleString('vi-VN') : '—');
const money = (v) => (v == null ? '—' : `${v.toLocaleString('vi-VN')} đ`);

// Lịch sử gửi xe. USER: phiên của mình. STAFF/ADMIN: tra biển số trên toàn hệ thống.
export default function History({ user, onOpenSlot }) {
  // Nhân viên mở được ô của bãi mình (quản trị: mọi bãi) để cho xe ra / xem chi tiết.
  const canOpen = (x) => !!onOpenSlot && !x.exitedAt && (user.role === 'ADMIN' || user.parkingId === x.parkingId);
  const mine = user.role === 'USER';
  const [plate, setPlate] = useState('');
  const [searched, setSearched] = useState('');   // biển số của lần tra gần nhất (để hiện tiêu đề kết quả)
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(null);   // { x: phiên, quote, key, unknown } – key giữ nguyên khi "Thử lại"

  const [directLot, setDirectLot] = useState(null);   // trung tâm sập -> đang tra thẳng ở máy chủ bãi này
  const load = useCallback(async (q) => {
    let r = await api(mine ? '/api/me/sessions' : `/api/sessions/search?plate=${encodeURIComponent(q)}`);
    // PT-05: nhân viên tra thẳng ở bãi mình khi trung tâm không trả lời (chỉ thấy phiên của bãi này).
    if (!mine && centralDown(r) && user.parkingId && knownNode(user.parkingId)) {
      const n = await nodeApi(user.parkingId, `/api/sessions?plate=${encodeURIComponent(q)}`);
      if (n.ok) r = { ok: true, data: { sessions: n.data.map((s) => ({ ...s, parkingId: user.parkingId })), unavailable: [] } };
      setDirectLot(n.ok ? user.parkingId : null);
    } else setDirectLot(null);
    setError(r.ok ? '' : message(r.data));
    setData(r.ok ? r.data : null);
  }, [mine, user.parkingId]);
  useEffect(() => { if (mine) load(); }, [mine, load]);
  useLive(['SLOT_UPDATED'], () => (mine ? load() : plate && data && load(plate)));

  // Trả trong bãi xong có 15 phút để ra; quá hạn thì có thể phát sinh thêm (máy chủ bãi tính, xem quote.due).
  const GRACE_MS = 15 * 60000;
  const payExpired = (x) => !!x.paidAt && !x.exitedAt && Date.now() - new Date(x.paidAt) > GRACE_MS;
  const canPay = (x) => mine && !x.exitedAt && (!x.paidAt || payExpired(x));
  const hhmm = (t) => new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const paidChip = (x) => (x.paidAt
    ? <span className="st ok"><Icon name="check" />{!x.exitedAt && !payExpired(x) ? `Đã trả · ra trước ${hhmm(new Date(x.paidAt).getTime() + GRACE_MS)}` : 'Đã trả'}</span>
    : x.fee ? <span className="st warn"><Icon name="clock" />Chưa trả</span> : null);
  const payLabel = (x) => (x.paidAt ? 'Kiểm tra phí phát sinh' : 'Thanh toán');

  async function startPay(x) {
    const q = await api(`/api/parkings/${x.parkingId}/sessions/${x.id}/quote`);
    if (!q.ok) return setError(message(q.data));
    setPaying({ x, quote: q.data, key: newKey(), unknown: false });
  }

  async function pay() {
    const { x } = paying;
    const r = await commandRequest(`/api/me/sessions/${x.parkingId}/${x.id}/pay`, { method: 'POST', headers: { 'idempotency-key': paying.key } },
      () => setError('Đang xử lý thanh toán…'));
    if (r.ok) { toast(`Đã thanh toán ${money(paying.quote.due ?? paying.quote.fee)} · phiên ${x.slotCode}. Mời ra cổng trong 15 phút.`, 'ok'); setPaying(null); setError(''); load(); }
    else if (r.status === 504 || r.status === 0) setPaying({ ...paying, unknown: true });   // chưa rõ: thử lại cùng key
    else { setPaying(null); setError(message(r.data)); load(); }
  }

  return (
    <>
      <h2>{mine ? 'Lịch sử gửi xe' : 'Tra cứu biển số'}</h2>
      {!mine && (
        <form className="inline" style={{ marginBottom: 'var(--space-4)' }} onSubmit={(e) => { e.preventDefault(); setSearched(plate); load(plate); }}>
          <input className="mono" placeholder="Cả biển hoặc một phần, vd 12345" aria-label="Biển số" value={plate} onChange={(e) => setPlate(e.target.value)} required autoFocus />
          <span className="muted small" style={{ alignSelf: 'center' }}>Nhập ít nhất 3 ký tự; tìm được cả khi chỉ nhớ một phần biển số.</span>
          <button className="primary"><Icon name="search" /> Tra cứu</button>
        </form>
      )}
      {error && <div className="banner bad"><Icon name="x" /><div>{error}</div></div>}
      {directLot && (
        <div className="banner"><Icon name="wifi-off" />
          <div><strong>Máy chủ trung tâm đang mất kết nối</strong>Kết quả dưới đây tra thẳng ở bãi {directLot}, chưa gồm các bãi khác.</div>
        </div>
      )}
      {data?.unavailable.length > 0 && (
        <div className="banner"><Icon name="alert" />
          <div><strong>Thiếu dữ liệu bãi {data.unavailable.join(', ')}</strong>Bãi đang mất kết nối nên kết quả có thể thiếu.</div>
        </div>
      )}
      {!mine && data && searched && (
        <div className="legend" style={{ alignItems: 'center', margin: 'var(--space-4) 0' }}>
          <span>Kết quả cho <b className="mono">“{searched.toUpperCase()}”</b></span>
          <span className="muted small">{data.sessions.length} phiên gửi{data.unavailable.length > 0 && ` · không tra được bãi ${data.unavailable.join(', ')}`}</span>
        </div>
      )}
      {paying && (
        <div className="dialog-backdrop" onClick={() => setPaying(null)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="pay-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="pay-title">Thanh toán phiên gửi xe</h3>
            <div className="legend" style={{ alignItems: 'center' }}><Plate value={paying.x.licensePlate} /><span className="mono">{paying.x.parkingId} · {paying.x.slotCode}</span></div>
            <ul className="small mono" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
              {paying.quote.breakdown.map((b) => <li key={b.label}>{b.label}: {money(b.amount)}</li>)}
            </ul>
            {paying.quote.paid > 0 && <p className="muted" style={{ margin: 0 }}>Tổng phí đến giờ {money(paying.quote.fee)} · đã trả {money(paying.quote.paid)}. Cần trả thêm:</p>}
            <div className="big" style={{ fontSize: 44 }}>{(paying.quote.due ?? paying.quote.fee ?? 0).toLocaleString('vi-VN')}<span className="muted"> đ</span></div>
            {(paying.quote.due ?? paying.quote.fee) > 0 && <p className="muted small" style={{ margin: 0 }}>Trả xong có 15 phút để ra cổng; ở lâu hơn có thể phát sinh thêm phí.</p>}
            {(paying.quote.due ?? paying.quote.fee) > 0 ? (
              paying.unknown && (
                <div className="cmd timeout" role="status">
                  <span className="ic"><Icon name="wifi-off" /></span>
                  <span className="cmd-title">Chưa rõ đã trả tiền chưa</span>
                  <span className="cmd-sub">{message({ error: 'TIMEOUT_UNKNOWN_RESULT' })}</span>
                </div>
              )
            ) : <p className="muted" style={{ margin: 0 }}>{paying.quote.paid > 0 ? 'Không phát sinh thêm phí, bạn có thể ra cổng.' : 'Gửi dưới 5 phút: miễn phí.'}</p>}
            <div className="dialog-actions">
              <button onClick={() => setPaying(null)}>Để sau</button>
              {(paying.quote.due ?? paying.quote.fee) > 0 && (
                <button className="primary" onClick={pay}>{paying.unknown ? <><Icon name="retry" /> Thử lại (cùng giao dịch)</> : <><Icon name="card" /> Thanh toán (giả lập)</>}</button>
              )}
            </div>
          </div>
        </div>
      )}
      {data && data.sessions.length > 0 && (
        // Màn hẹp: mỗi phiên là một thẻ, phí và nút Thanh toán luôn nằm trong tầm nhìn.
        <ul className="session-cards narrow-only">
          {data.sessions.map((x) => (
            <li key={`${x.parkingId}:${x.id}`} className="card session-card">
              <div className="session-top">
                <Plate value={x.licensePlate} />
                {x.exitedAt ? <span className="muted small">Đã ra</span> : <span className="st info"><Icon name="car" />Đang gửi</span>}
              </div>
              <dl>
                <dt>Bãi · ô</dt><dd>{x.parkingId} · <span className="mono">{x.slotCode}</span></dd>
                <dt>Vào</dt><dd className="mono small">{time(x.enteredAt)}</dd>
                {x.exitedAt && <><dt>Ra</dt><dd className="mono small">{time(x.exitedAt)}</dd></>}
                <dt>Phí</dt>
                <dd>
                  <b className="tnum-inline">{money(x.fee)}</b>{' '}
                  {paidChip(x)}
                </dd>
              </dl>
              {canPay(x) && <button className="primary block" onClick={() => startPay(x)}><Icon name="card" /> {payLabel(x)}</button>}
              {canOpen(x) && <button className="block" onClick={() => onOpenSlot(x.parkingId, x.slotCode)}><Icon name="pin" /> Xem ô {x.slotCode}</button>}
            </li>
          ))}
        </ul>
      )}
      {data && data.sessions.length > 0 && (
        <div className="scroll wide-only"><table>
          <thead><tr><th>Bãi</th><th>Slot</th><th>Biển số</th><th>Vào</th><th>Ra</th><th className="tnum">Phí</th><th>Đã trả</th><th /></tr></thead>
          <tbody>
            {data.sessions.map((x) => (
              <tr key={`${x.parkingId}:${x.id}`}>
                <td>{x.parkingId}</td><td className="mono">{x.slotCode}</td><td><Plate value={x.licensePlate} /></td>
                <td className="mono small">{time(x.enteredAt)}</td>
                <td>{x.exitedAt ? <span className="mono small">{time(x.exitedAt)}</span> : <span className="st info"><Icon name="car" />Đang gửi</span>}</td>
                <td className="tnum">{money(x.fee)}</td>
                <td>{paidChip(x) ?? <span className="muted">—</span>}</td>
                <td>
                  {canPay(x) && <button className="primary" onClick={() => startPay(x)}><Icon name="card" /> {payLabel(x)}</button>}
                  {canOpen(x) && <button onClick={() => onOpenSlot(x.parkingId, x.slotCode)}><Icon name="pin" /> Xem ô {x.slotCode}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {data && !data.sessions.length && (
        <div className="empty"><Icon name="search" /><strong>Không có phiên gửi nào</strong>
          {mine ? 'Bạn chưa gửi xe ở bãi nào.' : `Biển số ${searched} chưa gửi ở bãi nào đang kết nối.`}
        </div>
      )}
    </>
  );
}
