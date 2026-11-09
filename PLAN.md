# PLAN – Huynh làm mọi việc có phụ thuộc, để thành viên code độc lập

Ngày lập: 01/11/2026 · Nhánh gốc: `dev` (`42f0456`) · Người làm: Huynh (Claude code giúp)

Thành viên làm các việc độc lập trong `tai-lieu/chia-viec-thanh-vien-tu-01-11.md`. Huynh làm mọi việc còn lại, gồm hai loại:
- Việc người khác đang chờ.
- Việc phải chờ việc khác xong mới làm được.

## Thứ tự

| Đợt | Việc | Cần xong trước |
|---|---|---|
| 1 | B1 PD-12 · B2 PD-03 | — |
| 2 | B3 PD-14a · B4 PD-16 · B5 PD-07 · B6 PD-06 · B7 PD-19 | B3: B1 · B4–B6: B2 · B7: B1 |
| 3 | B8 PD-14b · B9 PD-21 · B10 PD-25 | B8: B3 · B9: B4 · B10: B2, B6 |
| 4 | B11 nối PD-08, PD-04 vào PD-03, TC61 · B12 PD-15 ra 6 bãi · B13 PD-24 trace lệnh · B14 PD-26 nemesis failover | việc độc lập tương ứng của Hùng, Loan, Hiệp đã merge |
| 5 | B15 PD-27 đo trước/sau · B16 kết thúc | tất cả |

Ở đợt 4, Huynh chờ thành viên chứ không có thành viên nào phải chờ Huynh. Nếu thành viên chưa xong, Huynh làm việc khác trong đợt 2–3 trước.

## Quy tắc chung

- Mỗi bước một nhánh `huynh/PD-xx` tạo từ `origin/dev` mới nhất, một PR vào `dev`. Merge khi CI xanh và e2e trên Docker đạt.
- Dùng code có sẵn bằng `git cherry-pick` để giữ tên tác giả. Phần sửa thêm nằm trong commit riêng. Mô tả PR ghi rõ phần nào của ai.
- Không sửa, không force-push nhánh của thành viên.
- Sửa đúng các lỗi đã ghi trong `tai-lieu/nhan-xet-thanh-vien-gd2.md` cho việc đó.
- Kiểm tra mỗi bước:
  - Unit: `node --test --test-concurrency=2 test/*.test.js` trong `parking-node` và `aggregator-service` (và service mới nếu có).
  - e2e trên Docker theo profile của việc đó.
  - e2e mặc định không đỏ.
- Docker trên máy Huynh: frontend cổng 3005, etcd-1 cổng 23790 trong `docker-compose.override.yml` (không commit). Docker Hub đang timeout từ trong Docker: image nào thiếu thì thử lại hoặc dùng bản có sẵn.
- Xong mỗi bước: đổi `- [ ]` thành `- [x]`. Bước có thiết kế khó (B2, B4, B8): viết nửa trang thiết kế vào issue trước khi code.

---

## Đợt 1

### B1 – PD-12 Mở rộng 6 bãi (issue #29)

Nền: `feature/PD-12-six-parking-rebased` (`0af30c8`, Hiệp), đã đạt e2e 21/21.

- [ ] `git checkout -b huynh/PD-12 origin/dev && git cherry-pick 0af30c8`. Xung đột thì giữ code PD-10, PD-13 trên `dev`, thêm phần 6 bãi.
- [ ] Ưu tiên vùng:
  - `aggregator-service/src/nodes.js`, `makeRegistry`: thêm tham số `zone` (từ `process.env.ZONE`, mặc định `bac`).
  - Trong `gather` (dòng ~177): sắp xếp `[...nodes.values()]` để bãi cùng `zone` đứng trước, rồi mới gọi.
  - Thêm `api.ordered()` trả danh sách đã sắp xếp, để route nào chọn một bãi bất kỳ cũng dùng được.
  - Truyền `zone` khi gọi `makeRegistry` ở `aggregator-service/src/index.js`; thêm `ZONE` vào `docker-compose.yml` và `docker-compose.scale.yml`.
- [ ] Bỏ cột `managed_by_etcd` (`aggregator-service/src/schema.sql:24`) và mọi chỗ dùng. Kiểm bằng `git grep managed_by_etcd`: không còn kết quả.
- [ ] `scripts/gen-lots.mjs`:
  - Đưa A–C vào `LOTS` cùng D–F, sinh 6 bãi từ một mẫu, bỏ khối viết tay (dòng ~60).
  - Cập nhật `scripts/gen-lots.test.mjs`.
  - Sinh lại `docker-compose.scale.yml`.
- [ ] README: dùng `up -d`, không dùng `--wait` (service `region-latency` chạy xong thì thoát).
- [ ] Unit test `aggregator-service/test/discovery.test.js` (hoặc `nodes-zone.test.js`): với `zone='nam'` thì thứ tự là D, E, F, A, B, C.
- [ ] Kiểm tra:
  - `node scripts/gen-lots.mjs`.
  - `docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile scale --profile coord up -d`.
  - `SCALE=1 COORD=1 node --test tests/e2e.test.mjs` đạt hết.
  - e2e mặc định 3 bãi đạt.
- [ ] PR vào `dev`, đóng #56, merge.

### B2 – PD-03 Request–reply (issue #20)

Nền: `hung-pd-03-request-reply` (`fd9d781`, Hùng), 36 file, xung đột 7 file với `dev`.

- [ ] Viết thiết kế nửa trang vào #20, lấy từ `tai-lieu/pd-03-design.md`.
- [ ] `git checkout -b huynh/PD-03 origin/dev && git cherry-pick fd9d781`. Khi giải xung đột:
  - `aggregator-service/src/commands.js`, `index.js`, `routes.js`: giữ PD-10 (leader, fencing, `nodes.call` có `job`), thêm request-reply.
  - `frontend/src/App.jsx`, `pages/History.jsx`, `pages/MyReservations.jsx`: giữ giao diện `dev`, thêm `CommandStatus` và xử lý 202.
- [ ] Áp `scripts/pd03-pd02-reply.patch` thẳng vào `parking-node/src/commands.js`, rồi xoá file patch. Kiểm bằng `git grep pd03-pd02`: không còn kết quả.
- [ ] Topology:
  - Exchange `parking.replies` (direct).
  - Queue `agg.replies.<INSTANCE_ID>`: quorum, TTL 60000, bind khoá `<INSTANCE_ID>`.
  - Khai báo ở `aggregator-service/src/commands.js` và `rabbitmq/definitions.json`.
