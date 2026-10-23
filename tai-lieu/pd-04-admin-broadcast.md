# PD-04 — Phát lệnh theo vùng và giao diện quản trị

Issue #21, kế hoạch v1.4 mục 5.7–5.8; hợp đồng queue quản trị của PD-06 (Issue #23).

## Trạng thái dependency và phạm vi

Đối chiếu `origin/dev` ngày 23/10/2026: `0f8eae8`, đã có PD-01 #47. PD-02 #48, PD-03 #52 và PD-08 #49 chưa merge. Không có consumer/inbox/request–reply trong dev để bật chức năng này hoàn chỉnh. Compose có A/B/C và D tùy chọn; không có dịch vụ E/F, cũng chưa có dữ liệu vùng etcd của PD-09 trong dev. **TC61 vùng Nam D/E/F bị chặn, PR phải là draft.** Không tuyên bố đã thay thế các dependency này.

Thay đổi độc lập gồm topology quản trị, API và lưu broadcast/kết quả từng bãi, worker publish/reply, hàm nghiệp vụ nhận transaction client, guard cho HTTP cũ, giao diện và test. Không sao chép implementation inbox hay bảng `commands` của PD-02/PD-03. Điểm nối consumer nằm trong patch chờ dependency, được thử trên candidate riêng.

Nhánh `hung-pd-04-admin-broadcast` dùng dấu gạch ngang vì ref `hung` hiện hữu chặn tên `hung/pd-04-admin-broadcast`; theo lựa chọn đã được cho phép trong PD-01. Không thêm `codex/`.

## Topology và vùng

- Giữ vhost `/`, URI `/%2F`, cùng permissions và connector PD-01.
- `parking.commands`: topic durable. Broadcast vùng dùng `cmd.zone-<zone>.<type>`, tất cả dùng `cmd.all.<type>`. **Một publish** cho một broadcast; không publish từng bãi.
- Chỉ `cmd.<id>.admin` nhận `cmd.zone-<zone>.#` và `cmd.all.#`. Queue user giữ `cmd.<id>.#`, không nhận hai key này. Không bind unicast `cmd.A.admin.*`, vì key đó khớp queue user PD-01.
- Queue admin durable/quorum/SAC, immutable args chỉ `x-queue-type=quorum`, `x-single-active-consumer=true`. Policy `admin-command-delivery` chứa TTL 600000, max-length 10000, reject-publish, delivery-limit 5, DLX `parking.dlx`/`expired`, at-least-once. Không gắn policy TTL user 10 giây vào admin.
- Definitions seed A/B/C vùng `bac`. Runtime chuẩn bị queue/binding cho các bãi **đã đăng ký** trước publish; không dựng dịch vụ/DB D/E/F. `PARKING_ZONES` là map tĩnh tạm thời, mặc định `{"A":"bac","B":"bac","C":"bac"}`. Nếu registry tương lai có `node.zone`, giá trị đó được ưu tiên.
- Target snapshot gồm cả node OFFLINE, được lưu trong DB trước publish. Snapshot không đổi khi registry/vùng thay đổi sau đó. Node chỉ áp dụng nếu chính nó có trong snapshot đã ký.
- Cấu hình vùng phải đồng nhất trên mọi Aggregator. Đổi vùng cần đối chiếu và bỏ binding vùng cũ trước bật lại; runtime chỉ tự bỏ seed `bac` của A/B/C khi cấu hình khác. Không quảng cáo hỗ trợ thay đổi vùng động/etcd khi PD-09 chưa tích hợp.
- Reply dùng direct exchange `parking.replies`, key `agg.broadcast`, queue chung durable/quorum `agg.broadcast.replies`, không TTL 60 giây để giữ reply qua thời gian Aggregator ngừng. Mọi instance PD-04 có thể consume và ghi DB chung. Key riêng tránh consumer PD-03 lấy rồi bỏ reply broadcast.

## API, định danh và kết quả

Chỉ JWT `ADMIN` được gọi các API sau:

```
GET  /api/admin/broadcast/zones
POST /api/admin/broadcast
GET  /api/admin/broadcast/:id
```

POST nhận đúng `{ zone, type, body }`. `zone=all` chỉ bãi đã đăng ký. Vùng không có bãi trả 404; payload sai trả 400. Header `Idempotency-Key` tối đa 64 ký tự `[A-Za-z0-9_-]`, không có thì server sinh UUID. `broadcastId = <userId>:broadcast-<key>` đồng thời là `messageId` và `correlationId`; namespace `broadcast-` tách khỏi request–reply user. Cùng key + cùng body trả snapshot/kết quả cũ; đổi nội dung với key cũ trả 422. Actor lấy từ JWT của server, HMAC bao phủ envelope và các AMQP properties theo PD-02/PD-03. Metadata truy vết được giữ trong command/outbox/reply.

