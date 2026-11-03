# PD-02 – Sửa phản hồi lỗi và reconnect (03/11/2026)

Việc 1 của Vũ Văn Hùng trong phân công từ 01/11 và nhận xét PD-02. Base dev
`4155051814f4df61e4df75dcb27f7b1e32553c5b`; không có AGENTS.md trong repo/ancestor.
Không cần chờ Huynh duyệt theo chỉ thị người dùng. Không sửa nhánh PD-03.

Remote/local đã có ref `hung`, Git cấm đồng thời `hung` và `hung/...`.
Giữ nguyên ref đó, tạo `hung-fix-pd02-replies-reconnect` từ dev trong worktree riêng.
Không tạo PR trùng, không amend/force-push. Workspace gốc có thay đổi được giữ nguyên.

## Nguyên nhân và sửa

- `command-replies.js`: `false` gộp mandatory return với lỗi hạ tầng; `break`
  khiến row không có binding chặn các row sau. Giữ API boolean `publish` cho caller
  cũ; relay dùng `publishDetailed` phân biệt kết quả, vẫn dùng confirm channel chung.
- `REPLY_UNROUTABLE` và `REPLY_INVALID_RECORD` là lỗi từng row: lưu trạng thái lỗi,
  hẹn lại sau 30 giây, tiếp tục batch. Nack/disconnect/timeout/setup hoặc DB lỗi ảnh
  hưởng lượt hiện tại nên dừng lượt. Lỗi DB/unexpected publisher exception được
  cơ chế background task hiện có ghi log; row không mất và không được đánh dấu sent.
- Chỉ confirm thành công không có return mới đặt `published_at`. Giữ messageId,
  correlationId và payload/properties gốc để retry cùng phản hồi; kết quả vẫn là
  at-least-once nếu crash sau confirm trước cập nhật DB.
- Migration additive `ADD COLUMN IF NOT EXISTS`: `attempts INT NOT NULL DEFAULT 0`,
  `last_attempt_at TIMESTAMPTZ`, `last_error TEXT`, `next_attempt_at TIMESTAMPTZ`.
  Không drop/rewrite dữ liệu. Lỗi chỉ lưu mã cố định, không lưu secret/raw error.
  Các row đang chờ retry được loại khỏi batch 100 để không che row hợp lệ phía sau.
- `commands.js`: giữ một vòng reconnect, chờ handler connection cũ kết thúc;
  chờ 5000, 10000, 20000, 40000, 60000 ms rồi giữ trần. Reset sau khi các consumer
  cần thiết đã setup xong; TCP nối được nhưng thiếu queue vẫn tăng backoff.
  Timer retry được inject trong test; shutdown hủy timer, đóng connection tới muộn,
  không thêm consumer. Listener error/close được gắn trước checkQueue bắt buộc để
  RabbitMQ 404 không gây unhandled error. Handler/inbox/commit/ack không đổi.

Xem lỗi chưa gửi bằng truy vấn chỉ metadata:

```sql
SELECT id, command_id, reply_to, attempts, last_error, last_attempt_at, next_attempt_at
FROM command_reply_outbox WHERE published_at IS NULL ORDER BY id;
-- Sau khi sửa đúng binding/record, dùng parameter id cụ thể để thử ngay:
UPDATE command_reply_outbox SET next_attempt_at=now() WHERE id=$1 AND published_at IS NULL;
```

Không xóa row lỗi hoặc đặt published_at thủ công để làm sạch hàng. Đây là retry
của reply outbox hiện có, không phải triển khai retry/DLQ lệnh PD-08.

## Cách chạy lại

Ở mỗi service parking-node, aggregator-service, notification-service:
`node --test --test-concurrency=2 test/*.test.js`. CI backend cũng dùng concurrency 2.

Docker sạch dùng project riêng, image riêng, volume theo project và chỉ bind cổng
loopback: API 18000, bãi 18001–18003, frontend 13000, broker 5674/15674, DB A 25432.
Không thay cổng hoặc volume stack đang dùng. Tạo .env từ .env.example chỉ trong
checkout test mới; `node scripts/gen-keys.mjs` sinh khóa demo trong .env bị gitignore.

```powershell
$env:COMPOSE_PROJECT_NAME='pd02-fix-20261103'
$env:COMPOSE_FILE='docker-compose.yml;tests/pd02-fixes.compose.yml'
docker compose build parking-a aggregator frontend notification pd02-unit
docker compose up -d --no-build --wait rabbitmq parking-a parking-b parking-c aggregator frontend notification
docker compose run --rm --no-deps pd02-unit
$env:RUN_PD02_FIXES='1'
$env:PD02_AMQP_URL='amqp://parking:parking@localhost:5674/%2F'
node --test tests/pd02-replies-reconnect.e2e.mjs
$env:COMMAND_MODE='http'
$env:AGGREGATOR_URL='http://localhost:18000'
$env:PARKING_BASE_PORT='18001'
$env:FRONTEND_URL='http://localhost:13000'
node --test tests/e2e.test.mjs
docker compose stop # giữ volume; chỉ down -v sau xác minh dưới đây
```