- [ ] Bảng `commands` trong `aggregator-service/src/schema.sql`: `id TEXT PK, parking_id, type, user_id, status CHECK (PENDING|DONE|FAILED|EXPIRED), result JSONB, created_at, updated_at`.
- [ ] Đặt chỗ, huỷ, thanh toán (`routes.js`, `sessions-routes.js`) khi `COMMAND_MODE=broker`:
  - Ghi `PENDING`.
  - Gửi lệnh với `replyTo=INSTANCE_ID`, `correlationId=commandId`.
  - Chờ trong `Map pending` tối đa `REPLY_WAIT_MS=3000` → trả 201/409, hoặc 202 kèm `{ commandId }`.
- [ ] Consumer `agg.replies.<i>`:
  - `UPDATE commands`.
  - Trả kết quả cho request đang chờ.
  - `io.to('user:'+userId).emit('COMMAND_RESULT', …)`.
- [ ] `GET /api/commands/:id`: chỉ chủ lệnh hoặc ADMIN xem được.
- [ ] Viết lại `aggregator-service/src/command-flow.js`: dòng ≤ 120 ký tự, tách hàm, theo phong cách `commands.js`.
- [ ] `COMMAND_MODE` mặc định `http` ở `routes.js`, `index.js`, `docker-compose.yml`.
- [ ] Frontend: `api.js` xử lý 202; trang đặt chỗ hiện "Đang xử lý" và nghe `COMMAND_RESULT`.
- [ ] Gộp `tests/command-flow.e2e.mjs` vào bộ e2e với cờ `PD03_BROKER=1`, chạy trên stack thường.
- [ ] Xoá `tai-lieu/pd-03-*-e2e.log`, `pd-03-evidence.md`. Giữ `pd-03-request-reply.md` và ảnh.
- [ ] Kiểm tra:
  - Unit node, aggregator, `frontend/test/command-client.test.mjs` đạt.
  - Với `COMMAND_MODE=broker PD03_BROKER=1`: TC51 (201 trong ≤ 3 s, tin có `correlationId`), TC54 (tắt bãi 5 s → 202 → Socket.IO DONE), TC62 (dừng aggregator trước khi có phản hồi → `aggregator-2` trả DONE).
  - Với `COMMAND_MODE=http`: e2e cũ đạt.
- [ ] PR, đóng #52, merge.

---

## Đợt 2

### B3 – PD-14a Bản sao DB 6 bãi (issue #31) – sau B1

Nền: `feature/PD-14a-db-replication-clean` (`23d9fbc 23d5ee0 3d53169`, Loan).

- [ ] `git checkout -b huynh/PD-14a origin/dev && git cherry-pick 23d9fbc 23d5ee0 3d53169`.
- [ ] Đưa `db-x-replica` vào mẫu bãi của `scripts/gen-lots.mjs`:
  - A, D: đồng bộ, `synchronous_standby_names='ANY 1 (db_x_replica)'`.
  - B, C, E, F: bất đồng bộ.
  - Primary bật `wal_log_hints=on`.
  - Sinh lại `docker-compose.scale.yml`.
- [ ] Sửa lỗi chặn: chế độ đồng bộ lưu vĩnh viễn trong volume.
  - `docker-compose.yml` thêm `-c synchronous_standby_names=''` vào lệnh của `db-a` (và `db-d`).
  - `docker-compose.ha.yml` đè lại lệnh, không có tham số này.
- [ ] `docker-compose.ha.yml`:
  - `depends_on: { db-a-sync-config: { condition: service_completed_successfully, required: false } }`.
  - `db-d` thuộc cả profile `ha`.
- [ ] Bật metric `replication_lag_seconds` cho mọi bãi (đặt `READ_DATABASE_URL`).
- [ ] `tai-lieu/runbook-failover.md`:
  - Dùng `up -d`, không `--wait`.
  - Lệnh chạy script đo độ trễ trong container.
  - Kết quả chạy thật `scripts/rewind.mjs --execute` trên volume thử.
- [ ] Kiểm tra:
  - `config -q` đạt với: không profile, `ha`, `ha`+`extra`, `scale`.
  - Bật `ha` → `down` → `up` không `ha` → đặt chỗ ở A trả 201.
  - `pg_stat_replication`: A, D `quorum`/`sync`; các bãi khác `async`.
  - Độ trễ sao chép < 1 s cả 6 bãi.
  - e2e `HA=1` và `SCALE=1` đạt.
- [ ] PR, đóng #63, merge.

### B4 – PD-16 Phân mảnh `db-users` (issue #34) – sau B2

- [ ] Thiết kế nửa trang vào #34.
- [x] `aggregator-service/src/ring.js`:
  - Băm `sha1(username.toLowerCase())`, lấy 4 byte đầu thành số trên vòng 2³².
  - 128 nút ảo mỗi phân mảnh.
  - Hàm `shardFor`, `addShard`, `removeShard`.
- [x] Compose: `db-users-1`, `db-users-2`, mỗi cái có replica (cùng mẫu B3). Biến `USERS_DATABASE_URLS` là danh sách URL phân cách bằng dấu phẩy.
- [x] Aggregator: mỗi phân mảnh một `Pool`, thêm hàm `usersPool(username)`. Chuyển sang pool theo người dùng:
  - `users` (`auth.js`, kể cả `seedUsers`).
  - `commands` (B2).
  - `sagas` (`saga.js`).
  - Các bảng chung khác giữ ở `db-agg`.
- [x] `scripts/them-phan-manh.mjs`: ghi đôi → chép → đối chiếu số lượng và checksum → chuyển đọc → xoá bản cũ. Có `--dry-run`.
- [x] Kiểm tra:
  - TC72 (`aggregator-service/test/ring.test.js`): 10 000 username lệch ≤ 10%; thêm phân mảnh 3 thì 30–36% khoá phải chuyển.
  - TC73 (e2e): `stop db-users-1` → người ở phân mảnh 2 vẫn đăng nhập và đặt chỗ được.
  - e2e cũ đạt.
- [ ] PR, merge.

