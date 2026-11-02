# Nhận xét thành viên – Giai đoạn 2

Nhóm 16 · 01/11/2026 (tuần 25/10 → 01/11) · Người nhận xét: Hoàng Văn Huynh

Mọi kết quả dưới đây do Huynh tự chạy lại ngày 01/11 trên Docker, mỗi nhánh một stack sạch. Sửa xong thì đẩy commit mới lên nhánh của mình, không amend, không force-push.

Ký hiệu:
- ✅ đạt
- ❌ lỗi
- ⚠️ đạt có điều kiện
- ⛔ không chạy được
- ⏸ chưa có code

## Bảng điểm

| Thành viên | 25/10 | 01/11 | Đã merge / tổng | Tuần này |
|---|---|---|---|---|
| Nguyễn Văn Luận | 72 | **77** | 3/5 | Sửa đủ lỗi PD-10 → merge #60 |
| Vũ Văn Hùng | 80 | **76** | 2/5 | Không có commit |
| Trịnh Kim Loan | 54 | **70** | 1/6 | PD-13 merge #61; PD-17, PD-14a, PD-05 còn lỗi |
| Đỗ Huyền Trang | 66 | **62** | 1/7 | PD-23 mới, chưa chạy được |
| Phạm Sỹ Hiệp | 45 | **56** | 0/5 | PD-12 đạt nhưng chưa PR; PD-24, PD-26 sai nền |

Điểm = 50% chất lượng + 30% khối lượng + 20% quy trình. Một việc được merge khi đạt ≥ 75 điểm, không có lỗi chặn và test đạt khi chạy lại.

`main` sau merge #65: unit 74/59/2, e2e `coord` 22/22; `ha` đạt TC43–TC49 và TC63–TC67.

---

## Luận – 77

**Tiến độ:**
- Đã merge: PD-09, PD-11, PD-10.
- PD-14b: có nhánh, chưa PR.
- PD-07: chưa làm.

**Kết quả test**

| Việc | Kết quả |
|---|---|
| PD-10: TC43, TC44, TC65, TC66 cùng một lượt (`COORD=1 HA=1`) | ✅ 4/4 |
| PD-10: `docker compose pause` leader thật 15 s | ✅ bản kia lên leader; sau unpause chỉ còn 1 leader |
| PD-10: trạng thái sau lượt test trên | ❌ `aggregator-2` bị tắt; 2 bản cùng `isLeader: true` (token 23, 27) |
| PD-14b: TC68 promote replica, TC70 hạ async | ✅ |
| PD-14b: TC69 zombie primary | ⚠️ chỉ đạt khi chạy riêng, và là test giả |
| PD-07: TC75–76 | ⏸ |

