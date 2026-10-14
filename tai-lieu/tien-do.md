# Tiến độ và bàn giao – Nhóm 16

**Cập nhật:** 14/10/2026 · Dùng để chia việc lại và để mở đoạn chat mới với Claude (đọc file này trước).

## 1. Trạng thái nhánh
- Nhánh `dev` đã push lên GitHub; CI (test unit + build frontend + e2e trên Docker) **xanh**.
- Lần đầu chạy Docker sau khi kéo bản này: `cp .env.example .env` rồi `docker compose down -v`.
- Bật profile `ha` thì bỏ dấu `#` ở 2 dòng `A_READ_DATABASE_URL`, `RABBITMQ_URL` trong `.env`; không bật `ha` thì để nguyên
  (để sẵn địa chỉ máy không tồn tại làm hệ thống chậm, xem mục 5).

## 2. Đã code xong và đã chạy thật trên Docker (32/32 việc)

| Việc | Kiểm chứng |
|---|---|
| NV-01..09, PT-04, PT-05, PT-07, GS-01, GS-03, GS-07, UX-01..04 | test unit + thử trình duyệt (camera QR chưa thử: máy test không có camera) |
| GS-02 e2e | 15 test. Không `ha`: 12 đạt (TC46 cần khoá RS256, CI tự sinh bằng `gen-keys.mjs`); `HA=1` với `--profile ha`: 14 đạt, thêm TC43, TC44; TC47 cần `CHAOS=1` |
| PT-01 nhiều Aggregator | tắt `aggregator` -> web qua nginx vẫn 200 |
| PT-02 bản sao DB A | `pg_stat_replication` = streaming/async, `replication_lag_seconds` = 0 |
| PT-03 cụm RabbitMQ | 3 nút, quorum queue đủ 3 bản; tắt `rabbitmq` -> sự kiện vẫn đi qua nút 2/3, outbox không ứ |
| PT-06 mạng xấu | `net.mjs B latency 1500` vẫn ONLINE (~1,9 s); `3500` -> timeout, dữ liệu cũ; `down` -> OFFLINE; `reset` -> ONLINE |
| GS-04 Prometheus/Grafana | 8 target up (2 Aggregator, 3 bãi, 3 nút RabbitMQ); dashboard đủ số liệu |
| GS-05 k6 (250 người, 30 s) | Chạy trên Linux: ~470 req/s, lỗi 0%, p95 tra cứu 234 ms, đặt chỗ 245 ms; bất biến đạt. Lượt 2 phút của Hiệp trên Windows chưa dùng được (đồng hồ Docker lệch), xem `ket-qua-test-tai.md` |
| GS-06 hỗn loạn (3 phút, tắt/bật ngẫu nhiên bãi B, rabbitmq-2, aggregator) | 86 959 request, lỗi 0,05%, p95 < 400 ms; mọi bất biến đạt (không đặt trùng, outbox về 0) |

Test unit: parking-node 46, aggregator-service 29, notification-service 2 — đạt hết; frontend build được.

## 2b. Phần thành viên đã gộp (12/10)

| Người | Việc | Ghi chú |
|---|---|---|
| Loan | PT-01.7 (TC43, TC44), PT-01.8 (ảnh `tai-lieu/anh/`), PT-05.6 (TC46) | TC45 đã có trong test unit `parking-node/test/app.test.js` |
| Trang | K.9 mẫu PR, PT-04.6 lý thuyết circuit breaker / retry | |
| Hiệp | UX-02.8 ảnh khi bãi B tắt, chẩn đoán GS-05 (log request chậm trong `k6.js`) | GS-05.3–5 cần chạy lại sau khi sửa đồng hồ Docker |

Sửa thêm khi gộp: TC46 bỏ qua khi chưa có khoá RS256, lấy slot sau khi dừng Aggregator (kết nối keep-alive cũ),
để xe trong bãi rồi kiểm Aggregator thấy OCCUPIED (trước đó slot về AVAILABLE nên test luôn qua).

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
9. **Node / Aggregator sập khi DB mất kết nối** (pool `pg` không bắt sự kiện `error`): tắt hay khởi động lại DB một bãi là node bãi đó
   chết luôn. Tìm ra khi tập failover. Đã sửa + thêm test e2e "DB bãi C khởi động lại".
10. Runbook failover: `docker compose up -d parking-a` bật lại db-a cũ (do `depends_on`) -> phải dùng `--no-deps`. Node A trỏ DB qua
   biến `A_DATABASE_URL` trong `.env` thay vì sửa compose. Đã tập trọn runbook: OFFLINE sau ~19 s, ONLINE lại ~12 s sau bước 3.
11. Test e2e chập chờn: biển số cố định (lần chạy hỏng trước để xe trong bãi), sự kiện test trước đến muộn, kết nối keep-alive cũ trên CI.
12. **Cụm RabbitMQ tách khi dựng mới** (`down -v` rồi `--profile ha up`): nút 2/3 khởi động lúc nút gốc chưa lên thì tự lập
   cụm riêng (`classic_config` là danh sách cố định nên `discovery_retry_limit` không giữ lại được). Tắt `rabbitmq` lúc đó
   thì quorum queue chỉ còn 1/3 bản -> outbox ứ. Sửa: `rabbitmq/join-wait.sh` cho nút mới chờ nút gốc mở cổng 5672;
   nút đã có dữ liệu chạy ngay (tránh lỗi 4). 5/5 lần dựng mới đủ 3 nút; e2e `HA=1` đạt ngay lượt đầu.

## 4. Việc tiếp theo (ưu tiên)
1. Việc của người không code (đánh dấu **[Tên]** trong `danh-sach-viec-nho.md`): ghi số liệu test tải/mạng xấu/hỗn loạn chạy lâu hơn (Trang, `MINUTES=10 node tests/chaos.mjs`),
   tập failover DB theo `runbook-failover.md` (Loan + Hùng — Claude đã chạy thử và sửa runbook, nhóm tập lại và bấm giờ), sơ đồ mới + báo cáo + slide (Hiệp).
2. Thử giao diện trên bản Docker (bản trước chỉ thử bản không Docker), đặc biệt màn hình cổng + QR bằng điện thoại thật.
3. Mỗi người đọc hiểu phần code của mình (bảng "Ai" trong plan) — code do Claude viết, người phụ trách phải giải thích được.
4. Còn mở theo bảng phân công tuần 1–2: bảng TC01–TC55 `bang-test.md` (Trang), TL-01 sửa HLD (Hiệp), bảng giá + dữ liệu mẫu (Loan);
   Hùng, Luân đọc hiểu và nhận phần code của mình (việc 3 ở trên).

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
