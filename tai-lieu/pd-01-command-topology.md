# PD-01 – Topology kênh lệnh RabbitMQ

Phạm vi của Vũ Văn Hùng theo Issue #18, kế hoạch mở rộng giai đoạn 2 bản 1.4 mục 5.1, 5.2, phụ lục B và PDF phân công: topology, publisher confirm, mandatory return và một đường HTTP bổ sung để kiểm chứng TC56. Chưa có consumer nghiệp vụ, inbox, bảng commands, request–reply, TTL mặc định, retry/DLQ, back-pressure hay tracing. HTTP nghiệp vụ cũ vẫn hoạt động.

## Cấu hình và vhost

Chọn **`/`** theo hệ thống đang chạy trên `origin/dev`: URI cũ không có path nên dùng `/`, các dịch vụ sự kiện và tài khoản demo cũng dùng vhost này. Phụ lục B nêu `/parking`, còn PDF phân công nêu `/`; PD-01 giữ `/` để không chuyển dữ liệu/topology sự kiện. Definitions, permissions, URI Compose và test đều dùng `/` (trong URI ghi rõ `/%2F`). Không xóa hay chuyển `/parking` nếu đã có.

`rabbitmq/definitions.conf` nạp `definitions.json` bằng bộ import của RabbitMQ 3.13 trên **cả ba nút**, gồm nút seed. File chung này tách khỏi `cluster.conf` vì cấu hình peer discovery chỉ gắn vào nút 2/3. Không gắn peer discovery của follower vào seed để tránh chờ nhau khi khởi động.

Definitions có user demo `parking`, hash của mật khẩu demo công khai `parking`, vhost `/`, permissions configure/write/read `.*`. Hash demo không phải bí mật triển khai. `RABBITMQ_DEFAULT_USER/PASS` không thay thế user trong definitions. Khi triển khai với thông tin riêng, chuẩn bị file definitions riêng ngoài Git, đặt `RABBITMQ_DEFINITIONS_FILE` và `RABBITMQ_URL` tương ứng trên mọi dịch vụ/nút; không commit file riêng, mật khẩu hay bản export có credentials. Import có thể cập nhật hash user đã có: đọc phần nâng cấp trước khi dùng với dữ liệu cũ.

| Thành phần | Cấu hình |
|---|---|
| `parking.commands`, `parking.dlx` | topic, durable |
| `cmd.A`, `cmd.B`, `cmd.C` | durable, quorum, `x-single-active-consumer=true` |
| Policy `command-delivery` | Pattern `^cmd\.[A-F]$`, quorum queues, priority 10; `dead-letter-exchange=parking.dlx`, `dead-letter-routing-key=expired`, `dead-letter-strategy=at-least-once`, `overflow=reject-publish`, `max-length=10000`, `delivery-limit=5`. Queue arguments chỉ giữ type quorum và SAC. |
| Binding | `parking.commands` → `cmd.<bãi>` với `cmd.<bãi>.#` |
| Đích dead-letter | `parking.dlx` → `cmd.expired` với `expired`; queue durable, quorum; chưa có consumer EXPIRED (PD-06) |
| Sự kiện giữ nguyên | Exchange, queue và binding sự kiện do các dịch vụ đang chạy tự tạo bằng assertExchange/assertQueue; không bootstrap trong definitions, không tạo sẵn queue Aggregator `.2`. |

`origin/dev` chưa có môi trường 6 bãi; chỉ có D tùy chọn dưới profile `extra`. PD-01 tạo A–C theo phân công, chưa tạo D–F hoặc tự đăng ký bãi. Sau PD-12, bổ sung D–F với arguments type/SAC và binding tương ứng; policy đã bao phủ A–F. Trước đó publish tới D sẽ bị return dù D có trong registry. Không có `assertQueue` cho command trong publisher; queue sự kiện chỉ được khai báo bởi runtime. Import bổ sung topology, không xóa queue/binding khác đang có.

## Publisher và API bổ sung

`makeCommands(RABBITMQ_URL)` tạo một publisher dùng `makeConnector`; `send(parkingId, type, payload, opts)` tái sử dụng connection/confirm channel. Connector thử các URI theo thứ tự nút đang hoạt động. Khi mất connection/channel, publisher hủy trạng thái hiện tại; request tiếp theo kết nối lại. Không tự publish lại lệnh có kết quả chưa xác định.

