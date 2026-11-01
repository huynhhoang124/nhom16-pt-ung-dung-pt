# PD-02 – Inbox xử lý lệnh tại parking node

Theo Issue #19, kế hoạch giai đoạn 2 bản 1.4 mục 5.2/5.4/5.5 và tài liệu phân công của Vũ Văn Hùng. PD-01 đã merge vào dev tại `0f8eae8356192543eb42323786c522ef33fc7ec9`. Issue #19 chưa có bình luận duyệt thiết kế; người dùng đã xác nhận trong chat: **“Không cần chờ Huynh duyệt thiết kế nữa hãy làm tiếp nvu này”**. Đây là miễn điều kiện duyệt từ người dùng, không phải bằng chứng Huynh đã duyệt. Không đăng bình luận Issue thay người dùng.

Nhánh `hung-pd-02-command-inbox` từ origin/dev trong worktree riêng. Ref `hung` có sẵn cả local/origin nên Git không cho tạo `hung/pd-02-command-inbox`; dùng cách đặt tên có dấu gạch ngang như PD-01. Không lấy thay đổi chưa commit từ checkout khác.

## Schema và phạm vi duy nhất

Schema được nạp idempotent bởi init hiện có, chỉ bổ sung bảng/index, không drop bảng hoặc xóa dữ liệu:

| Bảng | Các cột |
|---|---|
| `inbox_messages` | `message_id TEXT PRIMARY KEY`, `command_type TEXT NOT NULL`, `request_hash TEXT NOT NULL`, `result JSONB`, `status_code INT`, `processed_at TIMESTAMPTZ` |
| `command_reply_outbox` | `id BIGSERIAL PRIMARY KEY`, `command_id TEXT NOT NULL`, `reply_to TEXT NOT NULL`, `payload JSONB NOT NULL`, `properties JSONB NOT NULL`, `created_at TIMESTAMPTZ DEFAULT now()`, `published_at TIMESTAMPTZ`, `next_attempt_at TIMESTAMPTZ`, `last_error TEXT` |

Chọn **`command_type`** theo tài liệu phân công; không dùng thêm cột `type` trong inbox. Index `ix_inbox_processed_at` phục vụ dọn dữ liệu; partial index `ix_command_replies_unpublished` phục vụ relay. `processed_at` chỉ được đặt khi đã có kết quả; dòng đang xử lý chưa commit không hiện ra ngoài transaction.

`messageId=<userId>:<Idempotency-Key>` duy nhất **trong DB mỗi bãi, xuyên reserve/cancel/pay**; phần key 1–64 ký tự, full ID tối đa 128 ký tự để khớp request_id/payment_key hiện có. Cùng user/key ở hai DB bãi khác nhau là hai phạm vi độc lập. Không tái sử dụng một key cho reserve rồi cancel/pay trong cùng bãi.

`request_hash` là SHA-256 của JSON sắp khóa ổn định gồm type, parkingId, actor và payload. Đổi thứ tự khóa JSON không đổi hash; đổi loại lệnh, actor hoặc payload trả 422 `IDEMPOTENCY_KEY_REUSED`. Giữ nguyên inbox/kết quả gốc và tạo phản hồi lỗi riêng cho lần dùng sai. Correlation/reply routing và metadata causation/trace/HLC/fencing không nằm trong fingerprint, cho phép một lần gửi lại hợp lệ nhận kết quả ở địa chỉ phản hồi mới.

## Envelope và nguồn actor

Properties AMQP là nguồn chuẩn cho messageId/correlationId/replyTo/expiration. Phải có messageId đúng actor, correlationId và replyTo hợp lệ; expiration nếu có là chuỗi số. Body schemaVersion=1, type reserve/cancel/pay, parkingId đúng node, actor/payload là object. Trường properties lặp trong body hoặc metadata lặp giữa body/header phải nhất quán. Giới hạn nội dung lệnh 10 KB; không tự đặt TTL.

Aggregator xác lập actor từ `req.user` của phiên JWT; bỏ qua actor do client gửi. Endpoint quản trị PD-01 bổ sung default messageId theo user đã xác thực và key/UUID, replyTo `agg.<INSTANCE_ID>`; từ chối messageId thuộc người khác. **API nghiệp vụ cũ vẫn dùng HTTP**, không chuyển sang broker hay trả 201/202 theo PD-03 trong PR này.

