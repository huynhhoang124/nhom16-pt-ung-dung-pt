# PD-08 – Retry/DLQ trực tiếp trên consumer dev

Việc 2 của Vũ Văn Hùng trong phân công từ 01/11/2026; Issue #25. Không chờ duyệt
theo chỉ thị người dùng, không tuyên bố Huynh đã duyệt. Không có AGENTS.md trong repo/ancestor.

## Nguồn và dependency

Nhánh tạo từ origin/dev `4155051814f4df61e4df75dcb27f7b1e32553c5b`.
Hai lỗi PD-02 đã sửa ở #79 nhưng chưa merge lúc bắt đầu; giữ commit tiền đề riêng
`5ebb1df` (cherry-pick `d889cb7`, nguyên tác giả Vũ Văn Hùng), rồi mới làm PD-08.
Diff sau commit tiền đề là phần PD-08. Sau #79 merge, nhận dev bằng merge thường;
không amend/force-push. Remote có ref `hung`, nên dùng `hung-pd08-retry-dlq-dev`
để bảo toàn ref cũ; không thể đồng thời tạo `hung/...` trong Git.

Tái sử dụng có chọn lọc command-transfer, retry-contract, command-retry, DLQ,
replay-claim, UI và test từ `hung-pd-08-retry-dlq` commit `4535c85` của Vũ Văn Hùng.
Không merge nguyên nhánh: bản đó có publisher/index/schema cũ, làm mất code PD-03,
phân vùng, fencing/epoch, TTL mới của dev. Giữ toàn bộ các phần này, prefetch 16/4,
reply enrichment, HTTP fallback và mặc định COMMAND_MODE=http.

Không có file patch/retry-integration trong base hoặc source đã chọn; không phục hồi
chúng. Test import trực tiếp ../src trong checkout/image hiện tại. Test PostgreSQL
cũ cũng được copy tới /app/test để bỏ loader source ngoài. Hai tài liệu review/
phân công lịch sử vẫn nhắc cơ chế cũ, không phải hướng dẫn chạy hiện tại.

## Topology và xử lý

Vhost `/`, parking.commands/parking.dlx topic durable. Definitions tự nạp như dev,
không đổi vhost/permissions hoặc topology sự kiện/lệnh đang có.

| Routing trên parking.dlx | Queue durable/quorum | Hành vi |
|---|---|---|
| retry.1 | cmd.retry.2s, x-message-ttl=2000 | DLX về parking.commands bằng CC chứa đúng route gốc |
| retry.2 | cmd.retry.10s, x-message-ttl=10000 | tương tự, sau lần thử thứ hai |
| dead | cmd.dead | giữ tin sai schema hoặc cạn hai retry |
| expired | cmd.expired hiện có | điểm bàn giao cho PD-06, không thêm consumer |

Policy command-retry chỉ áp dụng hai delay queue: at-least-once DLX, reject-publish,
không đặt dead-letter-routing-key để giữ route gốc. Policy command-delivery của
PD-06 giữ nguyên. Route thường/admin vẫn về đúng một queue, không đổi bãi/type.
Broker giữ fields.routingKey=retry.N khi DLX; wrapper kiểm HMAC và route gốc khớp
signed parkingId/type (có thể .admin), rồi chuẩn hóa trước processor hiện có.

Một lần đầu + tối đa hai retry. x-retry độc lập x-death, không chấp nhận số thử
không giới hạn. Giữ messageId, correlationId, replyTo, actor và trace/causation/HLC/
fencing context; ký lại khi bỏ expiration. Publish mandatory/persistent trên confirm
channel dùng chung, attempt ID riêng ghép return/confirm cho publish đồng thời.
Chỉ ack nguồn sau transfer xác nhận và không return. Nack/return/disconnect/timeout/
false giữ nguồn unacked, đóng connection và backoff hiện có; không hot requeue.

Lỗi SQL/connection rollback trước transfer. Trạng thái STALE_DB_EPOCH hoặc
ETCD_UNREACHABLE mà processor trả sau rollback cũng được phân loại hạ tầng.
Kết quả nghiệp vụ 400/403/404/409 đã lưu inbox trả bình thường, không retry.
Sai envelope/schema/chữ ký đi dead, không giả thành lỗi nghiệp vụ. Không có consumer
node thứ hai. Fault hook TC57 nằm trong transaction sau INSERT inbox để thật sự
kiểm rollback, chỉ bật khi NODE_ENV=test và đúng RETRY_TEST_MESSAGE_ID, số lỗi 1–2.

