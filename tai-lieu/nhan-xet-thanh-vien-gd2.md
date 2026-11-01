# Nhận xét thành viên – Giai đoạn 2

Nhóm 16 · 01/11/2026 (tuần 25/10 → 01/11) · Người nhận xét: Hoàng Văn Huynh

Sửa xong thì đẩy commit mới lên nhánh của mình, không amend, không force-push. Link trỏ đúng dòng code lúc review.

## Bảng điểm

| Thành viên | 25/10 | 01/11 | Đã merge / tổng | Tuần này |
|---|---|---|---|---|
| Nguyễn Văn Luận | 72 | **77** | 3/5 | Sửa đủ lỗi PD-10 → merge #60 |
| Vũ Văn Hùng | 80 | **76** | 2/5 | Không có commit |
| Trịnh Kim Loan | 54 | **70** | 1/6 | PD-13 merge #61; PD-17, PD-14a còn lỗi |
| Đỗ Huyền Trang | 66 | **62** | 1/7 | PD-23 mới, chưa chạy được |
| Phạm Sỹ Hiệp | 45 | **56** | 0/5 | PD-12 rebase đạt; PD-24, PD-26 sai nền |

Điểm thành viên = 50% chất lượng + 30% khối lượng + 20% quy trình. Ngưỡng merge một việc: ≥ 75 điểm, không lỗi chặn, test đạt khi chạy lại.

## Kết quả test

| Nhánh | Kết quả | Kết luận |
|---|---|---|
| PD-10 (Luận) | Unit đạt; e2e `coord` 22/22; `docker pause` leader → bản kia lên sau 5 s | ✅ merge |
| PD-13 (Loan) | TC60 4/4; tắt `parking-a` → 20/20 request vẫn 200 | ✅ merge |
| PD-17 (Loan) | e2e 18/18, nhưng D lệch −30 s thì sai thứ tự | ❌ |
| PD-14a (Loan) | Bản sao đúng (A, D quorum; B, C async); ghi vào A treo sau khi tắt `ha` | ❌ chặn |
| PD-12 (Hiệp) | e2e 21/21 trên 6 bãi | ✅ chờ PR |
| PD-23 (Trang) | e2e 17/17, nhưng trang Thống kê toàn 0 | ❌ chặn |

`main` sau merge #65: unit 74/59/2, e2e `coord` 22/22, `ha` đạt TC43–TC49, TC63–TC67.

Chiều 01/11 mình đã tự chạy plan test của từng người. Kết quả ghi ngay dưới mục "Plan test" của mỗi người. Ký hiệu:
- ✅ đạt
- ❌ lỗi
- ⚠️ đạt có điều kiện
- ⛔ không chạy được
- ⏸ chưa có code

Lỗi mới phát hiện:
- Luận 6, 7: node sập do thiếu `log.warn`; TC69 là test giả.
- Loan 5: PD-05 TC60 đo sai.
- Trang: PD-18 có số đo; PD-22 lỗi TC37.
- Hiệp: PD-26 lỗi bất biến 4.

---

## Luận – 77

PD-09, PD-11, PD-10 đã merge. PD-14b chưa PR. PD-07 chưa làm.

