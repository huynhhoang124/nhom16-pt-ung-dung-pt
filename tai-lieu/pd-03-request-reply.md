# PD-03 — Request–reply và theo dõi trạng thái lệnh

## Dependency và trạng thái bàn giao

Nhánh PD-03 bắt đầu từ origin/dev 0f8eae8 (PD-01 đã merge). PD-02 #48 và PD-08 #49
chưa merge tại thời điểm thực hiện. Không chép consumer/inbox/retry vào PR PD-03.
Vì vậy bản dev đơn lẻ **chưa có node consumer để chạy broker đầu-cuối**; PR cần
giữ draft đến khi nhận dependency và tích hợp hook node dưới đây.

Thiết kế ở [pd-03-design.md](pd-03-design.md). Issue #20 chưa có bằng chứng Huynh
duyệt; người dùng đã yêu cầu tiếp tục không chờ trong chat. Không tự đăng bình luận,
không tuyên bố Huynh đã duyệt. Nhánh dùng hung-pd-03-request-reply do ref hung hiện
có chặn tên hung/pd-03-request-reply; không đổi/xoá ref hung của người khác.

## Định danh và trạng thái

commandId = messageId = correlationId = `<JWT userId>:<Idempotency-Key>`.
Khoá duy nhất toàn bộ bãi/loại lệnh của một user. Hash SHA-256 canonical gồm bãi,
type, actor server và payload; payload/type/bãi khác cùng key trả 422
IDEMPOTENCY_KEY_REUSED. Retry không tạo row/ID/deadline mới. Actor từ JWT server,
không lấy userId/role trong payload client. Cancel cũ thiếu key dùng cancel-<reservationId>.

States chính: PENDING, DONE, FAILED, EXPIRED. Kết quả nghiệp vụ 2xx→DONE; 4xx/5xx
do node trả bền vững→FAILED. FAILED_TO_SEND là `status=FAILED`, failure_phase=SEND,
publish_state=REJECTED, kèm sendStatus trong API, không thêm trạng thái chính khác.

Chỉ lỗi chắc chắn trước publish/mandatory return/nack mới FAILED_TO_SEND. Mất confirm,
disconnect sau publish hoặc khôi phục lease SENDING giữ PENDING/UNKNOWN. Dù lần
publish tiếp theo bị từ chối, command đã uncertain vẫn không được gọi là chắc chắn
chưa gửi. Một retry đã biết bị từ chối được reset chính row đó khi user gửi lại,
còn hạn, giữ nguyên ID/deadline. Không cấp key mới để né kết quả chưa xác định.

INSERT PENDING và intent trước publish; worker SELECT FOR UPDATE SKIP LOCKED rồi
COMMIT SENDING/lease trước I/O broker. Crash trước publish hoặc sau gửi/trước ghi
confirm được khôi phục cùng ID sau lease. Inbox PD-02 chặn hiệu lực trùng. Không
giữ transaction DB qua network publish. Candidate tests và unit kiểm tra các cửa sổ.

Nếu mất ACK DB sau INSERT, HTTP 503 COMMAND_PERSISTENCE_UNKNOWN mang commandId,
unknown=true: có thể intent đã commit. Frontend vẫn theo dõi ID đó; không xem là
FAILED_TO_SEND. Request chưa có reply sau REPLY_WAIT_MS trả 202, tuyệt đối không 504.

## Queue phản hồi và failover

AGGREGATOR_ID ưu tiên, fallback INSTANCE_ID, cuối cùng 1. Cùng ID canonical dùng
cho reply, event queues và header x-instance. Compose đặt instance 1/2 riêng.
ID chỉ A–Z/a–z/0–9/_/-, tối đa 64; recovery là tên dành riêng. Lease DB 15 giây,
heartbeat 5 giây ngăn trùng ID khi khởi động; sau crash restart có thể chờ hết lease
tối đa khoảng 20 giây. Đây không thay thế fencing/leader PD-10.