Routing key: `cmd.<parkingId>.<type>`. Mỗi segment gồm 1–64 ký tự chữ/số, `_`, `-`; cấm `.`, `#`, `*` để không vô tình multicast. Không kiểm registry để quyết định khả năng định tuyến.

AMQP properties luôn có `mandatory=true`, `persistent=true`, `contentType=application/json`, `type`, `messageId` (UUID nếu chưa truyền), `correlationId` (mặc định messageId). Giữ `replyTo`, `expiration` nếu caller truyền; PD-01 không tự đặt TTL. Header tùy chỉnh được giữ. `causationId`, `fencingToken`, `hlc`, `traceparent`, `actor`, `schemaVersion` lấy từ opts/header và có trong envelope JSON cùng `type`, `parkingId`, `payload`; schemaVersion mặc định 1. Đây chỉ là chuyển tiếp dữ liệu envelope, chưa tạo HLC/span hoặc kiểm fencing.

Header nội bộ `x-command-publish-id` được publisher cấp riêng cho **mỗi lần publish**, không dùng làm khóa nghiệp vụ. Nhờ vậy hai lần gửi đồng thời cùng messageId/correlationId vẫn ghép `basic.return` đúng promise. Confirm callback riêng từng tin, không dùng một `waitForConfirms()` chung cho các HTTP request đồng thời. RabbitMQ gửi return trước confirm cho tin mandatory không định tuyến được.

Endpoint: `POST /api/admin/parkings/:id/commands`, JWT ADMIN. Ví dụ với token đăng nhập admin:

```bash
curl -i http://localhost:8000/api/admin/parkings/UNKNOWN/commands \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"reserve","messageId":"admin:probe-1","payload":{"slotCode":"UNKNOWN"}}'
```

| Kết quả publish | HTTP | Body |
|---|---|---|
| mandatory return `NO_ROUTE` (312) | 404 | `error: PARKING_NOT_FOUND` |
| Confirm và không return | 202 | `messageId`, `correlationId`, `status: BROKER_CONFIRMED`, `processed: false` |
| Không kết nối/thiết lập được channel trước publish | 503 | `error: BROKER_UNAVAILABLE` |
| Broker basic.nack | 503 | `error: PUBLISH_NACKED` (chưa quy kết queue đầy) |
| Mất channel/connection sau publish, confirm timeout, publish throw | 504 | `error: PUBLISH_UNKNOWN_RESULT` |
| Return khác NO_ROUTE | 502 | `error: PUBLISH_RETURNED` |
| Routing segment/ID không hợp lệ | 400 | `error: INVALID_COMMAND` |

Setup và confirm có thời hạn 3 giây; socket connect 2 giây mỗi nút. Đây là thời hạn chờ publisher, không phải TTL lệnh. Confirm chỉ chứng minh broker nhận tin, **không chứng minh node xử lý**. Endpoint này chưa lưu trạng thái lệnh và chưa chống trùng nghiệp vụ; 202 không hứa có API tra cứu kết quả. Lệnh gửi tới A–C sẽ nằm chờ đến khi consumer PD-02 được triển khai. Tránh dùng endpoint cho nghiệp vụ thật trong giai đoạn này.

## Chạy và kiểm tra

```bash
cp .env.example .env
docker compose up -d --build --wait
node scripts/check-command-topology.mjs
npm ci --prefix parking-node
npm ci --prefix aggregator-service
npm ci --prefix notification-service
npm ci --prefix frontend
npm test --prefix parking-node
npm test --prefix aggregator-service
npm test --prefix notification-service
npm run build --prefix frontend
node --test tests/e2e.test.mjs
node --test --test-name-pattern=TC56 tests/e2e.test.mjs
```

Script Management API chỉ đọc, kiểm tra topology lệnh, arguments, policy hiệu lực, bindings và permissions. Các biến tùy chọn: `RABBITMQ_MANAGEMENT_URL` (mặc định `http://localhost:15672`), `RABBITMQ_MANAGEMENT_USER`, `RABBITMQ_MANAGEMENT_PASSWORD` (mặc định demo parking). Management UI xem vhost `/`, Queues `cmd.*`, Exchanges `parking.commands`/`parking.dlx`.

