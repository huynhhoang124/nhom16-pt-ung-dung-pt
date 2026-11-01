# Nhận xét và chấm điểm thành viên – Giai đoạn 2

Nhóm 16 · Cập nhật 01/11/2026 (tuần 25/10 → 01/11) · Người test và nhận xét: Hoàng Văn Huynh

Mỗi lỗi có link tới đúng dòng code trên GitHub, ghim theo commit lúc review. Sửa xong thì đẩy commit mới lên nhánh của mình, không amend, không force-push (riêng Hiệp: xem mục PD-12).

## Bảng điểm

| Thành viên | Điểm 25/10 | Điểm 01/11 | Việc đã vào `dev`/`main` / tổng | Tuần này đã làm |
|---|---|---|---|---|
| Nguyễn Văn Luận | 72 | **77** | 3/5 (PD-09, PD-11, PD-10) – 60% | Sửa đủ 3 lỗi PD-10 → merge |
| Vũ Văn Hùng | 80 | **76** | 2/5 (PD-01, PD-02) – 40% | Không có commit mới |
| Trịnh Kim Loan | 54 | **70** | 1/6 (PD-13) – 17% | PD-17 sửa, PD-13 xong → merge, PD-14a đủ 6 bãi |
| Đỗ Huyền Trang | 66 | **62** | 1/7 (PD-18) – 14% | PD-23 mới (chưa chạy được) |
| Phạm Sỹ Hiệp | 45 | **56** | 0/5 – 0% | PD-12 rebase đạt e2e 6 bãi; PD-24, PD-26 lệch nền |

**Điểm từng việc (100):** đúng yêu cầu issue 30 · chất lượng code và an toàn 25 · test 20 · quy trình 15 · sẵn sàng tích hợp 10. Ngưỡng merge: ≥ 75, không lỗi chặn, test đạt khi chạy lại.

**Điểm thành viên:** 50% chất lượng các việc đã làm + 30% khối lượng so với kế hoạch + 20% quy trình và phối hợp (có phản hồi review hay không).

## Kết quả test lần này

Mỗi nhánh chạy trên Docker với volume riêng, làm mới hoàn toàn.

| Nhánh | Unit (node / aggregator / notification) | Docker | Kết luận |
|---|---|---|---|
| PD-10 `38bc9bc` (Luận) | 69 / 58 / 2 đạt | e2e `coord` 22/22, có TC65, TC66; `docker pause` leader thật: bản kia lên leader sau 5 s | ✅ merge #60 |
| PD-13 `551bd9a` (Loan) | 71 / 55 / 2 đạt | TC60 4/4; tắt `parking-a` → 20/20 request vẫn 200, đặt chỗ ở A thành công | ✅ merge #61 |
| PD-17 `d7fc04c` (Loan) | 72 / 62 / 2 đạt | e2e 18/18, TC74 đạt; **chạy lại với D lệch −30 s thì sai thứ tự** | ❌ sửa 1 lỗi |
| PD-14a `3d53169` (Loan) | 66 / 55 / 2 đạt | A, D `streaming/quorum`; B, C `async`; trễ trung bình A 6,6 ms · B 29 ms · C 29 ms · D 13 ms; **ghi vào A treo vô hạn khi quay lại chế độ thường** | ❌ sửa lỗi chặn |
| PD-12 `0af30c8` (Hiệp) | 66 / 55 / 2, gen-lots 2/2 | e2e `SCALE=1 COORD=1` 21/21 trên 6 bãi, toxiproxy 40 ± 10 ms cho D–F | ✅ đạt, chờ PR |
| PD-23 `e0582be` (Trang) | 66 / 55 / 2 đạt | e2e 17/17; **trang Thống kê trả toàn 0** (stats-service không nối được cổng 5552) | ❌ lỗi chặn |

Bản gộp `dev` = PD-10 + PD-13 (`8a5c257`): unit 74 / 58 / 2; e2e `coord` 22/22; TC60 4/4; e2e `coord` + `ha` đạt TC44, TC48, TC49, TC63–TC67; TC43 chạy tay qua nginx 20/20.

---

