# Nhận xét và chấm điểm thành viên – Giai đoạn 2

Nhóm 16 · Cập nhật 25/10/2026 · Người test và nhận xét: Hoàng Văn Huynh

Mỗi lỗi dưới đây có link tới đúng dòng code trên GitHub, ghim theo commit lúc review. Sửa xong thì đẩy commit mới lên nhánh của mình, không amend, không force-push.

## Bảng điểm

| Thành viên | Điểm | Việc đã vào `main` / tổng | Việc có code | Tiến độ tuần (mục tiêu 30–50%) |
|---|---|---|---|---|
| Vũ Văn Hùng | **80** | 2/5 (PD-01, PD-02) | 5/5 | 40% – đạt |
| Nguyễn Văn Luận | **72** | 2/5 (PD-09, PD-11) | 4/5 | 40% – đạt |
| Đỗ Huyền Trang | **66** | 1/7 (PD-18) | 2/7 | 14% – chưa đạt |
| Trịnh Kim Loan | **54** | 0/6 | 3/6 | 0% – chưa đạt |
| Phạm Sỹ Hiệp | **45** | 0/5 | 2/5 | 0% – chưa đạt |

**Điểm từng việc (100):** đúng yêu cầu issue 30 · chất lượng code và an toàn 25 · test 20 · quy trình (PR theo mẫu, duyệt thiết kế, tối đa 2 PR chờ) 15 · sẵn sàng tích hợp 10. Ngưỡng merge: ≥ 75, không lỗi chặn, test đạt khi chạy lại.

**Điểm thành viên:** 50% chất lượng các việc đã làm + 30% khối lượng so với kế hoạch + 20% quy trình và phối hợp.

**Kết quả test lần này** (dev + PD-09 + PD-11 + PD-18, Docker volume mới): unit node 66, aggregator 55, notification 2 đều đạt; e2e chế độ mặc định 16/16; e2e bật `coord` + `ha` 22 đạt (TC43 chạy tay qua nginx 20/20); CI của PR #59 xanh cả test, frontend, e2e.

---

## Vũ Văn Hùng – 80/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-01 Topology kênh lệnh | ✅ main | 92 |
| PD-02 Inbox ở node | ✅ main | 88 |
| PD-08 Retry, DLQ | PR #49, chưa merge | 70 |
| PD-03 Request–reply | PR #52, chưa merge | 68 |
| PD-04 Phát lệnh nhiều bãi | PR #53, chưa merge | 60 |

**Điểm mạnh:** làm nhanh và chắc nhất nhóm; PD-01/PD-02 có transaction đúng, HMAC, test e2e thật (TC52, TC53, TC56), tài liệu bằng chứng đầy đủ.

**Lỗi cần sửa**

1. **PD-08, PD-03, PD-04 nối vào PD-02 bằng file `.patch` thay vì code thật.** PD-02 đã ở `dev`, cần rebase từng nhánh lên `dev`, nối hook trực tiếp, xoá các file sau:
   - PD-08: [`scripts/pd08-pd02-integration.patch`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/c20c084638ac275c439a7f55974e25850d4e4d29/scripts/pd08-pd02-integration.patch), [`parking-node/src/retry-integration.js`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/c20c084638ac275c439a7f55974e25850d4e4d29/parking-node/src/retry-integration.js)
   - PD-03: [`scripts/pd03-pd02-reply.patch`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/scripts/pd03-pd02-reply.patch)
   - PD-04: [`scripts/pd04-pd02-integration.patch`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e8dc90ffca0e5efdf03ab0d24d9e5f093086d420/scripts/pd04-pd02-integration.patch), [`scripts/prepare-pd04-candidate.mjs`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e8dc90ffca0e5efdf03ab0d24d9e5f093086d420/scripts/prepare-pd04-candidate.mjs), [`parking-node/src/admin-integration.js`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/e8dc90ffca0e5efdf03ab0d24d9e5f093086d420/parking-node/src/admin-integration.js)