**Cần sửa**
1. **PD-10 – giả lập pause để lại 2 leader.** `simulatePause` đặt `activeLease = null` nên sự kiện `lost` bị bỏ qua ([leader.js:175](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/aggregator-service/src/leader.js#L175), [:119](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/aggregator-service/src/leader.js#L119)). → Hẹn `setTimeout(handleLoseLeadership, durationMs)`, hoặc bỏ endpoint, cho TC66 dùng `docker compose pause`.
2. **PD-10 – TC65/66 luôn dừng `aggregator-2` trong `finally`** ([e2e.test.mjs:729](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/tests/e2e.test.mjs#L729), [:786](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/tests/e2e.test.mjs#L786)), làm TC43 lỗi khi chạy `HA=1`. → Chỉ dừng nếu chính test bật nó.
3. **PD-10 – request người dùng cũng mang fencing token** ([nodes.js:91](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/aggregator-service/src/nodes.js#L91)). Hậu quả: khoá dòng `fencing` làm ghi nối tiếp nhau, và người dùng nhận `409`. → Chỉ gắn token khi có `job`.
4. **PD-10 – lệnh qua broker chưa kiểm fencing** ([commands.js:85](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/parking-node/src/commands.js#L85)). → Gọi `checkFencing` ngay sau `BEGIN`; token cũ thì ghi `409 STALE_LEADER` vào inbox.
5. **PD-14b – nhánh còn chứa PD-10 bản cũ, xung đột với `dev`.** → Tạo nhánh mới từ `origin/dev`, cherry-pick `a613d05 c13fc62 5129966 088def2`. Chỉ giữ `failover-manager/`, `dynamic-pool.js`, `epoch.test.js`, rồi mở PR.

6. **PD-09 (lỗi mới) – node sập khi không nối được etcd lúc khởi động.** [index.js:73](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/2b9cb9d/parking-node/src/index.js#L73) gọi `log.warn`, nhưng [log.js:17](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/2b9cb9d/parking-node/src/log.js#L17) chỉ có `info` và `error`. Kết quả: `TypeError: log.warn is not a function`, container thoát với mã 1.
   - Gặp khi `.env` có `ETCD_ENDPOINTS` mà etcd chưa chạy. Đây đúng là tình huống PD-09 phải chịu được.
   - Các chỗ `log.warn?.(...)` ở `registry.js`, `config.js`, `discovery.js` không sập nhưng cảnh báo bị nuốt mất.
   - ✅ Huynh đã sửa hộ trong [`734860a`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/commit/734860a): thêm `log.warn` vào `log.js` của node và aggregator, kèm test. Luận không cần sửa gì; lần sau thêm hàm log mới thì nhớ kiểm `log.js`.
7. **PD-14b – TC69 là test giả.** [app.js:120](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/088def2/parking-node/src/app.js#L120) thấy header `x-test-simulate-stale-epoch` thì trả `409` luôn, không đụng DB. → TC69 phải bật lại primary cũ thật rồi ghi qua node.
   - TC69 chạy ngay sau TC68 thì lỗi (`status 0`), vì node A chưa nối lại xong. → Chờ node A sẵn sàng trước khi gửi.

**Plan test – kết quả mình chạy 01/11**
- ✅ `COORD=1 HA=1`: TC43, TC44, TC65, TC66 cùng đạt trong một lượt. TC43 cần sửa cổng sang 3005 trên máy mình.
- ❌ Sau lượt đó, `aggregator-2` bị tắt (lỗi 2). Cả 2 bản cùng báo `isLeader: true` (token 23 và 27) do `simulatePause` (lỗi 1).
- ✅ `docker compose pause` leader thật 15 s: bản kia lên leader (token 31). Sau unpause chỉ còn 1 leader.
- PD-14b (nhánh `088def2`):
  - ✅ TC68: promote replica.
  - ✅ TC70: hạ xuống async.
  - ⚠️ TC69: chỉ đạt khi chạy riêng, và là test giả (lỗi 7).
- ⏸ PD-07 TC75–76: chưa có code.

---

## Hùng – 76

PD-01, PD-02 đã merge. PR #49 (PD-08), #52 (PD-03), #53 (PD-04) không cập nhật từ 22–23/10. Tuần này không có commit. Trừ 4 điểm vì không phản hồi review.

**Cần sửa** (giữ từ 25/10)
1. **PD-08/03/04 nối vào PD-02 bằng file `.patch`.** → Rebase lên `dev`, nối hook trực tiếp, xoá `scripts/pd0*-pd02*.patch`, `retry-integration.js`, `admin-integration.js`, `prepare-pd04-candidate.mjs`.
2. **PD-03 – `command-flow.js` viết dồn** (dòng dài 221 ký tự). → Viết lại cho dễ đọc.
3. **PD-03 – đổi mặc định sang `broker`** ([routes.js:10](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/aggregator-service/src/routes.js#L10)). → Giữ `http` tới khi e2e chế độ broker chạy trong CI.
4. **PD-02 – kẹt hàng đợi phản hồi.**
   - Gặp tin không có queue nhận thì `break`, cả hàng đợi kẹt ([command-replies.js:76](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/command-replies.js#L76)). → Đánh dấu tin đó rồi đi tiếp.
   - Bãi chưa có queue thì cứ 5 s reconnect và ghi log ([commands.js:151](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/commands.js#L151)). → Tăng dần thời gian chờ, tối đa 60 s.
5. **Quy trình – 3 PR chờ (tối đa 2).** → Chuyển #52, #53 sang Draft, đăng thiết kế PD-03 lên #20.

**Plan test – kết quả mình chạy 01/11**
- ⛔ Không chạy được test nào: TC57–58, TC51, TC54, TC62, TC61.
  - Merge thử vào `dev` thì xung đột: PD-08 4 file, PD-03 7 file, PD-04 6 file.
  - Test của PD-08 cần biến `PD02_SOURCE_ROOT` trỏ tới một checkout PD-02 riêng.
  - Test của PD-03 cần "broker candidate" ghép bằng patch.
  - TC61 tự skip trong code ([pd04-broadcast.test.mjs:124](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e8dc90f/tests/pd04-broadcast.test.mjs#L124)).
- → Sửa lỗi 1 (rebase lên `dev`, bỏ patch) trước, rồi chạy lại TC57–58, TC51, TC54, TC62, TC61 bằng `node --test` trên stack thường.

---

## Loan – 70

PD-13 đã merge. PR #55 (PD-17), #63 (PD-14a) và #64 (PD-05, mở 31/10) còn lỗi. PD-15, 16 chưa làm. Tuần này làm nhiều nhất nhóm.

**Cần sửa**
1. **PD-17 – HLC không truyền qua HTTP.** TC74 đạt chỉ vì D chạy nhanh. Với D lệch `-30000`, sự kiện vào D đứng trước ra A.
   - [nodes.js:94](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/aggregator-service/src/nodes.js#L94): gửi header `x-hlc: hlc.now()`.
   - Node: có `x-hlc` và `x-internal-key` thì gọi `hlc.update`.
   - Thêm biến thể TC74 lệch `-30000`, xe vào D đi qua Aggregator.
2. **PD-14a (chặn) – `ALTER SYSTEM` lưu vĩnh viễn trong volume** ([configure-sync-a.sh:25](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/postgres/configure-sync-a.sh#L25)). Chạy `ha` một lần rồi quay lại chế độ thường thì `UPDATE` vào A treo vô hạn.
   - Sửa: base compose thêm `-c synchronous_standby_names=''` cho `db-a`, `db-d`; bỏ dòng này trong `ha`.
3. **PD-14a – `docker-compose.ha.yml` lỗi khi thiếu profile** ([:31](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/docker-compose.ha.yml#L31), [:59](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/docker-compose.ha.yml#L59)).
   - Dùng `depends_on … required: false`.
   - Cho `db-d` vào cả profile `ha`.
   - Ghi runbook: dùng `up -d`, không `--wait`.
4. **Nhỏ:**
   - PD-17: comment sai ở [slots.js:275](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/parking-node/src/slots.js#L275); thụt lề sai ở `commands.js:52`.
   - PD-14a: runbook thiếu cách chạy script đo trễ trong container. `rewind.mjs --execute` chưa chạy thật.
   - PD-13: [tc60.pd13.test.mjs:22](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/551bd9af8a5cc366fe9fdd084477050d0661123f/tests/tc60.pd13.test.mjs#L22) viết cứng tên container → dùng `docker compose ps -q`. `docker-compose.pd13.yml` chép lại biến môi trường → dùng `extends`.

5. **PD-05 (PR #64 mới) – TC60 trượt cả 3 lần: failover đo được 7,2–7,7 s, yêu cầu ≤ 5 s.**
   - Con số này chủ yếu là thời gian chạy lệnh `rabbitmqctl list_consumers` qua `docker compose exec`. Trên máy mình mỗi lần gọi mất khoảng 6 s, nên chưa đo đúng thời gian failover.
   - Hàm `waitFor` đặt timeout 5000 ms nhưng một vòng kiểm tra đã dài hơn thế ([tc60.pd05.test.mjs:402](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/044715e/tests/tc60.pd05.test.mjs#L402)).
   - Sửa: đo bằng Management API (`GET :15672/api/consumers/%2F`), hoặc lấy khoảng cách `processed_at` trong `inbox_messages` giữa lệnh cuối của consumer cũ và lệnh đầu của consumer mới.
   - Sau khi PD-13 merge (đã merge), chạy lại với `parking-a-1`/`parking-a-2` như PR ghi.

**Plan test – kết quả mình chạy 01/11**
- ❌ TC74 với `-30000`: sai thứ tự (lỗi 1). PD-17 không đổi từ lần review.
- ❌ Bật `ha` → `down` → `up` không `ha` → ghi vào A treo (lỗi 2).
- ❌ `config -q`:
  - Không profile: lỗi `parking-a depends on undefined service "db-a-sync-config"`.
  - Chỉ `ha`: lỗi `db-d-sync-config depends on undefined service "db-d"`.
  - `ha` + `extra`: đạt.
- ✅ `pg_stat_replication`: A, D `quorum`; B, C `async`.
- PD-05:
  - ✅ TC52, TC53 (PD-02) đạt.
  - ❌ TC60 trượt (lỗi 5).
- ⏸ PD-15 TC71, PD-16 TC72–73: chưa có code.

---

## Trang – 62

PD-18 đã merge. PR #58 (PD-22) không cập nhật từ 24/10. PR #62 (PD-23) có lỗi chặn. PD-06, 20, 21, 25 chưa làm. Lỗi PD-18/22 của tuần trước chưa sửa.

**Cần sửa**
1. **PD-23 (chặn) – không đọc được sự kiện nào.**
   - [enabled_plugins](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/rabbitmq/enabled_plugins#L1) thiếu `rabbitmq_stream`, nên cổng 5552 bị từ chối (`ECONNREFUSED`).
   - `events.stream` chưa có trong `definitions.json`.

   → Bật plugin, merge PD-22 trước, rồi rebase PD-23.
2. **PD-23 – bật mặc định, không có đường lui** ([docker-compose.yml:115](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/docker-compose.yml#L115)). → Đặt `${USE_STATS_SERVICE:-false}`; stats-service lỗi thì dùng lại scatter–gather.
3. **PD-23 – thiếu doanh thu tiền mặt.** Chỉ cộng khi có `PAYMENT_COMPLETED` ([slots.js:178](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/parking-node/src/slots.js#L178)). → Cộng `fee` của `CAR_EXIT` khi trả `CASH`.
4. **PD-23 – sự kiện thanh toán giả dạng `SLOT_UPDATED OCCUPIED`** ([slots.js:261](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/parking-node/src/slots.js#L261)). → Dùng `event_type` riêng, không có `status`/`version`; thụt lề lại.
5. **PD-23 – tin lỗi bị mất vì offset vẫn tăng** ([consumer.js:219](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/stats-service/src/consumer.js#L219)). → Ghi offset cùng giao dịch, lỗi thì đọc lại.
   - Bỏ `console.log` mỗi sự kiện.
   - Nhóm giờ theo `Asia/Ho_Chi_Minh`.
6. **PD-23 – không có test.** → Unit test `processEvent` + e2e so sánh 2 chế độ.
7. **PD-22, PD-18 (còn từ 25/10):**
   - [events.js:103](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5c4cf8245e46ab214cae9b926d1989ea7324c3a9/aggregator-service/src/events.js#L103) thiếu `ch.on('error')`.
   - Replay không có timeout.
   - Chưa có số đo trước/sau.
   - #58 cần rebase.
   - PD-18: LISTEN không nối lại khi DB khởi động lại.

**Plan test – kết quả mình chạy 01/11**
- ❌ PD-18 trên `dev`, 40 sự kiện bãi C, đo `published_at - created_at`:

  | | p50 | p95 | < 20 ms |
  |---|---|---|---|
  | Trước restart | 37 ms | 61 ms | 0% |
  | Sau `restart db-c` | 338 ms | 690 ms | 0% |

  - Sau restart độ trễ tăng gấp 10 lần: LISTEN không nối lại, relay rơi về chế độ quét định kỳ (lỗi 7).
  - Cả trước restart cũng chưa đạt mục tiêu ≥ 95% dưới 20 ms.
- ✅ PD-22: Aggregator khởi động khoảng 2 s khi có `events.stream`. Đã xoá stream thì vẫn khoảng 2 s: log lỗi `404 NOT-FOUND` rồi chạy tiếp.
- ❌ PD-22 e2e 16/17: TC37 lỗi `Cannot read properties of null (reading 'token')` ở cả 2 lần chạy. Trên `dev` TC37 đạt. → Rebase lên `dev` rồi chạy lại.
- ❌ PD-23: `/api/admin/stats` toàn 0 (lỗi 1). Nhánh không đổi từ lần review.
- ⏸ PD-06 TC55, TC59: chưa có code.

---

## Hiệp – 56

PD-12 rebase đạt nhưng chưa có PR. PD-24, PD-26, PD-19 chưa có PR. PD-27 chưa làm.

**Cần sửa**
1. **PD-12 – chưa có PR.** → Mở PR từ `feature/PD-12-six-parking-rebased`, đóng #56.
   - Chưa làm phần ưu tiên gọi bãi cùng `zone`.
   - Bỏ cột `managed_by_etcd` ([schema.sql:24](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/0af30c8920491a7fd18e712ae83943e322cc259b/aggregator-service/src/schema.sql#L24)).
   - `gen-lots.mjs` sinh cả 6 bãi từ một mẫu.
2. **PD-24 – làm trên nhánh PD-03 chưa merge, xung đột 17 file.** → Tạo nhánh mới từ `origin/dev`.
   - Chỉ lấy các file `tracing.js`, `otel-collector.yml`, `docker-compose.tracing.yml`, tài liệu, test từ `1ebd265`.
   - Không đụng `commands.js`, `saga.js`.
3. **PD-26 – chưa duyệt thiết kế, làm trên nhánh tích hợp.**
   - [index.js:21](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/7713dfd26422d3486638c6598ef6be557cc1864f/parking-node/src/index.js#L21) ghi đè `Date.now`, làm lệch hạn JWT và hạn giữ chỗ.
   - `ket-qua-jepsen.md` 1466 dòng, phần lớn là log.

   → Đăng thiết kế lên #44 và chờ duyệt. Tách `tests/jepsen/` ra nhánh mới từ `dev`. Bỏ ghi đè `Date.now`. File kết quả chỉ giữ bảng.
4. **PD-19:** rebase sau khi PD-12 merge.

**Plan test – kết quả mình chạy 01/11**
- ✅ PD-12: e2e `SCALE=1 COORD=1` 21/21.
- ❌ PD-12: chưa có ưu tiên `zone`. `zone` chỉ được lưu ở `discovery.js` và `nodes.js`, không dùng khi chọn thứ tự gọi bãi.
- ⛔ PD-24 TC77: chưa chạy được, vì máy mình không tải được image Jaeger và OTel Collector từ Docker Hub. Hiệp tự chạy và chụp ảnh vào PR.
- PD-26 TC78 (`--seed 42 --nemesis partition --time 120`, 1936 dòng lịch sử): đạt 5/6 bất biến.
  - Đạt: 469 lệnh thành công đều có đúng 1 hiệu ứng; 475 lệnh nhận đều kết thúc; version liên tục; chỉ 1 primary.
  - ❌ Bất biến 4 lỗi: `did not converge within 30s: fetch failed`.
  - Mỗi vòng kiểm tra gọi 18 lần `docker compose exec` nên một vòng đã gần hết 30 s ([checkers.mjs:145](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/7713dfd/tests/jepsen/checkers.mjs#L145)). → Gộp truy vấn mỗi DB thành một lần gọi; ghi rõ bãi nào lỗi `fetch`.
  - Lần chạy đầu RabbitMQ lỗi lúc khởi động (`rabbitmq_prelaunch`) và runner dừng hẳn. → Thêm bước thử lại `up`.
- ⏸ TC79, PD-27 TC80: chưa chạy.

---

## Lưu ý chung

- TC43 viết cứng cổng 3000. Nên đọc từ biến `FRONTEND_URL`.
- Windows: cổng 2379 có thể bị hệ điều hành giữ. Đổi cổng host trong `docker-compose.override.yml`.
- Máy 16 GB: chạy `node --test --test-concurrency=2 test/*.test.js`.
