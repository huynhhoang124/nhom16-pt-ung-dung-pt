// NV-05: mã QR vào/ra. Token = base64url(JSON {p: bãi, r: reservationId, e: hết hạn (giây)}) + "." + chữ ký HMAC-SHA256.
// Bãi tự ký bằng khoá riêng và tự kiểm khi quét ở cổng: KHÔNG cần hỏi Aggregator (cổng vẫn chạy khi trung tâm sập).
const crypto = require('node:crypto');

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const mac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();

function sign(secret, payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(secret, body))}`;
}

// Trả { payload } nếu hợp lệ, hoặc { error } (INVALID_QR | QR_EXPIRED).
function verify(secret, token, nowSec = Date.now() / 1000) {
  const [body, sig, extra] = String(token ?? '').split('.');
  if (!body || !sig || extra !== undefined) return { error: 'INVALID_QR' };
  const want = mac(secret, body);
  const got = Buffer.from(sig, 'base64url');
  // so sánh thời gian hằng: không lộ chữ ký đúng qua thời gian phản hồi
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { error: 'INVALID_QR' };
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return { error: 'INVALID_QR' }; }
  if (!(payload.e > nowSec)) return { error: 'QR_EXPIRED' };
  return { payload };
}

module.exports = { sign, verify };