### B5 – PD-07 Saga qua broker (issue #24) – sau B2

- [ ] `aggregator-service/src/saga.js`: giữ bảng `sagas` và các hàm `run`, `compensate`, `recover`. `call()` gửi lệnh qua kênh lệnh của B2 và chờ phản hồi, thay cho HTTP.
- [ ] `UPDATE sagas … steps` trước khi gửi mỗi lệnh, `messageId=<sagaId>:<i>:<hành động>`.
- [ ] `parking-node/src/schema.sql`: thêm `PENDING_SAGA` vào `CHECK` của `reservations.status`.
  - Bước giữ chỗ tạo `PENDING_SAGA`.
  - Bước cuối gửi confirm → `ACTIVE`.
  - Lỗi thì gửi cancel cho các bước đã `DONE`.
  - Node xử lý thêm lệnh `confirm`.
- [ ] Chỉ leader chạy saga và `recover()`. Bản không phải leader ghi saga `PENDING` để leader nhận. Lệnh mang fencing token (giữ cách truyền token của `6f07129`).
- [ ] Kiểm tra:
  - TC75: saga 3 bãi thành công.
  - TC76: bước 3 lỗi → bù trừ 2 bước trước; tắt leader giữa lúc bù trừ → leader mới làm tiếp.
  - `frontend/src/GroupBooking.jsx` vẫn chạy.
  - Test PD-10 trong `routes.test.js` vẫn đạt.
- [ ] PR, merge.

### B6 – PD-06 TTL lệnh, back-pressure (issue #23) – sau B2

- [ ] `commands.send()`: `expiration` mặc định 10000 ms, đọc từ cấu hình động (`config.get('commandTtlMs')`).
- [ ] `rabbitmq/definitions.json`:
  - Các `cmd.<bãi>` có `x-dead-letter-routing-key: expired`.
  - Queue `cmd.expired` bind `parking.dlx`, khoá `expired`.
- [ ] Consumer `cmd.expired`, chỉ chạy ở leader:
  - Lý do `expired` → `commands.status='EXPIRED'`, báo người dùng qua Socket.IO.
  - Lý do `delivery_limit` → chuyển sang `cmd.dead`.
- [ ] Publisher nack (`reject-publish`) → lỗi `QUEUE_FULL` → route trả 503 kèm `Retry-After`.
- [ ] Hàng đợi `cmd.<bãi>.admin`. Node dùng 2 channel: prefetch 16 cho hàng thường, 4 cho hàng admin.
- [ ] Kiểm tra:
  - TC55: tắt bãi 20 s → lệnh `EXPIRED`, không đặt muộn.
  - TC59: `x-max-length` nhỏ → 503, không mất lệnh đã nhận.
- [ ] PR, merge.

### B7 – PD-19 Aggregator theo vùng (issue #37) – sau B1

Nền: `feature/PD-19-regional-aggregators` (`864a936`, Hiệp). Xem lại, chỉ cherry-pick phần dùng được.

- [ ] Compose: `aggregator-bac-1/2`, `aggregator-nam-1/2` có `ZONE`. `frontend/nginx.conf` chia tải.
- [ ] `/api/parkings/availability`, `/api/parkings/search`: gọi thẳng bãi cùng vùng (dùng `ordered()` của B1). Gửi 1 request sang Aggregator vùng kia với `scope=zone`. Vùng kia trả kết quả đã gộp kèm danh sách bãi lỗi.
- [ ] Metric `cross_zone_requests_total`.
- [ ] Kiểm tra: chặng liên vùng mỗi truy vấn giảm từ 3 xuống 1 (đo bằng metric); e2e `SCALE=1` đạt.
- [ ] PR, merge.

---

## Đợt 3

### B8 – PD-14b Failover tự động (issue #32) – sau B3

Nền: `feature/PD-14b-auto-failover-epoch` (Luận). Lấy `a613d05 c13fc62 5129966 088def2`. Không lấy `0293d31`, `84ee4c8` và các commit merge.

- [ ] Thiết kế nửa trang vào #32: thứ tự CAS → chờ → promote, cửa sổ an toàn.
- [x] `git checkout -b huynh/PD-14b origin/dev && git cherry-pick a613d05 c13fc62 5129966 088def2`. Khi xung đột:
  - Bỏ thay đổi PD-10 ở `leader.js`, `fencing.js`, `app.js`.
  - Giữ `failover-manager/`, `parking-node/src/dynamic-pool.js`, `epoch.test.js`.
- [x] `failover-manager` dùng module bầu leader trên `dev`, khoá `/nhom16/election/failover`.
- [x] Bỏ đường tắt `x-test-simulate-stale-epoch` ở `parking-node/src/app.js`.
- [x] Viết lại TC69 thật: bật lại primary cũ → chờ node sẵn sàng → ghi → `409 STALE_DB_EPOCH`, và chỉ 1 primary (`pg_is_in_recovery()`).
- [x] Bãi A, D: replica chết quá 3 s thì `ALTER SYSTEM RESET synchronous_standby_names` + `pg_reload_conf()` và ghi cảnh báo. Phải khớp với cách B3 đặt tham số.
- [x] Kiểm tra:
  - `COORD=1 HA=1`: TC68 (failover ≤ 15 s), TC69, TC70 (ghi treo ≤ 3 s), TC65, TC66 đạt cùng một lượt.
  - Đã đo `scripts/measure-failover.mjs` 05/11, ghi vào runbook: 10,05 s.
- [ ] PR, merge.

### B9 – PD-21 Giới hạn đăng nhập phân tán (issue #39) – sau B4

- [x] Bảng `login_buckets(username PK, tokens REAL, updated_at TIMESTAMPTZ)` ở phân mảnh users.
- [x] `aggregator-service/src/auth.js`: thay `makeLimiter()` (đếm trong RAM) bằng một câu `UPDATE … RETURNING` nguyên tử: nạp lại token theo thời gian, sai thì trừ 1. Giới hạn 5 lần sai trong 15 phút.
- [x] Kiểm tra: 4 bản Aggregator, 5 lần sai rải đều → lần thứ 6 bị khoá (e2e). Có unit test.
- [ ] PR, merge.

### B10 – PD-25 Metrics, cảnh báo, dashboard (issue #43) – sau B2, B6

