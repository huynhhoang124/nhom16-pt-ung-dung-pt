> Cập nhật 01/11/2026: tài liệu này giữ thiết kế ban đầu. Trạng thái dependency,
> hợp đồng TTL hiện tại và cách chạy không cần patch nằm ở [runbook](pd-08-retry-dlq.md)
> và [bằng chứng mới](pd-08-cap-nhat-2026-11-01.md). PD-02 đã merge; runtime đã nối trực tiếp.

# PD-08 — Thiết kế retry và quản trị DLQ

Đây là thiết kế ban đầu; trạng thái cuối xem [runbook](pd-08-retry-dlq.md). Ngày kiểm tra:
22/10/2026. Người dùng đã miễn bước chờ Huynh duyệt; đây không phải bằng chứng
Huynh đã duyệt thiết kế.

## Dependency đã kiểm tra

- `origin/dev`: `0f8eae8356192543eb42323786c522ef33fc7ec9`, đã chứa PD-01/PR #47.
- PD-02/PR #48 còn mở, `merged=false`; commit
  `238b77692f64b502b4ac5761c9b464dee3c91f5d` chưa là tổ tiên của dev.
  Dev chưa có `parking-node/src/commands.js` và transaction inbox.
- Issue #23 (PD-06) mô tả TTL 10 giây và phân loại `x-death`, chưa có hợp đồng
  deadline tuyệt đối trong code dev. PD-03/bảng commands cũng chưa có.
- Không tự merge hoặc sao chép triển khai PD-02 vào PR PD-08. Có thể phát triển
  topology/DLQ từ dev, dùng PD-02 riêng trong checkout kiểm thử tích hợp; việc
  nối consumer trong bản bàn giao cần thống nhất cách nhận dependency này.

## Hợp đồng thời hạn đề xuất với PD-06

Đây là đề xuất cần thống nhất, chưa phải hợp đồng đã được nhóm xác nhận.

1. Aggregator xác lập `issuedAt` và `deadlineAt` epoch milliseconds trong envelope
   được HMAC ký, mặc định `deadlineAt = issuedAt + COMMAND_TTL_MS` (10.000 ms).
   Client không được tự kéo dài hạn. Deadline không đổi qua mọi lần retry tự động.
2. `expiration` AMQP chỉ là TTL của một lần lưu trên queue, tính từ thời điểm
   publish. Lần đầu dùng phần thời gian còn lại; không xem `expiration` là deadline.
   RabbitMQ bỏ thuộc tính này khi dead-letter. Không cấp lại 10 giây mỗi lần publish.
3. Retry queue dùng TTL cố định 2.000/10.000 ms. Nếu đặt thêm per-message expiration
   ngắn hơn delay, broker có thể dead-letter sớm và phá yêu cầu chờ retry. Vì vậy
   bản nằm trong retry queue không mang expiration; deadline tuyệt đối vẫn được ký
   và giữ nguyên. Khi trở về node phải kiểm tra deadline trước nghiệp vụ.
4. Kiểm tra thời gian DB ngay trước nghiệp vụ trong transaction. Nếu đã quá hạn,
   không chạy nghiệp vụ mới; chuyển thông báo hết hạn qua hook PD-06 bằng publish
   confirm trước ack. Nếu inbox đã có kết quả thì có thể trả lại kết quả đã lưu,
   không tạo hiệu lực mới. Phải thống nhất hạn là hạn bắt đầu xử lý hay hạn commit;
   đề xuất hạn bắt đầu nghiệp vụ sau khi đã giành khoá DB cần thiết, kiểm tra lại
   sau mọi chờ khoá. Không tuyên bố có bảo đảm hạn commit tuyệt đối từ TTL broker.
5. TTL 10 giây mặc định không đủ cho hành trình retry 2+10 giây: hết hạn trước lần
   thứ ba là đúng. TC57 đặt rõ `COMMAND_TTL_MS=60000`; test riêng dùng deadline
   ngắn, chờ quá hạn rồi khẳng định không có đặt chỗ mới.
6. PD-06 sở hữu consumer `cmd.expired`, phân biệt hết hạn và `delivery_limit` qua
   `x-death`; PD-08 không tạo consumer cạnh tranh ở đây. Cần thống nhất envelope
   chuyển tiếp và hook cập nhật EXPIRED/FAILED khi bảng commands PD-03 có mặt.

## Routing và publish an toàn

Vhost tiếp tục là `/`, URI `/%2F`, không di chuyển dữ liệu. Giữ policy command
PD-01 và đích `expired`. Bổ sung durable quorum `cmd.retry.2s`, `cmd.retry.10s`,
`cmd.dead`; bindings `retry.1`, `retry.2`, `dead` trên `parking.dlx`. Các retry queue
dead-letter sang `parking.commands`; cấu hình DLX/at-least-once/reject-publish bằng
policy để thay đổi được. Không khởi tạo các event queue của Aggregator.

Probe RabbitMQ 3.13 thật ngày 22/10/2026 đã publish `retry.1`/`retry.2` với
`CC=['cmd.A.reserve']`, kiểm tra queue đích A và queue đối chứng B:

| TTL queue | Thời gian quan sát | Bãi A | Bãi B | routing key khi nhận | expiration |
|---|---:|---|---|---|---|
| 2.000 ms | 2.062 ms | nhận đúng messageId | không nhận | retry.1 | bị bỏ |
| 10.000 ms | 10.050 ms | nhận đúng messageId | không nhận | retry.2 | bị bỏ |

