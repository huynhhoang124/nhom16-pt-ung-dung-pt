import { useEffect, useRef, useState } from 'react';
import { api, centralDown, message, nodeApi } from '../api.js';
import { Icon, Plate } from '../ui.jsx';

// UX-04: màn hình cổng bãi cho máy tính bảng. Quét QR (camera hoặc dán mã) -> Xe vào / Xe ra.
// Đi qua Aggregator; trung tâm không trả lời thì gọi thẳng node của bãi (node tự kiểm QR + JWT nhân viên).
// Quét bằng camera thì tự nhận biết: thử cho vào, vé đã vào bãi rồi (QR_USED + USED) thì cho ra.
export default function Gate({ parkingId }) {
  const [token, setToken] = useState('');
  const [result, setResult] = useState(null);   // { ok, verdict, title, detail, action, plate, slot, at }
  const [log, setLog] = useState([]);           // các lượt gần nhất trong ca (chỉ trên máy này)
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [direct, setDirect] = useState(false);  // lần gần nhất phải gọi thẳng bãi vì trung tâm không trả lời
  const [kiosk, setKiosk] = useState(false);
  const video = useRef(null);

  // Chế độ cổng: ẩn thanh điều hướng + toàn màn hình, tránh bấm nhầm sang trang khác.
  useEffect(() => {
    document.body.classList.toggle('kiosk', kiosk);
    const off = () => !document.fullscreenElement && setKiosk(false);
    document.addEventListener('fullscreenchange', off);
    return () => { document.removeEventListener('fullscreenchange', off); document.body.classList.remove('kiosk'); };
  }, [kiosk]);
  function toggleKiosk() {
    if (kiosk) { document.fullscreenElement && document.exitFullscreen?.(); setKiosk(false); return; }
    setKiosk(true);
    document.documentElement.requestFullscreen?.().catch(() => { /* trình duyệt chặn: vẫn ẩn thanh điều hướng */ });
  }

  // Camera: BarcodeDetector nếu trình duyệt có (Android/ChromeOS/macOS), không thì jsQR (tải lười).
  useEffect(() => {
    if (!scanning) return undefined;
    let stream;
    let stop = false;
    (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
        }
        // Xin độ phân giải cao (mặc định nhiều webcam chỉ trả 640x480 -> mã QR dày bị nhoè, không đọc được).
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        const track = stream.getVideoTracks()[0];
        // Lấy nét liên tục nếu camera hỗ trợ (điện thoại); webcam không hỗ trợ thì bỏ qua.
        if (track?.getCapabilities?.().focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        video.current.srcObject = stream;
        await video.current.play();
        const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
        const jsQR = detector ? null : (await import('jsqr')).default;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        // jsQR: luân phiên quét cả khung hình và VÙNG GIỮA phóng to gấp đôi — mã nhỏ trong khung (đưa điện thoại hơi xa
        // webcam) vẫn đủ điểm ảnh để đọc. Ảnh to quá thì thu lại cho nhanh.
        const decode = (crop) => {
          const v = video.current;
          const [w, h] = [v.videoWidth, v.videoHeight];
          if (!w) return null;
          const side = Math.min(w, h) * (crop ? 0.6 : 1);
          const [sx, sy, sw, sh] = crop ? [(w - side) / 2, (h - side) / 2, side, side] : [0, 0, w, h];
          const scale = crop ? Math.min(2, 1000 / side) : Math.min(1, 1280 / w);
          [canvas.width, canvas.height] = [Math.round(sw * scale), Math.round(sh * scale)];
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data;
        };
        let n = 0;
        while (!stop) {
          const text = detector ? (await detector.detect(video.current))[0]?.rawValue : decode(n++ % 2 === 1);
          if (text) { setToken(text); setScanning(false); auto(text); break; }
          await new Promise((r) => setTimeout(r, 120));
        }
      } catch (e) {
        setScanning(false);
        const insecure = e.name === 'InsecureContext';
        setResult({ ok: false, verdict: 'Không mở được camera',
          title: insecure ? 'Trình duyệt chỉ cho dùng camera trên HTTPS hoặc localhost' : e.name === 'NotAllowedError' ? 'Bạn chưa cho phép dùng camera' : 'Kiểm tra quyền dùng camera của trình duyệt',
          detail: insecure ? 'Mở trang bằng địa chỉ https://… (xem README, mục "Test quét QR bằng điện thoại"), hoặc dán mã QR vào ô bên dưới.' : e.message });
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [scanning]);

  async function call(action, value) {
    const body = { token: value.trim(), action };
    // keepSession: QR sai/hết hạn trả 401 — đó là lỗi của mã, không phải phiên đăng nhập của nhân viên.
    let r = await api(`/api/parkings/${parkingId}/gate/scan`, { method: 'POST', body, keepSession: true });
    const down = centralDown(r);
    if (down) r = await nodeApi(parkingId, '/api/gate/scan', { method: 'POST', body });
    setDirect(down);
    return r;
  }

  function show(action, r) {
    const fee = r.data?.session?.fee;
    const extra = { action, plate: r.data?.licensePlate ?? r.data?.session?.licensePlate, slot: r.data?.slot ?? r.data?.slotCode, at: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
    const res = r.ok
      ? { ok: true, ...extra, verdict: action === 'enter' ? 'Mời vào' : 'Mời ra',
          title: action === 'enter' ? `Ô ${extra.slot ?? ''}`.trim() : 'Hẹn gặp lại!',
          detail: action === 'exit' ? (fee ? `Phí ${fee.toLocaleString('vi-VN')} đ · đã thanh toán` : 'Miễn phí') : '' }
      : { ok: false, ...extra, verdict: r.status === 402 ? 'Chưa thanh toán' : 'Không cho qua',
          title: r.status === 402 ? `Cần thu ${r.data.extra ? 'thêm ' : ''}${r.data.fee.toLocaleString('vi-VN')} đ` : message(r.data),
          detail: r.status === 402 ? (r.data.extra ? 'Khách đã trả nhưng ra quá 15 phút sau khi trả nên phát sinh thêm. ' : '') + 'Mời khách thanh toán trên ứng dụng, hoặc thu tiền mặt ở trang "Bãi" rồi cho ra.' : '' };
    setResult(res);
    setLog((xs) => [res, ...xs].slice(0, 8));
    beep(r.ok);
    if (r.ok) setToken('');
  }

  async function go(action, value = token) {
    if (busy || !value.trim()) return;
    setBusy(true);
    try { show(action, await call(action, value)); } finally { setBusy(false); }
  }

  // Tự nhận biết vào/ra: vé đã vào bãi (QR_USED, status USED) thì đây là lượt ra.
  async function auto(value) {
    if (busy) return;
    setBusy(true);
    try {
      let r = await call('enter', value);
      if (!r.ok && r.data?.error === 'QR_USED' && r.data?.status === 'USED') { show('exit', await call('exit', value)); return; }
      show('enter', r);
    } finally { setBusy(false); }
  }

  return (
    <div className="gate">
      {direct && (
        <div className="banner bad"><Icon name="wifi-off" />
          <div><strong>Trung tâm mất kết nối</strong>Đang làm việc thẳng với máy chủ bãi {parkingId}. Lượt vào/ra vẫn ghi nhận, sẽ đồng bộ khi trung tâm kết nối lại.</div>
        </div>
      )}
      <div className="row">
        <h2 style={{ margin: 0 }}>Cổng bãi {parkingId}</h2>
        <button onClick={toggleKiosk}><Icon name={kiosk ? 'x' : 'layers'} /> {kiosk ? 'Thoát chế độ cổng' : 'Chế độ cổng (toàn màn hình)'}</button>
      </div>
      {scanning
        ? <>
            <div className="cam"><video ref={video} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /></div>
            <div className="row">
              <span className="muted small"><Icon name="loader" spin /> Đang tìm mã… Đưa mã vào giữa khung, cách 15–25 cm. Màn điện thoại loá thì giảm độ sáng.</span>
              <button onClick={() => setScanning(false)}>Dừng quét</button>
            </div>
          </>
        : <button className="big-btn" onClick={() => { setResult(null); setScanning(true); }} disabled={busy}><Icon name="camera" /> Quét mã QR</button>}
      <p className="muted small" style={{ margin: 0 }}>Quét bằng camera: hệ thống tự biết xe đang vào hay ra.</p>
      <textarea placeholder="…hoặc dán mã QR vào đây rồi chọn Xe vào / Xe ra" aria-label="Mã QR" value={token} onChange={(e) => setToken(e.target.value)} rows="2" />
      <div className="gate-actions">
        <button className="big-btn primary" disabled={!token.trim() || busy} onClick={() => go('enter')}>{busy ? <Icon name="loader" spin /> : <Icon name="login" />} Xe vào</button>
        <button className="big-btn" disabled={!token.trim() || busy} onClick={() => go('exit')}><Icon name="logout" /> Xe ra</button>
      </div>
      {result && (
        <div className={`gate-result ${!result.ok ? 'bad' : result.action === 'exit' ? 'out' : 'ok'}`} role="status">
          <Icon name={!result.ok ? 'circle-x' : result.action === 'exit' ? 'logout' : 'circle-check'} />
          <span className="verdict">{result.verdict}</span>
          <span>{result.title}{result.detail && ` · ${result.detail}`}</span>
          {(result.plate || result.slot) && (
            <div className="detail">
              {result.plate && <Plate value={result.plate} lg />}
              {result.slot && <span className="sheet-code">{result.slot}</span>}
              <span className="mono small muted">{result.at}</span>
            </div>
          )}
        </div>
      )}
      {log.length > 0 && (
        <section>
          <h3 style={{ marginBottom: 'var(--space-2)' }}>Lượt gần đây</h3>
          <ol className="gate-log">
            {log.map((x, i) => (
              <li key={i} className={x.ok ? 'ok' : 'bad'}>
                <span className="mono small muted">{x.at}</span>
                <span className={`st ${x.ok ? (x.action === 'exit' ? 'info' : 'ok') : 'bad'}`}>
                  <Icon name={x.ok ? (x.action === 'exit' ? 'logout' : 'login') : 'x'} />{x.ok ? (x.action === 'exit' ? 'Ra' : 'Vào') : 'Từ chối'}
                </span>
                {x.plate ? <Plate value={x.plate} /> : <span className="muted small">—</span>}
                <span className="small">{x.ok ? (x.slot ? `Ô ${x.slot}` : '') : x.title}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

// Âm báo ngắn: cao = cho qua, thấp = từ chối. Dùng chung MỘT AudioContext — tạo mới mỗi lần sẽ chạm giới hạn
// số context của trình duyệt và mất tiếng sau vài chục lượt quét.
let audio;
function beep(ok) {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator();
    o.frequency.value = ok ? 880 : 220;
    o.connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.15);
  } catch { /* trình duyệt chặn âm thanh: bỏ qua */ }
}
