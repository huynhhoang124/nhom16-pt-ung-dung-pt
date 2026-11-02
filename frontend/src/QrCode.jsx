import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';

// Mã QR của đặt chỗ (NV-05). Bấm để phóng to khi đưa máy quét ở cổng.
export default function QrCode({ value }) {
  const [big, setBig] = useState(false);
  const src = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(value);
    q.make();
    return q.createDataURL(8, 2);
  }, [value]);
  return <img src={src} alt="Mã QR vào bãi" className="qr" style={big ? { width: 280, height: 280 } : undefined}
    onClick={() => setBig(!big)} title="Bấm để phóng to / thu nhỏ" />;
}