Đây chỉ là probe cơ chế CC, chưa phải TC57, chưa chứng minh toàn bộ topology triển
khai hay consumer/inbox. Probe dùng exchange/queue riêng trong broker project
`pd08-retry`, đã xoá đúng các queue/exchange probe sau khi đo; không xoá volume.

CC có thể dùng cho routing nhưng không bảo toàn `fields.routingKey` theo cách
consumer PD-02 hiện yêu cầu. Adapter phải xác thực HMAC trước, đối chiếu routing
gốc với parkingId/type trong envelope và allowlist retry headers, rồi mới chuyển
cho processor. Không nhận CC tuỳ ý từ client; khi publish chỉ đặt đúng một khoá
gốc đã xác thực và bỏ BCC/CC cũ. Cần test đồng thời nhiều bãi/loại lệnh và kiểm tra
không nhân bản trước khi chọn CC cho bản triển khai cuối. Nếu không thoả, chuyển
sang retry queue riêng từng bãi **và loại lệnh**, DLX routing key chính xác.

PD-02 HMAC hiện bao gồm expiration. Adapter không được bỏ qua xác thực để tránh
lỗi sau dead-letter: bản retry được server ký lại với expiration đã bỏ, giữ nguyên
deadline trong body. Đây là thay đổi hợp đồng phải có test tương thích hai service.

Lỗi tạm: rollback trước, x-retry 0→1→2, sau đó DLQ. Lỗi nghiệp vụ đã commit không
retry. Sai schema vào DLQ. Giữ content, actor, messageId, correlationId, replyTo và
ngữ cảnh truy vết. Chỉ ack gốc khi bản chuyển đi đã confirm và không return; lỗi
publish/unknown giữ gốc unacked, reconnect có backoff. Dùng attempt ID riêng để
ghép return/confirm khi nhiều tin cùng messageId. Không dùng x-death để đếm retry
ứng dụng và không can thiệp delivery_limit của broker.

## Lưu DLQ, replay và quyền

Aggregator ghi `dead_letters` bền vững trước ack, khoá dedup từ messageId cộng hash
content/routing/lý do để giao lại không sinh hàng trùng nhưng payload khác không
bị nuốt. Lưu content gốc (kể cả JSON hỏng), properties phục vụ replay, routing gốc,
lý do, retry count, timestamps; API/UI chỉ trả projection đã che dữ liệu nhạy cảm.
Không log raw content, chữ ký HMAC, token, URI có mật khẩu hay SQL parameters.

API ADMIN GET phân trang giới hạn; POST replay chỉ cho sửa trường payload nghiệp
vụ đã allowlist và validate theo type, không sửa actor/role/parkingId/identity,
không gửi lại header tuỳ ý. Với envelope sai tới mức không xác lập được actor
server đáng tin cậy: từ chối replay, yêu cầu tạo lệnh mới qua luồng đã xác thực.

Replay là hành động quản trị mới, có audit admin, ID và deadline mới cùng liên kết
causationId về bản gốc. Không xoá inbox. Nếu yêu cầu retry giữ messageId cho lệnh
chưa hiệu lực thì chỉ cho phép payload/type không đổi; sửa payload phải có ID mới.
Không mặc định đổi ID để chạy lại lệnh đã có hiệu lực: cần tra kết quả inbox đáng
tin cậy qua hợp đồng PD-02/PD-03 trước, hoặc từ chối replay khi chưa xác định được.
Không tạo bảng commands thay PD-03. Để hook cập nhật FAILED/EXPIRED, ghi rõ trạng
thái chưa tích hợp đầu-cuối.

Trạng thái replay cần phân biệt READY/PUBLISHING/BROKER_CONFIRMED/UNKNOWN/FAILED;
confirm không có nghĩa nghiệp vụ hoàn tất. Chống hai admin replay đồng thời bằng
CAS/transaction trên dead_letters và lưu ý cửa sổ crash publish→cập nhật DB: retry
cùng replay messageId giúp inbox loại trùng, không tạo ID mới mỗi lần khôi phục.

## Kiểm chứng khi dependency sẵn sàng

- Unit: classification, x-retry, deadline bất biến, properties, HMAC, concurrent
  return/confirm, nack/disconnect/unknown, rollback và commit/ack.
- Broker: cả hai delay đúng bãi/type, không bản sao ở bãi khác, retry cạn,
  publish return/nack, delivery_limit thuộc cmd.expired.
- PostgreSQL: duplicate DLQ, crash trước ack, replay CAS và idempotent recovery.
- TC57: hook test-only hai lỗi, TTL 60 giây, thứ ba thành công đúng một hiệu lực.
- Quá hạn: TTL tổng ngắn, không cho retry thực hiện muộn; không reset deadline.
- TC58: sai schema→DLQ→trang admin→sửa được phép→replay, kiểm tra USER bị cấm;
  không dùng test hàm publish đơn lẻ để tuyên bố TC58 đầu-cuối đã đạt.
- Hồi quy HTTP và frontend build; khôi phục service/dữ liệu test, không xoá volume.

Nguồn: Issue #25, Issue #23, PR #47/#48, kế hoạch v1.4 mục 5.2/5.4/5.6 và phân
công PD-08. Hành vi broker đối chiếu tài liệu chính thức:
https://www.rabbitmq.com/docs/3.13/dlx và
https://www.rabbitmq.com/docs/3.13/sender-selected.
