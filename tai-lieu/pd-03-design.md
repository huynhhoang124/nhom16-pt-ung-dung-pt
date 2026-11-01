# PD-03 – Thiết kế request–reply

Cập nhật 01/11/2026 theo Issue #20, kế hoạch 1.4 mục 5.2–5.4/5.9 và phụ lục C.
Issue chưa có bình luận duyệt thiết kế. Người dùng chỉ thị trong chat **“tự làm không cần huynh duyệt”**,
cho phép tiếp tục; không tuyên bố Huynh đã duyệt và không đăng bình luận thay người dùng.

PD-01 và PD-02 đã có trong dev `4cf3e267cf50e71c7382221deee95bc2ce2f207d`.
Tiếp tục nhánh/PR #52 hiện hữu, nhận dev mới bằng merge để giữ lịch sử đã push, không force-push.
Ref hung có sẵn nên giữ `hung-pd-03-request-reply`, không tạo nhánh/PR trùng.
PD-08 #49 và sửa bổ sung PD-02 #66 chưa merge: không chép implementation của hai PR này vào PD-03.

commandId = AMQP messageId = correlationId = `<JWT userId>:<Idempotency-Key>`, duy nhất
trong DB Aggregator chung xuyên bãi/loại lệnh. Fingerprint canonical gồm bãi/type/actor server/payload;
retry dùng cùng ID/envelope/deadline, đổi nội dung cùng key trả 422. Actor lấy từ JWT, ký HMAC
backend; node dùng inbox PD-02, cùng transaction client cho nghiệp vụ/kết quả/outbox phản hồi.

INSERT PENDING + publish intent trước I/O broker. Worker dùng FOR UPDATE SKIP LOCKED và lease,
COMMIT SENDING rồi mới publish bằng publisher PD-01. Crash trước/sau publish được khôi phục
cùng ID/deadline khi lease hết; inbox chống hiệu lực trùng. Chỉ từ chối chắc chắn trước publish,
NO_ROUTE/nack mới FAILED với failure_phase=SEND và sendStatus=FAILED_TO_SEND. Lần publish
trước đã UNKNOWN thì lần từ chối sau không chứng minh chưa có hiệu lực: vẫn PENDING/UNKNOWN.
Retry chủ động lỗi gửi chắc chắn chỉ mở lại chính row/ID còn hạn. DONE/FAILED nghiệp vụ/EXPIRED
đã xác nhận không bị duplicate hoặc reply xung đột ghi đè. EXPIRED đầu-cuối chờ PD-06.

AGGREGATOR_ID ưu tiên, fallback INSTANCE_ID; Compose gán 1/2. Cùng ID dùng cho reply/events/
metrics/leader, kiểm trùng bằng lease DB. Queue agg.replies.<id> durable quorum TTL 60000,
bind direct parking.replies bằng agg.<id>. Recovery queue durable quorum không TTL được bind
cùng route TRƯỚC khi cho publish; các instance consume cạnh tranh. Sender chết thì bản còn
sống vẫn lưu terminal, không phụ thuộc sender restart hoặc TTL queue riêng.

Đăng ký pending Map trước durable intent, một vòng quét 100 ms cho timeout và terminal DB;
không tạo timer riêng cho từng HTTP waiter. Có reply trả mã nghiệp vụ 201/409/...; quá
REPLY_WAIT_MS=3000 trả 202 + commandId/Location, không 504. Shutdown giải phóng waiter bằng 202.
Reply kiểm HMAC, command/correlation/type/bãi/actor; UPDATE DB trước ack, replay không đổi kết quả.
Nếu notify thất bại sau commit, redelivery cùng reply gửi lại notify mà không chạy nghiệp vụ.
Node thêm slot/status/version và ký trong transaction outbox; cache chỉ nhận version cao hơn.
PostgreSQL LISTEN/NOTIFY đưa kết quả tới Socket.IO của các instance, chỉ emit phòng owner lấy từ DB.
GET đọc DB chung, chỉ owner/admin; mất notify/socket được frontend bù bằng polling.

COMMAND_MODE mặc định broker theo chỉ thị/phụ lục C; http giữ REST cũ. Chuyển reserve/cancel/pay;
frontend 202 hiện Đang xử lý, lưu ID/key/fingerprint theo user, giữ key khi thử lại, phục hồi khi
reload/reconnect; không lưu payload/result vào localStorage tracker. traceparent/correlationId giữ
xuyên command, outbox, reply. Không triển khai tracing PD-24.

Migration tạo commands và aggregator_instances, bổ sung cột bằng ADD COLUMN IF NOT EXISTS.
Bảng commands tối thiểu cũ giữ kết quả và ID; PENDING thiếu metadata được giữ UNKNOWN/uncertain,
không tự republish. Cần đối chiếu dữ liệu nguồn trước khi phục hồi các row legacy này.

CI có job broker độc lập dùng entrypoint Compose thật và hai Aggregator, không candidate/patch.
Test TC51/52/54/62, late/duplicate reply, quyền, cache version, notify failure, publish failure,
crash trước/sau publish, migration; frontend mất socket/reload; đầy đủ E2E HTTP dự phòng.
Giữ service/volume và dọn đúng dữ liệu test. Kết quả mới nằm trong pd-03-review-2026-11-01.txt.