Publisher ký HMAC-SHA256 bằng INTERNAL_KEY trên canonical body cùng các properties chuẩn và type; node xác minh bằng timingSafeEqual trước khi chạm DB. Không dựa vào role trong JSON hoặc tài khoản AMQP chung để tin actor. Hai bản `command-signature.js` dùng cùng wire contract vì Docker build từng service riêng; unit test đối chiếu trực tiếp chữ ký producer/consumer. Key không được đưa vào body, header, DB hoặc log. Transport headers do RabbitMQ bổ sung và ID lần publish không thuộc chữ ký. Khi PD-08 thay properties/envelope để retry, phải ký lại bằng code server tin cậy.

USER chỉ reserve/pay cho chính mình, cancel đặt chỗ của mình. STAFF chỉ cancel trong bãi được gán, không được reserve/pay; ADMIN có thể cancel mọi đặt chỗ trong bãi. Reserve của ADMIN vẫn gắn chính actor; pay luôn ONLINE và ràng buộc chủ phiên. Payload userId/requestId/paymentKey không được đổi danh tính/khóa do server xác lập. QR token được tạo bằng cùng cấu hình với HTTP rồi lưu trong kết quả inbox.

CausationId, traceparent, hlc và fencingToken được giữ trong phản hồi/header khi có; chưa tạo span, đồng hồ HLC hoặc kiểm fencing của PD-10/PD-17. Fencing token chấp nhận số nguyên an toàn không âm hoặc chuỗi số tối đa 20 chữ số để không làm mất độ chính xác token lớn.

## Transaction, đồng thời và lỗi

Mỗi lần xử lý dùng một client và một `BEGIN/COMMIT`:

1. INSERT inbox `ON CONFLICT DO NOTHING RETURNING message_id`.
2. Tin mới chạy `reserveIn/endReservationIn/payIn` trên chính client đó. Tin trùng đọc status/result đã commit; không gọi lại nghiệp vụ.
3. Ghi result/status/processed_at nếu mới, rồi ghi phản hồi vào outbox trên cùng client.
4. COMMIT thành công mới trả khỏi processor; consumer chạy hook test (nếu bật), rồi mới ack.

Các HTTP wrapper `reserve/endReservation/pay` vẫn mở transaction riêng khi được gọi từ HTTP; phần thân `*In` không tự BEGIN/COMMIT. Savepoint `business_operation` bảo vệ thay đổi nghiệp vụ: lỗi Abort hoặc ràng buộc 23P01/23505 được rollback về savepoint trước khi chuyển thành kết quả ổn định. Vì vậy lỗi trùng giờ 409 vẫn lưu được inbox và outbox mà không để transaction ở trạng thái aborted. Lỗi hạ tầng, lỗi ghi inbox/outbox hoặc COMMIT không rõ kết quả rollback nếu còn có thể và không ack; giao lại sẽ dựa vào inbox để biết transaction trước đã commit hay chưa.

Consumer manual ack, prefetch **20**, nhưng dùng một chuỗi promise tuần tự trong mỗi connection. SAC chỉ chọn consumer, không được coi là bảo đảm callback async hoàn tất tuần tự. Unique key Postgres vẫn là cơ chế chống duplicate giữa nhiều client/tiến trình: INSERT thua chờ transaction thắng, rồi SELECT đọc kết quả ở isolation READ COMMITTED mặc định. CAS/version, row lock và ràng buộc EXCLUDE/UNIQUE cũ vẫn giữ cho HTTP, timer nền và các lệnh tranh cùng slot.

Reconnect chỉ có một loop, đợi handler của connection cũ kết thúc trước khi tạo consumer mới. Tin đã prefetch nhưng chưa chạy được giữ unacked để broker giao lại. Lỗi tạm đóng connection rồi backoff từ 5 giây, tăng gấp đôi đến tối đa 60 giây nếu đăng ký consumer tiếp tục thất bại; đăng ký thành công đặt lại 5 giây; không nack requeue liên tục. Hook `retryOrDead` cho PD-08 chỉ cho ack nguồn khi hook trả true sau chuyển tiếp được xác nhận. Khi chưa có PD-08, tin sai envelope/chữ ký được reject không requeue, đi vào DLX bền vững `cmd.expired` theo policy PD-01. Tin lỗi tạm giao lại quá delivery-limit cũng có thể vào đây; chưa có xử lý/phân loại EXPIRED/dead trong PR này.