Ví dụ:

```json
{"zone":"bac","type":"lockFloor","body":{"floor":1,"locked":true}}
```

Các payload được hỗ trợ:

- `setPricing`: `{ "rules": [ { "vehicleType":"CAR", "firstBlockMin":120, "firstBlockFee":25000, "nextHourFee":10000, "overnightFee":30000, "maxDayFee":150000 } ] }`; 1–2 quy tắc, CAR/MOTO không trùng. Dùng `savePricing(client,rules)` hiện hữu.
- `lockFloor`: `{ "floor":1, "locked":true }`; false để mở. Tầng không có trả 404; còn xe/lượt đặt ACTIVE/USED trả 409, không đổi một phần. Chỉ mở lại slot do broadcast khóa, giữ nguyên bảo trì thủ công. Version tăng cùng event outbox theo các loại MAINTENANCE_ON/OFF hiện hữu.
- `banPlates`: `{ "plates":["30A-123.45"], "banned":true }`; false để bỏ cấm. Chuẩn hóa biển số, tối đa 100 biển, không trùng. Guard chặn đặt chỗ/vào bãi, kể cả QR lấy biển số từ reservation; không chặn xe ra/thanh toán. Không hủy các lượt đặt trước một cách ngầm định.

POST gom tối đa 5 giây sau khi lưu intent, trả HTTP 200 với:

```json
{"broadcastId":"...","targets":["D","E","F"],"total":3,"applied":["D","E"],"rejected":[],"missing":["F"],"publishState":"CONFIRMED","expired":false}
```

Đây là ví dụ hợp đồng D/E/F, **không phải kết quả TC61 đã chạy**. `applied` chỉ có khi nhận reply hợp lệ của bãi; `rejected` là lỗi nghiệp vụ đã trả lời; `missing` là chưa có bằng chứng, không đồng nghĩa thất bại. Hết 5 giây không gửi lệnh mới. GET đọc kết quả mới từ DB; frontend tự hỏi lại mỗi 2 giây và có nút kiểm tra thủ công, kể cả sau deadline. Session storage chỉ giữ mã broadcast để mở lại, không giữ payload/biển số. Khi retry trong cùng form, key giữ nguyên nếu nội dung không đổi.

## Persistence, crash và đồng thời

Schema thêm không phá dữ liệu: `admin_broadcasts` giữ định danh, hash request, actor/envelope, target snapshot, deadline và publish lease/state; `admin_broadcast_results` có khóa `(broadcast_id,parking_id)` và hash reply. Không ghi đè nhiều bãi vào `commands.result` của PD-03. Reply phải có parkingId thuộc snapshot, đúng actor/type/correlation và HMAC. Kết quả terminal đầu tiên của từng bãi thắng; duplicate giống nhau được chấp nhận, reply khác không ghi đè. DB ghi thành công rồi mới ack. GET trả projection không chứa payload gốc, secret, chữ ký hoặc biển số; mã lỗi nghiệp vụ chỉ hiện chuỗi mã kiểm soát.

Intent commit trước publish. Worker dùng `FOR UPDATE SKIP LOCKED` + lease 10 giây; chết sau claim hoặc trước/sau confirm có thể publish lại **cùng ID/snapshot/deadline**. Publish confirm chỉ chứng minh broker nhận. Mandatory NO_ROUTE lần đầu là REJECTED/404; nack khi fanout có thể đã nhận ở một số queue nên là UNKNOWN, không khẳng định toàn bộ bị từ chối. UNKNOWN được thử lại sau lease/backoff cùng ID; node inbox bảo vệ hiệu lực. Hết deadline dừng publish, không cấp lại 10 phút. Không có cam kết exactly-once delivery.

Node dùng **inbox processor PD-02 duy nhất**, inject decoder/dispatch admin. INSERT inbox, nghiệp vụ, kết quả và reply outbox cùng transaction; COMMIT rồi ack. Duplicate cùng ID đọc kết quả cũ, không chạy lại. Decoder admin cho phép scope zone/all nhưng kiểm HMAC, role ADMIN do server ký, target, routing key, thuộc tính chuẩn và hạn đúng 10 phút. Các mutation admin được serialize bằng khóa UPDATE trên hàng `admin_command_gate`; user dùng khóa SHARE nên vẫn song song với nhau. Thứ tự gate trước slot tránh race đổi floor/ban với đặt/vào bãi; giữ CAS/version và ràng buộc DB. SAC không được dùng để suy ra async handler tuần tự.

`admin_floor_locks`, `admin_locked_slots`, `banned_plates` lưu DB. Check `clock_timestamp()` sau khi lấy gate/khóa giá/slot, và cuối savepoint; nếu quá hạn rollback mutation rồi ghi kết quả 410 vào inbox/outbox. Consumer admin 4, user 16 khi bật; hai channel/consumer độc lập. Tắt cả hai và drain khi shutdown theo lifecycle PD-02.