## Hạn tổng và giới hạn PD-06

TC57 cần hơn 2+10 giây: helper test dùng chính send() hiện có với opts issuedAt,
deadlineAt và expiration=60000. Fixture test đặt COMMAND_TTL_MS=60000; production
vẫn 10000. Không sửa publisher PD-01/PD-03 hoặc tăng mặc định để làm test đạt.

Retry giữ nguyên deadline tuyệt đối, không cấp lại 10 giây mỗi lần. Bỏ expiration
khi vào delay queue để per-message TTL không cắt ngắn delay; RabbitMQ cũng bỏ nó
khi DLX. Wrapper và guard PD-06 đang có chặn hiệu lực mới đã quá hạn; kết quả inbox
đã commit vẫn được phát lại. Tin có thể nằm ở queue bãi offline qua deadline rồi
mới được chuyển expired khi node nhận lại. Không tuyên bố hoàn tất EXPIRED/back-
pressure, đồng bộ đồng hồ hay bảo đảm deadline chính xác tại COMMIT của PD-06.

Lệnh legacy đã ký nhưng không có deadline vẫn chạy bình thường để giữ tương thích.
Nếu lỗi cần retry, đưa nó vào DLQ thay vì tự tạo/gia hạn deadline không biết thời
điểm gốc. Admin replay là yêu cầu rõ ràng mới, được cấp deadline mới có giới hạn.

## DLQ, API và trang Quản trị

Worker Aggregator ghi dead_letters ở DB chung trước ack. Dedup theo hash bytes,
messageId, route và reason, bỏ attempt ID. DB lỗi đóng channel để giao lại; worker
không chạy chồng, shutdown hủy timer/chờ job/đóng connection. Schema additive gồm
content_base64/properties gốc và các trường audit/replay intent; không xóa dữ liệu.

- GET /api/admin/dlq?limit=20&offset=0: chỉ ADMIN, limit 1–100, projection che biển số,
  không trả raw chữ ký/header/token.
- POST /api/admin/dlq/:id/replay: chỉ ADMIN, {} giữ nội dung/ID; hoặc {type,payload}
  sửa allowlist reserve/cancel/pay. Actor/role/owner/route không nhận từ client.
- Có sửa chỉ cho INVALID_SCHEMA do node chứng thực. Claim nội bộ dùng cùng inbox
  transaction và epoch check hiện có, tạo tombstone cho ID cũ; kết quả có trước thì
  409. Không xóa inbox để ép chạy lại. ID mới ổn định theo dedup key; quá 7 ngày từ
  DLQ từ chối sửa vì giới hạn dedup inbox. JSON hỏng/actor không xác thực được chỉ
  xem, không tự tái tạo quyền để replay.
- READY → PUBLISHING → BROKER_CONFIRMED hoặc REPLAY_EXPIRED. Intent ghi trước publish;
  lỗi/unknown retry cùng ID/deadline, không sinh hiệu lực mới. Confirm chỉ chứng minh
  gửi tới broker. Trang Quản trị xem, phân trang, sửa payload và gửi lại; không coi
  BROKER_CONFIRMED là kết quả nghiệp vụ.

markFailed(messageId,reason) là hook idempotent để Huynh nối vào commands của PD-03;
mặc định không cập nhật bảng đó. PD-08 không làm thay phần FAILED/request–reply này.

## Chạy kiểm tra

Unit ở parking-node, aggregator-service, notification-service:
`node --test --test-concurrency=2 test/*.test.js`. Frontend: npm test và npm run build.