## Outbox phản hồi và vòng đời

Không ép phản hồi vào parking_events vì bảng đó yêu cầu slot_code. Relay riêng gửi `command_reply_outbox` qua exchange direct durable `parking.replies`, routing key=replyTo. Body gồm commandId, commandType, parkingId, actor, statusCode, result và metadata; properties gồm messageId phản hồi riêng, correlationId gốc và header causation/trace/HLC/fencing.

Publish mandatory/persistent và confirm từng tin, dùng chung connection/channel. Return/nack/disconnect/timeout giữ `published_at` NULL; chỉ cập nhật sau confirm và không có return. Relay chạy mỗi 500 ms, không chạy chồng trong một tiến trình; có thể phát lại phản hồi nếu chết sau confirm trước cập nhật DB. PD-03 cần ghép/loại trùng phản hồi theo commandId/correlationId; đây không phải exactly-once delivery. Khi broker trả NO_ROUTE (312), row vẫn chưa published, được đánh dấu last_error=NO_ROUTE và next_attempt_at sau 30 giây; relay đi tiếp tới đích khác. Khi binding xuất hiện, row đến hạn được phát lại và chỉ đánh dấu đã gửi sau confirm. Nack/disconnect/confirm timeout không bị coi là NO_ROUTE: giữ pending và dừng batch để tránh thử liên tục trên broker lỗi. Đây là lịch gửi lại phản hồi đã lưu, không phải retry thực thi lệnh PD-08.

`parking.replies` chỉ được runtime khai báo; chưa tạo queue phản hồi Aggregator, bảng commands, HTTP wait/poll hoặc Socket.IO kết quả của PD-03. Queue phản hồi trong test là exclusive, tự dọn khi đóng connection. Relay sự kiện cũ được giữ; chỉ bổ sung close cho lifecycle, không làm batching/SKIP LOCKED của PD-18.

Inbox được dọn sau **7 ngày** mỗi **30 giây** bằng đồng hồ DB; sau đó không còn bảo đảm dedup từ inbox và kết quả lỗi có thể được đánh giá lại. Các khóa nghiệp vụ cũ có thể vẫn còn trong reservations/payment, nhưng không thay thế một bảo đảm dedup vô hạn. Outbox chưa gửi không bị xóa cùng inbox.

SIGTERM/SIGINT dừng HTTP/consumer, clear toàn bộ timer, chờ handler và job đang chạy, đóng publisher/DB pool. Quá deadline shutdown 10 giây thì thoát lỗi để broker giao lại unacked. Test TC53 kiểm shutdown bình thường exit 0 trước khi bật worker crash.

## Test crash và cách chạy

Hook chỉ hoạt động khi **cả** `NODE_ENV=test` và `COMMAND_TEST_CRASH_MESSAGE_ID` trùng lệnh. Sau COMMIT, trước ack, hook tạo marker `/tmp/pd02-crash-<sha256(messageId)>` bằng exclusive create rồi exit **86**. Restart cùng container giữ marker nên không crash lại với cùng biến môi trường. Mặc định không bật; không có cấu hình crash trong Compose sản phẩm.

```bash
npm ci --prefix parking-node
npm ci --prefix aggregator-service
npm ci --prefix notification-service
npm ci --prefix frontend
npm test --prefix parking-node
npm test --prefix aggregator-service
npm test --prefix notification-service
npm run build --prefix frontend
cp .env.example .env
docker compose build parking-a aggregator frontend notification
docker compose up -d --no-build --wait
node --test tests/e2e.test.mjs
node --test --test-name-pattern='PD-02' tests/e2e.test.mjs
```

Build parking-a một lần để dùng chung image cho A/B/C, tránh ba target cùng ghi một image tag khi Docker Desktop export song song. Không cần xóa cache hay volume. Nếu cổng broker mặc định đã bận, dùng override port riêng và đặt PD02_AMQP_URL trỏ tới broker của stack test. COMPOSE_PROJECT_NAME/COMPOSE_FILE áp dụng cho mọi thao tác Docker của e2e.