- [x] Thêm metric vào `aggregator-service/src/metrics.js` và `parking-node/src/metrics.js`:
  - `command_duration_seconds`
  - `cmd_redelivered_total`
  - `cmd_dead_total`
  - `cmd_oldest_age_seconds`
  - `aggregator_is_leader`
  - `fencing_rejected_total`
  - [x] `hlc_drift_ms`: PD-17 đã merge; gauge độ lệch tuyệt đối giữa thành phần thời gian HLC nhận được và `Date.now()` của Aggregator, theo bãi. Bỏ HLC sai nhưng vẫn cập nhật slot; có unit test, chưa chạy. `aggregator_is_leader`, `fencing_rejected_total` đã có từ PD-10, giữ nguyên.
- [x] `observability/prometheus.yml`: thêm job cho `failover-manager`, `stats-service` (repo chưa có service này, bỏ qua), etcd, RabbitMQ `/metrics/detailed?family=queue_coarse_metrics`.
- [x] Alertmanager: service trong profile `obs`, file `observability/alertmanager.yml` và `observability/alerts.yml` theo ngưỡng mục 10.2.
- [x] 2 dashboard `observability/grafana/dashboards/` ("Kênh lệnh", "Điều phối"), theo mẫu `nhom16.json`.
- [ ] Kiểm tra: chạy k6 rồi chụp 2 dashboard; tắt một bãi hoặc làm đầy hàng đợi → cảnh báo bắn.
- [ ] PR, merge.

---

## Đợt 4 (sau khi thành viên merge việc độc lập)

### B11 – Nối PD-08, PD-04 vào PD-03; TC61 – sau PR PD-08, PD-04 của Hùng, B1, B2

- [x] Retry của PD-08 bọc consumer lệnh, có cả phản hồi request–reply: lỗi tạm thời thì thử lại theo độ trễ; quá giới hạn thì vào `cmd.dead` và `commands.status='FAILED'`.
- [x] PD-04 phát lệnh nhiều bãi dùng luồng `commands` của B2. Kết quả từng bãi lưu và hiện trên trang Quản trị.
- [x] TC61 chạy ở TC61, chạy trên 6 bãi.
- [x] Kiểm tra:
  - TC57, TC58 với `COMMAND_MODE=broker`.
  - TC61: tắt F → 2/3; bật F trong 10 phút → F áp dụng.
- [ ] PR, merge.

#### B11 chi tiết (04/11, nhánh `huynh/PD-B11`)

Nhánh này đã gộp #80, #81 và sửa lỗi tích hợp với PD-06. Chỉ sửa file, không chạy lệnh shell. Giữ thay đổi gọn, không đổi logic đã có của #80, #81 ngoài các mục dưới.

- [x] **Nối `markFailed`.** Trong `aggregator-service/src/index.js`, truyền `markFailed` vào `makeDlq`.
  - Đọc `aggregator-service/src/command-flow.js` trước, xác nhận `commands.id` khớp `messageId` của tin. Nếu không khớp, tra đúng cột.
  - Làm: `UPDATE commands SET status='FAILED', failure_phase, last_error, status_code, result, updated_at WHERE id=$1 AND status='PENDING'`. Dùng giá trị `failure_phase` có sẵn trong CHECK của `schema.sql`; không có thì thêm giá trị mới theo cách migrate đang dùng.
  - Kết quả lỗi phải tới người dùng giống các đường FAILED khác trong `command-flow.js` (dùng lại hàm có sẵn nếu có, ví dụ phát `COMMAND_RESULT`).
  - Lệnh đã DONE thì không đổi.
  - Unit test trong `aggregator-service/test/dlq.test.js` hoặc test của `command-flow`: PENDING thành FAILED; DONE giữ nguyên; lý do `UNVERIFIED` không gọi `markFailed`.
- [x] **PD-04 ra 6 bãi.**
  - `aggregator-service/src/broadcast.js`: mặc định `parkingIds` thành A–F.
  - `aggregator-service/src/index.js` và `docker-compose.yml`: `PARKING_ZONES` mặc định A, B, C là `bac`; D, E, F là `nam`. Bỏ dòng ghi chú "Assignment 01/11".
  - `aggregator-service/src/broadcast-runtime.js`: kiểm lại logic bind/unbind cho D, E, F (dòng 24–39, seed `bac` chỉ của A, B, C).
  - `rabbitmq/definitions.json`: policy `admin-command-delivery` đổi thành `^cmd\.[A-F]\.admin$`; thêm binding `cmd.zone-nam.#` và `cmd.all.#` cho `cmd.D.admin`, `cmd.E.admin`, `cmd.F.admin`, cùng dạng binding của A.
  - Tìm các chỗ còn cố định A–C: `git grep`-tương-đương cho `"A", "B", "C"` và `ABC` trong `aggregator-service/src`, `parking-node/src`, `frontend/src`. Sửa chỗ thuộc broadcast/admin; không đụng phần khác.
  - `README.md` dòng 105: đổi "A–C" thành "A–F".
  - Sửa unit test bị ảnh hưởng trong `aggregator-service/test/broadcast.test.js`.
- [x] **Trang Quản trị.** Đọc `frontend/src/pages/Broadcast.jsx`: phải hiện kết quả từng bãi (đã áp dụng, từ chối kèm lỗi, đang chờ). Thiếu phần nào thì thêm, theo style có sẵn.
- [x] **TC61, e2e mới `tests/tc61.pd04.e2e.mjs`.** Lấy mẫu `tests/pd04-abc.e2e.mjs`, chạy độc lập, có `skip: !process.env.SCALE` (cần stack `docker-compose.scale.yml` 6 bãi).
  - `docker compose stop parking-f`.
  - Admin phát lệnh vùng `nam`: chờ tới khi D, E áp dụng, F còn chờ (2/3).
  - `docker compose start parking-f`: chờ tới khi F áp dụng (3/3), không quá 10 phút TTL.
  - `finally` luôn bật lại `parking-f` và trả cấu hình về như cũ.
  - Xác nhận tên service thật trong `docker-compose.scale.yml`.