parking.replies: direct, durable. Mỗi instance assert durable quorum
agg.replies.<id>, x-message-ttl=60000, binding agg.<id>. Node replyTo là agg.<id>.
Thêm agg.replies.recovery durable quorum **không TTL**, bind chính routing key
agg.<id> trước khi instance được phép publish. Mọi instance consume recovery cạnh
tranh, nên sender chết vẫn có bản khác cập nhật commands. Queue riêng có thể chứa
duplicate trong 60 giây; DB dedup. Recovery giữ tin khi mọi instance tắt lâu hơn
60 giây, không phụ thuộc queue riêng của instance đã chết. Cần giám sát dung lượng
recovery khi toàn bộ consumer tắt; không làm thay back-pressure PD-06.

Reply HMAC phải hợp lệ, khớp command/parking/type/actor/correlation. Cập nhật DB
trước ack; duplicate đồng nhất không ghi đè terminal, reply conflict bị bỏ qua.
Reply lạ/sai chữ ký không tạo command mới và không được dùng để nhận quyền.
Node enrich slotCode/status/version và ký reply trong cùng transaction client
inbox/nghiệp vụ/outbox. Cache chỉ nhận version cao hơn; sự kiện cũ không ghi đè.

Pending Map đăng ký trước durable intent, nhiều waiter cho cùng ID. Một vòng quét
100 ms dọn timeout/đọc terminal DB, không timer riêng mỗi HTTP request. Shutdown
giải phóng waiter bằng 202, không khẳng định nghiệp vụ thất bại. PostgreSQL
LISTEN/NOTIFY báo terminal tới các instance; Socket.IO emit COMMAND_RESULT chỉ
phòng user từ DB. Mất notify/socket được bù bằng polling GET; notify không phải
nguồn sự thật hoặc log thông báo bền vững.

## API và frontend

COMMAND_MODE=broker mặc định; http giữ nguyên đường cũ để dự phòng/đo so sánh.
Chuyển reserve POST, cancel DELETE, pay POST ONLINE, giữ permission/shape nghiệp vụ.
Kết quả broker thêm commandId; HTTP fallback giữ mã/body cũ, không ghi bảng commands.

```text
POST   /api/parkings/:id/reservations   Idempotency-Key bắt buộc
DELETE /api/parkings/:id/reservations/:rid   key tuỳ chọn (fallback ổn định)
POST   /api/me/sessions/:id/:sid/pay    Idempotency-Key bắt buộc
GET    /api/commands/:commandId
```

Có reply trả đúng mã 201/200/409/... cùng body nghiệp vụ + commandId. Chưa có:

```json
{"commandId":"<userId>:<key>","status":"PENDING","publishState":"AWAITING_RESULT"}
```

HTTP 202 có Location trỏ GET tương ứng. GET từ bất kỳ instance đọc DB chung,
trả status/result/statusCode/publishState, chỉ owner hoặc ADMIN; người khác 404,
không có token 401. Không trả request_hash, actor nội bộ hoặc chữ ký.

Frontend commandRequest chờ terminal, hiện Đang xử lý khi nhận 202 hoặc persistence
unknown, giữ key cho retry cùng thao tác. Lưu ID/key/fingerprint theo user, không
lưu payload/biển số/result vào tracker localStorage. Tải lại trang/reconnect socket
vẫn đọc GET, có một polling loop khi socket bỏ lỡ sự kiện. Banner terminal có nút
đóng. Đổi payload là thao tác khác/key mới; server vẫn kiểm hash độc lập. Traceparent
HTTP hợp lệ được giữ qua command/outbox/reply, correlationId không đổi. Không làm
thay toàn bộ tracing PD-24.

## Schema, cấu hình và tích hợp node

