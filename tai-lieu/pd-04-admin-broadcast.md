# PD-04 – Phát lệnh nhiều bãi và giao diện quản trị

Issue #21, kế hoạch 1.4 mục 5.7–5.8; hợp đồng admin queue PD-06 (Issue #23).
Người dùng chỉ thị thực hiện trọn vẹn, không chờ Huynh duyệt. Không tự đăng Issue
comment hoặc merge PR. Tiếp tục nhánh/PR #53 hiện hữu, không tạo trùng.

## Dependency và base

Base dev `4155051814f4df61e4df75dcb27f7b1e32553c5b` ngày 02/11/2026 đã có PD-03 #68,
PD-06 #72, PD-12 #67 và PD-09. Không còn dùng code/patch/candidate cũ của PD-03 #52.
Nhận dev bằng merge giữ lịch sử đã push, không force-push; diff so với dev chỉ PD-04.
Ref hung có sẵn nên giữ tên nhánh `hung-pd-04-admin-broadcast`. Base PR là dev;
không cần stacked PR hoặc đổi base sau dependency.

Đã bỏ admin-integration.js, pd04-pd02-integration.patch và prepare-pd04-candidate.mjs.
Một inbox processor hiện có nhận decoder/dispatch admin trực tiếp, giữ epoch/fencing
và saga của dev; không viết inbox khác hoặc mở transaction nghiệp vụ thứ hai.

## Topology thống nhất PD-06

- Vhost `/`, parking.commands topic durable; queue cmd.A.admin … cmd.F.admin
  durable quorum, SAC, immutable args giống PD-06.
- Chỉ queue quản trị nhận `cmd.zone-bac.#` (A/B/C), `cmd.zone-nam.#` (D/E/F)
  và `cmd.all.#`. Không thêm broadcast binding vào cmd.<bãi> thường.
- Một publish `cmd.zone-nam.setPricing` có ba bản broker giao tới D/E/F.admin,
  không publish lần lượt từng bãi. Giữ unicast admin bindings PD-06 hiện có.
- Policy admin-command-delivery priority **20** cao hơn command-delivery priority 10,
  gồm TTL 600000, max-length 10000, reject-publish, delivery-limit 5, DLX parking.dlx,
  key expired, dead-letter-strategy at-least-once. Không để hai policy cùng ưu tiên
  khiến broker chọn ngẫu nhiên policy thiếu TTL admin.
- Caller broadcast đặt expiration 600000 và deadline đã lưu; publisher dùng phần
  thời gian còn lại. Fallback cho broadcast có targets cũng là 600000, không bị
  commandTtlMs của người dùng (10000) ghi đè. Republish giữ deadline, không gia hạn.
- Dùng đúng consumer PD-06: hai channel prefetch user 16/admin 4, một lifecycle và
  handler chain; không tạo thêm consumer admin, không dựa SAC để coi async tuần tự.
- Reply dùng parking.replies direct durable, routing key agg.broadcast, queue chung
  agg.broadcast.replies durable quorum không TTL. Không dùng queue riêng PD-03
  để consumer command thông thường nhận rồi bỏ broadcast reply.

## Mục tiêu và vùng

Lấy danh sách từ registry PD-09/PD-12, ưu tiên node.zone do etcd đăng ký. Bao gồm
bãi OFFLINE/DEGRADED đã biết; không loại F chỉ vì F đang dừng. PARKING_ZONES là map
fallback khi registry chưa có zone, chỉ là cấu hình tĩnh tạm (mặc định A/B/C=bac).
Khi dùng scale/coord, D/E/F đăng ký nam qua etcd; không dựng lại môi trường PD-12.

Snapshot targets được lưu trước publish và được ký trong envelope. Cùng key retry
không chụp lại targets; reply từ bãi ngoài snapshot bị bỏ. Runtime chuẩn bị bindings
cho bãi đã đăng ký trước publish; node chỉ thực thi khi nằm trong snapshot. Đổi vùng
đang có lưu lượng cần đối chiếu binding cũ; đây không phải triển khai toàn bộ cấu hình
vùng động. Không tự xóa queue/binding không thuộc PD-04 hoặc dữ liệu cũ.

## API và định danh

JWT ADMIN mới gọi được:

