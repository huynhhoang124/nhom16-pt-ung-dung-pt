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
- [ ] `aggregator-service/src/ring.js`:
  - Băm `sha1(username.toLowerCase())`, lấy 4 byte đầu thành số trên vòng 2³².
  - 128 nút ảo mỗi phân mảnh.
  - Hàm `shardFor`, `addShard`, `removeShard`.
- [ ] Compose: `db-users-1`, `db-users-2`, mỗi cái có replica (cùng mẫu B3). Biến `USERS_DATABASE_URLS` là danh sách URL phân cách bằng dấu phẩy.
- [ ] Aggregator: mỗi phân mảnh một `Pool`, thêm hàm `usersPool(username)`. Chuyển sang pool theo người dùng:
  - `users` (`auth.js`, kể cả `seedUsers`).
  - `commands` (B2).
  - `sagas` (`saga.js`).
  - Các bảng chung khác giữ ở `db-agg`.
- [ ] `scripts/them-phan-manh.mjs`: ghi đôi → chép → đối chiếu số lượng và checksum → chuyển đọc → xoá bản cũ. Có `--dry-run`.
- [ ] Kiểm tra:
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
- [ ] `git checkout -b huynh/PD-14b origin/dev && git cherry-pick a613d05 c13fc62 5129966 088def2`. Khi xung đột:
  - Bỏ thay đổi PD-10 ở `leader.js`, `fencing.js`, `app.js`.
  - Giữ `failover-manager/`, `parking-node/src/dynamic-pool.js`, `epoch.test.js`.
- [ ] `failover-manager` dùng module bầu leader trên `dev`, khoá `/nhom16/election/failover`.
- [ ] Bỏ đường tắt `x-test-simulate-stale-epoch` ở `parking-node/src/app.js`.
- [ ] Viết lại TC69 thật: bật lại primary cũ → chờ node sẵn sàng → ghi → `409 STALE_DB_EPOCH`, và chỉ 1 primary (`pg_is_in_recovery()`).
- [ ] Bãi A, D: replica chết quá 3 s thì `ALTER SYSTEM RESET synchronous_standby_names` + `pg_reload_conf()` và ghi cảnh báo. Phải khớp với cách B3 đặt tham số.
- [ ] Kiểm tra:
  - `COORD=1 HA=1`: TC68 (failover ≤ 15 s), TC69, TC70 (ghi treo ≤ 3 s), TC65, TC66 đạt cùng một lượt.
  - Đo `scripts/measure-failover.mjs`, ghi vào runbook.
- [ ] PR, merge.

### B9 – PD-21 Giới hạn đăng nhập phân tán (issue #39) – sau B4

- [ ] Bảng `login_buckets(username PK, tokens REAL, updated_at TIMESTAMPTZ)` ở phân mảnh users.
- [ ] `aggregator-service/src/auth.js`: thay `makeLimiter()` (đếm trong RAM) bằng một câu `UPDATE … RETURNING` nguyên tử: nạp lại token theo thời gian, sai thì trừ 1. Giới hạn 5 lần sai trong 15 phút.
- [ ] Kiểm tra: 4 bản Aggregator, 5 lần sai rải đều → lần thứ 6 bị khoá (e2e). Có unit test.
- [ ] PR, merge.

### B10 – PD-25 Metrics, cảnh báo, dashboard (issue #43) – sau B2, B6

- [ ] Thêm metric vào `aggregator-service/src/metrics.js` và `parking-node/src/metrics.js`:
  - `command_duration_seconds`
  - `cmd_redelivered_total`
  - `cmd_dead_total`
  - `cmd_oldest_age_seconds`
  - `aggregator_is_leader`
  - `fencing_rejected_total`
  - `hlc_drift_ms` (gọi khi PD-17 của Loan đã merge)
