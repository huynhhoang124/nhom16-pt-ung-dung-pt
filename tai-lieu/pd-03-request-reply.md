# PD-03 – Request–reply và theo dõi trạng thái lệnh

Theo Issue #20, kế hoạch giai đoạn 2 bản 1.4 mục 5.2–5.4/5.9 và phụ lục C.
[Thiết kế cuối cùng](pd-03-design.md). Người dùng đã miễn bước chờ duyệt trong chat;
không có bằng chứng Huynh duyệt thiết kế trong Issue, không tự đăng bình luận.

## Dependency và phạm vi

PD-01/PD-02 đã merge vào dev. Nhánh/PR #52 hiện hữu đã nhận dev mới tại `4cf3e26`,
giữ lifecycle discovery/config/leader, scheduled jobs và relay của các phần đã merge.
Đã bỏ `scripts/pd03-pd02-reply.patch`; hook enrichReply được gọi trực tiếp trong
processor inbox, trước INSERT outbox và COMMIT. Test dùng entrypoint thật trong repo,
không cần checkout PD-02 riêng hoặc ghép candidate.

PD-08 #49 và bản sửa relay/backoff PD-02 #66 chưa merge. Không lấy code các PR đó.
PD-03 chuẩn bị deadline đã lưu và reply ký xác thực; khi nhận PD-08 phải giữ nguyên
issuedAt/deadlineAt khi retry và nối kết quả thất bại có bằng chứng. Chưa có consumer
EXPIRED của PD-06 hoặc tích hợp terminal từ DLQ; không tuyên bố hoàn tất TTL toàn hệ thống.

## Định danh và trạng thái

`commandId = messageId = correlationId = <userId>:<Idempotency-Key>` duy nhất toàn
bộ bãi/loại lệnh trong DB Aggregator chung. Key 1–64 ký tự, full ID tối đa 128.
Hash bãi/type/actor server/payload; retry cùng nội dung trả cùng ID/kết quả,
dùng key cho nội dung khác trả 422 IDEMPOTENCY_KEY_REUSED. Hủy thiếu key dùng
`cancel-<reservationId>` để tương thích client cũ. Actor do JWT server xác lập.

| Trạng thái | Ý nghĩa |
|---|---|
| PENDING | Intent đã lưu; có thể đang gửi, đã confirm hoặc chưa rõ kết quả publish |
| DONE | Reply nghiệp vụ thành công đã được ghi DB |
| FAILED | Lỗi nghiệp vụ đã lưu, hoặc gửi bị từ chối chắc chắn |
| EXPIRED | Dành cho bằng chứng hết hạn từ PD-06; không suy ra từ HTTP timeout |

FAILED_TO_SEND là `status=FAILED`, `failure_phase=SEND`, `publish_state=REJECTED`,
trả thêm sendStatus; không thêm trạng thái chính thứ năm. Chỉ dùng khi chưa từng
có publish không rõ kết quả. Disconnect/mất confirm giữ PENDING/UNKNOWN, không
cho tạo ID mới. Retry chủ động lỗi gửi chắc chắn, còn deadline, mở lại cùng row/ID.
Reply terminal nghiệp vụ không bị duplicate/xung đột ghi đè.

Ghi intent trước publish. Worker claim bằng DB lease rồi I/O ngoài transaction;
crash trước/sau publish được phục hồi cùng ID/deadline, inbox PD-02 chặn lặp.
Mất ACK DB sau INSERT trả 503 COMMAND_PERSISTENCE_UNKNOWN kèm ID và unknown=true:
frontend vẫn theo dõi ID đó, không coi là chắc chắn chưa gửi.

## Queue, instance và failover

AGGREGATOR_ID ưu tiên, fallback INSTANCE_ID, mặc định 1; Compose gán 1/2 riêng.
Canonical ID dùng cho reply, events, x-instance, metric và leader. Lease DB ngăn
hai tiến trình cùng ID; heartbeat 5 s, lease 15 s; restart sau SIGKILL có thể chờ
lease tối đa khoảng 20 s. Đây không thay thế fencing PD-10.

parking.replies direct durable. `agg.replies.<id>` durable quorum có
`x-message-ttl=60000`, binding `agg.<id>`. Queue `agg.replies.recovery` durable quorum
không TTL cũng bind từng `agg.<id>` trước khi cho publish. Mọi instance consume
recovery cạnh tranh: sender chết thì instance còn lại vẫn cập nhật commands terminal.
Queue riêng có thể tạo bản sao trong 60 s; DB dedup. Recovery giữ tin cả khi toàn
bộ instance tắt quá 60 s; cần giám sát dung lượng, không có back-pressure PD-06 ở đây.

Consumer kiểm chữ ký HMAC, command/correlation/bãi/type/actor; lưu DB trước ack.
Redelivery sau lỗi notify có thể phát lại COMMAND_RESULT, client đọc kết quả DB.
Node thêm slot/status/version và ký trong cùng transaction inbox/outbox; cache chỉ
nhận version cao hơn. PostgreSQL LISTEN/NOTIFY báo các instance; socket chỉ emit
đến user_id lấy từ commands, không broadcast kết quả nghiệp vụ.

## API và frontend

```text
POST   /api/parkings/:id/reservations       Idempotency-Key bắt buộc
DELETE /api/parkings/:id/reservations/:rid   key tùy chọn, fallback ổn định
POST   /api/me/sessions/:id/:sid/pay         Idempotency-Key bắt buộc
GET    /api/commands/:commandId             owner hoặc ADMIN
```