```text
GET  /api/admin/broadcast/zones
POST /api/admin/broadcast
GET  /api/admin/broadcast/:id
```

POST đúng `{zone,type,body}`. zone là tên vùng hoặc all. Vùng không có bãi trả 404;
sai type/payload trả 400; chưa đăng nhập 401, sai role 403. Idempotency-Key 1–64
ký tự chữ/số/_/-, không có thì UUID. broadcastId = messageId = correlationId =
`<adminId>:broadcast-<key>`. Cùng key/nội dung trả snapshot/kết quả cũ, khác nội dung
trả 422. Actor từ JWT server, không từ client. HMAC và trace metadata được giữ.

Payloads:

- setPricing: `{rules:[{vehicleType:"CAR",firstBlockMin:120,firstBlockFee:25000,
  nextHourFee:10000,overnightFee:30000,maxDayFee:150000}]}`; CAR/MOTO không trùng.
- lockFloor: `{floor:1,locked:true}`; false để mở. Tầng không có 404, còn xe/lượt
  PENDING_SAGA/ACTIVE/USED trả 409, không đổi một phần. Chỉ mở slot do broadcast khóa,
  giữ bảo trì thủ công. Event/version slot dùng đường outbox hiện có.
- banPlates: `{plates:["30A-123.45"],banned:true}`; chuẩn hóa, tối đa 100 biển,
  không trùng; false bỏ cấm. Guard chặn đặt/vào bãi (cả QR), cho xe ra/thanh toán.

POST gom reply tối đa 5 giây, trả HTTP 200 cùng broadcastId, targets, total,
applied, rejected (lỗi nghiệp vụ từng bãi), missing, publishState, deadlineAt,
expired và receivedAt từng kết quả. REJECTED do mandatory NO_ROUTE lần đầu trả 404.
`applied` chỉ sau reply hợp lệ, `missing` không đồng nghĩa thất bại. Nack fanout
có thể đã nhận ở một số queue nên UNKNOWN, không khẳng định toàn bộ bị từ chối.

GET đọc DB chung; late reply cập nhật độc lập theo parkingId. Projection không trả
payload gốc, chữ ký, secret hay biển số. Không ghi đè kết quả bãi khác cùng correlation.

## Transaction, persistence và hết hạn

admin_broadcasts giữ intent/hash/envelope/targets/deadline/publish lease;
admin_broadcast_results có PK(broadcast_id,parking_id), reply_hash và status/result.
DB update trước ack. Kết quả terminal đầu tiên từng bãi thắng; duplicate đồng nhất
được chấp nhận, xung đột không ghi đè. Crash sau claim/publish giữ cùng ID/deadline
khi phục hồi; inbox mỗi bãi chặn hiệu lực trùng.

Node dùng transaction inbox + nghiệp vụ + result + reply outbox hiện có; COMMIT rồi
ack. admin_command_gate exclusive cho mutation admin, SHARE cho user, thứ tự gate
trước slot. Giữ CAS/version/constraints. admin_floor_locks/admin_locked_slots và
banned_plates lưu DB. Savepoint rollback toàn bộ mutation khi clock_timestamp quá
hạn sau chờ lock hoặc cuối dispatch; lưu kết quả 410 an toàn. Kiểm đầu handler của
PD-06 cũng giữ, không gọi dispatch cho lệnh đã hết deadline.

Không triển khai saga/fencing/config động thay người khác. Có khoảng rất nhỏ giữa
kiểm cuối và COMMIT, cùng giới hạn clock skew hiện có; không hứa deadline tuyệt đối
tại COMMIT. PD-06 quản lý cmd.expired; PD-04 không cạnh tranh consumer queue đó.
GET hiển thị hết hạn + missing nếu chưa có reply, không suy thành applied.

## Giao diện

Trang Quản trị có chọn vùng/type, dữ liệu JSON được kiểm tra và bảng kết quả từng bãi;
hiện “2/3 bãi đã áp dụng, bãi F chưa phản hồi”. Poll GET mỗi 2 giây khi còn chờ,
có nút kiểm tra thủ công cho reply muộn. Không phát command mới chỉ vì qua 5 giây.
Session storage giữ digest/key/ID TRƯỚC POST và sau reload, không lưu payload/biển số.
Thao tác cùng nội dung dùng lại key; nút Soạn lệnh mới tạo intent mới khi đã hoàn tất
hoặc hết hạn. Không tự retry bằng ID mới khi publisher chưa rõ kết quả.