TC52 broker dùng 10 publish đồng thời cùng messageId, kiểm một reservation/inbox/event và 10 phản hồi giống nhau. Test PostgreSQL riêng chạy 10 transaction client thật để không chỉ dựa vào consumer tuần tự; có thêm race khác ID cùng slot, lỗi SQL/savepoint và rollback outbox. TC53 dừng parking-a, chạy worker container tạm dùng cùng DB và hook một lần, chờ exit 86, restart **cùng container**, kiểm giao lại tạo phản hồi mới nhưng không thêm reservation/event. Finally dọn container test, khôi phục parking-a, cancel đặt chỗ thử và dọn đúng inbox/outbox test; không xóa volume.

Test `commands-pg.test.js` bỏ qua trong unit thông thường; e2e copy test vào container và chạy với PD02_REAL_DATABASE_URL, PD02_SOURCE_ROOT để dùng PostgreSQL thật. Chỉ chạy trên stack test cô lập. CI e2e được bổ sung npm ci ở aggregator-service vì harness broker dùng publisher/amqplib của service đó.

**TC52 cấp HTTP qua broker chưa kiểm chứng**: PD-03 chưa triển khai request–reply/Idempotency-Key cho đường đó. Scaffold `tests/command-inbox-http.test.mjs` được import vào e2e nhưng skip rõ lý do; chỉ bật `PD03_HTTP_COMMANDS=1` khi PD-03 có mặt và đối chiếu lại hợp đồng `GET /api/commands/:id`/result. Scaffold kiểm cả command lookup nên không thể lấy idempotency HTTP cũ làm bằng chứng broker. Các test idempotency HTTP hiện có tiếp tục kiểm đường HTTP cũ. Không làm PD-08/10/17/18 hoặc TTL/back-pressure/tracing.

## Nâng cấp và hoàn tác

Giữ vhost `/` và topology command/policy của PD-01. Chạy phiên bản mới để init thêm bảng/index; có thể chạy lại init, không cần down -v. Nếu đã tự tạo inbox schema khác ngoài dev (ví dụ cột type), đối chiếu và chuẩn bị migration bổ sung phù hợp trước khi chạy; không drop bảng để đổi tên.

Giữ INTERNAL_KEY nhất quán giữa Aggregator và node vì nay dùng để ký/xác minh lệnh, ngoài HTTP nội bộ. Trước khi bật consumer, kiểm kê tin cũ trong cmd.*: tin từ publisher cũ không có chữ ký/đúng ID sẽ không được thực thi mà được giữ qua DLX để xử lý có kiểm soát. Không tự tin actor cũ rồi ký lại. Không đổi key trong khi còn tin ký bằng key cũ mà chưa có kế hoạch chuyển tiếp.

Hoàn tác bằng phiên bản trước và giữ hai bảng/outbox; dừng publisher broker, bảo toàn lệnh đang chờ và các phản hồi chưa gửi. Việc hoàn tác không đảo ngược nghiệp vụ đã commit. Không tự xóa queue/volume hoặc tuyên bố tác vụ đã được Huynh duyệt.

## Kết quả thực tế ngày 22/10/2026

- parking-node: **58 đạt, 1 opt-in PostgreSQL bỏ qua** trong unit; test PostgreSQL thật đã chạy riêng qua e2e và đạt.
- aggregator-service: **39 đạt, 3 opt-in AMQP bỏ qua**. Lượt đầu chạy cùng Docker build/e2e có một request vượt ngân sách HTTP test 400 ms (504 thay vì 201); test riêng và toàn bộ lượt chạy lại sau khi dừng stack đều đạt. Không tăng timeout hoặc bỏ assertion để né lỗi.
- notification-service **2/2 đạt**, frontend production build đạt.
- Full Docker e2e trên code runtime cuối: **15 đạt, 1 TC47 chaos bỏ qua**, gồm TC52 broker, TC53 crash và PostgreSQL nhiều client. Sau đó bổ sung scaffold PD-03 chỉ-skip và kiểm tra riêng: **1 bỏ qua đúng lý do PD-03 chưa có**. Khi chạy e2e đầy đủ có scaffold, còn thêm test skip này; không gọi TC52 HTTP là đã đạt.
- TC52 broker: một reservation/inbox/RESERVED event, 10 phản hồi cùng kết quả. TC53: exit 86 sau commit, restart cùng container, hai row phản hồi outbox được gửi, một reservation/RESERVED event; parking-a đã được khôi phục. Shutdown thông thường exit 0.
- PostgreSQL thật kiểm 10 transaction đồng thời, 10 ID tranh cùng slot (1 thành công/9 conflict), reuse key 422, exclusion conflict và rollback khi lỗi outbox. Lần đầu test so JSON bằng chuỗi bị ảnh hưởng thứ tự khóa JSONB; đã sửa sang so giá trị JSON và chạy lại đạt.

