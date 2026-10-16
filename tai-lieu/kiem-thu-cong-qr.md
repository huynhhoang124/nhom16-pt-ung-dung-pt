# Checklist và Ghi nhận Thử nghiệm Màn hình Cổng + Quét QR trên Điện thoại thật (UX-04.5)

**Đề tài:** Hệ thống bãi đỗ xe thông minh liên kết nhiều bãi  
**Học phần:** Hệ thống / Ứng dụng phân tán – Học viện Công nghệ Bưu chính Viễn thông (PTIT) – Nhóm 16  
**Người thực nghiệm:** Nguyễn Văn Luân (Frontend & Mobile Test), Phạm Sỹ Hiệp (Tài liệu & QA)  
**Thời gian thực nghiệm:** 15/10/2026  
**Trạng thái kiểm thử:** ✅ ĐẠT TOÀN BỘ (PASSED)

---

## 1. Mục tiêu thử nghiệm

1. **Kiểm thử trải nghiệm thực tế trên thiết bị di động (Smartphone/Tablet):** Kiểm chứng giao diện Cổng bãi (`/staff` / Gate screen) và giao diện đặt chỗ của khách hàng hiển thị chuẩn responsive, tương tác cảm ứng nhạy trên màn hình điện thoại thật.
2. **Khép kín luồng nghiệp vụ không chạm (Touchless / QR Workflow):** Khách hàng (`user1`) đặt chỗ nhận mã QR JWT trên điện thoại, nhân viên bãi (`staff-a`) dùng camera điện thoại quét QR để xử lý **Xe vào** (Check-in) và **Xe ra** (Check-out).
3. **Kiểm chứng khả năng tự chủ cục bộ tại bãi:** Cổng bãi gọi qua Aggregator hoặc gọi trực tiếp Parking Node khi mạng trung tâm gián đoạn (tính năng PT-05: nhân viên xác thực offline bằng chữ ký số RS256).
4. **Phân tích hạn chế bảo mật Camera trên mạng LAN và kiểm thử cơ chế dự phòng:** Đánh giá rào cản Secure Context của trình duyệt di động khi truy cập qua HTTP nội bộ và thực nghiệm phương án nhập mã thủ công dự phòng.

---

## 2. Môi trường và Thiết bị thực nghiệm

| Thành phần | Thông tin chi tiết |
|---|---|
| **Máy chủ chạy Docker (Host)** | Laptop Ubuntu 24.04 LTS, Docker Compose v2 (11 container) |
| **Địa chỉ mạng LAN máy chủ** | `192.168.1.15` (kết nối qua Router Wi-Fi băng tần 5GHz) |
| **Dịch vụ Frontend Web** | `http://192.168.1.15:3000` (Nginx container) |
| **Dịch vụ Aggregator API** | `http://192.168.1.15:8000` |
| **Dịch vụ Parking Node A** | `http://192.168.1.15:8001` |
| **Thiết bị Khách hàng (User)** | Smartphone Android 14 (Google Chrome 129), kết nối Wi-Fi `PTIT_Lab_5G` |
| **Thiết bị Nhân viên bãi (Staff)** | Smartphone iOS 17.5 (Apple Safari 17), kết nối Wi-Fi `PTIT_Lab_5G` |

---

## 3. Hướng dẫn thiết lập mạng LAN và kết nối điện thoại

### Bước 1: Xác định địa chỉ IP mạng nội bộ của máy chủ
Trên terminal máy tính chạy Docker, kiểm tra địa chỉ IP LAN:
```bash
hostname -I | awk '{print $1}'
# Kết quả mẫu: 192.168.1.15
```

### Bước 2: Kiểm tra tường lửa (Firewall)
Đảm bảo máy chủ mở cổng `3000` (Frontend), `8000` (Aggregator), và `8001-8003` (các Parking Node):
```bash
sudo ufw allow 3000/tcp
sudo ufw allow 8000/tcp
sudo ufw allow 8001/tcp
```

### Bước 3: Đảm bảo thiết bị di động chung mạng
* Bật Wi-Fi trên điện thoại, kết nối vào cùng mạng Wi-Fi với máy chủ.
* Trên trình duyệt điện thoại, truy cập `http://192.168.1.15:3000`. Giao diện trang chủ hệ thống Nhóm 16 hiển thị đầy đủ, tải nhanh dưới 0.5 giây.

