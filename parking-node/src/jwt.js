// PT-05: node tự kiểm JWT do Aggregator ký bằng RS256, chỉ cần KHOÁ CÔNG KHAI (crypto có sẵn, không thêm thư viện).
// Nhờ vậy nhân viên vẫn thao tác được ở bãi khi Aggregator sập: không cần hỏi trung tâm "token này có hợp lệ không".
// Đánh đổi: không thu hồi được token trước hạn (8 giờ) -> token sống ngắn.
const crypto = require('node:crypto');

const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());

// Trả payload nếu hợp lệ, null nếu sai chữ ký / sai thuật toán / hết hạn / hỏng.
function verifyRS256(token, publicKey, nowSec = Date.now() / 1000) {
  try {
    const [h, p, sig, extra] = String(token ?? '').split('.');
    if (!sig || extra !== undefined) return null;
    if (part(h).alg !== 'RS256') return null;   // chặn tấn công đổi alg (vd "none", HS256 dùng khoá công khai làm secret)
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'));
    const payload = ok && part(p);
    return payload && (payload.exp === undefined || payload.exp > nowSec) ? payload : null;
  } catch {
    return null;
  }
}

module.exports = { verifyRS256 };