- [ ] `observability/prometheus.yml`: thêm job cho `failover-manager`, `stats-service`, etcd, RabbitMQ `/metrics/detailed?family=queue_coarse_metrics`.
- [ ] Alertmanager: service trong profile `obs`, file `observability/alertmanager.yml` và `observability/alerts.yml` theo ngưỡng mục 10.2.
- [ ] 2 dashboard `observability/grafana/dashboards/` ("Kênh lệnh", "Điều phối"), theo mẫu `nhom16.json`.
- [ ] Kiểm tra: chạy k6 rồi chụp 2 dashboard; tắt một bãi hoặc làm đầy hàng đợi → cảnh báo bắn.
- [ ] PR, merge.

---

## Đợt 4 (sau khi thành viên merge việc độc lập)

### B11 – Nối PD-08, PD-04 vào PD-03; TC61 – sau PR PD-08, PD-04 của Hùng, B1, B2

- [ ] Retry của PD-08 bọc consumer lệnh, có cả phản hồi request–reply: lỗi tạm thời thì thử lại theo độ trễ; quá giới hạn thì vào `cmd.dead` và `commands.status='FAILED'`.
- [ ] PD-04 phát lệnh nhiều bãi dùng luồng `commands` của B2. Kết quả từng bãi lưu và hiện trên trang Quản trị.
- [ ] Bỏ `skip` ở TC61, chạy trên 6 bãi.
- [ ] Kiểm tra:
  - TC57, TC58 với `COMMAND_MODE=broker`.
  - TC61: tắt F → 2/3; bật F trong 10 phút → F áp dụng.
- [ ] PR, merge.

### B12 – PD-15 ra 6 bãi – sau PR PD-15 của Loan, B3

- [ ] Bật đọc replica (`READ_DATABASE_URL`) cho mọi bãi trong mẫu `gen-lots.mjs`.
- [ ] Kiểm tra: TC71 trên bãi A và một bãi vùng Nam (E).
- [ ] PR, merge.

### B13 – PD-24 trace lệnh qua broker – sau PR PD-24 của Hiệp, B2

- [ ] Gắn `traceparent` vào header lệnh và phản hồi (`commands.send`, consumer node, `command-replies`, consumer `agg.replies`).
- [ ] Kiểm tra: một trace đặt chỗ ở `COMMAND_MODE=broker` có đủ HTTP → AMQP lệnh → node → DB → AMQP phản hồi → Socket.IO; chụp ảnh. Ảnh trace saga 3 bãi có bù trừ (sau B5).
- [ ] PR, merge.

### B14 – PD-26 nemesis failover DB, treo leader – sau PR PD-26 của Hiệp, B8

- [ ] `tests/jepsen/nemesis.mjs` thêm nemesis `db` (`docker compose stop db-x`, failover tự động) và `leader` (`docker pause` leader 15 s).
- [ ] Bất biến 6 đọc epoch từ etcd và `db_epoch`.
- [ ] Kiểm tra: `--nemesis random --time 300` với 2 seed khác nhau, đạt 6/6 bất biến. Lưu bảng vào `tai-lieu/ket-qua-jepsen.md`.
- [ ] PR, merge.

---

## Đợt 5

### B15 – PD-27 Đo trước/sau (issue #45) – sau tất cả

- [ ] `tests/load/k6.js`: kịch bản 300 người dùng ảo; `node scripts/net.mjs B latency 1500`.
- [ ] 4 cặp so sánh: `COMMAND_MODE` http/broker; 3/6 bãi; 2/4 Aggregator; bãi A đồng bộ/bất đồng bộ.
- [ ] Mỗi lần ghi p50, p95, p99, tỉ lệ 504/503, thông lượng; lưu log k6 và ảnh Grafana.
- [ ] `tai-lieu/ket-qua-do-so-sanh.md`: bảng số liệu, đối chiếu SLO mục 3.3. Không có số ước lượng.
- [ ] TC80: 300 người dùng ảo, bãi chậm 1,5 s → tỉ lệ 504 về 0, p95 trong ngưỡng.
- [ ] PR, merge.

### B16 – Kết thúc

- [ ] Toàn bộ e2e trên `dev` đạt với các profile `coord`, `ha`, `scale`, `obs`.
- [ ] PR `dev` → `main`.
- [ ] Cập nhật bảng điểm và nhận xét.

## Câu hỏi

(Chưa có. Bước nào chưa rõ thì ghi câu hỏi vào đây rồi dừng.)