Log ở `tai-lieu/pd-02-evidence.txt`. Stack `pd02-inbox` dùng port 5673/15673, không đụng broker sẵn có ở cổng mặc định; test khôi phục dịch vụ, dọn đúng bản ghi thử và dừng stack, giữ toàn bộ volume. E2e local tái sử dụng socket.io-client đã cài với cùng lockfile ở worktree PD-01 trong lúc npm ci hoàn tất; sau đó mọi dependency của worktree PD-02 đã cài đủ. CI e2e cài dependency trực tiếp tại workspace.


## Bổ sung PD-02 ngày 01/11/2026

PR #48 và commit `238b77692f64b502b4ac5761c9b464dee3c91f5d` đã merge. Lượt này tiếp tục đúng nhánh hiện hữu `hung-pd-02-command-inbox`, fast-forward lên `origin/dev` tại `eef361f1a1542ad6c620fa217116b7f54016048f`; không amend, không force-push, không lấy thay đổi chưa commit ở checkout khác. Ref `hung` vẫn tồn tại nên giữ tên nhánh đã có, không tạo nhánh trùng hoặc thêm tiền tố codex/.

Issue #19 không có bình luận thiết kế. Người dùng đã chỉ thị trong chat **“tự làm hết không cần xin”**, cho phép tiếp tục không chờ duyệt. Đây là miễn điều kiện chờ của người dùng; không gọi là thiết kế đã được Huynh duyệt và không tự đăng bình luận Issue.

Phạm vi bổ sung chỉ gồm hai nhận xét PD-02 trong review #48 và `nhan-xet-thanh-vien-gd2.md`: một reply không route không chặn đích khác; queue bãi chưa có dùng backoff tăng dần. Giữ nguyên transaction inbox/nghiệp vụ/outbox, schema `command_type`, messageId/fingerprint, prefetch 20, ack sau COMMIT, consumer tuần tự, HTTP wrapper và các hook PD-08/10/17. Không triển khai request–reply HTTP hoặc retry thực thi lệnh.

Migration cộng thêm vào `command_reply_outbox`:

```sql
ALTER TABLE command_reply_outbox ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE command_reply_outbox ADD COLUMN IF NOT EXISTS last_error TEXT;
```

Không đổi/xóa inbox hoặc payload cũ. Schema init chạy lặp được; test mô phỏng outbox phiên bản cũ chứa tin trước khi nâng cấp. Publisher trả riêng trạng thái UNROUTABLE khi basic.return có replyCode 312; confirm callback đến sau không ghi đè trạng thái. Các lỗi khác giữ pending. Hoàn tác app giữ hai cột mới và dữ liệu; bản cũ sẽ không xét lịch hoãn nên có thể gặp lại tình trạng chặn đầu hàng. Không xóa volume.

Test tập trung: `node --test parking-node/test/commands.test.js`. Test broker bổ sung được đăng ký trong `tests/command-inbox.e2e.mjs`, chạy cùng `node --test --test-name-pattern='PD-02' tests/e2e.test.mjs`: gửi phản hồi tới route thiếu, xác nhận row còn nguyên/chưa published và có lịch hoãn, kiểm đích khác nhận ngay, thêm binding rồi xác nhận row cũ được gửi và xóa trạng thái lỗi. TC52/TC53 và PostgreSQL concurrent test tiếp tục kiểm invariants cũ. HTTP TC52 vẫn chỉ là scaffold bỏ qua đến PD-03.

Kết quả mới, lệnh chạy và giới hạn thực tế nằm trong `pd-02-review-evidence-2026-11-01.txt`; số liệu ở phần 22/10 bên trên là bằng chứng lịch sử.