2. **PD-03: code viết dồn, khó đọc.** [`aggregator-service/src/command-flow.js`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/aggregator-service/src/command-flow.js) bỏ hết khoảng trắng, nhiều lệnh trên một dòng (dòng dài nhất 221 ký tự), khác hẳn phong cách repo. Viết lại cho dễ đọc như `commands.js` của PD-01.
3. **PD-03: đổi mặc định sang broker** → đổi hành vi API đặt/huỷ/trả tiền của cả nhóm:
   - [`aggregator-service/src/routes.js:10`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/aggregator-service/src/routes.js#L10) `commandMode = 'broker'`
   - [`aggregator-service/src/index.js:50`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/aggregator-service/src/index.js#L50) `env('COMMAND_MODE','broker')`
   - [`docker-compose.yml:27`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/docker-compose.yml#L27), [`:97`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/fd9d78131c02b31a11838114997cc7856bbd3d45/docker-compose.yml#L97) `${COMMAND_MODE:-broker}`

   Để mặc định `http` tới khi e2e chế độ broker chạy trong CI.
4. **PD-02 (đã merge, sửa nhỏ):** [`parking-node/src/command-replies.js:76`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/command-replies.js#L76) gặp phản hồi không có queue nhận thì `break` → cả hàng đợi phản hồi kẹt ở tin đó (trên dev chưa có queue `agg.<id>`). Merge PD-03 sẽ hết; hoặc đánh dấu tin không route được rồi đi tiếp. [`parking-node/src/commands.js:151`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/commands.js#L151) bãi chưa có queue `cmd.D/E/F` sẽ reconnect và ghi log lỗi mỗi 5 s.
5. **Quy trình:** đang để 3 PR chờ (#49, #52, #53; quy định tối đa 2). PD-02, PD-03 là việc khó nhưng #19, #20 không có thiết kế được duyệt trước.

**Tuần tới:** rebase PD-08 → merge; viết lại PD-03 dễ đọc, mặc định `http`, đăng thiết kế lên #20.

---

## Nguyễn Văn Luận – 72/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-09 etcd, lease discovery | ✅ dev → main (#59) | 83 |
| PD-11 Cấu hình động | ✅ dev → main (#59) | 82 |
| PD-10 Bầu leader, fencing | Nhánh, chưa PR | 56 |
| PD-14b Failover tự động | Nhánh, chưa PR | 66 |
| PD-07 Saga qua broker | Chưa làm (tuần M4) | — |

**Điểm mạnh:** sửa đủ 7 điểm review PD-09 trong chưa tới một ngày; thiết kế #27, #32 đăng lại đầy đủ và trả lời đúng các câu hỏi (thứ tự CAS → chờ → promote, kiểm epoch trong transaction, đánh đổi sync/async).

**Lỗi cần sửa**

1. **PD-10: kiểm fencing nằm ngoài transaction ghi.** [`parking-node/src/app.js:59-63`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/84ee4c8156d05c75b8313460547da83f2547b490/parking-node/src/app.js#L59-L63) middleware gọi `checkFencing(pool, …)` (tự commit) rồi `next()`. Leader cũ có thể qua bước kiểm rồi mới bị thay → vẫn ghi được. Đúng khe hở thiết kế #27 hứa tránh. Sửa: truyền client transaction vào từng thao tác ghi của job và chạy câu ở [`fencing.js:21`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/84ee4c8156d05c75b8313460547da83f2547b490/parking-node/src/fencing.js#L21) trong cùng `BEGIN … COMMIT` với lệnh ghi.
2. **PD-10: nhân viên bãi chặn được leader.** Middleware ở [`app.js:59`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/84ee4c8156d05c75b8313460547da83f2547b490/parking-node/src/app.js#L59) chạy sau bước xác thực [`app.js:45`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/84ee4c8156d05c75b8313460547da83f2547b490/parking-node/src/app.js#L45), mà bước đó cho nhân viên có JWT gọi GET. Gửi `x-fencing-token: 999999999` là `max_token` tăng vọt, leader thật bị `STALE_LEADER`. Chỉ đọc token khi request có `x-internal-key`.
3. **PD-10:** [`app.js:74`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/84ee4c8156d05c75b8313460547da83f2547b490/parking-node/src/app.js#L74) `/api/internal/fenced-job` có transaction nhưng không làm việc gì — bỏ hoặc nối vào job thật.
4. **PD-14b:** [`failover-manager/src/manager.js:3`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5129966156b31946dbf93e7e1bbd736316cf85e1/failover-manager/src/manager.js#L3) comment đầu file còn ghi thứ tự cũ (promote trước, CAS sau), ngược với code — sửa cho khớp.
5. **PD-09 (đã merge):** [`tests/e2e.test.mjs:593`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/tests/e2e.test.mjs#L593) TC63 sát ngưỡng 2 s, máy chậm từng ra 2,65 s.
6. **Quy trình:** lần đầu báo đã mở PR khi chưa có; thiết kế lần đầu bị cắt cụt và còn dấu `[cite]`. Các nhánh PD-11 → PD-10 → PD-14b xếp chồng nên mỗi lần sửa phải merge dây chuyền.

Hai điểm "làm tiếp" của PD-11 (`reserveTimeoutMs`, `healthIntervalMs` chưa đổi động) đã được sửa ở commit `72c9d70` theo review Codex trên PR #59.

**Tuần tới:** sửa lỗi 1, 2 của PD-10 rồi mở PR; sửa lỗi 4 rồi mở PR PD-14b.

---

## Đỗ Huyền Trang – 66/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-18 Relay LISTEN/NOTIFY, SKIP LOCKED | ✅ dev → main (#59) | 79 |
| PD-22 Replay events.stream | PR #58, chưa merge | 70 |
| PD-06, 20, 21, 23, 25 | Chưa làm | — |

**Điểm mạnh:** mô tả PR tốt nhất nhóm (có số đo, nói rõ phần chưa kiểm được). PD-18 đạt tiêu chí: đo 40 sự kiện ở bãi A, 100% dưới 20 ms, trung bình 9,4 ms.

**Lỗi cần sửa**

1. **PD-18 (đã merge): LISTEN không nối lại khi DB khởi động lại.** [`parking-node/src/index.js:89`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/index.js#L89) chỉ ghi log lỗi; client tạo một lần ở [`:93`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/index.js#L93). Đo ở bãi C sau khi restart DB: 0/40 dưới 20 ms, trung bình 257 ms (rơi về quét 500 ms). Sửa: khi `error`/`end` thì tạo Client mới, `LISTEN outbox` lại, backoff 1–5 s.
2. **PD-18:** [`index.js:100`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/72c9d70a929d7de33263f2f18710d281ae81b3e0/parking-node/src/index.js#L100) ghi log info cho mỗi NOTIFY — quá ồn khi tải cao, bỏ hoặc đổi sang debug.
3. **PD-22: channel đọc stream không bắt lỗi.** [`aggregator-service/src/events.js:103`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5c4cf8245e46ab214cae9b926d1989ea7324c3a9/aggregator-service/src/events.js#L103) tạo channel mà không có `ch.on('error')` (chỉ có `conn.on('error')` ở dòng 101). Server đóng channel (queue thiếu, đổi leader stream) sẽ phát `error` không ai bắt.
4. **PD-22: replay có thể treo mãi.** [`events.js:80`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5c4cf8245e46ab214cae9b926d1989ea7324c3a9/aggregator-service/src/events.js#L80) Promise chỉ xong khi gặp marker ([`:121`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5c4cf8245e46ab214cae9b926d1989ea7324c3a9/aggregator-service/src/events.js#L121)). Mất marker thì [`index.js:110-111`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5c4cf8245e46ab214cae9b926d1989ea7324c3a9/aggregator-service/src/index.js#L110-L111) không chạy → **`sagas.recover()` không bao giờ được gọi**. Thêm timeout (ví dụ 10 s) rồi tiếp tục khởi động.
5. **PD-22:** chưa có số đo trước/sau theo "Xong khi" (thời gian khởi động, số request tới bãi). [`index.js:89`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/5c4cf8245e46ab214cae9b926d1989ea7324c3a9/aggregator-service/src/index.js#L89) thụt lề lệch.
6. **Tiến độ:** tới 24/10 mới có commit đầu tiên; còn 5 việc chưa bắt đầu.

**Tuần tới:** sửa lỗi 3, 4 của PD-22 để merge; sửa lỗi 1 của PD-18; bắt đầu PD-23.

---

## Trịnh Kim Loan – 54/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-17 HLC | PR #55, chưa merge | 66 |
| PD-14a Bản sao DB | Nhánh, chưa PR | 45 |
| PD-13 Hai bản node | Nhánh, chưa PR | 32 |
| PD-05, 15, 16 | Chưa làm | — |

**Điểm mạnh:** thuật toán HLC đúng (gửi/nhận, tràn bộ đếm), có TC74 và unit test. PD-14a mới thêm `init-primary.sh` chạy lại được nhiều lần và script đo độ trễ `scripts/do-tre-ban-sao.mjs` đúng tiêu chí "Xong khi".

**Lỗi cần sửa**

1. **PD-17: tự đổi công thức chống trùng của PD-02.** [`parking-node/src/commands.js:95-98`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/55ea917b9fef7f46011dd4aaaead27e1602b4f6e/parking-node/src/commands.js#L95-L98) bỏ `actor`, `parkingId` khỏi `request_hash`. Ngoài phạm vi PD-17, và lệnh gửi lại sau khi nâng cấp sẽ bị 422. Giữ nguyên công thức cũ `canonical({ type, parkingId, actor, payload })`.
2. **PD-17: lịch sử quét cả bảng sự kiện.** [`parking-node/src/slots.js:272-275`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/55ea917b9fef7f46011dd4aaaead27e1602b4f6e/parking-node/src/slots.js#L272-L275) `LEFT JOIN LATERAL … WHERE pe.payload->>'sessionId' = …` không có index → mỗi phiên quét toàn bộ `parking_events`. Lưu `hlc` vào `parking_sessions` lúc xe vào (cùng transaction) rồi sắp theo cột đó.
3. **PD-17: PR #55** tên là "Feature/pd 17 hlc" (tên nhánh tự sinh), mô tả chưa theo mẫu (`Đã làm`, `Cách kiểm tra`). 7 test aggregator lỗi trên máy Loan trong khi CI xanh → chạy lại sau `npm ci` để biết do môi trường.
4. **PD-13: chưa chạy được 2 bản node.** [`parking-node/src/index.js:23`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/99e4b9a32fbfc63bbdac3bec2f76da93fb625c14/parking-node/src/index.js#L23) advisory lock viết cẩn thận nhưng 180 dòng nằm thẳng trong `index.js` (tới dòng 196) → tách `scheduled-lock.js` có unit test. Chưa có compose cho 2 bản sau 1 alias DNS, chưa có test TC60.
5. **PD-14a:** còn thiếu script `pg_rewind` + runbook, metric độ trễ theo bãi, bãi D/E/F, hướng dẫn dùng `docker-compose.ha.yml`. Chưa mở PR.

**Tuần tới:** sửa lỗi 1, 2 của PD-17 để merge; mở PR PD-14a (bãi A–C trước, ghi rõ phần còn thiếu).

---

## Phạm Sỹ Hiệp – 45/100

| Việc | Trạng thái | Điểm |
|---|---|---|
| PD-12 Mở rộng 6 bãi, 2 vùng | PR #56, xung đột | 53 |
| PD-19 Aggregator theo vùng | Nhánh, chưa PR | 48 |
| PD-24, 26, 27 | Chưa làm | — |

**Điểm mạnh:** phần sinh compose 6 bãi (`scripts/gen-lots.mjs`), toxiproxy giả lập độ trễ liên vùng và test `gen-lots` có giá trị thật.

**Lỗi cần sửa**

1. **PD-12 dựa trên PD-09 bản cũ, chưa rebase dù đã được nhắc.** Nhánh tách từ `e7cf08c` (16/10), chậm hơn `dev` 18 commit, và chứa commit [`043a071 pd-09`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/commit/043a071) bản chưa sửa của Luận. PR #56 xung đột nên CI không chạy. [`aggregator-service/src/index.js:42-49`](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/blob/cc4c9040eb65422369710b3338fcbb661852ff5c/aggregator-service/src/index.js#L42-L49) nối vào `discovery` bản cũ.
   ```bash
   git fetch origin
   git checkout feature/PD-12-six-parking
   git rebase origin/dev
   ```
   Khi rebase bỏ commit `043a071` và phần sửa `discovery.js` cũ, dùng PD-09 mới đã có trên `dev`; chạy lại e2e trên 6 bãi theo "Xong khi".
2. **PD-19 làm trước việc bắt buộc.** Issue #37 ghi "Nếu kịp" và cần PD-12; nhánh xây chồng lên PD-12 chưa rebase. Trong khi PD-24, PD-26, PD-27 (bắt buộc) chưa bắt đầu.

**Tuần tới:** rebase PD-12 (ưu tiên số 1), rồi PD-24.

---

## Việc chung

- Test UX-02 `byHour` trên `dev` phụ thuộc giờ chạy, đôi khi làm CI đỏ — cần một người sửa.
- TC43 viết cứng `localhost:3000`; máy bị chiếm cổng 3000 sẽ lỗi giả — nên đọc từ biến môi trường.