## Tích hợp sau khi dependency vào dev

Mặc định `ADMIN_BROADCAST_ENABLED=false`: API báo 503 `ADMIN_BROADCAST_NOT_READY`, không gửi lệnh vào queue không consumer. Chỉ bật khi **mọi node mục tiêu** đã có inbox, relay và signed reply.

1. Merge/rebase PD-02 và PD-03 theo quy trình review; có hook `enrichReply` của PD-03 trước insert outbox. PD-04 không tự merge chúng.
2. Áp dụng hook PD-03 nếu nó còn là patch: `scripts/pd03-pd02-reply.patch` trong PR #52. Copy module `reply-envelope.js` tương ứng.
3. Kiểm tra và áp dụng `git apply --check scripts/pd04-pd02-integration.patch`, sau đó `git apply scripts/pd04-pd02-integration.patch`. Patch yêu cầu base PD-02 + hook signed reply PD-03. Nếu index/slots đã được PD-08/PD-06 thay đổi, ghép cùng lifecycle và guard tương ứng; không ghi đè retry consumer của PD-08. Admin không đi vào retry user (routing/deadline khác hợp đồng).
4. Chạy schema additive theo init service, import definitions/policy. Với DB/node của PD-02, bảo đảm guard nằm trong `reserveIn`, không tạo transaction lồng nhau.
5. Cấu hình vùng đồng nhất, bảo đảm queue quản trị tồn tại, đặt `ADMIN_BROADCAST_ENABLED=true` cho Aggregator và node rồi khởi động lại có kiểm soát.

Patch có capability marker `makeCommandProcessor.supportsCustomDispatch`; thiếu extension thì node báo rõ `PD04_REQUIRES_PD02_DISPATCH_EXTENSION`, tránh âm thầm đưa broadcast qua decoder user.

Không xóa queue/vhost/DB/volume. Queue admin mới dùng args cố định giống definitions; policy mutable. Nếu gặp PRECONDITION_FAILED do queue admin cũ khác loại/SAC, sao lưu definitions, dừng publisher mới, xác định consumer và drain/chuyển dữ liệu sang queue mới có kiểm chứng trước khi đổi binding. Không dùng purge hoặc `down -v` để né lỗi. Bỏ chức năng bằng cờ false, giữ bảng và queue để bảo toàn dữ liệu đã nhận.

## Kiểm tra

```sh
cd parking-node && npm ci && npm test
cd ../aggregator-service && npm ci && npm test
cd ../frontend && npm ci && npm run build
```

Trên môi trường tích hợp, dùng biến Compose chính xác, không để test chạy nhầm project:

```powershell
$env:COMPOSE_PROJECT_NAME='pd04-broadcast'
$env:COMPOSE_FILE='docker-compose.yml;D:\pd04-compose.local.yml'
$env:ADMIN_BROADCAST_ENABLED='true'
$env:RUN_PD04_BROKER='1'
node --test tests/pd04-broadcast.test.mjs
$env:RABBITMQ_MANAGEMENT_URL='http://localhost:15673'
node scripts/check-command-topology.mjs --default-mode
node --test tests/e2e.test.mjs
```

Override local chỉ đổi broker sang 5673/15673 và context node candidate gồm PD-02 + signed reply PD-03 + patch PD-04; không commit candidate/dependency code. `PD04_AMQP_URL` đổi URL broker cho test. Không dùng secret thật trong file theo dõi Git. Test tự khôi phục node C, giá cũ, xóa đúng inbox/outbox/broadcast ID của fixture; không xóa volume. Dùng `docker compose down` giữ volume sau khi thử.

Tạo candidate có thể tái lập bằng `node scripts/prepare-pd04-candidate.mjs <checkout-PD02> <checkout-PD03> <thư-mục-mới>`. Script kiểm patch trước khi áp dụng, chỉ ghi vào thư mục mới và không sửa các checkout dependency. Compose override dùng build context `<thư-mục-mới>/parking-node` cho cả A/B/C.

## Giới hạn phải giữ trong review

TC61 Nam D/E/F chưa được kiểm chứng; không tự dựng toàn bộ môi trường PD-12 hay etcd PD-09. Test A/B/C candidate không chứng minh dependency đã tích hợp dev. Consumer expired/leader update trạng thái thuộc PD-06; PD-04 kiểm không áp dụng lệnh admin đã quá hạn nhưng không làm thay toàn bộ TTL/back-pressure. Clock skew giữa Aggregator và DB, khoảng rất nhỏ giữa final deadline check và COMMIT cần hợp đồng thời gian PD-06; không tuyên bố commit-time deadline tuyệt đối. Không có saga, fencing hoặc cấu hình vùng động. Runtime cần ngân sách retention/giám sát reply/broadcast DB trong triển khai lâu dài.
