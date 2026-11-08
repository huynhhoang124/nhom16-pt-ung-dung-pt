import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';

// Mã QR của đặt chỗ (NV-05). Chạm để mở chế độ "đưa vào máy quét": mã to hết màn hình, viền trắng rộng,
// nền xung quanh tối cho đỡ loá, giữ màn hình không tắt.
// Mức sửa lỗi 'L' (thay vì 'M'): mã 134 ký tự còn 45x45 ô thay vì 49x49 -> ô to hơn, webcam độ phân giải
// thấp đọc dễ hơn. Màn hình điện thoại không bị bẩn/rách như giấy in nên không cần mức sửa lỗi cao.
function useQrSrc(value, cell) {
  return useMemo(() => {
    const q = qrcode(0, 'L');
    q.addData(value);
    q.make();
    return q.createDataURL(cell, cell * 4);   // viền trắng 4 ô (vùng yên tĩnh chuẩn) để máy quét tìm thấy mã
  }, [value, cell]);
}

export default function QrCode({ value, label = 'Mã QR vào bãi' }) {
  const [open, setOpen] = useState(false);
  const src = useQrSrc(value, 8);
  const big = useQrSrc(value, 16);

  // Giữ màn hình sáng khi đang đưa mã vào máy quét (trình duyệt hỗ trợ Wake Lock), Esc để đóng.
  useEffect(() => {
    if (!open) return undefined;
    let lock;
    navigator.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => {});
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', esc);
    return () => { lock?.release().catch(() => {}); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <>
      <button type="button" className="qr-btn" onClick={() => setOpen(true)} aria-label={`${label} – mở to để quét`}>
        <img src={src} alt={label} className="qr" />
      </button>
      {open && (
        <div className="qr-full" role="dialog" aria-modal="true" aria-label={label} onClick={() => setOpen(false)}>
          <img src={big} alt={label} className="qr-full-img" />
          <p className="qr-full-tip">
            Đưa mã vào khung camera ở cổng, cách khoảng 15–25 cm, giữ yên.<br />
            Máy quét không đọc được? Giảm độ sáng màn hình hoặc nghiêng nhẹ cho đỡ loá.
          </p>
          <button type="button" className="qr-full-close" onClick={() => setOpen(false)}>Đóng</button>
        </div>
      )}
    </>
  );
}