Test AMQP trực tiếp chỉ chạy trên **stack test cô lập**, vì có consumer kiểm chứng reject/DLX trên `cmd.A` và `cmd.expired`:

```bash
PD01_AMQP_URL='amqp://parking:parking@localhost:5672/%2F' node --test aggregator-service/test/commands-live.test.js
```

PowerShell đặt biến bằng `$env:PD01_AMQP_URL='...'` rồi chạy `node --test ...`. Test có queue tạm exclusive tự dọn; tin probe của test trong queue lệnh được ack sau kiểm tra. Không chạy khi có lệnh thật hoặc consumer nghiệp vụ. Không đặt biến này trong CI unit thông thường.

## Sửa topology sau review ngày 22/10/2026

Definitions hiện chỉ bootstrap **2 exchange lệnh, 4 quorum queue lệnh, 4 binding và 1 policy**; user/vhost/permissions vẫn giữ nguyên. Bỏ cả 5 queue Aggregator/notification và binding khỏi bootstrap để không tạo queue không có consumer ở chế độ mặc định. Runtime vẫn tự tạo topology sự kiện khi dịch vụ tương ứng chạy.

Phụ lục B đặt DLX trong x-arguments; bản sửa giữ cùng hành vi nhưng đưa các giá trị có thể thay đổi sang policy. Queue arguments chỉ còn `x-queue-type` và `x-single-active-consumer`. Có thể thay policy khi queue đã chứa tin, không cần xóa/tạo lại queue **được tạo theo definitions mới**. Script kiểm chứng cả policy và `effective_policy_definition` để tránh trường hợp policy bị arguments cũ ghi đè.

Khi thay policy trong bản triển khai sau, cập nhật cả policy trong definitions để lần khởi động/import tiếp theo không đặt lại giá trị cũ. Giữ đầy đủ các thuộc tính trong definition khi đổi routing key; không thêm policy ưu tiên cao chỉ có một trường rồi vô tình mất các giới hạn/điều kiện at-least-once của policy đang dùng.

Policy không tự chọn routing key theo lý do dead-letter: hiện expired/rejected/delivery_limit vẫn được giữ ở cmd.expired. PD-06/PD-08 cần phân loại `x-death.reason` và chỉ ack sau khi chuyển tiếp được xác nhận; chưa triển khai consumer này trong PD-01. Nếu đổi policy sang key dead, phải chuẩn bị binding/đích bền vững tương ứng trước. Không tạo thêm cmd.dead hoặc retry topology trong sửa đổi này.

**Broker đã nạp bản cũ:** bỏ queue/binding khỏi JSON không xóa chúng khỏi broker; queue sự kiện `.2` có sẵn vẫn giữ dữ liệu/binding. Policy cũng không gỡ x-arguments cũ; client arguments có thể lấn policy. Không tự xóa queue/volume. Cần kiểm kê, giữ payload/credentials và dùng chuyển đổi song song bên dưới nếu muốn bỏ arguments cũ; không thể coi chỉ import JSON mới là đã sửa broker cũ. Với `.2` còn backlog, cần thống nhất replay/lưu trữ trước khi bật consumer để tránh phát hàng loạt thông báo cũ.

Chạy `node scripts/check-command-topology.mjs --default-mode` trên stack mặc định để xác nhận ba queue sự kiện runtime có consumer và không có hai queue `.2`. Không dùng cờ này khi đã bật aggregator-2 hoặc còn queue từ lần chạy HA trước.

Test opt-in `commands-policy-live.test.js` chỉ chạy riêng trên stack test cô lập: đặt probe vào cmd.C, đổi policy tới đích test, kiểm probe còn nguyên, reject và nhận đúng ở đích mới, rồi khôi phục policy. Không purge hoặc khai báo lại cmd.C. Đặt `PD01_AMQP_URL` và `PD01_POLICY_MANAGEMENT_URL` rồi chạy `node --test aggregator-service/test/commands-policy-live.test.js`. Không chạy song song live suite khác vì test tạm đổi policy chung. Management API có độ trễ cập nhật nên test đợi policy hiệu lực trước khi kiểm tra.

## Nâng cấp bảo toàn dữ liệu và hoàn tác

