# Thiết kế giao diện "Biển báo bãi đỗ" (bàn giao từ Claude Design)

> Bản bàn giao gốc từ Claude Design, giữ nguyên để tra cứu. `style.css` đã thay vào `src/style.css` (thêm mục 23 bố cục ở cuối). Ba file bản vẽ `designs/*.html` (mỗi file khoảng 1 MB) không đưa vào repo; xem trong dự án Claude Design của nhóm. Bãi D–F và vùng Bắc/Nam trong bản vẽ là dữ liệu minh hoạ cho giai đoạn 2.

## Overview
Thiết kế lại giao diện web Smart Parking (bãi đỗ xe thông minh liên kết nhiều bãi). **Chỉ đổi giao diện**: giữ nguyên màn hình, chức năng, luồng, dữ liệu, chữ tiếng Việt, API. Thêm cách hiển thị trạng thái phân tán (bãi kết nối / một phần / mất kết nối, lệnh hàng đợi đang chờ, realtime).

App hiện tại: React 19 + Vite, CSS thuần dùng biến CSS, Leaflet/OpenStreetMap, QR, Socket.IO, RabbitMQ.

## About the Design Files
Các file trong `designs/` là **bản vẽ tham khảo bằng HTML** (mở thẳng trong trình duyệt, tự chứa, không cần mạng trừ font Google). Chúng KHÔNG phải mã để chép vào app. Nhiệm vụ: dựng lại các màn hình này trong code React hiện có, theo cấu trúc component đang dùng.

Riêng **`style.css` là mã thật**: thay thẳng file `style.css` cũ của app. Bản vẽ được dựng bằng chính các class trong file này, nên đặt đúng class trong JSX là ra đúng giao diện.

## Fidelity
**High-fidelity.** Màu, chữ, khoảng cách, trạng thái là bản cuối. Dựng lại sát bản vẽ.

## Files
- `style.css` — biến CSS (sáng + tối) + toàn bộ class thành phần + biểu tượng Lucide nhúng sẵn (mask SVG). Thay file cũ.
- `qr-sample.svg` — QR minh hoạ, app dùng QR thật.
- `designs/he-thong.html` — bảng biến (sáng/tối), chữ, khoảng cách, tất cả thành phần dùng lại ở 2 chế độ.
- `designs/nguoi-dung.html` — U1 Đăng nhập/Đăng ký, U2 Tổng quan (danh sách sáng/tối, bản đồ, điện thoại), U3 Chi tiết bãi & đặt chỗ, U4 Đặt chỗ của tôi + Đặt nhóm, U5 Lịch sử gửi xe + thanh toán, U6 Tài khoản.
- `designs/nhan-vien-quan-tri.html` — S1 Bãi A (nhân viên), S2 Cổng (máy tính bảng sáng/tối, điện thoại khi trung tâm mất kết nối), S3 Tra biển số, S4 Thống kê, S5 Quản trị + Lệnh lỗi.

Khổ bản vẽ: máy tính 1280px, máy tính bảng 820px, điện thoại 375px.

## Cài đặt bắt buộc
1. Thay `style.css`. Font được `@import` ở đầu file (Be Vietnam Pro, Barlow Condensed, JetBrains Mono).
2. **Bố cục điện thoại dùng container query**, không dùng `@media` theo viewport: `#root, .app { container-type: inline-size }` và `@container app (max-width: 640px)`. Gốc app phải là `#root` (Vite mặc định) hoặc có class `.app`.
3. Chế độ tối: tự theo `prefers-color-scheme`; ép bằng `data-theme="dark"` / `"light"` trên `<html>`.
4. Biểu tượng: `<i class="i i-check"></i>` (cỡ theo `font-size`, màu theo `color`). Có: check, x, circle-check, circle-x, alert, clock, loader (+ `.i-spin`), wifi, wifi-low, wifi-off, wrench, car, bike, qr, camera, pin, search, retry, undo, ban, info, logout, login, back, plus, lock, send, hourglass, menu, inbox, card, calendar, server, eye-off, pencil, user, layers, radio.

## Tên class
Giữ nguyên các class cũ: `card, panel, inline, banner, error, success, muted, small, scroll, num, tab, dot, bar, brand`, và cả `cards, parking, offline, big, meter, badge, ONLINE, OFFLINE, legend, chip, grid, slot, sel, AVAILABLE, RESERVED, OCCUPIED, MAINTENANCE, form, floor, qr, toasts, toast, map, stats, bars, barcol, hbar, gate, gate-actions, big-btn, cam, gate-result, login, primary, link, mono, row, who`.

