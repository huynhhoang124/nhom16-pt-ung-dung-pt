# Chia việc thành viên từ 01/11/2026

Nhóm 16 · Giai đoạn 2 · Người lập: Hoàng Văn Huynh

## Thay đổi so với bảng chia việc cũ

- Mỗi thành viên chỉ giữ những việc **code độc lập**: không phải chờ ai merge, làm được ngay hôm nay.
- Mọi việc người khác đang chờ, và mọi việc phải chờ việc khác xong mới làm được, Huynh làm hết.
- Huynh dùng lại code đã có trên các nhánh, giữ tên tác giả trong commit. Phần đã làm vẫn tính điểm cho người viết.
- **Từ hôm nay không sửa các nhánh sau nữa**, để tránh làm trùng:
  - `feature/PD-12-six-parking-rebased`
  - `hung-pd-03-request-reply`
  - `feature/PD-14a-db-replication-clean`
  - `feature/PD-14b-auto-failover-epoch`
  - `feature/PD-19-regional-aggregators`

Các việc Huynh nhận:

| Việc | Trước đây |
|---|---|
| PD-12 Mở rộng 6 bãi | Hiệp |
| PD-19 Aggregator theo vùng | Hiệp |
| PD-27 Đo trước/sau | Hiệp |
| PD-24 phần trace lệnh qua broker | Hiệp |
| PD-26 phần nemesis failover DB, treo leader | Hiệp |
| PD-03 Request–reply | Hùng |
| Nối PD-08, PD-04 vào PD-03; TC61 trên 6 bãi | Hùng |
| PD-14a Bản sao DB 6 bãi | Loan |
| PD-16 Phân mảnh `db-users` | Loan |
| PD-15 mở rộng ra 6 bãi | Loan |
| PD-14b Failover tự động | Luận |
| PD-07 Saga qua broker | Luận |
| PD-06 TTL lệnh, back-pressure | Trang |
| PD-25 Metrics, cảnh báo, dashboard | Trang |
| PD-21 Giới hạn đăng nhập | Trang |

## Quy tắc chung

- Mỗi việc một nhánh tạo từ `origin/dev` mới nhất, một PR vào `dev`. Không amend, không force-push.
- Trước khi báo xong:
  - Unit: `node --test --test-concurrency=2 test/*.test.js` đạt.
  - e2e cũ không đỏ.
  - Các test ở cột "Xong khi" đạt khi chạy lại trên Docker sạch (`down -v` trước).
  - Mô tả PR dán kết quả các test đó.
- Lỗi đã ghi trong `tai-lieu/nhan-xet-thanh-vien-gd2.md` phải sửa trước khi làm việc mới.

---

## Luận

| # | Việc | Làm gì | Xong khi |
|---|---|---|---|
| 1 | Sửa PD-10 | Xem chi tiết ở dưới bảng | TC43, TC44, TC65, TC66 cùng đạt một lượt; sau đó `/api/leader` chỉ 1 bản là leader |

Chi tiết việc 1, 4 lỗi cần sửa:
- `simulatePause` để lại 2 leader. Hẹn `setTimeout(handleLoseLeadership, durationMs)`, hoặc bỏ endpoint này.
- `finally` của TC65/66 tắt `aggregator-2`. Chỉ tắt nếu chính test đã bật nó.
- Mọi request đều mang fencing token. Chỉ gắn token khi có `job`.
- `parking-node/src/commands.js` thiếu kiểm fencing. Gọi `checkFencing` ngay sau `BEGIN`; token cũ thì ghi `409 STALE_LEADER` vào inbox.

## Hùng