- [x] **TC57, TC58, e2e mới `tests/tc57-58.pd08.e2e.mjs`.** Lấy mẫu `tests/pd08-retry.integration.cjs`, `tests/pd08-compose.test.yml` và `testFailures` trong `parking-node/src/command-retry.js`. Có `skip: process.env.COMMAND_MODE !== 'broker'`.
  - TC57: lỗi tạm thời vài lần, lệnh tự thử lại rồi DONE, đúng 1 reservation.
  - TC58: lỗi vượt giới hạn, tin vào `cmd.dead`, có bản ghi `dead_letters`, `commands.status='FAILED'`, `GET /api/commands/:id` trả FAILED.
  - Thêm vào `tests/pd08-compose.test.yml` nếu cần biến bật lỗi giả. Không bật lỗi giả trong `docker-compose.yml` thường.

**Bàn giao B11 chi tiết (05/11):** Phạm vi chỉ năm checkbox của “B11 chi tiết”; không tick B11 tổng hay B khác. Các dấu `[x]` ở mục này xác nhận đã sửa/viết file, **không xác nhận test đạt**. Không chạy shell, test/build/Docker hay commit/PR theo giới hạn của mục này.
- `commands.id` được gửi nguyên vẹn thành `messageId` trong `command-flow.publishOne`; DLQ dùng đúng ID đó. Dùng lại `signal()` để trả request đang chờ và `pg_notify('command_results', ...)` để các Aggregator phát `COMMAND_RESULT`.
- `failure_phase` trước đó không có CHECK; thêm `EXECUTION` cùng `SEND` bằng mẫu DROP/ADD constraint có sẵn trong schema. Chỉ cập nhật lệnh `PENDING`, không sửa `DONE`.
- Trang Quản trị đã có bảng từng bãi: đã áp dụng / từ chối kèm lỗi / chưa phản hồi; giữ nguyên, chỉ đổi nhãn sáu bãi/vùng Nam.
- TC58 cần lỗi cả ba lần giao; mở giới hạn hook `testFailures` từ 2 lên 3, vẫn chỉ bật trong `NODE_ENV=test` và khớp chính xác messageId. Không thay thuật toán retry hay bật lỗi giả ở Compose thường. TC58 quan sát bản sao routing `dead` bằng queue exclusive, không giành tin `cmd.dead` của worker thật; đồng thời kiểm tra `dead_letters`, DB `commands` và API.
- Review tĩnh cuối: không xác nhận được lỗi chặn trong thay đổi B11. Giữ assertion cleanup TC57/58: lỗi ở `finally` của subtest không bỏ qua `finally` ngoài cùng (vẫn khôi phục node/đóng AMQP); cần báo cleanup lỗi thay vì im lặng. Không đổi hai default TTL có sẵn trong `config.js` vì ngoài phạm vi B11; stack retry đặt `COMMAND_TTL_MS=60000` cho cả hai.
- Chờ chạy `node --test --test-concurrency=2 test/*.test.js` trong `aggregator-service` và `parking-node`; build frontend; TC61 trên stack scale; TC57/58 trên project `pd08-*` cô lập với `COMMAND_MODE=broker`, override `tests/pd08-compose.test.yml` và TTL 60000 ms. Hai file e2e mới có lệnh chạy ở đầu file. Không chạy đồng thời với bộ e2e khác có dừng node/đổi bảng giá.

### B12 – PD-15 ra 6 bãi – sau PR PD-15 của Loan, B3

- [x] Bật đọc replica (`READ_DATABASE_URL`) cho cả sáu bãi trong mẫu `gen-lots.mjs`.
- [x] TC71 đạt trên bãi A và E trong [CI ngày 08/11](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42471407708/job/128702782509).
- [ ] PR, merge.

### B13 – PD-24 trace lệnh qua broker – sau PR PD-24 của Hiệp, B2

- [x] Gắn `traceparent` vào header lệnh và phản hồi (`commands.send`, consumer node, `command-replies`, consumer `agg.replies`).
- [x] Kiểm tra: một trace đặt chỗ ở `COMMAND_MODE=broker` có đủ HTTP → AMQP lệnh → node → DB → AMQP phản hồi → Socket.IO; chụp ảnh. Ảnh trace saga 3 bãi có bù trừ (sau B5).
- [x] PR, merge.

#### B13 chi tiết (05/11, nhánh `huynh/PD-B13`, đang giữa `git merge` PR #83 của Hiệp)

Chỉ sửa file, không chạy lệnh shell, không commit.

- [x] **Gỡ 5 file xung đột, xoá hết dấu `<<<<<<<`, `=======`, `>>>>>>>`:** `.github/workflows/ci.yml`, `aggregator-service/src/routes.js`, `parking-node/src/index.js`, `parking-node/src/schema.sql`, `parking-node/src/slots.js`.
  - Giữ toàn bộ tính năng của `dev` (HEAD): PD-02, PD-06, PD-08, PD-04, PD-17 (HLC), PD-25. Thêm phần tracing của PD-24 lên trên, không bỏ dòng nào của `dev` trừ khi trùng hẳn.
  - `ci.yml`: giữ mọi job của `dev`, thêm job tracing của PD-24 nếu có. Bỏ điều kiện `contains(github.head_ref,'PD-24')` để job không phụ thuộc tên nhánh; nếu job nặng thì chỉ chạy trên `pull_request` vào `dev`.
- [x] **Span `command.publish`:** chỉ bao thời gian gửi lên broker tới khi có confirm, không bao thời gian chờ phản hồi. Phần chờ dùng span riêng `command.wait_reply` nếu cần. Đọc `aggregator-service/src/commands.js`, `command-flow.js`.
- [x] **`traceparent` đủ đường đi ở `COMMAND_MODE=broker`:** header lệnh (`commands.send`, `command-flow.publishOne`), consumer node (`parking-node/src/commands.js`), phản hồi của node, `aggregator-service/src/command-replies.js`, phát `COMMAND_RESULT` qua Socket.IO. Tin retry của PD-08 (`command-retry.js`) và replay DLQ giữ nguyên `traceparent`. Header mới phải nằm ngoài chữ ký hoặc được ký đúng, xem `command-signature.js`, `retry-contract.js`; không làm hỏng xác thực chữ ký.
- [x] **Không tốn khi tắt:** khi không bật tracing, code chạy như cũ, không cần Jaeger. `package.json` và lockfile các service phải có đủ deps OTel.
- [x] **Test `tests/tc-pd24.trace.e2e.mjs`:** có `skip: !process.env.TRACING`, chạy trên `docker-compose.yml` + `docker-compose.tracing.yml`, `COMMAND_MODE=broker`. Đặt chỗ một lần, gọi API Jaeger `/api/traces?service=...`, kiểm tra cùng một trace có span của aggregator và parking node, gồm publish, consume, phản hồi. Xem cổng Jaeger trong `docker-compose.tracing.yml`. Nếu #83 đã có test giống vậy thì mở rộng test đó.
- [x] Ghi vào cuối mục này: tên file đổi, điều chưa kiểm được, mọi quyết định khi gỡ xung đột.