Class mới (ghi "MỚI" trong CSS):
- `.app` (gốc + theme), `.page-head`, `.kicker`, `.tnum` (cột số căn phải, mono), `.field` (+ `.hint`, `.error`), `.danger`
- `.seg` — nhóm lọc phân đoạn, bọc các `.tab` (Tất cả/Ô tô/Xe máy, Danh sách/Bản đồ, vùng Bắc/Nam)
- `.brand-mark` — ô chữ P; `.rt` / `.rt.off` — "Đang nhận realtime" / "Mất kết nối realtime"; `.role`; `.hide-sm`, `.show-sm`
- `.badge.PARTIAL` — Kết nối một phần
- `.lot-head, .lot-name, .lot-cap, .lot-foot`; `.meter.mid/.low/.off`
- `.st` + `.ok/.warn/.bad/.off/.info` — pill trạng thái chung (đặt chỗ, lệnh, bước)
- Sơ đồ: `.lot` (mặt bằng 1 tầng), `.lot-label`, `.aisle` (lối đi vạch đứt), `.grid.moto`, `.grid.down`, `.slot.hidden`, `.sheet-head`, `.sheet-code`, `.timeline` (24 ô giờ; `i.busy`, `i.now`)
- `.plate` (+ `.lg`, `.two` cho xe máy 2 dòng)
- `.cmd` + `.pending/.ok/.bad/.expired/.busy/.timeout` (con: `.ic`, `.cmd-title`, `.cmd-sub`, `.cmd-meta`, `.cmd-actions`, `.track`)
- `.steps` > `li.running/.undoing/.done/.failed` (con `.step-n`)
- `.qr-card` (+ `.expiring`, `.ticket-slot`, `.qr-wrap`, `dl`)
- `.pin` (+ `.mid/.low/.off`) cho Leaflet `divIcon`; `.map-legend`
- `.gate-result.out` (Xe ra), con `.verdict`, `.detail`
- `.empty`, `.skeleton`, `.dialog-backdrop`, `.dialog`, `.dialog-actions`

## Design Tokens (style.css `:root`)
| Biến | Sáng | Tối | Dùng cho |
|---|---|---|---|
| --bg | #eeeff0 | #151719 | nền trang (nhựa đường) |
| --card | #f9f9fa | #1d2023 | bảng, ô nhập, thanh trên, toast |
| --surface | #e3e5e7 | #262a2e | đầu bảng, nền phụ |
| --text | #16181a | #eceef0 | chữ chính |
| --muted | #50565d | #a7adb4 | chữ phụ |
| --line / --line-strong | #c9cdd1 / #8b9198 | #363b41 / #5c636b | kẻ mảnh / viền khung |
| --mark | #6b7178 | #7d848c | dấu + ở 4 góc thẻ |
| --primary | #416180 | #94bce3 | xanh biển báo: nút chính, link, focus |
| --primary-hover / -ink / -soft | #2c455d / #fff / #d6ebff | #b5d9fd / #0f1f2e / #1d2d3d | |
| --sign | #34597e | #34597e | ô chữ P logo |
| --lane / --lane-ink | #f2c200 / #1d1f20 | #f2c230 / #1a1a1a | vàng vạch kẻ: đang chờ, cảnh báo |
| --ok / --ok-soft | #1d6b34 / #d4ebda | #74d18f / #163220 | |
| --warn / --warn-soft | #7a5600 / #fbedb8 | #f2c94c / #33290c | |
| --bad / --bad-soft | #a8231f / #f6d6d3 | #ff8f85 / #3b1816 | |
| --off / --off-soft | #565c63 / #dfe1e4 | #9aa1a9 / #2a2e33 | mất kết nối, đã huỷ |
| --available / -line | #d4ebda / #2f8a4b | #183a23 / #4cbb6c | ô Trống (xanh lá) |
| --reserved / -line | #fbe7a6 / #d9a400 | #3a300d / #f2c230 | ô Đã đặt (vàng) |
| --occupied / -line | #f4d0cc / #c0392b | #451d1a / #ff6b5e | ô Có xe (đỏ) |
| --maintenance / -line | #dcdee1 / #7a8088 | #2a2e33 / #8f969e | ô Bảo trì (xám, sọc chéo) |
| --asphalt / --paint | #d9dbde / #fff | #202326 / #c9cdd1 | mặt bằng tầng / vạch sơn |
| --plate-bg / --plate-ink | #fcfcf8 / #111214 | #f4f4ee / #111214 | biển số |
| --pin-hi/-mid/-low/-off | #1d6b34 / #f2c200 / #b42318 / #6b7178 | như sáng | điểm bản đồ |

