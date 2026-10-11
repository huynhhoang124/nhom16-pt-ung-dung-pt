import { STATUS_LABEL, useEventLog } from '../api.js';
import { clock, href } from '../ui.jsx';

const TYPE_LABEL = {
  RESERVED: 'Đặt chỗ', CAR_ENTER: 'Xe vào', CAR_EXIT: 'Xe ra', MAINTENANCE_ON: 'Khoá bảo trì', MAINTENANCE_OFF: 'Mở khoá',
  CANCELLED: 'Huỷ đặt chỗ', EXPIRED: 'Hết hạn giữ chỗ', RECONCILE: 'Đối soát',
};

function what(e) {
  if (e.kind === 'SLOT_UPDATED') return TYPE_LABEL[e.type] ?? e.type;
  if (e.kind === 'NODE_STATUS') return e.status === 'ONLINE' ? 'Bãi hoạt động lại' : 'Bãi mất kết nối';
  return e.kind === 'connect' ? 'Đã kết nối realtime với Aggregator' : 'Mất kết nối realtime với Aggregator';
}

// Tô màu dòng: mất kết nối là cảnh báo, kết nối lại là tin tốt, đối soát tô riêng.
const tone = (e) =>
  e.kind === 'disconnect' || (e.kind === 'NODE_STATUS' && e.status !== 'ONLINE') ? 'warn'
    : e.kind === 'connect' || e.kind === 'NODE_STATUS' ? 'good'
      : e.type === 'RECONCILE' ? 'reconcile' : '';

export default function EventLog() {
  const log = useEventLog();
  return (
    <>
      <h1>Nhật ký sự kiện</h1>
      <p className="muted">
        Mỗi thay đổi slot đi theo đường: DB của bãi (outbox) → relay → RabbitMQ → Aggregator → WebSocket → trình duyệt.
        Aggregator đã bỏ tin trùng và tin đến muộn (version không lớn hơn bản đang giữ) nên chúng không có ở đây.
        Khi một bãi hoạt động lại, Aggregator đối soát với DB của bãi và các thay đổi bị lỡ hiện thành dòng "Đối soát".
      </p>
      <p className="muted small">Ghi từ lúc mở trang này, mới nhất ở trên, tối đa 200 dòng.</p>
      <div className="scroll"><table className="log">
        <thead><tr><th>Giờ</th><th>Bãi</th><th>Slot</th><th>Sự kiện</th><th>Trạng thái mới</th><th>Version</th></tr></thead>
        <tbody>
          {log.map((e) => (
            <tr key={e.id} className={tone(e)}>
              <td>{clock(e.at)}</td>
              <td>{e.parkingId ? <a href={href.parking(e.parkingId)}>{e.parkingId}</a> : ''}</td>
              <td><b>{e.slot}</b></td>
              <td>{what(e)}</td>
              <td>{STATUS_LABEL[e.status] ?? ''}</td>
              <td>{e.version ?? ''}</td>
            </tr>
          ))}
          {!log.length && <tr><td colSpan="6" className="muted">Chưa có sự kiện nào. Thử cho xe vào một slot, hoặc chạy <code>node scripts/barrier.mjs A A02 enter</code>.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