1. Trước khi nạp lên broker cũ, export definitions riêng (có users/hash/permissions) và kiểm kê queue arguments, bindings, số ready/unacked; sao lưu dữ liệu broker theo quy trình hiện có. **Export definitions không chứa nội dung tin nhắn.** Lưu snapshot volume khi broker đã dừng an toàn; không xóa volume. Không đưa bản export riêng vào Git.
2. So sánh arguments với file mới. Nếu user `parking` đang có mật khẩu riêng, tạo private definitions dùng hash/quyền hiện tại và thêm topology PD-01; chọn file đó qua `RABBITMQ_DEFINITIONS_FILE`. URI phải cùng user/vhost ở tất cả dịch vụ. Giữ lại cấu hình và topology không thuộc PD-01.
3. Với topology tương thích, import/nạp lại definitions rồi chạy script kiểm tra. Không đổi queue type hoặc arguments bất biến tại chỗ. `PRECONDITION_FAILED` là lý do dừng nâng cấp để đối chiếu, không phải lý do xóa queue/volume.
4. Nếu đã có `cmd.*` hoặc queue sự kiện cùng tên nhưng arguments khác, chuẩn bị broker/cụm song song với **vhost `/` và volume mới**. Giữ nguyên broker cũ. Tạm dừng publishers/consumers của queue cần chuyển, kiểm kê và chuyển tin theo thứ tự bằng công cụ chuyển tiếp có publisher confirm + mandatory; chỉ ack nguồn sau confirm đích và không có return. Kiểm tra số tin, ID, properties/header, không có unacked trước cutover. Cần tính đến khả năng bản sao khi gián đoạn; PD-01 chưa có inbox để loại trùng nghiệp vụ. Không dùng export/import definitions như bản sao payload.
5. Chuyển URI mọi dịch vụ sang broker mới khi đã đối chiếu xong; kiểm thử HTTP cũ, sự kiện và TC56. Giữ broker/volume cũ cho đến khi được xác nhận dữ liệu đã chuyển đủ. Không có script tự động xóa/chuyển dữ liệu trong PR.

Hoàn tác app/Compose bằng commit trước; giữ volume và topology đã nạp. Dừng sử dụng endpoint publish mới, bảo toàn lệnh đang chờ. Khi dùng cutover song song, không chuyển ngược URI nếu chưa đối chiếu cả lệnh mới đã nhận ở broker đích. Không chạy `docker compose down -v` để hoàn tác.

## Kiểm chứng sau review ngày 22/10/2026

Stack mới cô lập `pd01-review`, cổng broker 5673/15673; không xóa hoặc sửa volume của `pd01-command` hay broker khác. Definitions mới và policy đã được nạp ngay từ lần khởi động đầu.

- `check-command-topology.mjs --default-mode`: **2 exchanges, 4 quorum queues, 4 bindings, 1 policy**; cả policy khai báo và hiệu lực đều đúng. Runtime có `aggregator.slot-updates.1`, `aggregator.notifications.1`, `notification.events` với consumer; không có hai queue `.2`. Kiểm tra lại sau restart broker và bật hai broker HA vẫn đạt.
- E2E đầy đủ: **12 đạt, 1 TC47 bỏ qua**, không lỗi. TC56 **137 ms**; luồng sự kiện, thông báo, HTTP và restart node/DB/Aggregator/broker đạt khi queue sự kiện chỉ được runtime tạo.
- Bộ tập trung publisher/unit/HTTP/live: **12/12 đạt** trên cụm ba nút sau sửa.
- Test policy riêng: **1/1 đạt**, thay routing key khi tin đã nằm trong cmd.C, tin còn nguyên và tới đúng đích mới sau reject, không xóa/redeclare cmd.C; policy gốc được khôi phục cả khi test lỗi. Test có polling vì Management API cập nhật policy hiệu lực trễ; lần kiểm tra ban đầu đã phát hiện độ trễ này, sau sửa test đã đạt trên một nút và cụm ba nút.
- Log cuối cùng và snapshot queue/consumer/policy/members nằm trong `tai-lieu/pd-01-evidence.txt`. Không tuyên bố broker đã nạp definitions cũ được tự chuyển đổi.

Danh tính Git cấu hình riêng cho repo: `Vũ Văn Hùng <165639660+hungvu205@users.noreply.github.com>`. Email noreply đối chiếu với ID tài khoản GitHub hungvu205 và các commit trước của Hùng. Commit PD-01 được amend/reset-author; không thay tác giả các commit khác.

