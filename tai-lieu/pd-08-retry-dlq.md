# PD-08 — Retry và quản trị DLQ

## Trạng thái và dependency

Cập nhật 01/11/2026 từ origin/dev `eef361f`: PD-01 và PD-02 đã merge. Nhánh/PR
PD-08 hiện hữu (#49) đã nhận dev mới nhất; retry được nối trực tiếp vào
`parking-node/src/index.js`, dùng processor/inbox/transaction PD-02 đang có trong repo.
Đã bỏ `retry-integration.js` và patch chờ tích hợp; TC57/TC58 không cần checkout
PD-02 riêng hay ghép source candidate. Giữ nguyên lifecycle etcd, leader, fencing,
LISTEN/relay và scheduled lock của các phần đã merge.

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
ký lại properties đã đổi. Guard node kiểm tra deadline trước processor, và bằng clock_timestamp() của DB sau
INSERT inbox/chờ khóa, sau nghiệp vụ và ngay trước COMMIT. Quá hạn làm rollback
toàn bộ hiệu lực/inbox/outbox mới. Bản giao lại có inbox đã COMMIT được trả kết quả
cũ, không chạy lại nghiệp vụ. Replay
được admin yêu cầu là lần yêu cầu mới có hạn mới; retry tự động không gia hạn.

10 giây mặc định không đủ 2+10 giây rồi xử lý lần ba: hết hạn là đúng. TC57 dùng
factory TTL 60000 ms. Test riêng dùng 500 ms, retry 2 giây rồi xác nhận không có
reservation, deadline-issuedAt vẫn 500 ms. Test broker khác dùng TTL 50 ms/node dừng.

RabbitMQ 3.13 thật xác nhận CC về đúng bãi/type, B/C không nhận. fields.routingKey
vẫn là retry.N; adapter xác thực HMAC rồi đối chiếu route gốc với body và chuẩn hoá
trước khi gọi processor PD-02. Không bỏ xác thực hoặc tin actor client tự khai.

**Điểm còn cần thống nhất với PD-06:** bản trở về từ delay queue bị RabbitMQ bỏ
expiration. Khi node còn offline, nó có thể nằm ở cmd.<bãi> qua deadline; guard DB
ngăn hiệu lực muộn khi node nhận lại, nhưng chưa có cơ chế PD-06 cập nhật EXPIRED
đúng thời điểm đó. Clock skew Aggregator/DB và khoảng giữa final check/COMMIT vẫn
cần hợp đồng thời gian; không hứa deadline tuyệt đối tại COMMIT. Không thêm consumer
cmd.expired hay triển khai thay toàn bộ TTL/back-pressure. Default 10 giây vẫn là
10 giây, không tăng mặc định để làm TC57 vượt qua.

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

TC57/TC58 trên entrypoint service thật (Compose project riêng, không cần source ngoài):

```powershell
# Lần đầu tạo .env từ .env.example; không ghi đè cấu hình đang dùng.
$env:COMPOSE_PROJECT_NAME='pd08-test'
$env:COMPOSE_FILE='docker-compose.yml;tests/pd08-compose.test.yml'
docker compose build parking-a aggregator
docker compose up -d --no-build --wait rabbitmq parking-a parking-b parking-c aggregator
$env:PD08_RUNTIME='1'
node --test tests/pd08-runtime.test.cjs
```

Override test dùng broker 5673/15673, DB A 15432, DB Aggregator 15433;
COMMAND_TTL_MS=60000 cho TC57. NODE_ENV=test và RETRY_TEST_MESSAGE_ID chỉ trỏ
`pd08-runtime:retry`, đúng hai lỗi giả lập; không bật hook trên B/C. Cấu hình
production mặc định không có các biến lỗi này. Runtime test kiểm TC57, TC58 và
hạn tổng 300 ms hết khi SQL đang chờ khóa slot: DB không có hiệu lực/inbox mới.

Kiểm riêng retry cạn, DLQ duplicate, replay fence và deadline không reset bằng
processor hiện có trong chính repo; cần dừng consumer service trước để không tranh test:

```powershell
docker compose stop parking-a parking-b parking-c aggregator
$env:PD08_AMQP_URL='amqp://parking:parking@localhost:5673/%2F'
$env:PD08_DATABASE_URL='postgres://postgres:dev@localhost:15432/parking'
node --test tests/pd08-retry.integration.cjs
# Khôi phục nếu tiếp tục chạy; không dùng -v.
docker compose up -d --no-build parking-a parking-b parking-c aggregator
```

Component test chỉ skip nếu không có URL DB/broker opt-in; không cần PD02_SOURCE_ROOT.
Job CI `retry-dlq` tự dựng stack, chạy runtime TC57/TC58 rồi component test, giữ
volumes khi cleanup. Không coi skip của test opt-in trong npm test là pass broker.
Test cleanup chỉ ID/slot prefix do nó tạo, không purge queue/DB/volume. Nếu thử UI,
build/up frontend và notification như README, đăng nhập admin demo, vào Quản trị →
Lệnh lỗi; nhập payload mới đầy đủ khi sửa vì biển số cũ đã che. Xem
[bằng chứng mới](pd-08-cap-nhat-2026-11-01.md); bằng chứng 22/10 được giữ làm lịch sử,
không thay cho kết quả runtime hiện tại.