```powershell
# Trong checkout test mới: copy .env.example .env; node scripts/gen-keys.mjs
$env:COMPOSE_PROJECT_NAME='pd08-dev-20261103'
$env:COMPOSE_FILE='docker-compose.yml;tests/pd08-compose.test.yml'
docker compose build parking-a aggregator frontend notification
docker compose build pd08-unit
docker compose run --rm --no-deps pd08-unit
docker compose up -d --no-build --wait rabbitmq parking-a parking-b parking-c aggregator frontend notification
$env:PD08_RUNTIME='1'
node --test tests/pd08-runtime.test.cjs
# Supplemental: test retry cạn và replay từ chối inbox đã có; dừng worker thật để tránh tranh queue.
docker compose stop parking-a parking-b parking-c aggregator
$env:PD08_AMQP_URL='amqp://parking:parking@localhost:5683/%2F'
$env:PD08_DATABASE_URL='postgres://postgres:dev@localhost:25442/parking'
node --test tests/pd08-retry.integration.cjs
docker compose start parking-a parking-b parking-c aggregator
$env:COMMAND_MODE='http'
$env:AGGREGATOR_URL='http://localhost:18010'
$env:PARKING_BASE_PORT='18101'
$env:FRONTEND_URL='http://localhost:13010'
$env:PD02_AMQP_URL='amqp://parking:parking@localhost:5683/%2F'
node --test tests/e2e.test.mjs
```

Linux dùng dấu : trong COMPOSE_FILE. Cổng loopback riêng: 18010, 18101–18103,
13010, 5683/15683, DB A 25442, DB Aggregator 25443; image pd08-dev/* riêng.
TC57/58 chính chạy entrypoint index bình thường, không apply patch/nạp checkout khác.
CI retry-dlq chạy runtime, supplemental rồi hồi quy cũ trên project riêng pd08-ci.

Chỉ down -v project test vừa tạo sau kiểm tên/label com.docker.compose.project của
từng container/volume và prefix volume đúng pd08-dev-20261103_. Không dùng project
mặc định, không purge queue/xóa volume stack đang dùng để né PRECONDITION_FAILED.
Khi nâng cấp queue cũ khác immutable args: kiểm kê ready/unacked, sao lưu, chuyển
tin có confirm sang queue durable tạm và đối chiếu IDs/count trước cutover; giữ
dữ liệu nếu chưa hoàn tất. Hoàn tác bằng dừng worker mới, giữ queue/bảng, không drop.

## Kết quả thực tế và phần chưa kiểm chứng

Ngày 03/11/2026, source cuối: unit node 110 đạt/1 opt-in skip; Aggregator 90 đạt/3
opt-in skip; notification 2/2; frontend 3/3 và build đạt 110 modules. Focused retry/
ack 12/12 đạt sau phân loại trạng thái hạ tầng. PR #79 đã có CI test/frontend xanh.
Unit node trên Docker Linux/Node 22 cũng 110 đạt/1 opt-in skip, concurrency 2;
image unit dùng chung đã bổ sung hai file wire-contract để giữ regression cũ chạy được.
Lượt xác nhận cuối đã down -v đúng project test (11 container/5 volume có tên/label
khớp), khởi tạo volume trắng rồi chạy runtime/supplemental/e2e. Runtime thật 4/4:
TC57 gap 2025/10359 ms, một reservation và nguyên context; TC58
worker/API sửa-replay thành công; deadline 500 ms đi qua retry 2 giây không tạo hiệu
lực. Supplemental 7/7, gap 2054/10018 ms; gồm retry cạn, business 409, dedup, claim
từ chối hiệu lực đã có, expired không gia hạn. Hồi quy HTTP cũ 17 đạt/21 skip/0 lỗi
(111266 ms). [Bằng chứng stdout lượt cuối](pd-08-evidence-2026-11-03.txt).
Management thật: 2 exchanges, 16 quorum queues, 16 bindings, 2 policies, permissions.

GUI chưa xác minh end-to-end: webview không gắn được, computer-use dừng do không
xác định URL Chrome trên Windows để kiểm tra chính sách. Đã dừng UI automation,
không dùng đường khác để vượt chặn; fixture UI được dọn. Vì TC58 qua trang Quản trị
chưa được quan sát, PR để draft. Không lấy build/API pass làm bằng chứng GUI pass.
Các profile HA/coord/scale/shards và tích hợp PD-03/PD-06 ngoài phạm vi không tính đạt.
Không có ảnh GUI mới; không dùng ảnh candidate cũ làm bằng chứng.
