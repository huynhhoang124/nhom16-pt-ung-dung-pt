# PD-03 — Thiết kế request–reply

Người dùng đã yêu cầu tiếp tục không chờ Huynh duyệt trong chat. Issue #20 chưa
có bằng chứng duyệt; không tự đăng bình luận hoặc tuyên bố đã được duyệt.
Base dev hiện chỉ có PD-01; PD-02 #48 và PD-08 #49 chưa merge. PR PD-03 sẽ ghi rõ
dependency, kiểm thử trên bản ghép riêng, không đưa lại triển khai inbox/retry.

commandId = messageId = correlationId = `<userId>:<Idempotency-Key>` trong DB chung.
Khoá duy nhất toàn bộ loại lệnh/bãi của một user; hash canonical parking/type/actor/
payload chặn dùng lại key cho thao tác khác bằng 422. Retry giữ ID, envelope và
deadline. actor từ JWT server. Cancel cũ không có key dùng key suy ra reservation ID.

Commands được INSERT PENDING trước publish, kèm intent và lease publish. Một worker
chiếm intent bằng FOR UPDATE SKIP LOCKED, COMMIT intent SENDING rồi mới publish.
Crash trước/sau publish được phục hồi với cùng ID/deadline sau lease; inbox PD-02
chặn hiệu lực trùng. Chỉ từ chối chắc chắn (unavailable trước publish, mandatory
return/nack) mới FAILED với failure_phase=SEND/FAILED_TO_SEND. Disconnect sau publish
hoặc mất confirm giữ PENDING/UNKNOWN; tuyệt đối không tạo ID mới để né kết quả chưa
xác định. Trạng thái chính PENDING/DONE/FAILED/EXPIRED; reply terminal không bị ghi
đè bởi duplicate/conflict. EXPIRED chờ hợp đồng PD-06, không suy từ HTTP timeout.

AGGREGATOR_ID ưu tiên, fallback INSTANCE_ID, mặc định 1; Compose gán 1/2 riêng.
Queue durable quorum agg.replies.<id> TTL 60000 bind direct parking.replies bằng
agg.<id>. Thêm queue recovery durable quorum không TTL, bind từng agg.<id> trước
khi publish. Mọi instance consume recovery cạnh tranh: instance gửi chết thì bản
khác vẫn cập nhật commands. Queue riêng có thể giữ duplicate tối đa 60 giây;
dedup tại DB. Không phụ thuộc leader PD-10. Lease DB ngăn hai instance dùng một ID.

Pending Map đăng ký trước INSERT/publish, một vòng quét 100 ms cho timeout, đọc DB
để nhận kết quả do instance khác xử lý; 3 giây chưa có reply trả 202/commandId,
không 504. Reply phải khớp command/parking/type/user/correlation và HMAC server;
UPDATE DB trước ack. Node enrich reply với slot/status/version và ký trong chính
transaction inbox/outbox. Cache áp dụng max version. PostgreSQL LISTEN/NOTIFY báo
kết quả tới các instance; Socket.IO chỉ phòng user từ DB. Mất notify/socket được
bù bằng GET DB chung; chỉ owner/admin được xem.

COMMAND_MODE mặc định broker, http giữ nguyên REST cũ. Frontend chờ 202 hiển thị
Đang xử lý, giữ key khi thử lại, lưu ID chờ để phục hồi sau reload/reconnect, polling
khi socket mất tin. Không suy confirm hoặc timeout thành kết quả nghiệp vụ.
TTL tổng mặc định 10 giây, REPLY_WAIT_MS=3000; không cấp lại deadline khi republish.
Guard sau chờ khoá/clock skew và EXPIRED đầy đủ vẫn cần PD-06/PD-08.

Test: TC51 correlation/trace và 201 dưới 3 giây; TC52 10 HTTP cùng key một hiệu lực;
TC54 dừng bãi 5 giây, 202 rồi Socket.IO terminal; TC62 kill Aggregator gửi trước
reply, instance 2 phải đọc terminal thật. Thêm duplicate/mismatch/late reply,
ownership/admin, unknown/definite publish failure, lease crash windows, cache version,
socket reconnect/polling và HTTP regression toàn bộ. Không xoá volume; khôi phục
mọi container dừng khi test. Bằng chứng phân biệt checkout dev với bản ghép dependency.