## Bằng chứng trước review ngày 21/10/2026

Worktree sạch từ `origin/dev` tại `1519d4c8b924c9376265db8880a1bfc5f439b900`; không lấy các sửa đổi chưa commit ở checkout của người khác. Không tìm thấy AGENTS.md trong repo hoặc thư mục cha đã kiểm tra. Đã đọc README, Issue #18, mẫu PR trên main và mẫu local, kế hoạch 1.4 và PDF phân công trong Downloads.

Stack riêng `pd01-command`, RabbitMQ **3.13.7**. Vì cổng 5672/15672 đang được broker khác dùng, override local chỉ đổi host port sang **5673/15673**; không sửa/dừng broker đó. `docker compose ... config --quiet` và `up -d --build --wait` đạt. Không xóa volume.

- Management API: **4 exchanges, 9 quorum queues, 9 bindings, permissions parking trên `/`**, arguments đúng. Kiểm tra lại sau khi thêm hai nút HA vẫn đạt.
- `rabbitmqctl cluster_status`: ba nút `rabbit@rabbitmq`, `rabbit@rabbitmq-2`, `rabbit@rabbitmq-3` online, không alarm/partition. API `/api/queues/%2F` cho thấy `cmd.A/B/C` và `cmd.expired` đều có ba members/online. Feature flag `stream_queue` enabled, đáp ứng điều kiện at-least-once dead lettering.
- Unit publisher + HTTP: **10/10 đạt**; routing/properties/envelope, concurrent IDs, return/nack, mất channel, timeout, setup bị treo/late connection, reconnect, phân quyền và ánh xạ HTTP.
- AMQP trực tiếp: **2/2 đạt** trên cụm ba nút: 20 mandatory return đồng thời cùng messageId với tin có route nhận đúng; tái sử dụng/kết nối lại; reject probe `cmd.A` tới `cmd.expired` với `x-death.reason=rejected`, routing key `expired`.
- Toàn bộ e2e: **12 đạt, 1 bỏ qua TC47** (điều kiện chaos có sẵn), không lỗi. TC56 lần chạy đầy đủ khoảng **129 ms**; chạy lại sau rebuild publisher trên cụm ba nút **1.326 s**, dưới ngưỡng 2.5 s và timeout publish 3 s. Lần ghi log cuối cùng sau rà soát đạt **314 ms** (xem evidence). Các test tắt/bật node/DB/Aggregator/broker và đường HTTP cũ đạt.

Lần thử DLX đầu dùng `basic.get` bị RabbitMQ trả `RESOURCE_LOCKED` vì quorum queue có SAC; đã sửa phép thử sang consumer, ack các probe của lần thử hỏng rồi chạy lại đạt. Phép thử cũng xử lý các probe cũ trong namespace `dlx-test:` vì đường dead-letter at-least-once có thể giao trùng; tin ngoài namespace được giữ/requeue và làm test báo lỗi. Đã xác nhận live suite chạy lặp đạt. Không purge queue hay xóa volume.

Hồi quy trước review: `parking-node` **46/46 đạt**; `aggregator-service` **39 đạt, 1 live test bỏ qua** tại thời điểm chạy bộ mặc định (sau đó mở rộng live suite và chạy riêng **2/2 đạt**); `notification-service` **2/2 đạt**; frontend build đạt. `origin/dev` không có package.json gốc nên không có `npm run check`; đã chạy từng lệnh tương đương ở trên. Log `tai-lieu/pd-01-evidence.txt` được cập nhật bằng kết quả sau review; các số 4/9/9 trong phần này chỉ mô tả bản cũ ngày 21/10. Chưa kiểm chứng inbox/request–reply/TTL/back-pressure/tracing hoặc môi trường sáu bãi vì ngoài PD-01. CI e2e trong repo chỉ chạy PR vào dev khi có nhãn `e2e`.

Tham khảo kỹ thuật: [RabbitMQ 3.13 quorum queues và điều kiện at-least-once dead lettering](https://www.rabbitmq.com/docs/3.13/quorum-queues), [import definitions khi khởi động](https://www.rabbitmq.com/docs/definitions).