**Bàn giao B13 chi tiết (05/11):** Chỉ sáu checkbox trong mục này được tick; xác nhận sửa/viết file, **không xác nhận test đạt**. Không chạy shell, test/build/Docker, stage/commit hay lệnh git thay đổi merge. Git index vẫn để người tiếp nhận xử lý sau khi kiểm thử.
- File sửa trong lượt B13: `.github/workflows/ci.yml`; `aggregator-service/src/{routes,commands,command-flow,command-replies,index,tracing}.js`; `parking-node/src/{index,commands,command-replies,slots,tracing}.js`, `parking-node/src/schema.sql`; `notification-service/src/tracing.js`; `aggregator-service/test/{tracing,dlq}.test.js`; `parking-node/test/command-retry.test.js`; `tests/pd24-tracing.e2e.mjs`; `tai-lieu/pd-24-tracing.md`; `PLAN.md`. Các file OTel/Docker/Compose/package/lockfile đã có từ PR #83 được giữ, không tự tạo lại lockfile.
- Quyết định gỡ xung đột: giữ `mountDlq`, `mountBroadcasts`, các tham số app của HEAD; giữ `publishDetailed`, `retryOrDead`, `withDeadline`, `adminEnabled`, hook lỗi test và cleanup của node. Chuyển span nhận lệnh vào processor dùng chung, sau xác thực chữ ký, không tạo processor thứ hai bỏ qua PD-08. Giữ cả cột/migration HLC lẫn traceparent; `slots.emit` ghi cả hai trong cùng INSERT, giữ payload HLC và timestamp của phiên.
- CI giữ `test`, `frontend`, `pd04-abc`, `e2e`, `retry-dlq`. Cài dependencies hai package dùng chéo trước khi unit test, giữ concurrency=2; thêm job `tracing` riêng chỉ PR vào `dev`, bỏ lọc tên nhánh. Không chạy job CI ở phiên này.
- Ưu tiên yêu cầu B13 chi tiết hiện tại so với nhận xét PD-24 cũ “không đụng commands.js” trong `tai-lieu/nhan-xet-thanh-vien-gd2.md`: chỉ thêm tracing vào commands, không lấy thuật toán commands/saga cũ từ nhánh thành viên. Không sửa saga.
- `command.publish` nằm trong `commands.send`, kết thúc khi confirm hoặc lỗi publish, không bao `execute`/chờ phản hồi. Không thêm `command.wait_reply` vì không bắt buộc. Context HTTP lưu bền trong envelope cho worker/recovery và saga; producer inject context trước khi ký body/header, không đổi hợp đồng HMAC. Node inject context consumer vào reply trước `enrichReply` ký; reply publisher chỉ đổi header transport ngoài chữ ký, không sửa payload đã ký. `pg_notify` mang JSON `{ id, traceparent }`, listener vẫn đọc thông báo commandId thuần từ instance cũ và truyền parent tới `COMMAND_RESULT` Socket.IO.
- Retry PD-08 và replay DLQ đã giữ traceparent, không cần sửa thuật toán; thêm assertion giữ context và chữ ký vào test hiện có. Thêm `aggregator-service/test/tracing.test.js` dùng SDK thật + broker confirm có điều khiển để kiểm tra producer kết thúc trong khi HTTP vẫn chờ.
- Giữ/mở rộng test có sẵn `tests/pd24-tracing.e2e.mjs` thay vì tạo test TC77 trùng tên mới. Có `skip: !process.env.TRACING`, yêu cầu `COMMAND_MODE=broker`, truy vấn Jaeger `/api/traces?service=aggregator`, lọc đúng trace ID và kiểm HTTP, command publish/receive, PostgreSQL, reply publish/receive, Socket.IO `COMMAND_RESULT` cùng trace. Giữ thêm kiểm tra nhánh parking event. Jaeger UI/API cổng 16686. Hướng dẫn chạy trong `tai-lieu/pd-24-tracing.md`.
- Review tĩnh độc lập cuối tìm thấy race trong test có sẵn: reply cập nhật cache trước parking event có thể làm `SLOT_UPDATED` không được emit (hoặc test nhận nhầm event tạo slot). Đã bỏ chờ `SLOT_UPDATED`, vẫn bắt buộc nhận `COMMAND_RESULT` DONE và kiểm span nhánh event trên Jaeger; không thay thuật toán cache. Reviewer không thấy thêm lỗi syntax/context/signature chắc chắn; đây không phải xác nhận runtime/test đạt.
- Tracing mặc định không khởi tạo SDK (chỉ bật khi `OTEL_SDK_DISABLED=false`); Compose thường tắt, overlay bật. Đọc package.json, root lock entry và tìm đủ bốn node_modules OTel entry của cả ba service: đủ deps, không thêm dependency. Grep tĩnh không còn conflict marker trong năm file xung đột và các file nguồn liên quan. Chưa kiểm `npm ci`, syntax, unit/e2e, Compose config, signature/runtime tương tác thật, overhead khi tắt hay ảnh trace/saga bù trừ. Bộ test mới chưa chạy RED/GREEN vì mục này cấm shell.

**Review B13 bổ sung (05/11):** Chỉ sửa file theo `.task-b13.md`, không shell/commit. Checkbox dưới đây xác nhận đã sửa file, **không xác nhận test đạt**.
- [x] `parking-node/src/relay.js`: inject context của producer; giữ span tới confirm ở cả single/batch, ghi lỗi trước end; giữ thứ tự gửi và đánh dấu outbox sau confirm. Thêm unit test với SDK thật và confirm có điều khiển.
- [x] `notification-service/src/index.js`: consumer `notification.process`, extract parent/inject header khi publish; ghi lỗi, giữ logic ack. Thêm unit test consumer thành công/lỗi.
- [x] `tests/pd24-tracing.e2e.mjs`: kiểm quan hệ CHILD_OF từ `event.process` tới `outbox.publish`; ghi bàn giao và những kiểm tra chưa chạy ở cuối mục này.

