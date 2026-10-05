# Tiến độ và bàn giao – Nhóm 16

**Cập nhật:** 05/10/2026 (chiều) · Dùng để chia việc lại và để mở đoạn chat mới với Claude (đọc file này trước).

## 1. Trạng thái nhánh
- Nhánh `dev` đã push lên GitHub; CI (test unit + build frontend + e2e trên Docker) **xanh**.
- Lần đầu chạy Docker sau khi kéo bản này: `cp .env.example .env` rồi `docker compose down -v`.
- Bật profile `ha` thì bỏ dấu `#` ở 2 dòng `A_READ_DATABASE_URL`, `RABBITMQ_URL` trong `.env`; không bật `ha` thì để nguyên
  (để sẵn địa chỉ máy không tồn tại làm hệ thống chậm, xem mục 5).

## 2. Đã code xong và đã chạy thật trên Docker (32/32 việc)

| Việc | Kiểm chứng |
|---|---|
| NV-01..09, PT-04, PT-05, PT-07, GS-01, GS-03, GS-07, UX-01..04 | test unit + thử trình duyệt (camera QR chưa thử: máy test không có camera) |
| GS-02 e2e | 10/10 trên Docker, 3 lần liên tiếp; cũng đạt khi bật `ha` và khi bật chaos (`CHAOS=1`, thêm TC47 = 11 test); đạt trên CI |
| PT-01 nhiều Aggregator | tắt `aggregator` -> web qua nginx vẫn 200 |
| PT-02 bản sao DB A | `pg_stat_replication` = streaming/async, `replication_lag_seconds` = 0 |
| PT-03 cụm RabbitMQ | 3 nút, quorum queue đủ 3 bản; tắt `rabbitmq` -> sự kiện vẫn đi qua nút 2/3, outbox không ứ |
| PT-06 mạng xấu | `net.mjs B latency 1500` vẫn ONLINE (~1,9 s); `3500` -> timeout, dữ liệu cũ; `down` -> OFFLINE; `reset` -> ONLINE |
| GS-04 Prometheus/Grafana | 8 target up (2 Aggregator, 3 bãi, 3 nút RabbitMQ); dashboard đủ số liệu |
| GS-05 k6 (250 người, 30 s) | ~470 req/s, lỗi 0%, p95 tra cứu 234 ms, đặt chỗ 245 ms; bất biến đạt |
| GS-06 hỗn loạn (3 phút, tắt/bật ngẫu nhiên bãi B, rabbitmq-2, aggregator) | 86 959 request, lỗi 0,05%, p95 < 400 ms; mọi bất biến đạt (không đặt trùng, outbox về 0) |

Test unit: parking-node 46, aggregator-service 29, notification-service 2 — đạt hết; frontend build được.

## 3. Lỗi tìm ra khi chạy thật (đã sửa, để nhóm hiểu và kể trong báo cáo)
1. Aggregator không khởi động: biến `instance` dùng trước khi khai báo.
2. RabbitMQ nút gốc chờ ~3 phút tìm nút 2/3 khi không bật `ha`; healthcheck `ping` báo khoẻ khi broker chưa chạy.
3. Quorum queue tạo lúc cụm có 1 nút chỉ có 1 bản -> tắt `rabbitmq` là mất queue. Sửa: `rabbitmq/quorum.conf` tự bổ sung đủ 3 bản.
4. Khởi động lại cả cụm RabbitMQ kẹt (nút gốc chờ nút 2/3, nút 2/3 `depends_on` chờ nút gốc).
5. Bãi A chậm 2 s mỗi lần đọc: luôn trỏ tới bản sao DB kể cả khi không bật `ha`.
6. **Tra DNS nghẽn:** Node tra DNS trên thread pool 4 luồng. Tên không tồn tại (rabbitmq-2/3) mất ~3,6 s; 250 người vào cùng lúc
   = vài trăm lần tra (375 lần = 4,2 s) -> vượt timeout 2 s -> Aggregator báo cả 3 bãi OFFLINE dù bãi khoẻ (k6 lỗi 3,14%).
   Sửa: Aggregator tra tên bãi -> IP mỗi vòng health check, gọi thẳng IP (k6 lỗi 0%).
7. Thanh toán: key đã dùng cho phiên khác trả lại kết quả của phiên kia như thể đã trả -> nay trả 422 `IDEMPOTENCY_KEY_REUSED`.
8. `net.mjs latency` đặt cả 2 chiều nên 1500 thành ~3 s; dashboard Grafana nhân đôi ô trạng thái; Prometheus lấy số ngẫu nhiên 1 trong 2 Aggregator.
9. Test e2e chập chờn: biển số cố định (lần chạy hỏng trước để xe trong bãi), sự kiện test trước đến muộn, kết nối keep-alive cũ trên CI.

## 4. Việc tiếp theo (ưu tiên)
1. Việc của người không code (đánh dấu **[Tên]** trong `danh-sach-viec-nho.md`): ghi số liệu test tải/mạng xấu/hỗn loạn chạy lâu hơn (Trang, `MINUTES=10 node tests/chaos.mjs`),
   tập failover DB theo `runbook-failover.md` (Loan + Hùng — runbook chưa ai chạy thử), sơ đồ mới + báo cáo + slide (Hiệp).
2. Thử giao diện trên bản Docker (bản trước chỉ thử bản không Docker), đặc biệt màn hình cổng + QR bằng điện thoại thật.
3. Mỗi người đọc hiểu phần code của mình (bảng "Ai" trong plan) — code do Claude viết, người phụ trách phải giải thích được.
4. Mở PR `dev` -> `main` khi nhóm xem xong.

## 5. Cách chạy nhanh
- Không Docker (làm giao diện): `node scripts/dev-no-docker.cjs` + `cd frontend && npm run dev` → http://localhost:3000
- Docker: `docker compose up -d --build` → `node --test tests/e2e.test.mjs`. Profile: `ha`, `obs` (Grafana :3001), `extra`, mạng xấu
  `-f docker-compose.yml -f docker-compose.chaos.yml --profile chaos` (xem README).
- Tài khoản demo (mật khẩu 123456): user1, user2, staff-a/b/c, admin.

## 6. Quyết định kỹ thuật đáng nhớ
- Gỡ slot = trạng thái `HIDDEN`; chống chồng giờ = ràng buộc `EXCLUDE` (btree_gist); 5 phút đầu miễn phí.
- JWT RS256 khi có `JWT_PRIVATE_KEY_B64` (sinh bằng `node scripts/gen-keys.mjs`), không có thì HS256.
- Nhiều Aggregator: mỗi bản 1 queue riêng `aggregator.slot-updates.<INSTANCE_ID>`, Socket.IO chỉ websocket, không Redis.
- Thông báo: `notification-service` (rules.js thuần) → exchange `user.notifications` → Socket.IO phòng `user:<id>`.
- Địa chỉ chỉ có khi bật `ha` (bản sao DB, rabbitmq-2/3) nằm trong `.env`, không viết cứng trong compose.
- Aggregator gọi bãi bằng IP (tra lại mỗi 5 s), không tra DNS mỗi request.