## Nguyễn Văn Luận – 77/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-09 etcd, lease discovery | ✅ main | 83 |
| PD-11 Cấu hình động | ✅ main | 82 |
| PD-10 Bầu leader, fencing | ✅ dev (#60) | 80 |
| PD-14b Failover tự động | Nhánh, chưa PR, xung đột với `dev` | 64 |
| PD-07 Saga qua broker | Chưa làm | — |

**Đã làm tuần này:** sửa đủ 3 lỗi PD-10 của lần trước:
- Kiểm fencing nằm trong cùng giao dịch ghi.
- Chỉ tin token khi request có `x-internal-key`.
- Bỏ `fenced-job` rỗng.
- Có test cho cả ba điểm trên.

TC65 và TC66 đạt, `docker pause` thật cũng đạt.

**Lỗi cần sửa**

1. **PD-10: endpoint giả lập pause để lại 2 leader cùng lúc.** [`leader.js:175`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/aggregator-service/src/leader.js#L175) `simulatePause` đặt `activeLease = null`, nên sự kiện `lost` bị bỏ qua ở [`leader.js:119`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/aggregator-service/src/leader.js#L119). Bản cũ giữ `isLeader=true`, token cũ mãi mãi. Đo được sau TC66: bản 1 token 37 và bản 2 token 41 cùng báo `isLeader: true`.
   - Sửa: trong `simulatePause` hẹn `setTimeout(handleLoseLeadership, durationMs)`, hoặc bỏ endpoint và cho TC66 dùng `docker compose pause` như issue ghi.
2. **PD-10: test làm hỏng môi trường HA.** `finally` của TC65/TC66 luôn chạy `stop aggregator-2` ([`e2e.test.mjs:729`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/tests/e2e.test.mjs#L729), [`:786`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/tests/e2e.test.mjs#L786)). Chạy chung với `HA=1` thì TC43 sau đó lỗi vì không còn bản Aggregator thứ hai.
   - Sửa: đầu test kiểm `aggregator-2` đã chạy chưa; chỉ dừng nếu chính test bật nó.
3. **PD-10: mọi request của bản leader đều mang fencing token.** [`nodes.js:91`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/aggregator-service/src/nodes.js#L91) gắn token vào cả đặt chỗ, xe vào/ra của người dùng. Hậu quả:
   - Mọi giao dịch ghi đi qua bản leader đều khoá dòng `fencing('reconcile')` tới khi commit, nên các lệnh ghi xếp hàng nối tiếp nhau.
   - Leader cũ trả `409 STALE_LEADER` cho chính người dùng.

   Sửa: chỉ gắn header khi người gọi truyền `job` (đối soát, khôi phục saga); request của người dùng không mang token.
4. **PD-10: kênh lệnh qua broker chưa kiểm fencing.** Hướng dẫn bước 5 yêu cầu kiểm trong giao dịch xử lý lệnh PD-02. [`parking-node/src/commands.js:85`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/38bc9bcd65520d6dddeb9b019b2b41318f9d609e/parking-node/src/commands.js#L85) mở `BEGIN` nhưng không gọi `checkFencing(c, env.job, env.fencingToken)`.
   - Sửa: gọi ngay sau `BEGIN`, token cũ thì ghi kết quả `409 STALE_LEADER` vào inbox như lỗi nghiệp vụ.
5. **PD-14b: chưa tách lại khỏi PD-10 bản cũ.** Nhánh `088def2` vẫn chứa `0293d31`, `84ee4c8` (PD-10 trước khi sửa): chậm `dev` 10 commit, xung đột 3 file với `dev` và 10 file với PD-10 mới. Tuần này chỉ sửa comment.
   ```bash
   git fetch origin
   git checkout -b feature/PD-14b-v2 origin/dev
   git cherry-pick a613d05 c13fc62 5129966 088def2
   ```
   Khi cherry-pick, bỏ mọi thay đổi ở `fencing.js`, `leader.js`, `app.js` (đã có trên `dev`), giữ `failover-manager/`, `dynamic-pool.js`, `epoch.test.js`. Mở PR vào `dev`.

**Plan test Luận phải tự chạy trước khi báo xong**

| Việc | Lệnh / bước | Đạt khi |
|---|---|---|
| PD-10 sửa | `COORD=1 HA=1 node --test tests/e2e.test.mjs` với `--profile coord --profile ha` | TC65, TC66, TC43, TC44 cùng đạt trong một lượt |
| PD-10 sửa | `docker compose pause aggregator` 15 s rồi `unpause`; gọi `/api/leader` cả 2 bản | Luôn chỉ 1 bản `isLeader: true` |
| PD-14b | TC68: `docker compose stop db-b` | Replica B lên primary trong ≤ 15 s, `/nhom16/parking/B/db/epoch` tăng 1 |
| PD-14b | TC69: bật lại `db-b` cũ, ghi vào B | Node từ chối ghi, `SELECT pg_is_in_recovery()` chỉ đúng 1 primary |
| PD-14b | TC70: `docker compose stop db-a-replica`, ghi vào A | Ghi treo ≤ 3 s rồi chạy tiếp, có log cảnh báo hạ cấp async |
| PD-07 | TC75, TC76 | Saga 3 bãi thành công; bước 3 lỗi → bù trừ; tắt leader giữa bù trừ → leader mới làm tiếp |

---

## Vũ Văn Hùng – 76/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-01 Topology kênh lệnh | ✅ main | 92 |
| PD-02 Inbox ở node | ✅ main | 88 |
| PD-08 Retry, DLQ | PR #49, không cập nhật từ 22/10 | 70 |
| PD-03 Request–reply | PR #52, không cập nhật từ 22/10 | 68 |
| PD-04 Phát lệnh nhiều bãi | PR #53, không cập nhật từ 23/10 | 60 |

**Đã làm tuần này:** không có commit mới. Cả 5 lỗi ở bản nhận xét 25/10 còn nguyên. Điểm giảm 4 vì 9 ngày không phản hồi review.

**Lỗi cần sửa** (giữ nguyên từ 25/10)

1. **PD-08, PD-03, PD-04 nối vào PD-02 bằng file `.patch`.** Rebase từng nhánh lên `dev`, nối hook trực tiếp, xoá các file sau:
   - [`scripts/pd08-pd02-integration.patch`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/c20c084638ac275c439a7f55974e25850d4e4d29/scripts/pd08-pd02-integration.patch), [`parking-node/src/retry-integration.js`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/c20c084638ac275c439a7f55974e25850d4e4d29/parking-node/src/retry-integration.js)
   - [`scripts/pd03-pd02-reply.patch`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/scripts/pd03-pd02-reply.patch)
   - [`scripts/pd04-pd02-integration.patch`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e8dc90ffca0e5efdf03ab0d24d9e5f093086d420/scripts/pd04-pd02-integration.patch), [`scripts/prepare-pd04-candidate.mjs`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e8dc90ffca0e5efdf03ab0d24d9e5f093086d420/scripts/prepare-pd04-candidate.mjs), [`parking-node/src/admin-integration.js`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e8dc90ffca0e5efdf03ab0d24d9e5f093086d420/parking-node/src/admin-integration.js)
2. **PD-03: [`command-flow.js`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/aggregator-service/src/command-flow.js) viết dồn** (dòng dài nhất 221 ký tự). Viết lại cho dễ đọc như `commands.js` của PD-01.
3. **PD-03: đổi mặc định sang `broker`** ở [`routes.js:10`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/aggregator-service/src/routes.js#L10), [`index.js:50`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/aggregator-service/src/index.js#L50), [`docker-compose.yml:27`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/docker-compose.yml#L27), [`:97`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/docker-compose.yml#L97). Để mặc định `http` tới khi e2e chế độ broker chạy trong CI.
4. **PD-02:** [`command-replies.js:76`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/command-replies.js#L76) gặp phản hồi không có queue nhận thì `break`, cả hàng đợi phản hồi kẹt.
   - Sửa: đánh dấu tin đó rồi đi tiếp.

   [`commands.js:151`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/commands.js#L151) bãi chưa có queue thì cứ 5 s reconnect và ghi log lỗi một lần.
   - Sửa: gặp 404 thì ghi log một lần rồi tăng dần thời gian chờ, tối đa 60 s.
5. **Quy trình:** 3 PR chờ (quy định tối đa 2). Chuyển #52, #53 sang Draft tới khi #49 merge. Đăng nửa trang thiết kế PD-03 lên #20.

**Plan test Hùng phải tự chạy trước khi báo xong**

| Việc | Lệnh / bước | Đạt khi |
|---|---|---|
| PD-08 | TC57: đặt `FAIL_FIRST_N=2` ở node hoặc `docker compose stop db-a` 5 s | Lệnh thử lại theo độ trễ tăng dần rồi thành công, không trùng |
| PD-08 | TC58: gửi tin sai schema từ RabbitMQ Management | Tin vào `cmd.dead`, thấy trên trang Quản trị, sửa rồi đẩy lại được |
| PD-03 | TC51: đặt chỗ với `COMMAND_MODE=broker` | Trả 201 trong 3 s, tin có `correlationId` |
| PD-03 | TC54: `docker compose stop parking-a` 5 s rồi `start` | Lệnh chờ trong queue được xử lý, kết quả tới qua Socket.IO |
| PD-03 | TC62: gửi lệnh rồi `docker compose stop aggregator` trước khi có phản hồi | `GET /api/commands/:id` trên `aggregator-2` trả đúng kết quả |
| PD-04 | TC61: tắt bãi F trước khi phát lệnh 3 bãi | Kết quả 2/3; bật F trong 10 phút thì F áp dụng |
| Tất cả | `node --test tests/e2e.test.mjs` trên `dev` mới nhất | Không làm đỏ test cũ |

---

## Trịnh Kim Loan – 70/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-13 Hai bản node | ✅ dev (#61) | 80 |
| PD-17 HLC | PR #55, chưa merge | 72 |
| PD-14a Bản sao DB 6 bãi | PR #63, chưa merge (lỗi chặn) | 68 |
| PD-05, 15, 16 | Chưa làm | — |

**Đã làm tuần này:** nhiều nhất nhóm.
- **PD-17:** sửa đủ 2 lỗi cũ (giữ công thức hash PD-02; lưu `hlc` vào `parking_sessions`).
- **PD-13:**
  - Tách `scheduled-lock.js`, kèm unit test và TC60.
  - Compose cho 2 bản node mỗi bãi.
  - Test thật: tắt một bản thì bản kia giữ khoá và phục vụ.
- **PD-14a:**
  - Đủ A–F.
  - `wal_log_hints`, A/D đồng bộ.
  - Script `rewind.mjs` có `--check`/`--dry-run`.
  - Runbook dài.

**Lỗi cần sửa**

1. **PD-17: HLC không truyền qua HTTP nên chưa đạt mục tiêu "sắp đúng khi đồng hồ lệch".** TC74 đạt chỉ vì D chạy nhanh hơn 30 s ([`docker-compose.hlc-test.yml:4`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/docker-compose.hlc-test.yml#L4)): kể cả không có HLC thì thứ tự vẫn đúng. Mình chạy lại với `CLOCK_SKEW_MS=-30000`: ra A `1793481838693-0000`, vào D `1793481809380-0000`, nghĩa là **vào D đứng trước ra A**. Aggregator đã nhận HLC của sự kiện ra A ([`events.js`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/aggregator-service/src/events.js) gọi `hlc.update`) nhưng không gửi sang node khi gọi HTTP.
   - Sửa: [`aggregator-service/src/nodes.js:94`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/aggregator-service/src/nodes.js#L94) thêm header `'x-hlc': hlc.now()`.
   - Sửa: `parking-node/src/app.js` thêm middleware: có `x-hlc` hợp lệ (và có `x-internal-key`) thì `hlc.update(req.get('x-hlc'))` trước khi xử lý.
   - Sửa: thêm biến thể TC74 với D lệch `-30000`, xe vào D đi qua Aggregator (`POST /api/parkings/D/slots/:code/enter`) thay vì `barrier.mjs` gọi thẳng node.
2. **PD-17 (nhỏ):**
   - [`slots.js:275`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/parking-node/src/slots.js#L275): comment còn ghi "HLC lấy từ sự kiện CAR_ENTER", nhưng code đã đọc cột `ps.hlc`.
   - [`slots.js:33`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/parking-node/src/slots.js#L33): thiếu dấu cách ở `plate,extra`.
   - [`commands.js:52`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/d7fc04c2ee42caa9a04b0f5a51b2644aba7dd56c/parking-node/src/commands.js#L52): `return` thụt lệch 2 dấu cách.
3. **PD-14a (lỗi chặn): chế độ đồng bộ lưu vĩnh viễn trong volume.** [`configure-sync-a.sh:25`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/postgres/configure-sync-a.sh#L25) dùng `ALTER SYSTEM`, giá trị ghi vào `postgresql.auto.conf` của `db-a`. Đã thử:
   - Chạy `--profile ha` một lần.
   - Bật lại stack thường (không có replica).
   - Kết quả: `show synchronous_standby_names` vẫn là `ANY 1 ("db-a-replica")`; `UPDATE` vào DB A treo vô hạn, `statement_timeout` không cắt được.

   Ai trong nhóm từng chạy `ha` sẽ gặp bãi A "đơ" mà không biết vì sao. Sửa (chọn một):
   - Base `docker-compose.yml` thêm `-c synchronous_standby_names=''` cho `db-a`, `db-d` (tham số dòng lệnh ưu tiên hơn `postgresql.auto.conf`). Trong `docker-compose.ha.yml` bỏ dòng đó đi để `ALTER SYSTEM` có hiệu lực.
   - Hoặc thêm service một lần ở chế độ thường chạy `ALTER SYSTEM RESET synchronous_standby_names; SELECT pg_reload_conf();`.
4. **PD-14a: `docker-compose.ha.yml` không chạy được nếu thiếu profile.**
   - Không bật `--profile ha`: `parking-a` phụ thuộc `db-a-sync-config` chưa định nghĩa ([`docker-compose.ha.yml:31`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/docker-compose.ha.yml#L31)).
   - Bật `ha` mà không bật `extra`: `db-d-replica` phụ thuộc `db-d` chưa định nghĩa ([`:59`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/docker-compose.ha.yml#L59)).
   - Sửa: dùng `depends_on: { db-a-sync-config: { condition: service_completed_successfully, required: false } }`; cho `db-d` vào cả profile `ha`.
   - Ghi chú: `up --wait` báo lỗi vì 2 service `*-sync-config` chạy xong thì thoát. Ghi vào runbook là dùng `up -d` không kèm `--wait`, hoặc kiểm bằng `docker compose ps`.
5. **PD-14a (nhỏ):**
   - [`do-tre-ban-sao-pd14a.mjs:6`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/3d5316980580ebae7f45d3474a20cda5df29b821/scripts/do-tre-ban-sao-pd14a.mjs#L6) chỉ chạy được bên trong container (`/app/package.json`), chưa có hướng dẫn. Thêm vào runbook: `docker compose cp scripts/do-tre-ban-sao-pd14a.mjs parking-a:/tmp/d.mjs && docker compose exec parking-a node /tmp/d.mjs A 20`.
   - `rewind.mjs --execute` chưa chạy thật (PR có ghi). Chạy một lần trên volume thử rồi ghi kết quả vào PR.
6. **PD-13 (đã merge, sửa sau):**
   - [`tc60.pd13.test.mjs:22`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/551bd9af8a5cc366fe9fdd084477050d0661123f/tests/tc60.pd13.test.mjs#L22) viết cứng tên container `nhom16-parking-…`, đặt `COMPOSE_PROJECT_NAME` khác là hỏng. Lấy tên bằng `docker compose ps -q <service>`.
   - [`docker-compose.pd13.yml:16`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/551bd9af8a5cc366fe9fdd084477050d0661123f/docker-compose.pd13.yml#L16) chép lại toàn bộ biến môi trường; dùng `extends: { file: docker-compose.yml, service: parking-a }`.
   - [`index.js:161`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/551bd9af8a5cc366fe9fdd084477050d0661123f/parking-node/src/index.js#L161) khối shutdown thụt lệch 2 dấu cách.

**Plan test Loan phải tự chạy trước khi báo xong**

| Việc | Lệnh / bước | Đạt khi |
|---|---|---|
| PD-17 | `HLC_TEST=1 node --test tests/e2e.test.mjs` với D lệch `+30000` và `-30000` | TC74 đạt cả hai chiều |
| PD-14a | `--profile ha --profile extra up -d`, sau đó `down` (không `-v`), sau đó `up -d` không `ha`, rồi đặt chỗ ở A | Đặt chỗ ở A trả 201, không treo |
| PD-14a | `docker compose -f docker-compose.yml -f docker-compose.ha.yml config -q` (không profile) | Không lỗi |
| PD-14a | Trên primary A, D: `SELECT application_name, sync_state FROM pg_stat_replication` | `quorum` (A, D), `async` (B, C, E, F) |
| PD-05 | TC60 + gửi 100 lệnh cùng slot khi chạy 2 bản node | Lệnh xử lý đúng thứ tự gửi (SAC), không đặt trùng |
| PD-15 | TC71: trên replica `ALTER SYSTEM SET recovery_min_apply_delay='2s'`, đặt chỗ rồi đọc ngay | Vẫn thấy chỗ vừa đặt |
| PD-16 | TC72, TC73 | Người dùng chia đúng phân mảnh; tắt 1 phân mảnh, người ở phân mảnh kia vẫn đăng nhập được |

---

## Đỗ Huyền Trang – 62/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-18 Relay LISTEN/NOTIFY | ✅ main | 79 |
| PD-22 Replay events.stream | PR #58, không cập nhật từ 24/10 | 70 |
| PD-23 Thống kê CQRS | PR #62, chưa merge (lỗi chặn) | 52 |
| PD-06, 20, 21, 25 | Chưa làm | — |

**Đã làm tuần này:** PD-23 mới: service `stats-service`, DB `db-stats`, bảng `stats_hourly`, lưu offset, trang Stats đổi sang hiển thị vào/ra. Chưa sửa các lỗi PD-18 và PD-22 của lần trước.

**Lỗi cần sửa**

1. **PD-23 (lỗi chặn): service không đọc được sự kiện nào.** Hai nguyên nhân:
   - [`rabbitmq/enabled_plugins:1`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/rabbitmq/enabled_plugins#L1) chưa bật `rabbitmq_stream`, nên cổng 5552 không mở. Log stats-service: `ECONNREFUSED … port: 5552`.
   - Stream `events.stream` chưa có trong `definitions.json` (thuộc PD-22, chưa merge).

   Đã thử với 39 phiên gửi xe trên 3 bãi: `/api/admin/stats` trả toàn 0.
   - Sửa: thêm `rabbitmq_stream` vào `enabled_plugins`.
   - Sửa: merge PD-22 trước (nhớ thêm `events.stream` vào `definitions.json`), rồi rebase PD-23 lên.
2. **PD-23: bật mặc định và không có đường lui.** [`docker-compose.yml:115`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/docker-compose.yml#L115) đặt cứng `USE_STATS_SERVICE: "true"`; stats-service lỗi thì trả `503` ([`sessions-routes.js:160`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/aggregator-service/src/sessions-routes.js#L160)). Issue ghi "giữ đường cũ sau cờ".
   - Sửa: `USE_STATS_SERVICE: ${USE_STATS_SERVICE:-false}`.
   - Sửa: khi stats-service lỗi thì rơi về scatter–gather cũ.
3. **PD-23: doanh thu thu tiền mặt không được tính.** Consumer chỉ cộng doanh thu khi gặp `PAYMENT_COMPLETED`. Sự kiện này chỉ phát trong `payIn` (trả online). Xe ra trả tiền mặt cập nhật `paid_at` trong `moveSlot` ([`slots.js:178`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/parking-node/src/slots.js#L178)) mà không phát sự kiện thanh toán. Như vậy không thể "khớp với scatter–gather" theo tiêu chí Xong khi.
   - Sửa: consumer cộng `fee` của sự kiện `CAR_EXIT` khi `paymentMethod === 'CASH'`, hoặc phát thêm sự kiện thanh toán ở nhánh tiền mặt.
4. **PD-23: sự kiện thanh toán giả dạng `SLOT_UPDATED`.** [`slots.js:261`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/parking-node/src/slots.js#L261) gọi `emit` với `status 'OCCUPIED'`, `version 0`.
   - Aggregator mới khởi động (cache trống) sẽ ghi slot thành `OCCUPIED` dù xe đã ra.
   - Khối từ [`:250`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/parking-node/src/slots.js#L250) thụt sát lề, lệch hẳn với hàm.
   - Sửa: ghi sự kiện riêng (`event_type 'PAYMENT_COMPLETED'`, không có `status`/`version`), cho `applyEvent` bỏ qua sự kiện không có `version`, thụt lề lại.
5. **PD-23: consumer bỏ sót sự kiện lỗi.** Lỗi ở một tin chỉ ghi log ([`consumer.js:226`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/stats-service/src/consumer.js#L226)); tin sau đó vẫn đẩy offset lên `GREATEST` ([`:219`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/stats-service/src/consumer.js#L219)), nên tin lỗi mất vĩnh viễn.
   - Sửa: ghi offset trong cùng giao dịch với `stats_processed_events`; lỗi thì dừng consumer và đọc lại từ offset cũ.
   - Bỏ [`console.log` mỗi sự kiện](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/stats-service/src/consumer.js#L21).
   - [`index.js:45`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e0582be16c384cbb46647fb336021a4f7ec2cb1a/stats-service/src/index.js#L45) nhóm giờ theo UTC; đường cũ nhóm theo giờ của DB bãi. Thống nhất `Asia/Ho_Chi_Minh`.
6. **PD-23: không có test nào cho stats-service.** Thêm unit test `processEvent` (vào, ra, trả online, trả tiền mặt, tin trùng) và một test e2e so `/api/admin/stats` giữa 2 chế độ.
7. **PD-22, PD-18 (còn từ 25/10, chưa sửa):**
   - [`events.js:103`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5c4cf8245e46ab214cae9b926d1989ea7324c3a9/aggregator-service/src/events.js#L103) thiếu `ch.on('error')`.
   - [`events.js:80`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5c4cf8245e46ab214cae9b926d1989ea7324c3a9/aggregator-service/src/events.js#L80) replay không có timeout, nên `sagas.recover()` có thể không bao giờ chạy.
   - PD-22 chưa có số đo trước/sau.
   - PR #58 xung đột `aggregator-service/src/index.js` với `dev`, cần rebase.
   - PD-18 [`index.js:89`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/index.js#L89) LISTEN không nối lại khi DB khởi động lại.

**Plan test Trang phải tự chạy trước khi báo xong**

| Việc | Lệnh / bước | Đạt khi |
|---|---|---|
| PD-18 | `docker compose restart db-c`, rồi đo 40 sự kiện bãi C như lần trước | ≥ 95% dưới 20 ms |
| PD-22 | Đo thời gian khởi động Aggregator và `http_request_duration_seconds_count{route="/api/slots"}` của 3 node, có/không replay | Có bảng số liệu; TC10 đạt |
| PD-22 | Xoá `events.stream` rồi khởi động Aggregator | Khởi động xong trong ≤ 10 s, saga vẫn được khôi phục |
| PD-23 | `node scripts/du-lieu-mau.mjs 150`, gọi `/api/admin/stats` với `USE_STATS_SERVICE=true` rồi `false` | Lượt vào/ra, doanh thu, theo giờ khớp nhau |
| PD-23 | `docker compose restart stats-service` giữa lúc sinh dữ liệu | Không đếm trùng, không thiếu |
| PD-06 | TC55, TC59 | Tắt bãi 20 s → lệnh `EXPIRED`; `x-max-length` nhỏ → 503, không mất lệnh |

---

## Phạm Sỹ Hiệp – 56/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-12 Mở rộng 6 bãi, 2 vùng | Nhánh `PD-12-six-parking-rebased` đạt, **chưa có PR** | 76 |
| PD-24 OpenTelemetry + Jaeger | Nhánh, chưa PR, lệch nền | 50 |
| PD-26 Kiểm thử kiểu Jepsen | Nhánh, chưa PR, chưa duyệt thiết kế | 42 |
| PD-19 Aggregator theo vùng | Nhánh, chưa PR | 48 |
| PD-27 Đo trước/sau | Chưa làm | — |

**Đã làm tuần này:**
- PD-12 rebase đúng cách: 1 commit sạch trên `dev`, bỏ PD-09 cũ. e2e chạy được trên 6 bãi (21/21), toxiproxy liên vùng hoạt động.
- Bắt đầu PD-24 và PD-26, nhưng làm trên nền sai.

**Lỗi cần sửa**

1. **PD-12: chưa đưa nhánh đã rebase vào PR.** PR #56 vẫn trỏ nhánh cũ đang xung đột.
   - Sửa: mở PR mới từ `feature/PD-12-six-parking-rebased` vào `dev`, đóng #56.
   - Thêm còn thiếu so với hướng dẫn bước 4: Aggregator **ưu tiên gọi bãi cùng vùng** (đã lưu `zone` nhưng chưa dùng ở đâu).
   - [`schema.sql:24`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/0af30c8920491a7fd18e712ae83943e322cc259b/aggregator-service/src/schema.sql#L24) cột `managed_by_etcd` không dùng ở đâu, bỏ đi.
   - [`gen-lots.mjs:7`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/0af30c8920491a7fd18e712ae83943e322cc259b/scripts/gen-lots.mjs#L7) chỉ sinh D–F, còn A–C viết tay ở [`:60`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/0af30c8920491a7fd18e712ae83943e322cc259b/scripts/gen-lots.mjs#L60). Cho cả 6 bãi vào `LOTS` và sinh từ một mẫu.
   - Ghi chú: service `region-latency` chạy xong thì thoát, nên `docker compose up --wait` báo lỗi. Ghi vào README là dùng `up -d`.
2. **PD-24: làm trên nhánh PD-03 của Hùng (chưa merge), chậm `dev` 57 commit.** Commit [`1ebd265`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/commit/1ebd265ec122f3fcbf8d934516c18f46d5869d2e):
   - Chép lại cả `parking-node/src/commands.js` (+299 dòng) và `command-replies.js` (+151) của PD-02/PD-03.
   - Sửa `saga.js` 160 dòng.
   - Xung đột 17 file với `dev`.
   ```bash
   git fetch origin
   git checkout -b feature/PD-24-v2 origin/dev
   git checkout 1ebd265 -- aggregator-service/src/tracing.js parking-node/src/tracing.js notification-service/src/tracing.js observability/otel-collector.yml docker-compose.tracing.yml tai-lieu/pd-24-tracing.md tests/pd24-tracing.e2e.mjs
   ```
   Sau đó tự thêm lại phần nối tracing vào `relay.js`, `events.js`, `log.js`, `Dockerfile` trên code của `dev`. Không đụng `commands.js`, `saga.js`. Làm trước chặng HTTP → DB → outbox → AMQP → Socket.IO; chặng lệnh thêm sau khi PD-03 merge.
3. **PD-26: việc khó nhưng chưa có thiết kế trên issue #44, và làm trên nhánh tích hợp.** Nhánh merge cả PD-12 cũ, PD-14b, PD-03 (đều chưa merge) nên không review hay merge được.
   - [`parking-node/src/index.js:21`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/7713dfd26422d3486638c6598ef6be557cc1864f/parking-node/src/index.js#L21) ghi đè `Date.now` toàn tiến trình. Việc này làm lệch cả hạn JWT, hạn giữ chỗ, và trùng với `CLOCK_SKEW_MS` của PD-17.
   - [`commands.js:11`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/7713dfd26422d3486638c6598ef6be557cc1864f/parking-node/src/commands.js#L11) cần `reply-envelope.js` không có trên `dev`.
   - `tai-lieu/ket-qua-jepsen.md` dài 1466 dòng, phần lớn là log build Docker (16 lượt FAIL, 4 PASS).
   - Sửa:
     - Đăng nửa trang thiết kế lên #44 (6 bất biến, nemesis nào chạy được ngay, nemesis nào chờ PD-14b) và chờ duyệt.
     - Tách `tests/jepsen/` ra nhánh mới từ `dev`, chỉ chạy nemesis không cần PD-14b (phân hoạch Bắc|Nam, cô lập 1 nút RabbitMQ, mất 20% gói).
     - Bỏ ghi đè `Date.now`.
     - `ket-qua-jepsen.md` chỉ giữ bảng kết quả.
4. **PD-19:** giữ như 25/10. Rebase sau khi PD-12 merge; chưa mở PR trước đó.

**Plan test Hiệp phải tự chạy trước khi báo xong**

| Việc | Lệnh / bước | Đạt khi |
|---|---|---|
| PD-12 | `node scripts/gen-lots.mjs`, `docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile scale --profile coord up -d`, `SCALE=1 COORD=1 node --test tests/e2e.test.mjs` | Đạt hết (lần này 21/21) |
| PD-12 | Aggregator `ZONE=bac` tra cứu `/api/parkings/availability` | Gọi A–C trước, D–F sau (log thứ tự gọi) |
| PD-24 | TC77: đặt chỗ một lần, mở Jaeger `localhost:16686` | Một trace đủ HTTP → AMQP → DB → outbox → AMQP → Socket.IO; chụp ảnh vào PR |
| PD-26 | TC78: `node tests/jepsen/run.mjs --seed 42 --nemesis partition --time 120` | 6 bất biến đạt, in seed để chạy lại được |
| PD-26 | TC79: cô lập 1 nút RabbitMQ dưới tải | Không mất lệnh đã confirm |
| PD-27 | TC80: k6 300 người dùng ảo, một bãi chậm 1,5 s | Có bảng trước/sau: tỉ lệ 504 về 0, p95 trong ngưỡng |

---

## Việc chung

- TC43 viết cứng `localhost:3000`; máy có dịch vụ khác giữ cổng 3000 sẽ lỗi giả. Nên đọc từ biến `FRONTEND_URL`.
- Trên Windows cổng 2379 của etcd-1 có thể nằm trong dải bị hệ điều hành giữ (`netsh int ipv4 show excludedportrange protocol=tcp`). Gặp lỗi `bind: … forbidden` thì đổi cổng host trong `docker-compose.override.yml`.
- `node --test` mặc định chạy song song theo số nhân CPU, mỗi file test dùng pglite khoảng 900 MB RAM. Máy 16 GB nên chạy `node --test --test-concurrency=2 test/*.test.js`.