## Chạy và kiểm tra

```powershell
npm ci --prefix parking-node
npm ci --prefix aggregator-service
npm ci --prefix frontend
npm ci --prefix notification-service
npm test --prefix parking-node
npm test --prefix aggregator-service
npm test --prefix frontend
npm run build --prefix frontend
# Chỉ tạo .env từ .env.example lần đầu; không ghi đè file đang dùng.
$env:COMPOSE_PROJECT_NAME='pd04-review-1102'
$env:COMPOSE_FILE='docker-compose.yml;docker-compose.scale.yml;tests/pd04-compose.test.yml'
$env:COMPOSE_PROFILES='scale,coord'
$env:ADMIN_BROADCAST_ENABLED='true'
docker compose build parking-a aggregator frontend notification
docker compose up -d --no-build --wait rabbitmq etcd-1 etcd-2 etcd-3 parking-a parking-b parking-c parking-d parking-e parking-f toxiproxy aggregator frontend notification
$env:RUN_PD04_BROKER='1'
$env:PD04_AMQP_URL='amqp://parking:parking@localhost:5673/%2F'
node --test tests/pd04-broadcast.test.mjs
$env:RABBITMQ_MANAGEMENT_URL='http://localhost:15673'
node scripts/check-command-topology.mjs
# Hồi quy HTTP A/B/C dùng default stack riêng theo README, COMMAND_MODE=http.
docker compose stop # giữ tất cả volume
```

Fixture dùng dịch vụ PD-12/PD-09 thật, bỏ dependency sync replica chỉ trong test để
không kiểm thay replication; không sửa production generator. Broker 5673/15673,
etcd-1 host 12379 tránh cổng mặc định; API 8000 và bãi 8001–8006. Không đụng broker
sẵn có. Linux dùng dấu `:` trong COMPOSE_FILE. CI admin-broadcast chạy TC61 thật,
không skip hoặc ghép source ngoài repo.

TC61: một publish D/E/F, duplicate HTTP/broker, F dừng >10 s rồi bật trước 10 phút,
late reply/đúng một inbox effect; expiry khi offline và node guard; quyền/payload/
vùng không có; Management không double routing/QoS 16/4; lock/ban/price còn sau restart.
Bằng chứng mới: [pd-04-review-2026-11-02.txt](pd-04-review-2026-11-02.txt). Các kết quả
candidate A/B/C ngày 23/10 là lịch sử, không thay cho TC61 mới.

Ngày 02/11: TC61 D/E/F **7/7 đạt, không skip**; [log broker](pd-04-broker-2026-11-02.log).
Hồi quy HTTP đầy đủ **16 đạt, 22 skip theo mode/profile, 0 lỗi**;
[log HTTP](pd-04-http-2026-11-02.log). Node 90 đạt/1 skip, Aggregator 87 đạt/3 skip,
notification 2 đạt, frontend 5 đạt và build đạt. HTTP dùng project riêng
`pd04-http-1102`, COMPOSE_FILE `docker-compose.yml;tests/pd04-compose.test.yml`,
COMPOSE_PROFILES rỗng, COMMAND_MODE=http và
PD02_AMQP_URL=`amqp://parking:parking@localhost:5673/%2F`; bật cùng các dịch vụ A/B/C
như trên, bỏ etcd/toxiproxy/D/E/F. Không coi các test broker/HA bị skip là đã đạt.

## Nâng cấp và hoàn tác

Schema additive bằng init hiện có, không drop dữ liệu. Definitions import không
xóa topology cũ; policy admin priority 20 sửa được trên queue đang có tin. Queue cũ
khác type/SAC phải kiểm kê ready/unacked, sao lưu/chuyển có confirm trước cutover;
không xóa để né PRECONDITION_FAILED, không down -v/purge. Hủy tính năng bằng cờ
ADMIN_BROADCAST_ENABLED=false cho yêu cầu mới, giữ DB/queues và consumer xả backlog
có kiểm soát. Guard cho floor/ban đã lưu vẫn giữ; tắt UI không đảo ngược nghiệp vụ.