- Chữ: `--font-body` Be Vietnam Pro · `--font-head` Barlow Condensed 700 · `--font-mono` JetBrains Mono (biển số, mã ô, giờ, tiền, số liệu).
- Cỡ chữ: xs 12 · sm 14 · md 16 (thân) · lg 20 · xl 28 (h2) · 2xl 40 (h1) · 3xl 56 (kết quả cổng).
- Khoảng cách: 4 · 8 · 12 · 16 · 24 · 32 · 48 (`--space-1…8`).
- Bo góc: mọi khối, nút, ô nhập **vuông** (0). Chỉ biển số 4px; chấm realtime tròn.
- Bóng: chỉ cho lớp nổi. `--shadow-1` điểm bản đồ, `--shadow-2` toast, `--shadow-3` hộp thoại.
- Vùng chạm tối thiểu `--tap: 44px`. Nút cổng cao 88px (điện thoại 76px).
- Đã kiểm tra tương phản: chữ đạt WCAG AA (≥4.5:1) ở cả 2 chế độ.

## Ngôn ngữ hình ảnh
- Nền Industry: thẻ là "bản vẽ kỹ thuật" — trong suốt, viền mảnh, dấu + ở 4 góc (vẽ bằng `::before`, không cần thêm phần tử con).
- Sơ đồ chỗ đỗ như mặt bằng thật: nền `--asphalt`, vạch sơn trắng giữa các ô, vạch màu trạng thái 5px ở mép ô, lối đi vạch đứt giữa dãy ô tô và dãy xe máy, chia theo tầng. Ô chọn: viền 3px `--primary` + mũi tên nhỏ.
- Dải cảnh báo: dải sọc vàng–đen 6px ở mép trên (`.banner`), sọc đỏ cho `.banner.bad`.
- Lệnh đang chờ: nền vàng nhạt + thanh sọc vàng chạy (`.track`, 1s linear lặp).
- Không gradient trang trí, không emoji (biểu tượng Lucide nét 1.5).

## Trạng thái (luôn có màu + chữ + biểu tượng)
- Chỗ đỗ: Trống (check), Đã đặt (clock), Có xe (car/bike), Bảo trì (wrench + sọc chéo). Có `aria-label` "A04, Ô tô, Trống".
- Bãi: Đang kết nối (wifi, xanh) · Kết nối một phần (wifi-low, vàng; vẫn đặt được, mất realtime) · Mất kết nối (wifi-off, xám; thẻ viền đứt, ghi "Dữ liệu cũ · cập nhật lúc …", không cho đặt; điểm bản đồ xám).
- Đặt chỗ: Đang hiệu lực (info) · Đã vào bãi (ok) · Hoàn tất (off) · Đã huỷ (off) · Hết hạn (bad).
- Lệnh hàng đợi (`.cmd`): Đang xử lý (pending, spinner, "có thể mất vài giây, kết quả tự hiện khi về") · Thành công · Bị từ chối (hết chỗ, trùng giờ) · Hết hạn ("Bãi đang gián đoạn, chưa đặt") · Hệ thống quá tải ("Thử lại sau vài giây") · Quá thời gian chờ (nút **Thử lại** gửi lại đúng lượt cũ — dùng lại cùng idempotency key/mã lệnh, không đặt trùng).
- Đặt nhóm (`.steps`): Đang chạy · Đang hoàn tác · Xong · Thất bại. Khi một bãi lỗi, các bước Xong chuyển Đang hoàn tác rồi trả chỗ.
- Realtime: `.rt` chấm xanh "Đang nhận realtime" / `.rt.off` chấm xám "Mất kết nối realtime" (theo trạng thái Socket.IO).
- Mỗi màn: rỗng (`.empty`), đang tải (`.skeleton`), lỗi (`.empty` viền đỏ + Thử lại); toast ok/error/info; dải cảnh báo.

