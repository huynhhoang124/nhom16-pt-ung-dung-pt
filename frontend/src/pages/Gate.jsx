import { useEffect, useRef, useState } from 'react';
import { api, centralDown, message, nodeApi, STATUS_LABEL } from '../api.js';

// UX-04: màn hình cổng bãi cho máy tính bảng. Quét QR (camera hoặc dán mã) -> Xe vào / Xe ra.
// Đi qua Aggregator; trung tâm không trả lời thì gọi thẳng node của bãi (node tự kiểm QR + JWT nhân viên).
export default function Gate({ parkingId }) {
  const [token, setToken] = useState('');
  const [result, setResult] = useState(null);   // { ok, title, detail }
  const [scanning, setScanning] = useState(false);
  const video = useRef(null);

  // Camera: BarcodeDetector nếu trình duyệt có (Android/ChromeOS/macOS), không thì jsQR (tải lười).
  useEffect(() => {
    if (!scanning) return undefined;
    let stream;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.current.srcObject = stream;
        await video.current.play();
        const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
        const jsQR = detector ? null : (await import('jsqr')).default;
        const canvas = document.createElement('canvas');
        while (!stop) {
          let text = null;
          if (detector) {
            text = (await detector.detect(video.current))[0]?.rawValue;
          } else {
            const v = video.current;
            [canvas.width, canvas.height] = [v.videoWidth, v.videoHeight];
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(v, 0, 0);
            text = canvas.width && jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
          }
          if (text) { setToken(text); setScanning(false); beep(true); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) {
        setScanning(false);
        setResult({ ok: false, title: 'Không mở được camera', detail: e.message });
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [scanning]);

  async function go(action) {
    const body = { token: token.trim(), action };
    let r = await api(`/api/parkings/${parkingId}/gate/scan`, { method: 'POST', body });
    if (centralDown(r)) r = await nodeApi(parkingId, '/api/gate/scan', { method: 'POST', body });
    const fee = r.data?.session?.fee;
    setResult(r.ok
      ? { ok: true, title: action === 'enter' ? `Mời vào: ${r.data.slot}` : 'Mời ra. Hẹn gặp lại!',
          detail: `${STATUS_LABEL[r.data.status]}${fee ? ` · Phí: ${fee.toLocaleString('vi-VN')} đ (đã thanh toán)` : ''}` }
      : { ok: false, title: r.status === 402 ? `Chưa thanh toán ${r.data.fee.toLocaleString('vi-VN')} đ` : 'Không cho qua',
          detail: r.status === 402 ? 'Mời thanh toán trên ứng dụng hoặc tại quầy nhân viên.' : message(r.data) });
    beep(r.ok);
    if (r.ok) setToken('');
  }

  return (
    <div className="gate">
      <h2>Cổng bãi {parkingId}</h2>
      {scanning
        ? <video ref={video} className="cam" muted playsInline />
        : <button className="big-btn" onClick={() => { setResult(null); setScanning(true); }}>📷 Quét mã QR</button>}
      <textarea placeholder="…hoặc dán mã QR vào đây" value={token} onChange={(e) => setToken(e.target.value)} rows="2" />
      <div className="gate-actions">
        <button className="big-btn primary" disabled={!token.trim()} onClick={() => go('enter')}>Xe vào</button>
        <button className="big-btn" disabled={!token.trim()} onClick={() => go('exit')}>Xe ra</button>
      </div>
      {result && (
        <div className={`gate-result ${result.ok ? 'ok' : 'bad'}`} role="status">
          <strong>{result.title}</strong>
          <span>{result.detail}</span>
        </div>
      )}
    </div>
  );
}

// Âm báo ngắn: cao = cho qua, thấp = từ chối (WebAudio có sẵn, không cần file âm thanh).
function beep(ok) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = ok ? 880 : 220;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
  } catch { /* trình duyệt chặn âm thanh: bỏ qua */ }
}
