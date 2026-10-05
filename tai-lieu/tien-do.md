# Tiến độ và bàn giao – Nhóm 16

**Cập nhật:** 05/10/2026 · Dùng để chia việc lại và để mở đoạn chat mới với Claude (đọc file này trước).

## 1. Trạng thái nhánh
- Nhánh `dev` dưới máy **đi trước `origin/dev` 30+ commit, CHƯA push**: token `gh` thiếu quyền `workflow` nên GitHub chặn file CI.
  Sửa: `gh auth refresh -s workflow` rồi `git push origin dev`.
- Lần đầu chạy Docker sau khi kéo bản này: `cp .env.example .env` rồi `docker compose down -v` (schema đặt chỗ đổi, queue đổi sang quorum).

## 2. Đã code xong (32/32 việc trong `ke-hoach-chi-tiet-ban-hoan-chinh.md`)

| Việc | Kiểm chứng |
|---|---|
| NV-01..09 (khung giờ, loại xe/tầng, phí, thanh toán, QR, phiên/lịch sử, đăng ký, thông báo, quản lý slot) | test unit + thử trên trình duyệt (bản không Docker) |
| PT-04 breaker/retry, PT-05 nhân viên khi trung tâm sập, PT-07 Saga | test unit + thử trình duyệt |
| GS-01 CI, GS-03 log/mã truy vết, GS-07 bảo mật | test unit |
| UX-01 bản đồ, UX-02 thống kê, UX-03 giao diện, UX-04 cổng | thử trình duyệt (camera QR chưa thử: máy test không có camera) |
| PT-01 nhiều Aggregator, PT-02 bản sao DB, PT-03 cụm RabbitMQ, PT-06 toxiproxy, GS-02 e2e CI, GS-04 Prometheus/Grafana, GS-05 k6, GS-06 hỗn loạn | **chỉ kiểm `docker compose config` + test unit phần code; CHƯA chạy thật trên Docker** |

Test hiện tại: parking-node 45, aggregator-service 28, notification-service 2 — đạt hết; frontend build được.
Test e2e (`tests/e2e.test.mjs`) đã sửa theo code mới nhưng **chưa chạy lại** từ NV-02.

## 3. Việc tiếp theo (ưu tiên)
1. **Chạy trên Docker và sửa lỗi** (Huynh/Trang): `docker compose up -d --build` → `node --test tests/e2e.test.mjs`.
   Rồi lần lượt thử profile `ha` (aggregator-2, rabbitmq-2/3, db-a-replica), `obs` (Grafana :3001), chaos (`scripts/net.mjs`).
   Điểm dễ lỗi nhất: cụm RabbitMQ (hostname/cookie), `postgres/replica-entrypoint.sh`, nginx chia tải theo DNS khi có 2 Aggregator.
2. Việc của người không code (đánh dấu **[Tên]** trong `danh-sach-viec-nho.md`): chạy test tải/mạng xấu và ghi số liệu (Trang),
   tập failover theo `runbook-failover.md` (Loan + Hùng), sơ đồ mới + báo cáo + slide (Hiệp).
3. Mỗi người đọc hiểu phần code của mình (bảng "Ai" trong plan) — code do Claude viết, người phụ trách phải giải thích được.

## 4. Cách chạy nhanh
- Không Docker (làm giao diện): `node scripts/dev-no-docker.cjs` + `cd frontend && npm run dev` → http://localhost:3000
- Docker: xem README (profile `ha`, `obs`, `extra`, `docker-compose.chaos.yml`).
- Tài khoản demo (mật khẩu 123456): user1, user2, staff-a/b/c, admin.

## 5. Quyết định kỹ thuật đáng nhớ
- Gỡ slot = trạng thái `HIDDEN`; chống chồng giờ = ràng buộc `EXCLUDE` (btree_gist); 5 phút đầu miễn phí.
- JWT RS256 khi có `JWT_PRIVATE_KEY_B64` (sinh bằng `node scripts/gen-keys.mjs`), không có thì HS256.
- Nhiều Aggregator: mỗi bản 1 queue riêng `aggregator.slot-updates.<INSTANCE_ID>`, Socket.IO chỉ websocket, không Redis.
- Thông báo: `notification-service` (rules.js thuần) → exchange `user.notifications` → Socket.IO phòng `user:<id>`.
