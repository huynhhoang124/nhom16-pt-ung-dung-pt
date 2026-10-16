# Hướng dẫn giao diện (dùng chung)

Chạy không cần Docker: `node scripts/dev-no-docker.cjs` rồi `cd frontend && npm run dev` → http://localhost:3000.

| Cần gì | Dùng | Ở đâu |
|---|---|---|
| Gọi API | `api(path, { method, body, headers })` → `{ ok, status, data }`; 401 tự đăng xuất | `src/api.js` |
| Câu báo lỗi tiếng Việt | `message(r.data)`; mã lỗi mới thì thêm vào `MESSAGES` | `src/api.js` |
| Thông báo nổi | `toast('Đã lưu', 'ok' \| 'error' \| 'info')` | `src/api.js`, `src/Toaster.jsx` |
| Realtime | `useLive(['SLOT_UPDATED', 'NODE_STATUS'], reload)` (gộp tin dồn dập rồi tải lại từ API) | `src/api.js` |
| Thao tác ghi bấm lại được | `newKey()` sinh 1 lần cho mỗi lượt, gửi header `idempotency-key`; 504 thì giữ key, nút "Thử lại" | `ParkingDetail.jsx`, `History.jsx` |
| Hiển thị biển số | `formatPlate('30A12345')` → `30A-123.45` | `src/api.js` |
| Nhãn trạng thái | `STATUS_LABEL` (slot), `RESERVATION_LABEL` (đặt chỗ), `TYPE_LABEL` (loại xe) | `api.js`, `Dashboard.jsx` |
| Mã QR | `<QrCode value={token} />` | `src/QrCode.jsx` |

Class CSS hay dùng: `card`, `panel`, `inline` (hàng nút/ô nhập tự xuống dòng), `banner` (cảnh báo vàng), `error`, `success`, `muted`, `small`, `scroll` (bọc bảng để cuộn ngang trên điện thoại), `num` (ô số hẹp).

Kiểm tra trước khi mở PR: `npm run build` không lỗi; xem ở bề rộng 375px không bị tràn ngang.