Migration additive trong aggregator schema.sql: commands có các cột kế hoạch
id/parking_id/type/user_id/status/result/created_at/updated_at; bổ sung status_code,
request_hash, payload/actor/envelope JSONB, correlation_id, reply_to, publish_state,
publish_owner/lease, next_publish_at, attempts, uncertain, failure_phase, last_error,
reply_hash, slot JSONB. Index pending publish và lịch sử theo user. Bảng
aggregator_instances giữ lease ID. Không DROP/đổi dữ liệu cũ; không tạo lại inbox.

```dotenv
COMMAND_MODE=broker
AGGREGATOR_ID=1
REPLY_WAIT_MS=3000
COMMAND_TTL_MS=10000
```

Vhost tiếp tục `/`, URI `/%2F`, cùng INTERNAL_KEY giữa node/Aggregator. Không commit
secret thật. Node PD-02 đã có reply outbox/relay; sau nhận dependency áp dụng:

```powershell
git apply --check scripts/pd03-pd02-reply.patch
git apply scripts/pd03-pd02-reply.patch
```

Patch chỉ gọi enrichReply trước INSERT outbox trong processor PD-02, không mở
transaction khác. Kiểm tra apply trên PD-02 commit 238b77692f64b502b4ac5761c9b464dee3c91f5d.
Khi nhận PD-08, dùng adapter/lifecycle retry-integration của PD-08. Giải quyết xung
đột publisher bằng giữ HMAC và deadline **đã lưu**, không tạo deadline mới trong
factory mỗi lần worker publish. Candidate test đã dùng cả ba phần theo hợp đồng này.

Không xoá volume/queue để né PRECONDITION_FAILED. Nếu agg.replies.<id> cũ sai args,
dừng publisher liên quan, kiểm kê/export, chuyển có confirm tới recovery durable,
đối chiếu IDs trước thay queue trong cửa sổ bảo trì. Không xoá queue còn tin.
Rollback: COMMAND_MODE=http, giữ DB/queues/intents và worker phục hồi được kiểm soát;
không DROP commands hoặc purge reply queues.

## TTL/PD-06 và giới hạn

TTL tổng ký trong envelope: issuedAt/deadlineAt, không đổi khi worker republish.
Publisher chỉ gửi expiration phần thời gian còn lại. Retry PD-08 bỏ expiration
trên delay queue nhưng giữ deadline ký; không tự cấp lại 10 giây. Chỉ intent QUEUED
chưa từng publish chắc chắn quá hạn mới FAILED_TO_SEND/410. SENDING/UNKNOWN hết hạn
vẫn phải chờ bằng chứng node/PD-06, không suy thất bại từ đồng hồ Aggregator.

PD-06 chưa có: không thêm consumer cmd.expired, chưa tích hợp EXPIRED/FAILED từ
expired/DLQ thành trạng thái commands. Guard sau chờ khoá DB/clock skew của PD-08
chưa hoàn chỉnh; không tuyên bố giải quyết hết hạn toàn hệ thống. Kết quả nghiệp vụ
muộn vẫn được tiếp nhận nếu được xử lý hợp lệ trước hạn; terminal đã xác nhận không
bị ghi đè. Những điểm chưa thống nhất này được giữ rõ cho PD-06/PD-08 phối hợp.

## Kiểm thử

```powershell
npm test --prefix parking-node
npm test --prefix aggregator-service
npm test --prefix frontend
npm run build --prefix frontend
# Docker legacy regression: set COMMAND_MODE=http cho cả compose và test
node --test tests/e2e.test.mjs
# Broker candidate phải có PD-02 + PD-08 + patch enrich reply, hai Aggregator
$env:PD03_BROKER='1'
node --test tests/command-flow.e2e.mjs
```

Broker test cần port 8100 của aggregator-2 và AMQP localhost:5673 (override bằng
PD03_AMQP_URL). Compose project/file lấy từ environment để stop/start đúng stack.
Thiếu PD03_BROKER=1 sẽ skip rõ ràng. Xem [bằng chứng thật](pd-03-evidence.md),
[HTTP log](pd-03-http-e2e.log), [broker log](pd-03-broker-e2e.log).