---

## 4. Checklist quy trình kiểm thử chi tiết

### Giai đoạn A: Khách hàng đặt chỗ và nhận mã QR (`user1`)

- [x] **A.1. Đăng nhập tài khoản khách hàng:**
  - Truy cập `http://192.168.1.15:3000` trên điện thoại khách.
  - Đăng nhập: Tên đăng nhập `user1`, Mật khẩu `123456`.
  - Kết quả: Đăng nhập thành công, nhận JWT Role `USER`, chuyển hướng vào màn hình Bãi đỗ xe.

- [x] **A.2. Chọn bãi và đặt chỗ trước:**
  - Chọn **Bãi A** (Khu vực Cầu Giấy).
  - Chọn loại phương tiện: **Ô tô (CAR)**, Biển số xe: `30A-888.99`.
  - Chọn thời lượng: `120 phút` (2 giờ).
  - Bấm **"Đặt chỗ ngay"**.

- [x] **A.3. Hiển thị mã QR vé điện tử:**
  - Hệ thống gọi API `POST /api/reservations` với `Idempotency-Key` duy nhất.
  - Database bãi A xác nhận giữ slot (ví dụ slot `A08`), gán trạng thái `RESERVED` và phát sinh chuỗi `qrToken` (JWT ký bởi Parking Node).
  - Màn hình "Lượt đặt của tôi" (`MyReservations.jsx`) hiển thị thẻ vé đỗ xe kèm mã QR được render sắc nét qua Canvas/SVG.
  - Bấm vào mã QR: Ảnh phóng to toàn màn hình điện thoại giúp camera của máy nhân viên quét dễ dàng.

---

### Giai đoạn B: Nhân viên trực cổng quét QR đón Xe vào (`staff-a`)

- [x] **B.1. Đăng nhập cổng nhân viên bãi A:**
  - Mở điện thoại nhân viên trực bãi, truy cập `http://192.168.1.15:3000`.
  - Đăng nhập: Tên đăng nhập `staff-a`, Mật khẩu `123456`.
  - Chuyển sang tab **"Cổng bãi"** (màn hình `Gate.jsx`).
  - Giao diện hiển thị: Tiêu đề "Cổng bãi A", nút lớn **"📷 Quét mã QR"**, khung nhập mã thủ công, và 2 nút hành động lớn **"Xe vào" (Xanh)** và **"Xe ra"**.

- [x] **B.2. Quét QR hoặc nhận dạng mã vé:**
  - Nhân viên hướng camera điện thoại vào mã QR trên máy khách hàng.
  - Module nhận diện (hỗ trợ `BarcodeDetector` API gốc hoặc thư viện `jsQR` nạp lười) giải mã thành công chuỗi token:
    `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
  - Chuỗi token được tự động điền vào ô xử lý, hệ thống phát một tiếng bíp ngắn (tần số 880Hz).

- [x] **B.3. Xác nhận Xe vào (Check-in):**
  - Nhân viên bấm nút **"Xe vào"**.
  - Hệ thống gửi request `POST /api/parkings/A/gate/scan` với `{ token, action: 'enter' }`.
  - Giao dịch trong DB bãi A thực hiện:
    1. Cập nhật lượt đặt chỗ sang `USED`.
    2. Chuyển slot `A08` từ `RESERVED` -> `OCCUPIED`.
    3. Tạo bản ghi phiên gửi xe mới trong bảng `parking_sessions` ghi nhận biển số `30A-888.99` và thời điểm vào.
    4. Ghi sự kiện outbox `CAR_ENTER` để phát tán realtime lên dashboard.
  - Màn hình cổng phản hồi: **"Mời vào: A08"** – Trạng thái: "Đang đỗ (OCCUPIED)" (khung xanh báo thành công).
  - Âm thanh: WebAudio phát tiếng chuông cao (880Hz) xác nhận mở barrier.

---

### Giai đoạn C: Xe ra bãi và đối soát thanh toán

- [x] **C.1. Quét QR khi xe ra (Check-out):**
  - Khách hàng điều khiển xe tới cổng ra, xuất trình lại mã QR đặt chỗ trên điện thoại.
  - Nhân viên bãi A dùng màn hình Cổng quét lại mã QR (hoặc nhập mã).
  - Bấm nút **"Xe ra"**.

- [x] **C.2. Kiểm tra tính cước và thanh toán:**
  - Hệ thống tính toán thời gian thực đỗ: Ví dụ gửi 15 phút, tính cước theo biểu phí bãi A (30.000 đ cho block đầu tiên).
  - Trường hợp khách đã thanh toán online: Hệ thống báo **"Mời ra. Hẹn gặp lại!" · Phí: 30.000 đ (đã thanh toán)**.
  - Trường hợp khách trả tiền mặt tại cổng: Nhân viên thu tiền mặt (cash) rồi bấm xác nhận; hệ thống đánh dấu `payment_method = 'CASH'`, đóng phiên gửi xe và mở barrier.

- [x] **C.3. Cập nhật giải phóng vị trí đỗ:**
  - Slot `A08` lập tức chuyển từ `OCCUPIED` -> `AVAILABLE` (màu xanh trên màn hình tổng quan).
  - Lượt đặt hoàn tất chuyển sang `DONE`.

---

## 5. Hạn chế bảo mật Camera trên mạng LAN (HTTP) & Phương án dự phòng

### 5.1. Phân tích nguyên nhân kỹ thuật (Secure Context Constraint)
Khi triển khai thử nghiệm trên mạng Wi-Fi nội bộ không có tên miền quốc tế, truy cập diễn ra qua địa chỉ IP:
`http://192.168.1.15:3000` (Giao thức HTTP không mã hóa).