**Cần sửa**
1. **PD-10 – giả lập pause để lại 2 leader.**
   - `simulatePause` đặt `activeLease = null`, nên sự kiện `lost` bị bỏ qua ([leader.js:175](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/aggregator-service/src/leader.js#L175), [:119](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/aggregator-service/src/leader.js#L119)).
   - Sửa: hẹn `setTimeout(handleLoseLeadership, durationMs)`. Hoặc bỏ endpoint này và cho TC66 dùng `docker compose pause`.
2. **PD-10 – TC65/66 luôn dừng `aggregator-2` trong `finally`** ([e2e.test.mjs:729](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/tests/e2e.test.mjs#L729), [:786](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/tests/e2e.test.mjs#L786)). Hậu quả: TC43 chạy sau đó sẽ lỗi.
   - Sửa: chỉ dừng nếu chính test đã bật nó.
3. **PD-10 – request của người dùng cũng mang fencing token** ([nodes.js:91](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/aggregator-service/src/nodes.js#L91)). Hậu quả: khoá dòng `fencing` làm các lệnh ghi phải xếp hàng, và người dùng nhận `409`.
   - Sửa: chỉ gắn token khi có `job`.
4. **PD-10 – lệnh qua broker chưa kiểm fencing** ([commands.js:85](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/parking-node/src/commands.js#L85)).
   - Sửa: gọi `checkFencing` ngay sau `BEGIN`. Token cũ thì ghi `409 STALE_LEADER` vào inbox.
5. **PD-14b – TC69 là test giả.** Gặp header `x-test-simulate-stale-epoch` là [app.js:120](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/088def2/parking-node/src/app.js#L120) trả `409` ngay, không đụng DB. Chạy ngay sau TC68 thì lỗi `status 0`, vì node A chưa nối lại xong.
   - Sửa: bật lại primary cũ thật rồi ghi qua node.
   - Sửa: chờ node A sẵn sàng trước khi gửi.
6. **PD-14b – nhánh còn chứa PD-10 bản cũ, xung đột với `dev`.**
   - Sửa: tạo nhánh mới từ `origin/dev`, cherry-pick `a613d05 c13fc62 5129966 088def2`.
   - Chỉ giữ `failover-manager/`, `dynamic-pool.js`, `epoch.test.js`, rồi mở PR.

**Đã sửa hộ:** PD-09 làm node sập khi không nối được etcd lúc khởi động, vì [index.js:73](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/2b9cb9d/parking-node/src/index.js#L73) gọi `log.warn` mà `log.js` không có hàm này. Huynh đã thêm `log.warn` trong [`734860a`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/commit/734860a); Luận không cần làm gì.

**Sau khi sửa phải tự chạy**
- `COORD=1 HA=1`: TC43, TC44, TC65, TC66 đạt.
  - Sau lượt đó `aggregator-2` vẫn chạy.
  - `/api/leader` chỉ 1 bản trả `isLeader: true`.
- TC68, TC69, TC70 đạt cùng một lượt; TC69 dùng primary cũ thật.
- PD-07: TC75–76.

---

## Hùng – 76

**Tiến độ:**
- Đã merge: PD-01, PD-02.
- Còn mở: PR #49 (PD-08), #52 (PD-03), #53 (PD-04), không cập nhật từ 22–23/10.
- Tuần này không có commit. Trừ 4 điểm vì không phản hồi review.

**Kết quả test**

| Việc | Kết quả |
|---|---|
| PD-08: TC57, TC58 | ⛔ |
| PD-03: TC51, TC54, TC62 | ⛔ |
| PD-04: TC61 | ⛔ |

Lý do không chạy được:
- Merge thử vào `dev` thì xung đột: PD-08 4 file, PD-03 7 file, PD-04 6 file.
- Test PD-08 cần biến `PD02_SOURCE_ROOT` trỏ tới một checkout riêng.
- Test PD-03 cần bản ghép bằng patch.
- TC61 tự skip trong code ([pd04-broadcast.test.mjs:124](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e8dc90f/tests/pd04-broadcast.test.mjs#L124)).

**Cần sửa**
1. **PD-08/03/04 nối vào PD-02 bằng file `.patch`.**
   - Sửa: rebase từng nhánh lên `dev` (PD-02 đã có trên `dev`) và nối hook trực tiếp.
   - Xoá `scripts/pd0*-pd02*.patch`, `retry-integration.js`, `admin-integration.js`, `prepare-pd04-candidate.mjs`.
   - Test chạy được bằng `node --test` trên stack thường.
2. **PD-03 – `command-flow.js` viết dồn**, có dòng dài 221 ký tự.
   - Sửa: viết lại cho dễ đọc.
3. **PD-03 – đổi mặc định sang `broker`** ([routes.js:10](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/aggregator-service/src/routes.js#L10)).
   - Sửa: giữ `http` cho tới khi e2e chế độ broker chạy trong CI.
4. **PD-02 – kẹt hàng đợi phản hồi.**
   - Gặp tin không có queue nhận thì `break`, cả hàng đợi kẹt ([command-replies.js:76](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/command-replies.js#L76)). Sửa: đánh dấu tin đó rồi đi tiếp.
   - Bãi chưa có queue thì cứ 5 s reconnect một lần ([commands.js:151](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/commands.js#L151)). Sửa: tăng dần thời gian chờ, tối đa 60 s.
5. **Quy trình – 3 PR cùng chờ, quy định tối đa 2.**
   - Sửa: chuyển #52, #53 sang Draft.
   - Đăng thiết kế PD-03 lên issue #20.

**Sau khi sửa phải tự chạy**
- TC57: lỗi tạm thời → thử lại rồi thành công, không trùng.
- TC58: tin sai schema → vào `cmd.dead`, đẩy lại được.
- TC51, TC54, TC62 với `COMMAND_MODE=broker`.
- TC61: tắt F khi phát lệnh 3 bãi → kết quả 2/3.
- e2e trên `dev` mới nhất không đỏ.

---

## Loan – 70

**Tiến độ:** làm nhiều nhất nhóm tuần này.
- Đã merge: PD-13.
- Còn lỗi: PR #55 (PD-17), #63 (PD-14a), #64 (PD-05, mở 31/10).
- PD-15, PD-16: chưa làm.

**Kết quả test**

| Việc | Kết quả |
|---|---|
| PD-13: TC60; tắt `parking-a` | ✅ 4/4; 20/20 request vẫn 200 |
| PD-17: TC74 với D lệch `+30000` | ✅ |
| PD-17: TC74 với D lệch `-30000` | ❌ vào D đứng trước ra A |
| PD-14a: `pg_stat_replication` | ✅ A, D `quorum`; B, C `async` |
| PD-14a: bật `ha` → `down` → `up` không `ha` → ghi vào A | ❌ treo vô hạn |
| PD-14a: `config -q` | ❌ lỗi khi không có profile, hoặc chỉ có `ha`; ✅ đạt với `ha` + `extra` |
| PD-05: TC52, TC53 | ✅ |
| PD-05: TC60 SAC | ❌ 3/3 lần trượt, đo được 7,2–7,7 s (yêu cầu ≤ 5 s) |
| PD-15 TC71, PD-16 TC72–73 | ⏸ |

**Cần sửa**
1. **PD-17 – HLC không truyền qua HTTP.** TC74 đạt chỉ vì D chạy nhanh hơn.
   - [nodes.js:94](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/aggregator-service/src/nodes.js#L94): gửi header `x-hlc: hlc.now()`.
   - Node: có `x-hlc` và `x-internal-key` thì gọi `hlc.update`.
   - Thêm biến thể TC74 với lệch `-30000`, xe vào D đi qua Aggregator.
2. **PD-14a (chặn) – `ALTER SYSTEM` lưu vĩnh viễn trong volume** ([configure-sync-a.sh:25](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/postgres/configure-sync-a.sh#L25)).
   - Sửa: compose gốc thêm `-c synchronous_standby_names=''` cho `db-a`, `db-d`.
   - `docker-compose.ha.yml` bỏ tham số này đi.
3. **PD-14a – `docker-compose.ha.yml` lỗi khi thiếu profile.** Lỗi: `parking-a depends on undefined service "db-a-sync-config"` ([:31](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/docker-compose.ha.yml#L31), [:59](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/docker-compose.ha.yml#L59)).
   - Sửa: dùng `depends_on … required: false`.
   - Cho `db-d` vào cả profile `ha`.
   - Ghi vào runbook: chạy `up -d`, không dùng `--wait`.
4. **PD-05 – TC60 đo sai.** Thời gian đo được chủ yếu là lệnh `rabbitmqctl` chạy qua `docker compose exec` (khoảng 6 s mỗi lần gọi), không phải failover ([tc60.pd05.test.mjs:402](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/044715e/tests/tc60.pd05.test.mjs#L402)).
   - Sửa: đo bằng Management API (`GET :15672/api/consumers/%2F`), hoặc bằng khoảng cách `processed_at` trong `inbox_messages`.
   - PD-13 đã merge, nên chạy lại với `parking-a-1`/`parking-a-2`.
5. **Nhỏ:**
   - PD-17: comment sai ở [slots.js:275](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/parking-node/src/slots.js#L275); thụt lề sai ở `commands.js:52`.
   - PD-14a: runbook thiếu cách chạy script đo trễ trong container; `rewind.mjs --execute` chưa chạy thật.
   - PD-13: [tc60.pd13.test.mjs:22](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/551bd9af8a5cc366fe9fdd084477050d0661123f/tests/tc60.pd13.test.mjs#L22) viết cứng tên container, nên lấy bằng `docker compose ps -q`. `docker-compose.pd13.yml` chép lại biến môi trường, nên dùng `extends`.

**Sau khi sửa phải tự chạy**
- TC74 đạt với cả `+30000` và `-30000`.
- Bật `ha` → `down` (không `-v`) → `up` không `ha` → đặt chỗ ở A trả 201.
- `config -q` không lỗi với mọi tổ hợp profile.
- TC60 PD-05 đạt 3 lần liên tiếp.
- PD-15 TC71, PD-16 TC72–73.

---

## Trang – 62

**Tiến độ:**
- Đã merge: PD-18.
- Còn mở: PR #58 (PD-22), không cập nhật từ 24/10; PR #62 (PD-23), có lỗi chặn.
- PD-06, 20, 21, 25: chưa làm.
- Các lỗi PD-18 và PD-22 từ tuần trước chưa sửa.

**Kết quả test**

| Việc | Kết quả |
|---|---|
| PD-18: 40 sự kiện bãi C, độ trễ outbox → broker | ❌ p50 37 ms, p95 61 ms, 0% dưới 20 ms |
| PD-18: sau `restart db-c` | ❌ p50 338 ms, p95 690 ms (chậm gấp 10 lần) |
| PD-22: Aggregator khởi động, có và không có `events.stream` | ✅ khoảng 2 s cả hai trường hợp |
| PD-22: e2e | ❌ 16/17: TC37 lỗi `Cannot read properties of null (reading 'token')`; trên `dev` thì đạt |
| PD-23: `/api/admin/stats` | ❌ toàn 0 |
| PD-06: TC55, TC59 | ⏸ |

**Cần sửa**
1. **PD-23 (chặn) – không đọc được sự kiện nào.** [enabled_plugins](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/rabbitmq/enabled_plugins#L1) thiếu `rabbitmq_stream`, nên cổng 5552 trả `ECONNREFUSED`. `events.stream` cũng chưa có trong `definitions.json`.
   - Sửa: bật plugin.
   - Merge PD-22 trước, rồi rebase PD-23.
2. **PD-23 – bật mặc định, không có đường lui** ([docker-compose.yml:115](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/docker-compose.yml#L115)).
   - Sửa: đặt `${USE_STATS_SERVICE:-false}`.
   - Khi stats-service lỗi thì quay về scatter–gather.
3. **PD-23 – thiếu doanh thu tiền mặt.** Doanh thu chỉ được cộng khi có `PAYMENT_COMPLETED` ([slots.js:178](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/parking-node/src/slots.js#L178)).
   - Sửa: cộng `fee` của `CAR_EXIT` khi trả `CASH`.
4. **PD-23 – sự kiện thanh toán giả dạng `SLOT_UPDATED OCCUPIED`** ([slots.js:261](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/parking-node/src/slots.js#L261)).
   - Sửa: dùng `event_type` riêng, không có `status`/`version`.
   - Thụt lề lại khối này.
5. **PD-23 – tin lỗi bị mất vì offset vẫn tăng** ([consumer.js:219](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/stats-service/src/consumer.js#L219)).
   - Sửa: ghi offset trong cùng giao dịch; lỗi thì đọc lại từ offset cũ.
   - Bỏ `console.log` ở mỗi sự kiện.
   - Nhóm giờ theo `Asia/Ho_Chi_Minh`.
6. **PD-23 – chưa có test.**
   - Sửa: unit test `processEvent`, và một e2e so sánh 2 chế độ.
7. **PD-18 – LISTEN không nối lại khi DB khởi động lại**, nên relay rơi về quét định kỳ. Cả trước khi restart cũng chưa đạt mục tiêu ≥ 95% sự kiện dưới 20 ms.
   - Sửa: bắt sự kiện `end`/`error` của client LISTEN rồi nối lại.
   - Đo lại và tìm chỗ chậm.
8. **PD-22 – TC37 lỗi trên nhánh, thiếu xử lý lỗi.**
   - Sửa: rebase #58 lên `dev` và kiểm lại TC37.
   - Thêm `ch.on('error')` ([events.js:103](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5c4cf8245e46ab214cae9b926d1989ea7324c3a9/aggregator-service/src/events.js#L103)).
   - Thêm timeout cho replay.
   - Thêm bảng số đo trước/sau.

**Sau khi sửa phải tự chạy**
- `restart db-c` → 40 sự kiện bãi C, ≥ 95% dưới 20 ms.
- PD-22 e2e đạt hết; xoá stream thì Aggregator vẫn khởi động trong ≤ 10 s.
- PD-23: tạo 150 phiên mẫu → `/api/admin/stats` khớp nhau giữa `true` và `false`.
- PD-23: `restart stats-service` → không đếm trùng, không thiếu.
- PD-06: TC55, TC59.

---

## Hiệp – 56

**Tiến độ:**
- PD-12: đã rebase và test đạt nhưng chưa có PR.
- PD-24, PD-26, PD-19: chưa có PR.
- PD-27: chưa làm.

**Kết quả test**

| Việc | Kết quả |
|---|---|
| PD-12: e2e `SCALE=1 COORD=1` trên 6 bãi | ✅ 21/21 |
| PD-12: ưu tiên gọi bãi cùng `zone` | ❌ chưa làm: `zone` chỉ được lưu, không dùng |
| PD-24: TC77 trace trên Jaeger | ⛔ máy Huynh không tải được image Jaeger/OTel |
| PD-26: TC78 `--seed 42 --nemesis partition --time 120` | ❌ 5/6 bất biến (469 lệnh thành công, 475 lệnh đã nhận) |
| PD-26: TC79, PD-27: TC80 | ⏸ |

**Cần sửa**
1. **PD-12 – chưa có PR, thiếu ưu tiên vùng.**
   - Sửa: mở PR từ `feature/PD-12-six-parking-rebased`, đóng #56.
   - Aggregator ưu tiên gọi bãi cùng `zone` trước.
   - Bỏ cột `managed_by_etcd` ([schema.sql:24](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/0af30c8920491a7fd18e712ae83943e322cc259b/aggregator-service/src/schema.sql#L24)).
   - `gen-lots.mjs` sinh cả 6 bãi từ một mẫu.
2. **PD-24 – làm trên nhánh PD-03 chưa merge, xung đột 17 file.**
   - Sửa: tạo nhánh mới từ `origin/dev`.
   - Chỉ lấy `tracing.js`, `otel-collector.yml`, `docker-compose.tracing.yml`, tài liệu và test từ `1ebd265`.
   - Không đụng `commands.js`, `saga.js`.
3. **PD-26 – bất biến 4 lỗi: `did not converge within 30s: fetch failed`.** Mỗi vòng kiểm tra gọi `docker compose exec` 18 lần, nên một vòng đã gần hết 30 s ([checkers.mjs:145](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/7713dfd/tests/jepsen/checkers.mjs#L145)). Lần chạy đầu, RabbitMQ lỗi lúc khởi động và runner dừng hẳn.
   - Sửa: gộp truy vấn mỗi DB thành một lần gọi.
   - Ghi rõ bãi nào lỗi `fetch`.
   - Thêm bước thử lại `up`.
4. **PD-26 – chưa duyệt thiết kế, làm trên nhánh tích hợp.** [index.js:21](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/7713dfd26422d3486638c6598ef6be557cc1864f/parking-node/src/index.js#L21) ghi đè `Date.now`, làm lệch hạn JWT và hạn giữ chỗ. `ket-qua-jepsen.md` dài 1466 dòng, phần lớn là log.
   - Sửa: đăng thiết kế lên issue #44 và chờ duyệt.
   - Tách `tests/jepsen/` ra nhánh mới từ `dev`.
   - Bỏ ghi đè `Date.now`.
   - File kết quả chỉ giữ bảng.
5. **PD-19:** rebase sau khi PD-12 merge.

**Sau khi sửa phải tự chạy**
- PD-12: e2e `SCALE=1 COORD=1` đạt hết. Với `ZONE=bac`, log cho thấy gọi A–C trước.
- PD-24 TC77: một trace đủ chặng HTTP → AMQP → DB → outbox → AMQP → Socket.IO; chụp ảnh vào PR.
- PD-26 TC78: đạt 6/6 bất biến với `--seed 42`. TC79: cô lập 1 nút RabbitMQ, không mất lệnh.
- PD-27 TC80: bảng trước/sau với k6.

---

## Lưu ý chung

- TC43 viết cứng cổng 3000. Nên đọc từ biến `FRONTEND_URL`.
- Windows: cổng 2379 có thể bị hệ điều hành giữ. Khi đó đổi cổng host trong `docker-compose.override.yml`.
- Máy 16 GB: chạy `node --test --test-concurrency=2 test/*.test.js`.