Linux dùng `:` cho COMPOSE_FILE. PARKING_BASE_PORT mới chỉ cấu hình harness cũ;
default 8001 và hành vi/assert e2e được giữ nguyên.

Trước mọi `down -v`: kiểm tra `docker compose ls`, tên container/volume và label
`com.docker.compose.project` đều đúng project test mới tạo; với volume còn kiểm tên
bắt đầu `pd02-fix-20261103_`. Nếu bất kỳ tài nguyên nào không khớp thì dừng cleanup.
Lệnh thực tế chỉ dùng `docker compose -p pd02-fix-20261103 down -v`, không dùng
project mặc định, không xóa image hoặc volume của project khác.

## Bằng chứng và phạm vi

- Unit host Parking Node: 94 đạt, 1 integration PostgreSQL opt-in skip.
- Unit Docker Linux Node 22 trên source cuối: 94 đạt, 1 opt-in skip, concurrency 2.
- Unit host Aggregator: 83 đạt, 3 integration opt-in skip; notification: 2/2.
- Hồi quy toàn bộ `tests/e2e.test.mjs`, COMMAND_MODE=http: 17 đạt, 21 skip theo
  mode/profile, 0 lỗi. Có TC52 10 bản giao lại/10 phản hồi, TC53 crash sau COMMIT
  trước ack và test PostgreSQL nhiều transaction client thật. TC46 với RS256 đạt.
- Lượt xác nhận cuối sau down -v đúng project mới tạo và khởi tạo volume trắng:
  broker regression 2/2, e2e cũ 17 đạt/21 skip/0 lỗi (106502 ms). Trước mỗi lần
  làm sạch đã kiểm label của 11 container và 5 volume đều thuộc pd02-fix-20261103.
  Cleanup cuối chỉ dọn tài nguyên này; stack đang dùng và dữ liệu gốc được giữ nguyên.
- Broker/Postgres thật trên Docker sạch: 2/2 đạt. Tin NO_ROUTE giữ nguyên pending,
  tin sau gửi được, sửa binding thì row lỗi gửi lại thành công. Queue thiếu thật
  phát channel.error, clock kiểm 5/10/20/40/60/60 giây, reset và dừng không reconnect;
  sau shutdown cả hai queue test đều có consumerCount=0.
- Test có cả migrate outbox cũ còn dữ liệu, 100 row lỗi không chặn batch sau,
  lỗi DB/nack/disconnect, return/confirm đồng thời, shutdown khi connect còn pending.
- Lần broker test đầu chờ log consumer thường quá sớm khi admin chưa setup xong;
  test đã chờ cả hai consumer trước khi kiểm reset. Không sửa production để lách test.
- Lần full unit Docker đầu thiếu file producer/log/Compose mà test cũ đọc; đã bổ
  sung đúng các file vào image test, giữ toàn bộ assertions và chạy lại.
- Lượt e2e cũ đầu trượt TC52 sau restart broker: lệnh TTL 10 giây được gửi khi
  consumer còn backoff 20 giây, trước lúc consumer ready. Setup broker TC52/53
  giờ đợi consumer thật qua checkQueue (tối đa 90 giây); không tăng TTL, không đổi
  kiểm chứng một hiệu lực/10 phản hồi, không chỉ dựa readiness HTTP.

Các nhận xét PD-03/04/08 trong cùng bảng là việc riêng, không thực hiện ở PR này.
Các số dòng review cũ đã dịch chuyển (consumer hiện ở khoảng 170), nhưng hai lỗi
vẫn tồn tại trên base dev và được kiểm theo hành vi. Các mục lịch sử “PD-03 chưa có”
không còn phản ánh dev; không chỉnh phần request-reply đã chuyển cho Huynh.

Chưa kiểm chứng trong việc 1: các nhánh HA/coord/scale/sharding và HTTP broker
opt-in của e2e, TC51/54/62 PD-03, TC57/58 PD-08 hoặc TC61 PD-04. Không lấy các
skip đó làm bằng chứng đạt. Raw log chỉ lưu cục bộ ngoài Git; PR dán số liệu tóm tắt,
không commit .env, khóa RS256, database dump hay log chứa dữ liệu nhạy cảm.
