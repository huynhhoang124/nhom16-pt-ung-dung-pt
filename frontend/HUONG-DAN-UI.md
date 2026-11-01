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
| Biểu tượng | `<Icon name="check" />` (có `spin` cho `loader`); danh sách tên ở cuối `style.css` | `src/ui.jsx` |
| Biển số dạng tấm biển | `<Plate value={x.licensePlate} />`, to: `lg` | `src/ui.jsx` |
| Trạng thái (màu + chữ + biểu tượng) | `<NodeBadge status>` (bãi: ONLINE / DEGRADED / OFFLINE), `<SlotStatus>`, `<ResStatus>`, `<TypeTag>`, `<Meter available total>` | `src/ui.jsx` |

## Giao diện "Biển báo bãi đỗ"

Thiết kế làm trên Claude Design (nền Industry): xanh biển báo cho thao tác chính, vàng vạch kẻ cho cảnh báo và việc đang chờ, mọi khối vuông góc, thẻ có dấu + ở 4 góc. Mô tả đầy đủ biến, class và trạng thái ở `THIET-KE-GIAO-DIEN.md`.

Class hay dùng: `card`, `stack` (cột cách đều), `split` (nội dung + cột phải 380px), `duo` (2 cột), `page-head`, `seg` (nhóm lọc), `field` (nhãn + ô nhập), `banner` (vàng; `.bad` đỏ, `.info` xanh), `empty`, `skeleton`, `scroll` (bọc bảng), `tnum` (cột số), `num` (ô số hẹp), `st ok|warn|bad|off|info` (chip trạng thái).

Dành sẵn cho việc giai đoạn 2 (đã có class, chưa có màn hình):
- `.cmd` + `pending / ok / bad / expired / busy / timeout`: khung trạng thái lệnh qua hàng đợi (PD-03, PD-06).
- `.badge.PARTIAL` qua `<NodeBadge status="DEGRADED">`: bãi kết nối một phần (PD-09).
- `.steps`: các bước đặt nhóm theo bãi (PD-07, đang dùng ở `GroupBooking.jsx`).
- `.seg` cho lọc vùng Bắc/Nam (PD-12); bảng + `.cmd` cho trang Lệnh lỗi và lệnh cho cả vùng (PD-04, PD-08).

Bố cục điện thoại dùng container query (`@container app (max-width: 640px)`), không dùng `@media` theo bề rộng màn hình.

Kiểm tra trước khi mở PR: `npm run build` không lỗi; xem ở bề rộng 375px không bị tràn ngang, xem cả chế độ tối.