| # | Việc | Làm gì | Xong khi |
|---|---|---|---|
| 1 | Sửa PD-02 (đã merge) | `command-replies.js:76`: gặp tin lỗi thì đánh dấu rồi đi tiếp, không `break`. `commands.js:151`: thời gian chờ reconnect tăng dần, tối đa 60 s | Unit test cho cả 2 trường hợp |
| 2 | PD-08 Retry, DLQ (#25) | Nhánh mới từ `dev`, lấy phần retry/DLQ từ `hung-pd-08-retry-dlq`. Nối thẳng vào consumer PD-02 trên `dev`. Xoá `scripts/pd08-pd02-integration.patch`, `retry-integration.js`. Test chạy trên stack thường, không cần `PD02_SOURCE_ROOT` | TC57, TC58 đạt |
| 3 | PD-04 Phát lệnh nhiều bãi (#21) | Nhánh mới từ `dev`. Xoá patch, `prepare-pd04-candidate.mjs`, `admin-integration.js`. Mở PR mới rồi đóng #53 | Phát lệnh tới A–C đạt trên trang Quản trị |

## Loan

| # | Việc | Làm gì | Xong khi |
|---|---|---|---|
| 1 | PD-17 HLC (#35) | Xem chi tiết ở dưới bảng | TC74 đạt với D lệch cả `+30000` và `-30000` |
| 2 | PD-05 SAC (#22) | Đo failover bằng Management API (`GET :15672/api/consumers/%2F`) hoặc bằng `processed_at`, không dùng `rabbitmqctl`. Chạy với 2 bản node thật `parking-a-1`/`parking-a-2` | TC60 PD-05 đạt 3 lần liên tiếp |
| 3 | Sửa PD-13 (đã merge) | `tc60.pd13.test.mjs` lấy tên container bằng `docker compose ps -q`. `docker-compose.pd13.yml` dùng `extends` | TC60 đạt khi đổi `COMPOSE_PROJECT_NAME` |
| 4 | PD-15 Đọc replica (#33), cho bãi A | Xem chi tiết ở dưới bảng. Dùng `db-a-replica` đã có ở profile `ha` | TC71: replica trễ 2 s, đặt chỗ rồi đọc ngay vẫn thấy |

Chi tiết việc 1 (PD-17):
- Aggregator `nodes.js` gửi header `x-hlc: hlc.now()`.
- Node: có `x-hlc` và `x-internal-key` thì gọi `hlc.update`.
- Thêm biến thể TC74 với D lệch `-30000`, xe vào D đi qua Aggregator.
- Sửa comment ở `slots.js:275` và thụt lề ở `commands.js:52`.

Chi tiết việc 4 (PD-15):
- `readThrough()` trong `db.js`: replica trễ quá 1 s thì đọc primary.
- Các API ghi trả header `X-LSN`. Frontend gửi lại `X-Min-LSN`, Aggregator chuyển tiếp xuống node.
- Node chỉ đọc replica khi replica đã theo kịp LSN đó.

## Trang

| # | Việc | Làm gì | Xong khi |
|---|---|---|---|
| 1 | PD-18 Relay (#36, đã merge) | LISTEN nối lại khi DB khởi động lại (bắt `end`/`error` của client). Tìm chỗ chậm: hiện đo được p50 37 ms | `restart db-c` rồi 40 sự kiện: ≥ 95% dưới 20 ms |
| 2 | PD-22 Replay stream (#40) | Rebase #58 lên `dev`, sửa TC37. Thêm `ch.on('error')`, timeout cho replay, bảng số đo có/không replay | e2e đạt hết; xoá stream thì Aggregator khởi động ≤ 10 s |
| 3 | PD-23 Thống kê CQRS (#41), làm sau việc 2 | Xem chi tiết ở dưới bảng | 150 phiên mẫu: số liệu khớp giữa `true` và `false`; `restart stats-service` không đếm trùng, không thiếu |
| 4 | PD-20 Hedged, ETag (#38) | `hedgedGet()` trong `nodes.js`: sau 120 ms chưa có kết quả thì gọi bản node thứ 2, huỷ bản chậm bằng `AbortController`, tự tắt khi số lần gửi thêm > 5%. `GET /api/parkings/:id` có `ETag`, trả 304 | p99 tra cứu giảm ≥ 30% khi một bản node chậm (đo bằng k6 + toxiproxy) |

Chi tiết việc 3 (PD-23):
- Bật `rabbitmq_stream`.
- `USE_STATS_SERVICE` mặc định `false`; stats-service lỗi thì quay về scatter–gather.
- Cộng doanh thu tiền mặt.
- Sự kiện thanh toán dùng `event_type` riêng.
- Ghi offset trong cùng giao dịch.
- Nhóm giờ theo `Asia/Ho_Chi_Minh`.
- Unit test `processEvent`.

## Hiệp

| # | Việc | Làm gì | Xong khi |
|---|---|---|---|
| 1 | PD-24 OpenTelemetry (#42), phần HTTP và sự kiện | Xem chi tiết ở dưới bảng | TC77: trace một lần đặt chỗ có đủ HTTP → DB → outbox → AMQP → Socket.IO; chụp ảnh vào PR |
| 2 | PD-26 Jepsen (#44), phần mạng và broker | Xem chi tiết ở dưới bảng | TC78 (phân hoạch Bắc–Nam 30 s) đạt 6/6 bất biến, có in seed; TC79 không mất lệnh đã confirm |

Chi tiết việc 1 (PD-24):
- Tạo nhánh mới từ `dev`. Chỉ lấy `tracing.js`, `otel-collector.yml`, `docker-compose.tracing.yml` từ `1ebd265`; không đụng `commands.js`, `saga.js`.
- Thêm cột `traceparent` vào outbox, `relay.js` đặt giá trị này vào header AMQP.
- Aggregator tạo span `socket.emit`; log ghi thêm `traceId`.

Chi tiết việc 2 (PD-26):
- Đăng thiết kế lên #44 trước.
- Tách `tests/jepsen/` ra nhánh mới từ `dev`; bỏ ghi đè `Date.now`.
- Sửa bất biến 4: gộp truy vấn mỗi DB thành 1 lần gọi; thêm bước thử lại `up`.
- Nemesis: phân hoạch Bắc–Nam, cô lập 1 nút RabbitMQ, mất 20% gói.
- Code và TC79 chạy được ngay trên 3 bãi. TC78 cần 6 bãi: PD-12 là việc đầu tiên Huynh merge. Trong lúc chờ, chạy thử trên nhánh `huynh/PD-12`.
