// NV-08: từ một sự kiện của bãi -> danh sách thông báo { to: userId | '*', kind, text }.
// Hàm thuần (không đụng broker) để test được. Giữ trạng thái "bãi đang sắp đầy" để không báo lặp:
// báo khi chỗ trống < 10%, chỉ báo lại sau khi đã lên > 20% (độ trễ chống báo dồn dập quanh ngưỡng).
const LOW = 0.1;
const RESET = 0.2;

const hhmm = (t) => new Date(t).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });

function makeRules() {
  const low = new Set();
  return (e) => {
    const out = [];
    const at = `${e.slot} (bãi ${e.parkingId})`;
    const user = (kind, text) => { if (e.userId) out.push({ to: e.userId, kind, text }); };
    switch (e.type) {
      case 'RESERVED': user('ok', `Đã giữ chỗ ${at} cho bạn.`); break;
      case 'RESERVATION_MOVED': user('info', `Chỗ cũ vẫn còn xe, lượt đặt của bạn được chuyển sang ${at}.`); break;
      case 'RESERVATION_EXPIRING': user('error', `Chỗ ${at} chỉ giữ đến ${hhmm(e.expireTime)}. Hãy đến kịp hoặc huỷ để nhường chỗ.`); break;
      case 'EXPIRED': user('error', `Lượt đặt ${at} đã hết hạn vì quá giờ đến.`); break;
      case 'CAR_ENTER': user('ok', `Xe đã vào ${at}.`); break;
      default: break;
    }
    if (e.total > 0) {
      const ratio = e.available / e.total;
      if (ratio < LOW && !low.has(e.parkingId)) {
        low.add(e.parkingId);
        out.push({ to: '*', kind: 'error', text: `Bãi ${e.parkingId} sắp đầy: còn ${e.available}/${e.total} chỗ.` });
      } else if (ratio > RESET) {
        low.delete(e.parkingId);
      }
    }
    return out;
  };
}

module.exports = { makeRules };
