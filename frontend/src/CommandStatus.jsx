import { useEffect, useState } from 'react';
import { commandTracker } from './api.js';
import { Icon } from './ui.jsx';

// Lệnh gửi qua hàng đợi (đặt chỗ, huỷ, thanh toán) đang chờ hoặc vừa xong. Chỉ hiện mã ngắn để đối chiếu, không in cả UUID.
const VIEW = {
  PENDING: ['pending', 'loader', 'Đang xử lý yêu cầu…'],
  DONE: ['ok', 'circle-check', 'Yêu cầu đã hoàn tất'],
  EXPIRED: ['expired', 'hourglass', 'Yêu cầu đã hết hạn, vui lòng thử lại'],
  FAILED: ['bad', 'circle-x', 'Yêu cầu không thành công'],
};

export default function CommandStatus({ userId }) {
  const [rows, setRows] = useState([]);
  useEffect(() => commandTracker.subscribe(setRows), [userId]);
  if (!rows.length) return null;
  return (
    <div aria-live="polite" className="stack" style={{ gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
      {rows.map((r) => {
        const [cls, icon, text] = VIEW[r.status] ?? VIEW.FAILED;
        const title = r.status === 'PENDING' && r.uncertain ? 'Đang kiểm tra kết quả yêu cầu…' : text;
        return (
          <div key={r.commandId} className={`cmd ${cls}`}>
            <span className="ic"><Icon name={icon} spin={r.status === 'PENDING'} /></span>
            <span className="cmd-title">{title}</span>
            <span className="cmd-meta">Mã #{r.commandId.slice(0, 8)}</span>
            {r.status !== 'PENDING' && (
              <div className="cmd-actions"><button className="link" onClick={() => commandTracker.dismiss(r.commandId)}>Đóng</button></div>
            )}
          </div>
        );
      })}
    </div>
  );
}
