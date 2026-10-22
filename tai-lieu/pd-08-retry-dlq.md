# PD-08 — Retry và quản trị DLQ

## Trạng thái và dependency

Nhánh từ origin/dev có PD-01, không chép code PD-02 chưa merge (PR #48).
Topology, worker DLQ, API ADMIN, UI và module retry đã triển khai. Consumer production
trên dev chưa có: **chưa bật retry trong vòng đời node mặc định**. Không coi đây
là tích hợp runtime hoàn chỉnh khi PD-02 vắng mặt.

`parking-node/src/retry-integration.js` nối exports PD-02 qua dependency injection,
dùng chính processor/transaction inbox của PD-02. Khi nhận PD-02, áp dụng
`scripts/pd08-pd02-integration.patch` vào index (đã check apply trên commit
238b77692f64b502b4ac5761c9b464dee3c91f5d). Không tự merge PD-02. Khi xử lý xung đột
Aggregator, giữ HMAC, deadline và replyTo thống nhất, không khởi động hai consumer.

PD-03 chưa có bảng commands: `markFailed(messageId,reason)` là hook idempotent,
mặc định không cập nhật trạng thái người dùng. Không tạo bảng commands khác.
PD-06 chưa có consumer expired: tin giữ ở cmd.expired; chưa hoàn tất EXPIRED/FAILED
đầu-cuối. Người dùng đã miễn bước chờ Huynh duyệt, không phải Huynh đã duyệt.

## Cấu hình và topology

- Vhost `/`, URI `/%2F`, permissions như PD-01; không chuyển dữ liệu/vhost.
- Durable quorum cmd.retry.2s/10s có x-message-ttl 2000/10000. Policy command-retry
  đặt dead-letter-exchange=parking.commands, at-least-once, reject-publish.
- Durable quorum cmd.dead. Bindings retry.1/retry.2/dead trên parking.dlx.
- CC chỉ một routing key gốc đã xác thực. Không thêm event queue Aggregator.
- Policy command-delivery không đổi: broker delivery_limit vẫn chuyển expired.
  PD-08 không đọc cmd.expired, không cạnh tranh consumer PD-06.
- INTERNAL_KEY phải giống giữa Aggregator/node. Không commit secret triển khai.
- COMMAND_TTL_MS=10000 trong Compose là hạn tổng command mới; TC57 dùng 60000.

Khởi động theo README/.env.example. Definitions import trên cả ba broker. Kiểm tra:

```powershell
$env:RABBITMQ_MANAGEMENT_URL='http://localhost:15672'
node scripts/check-command-topology.mjs
```

Không xoá volume để né PRECONDITION_FAILED. Nếu queue retry cùng tên đã có arguments
khác, dừng lưu lượng liên quan, kiểm kê ready/unacked, export definitions; chuyển
tin có confirm sang queue durable tạm và đối chiếu IDs/count trước khi thay queue
trong cửa sổ bảo trì. Không xoá queue khi còn dữ liệu/chưa có bản chuyển xác nhận.
Hoàn tác bằng dừng worker mới, giữ nguyên queue/bảng có dữ liệu; không DROP/purge.

## Hợp đồng hạn xử lý đề xuất với PD-06

TTL per-message là thời gian ở một queue, khác deadline tuyệt đối. RabbitMQ bỏ
expiration khi dead-letter. Aggregator ký issuedAt/deadlineAt trong body. Retry
giữ nguyên deadline, bỏ expiration để không quay về sớm hơn delay queue 2/10 giây,
ký lại properties đã đổi. Guard node kiểm tra deadline trước processor. Replay
được admin yêu cầu là lần yêu cầu mới có hạn mới; retry tự động không gia hạn.

10 giây mặc định không đủ 2+10 giây rồi xử lý lần ba: hết hạn là đúng. TC57 dùng
factory TTL 60000 ms. Test riêng dùng 500 ms, retry 2 giây rồi xác nhận không có
reservation, deadline-issuedAt vẫn 500 ms. Test broker khác dùng TTL 50 ms/node dừng.

RabbitMQ 3.13 thật xác nhận CC về đúng bãi/type, B/C không nhận. fields.routingKey
vẫn là retry.N; adapter xác thực HMAC rồi đối chiếu route gốc với body và chuẩn hoá
trước khi gọi processor PD-02. Không bỏ xác thực hoặc tin actor client tự khai.

**Chưa thống nhất với PD-06:** guard dùng đồng hồ tiến trình, kiểm tra trước
processor; chưa kiểm tra đồng hồ DB sau mọi chờ khoá, chưa bảo đảm hạn COMMIT tuyệt
đối/clock skew. Cần phối hợp guard trong transaction với PD-02/PD-06. Chưa tuyên bố
đã giải quyết toàn bộ hết hạn/back-pressure. Thiết kế ban đầu ghi các điểm cần chốt.

## Phân loại và confirm

Sau rollback, lỗi tạm chuyển retry.1 (x-retry=1), retry.2 (=2), rồi dead. Lỗi nghiệp
vụ có kết quả inbox không retry. Sai schema/chữ ký vào dead. Quá deadline vào expired
cho PD-06. x-death không dùng thay x-retry. Chỉ ack gốc khi transfer trả true sau
confirm và không return; nack/disconnect/timeout giữ nguồn có khả năng giao lại.
Consumer PD-02 quản lý reconnect/backoff; helper có close, setup/confirm timeout,
attempt ID riêng ghép return/confirm khi nhiều tin cùng messageId. Confirm không
chứng minh node đã xử lý. Không mở transaction nghiệp vụ thứ hai.

RETRY_TEST_MESSAGE_ID và RETRY_TEST_FAILURES (1–2) chỉ hoạt động khi NODE_ENV=test,
nhắm một ID; mặc định tắt. Adapter/test có thể inject hook riêng.

## DLQ, dữ liệu và replay

Worker Aggregator get cmd.dead → INSERT dead_letters ON CONFLICT → ack. DB lỗi thì
đóng channel để giao lại. Dedup key gồm hash bytes gốc, ID, route, reason, không gồm
attempt ID. Lưu content base64/properties gốc; API chỉ trả projection, che biển số,
không trả token/chữ ký/raw headers. Log mới không ghi content/SQL parameters/secret.

Schema additive dead_letters: id, unique dedup_key, message_id, content_base64,
properties JSONB, routing_key, reason, status, created_at; replay_message_id,
replay_body/replay_properties JSONB, replay_admin, replay_requested_at, replayed_at.
Partial index intent PUBLISHING. Không đổi hoặc xoá bảng cũ.

```text
GET  /api/admin/dlq?limit=20&offset=0   (limit 1..100)
POST /api/admin/dlq/:id/replay         {} hoặc {"type":"reserve","payload":{...}}
```

Chỉ ADMIN. Chỉ allowlist trường nghiệp vụ reserve/cancel/pay; không cho sửa actor,
identity, header, route tuỳ ý. JSON hỏng/không xác thực được actor không thể replay.
UI che biển số; khi sửa phải nhập payload mới đầy đủ, không dùng lại chuỗi đã che.

- Không sửa payload/type: giữ messageId, inbox trả kết quả cũ nếu đã có. Không xoá
  inbox để ép chạy lại.
- Có sửa: chỉ lỗi schema được node chứng thực bằng HMAC riêng. Trước ID mới, gọi
  POST /api/internal/commands/replay-claim bằng internal key. JWT staff/admin trực
  tiếp không thay được key. Node INSERT tombstone ON CONFLICT vào inbox PD-02,
  chờ giao dịch đang xử lý; kết quả nghiệp vụ có trước thì 409. Thiếu inbox hoặc
  node lỗi thì fail closed 503. Tombstone của chính replay này trả idempotent 200.
- Tombstone: command_type=replay_fence, request_hash=pd08-replay:<newId>, result
  REPLACED_BY_ADMIN_REPLAY/replayMessageId, status_code=422. Hash khác khiến processor
  PD-02 trả IDEMPOTENCY_KEY_REUSED, không chạy bản cũ. ID replay mới ổn định từ
  userId/dedup_key; crash giữa claim và commit intent không sinh ID mới khi thử lại.
- Không sửa DLQ quá 7 ngày. Tombstone cũng theo dọn inbox PD-02; giới hạn chống
  trùng là 7 ngày lưu, không hứa vô hạn.

READY → PUBLISHING → BROKER_CONFIRMED hoặc REPLAY_EXPIRED. PUBLISHING là intent đã
lưu/đang chờ confirm; **broker có thể đã nhận** nếu mất kết nối lần trước. Worker
tiếp tục cùng ID/deadline. SELECT FOR UPDATE SKIP LOCKED và trạng thái ngăn hai
worker/admin tạo hai replay. Confirm không phải kết quả nghiệp vụ; chờ PD-03.

## Kiểm thử

```powershell
npm test --prefix parking-node
npm test --prefix aggregator-service
npm run build --prefix frontend
```

Integration cần broker/DB riêng, queue A/B/C/dead trống và không consumer:

```powershell
$env:PD02_SOURCE_ROOT='D:\pd-02-command-inbox\parking-node\src'
$env:PD08_AMQP_URL='amqp://parking:parking@localhost:5673/%2F'
$env:PD08_DATABASE_URL='postgres://postgres:dev@localhost:15432/parking'
node --test tests/pd08-retry.integration.cjs
```

Thiếu PD02_SOURCE_ROOT sẽ skip rõ ràng. Test dùng checkout PD-02 riêng; không chép
vào PR. Chỉ dọn records test theo IDs/slot prefix, đóng consumer trước dọn, giữ
volumes. Xem [bằng chứng](pd-08-bang-chung.md) và [ảnh UI](anh/pd08-dlq.png).