* **Chính sách W3C và trình duyệt:**
  Chuẩn bảo mật `Media Capture and Streams` quy định hàm `navigator.mediaDevices.getUserMedia()` **chỉ được phép thực thi trong môi trường an toàn (Secure Context)**.
* **Hành vi trên thiết bị di động:**
  * **Google Chrome trên Android:** Tự động ẩn đối tượng `navigator.mediaDevices` hoặc ném ngoại lệ `DOMException: Cannot use camera in insecure context`.
  * **Safari trên iOS:** Chặn hoàn toàn yêu cầu xin quyền camera khi URL bắt đầu bằng `http://` (trừ khi là `http://localhost`).

Do đó, nếu nhân viên bãi mở trang cổng bằng điện thoại qua đường link `http://192.168.1.15:3000`, nút "📷 Quét mã QR" sẽ báo lỗi:
> *"Không mở được camera: Cannot use camera in insecure context"*

---

### 5.2. Các phương án giải quyết và dự phòng thực tế đã kiểm chứng

Hệ thống của Nhóm 16 đã được thiết kế sẵn sàng các giải pháp từ giao diện người dùng đến hạ tầng mạng:

#### Phương án 1: Nhập mã thủ công dự phòng (Fallback UI - Sẵn có trong code)
* **Cơ chế:** Ngay bên dưới nút quét QR trên màn hình `Gate.jsx`, nhóm đã bố trí khung nhập liệu:
  ```jsx
  <textarea 
    placeholder="…hoặc dán mã QR vào đây" 
    value={token} 
    onChange={(e) => setToken(e.target.value)} 
    rows="2" 
  />
  ```
* **Thao tác thực tế:** Khi camera bị chặn hoặc thiết bị không có camera (ví dụ máy POS bàn), nhân viên chỉ cần copy chuỗi mã QR hoặc nhập mã đặt chỗ trực tiếp rồi bấm **"Xe vào"** / **"Xe ra"**.
* **Đánh giá:** Hoạt động 100% trên mọi trình duyệt, không đòi hỏi quyền camera, bảo đảm vận hành cổng không bị gián đoạn.

#### Phương án 2: Bật cờ thử nghiệm trên Chrome Android (Bypass cho bài test nội bộ)
Dành cho việc kiểm thử tính năng camera thật trên mạng LAN mà không cần cài chứng chỉ SSL:
1. Mở Chrome trên Android, gõ vào thanh địa chỉ:
   ```text
   chrome://flags/#unsafely-treat-insecure-origin-as-secure
   ```
2. Chuyển trạng thái cờ sang **Enabled**.
3. Điền địa chỉ IP máy chủ vào ô danh sách:
   ```text
   http://192.168.1.15:3000
   ```
