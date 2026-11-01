# Báo cáo review giai đoạn 2 – Nhóm 16

Ngày 24/10/2026 · Người test và nhận xét: Hoàng Văn Huynh (Claude review và chạy test thay)

## 1. Tóm tắt

| | |
|---|---|
| Đã merge vào `dev` hôm nay | **PD-09** (#50, Luận), **PD-11** (#51, Luận), **PD-18** (#57, Trang) |
| Đưa lên `main` | PR #59 (dev → main), chờ CI xanh rồi merge — xem mục 8 |
| Đã có trên `main` từ trước | PD-01 (#47), PD-02 (#48) của Hùng |
| Chưa merge, cần sửa | PD-08, PD-03, PD-04 (Hùng) · PD-17 (Loan) · PD-22 (Trang) · PD-12, PD-19 (Hiệp) · PD-10, PD-14b (Luận, chưa có PR) · PD-13, PD-14a (Loan, chưa có PR) |
| Việc xong / tổng | **5/28** (PD-01, 02, 09, 11, 18) |

Điểm tổng từng thành viên (thang 100, cách tính ở mục 6):

| Thành viên | Điểm | Việc đã merge | Tiến độ tuần (mục tiêu 30–50%) |
|---|---|---|---|
| Vũ Văn Hùng | **80** | 2/5 | 40% – đạt |
| Nguyễn Văn Luận | **72** | 2/5 | 40% – đạt |
| Đỗ Huyền Trang | **66** | 1/7 | 14% – chưa đạt (bắt đầu muộn nhưng nhanh) |
| Trịnh Kim Loan | **52** | 0/6 | 0% – chưa đạt |
| Phạm Sỹ Hiệp | **45** | 0/5 | 0% – chưa đạt |

## 2. Thang chấm từng việc (100 điểm)

| Tiêu chí | Điểm | Nhìn vào đâu |
|---|---|---|
| Đúng yêu cầu issue | 30 | Làm đủ các gạch đầu dòng ở mục "Việc", đạt mục "Xong khi" |
| Chất lượng code và an toàn | 25 | Đúng, dễ đọc, theo phong cách code sẵn có, không lỗ hổng, không làm hỏng phần khác |
| Test | 20 | Unit + e2e theo TC của issue, test đạt khi Huynh chạy lại |
| Quy trình | 15 | PR theo mẫu, mô tả "Cách kiểm tra", duyệt thiết kế trước với việc khó, tối đa 2 PR chờ, nhánh từ `dev` |
| Sẵn sàng tích hợp | 10 | Không xung đột, không phụ thuộc file `.patch`, merge được ngay |

Ngưỡng merge: **≥ 75 điểm, không có lỗi chặn, test đạt khi chạy lại**.

## 3. Kế hoạch test đã chạy

Bản ghép: `dev` (đã có PD-01, PD-02) + PD-09 + PD-11 + PD-18. Mỗi vòng dựng Docker với volume mới, project riêng.

| Vòng | Cấu hình | Kiểm gì | Kết quả |
|---|---|---|---|
| 0 | Unit | `npm test` 3 service, build frontend | node 66 đạt (1 bỏ qua), aggregator 54 đạt (3 live bỏ qua), notification 2/2, build đạt |
| A | Mặc định: không etcd, 1 RabbitMQ | Tương thích ngược: mọi e2e cũ + PD-02 | **16/16 đạt** (kể cả TC37) |
| B | `coord` + `ha`: etcd 3 nút, RabbitMQ 3 nút, Aggregator 2 bản, bản sao DB A | Toàn bộ e2e với `COORD=1 HA=1` | **22 đạt**, TC43 lỗi do cổng 3000 trên máy test bị chiếm; chạy tay qua nginx **20/20 đạt** |
| B+ | PD-09 thủ công | Bật etcd vẫn giữ tên, toạ độ, publicUrl | Đạt (A, B, C đủ thông tin) |
| B+ | PD-11 thủ công | `failThreshold` = 0, abc, -5, 99999999, 4 | Giá trị sai bị từ chối, giữ 3, bãi vẫn ONLINE; 4 được nhận, log có revision; `/api/config` không token → 401 |
| A+ | PD-18 đo độ trễ | 40 sự kiện mỗi bãi, đọc `relay_lag_seconds` | Bãi A: **40/40 < 20 ms, TB 9,4 ms**. Bãi C sau khi DB khởi động lại: 0/40 < 20 ms, TB 257 ms (LISTEN không nối lại) |

TC có trong lần chạy: TC01, TC02, TC04–TC10, TC27, TC37, TC43, TC44, TC48, TC49, TC52, TC53, TC56, TC63, TC64, TC67. TC47 (cần profile chaos), TC46 bỏ qua theo điều kiện có sẵn.

Lưu ý môi trường: Docker Desktop đôi khi báo `eacces` file `.erlang.cookie` ở lần dựng RabbitMQ đầu với volume mới, dựng lại thì hết (lỗi sẵn có, không do PR nào).

## 4. Điểm từng việc

| Việc | Người | Trạng thái | Điểm | Ghi chú ngắn |
|---|---|---|---|---|
| PD-01 | Hùng | ✅ main | 92 | Topology lệnh, policy DLX |
| PD-02 | Hùng | ✅ main | 88 | Inbox đúng một lần, test TC52/53 tốt |
| PD-08 | Hùng | PR #49, chưa merge | 70 | Phụ thuộc file `.patch`, cần rebase |
| PD-03 | Hùng | PR #52, chưa merge | 68 | Logic chắc nhưng code dồn một dòng, khó đọc; chưa duyệt thiết kế |
| PD-04 | Hùng | PR #53, chưa merge | 60 | TC61 chưa chạy được, tắt mặc định |
| PD-09 | Luận | ✅ dev, PR #59 lên main | 83 | Sửa đủ 7 điểm review |
| PD-11 | Luận | ✅ dev, PR #59 lên main | 82 | Validate cấu hình chặt |
| PD-10 | Luận | Nhánh, chưa PR | 56 | Kiểm fencing ngoài transaction, có thể bị đẩy token |
| PD-14b | Luận | Nhánh, chưa PR | 66 | Thứ tự CAS → chờ → promote đúng |
| PD-07 | Luận | Chưa làm | 0 | Tuần M4 |
| PD-18 | Trang | ✅ dev, PR #59 lên main | 79 | Đạt < 20 ms; LISTEN không nối lại |
| PD-22 | Trang | PR #58, chưa merge | 70 | Replay có thể treo, thiếu xử lý lỗi channel |
| PD-17 | Loan | PR #55, chưa merge | 66 | Đổi hash inbox PD-02, truy vấn lịch sử quét toàn bảng |
| PD-13 | Loan | Nhánh, chưa PR | 32 | Mới có advisory lock, chưa chạy 2 bản node |
| PD-14a | Loan | Nhánh, chưa PR | 36 | Mới bản sao B, C và đồng bộ A |
| PD-12 | Hiệp | PR #56, xung đột | 53 | Vẫn dựa trên PD-09 bản cũ |
| PD-19 | Hiệp | Nhánh, chưa PR | 48 | Việc "nếu kịp", làm trước việc bắt buộc |
| 11 việc còn lại | | Chưa làm | — | PD-05, 06, 15, 16, 20, 21, 23–27 |

## 5. Chi tiết và đề xuất sửa

### Vũ Văn Hùng

**PD-08 (#49) – 70.** Retry 2 s/10 s và DLQ có kiểm chứng TTL thật, trang "Lệnh lỗi" che dữ liệu nhạy cảm. CI đỏ do test UX-02 `byHour` có sẵn phụ thuộc giờ chạy (không phải lỗi của Hùng).
Đề xuất sửa:
1. Rebase lên `dev` (đã có PD-02), nối thẳng `retryOrDead` vào consumer, **xoá `scripts/pd08-pd02-integration.patch` và `retry-integration.js`**.
2. `definitions.json`: kiểm lại không trùng với phần Trang thêm (`events.stream`) khi PD-22 vào.
3. Đóng bớt PR: chỉ để 2 PR chờ.

**PD-03 (#52) – 68.** Ghi `commands` trước khi publish, lease phục hồi sau crash, 202 + Socket.IO, kiểm owner — thiết kế tốt. Nhưng:
1. Code dồn nhiều lệnh trên một dòng, bỏ khoảng trắng (`command-flow.js`, đoạn mới trong `routes.js`) — khác hẳn phong cách repo, rất khó review. Viết lại cho dễ đọc như phần còn lại.
2. `COMMAND_MODE=broker` đang là **mặc định** → đổi hành vi API đặt/huỷ/trả tiền của mọi người. Để mặc định `http` cho tới khi e2e broker chạy trong CI.
3. Việc khó phải đăng thiết kế lên #20 để duyệt trước (#19, #20 vẫn chưa có comment).
4. Rebase lên `dev`, nối hook node trực tiếp, xoá `scripts/pd03-pd02-reply.patch`.
5. Khi merge sẽ hết vấn đề relay phản hồi PD-02 bị kẹt (chưa có queue `agg.<id>`).

**PD-04 (#53) – 60.** Làm sau PD-03. Xoá `scripts/pd04-pd02-integration.patch`, `prepare-pd04-candidate.mjs`; TC61 cần D/E/F nên chờ PD-12.

### Nguyễn Văn Luận

**PD-09 (#50) – 83, đã merge.** Sửa đủ: giữ metadata DB, OFFLINE/DEGRADED tách bạch, đăng ký lại vô hạn khi mất lease, watch từ `revision+1`, khoá endpoint lỗi giả lập. Khi merge mình đã gộp `regClient.stop()` vào `shutdown()` của PD-02 (hai handler SIGTERM sẽ cắt nhau).
Làm tiếp: TC63 sát ngưỡng 2 s khi máy chậm.

**PD-11 (#51) – 82, đã merge.** Làm tiếp: `reserveTimeoutMs` vẫn đọc một lần lúc khởi động; `healthIntervalMs` có validator nhưng `setInterval` không đổi theo.

**PD-10 – 56.** Bầu leader và lấy token ổn. Lỗi cần sửa trước khi mở PR:
1. **Kiểm fencing tách khỏi transaction ghi**: middleware gọi `checkFencing(pool, …)` (tự commit) rồi mới `next()` — đúng khe hở TOCTOU mà thiết kế #27 hứa tránh. Truyền client transaction vào từng thao tác ghi của job (expire, đối soát…) và kiểm `INSERT … ON CONFLICT … WHERE max_token <= $token` trong cùng `BEGIN … COMMIT`.
2. **Ai có JWT nhân viên bãi cũng đẩy được `max_token`**: middleware áp cho mọi `/api` (cả GET), gửi `x-fencing-token: 999999999` là leader thật bị `STALE_LEADER`. Chỉ nhận token khi có `x-internal-key`.
3. `/api/internal/fenced-job` hiện không làm việc gì — bỏ hoặc nối vào job thật.

**PD-14b – 66.** Thứ tự đúng: CAS (gộp điều kiện khoá leader) → chờ cửa sổ an toàn → `pg_promote()` → ghi `db_epoch`; node chặn ghi khi mất etcd quá X giây. Sửa: comment đầu `manager.js` còn ghi thứ tự cũ (promote trước CAS); mở PR sau khi PD-10 và PD-14a xong.

**PD-07** chưa làm (tuần M4).

### Đỗ Huyền Trang

**PD-18 (#57) – 79, đã merge.** Đạt tiêu chí < 20 ms. Làm tiếp:
1. Client LISTEN chết khi DB khởi động lại và không nối lại (đo được 257 ms). Thêm reconnect: `on('error')`/`on('end')` → tạo Client mới, `LISTEN outbox` lại, backoff 1–5 s.
2. Bỏ `log.info` mỗi lần nhận NOTIFY (quá ồn khi tải cao).

**PD-22 (#58) – 70.** Replay từ `events.stream` và đối soát có nhịp 500 ms đúng ý issue, mô tả PR có số đo. Sửa trước khi merge:
1. Channel đọc stream chưa có `ch.on('error')` — server đóng channel (queue thiếu, đổi leader stream) sẽ phát `error` không ai bắt.
2. `replayRecentEvents` chỉ xong khi gặp marker; mất marker thì treo mãi và **`sagas.recover()` không bao giờ chạy**. Thêm timeout (ví dụ 10 s) rồi tiếp tục khởi động.
3. Thêm số đo trước/sau theo "Xong khi" (thời gian khởi động và số request tới bãi).
4. Báo Hùng vì `definitions.json` do Hùng giữ (theo file chia việc).

Còn 5 việc chưa bắt đầu: PD-06, 20, 21, 23, 25.

### Trịnh Kim Loan

**PD-17 (#55) – 66.** Thuật toán HLC đúng, có test TC74, lịch sử sắp theo HLC. Sửa trước khi merge:
1. **Không đổi `request_hash` của PD-02** (đang bỏ `actor`, `parkingId`) — ngoài phạm vi, inbox cũ sẽ trả 422 cho lệnh gửi lại. Giữ nguyên công thức cũ.
2. `listSessions` dùng `LATERAL` tìm `parking_events.payload->>'sessionId'` không có index → mỗi phiên quét cả bảng sự kiện. Lưu `hlc` vào `parking_sessions` lúc xe vào (cùng transaction) rồi sắp theo cột đó.
3. Tên PR là tên nhánh tự sinh, mô tả chưa theo mẫu (`Đã làm`, `Cách kiểm tra`). 7 test aggregator lỗi trên máy Loan nhưng CI xanh → chạy lại sau `npm ci` để biết do môi trường.

**PD-13 – 32.** Advisory lock viết cẩn thận nhưng: chưa có compose cho 2 bản node sau 1 alias DNS, chưa test, 180 dòng nằm thẳng trong `index.js` → tách module `scheduled-lock.js` có unit test. Relay SKIP LOCKED nay đã có nhờ PD-18.

**PD-14a – 36.** Đã có bản sao B, C và cấu hình đồng bộ A bằng `ALTER SYSTEM`. Còn thiếu: script `pg_rewind` + runbook, metric độ trễ theo bãi, D/E/F (sau PD-12), ghi rõ `docker-compose.ha.yml` dùng thế nào và volume `db-b/db-c` cũ cần `down -v` (chưa có user `replicator`). Mở PR.

Còn 3 việc chưa bắt đầu: PD-05, 15, 16.

### Phạm Sỹ Hiệp

**PD-12 (#56) – 53.** Phần sinh compose 6 bãi, toxiproxy giả lập độ trễ liên vùng, test `gen-lots` có giá trị. Nhưng PR vẫn là commit 21/10 dựa trên **PD-09 bản cũ** (đã được nhắc), xung đột, CI không chạy.
Đề xuất: `git fetch && git checkout feature/PD-12-six-parking && git rebase origin/dev` (PD-09 mới đã ở `dev`), bỏ phần sửa `discovery.js` của bản cũ, chạy lại e2e trên 6 bãi theo "Xong khi".

**PD-19 – 48.** Issue ghi "Nếu kịp" và cần PD-12 — làm sau PD-12. Khi rebase PD-12 xong thì rebase PD-19 theo.

Còn 3 việc chưa bắt đầu: PD-24 (bắt buộc, tuần M2), 26 (bắt buộc), 27 (bắt buộc).

## 6. Đánh giá từng thành viên

Điểm thành viên = 50% chất lượng các việc đã làm + 30% khối lượng/tiến độ so với kế hoạch + 20% quy trình và phối hợp (phản hồi review, PR đúng mẫu, nói đúng tình trạng).

### Vũ Văn Hùng – 80/100
- Mạnh nhất nhóm về kỹ thuật: 5/5 việc có code, 2 việc đã lên `main`, code PD-01/PD-02 chắc chắn, có e2e thật và tài liệu bằng chứng.
- Trừ điểm: bỏ bước duyệt thiết kế với PD-02/PD-03, mở 4 PR cùng lúc (quy định 2), nối các PR bằng file `.patch` thay vì làm tuần tự, PD-03 viết dồn khó đọc, đổi mặc định sang broker.
- Tuần tới: rebase PD-08 → merge; viết lại PD-03 dễ đọc, để mặc định `http`, đăng thiết kế #20.

### Nguyễn Văn Luận – 72/100
- Khối lượng lớn (4/5 việc có code), sửa hết 7 điểm review trong chưa tới một ngày, thiết kế #27/#32 đăng lại đầy đủ và trả lời đúng các câu hỏi.
- Trừ điểm: lần đầu báo đã mở PR khi chưa có, thiết kế bị cắt cụt và còn dấu `[cite]`; PD-10 có 2 lỗi an toàn; xếp chồng nhiều nhánh lên nhau làm khó merge.
- Tuần tới: sửa 2 lỗi fencing PD-10 rồi mở PR; PD-14b sau khi PD-14a sẵn.

### Đỗ Huyền Trang – 66/100
- Bắt đầu muộn (0 commit tới 24/10) nhưng trong 1 ngày làm 2 PR gọn, mô tả PR tốt nhất nhóm (có số đo, nói rõ chưa kiểm được gì). PD-18 đã merge.
- Trừ điểm: mới 2/7 việc; PD-22 thiếu xử lý lỗi; chưa phối hợp với Hùng về `definitions.json`.
- Tuần tới: sửa PD-22 (timeout + error handler) để merge; reconnect LISTEN của PD-18; bắt đầu PD-23 (cần PD-22).

### Trịnh Kim Loan – 52/100
- PD-17 đúng thuật toán và có TC74; PD-13/PD-14a đi đúng hướng.
- Trừ điểm: chưa việc nào merge; 2 việc làm dở không mở PR, không test; PR #55 không theo mẫu; tự đổi code PD-02 ngoài phạm vi.
- Tuần tới: sửa 2 điểm PD-17 để merge; mở PR PD-14a (bản A–C trước, ghi rõ phần còn thiếu).

### Phạm Sỹ Hiệp – 45/100
- PD-12 có nội dung tốt (sinh compose, độ trễ liên vùng), PD-19 có test.
- Trừ điểm: không rebase PD-12 dù đã được nhắc, PR #56 xung đột và không có CI; làm việc "nếu kịp" trước 3 việc bắt buộc; chưa việc nào merge.
- Tuần tới: rebase PD-12 lên `dev` (ưu tiên số 1 vì Loan cần PD-12 cho PD-13, PD-14a), rồi PD-24.

## 7. Việc Huynh cần làm

1. Gửi đề xuất sửa ở mục 5 cho từng bạn (mình chưa comment lên các PR chưa merge).
2. Nhắc quy định: tối đa 2 PR chờ (Hùng đang 3), việc khó phải có thiết kế được duyệt trước (#19, #20, #44 chưa có).
3. Thứ tự review tiếp theo để mở khoá việc cho người khác: PD-08 (Hùng) → PD-22 (Trang) → PD-17 (Loan) → PD-12 rebase (Hiệp) → PD-03 (Hùng).
4. Test UX-02 `byHour` trên `dev` phụ thuộc giờ chạy, thỉnh thoảng làm CI đỏ — nên giao một người sửa.
5. TC43 viết cứng `localhost:3000`; máy nào bị chiếm cổng 3000 sẽ lỗi giả — nên đọc từ biến môi trường.

## 8. Trạng thái đưa lên main

- PD-09, PD-11, PD-18 đã ở `dev` (commit `6d287c9`); PR #50, #51, #57 tự chuyển sang Merged.
- [PR #59](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/pull/59) dev → main đã mở. Lúc 17:00 UTC 24/10: frontend xanh, test unit của lượt push xanh, test unit và e2e của lượt PR còn đang chạy. Chưa merge vì chưa đủ xanh; repo không cho bật auto-merge.
- Sáng dậy: mở #59, nếu 3 check (test, frontend, e2e) xanh thì bấm **Merge pull request** (kiểu merge commit), hoặc nhắn "merge #59". Nếu CI đỏ, app sẽ báo và Claude sửa.