## Screens (tóm tắt — xem bản vẽ để biết chi tiết)
- **Thanh trên** `.bar`: logo P + "Smart Parking"; tab theo vai trò (Người dùng: Tổng quan, Đặt chỗ của tôi, Lịch sử gửi xe · Nhân viên: Tổng quan, Tra biển số, Bãi <mã>, Cổng, Thống kê · Quản trị: Tổng quan, Tra biển số, Thống kê, Quản trị); tab đang chọn gạch dưới 3px `--primary`; realtime; tên + vai trò; Tài khoản; Đăng xuất. Điện thoại: hàng 1 logo + chấm + tên + nút menu (Tài khoản/Đăng xuất); hàng 2 tab cuộn ngang.
- **Tổng quan**: tiêu đề + "5/6 bãi đang hoạt động · 130 chỗ trống"; ô tìm kiếm; lọc loại xe, vùng (Bắc/Nam), Danh sách/Bản đồ; "Tìm bãi gần tôi". Danh sách chia theo vùng, lưới 3 cột (điện thoại 1 cột). Thẻ bãi: tên, trạng thái, địa chỉ, chỗ trống/tổng riêng Ô tô và Xe máy + thanh đo (≥50% xanh, 20–49% vàng, <20% đỏ), dòng cập nhật. Bản đồ: điểm `.pin` hiện số chỗ trống, màu theo tỉ lệ, xám + wifi-off khi mất kết nối; popup thẻ bãi; chú thích màu.
- **Chi tiết bãi**: link quay lại, tên bãi, trạng thái, giờ dữ liệu; lọc + chip đếm; sơ đồ theo tầng. Máy tính: sơ đồ bên trái, bảng đặt chỗ 380px bên phải (mã ô lớn, loại, trạng thái, biển số, giờ đến, thời lượng, nút Đặt ngay → khung lệnh, lịch 24h của ô). Điện thoại: bảng đặt chỗ nằm dưới sơ đồ. Bảng giá cuộn ngang trong `.scroll`.
- **Nhân viên – Bãi**: như trên nhưng dày hơn (`main.dense`); bảng thao tác ô: Xe vào/Xe ra, Bảo trì/Mở lại, Sửa, Ẩn; Thêm slot (mã, tầng, loại); bảng giá sửa được (`input.num`) + Lưu bảng giá; Đặt chỗ tại bãi.
- **Đặt chỗ của tôi**: thẻ QR (mã ô 44px, biển số, khung giờ, đến trước, QR 168px, Huỷ); sắp hết giờ: viền vàng 2px + dải cảnh báo "còn N phút"; bảng đã dùng; khung đặt nhóm (bãi, slot, biển số × N, + Thêm xe, Đặt tất cả) + danh sách bước.
- **Lịch sử / Tra biển số**: bảng phiên (Bãi, Slot, Biển số, Vào, Ra, Phí, Đã trả); Thanh toán mở hộp thoại (điện thoại: tấm trượt từ dưới lên) có số tiền lớn.
- **Cổng**: tối đa 640px giữa màn; khung camera đen có 4 góc ngắm vàng; dán mã QR / nhập biển số; 2 nút lớn Xe vào / Xe ra; kết quả `.gate-result` chữ 56px viết hoa (XE VÀO xanh lá, XE RA xanh biển, KHÔNG HỢP LỆ đỏ) + biển số lớn + ô + giờ. Trung tâm mất kết nối: `.banner.bad` ở đầu trang.
- **Thống kê**: Từ–Đến; 4 thẻ (Lượt xe, Doanh thu (đã thu), Thời gian gửi TB, Đang lấp đầy + thanh đo); biểu đồ cột 24 giờ; bảng theo bãi; ghi chú "Số liệu cập nhật chậm tối đa 2 giây".
- **Quản trị**: dải cảnh báo tổng hợp bãi lỗi; bảng node (Bãi, Tên, Vùng, API, Trạng thái, Lỗi liên tiếp, Lần cuối thấy, Lệnh chờ); Gửi lệnh cho cả vùng (vùng, loại: Đổi giá/Khoá tầng/Cấm biển số, tham số) → khung lệnh "2/3 bãi đã áp dụng, bãi F chưa phản hồi" + từng bãi; Thêm bãi mới; tab Lệnh lỗi: bảng (mã lệnh, loại, bãi, lần thử, lỗi, lúc, Đẩy lại → "Đang đẩy lại").
- **Tài khoản**: form dọc 3 ô mật khẩu + lỗi "không khớp" + Đổi mật khẩu.
- **Đăng nhập/Đăng ký**: thẻ 400px giữa màn, logo lớn, lỗi bằng `.banner.bad`, chip tài khoản demo.

## Interactions & Behavior
- Hover: tô nhạt 7% màu chữ (nút viền), `--primary-hover` (nút chính), viền `--primary` (thẻ bãi). Nhấn: tô 14%.
- Focus bàn phím: `outline: 3px solid var(--primary); outline-offset: 2px` trên mọi phần tử.
- Disabled: opacity .45. Nút đang gửi: disabled + spinner.
- Chuyển động: spinner 1s, thanh sọc lệnh 1s, skeleton 1.4s; tắt hết khi `prefers-reduced-motion`.
- Không cuộn ngang trang; bảng cuộn trong `.scroll`; `.seg` và tab điện thoại cuộn ngang, ẩn thanh cuộn.

## Dữ liệu trong bản vẽ
Bãi D, E, F, cách chia vùng Bắc (B, C, D) / Nam (A, E, F) và số chỗ tách Ô tô/Xe máy là dữ liệu minh hoạ để thể hiện đủ 6 bãi và các trạng thái — thay bằng dữ liệu thật từ Aggregator.

## Assets
- Biểu tượng: Lucide (lucide.dev, ISC), nhúng dạng data-URI trong `style.css`.
- Font: Google Fonts (Be Vietnam Pro, Barlow Condensed, JetBrains Mono).
- Nền bản đồ trong bản vẽ là lưới thay thế; app dùng ô bản đồ OpenStreetMap qua Leaflet.