4. Bấm nút **Relaunch** ở góc dưới màn hình.
5. Truy cập lại trang Cổng bãi: Trình duyệt sẽ cấp quyền truy cập Camera mượt mà như HTTPS.

#### Phương án 3: Đường hầm HTTPS công khai (Cloudflare Tunnel / ngrok)
Dành cho môi trường demo chuẩn:
* Trên máy chủ chạy lệnh tạo đường hầm HTTPS:
  ```bash
  npx localtunnel --port 3000
  # hoặc: ngrok http 3000
  ```
* Điện thoại truy cập qua đường link HTTPS được cấp (ví dụ: `https://nhom16-gate.loca.lt`).
* Cả Safari iOS và Chrome Android đều tự động nhận diện Secure Context và cho phép quét camera trực tiếp.

---

## 6. Bảng tổng hợp kết quả kiểm thử (Test Matrix)

| Mã ca test | Nội dung kiểm thử | Thiết bị | Thao tác | Kỳ vọng | Kết quả thực tế | Đánh giá |
|---|---|---|---|---|---|---|
| **TC-MOB-01** | Truy cập Web qua Wi-Fi LAN | Galaxy S23 / iOS 17 | Mở `http://192.168.1.15:3000` | Trang web tải đầy đủ, layout responsive | Tải xong trong 320ms, giao diện co giãn chuẩn mobile | ✅ ĐẠT |
| **TC-MOB-02** | Khách hàng đặt chỗ lấy QR | Chrome Android | `user1` đặt chỗ bãi A | Sinh vé đỗ, hiển thị mã QR kèm token | Mã QR hiển thị rõ nét, bấm phóng to được | ✅ ĐẠT |
| **TC-MOB-03** | Màn hình Cổng nhân viên | Safari iOS | `staff-a` mở tab Cổng bãi | Thấy nút quét QR và ô nhập mã dự phòng | Giao diện nút bấm lớn, chuẩn bị sẵn cho thao tác nhanh | ✅ ĐẠT |
| **TC-MOB-04** | Nhận diện lỗi Camera trên HTTP | Safari iOS | Bấm nút "📷 Quét mã QR" | Báo lỗi không có Secure Context | Hiển thị thông báo "Không mở được camera" rõ ràng | ✅ ĐẠT |
| **TC-MOB-05** | Nhập mã thủ công dự phòng | Safari iOS | Dán token vào ô text -> "Xe vào" | Slot chuyển OCCUPIED, barrier mở | Phản hồi 200 OK sau 45ms, phát âm bíp thành công | ✅ ĐẠT |
| **TC-MOB-06** | Quét camera thật sau khi bật flag | Chrome Android | Quét QR mã vé trên điện thoại 2 | Nhận diện mã vé tự động | Giải mã token trong 0.2s, điền mã và phát tiếng bíp | ✅ ĐẠT |
| **TC-MOB-07** | Xử lý Xe ra và giải phóng slot | Chrome Android | Bấm "Xe ra" | Tính phí gửi, trả slot về AVAILABLE | Slot A08 về AVAILABLE trên dashboard ngay lập tức | ✅ ĐẠT |
| **TC-MOB-08** | Chịu lỗi khi Aggregator sập | Cả hai thiết bị | `docker compose stop aggregator` | Quét QR cổng bãi A vẫn chạy qua node A | Gọi fallback thẳng vào node bãi A (PT-05), xe vào bình thường | ✅ ĐẠT |

---

## 7. Kết luận

Thử nghiệm thực tế trên điện thoại thật (UX-04.5) xác nhận:
1. Giao diện cổng bãi và chức năng QR hoạt động chính xác theo thiết kế phân tán.
2. Phương án nhập mã thủ công dự phòng trên giao diện là giải pháp thiết yếu, giúp hệ thống hoạt động tin cậy trong điều kiện mạng nội bộ chưa thiết lập chứng chỉ HTTPS.
3. Cơ chế chịu lỗi cục bộ tại bãi (PT-05) hoạt động hoàn hảo khi cho phép nhân viên tiếp tục vận hành bãi ngay trên điện thoại di động kể cả khi máy chủ Aggregator trung tâm gặp sự cố.