Có kết quả trong REPLY_WAIT_MS: trả mã/body nghiệp vụ 201/200/409/... và commandId.
Chưa có: HTTP 202, Location trỏ GET và `{commandId,status:PENDING,publishState}`.
Một pending Map với vòng quét 100 ms; shutdown trả 202 cho waiter, không khẳng định
thất bại. GET từ bất kỳ instance đọc DB chung, người khác 404, chưa đăng nhập 401;
không trả payload/actor/chữ ký nội bộ.

Frontend commandRequest hiện Đang xử lý sau 202, nhận COMMAND_RESULT và polling
GET khi mất socket/reload. Nếu ACK lưu intent chưa rõ, form cho thử lại cùng key trong khi tracker vẫn theo dõi ID. Giữ key cho cùng thao tác đang chờ; tracker lưu ID/key/
fingerprint theo user, không lưu payload hoặc result nhạy cảm. traceparent hợp lệ
được giữ qua command, reply outbox và reply; không tạo span của PD-24.

## Schema và nâng cấp

commands: id, parking_id, type, user_id, status, result JSONB, created_at, updated_at;
bổ sung status_code, request_hash, payload/actor/envelope JSONB, correlation_id,
reply_to, publish_state, publish_owner/lease, next_publish_at, attempts, uncertain,
failure_phase, last_error, reply_hash, slot JSONB. Index pending publish và user.
aggregator_instances giữ id/owner/lease_until. Không thay schema inbox PD-02.

Init tạo bảng mới hoặc ADD COLUMN IF NOT EXISTS cho commands tối thiểu đã có;
không drop/ghi đè kết quả. Row PENDING cũ thiếu metadata giữ UNKNOWN/uncertain,
không tự publish vì không chứng minh được trước đó đã gửi hay chưa. Phải đối chiếu
inbox/nguồn gửi trước khi phục hồi những row legacy đó. Migration chạy lặp được.

Vhost tiếp tục `/`, URI `/%2F`; INTERNAL_KEY thống nhất backend, không commit secret.
Queue reply cũ khác args: không xóa để né PRECONDITION_FAILED. Dừng publisher liên
quan, kiểm kê ready/unacked/binding, chuyển có confirm sang đích durable, đối chiếu
ID/count trước cutover trong cửa sổ bảo trì. Export definitions không sao lưu payload.

Hoàn tác bằng COMMAND_MODE=http cho yêu cầu mới; giữ DB/queues/intents và ít nhất
một worker broker để xả backlog có kiểm soát. Không DROP commands hoặc purge queue.

## Cấu hình và kiểm thử

```dotenv
COMMAND_MODE=broker
AGGREGATOR_ID=1
REPLY_WAIT_MS=3000
COMMAND_TTL_MS=10000
```

COMMAND_MODE mặc định broker theo chỉ thị hiện tại và phụ lục C. CI `command-broker`
kiểm đường broker trên mỗi PR; CI E2E cũ vẫn chạy COMMAND_MODE=http. TTL per-message
lấy phần deadline còn lại; republish không cấp lại 10 s. PD-06 chưa có: cmd.expired
và lỗi DLQ chưa cập nhật terminal đầu-cuối; timeout reply không đổi PENDING thành
EXPIRED, chưa có cam kết deadline tại COMMIT/clock skew.

```powershell
npm ci --prefix parking-node
npm ci --prefix aggregator-service
npm ci --prefix frontend
npm ci --prefix notification-service
npm test --prefix parking-node
npm test --prefix aggregator-service
npm test --prefix frontend
npm run build --prefix frontend

# Stack riêng, hai Aggregator; broker 5673/15673, aggregator-2 ở 8100.
$env:COMPOSE_PROJECT_NAME='pd03-review-1101'
$env:COMPOSE_FILE='docker-compose.yml;tests/pd03-compose.test.yml'
docker compose build parking-a aggregator frontend notification
$env:COMMAND_MODE='http'
$env:PD02_AMQP_URL='amqp://parking:parking@localhost:5673/%2F'
docker compose up -d --no-build --wait
node --test tests/e2e.test.mjs
$env:COMMAND_MODE='broker'
docker compose up -d --no-build --wait
$env:PD03_BROKER='1'
$env:PD03_AMQP_URL='amqp://parking:parking@localhost:5673/%2F'
node --test tests/command-flow.e2e.mjs
$env:PD03_HTTP_COMMANDS='1'
node --test tests/command-inbox-http.test.mjs
docker compose stop   # giữ volume
```

Tạo .env từ .env.example chỉ lần đầu, không ghi đè cấu hình đang dùng. COMPOSE_FILE
trên Linux dùng dấu `:` thay `;`. TC51 đo response thật <=3 s và đọc trace/correlation
trên reply; TC52 kiểm 10 HTTP request/1 hiệu lực; TC54 dừng bãi 5 s; TC62 SIGKILL
sender trước reply và yêu cầu aggregator-2 đọc DONE thật, có Socket.IO.
Kết quả mới trong [pd-03-review-2026-11-01.txt](pd-03-review-2026-11-01.txt).
Các pd-03-*-e2e.log/evidence.md và ảnh ngày 22/10 là bằng chứng lịch sử trên candidate,
không thay cho kết quả entrypoint thật mới.
