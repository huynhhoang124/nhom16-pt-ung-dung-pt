# PD-04: phát lệnh quản trị A–C trên stack dev

Thay thế PR #53 theo việc số 3 trong phân công từ 01/11/2026; liên kết Issue #21. Chỉ chốt phạm vi A–C của Hùng. Huynh tiếp nhận nối PD-03 và TC61 sáu bãi. Không lấy thiếu D/E/F làm điều kiện chặn A–C.

## Nguồn và nhận xét đã xử lý

Nhánh bắt đầu từ `origin/dev` 4155051814f4df61e4df75dcb27f7b1e32553c5b. Tái sử dụng có chọn lọc các module broadcast/admin/UI/test của `hung-pd-04-admin-broadcast` tại c7a14b2bacae009567b730683358b87d5f8bed86 (PR #53, tác giả Vũ Văn Hùng); không merge nhánh candidate/PD-03. Commit prerequisite 3062c42 tái sử dụng nguyên tác giả bản sửa PD-02 d889cb7 của PR #79: phản hồi lỗi không chặn hàng sau, có retry metadata; reconnect 5/10/20/40/60 giây, reset sau setup thành công và hủy khi shutdown. PR #79 chưa merge tại thời điểm tạo nhánh, nên commit sửa lỗi được giữ riêng trước commit PD-04 để review riêng. Không amend/force-push.

Nhận xét về lớp patch/candidate trong `nhan-xet-thanh-vien-gd2.md` thuộc triển khai cũ. Cây dev không chứa `prepare-pd04-candidate.mjs`, `admin-integration.js` hoặc patch PD-04; lần triển khai này cũng không thêm chúng. Entry point chuẩn trực tiếp gọi admin handler trên transaction inbox/outbox PD-02, giữ fencing/epoch, reply enrichment và fix #79. Không đọc source ngoài repo, không dùng PD02_SOURCE_ROOT.

Tên yêu cầu `hung/pd04-broadcast-abc-dev` không tạo được vì remote/local đã có ref nhánh `hung`; Git cấm ref `hung` và `hung/...` cùng tồn tại. Dùng `hung-pd04-broadcast-abc-dev`, không đổi/xóa nhánh của người khác.

## Hợp đồng và dữ liệu

- Giữ vhost `/`, URI `/%2F`, definitions/permissions/connector nhất quán. `COMMAND_MODE=http` giữ đường HTTP cũ; broadcast dùng broker riêng, không thay luồng PD-03.
- `parking.commands` topic: một publish `cmd.zone-bac.<type>` hoặc `cmd.all.<type>`, mandatory/persistent/confirm. Chỉ bind vào `cmd.A.admin`, `cmd.B.admin`, `cmd.C.admin`; không bind vào queue thường. Không bật broadcast D–F. SAC quorum theo PD-06, prefetch thường/admin 16/4 trên các channel có sẵn, không tạo consumer cạnh tranh.
- Policy admin ưu tiên 20, mẫu `^cmd\.[ABC]\.admin$`, `message-ttl=600000`; TTL thường 10 giây không ghi đè. Envelope có issuedAt/deadlineAt cách nhau 10 phút. Publisher cắt expiration theo thời gian còn lại, phục hồi publish giữ nguyên ID/deadline, không kéo dài hạn. Node kiểm lại sau lock và trước kết thúc mutation, savepoint rollback nếu quá hạn. Không thay cơ chế TTL/back-pressure của PD-06.
- Danh sách mục tiêu được chụp từ registry hiện có, giữ cả bãi OFFLINE, giới hạn mặc định A–C. Zone lấy từ registry/etcd khi có; `PARKING_ZONES={"A":"bac","B":"bac","C":"bac"}` là fallback tĩnh. Đây không phải cơ chế membership/zone động hoàn chỉnh: khi đổi vùng cần kiểm tra/gỡ đúng binding cũ, không tự di chuyển dữ liệu.
- `admin_broadcasts` lưu intent, hash thao tác, snapshot và lease trước publish; `admin_broadcast_results` khóa `(broadcast_id,parking_id)`. ID là `<adminUserId>:broadcast-<Idempotency-Key>`, correlationId chung bằng ID; cùng key/cùng nội dung trả lại cùng thao tác, đổi nội dung trả 422. Trường `targets` được đưa vào chữ ký HMAC và envelope.
- `CONFIRMED` chỉ là broker nhận publish, không phải tất cả bãi áp dụng. NO_ROUTE chắc chắn trước đó chưa có publish bất định -> REJECTED/404; nack/disconnect/không rõ kết quả -> UNKNOWN, phục hồi cùng ID/deadline. HTTP chờ tối đa 5 giây rồi trả snapshot thực tế. Không báo thành công cho bãi thiếu phản hồi.
- Reply ký HMAC có parkingId. `agg.broadcast.replies` durable/quorum bind key `agg.broadcast` trên direct `parking.replies`, tách queue PD-03; lưu DB chung trước ack. Reply trùng theo bãi không nhân bản; terminal đầu tiên không bị reply mâu thuẫn ghi đè, reply muộn cập nhật bãi còn thiếu. Dữ liệu payload/biển số và lỗi thô không được trả qua API kết quả.
- Node dùng cùng transaction client: inbox + nghiệp vụ + outbox phản hồi, COMMIT rồi consumer mới ack. Giao lại chỉ lấy kết quả đã lưu. Giữ giới hạn dedup inbox 7 ngày của PD-02. Migration additive `CREATE TABLE/INDEX IF NOT EXISTS`, không xóa dữ liệu.
- `setPricing`: validate và cập nhật pricing_rules; `lockFloor`: lưu admin_floor_locks, theo dõi admin_locked_slots, CAS/version và event outbox, từ chối tầng đang được dùng/đặt chỗ; mở khóa không xóa trạng thái bảo trì thủ công. `banPlates`: normalize và lưu banned_plates; reserve/enter kiểm tra DB. Không giả lập thành công trong RAM, không bổ sung saga/fencing/config động ngoài hợp đồng hiện có.

## API và giao diện

Tất cả endpoint yêu cầu ADMIN:

- `GET /api/admin/broadcast/zones` trả các vùng của A–C.
- `POST /api/admin/broadcast`, header `Idempotency-Key`, body `{zone,type,body}`. `zone` là `all` hoặc `bac` theo cấu hình. Trả 200 với `{broadcastId,targets,applied,rejected,missing,publishState,deadlineAt,...}` kể cả kết quả một phần; payload sai 400, vùng không có mục tiêu 404, key đổi nội dung 422, chưa sẵn sàng 503.
- `GET /api/admin/broadcast/:id` đọc trạng thái bền vững, gồm phản hồi muộn.

Ví dụ body:

```json
{"zone":"bac","type":"lockFloor","body":{"floor":1,"locked":true}}
```

```json
{"zone":"all","type":"banPlates","body":{"plates":["55A94003"],"banned":true}}
```

```json
{"zone":"bac","type":"setPricing","body":{"rules":[{"vehicleType":"CAR","firstBlockMin":120,"firstBlockFee":25000,"nextHourFee":10000,"overnightFee":30000,"maxDayFee":150000}]}}
```

Đăng nhập admin -> Quản trị -> phạm vi Ba bãi A–C hoặc Vùng Bắc -> loại lệnh -> Payload JSON -> Gửi lệnh. Bảng hiện từng bãi đã áp dụng, từ chối hoặc chưa phản hồi. Poll 2 giây khi còn thiếu; tải lại trang phục hồi ID từ sessionStorage, không phát lệnh mới. Cùng nội dung giữ key khi thử lại; nút Soạn lệnh mới tạo thao tác mới sau hoàn tất/hết hạn. Không lưu payload/biển số vào sessionStorage.

## Chạy trực tiếp và kiểm tra an toàn

Stack thường: sao `.env.example` thành `.env`, đặt khóa riêng rồi `node scripts/gen-keys.mjs`; `docker compose up -d --build`. `ADMIN_BROADCAST_ENABLED=true`, `PARKING_ZONES` như trên, không cần source/patch. Không commit .env. Trên stack có dữ liệu, backup trước khi nâng cấp; definitions chỉ thêm topology, import không tự gỡ binding dư cũ. Kiểm tra Management `/api/bindings/%2F` để chắc `cmd.zone-bac.#` và `cmd.all.#` chỉ có một đường tới queue admin mỗi bãi; nếu binding cũ sai, chuẩn bị gỡ đúng binding sau khi kiểm kê, không xóa queue/volume để né PRECONDITION_FAILED.

Docker sạch đã kiểm thử bằng project riêng `pd04-abc-20261103` (ban đầu không có container/volume mang nhãn project), năm volume riêng, không dùng lại volume stack đang chạy. PowerShell:

```powershell
$env:COMPOSE_PROJECT_NAME='pd04-abc-20261103'
$env:COMPOSE_FILE="$PWD/docker-compose.yml;$PWD/tests/pd04-abc.compose.yml"
$env:COMPOSE_PROFILES=''
docker compose build parking-a aggregator frontend notification
docker compose up -d --wait rabbitmq db-a db-b db-c db-agg parking-a parking-b parking-c aggregator frontend notification
$env:RUN_PD04_BROKER='1'
node --test tests/pd04-abc.e2e.mjs
$env:COMMAND_MODE='http'
$env:AGGREGATOR_URL='http://localhost:18020'
$env:PARKING_BASE_PORT='18201'
$env:FRONTEND_URL='http://localhost:13020'
$env:PD02_AMQP_URL='amqp://parking:parking@localhost:5684/%2F'
node --test tests/e2e.test.mjs
```

Linux dùng `COMPOSE_FILE=docker-compose.yml:tests/pd04-abc.compose.yml`. Overlay chỉ tách cổng/image, dùng nguyên entry point dev: UI 13020, Aggregator 18020, node 18201–18203, broker 5684/15684, DB 25451–25454. Test backend có thể stop/restart node A/C, luôn start lại trong finally và khôi phục đúng fixture của nó; không purge broker hay xóa volume.

Unit (trong từng service parking-node, aggregator-service): `node --test --test-concurrency=2 test/*.test.js`. Frontend: `npm test` và `npm run build`; notification: `npm test`. CI `pd04-abc` tạo stack riêng và chạy hồi quy HTTP + test broadcast. CI không thay bằng chứng thao tác UI thủ công.

Dọn chỉ project test sau khi kiểm tra nhãn `com.docker.compose.project=pd04-abc-20261103` và tên từng volume bắt đầu đúng `pd04-abc-20261103_`; sau đó mới `docker compose down -v` với đúng hai biến Compose trên. Không chạy down -v trên stack dùng chung. Việc nâng cấp bình thường **không cần down -v**.

## Bằng chứng thực tế ngày 03/11/2026

Tất cả ảnh dưới đây được chụp trình duyệt trang `http://localhost:13020/`, không dựng ảnh minh họa. Dữ liệu là fixture trong project test riêng. Trước tạo fixture đã kiểm tra tầng 97/slot PD04GUI97/biển số 55A94003 chưa tồn tại, giá CAR ban đầu 25000 tại cả A/B/C.

| Thao tác UI | Kết quả thực tế |
|---|---|
| setPricing, giá CAR 37004 | 3/3, cả ba DB và GET node `/api/pricing` trả 37004 |
| lockFloor tầng 97 | 3/3; PD04GUI97 MAINTENANCE, version 1 ở cả ba DB/API slots |
| banPlates 55A94003 | 3/3; bảng banned_plates có biển số tại ba DB |
| restart cả A/B/C | Giá 37004, slot MAINTENANCE/version1, biển số cấm còn nguyên; inbox mỗi loại 200 |
| dừng C, UI gửi bỏ cấm | 2/3, C chưa phản hồi; cùng broadcastId sau bật C tự lên 3/3; cả ba DB không còn biển số cấm |
| lockFloor tầng không tồn tại 96 | 0/3, từng bãi Từ chối: FLOOR_NOT_FOUND; publish CONFIRMED không bị hiểu là nghiệp vụ thành công |

ID UI (admin user fixture 4fb5f6d8-e74e-4d18-9a6c-c0f32a2cfbe5): setPricing suffix 3f46b7d2-50c5-4ad6-8b89-41e971671e63; lockFloor bac186e6-516c-4968-9a3f-9a91b3bbccb2; banPlates 974dc382-fec4-4a24-977d-80a4a501e1cb; bỏ cấm df1f3dcb-eec9-43b0-99b1-2d2ab2a2ec41. Các ảnh chứa nguyên ID để đối chiếu. Sau kiểm tra đã trả giá 25000, xóa đúng fixture tầng/slot 97 và xác nhận không còn biển số cấm.

![Trước gửi](anh/pd04-abc-20261103/pd04-abc-before.jpg)
![setPricing 3/3](anh/pd04-abc-20261103/pd04-abc-pricing.jpg)
![lockFloor 3/3](anh/pd04-abc-20261103/pd04-abc-lock.jpg)
![banPlates 3/3](anh/pd04-abc-20261103/pd04-abc-ban.jpg)
![C chưa phản hồi 2/3](anh/pd04-abc-20261103/pd04-abc-partial.jpg)
![C phản hồi muộn cùng ID 3/3](anh/pd04-abc-20261103/pd04-abc-late.jpg)
![Từ chối nghiệp vụ từng bãi](anh/pd04-abc-20261103/pd04-abc-rejected.jpg)

| Kiểm tra đã chạy | Kết quả quan sát |
|---|---|
| parking-node unit, concurrency=2 | 97 đạt, 0 lỗi, 1 skip PostgreSQL opt-in (phần PostgreSQL thật chạy trong e2e) |
| aggregator-service unit, concurrency=2 | 85 đạt, 0 lỗi, 3 skip broker opt-in |
| Focused broadcast + publisher, sau bổ sung test envelope/TTL A–C | 13/13 đạt |
| notification unit | 2/2 đạt |
| frontend unit / production build | 5/5 đạt; Vite build đạt |
| tests/pd04-abc.e2e.mjs trên project Docker mới, chưa có volume | 7/7 đạt, 0 skip, 109.7 giây |
| tests/e2e.test.mjs, COMMAND_MODE=http | 17 đạt, 0 lỗi, 21 skip đúng opt-in/profile, 136.9 giây |

Broker e2e chứng minh 10 request cùng key chỉ một publish, ba inbox mỗi bãi một hiệu lực; duplicate lock không tăng version; reply theo bãi không ghi đè; C bật lại sau 19.163 giây áp dụng một lần; dữ liệu giá/khóa/cấm tồn tại sau restart. Test deadline dùng envelope đã trôi gần hết 10 phút và còn 250 ms để kiểm chứng broker hết hạn khi C offline, cùng trường hợp handler gặp deadline đã quá; không giả là đã đợi đủ 10 phút thực tế.

Hồi quy gồm TC56 mandatory return, TC52/TC53 PD-02 cấp broker, PostgreSQL duplicate thật, stop/start DB/node/broker/Aggregator. Các skip HTTP request–reply PD-03, scale/coord/HA/shard và TTL/back-pressure opt-in không được tính là đạt. Không tuyên bố TC61 sáu bãi/PD-03 đạt trong phạm vi này.

Cuối lượt chạy đã xác nhận các service test đều chạy lại, rồi kiểm tra nhãn/tên 11 container và 5 volume đúng project trước `down -v`. Không còn tài nguyên mang nhãn project test. Các container có sẵn `rabbitmq` (5672/15672), `airflow`, `superset-bi` vẫn chạy; không xóa dữ liệu hoặc volume của chúng. Thay đổi cục bộ trong checkout gốc được giữ nguyên.