**Bàn giao review B13 bổ sung:**
- Nguyên nhân trong relay: header gửi lại context cha đã lưu trong outbox, span kết thúc ngay sau `publish` nên không nhận lỗi confirm. Đã inject context đang active bên trong `outbox.publish`; single đợi confirm trong callback, batch giữ các span tới một lần `waitForConfirms()` chung. Lỗi publish/confirm được ghi exception + ERROR trước khi end mọi span đã mở. Không đổi `makeRelay`, thứ tự sự kiện, điều kiện UPDATE `published_at` hay rollback.
- Đã đọc `notification-service/src/tracing.js`: SDK chỉ bật khi `OTEL_SDK_DISABLED=false`, auto-instrumentation AMQP bị tắt. Giữ nguyên file này và dependencies; thêm span thủ công cho từng tin trong consumer, extract từ header trên ROOT_CONTEXT, inject vào header publish `user.notifications`. Span bao cả confirm, ghi lỗi parse/publish/confirm; vẫn ack sau confirm khi thành công và ack trong nhánh lỗi như trước; tin null không tạo span. Khi SDK không khởi tạo, dùng API no-op, không cần Jaeger.
- Test mới: `parking-node/test/relay-tracing.test.js` (SDK thật; single/batch, parent/header producer, span còn mở trước confirm, thứ tự gửi, một confirm chung, lỗi confirm/publish và đóng tất cả span); `notification-service/test/tracing.test.js` (SDK tắt/bật, parent/header, confirm trước ack, lỗi JSON/publish/confirm, tin null). Giữ các test relay DB và rules hiện có. TC77 đợi và assert mọi `event.process` có reference `CHILD_OF` tới `outbox.publish` cùng trace để tránh thiếu producer khi Jaeger export lệch thời điểm.
- File đổi: `parking-node/src/relay.js`, `notification-service/src/index.js`, hai unit test mới nêu trên, `tests/pd24-tracing.e2e.mjs`, `PLAN.md`. Không đổi ack, rules, schema, chữ ký, package/lockfile hay cấu hình tracing.
- **Chưa kiểm:** không chạy shell, syntax check, unit test, build, Docker, E2E/Jaeger hay git/commit theo yêu cầu. Các test mới chưa chạy RED/GREEN; chưa xác nhận runtime hoặc overhead khi SDK tắt. Người tiếp nhận cần chạy `npm test` trong `parking-node` và `notification-service`, rồi TC77 theo lệnh đầu `tests/pd24-tracing.e2e.mjs` trên stack tracing broker; kiểm parent links và lỗi confirm thật.

### B14 – PD-26 nemesis failover DB, treo leader – sau PR PD-26 của Hiệp, B8

- [x] `tests/jepsen/nemesis.mjs` thêm nemesis `db` (`docker compose stop db-x`, failover tự động) và `leader` (`docker pause` leader 15 s).
- [x] Bất biến 6 đọc epoch từ etcd và `db_epoch`.
- [x] Jepsen 300 giây với seed 42 và 43 đạt 6/6 bất biến. Xem [kết quả Jepsen](tai-lieu/ket-qua-jepsen.md).
- [ ] PR, merge.

---

## Đợt 5

### B15 – PD-27 Đo trước/sau (issue #45) – sau tất cả

- [x] `tests/load/k6.js`: kịch bản 300 người dùng ảo; `node scripts/net.mjs B latency 1500`.
- [x] 4 cặp so sánh: `COMMAND_MODE` http/broker; 3/6 bãi; 2/4 Aggregator; bãi A đồng bộ/bất đồng bộ.
- [x] Mỗi lần ghi p50, p95, p99, tỉ lệ 504/503, thông lượng; lưu log k6. Chưa có ảnh Grafana.
- [x] `tai-lieu/ket-qua-do-so-sanh.md`: bảng số liệu, không có số ước lượng. Đã đối chiếu SLO mục 3.3 theo bản kế hoạch v1.4.
- [x] TC80: 300 người dùng ảo, bãi chậm 1,5 s, hai lượt trên bản cuối p95 đặt 139/254 ms (<300 ms), 503/504=0%; bất biến đều đạt. Xem `tai-lieu/ket-qua-do-so-sanh.md`.
- [ ] PR, merge.

### B16 – Kết thúc

Nhánh `dev` đã lên `main` qua PR #97 và #101. PR #102 chuẩn hóa demo 10 slot mỗi bãi. PR #103 kiểm tra lại cấu hình sáu bãi, chịu lỗi, truy vết, thống kê, phân mảnh và hiệu năng. Xem [nhận xét cập nhật](tai-lieu/nhan-xet-thanh-vien-gd2.md) và [số đo TC80/PD-20](tai-lieu/ket-qua-do-so-sanh.md).

- [ ] Toàn bộ e2e trên `dev` đạt với các profile `coord`, `ha`, `scale`, `obs`.
- [x] PR `dev` → `main` (#97 và #101).
- [ ] Cập nhật bảng điểm và nhận xét.

## Câu hỏi

- B4 – Định tuyến theo username nhưng `commands.user_id`, `sagas.user_id` và `commandId` hiện chỉ chứa UUID; phản hồi broker cũng không chứa username. Có chấp nhận thêm bảng ánh xạ `user_id → username` ở `db-agg` để chọn phân mảnh mà không phải dò mọi DB không? Đề xuất giữ nguyên UUID, token và commandId hiện tại; đăng nhập ở phân mảnh 2 không được phụ thuộc phân mảnh 1.
- B4 – `scripts/them-phan-manh.mjs` cần chuyển dữ liệu hiện có từ `db-agg` sang hai phân mảnh đầu tiên, hay chỉ thêm phân mảnh thứ ba? Khi ghi đôi/chuyển đọc, có chấp nhận lưu cấu hình vòng băm và trạng thái di chuyển chung ở `db-agg`, cùng một khoảng chặn ghi ngắn để đối chiếu và chuyển đọc an toàn trên mọi bản Aggregator không? Cần chốt trước khi triển khai việc xoá bản cũ.
- B6: Lệnh nào phải đi vào `cmd.<bãi>.admin`? Tất cả lệnh của ADMIN hay chỉ lệnh từ API quản trị? Các loại lệnh quản trị cần node xử lý là gì?

### Trả lời (Huynh, 01/11)

- B4 câu 1: **Không thêm bảng ánh xạ.** Chỉ bảng `users` (và sau này `login_buckets` của B9) chia phân mảnh theo `username`. JWT đã có `username`, nên mọi request đã đăng nhập chọn phân mảnh bằng `req.user.username`. Bảng `commands`, `sagas` **giữ ở `db-agg`** (đây là dữ liệu điều phối, không phải dữ liệu người dùng); giữ nguyên UUID, token, commandId. Đăng nhập chỉ đụng phân mảnh của username đó, không phụ thuộc phân mảnh khác.
- B4 câu 2: `scripts/them-phan-manh.mjs` chỉ cần **thêm phân mảnh thứ ba** (2 → 3), chuyển những username đổi chủ. Lưu trạng thái di chuyển ở bảng `shard_migrations` trong `db-agg`; chấp nhận chặn ghi ngắn (cờ trong bảng đó, Aggregator đọc trước khi ghi `users`) để đối chiếu số lượng + checksum rồi chuyển đọc. Có thêm cờ `--import-agg` chép một lần các user cũ từ bảng `users` ở `db-agg` sang đúng phân mảnh. `seedUsers` ghi mỗi user mẫu vào đúng phân mảnh của nó. Có `--dry-run`. Không có `USERS_DATABASE_URLS` thì chạy như cũ (bảng `users` ở `db-agg`).
- B6, hàng đợi admin: lệnh quản trị là các lệnh do ADMIN phát cho nhiều bãi (PD-04: đổi bảng giá, bảo trì hàng loạt). `commands.send(parkingId, type, payload, { admin: true })` gửi vào `cmd.<bãi>.admin`; mặc định (`reserve`, `cancel`, `pay`) vẫn vào `cmd.<bãi>`. Hiện chưa có nơi nào gửi `admin: true`; PD-04 sẽ dùng sau. Node mở 2 channel: prefetch 16 cho `cmd.<bãi>`, 4 cho `cmd.<bãi>.admin`, cùng một processor/inbox. Khai báo hàng đợi admin trong `rabbitmq/definitions.json` và lúc node khởi động (giống `cmd.<bãi>`).
- Làm nốt phần còn lại của B6: `x-dead-letter-routing-key: expired`, queue `cmd.expired` bind `parking.dlx`, consumer `cmd.expired` chỉ chạy ở leader (EXPIRED + Socket.IO; `delivery_limit` → `cmd.dead`), 503 + `Retry-After` khi `QUEUE_FULL`, và test.

## Bàn giao mục nhỏ 05/11

Chỉ sửa file theo `.task-muc-nho.md`, không chạy shell/test/build/Docker, không commit/PR. Dấu `[x]` dưới đây xác nhận đã viết file, **không xác nhận chạy đạt**; không tick B4/B8 “thiết kế vào issue” vì chỉ có bản local, không tick các lượt đo B15.

- [x] `aggregator-service/src/metrics.js`, `src/events.js`: thêm `hlc_drift_ms` và gọi tại `applyEvent`, trước khi bỏ tin cũ theo version. Đo `abs(HLC.l - Date.now())` theo `parking_id`, không lấy đồng hồ HLC đã gộp làm mốc; HLC sai/thiếu không đổi gauge, không lưu vào cache và không chặn xử lý slot. Tick riêng dòng HLC của B10.
- [x] `aggregator-service/test/metrics.test.js`: kiểm gauge qua handler `/metrics`, HLC tương lai/quá khứ, tin cũ và HLC sai/thiếu; test viết trước phần triển khai, chưa chạy RED/GREEN theo giới hạn không shell.
- [x] `tai-lieu/pd-14b-thiet-ke.md`, `tai-lieu/pd-16-thiet-ke.md`: thiết kế từ code hiện có. PD-14b ghi đúng CAS → chờ → promote, cửa sổ/timeout là cấu hình không phải số đo. PD-16 mô tả chặn ghi (không phải ghi đôi); ghi rõ script chưa chuyển `login_buckets`, drain cố định, cleanup cần người vận hành xác nhận mọi Aggregator đã đổi vòng. Không sửa thuật toán failover/phân mảnh trong phạm vi này.
- [x] `tests/load/k6.js`: mặc định 240 VU đọc + 60 VU đặt, host/ngưỡng qua `__ENV`, đăng nhập demo như e2e. Lấy mã slot thật từ API (không dùng A01 cho seed SLOTS mới), key riêng cho đặt/huỷ; 202 thì poll `GET /api/commands/:id` tới kết quả cuối, 201 thì huỷ để quay vòng, 409 là tranh chấp hợp lệ. Summary JSON giữ p50/p95/p99, req/s, 503/504, raw metrics/thresholds; số thiếu là null, không giả bằng 0.
- [x] `scripts/do-so-sanh.sh`, `tai-lieu/ket-qua-do-so-sanh.md`: wrapper `grafana/k6` ghi `<tên>.json` + `.log`, không ghi đè, giữ mã lỗi k6; tên chỉ là nhãn stack do người chạy dựng sẵn. Khung 4 cặp và TC80 để trống; có lệnh chạy lại/reset latency và quy ước mẫu số/đơn vị.

**Review tĩnh độc lập:** không có lỗi chặn được xác nhận trong bốn mục và bàn giao; không xác minh runtime, không chạy shell/git/test/Docker.

**Chưa kiểm:** unit Aggregator (đặc biệt `test/metrics.test.js`, `test/events.test.js`), unit parking-node, cú pháp Bash/k6, Docker mount/quyền ghi trên Windows và Linux, smoke 201/202/409 ở cả http/broker, tải đủ 300 VU, TC80 trên toxiproxy, bất biến sau tải và ảnh Grafana. Chưa có JSON/log/ảnh đo thực tế. Khi được chạy lệnh: chạy unit theo quy tắc chung; `bash -n scripts/do-so-sanh.sh`; smoke k6 với VU/thời lượng nhỏ trước, rồi lượt 300 VU theo tài liệu. Cần đối chiếu ngưỡng p95 với bản SLO mục 3.3 khi đo, không sửa ngưỡng theo kết quả sau chạy.

