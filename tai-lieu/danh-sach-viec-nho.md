# Danh sách việc nhỏ – Nhóm 16 (bản hoàn chỉnh)
**Lập:** 05/10/2026 · Chia nhỏ 32 việc trong `ke-hoach-chi-tiet-ban-hoan-chinh.md` (đặc tả kỹ thuật ở mục 6 file đó).

**Cách dùng**
- Mỗi việc nhỏ khoảng **1–4 giờ**, làm xong trong một buổi. Mã dạng `NV-06.3` = việc NV-06, bước 3.
- Làm **theo thứ tự** trong từng việc (bước sau thường cần bước trước). Các việc khác nhau làm song song được, trừ khi ghi *Cần trước*.
- Xong bước nào thì đánh `[x]` trong PR hoặc Issue tương ứng. Mỗi PR nên gồm 1–3 bước, không gom cả việc lớn vào một PR.
- Giờ là ước lượng cho một người, 1 ngày công ≈ 4,5 giờ, đã tính viết test.

---

## Chia việc: 3 người code, 3 người không code

**Người code:** Huynh, Hùng, Luân nhận **mọi việc nhỏ có viết code** (kể cả test và giao diện của việc đó).
**Người không code:** Loan, Trang, Hiệp nhận việc nhỏ có gắn **[Tên]** trong các việc code (chạy thử, đo số liệu, viết lý thuyết, chụp ảnh) + toàn bộ nhóm E (tài liệu) + thử tay PR.

**Đi cặp** (để khi bảo vệ mỗi phần có 2 người trả lời được):

| Cặp | Phần | Người không code làm gì cho cặp |
|---|---|---|
| Hùng + **Loan** | Node, DB, nghiệp vụ (đặt giờ, phí, thanh toán, replica) | Bảng giá, dữ liệu mẫu, thử tay PR của Hùng, runbook failover, viết báo cáo mục 5–7 |
| Huynh + **Trang** | Aggregator, hạ tầng, chịu lỗi (LB, breaker, mạng xấu, RabbitMQ, CI, Grafana) | Chạy kịch bản mạng xấu, test tải, kiểm dashboard, thử tay PR của Huynh, viết báo cáo mục 8–10 |
| Luân + **Hiệp** | Giao diện, QR, thông báo, bản đồ, thống kê | Thử tay PR của Luân trên điện thoại, chụp ảnh, kiểm log truy vết, ghép báo cáo + slide |

### Lịch người code

| Người | Tuần 1 (06–12/10) | Tuần 2 (13–19/10) | Tuần 3 (20–26/10) | Tuần 4 (27/10–02/11) | Ngày công |
|---|---|---|---|---|---|
| **Hùng** | NV-02, NV-06 | NV-03, NV-01 (1–6) | NV-01 (7–11), NV-04 | NV-09, PT-02 (1–8) | khoảng 14 |
| **Huynh** | K, GS-01, PT-04, GS-07, GS-02 | PT-01 | PT-06, PT-05 | PT-03, GS-04 | khoảng 14 |
| **Luân** | UX-03, NV-07 | GS-03, NV-05 | UX-01, UX-02 (1–4) | UX-02 (5–7), NV-08, GS-05 (1–2) | khoảng 13 |

*Nếu kịp* (chỉ làm khi tuần 4 xong sớm, thực tế nên coi là đã cắt): PT-07, GS-06 (Huynh), UX-04 (Luân).

> Khoảng 13–14 ngày công mỗi người trong 4 tuần, tức 3,5 ngày/tuần, **nặng hơn** mức 3 ngày/tuần lúc 6 người chia nhau. Tuần nào trễ thì cắt theo thứ tự ở plan mục 12.2, không dồn sang tuần 5.

### Lịch người không code

| Người | Tuần 1 | Tuần 2 | Tuần 3 | Tuần 4 | Tuần 5 |
|---|---|---|---|---|---|
| **Loan** | NV-03.1 bảng giá; dữ liệu mẫu 3 bãi (toạ độ, số slot từng loại); thử tay PR Hùng | UX-03.5 câu chữ tiếng Việt; thử tay NV-03, NV-01 | Thử tay NV-01, NV-04; nháp báo cáo mục 5–7; NV-01.12 | PT-02.9–10 runbook + tập failover cùng Hùng | Hoàn thiện mục 5–7 |
| **Trang** | Lập bảng TC01–TC55 (`tai-lieu/bang-test.md`); thử tay PR Huynh; PT-04.6 | Thử tay PT-01; PT-01.10 | PT-06.4, PT-06.6 kịch bản mạng xấu | GS-05.3–5 test tải; GS-04.8–9; PT-03.6 | Z.4, Z.5, Z.9 máy demo; video demo |
| **Hiệp** | TL-01 sửa HLD | TL-03.1–2 khung báo cáo + mục 1, 4, 12; GS-03.7 | TL-02 sơ đồ mới; PT-05.7 | UX-01.7, UX-02.8 chụp ảnh; thử tay PR Luân trên điện thoại | TL-03.4–7 ghép báo cáo; TL-04 slide |

Tuần 5 (03–09/11) chung cho cả nhóm: TL-05 vấn đáp, sửa lỗi, tập demo (mục Z).

---

## K · Khởi động (GĐ0, 04–05/10)

**Cả nhóm**
- [ ] **K.1** (1h) Mỗi người clone repo, `docker compose up -d --build`, đăng nhập `user1`, chụp màn hình gửi nhóm.
- [ ] **K.2** (0,5h) Mỗi người chạy `npm test` ở `parking-node` và `aggregator-service`, thấy đạt hết.
- [ ] **K.3** (0,5h) Đọc mục 1–5 của `ke-hoach-chi-tiet-ban-hoan-chinh.md` và file này; ai muốn đổi việc thì báo trước 05/10.
- [ ] **K.4** (0,5h) Họp khởi động 30 phút, chốt phân công.

**Huynh**
- [ ] **K.5** (0,5h) Commit 2 file kế hoạch (.docx, .md) và file này lên `dev`.
- [ ] **K.6** (1,5h) Tạo 32 GitHub Issue (tiêu đề `NV-06: Phiên gửi xe và lịch sử`, dán danh sách việc nhỏ tương ứng vào nội dung), gán người.
- [ ] **K.7** (0,5h) Tạo nhãn: `A-nghiep-vu`, `B-phan-tan`, `C-giam-sat`, `D-giao-dien`, `E-tai-lieu`, `bat-buoc`, `nen-co`, `neu-kip`, `e2e`.
- [ ] **K.8** (0,5h) Tạo GitHub Project 4 cột: *Chưa làm / Đang làm / Chờ review / Xong*; thêm 32 Issue vào.
- [ ] **K.9** (0,5h) Thêm `.github/pull_request_template.md` theo mẫu ở mục 8 của plan.
- [ ] **K.10** (0,5h) Đổi `frontend/Dockerfile` sang `nginx:1.29-alpine`, kiểm web vẫn chạy.

---

## A · Nghiệp vụ sát thực tế

### NV-02 · Loại xe và tầng · Hùng · 4,5h · Bắt buộc
- [ ] **NV-02.1** (1h) Đổi seed trong `parking-node/src/db.js`: đọc env `SLOTS="CAR:1:10,CAR:2:10,MOTO:1:40"`, mã slot `A-1-C01`. Không có `SLOTS` thì dùng `SLOT_COUNT` như cũ.
- [ ] **NV-02.2** (0,5h) Thêm `CHECK (type IN ('CAR','MOTO'))` vào `schema.sql`; cập nhật env 3 bãi trong `docker-compose.yml`.
- [ ] **NV-02.3** (1h) `availability()` trả thêm `byType`; `listSlots()` nhận tham số `type`; route `GET /api/slots?type=`.
- [ ] **NV-02.4** (0,5h) Aggregator: `/api/parkings/search?type=CAR&available=true` lọc theo `byType`.
- [ ] **NV-02.5** (1h) Frontend: nút lọc Ô tô / Xe máy ở Tổng quan; chi tiết bãi nhóm slot theo tầng.
- [ ] **NV-02.6** (0,5h) Test TC15 (seed đúng số slot từng loại), TC16 (lọc `type=MOTO`); sửa test cũ bị ảnh hưởng do đổi mã slot.

### NV-06 · Phiên gửi xe và lịch sử · Hùng · 9h · Bắt buộc · *Cần trước: NV-02*
- [ ] **NV-06.1** (1h) Thêm bảng `parking_sessions` + 3 index vào `schema.sql` (SQL ở plan mục 6.1).
- [ ] **NV-06.2** (1,5h) `moveSlot`: khi `CAR_ENTER` bắt buộc biển số, `INSERT` phiên cùng giao dịch (gắn `reservation_id`, `user_id` nếu xe vào bằng đặt chỗ).
- [ ] **NV-06.3** (1h) `moveSlot`: khi `CAR_EXIT` đóng phiên (`exited_at=now()`), trả phiên trong response.
- [ ] **NV-06.4** (1h) Tạo `parking-node/src/sessions.js`: `GET /api/sessions?plate=&userId=&from=&to=`; gắn vào `app.js` bằng 1 dòng.
- [ ] **NV-06.5** (1h) Aggregator: tạo `src/sessions-routes.js` với `GET /api/sessions/search?plate=` (STAFF/ADMIN, gom bằng `reg.gather`) và `GET /api/me/sessions` (USER).
- [ ] **NV-06.6** (1,5h) Frontend: trang `History.jsx` (USER) và ô tra biển số trên trang nhân viên/quản trị.
- [ ] **NV-06.7** (1h) Test unit TC17 (vào–ra tạo đúng 1 phiên), TC18 (cùng biển số vào lần 2 thì 409).
- [ ] **NV-06.8** (1h) Test e2e TC19 (tra biển số khi B tắt trả `unavailable:["B"]`).

### NV-01 · Đặt chỗ theo khung giờ · Hùng · 18h · Nên có · *Cần trước: NV-06*
- [ ] **NV-01.1** (1h) **Thử trước:** nạp `btree_gist` vào PGlite trong `test/helpers.js`. Ghi kết quả vào Issue (được thì test unit, không được thì chỉ e2e).
- [ ] **NV-01.2** (1,5h) Schema: extension `btree_gist`, cột `end_time`, trạng thái `DONE`, ràng buộc `ex_no_overlap`; xoá `ux_one_active_per_slot`. Ghi trong PR "cần `down -v`".
- [ ] **NV-01.3** (2h) `reserve` nhận `startTime`, `durationMinutes`; kiểm giới hạn (≤ 7 ngày tới, 30 phút–24 giờ); mặc định đặt ngay 120 phút.
- [ ] **NV-01.4** (1,5h) Nhánh đặt cho tương lai: chỉ INSERT, bắt lỗi `23P01` trả 409 `TIME_CONFLICT`. Nhánh đặt ngay giữ CAS cũ và INSERT có `end_time`.
- [ ] **NV-01.5** (1h) Xe ra: reservation `USED → DONE` trong `moveSlot` (giải phóng khung giờ).
- [ ] **NV-01.6** (2h) Job `activateDue`: đến giờ thì CAS slot `AVAILABLE → RESERVED` và emit; gọi trong `index.js` cạnh `expireDue`.
- [ ] **NV-01.7** (2h) `activateDue` khi slot đang `OCCUPIED`: tìm slot trống cùng loại, đổi `slot_id`, emit `RESERVATION_MOVED`; không có thì emit `RESERVATION_CONFLICT`.
- [ ] **NV-01.8** (1h) Xe vãng lai: chặn `enter` vào slot có reservation bắt đầu trong 2 giờ tới (409 kèm gợi ý slot khác).
- [ ] **NV-01.9** (1h) API lịch slot `GET /api/slots/:code/schedule?date=` ở node và Aggregator.
- [ ] **NV-01.10** (2h) Frontend: form đặt có `datetime-local` + thời lượng; lịch slot dạng thanh ngang.
- [ ] **NV-01.11** (2h) Test TC20 (chồng giờ 409, e2e), TC21 (khung nối tiếp đều được), TC22 (`activateDue`), TC23 (chuyển slot).
- [ ] **NV-01.12** (1h) **[Loan]** Cập nhật `ap-dung-vao-btl.md` (schema mới) và README nếu đổi cách đặt.

### NV-03 · Tính phí gửi xe · Hùng · 9h · Bắt buộc · *Cần trước: NV-06*
- [ ] **NV-03.1** (1h) **[Loan]** Ghi bảng giá mẫu cho 3 bãi (ô tô, xe máy; 2 giờ đầu, giờ tiếp, qua đêm, trần ngày), chốt với nhóm.
- [ ] **NV-03.2** (2h) Tạo `parking-node/src/pricing.js`: hàm thuần `calcFee(rule, enteredAt, exitedAt)` trả `{fee, breakdown}`, tính qua đêm theo giờ Việt Nam.
- [ ] **NV-03.3** (1,5h) Test TC24 trong `test/pricing.test.js`: 0 phút, đúng 120 phút, 121 phút, qua 22:00, qua 2 đêm, chạm trần ngày.
- [ ] **NV-03.4** (1h) Bảng `pricing_rules` trong `schema.sql`; seed từ env `PRICING` (JSON) khi bảng rỗng.
- [ ] **NV-03.5** (1h) Khi `CAR_EXIT`: tính phí, ghi `fee` vào phiên cùng giao dịch, trả phí trong response.
- [ ] **NV-03.6** (0,5h) `GET /api/sessions/:id/quote` (phí tạm tính khi xe chưa ra).
- [ ] **NV-03.7** (1h) `GET/PUT /api/parkings/:id/pricing` ở node + Aggregator (STAFF bãi đó, ADMIN).
- [ ] **NV-03.8** (1h) Frontend: hiện phí khi nhân viên cho xe ra; trang sửa bảng giá cho STAFF/ADMIN. Test TC25.

### NV-04 · Thanh toán giả lập · Hùng · 9h · Nên có · *Cần trước: NV-03*
- [ ] **NV-04.1** (2h) Node `POST /api/sessions/:id/pay {method}` + header `Idempotency-Key`; `UPDATE … WHERE paid_at IS NULL`; trùng key thì trả kết quả cũ; emit `SESSION_PAID`.
- [ ] **NV-04.2** (1h) Chặn `exit` khi phiên chưa trả: 402 `PAYMENT_REQUIRED`.
- [ ] **NV-04.3** (1h) Thao tác "Thu tiền mặt và cho ra": pay CASH + exit trong một giao dịch.
- [ ] **NV-04.4** (1h) Aggregator `POST /api/me/sessions/:parkingId/:sid/pay` chuyển tiếp cùng key, timeout trả 504.
- [ ] **NV-04.5** (2h) Frontend: nút Thanh toán ở Lịch sử, trạng thái CHƯA TRẢ / ĐÃ TRẢ, "Thử lại" dùng cùng key; nút "Thu tiền mặt và cho ra" cho nhân viên.
- [ ] **NV-04.6** (2h) Test TC26 (cùng key 2 lần), TC27 (e2e, 2 request song song khác key), TC28 (chưa trả không cho ra).

### NV-05 · Mã QR vào/ra · Luân · 9h · Nên có
- [ ] **NV-05.1** (1,5h) Tạo `parking-node/src/qr.js`: `sign(payload)`, `verify(token)` bằng HMAC-SHA256 + `timingSafeEqual`; env `QR_SECRET` riêng mỗi bãi.
- [ ] **NV-05.2** (1h) Test unit `qr.verify`: đúng, sửa 1 ký tự, hết hạn, sai bãi.
- [ ] **NV-05.3** (1h) `reserve` trả thêm `qrToken` (node ký).
- [ ] **NV-05.4** (2h) Tạo `parking-node/src/gate.js`: `POST /api/gate/scan {token, action}` → kiểm chữ ký, hạn, bãi, reservation ACTIVE → gọi `moveSlot`.
- [ ] **NV-05.5** (1h) `scripts/barrier.mjs` thêm `--qr <token>`.
- [ ] **NV-05.6** (1,5h) Frontend: hiện QR (thư viện `qrcode`) ở "Đặt chỗ của tôi", nút phóng to.
- [ ] **NV-05.7** (1h) Test TC29–TC32 (đúng, sửa ký tự, sai bãi, dùng lại).

### NV-07 · Đăng ký tài khoản · Luân · 4,5h · Bắt buộc
- [ ] **NV-07.1** (1h) `POST /api/auth/register`: kiểm username/mật khẩu, băm bcrypt, chỉ tạo USER, trùng tên bắt lỗi `23505` trả 409.
- [ ] **NV-07.2** (0,5h) `PUT /api/me/password {oldPassword, newPassword}`.
- [ ] **NV-07.3** (1h) Bộ đếm sai mật khẩu trong RAM: 5 lần / 15 phút theo `username+IP` thì 429 (có comment `ponytail:` ghi giới hạn khi nhiều Aggregator).
- [ ] **NV-07.4** (1h) Frontend: `Register.jsx`, link từ trang đăng nhập; form đổi mật khẩu.
- [ ] **NV-07.5** (1h) Test TC33 (đăng ký rồi đăng nhập), TC34 (trùng tên), TC35 (lần thứ 6 bị 429).

### NV-08 · Dịch vụ thông báo · Luân · 9h · Nên có · *Cần trước: PT-01*
- [ ] **NV-08.1** (1h) Node: payload sự kiện reservation thêm `userId`, `reservationId`; mọi sự kiện slot thêm `available`, `total`.
- [ ] **NV-08.2** (1h) Node: cột `warned_at`; job emit `RESERVATION_EXPIRING` khi còn ≤ 5 phút (chỉ 1 lần).
- [ ] **NV-08.3** (2h) Tạo `notification-service/` (package.json, Dockerfile, `src/index.js`): consume queue `notification.events`, soạn nội dung tiếng Việt, publish ra exchange `user.notifications` (`user.<id>` hoặc `broadcast`).
- [ ] **NV-08.4** (1h) Luật "bãi sắp đầy": báo khi < 10%, chỉ báo lại sau khi đã lên > 20%.
- [ ] **NV-08.5** (1,5h) Aggregator: Socket.IO xác thực JWT khi kết nối, `join('user:'+sub)`; consume `user.notifications` (queue riêng mỗi bản) rồi emit `NOTIFICATION`.
- [ ] **NV-08.6** (1h) Frontend: nhận `NOTIFICATION` và hiện toast (dùng component của UX-03).
- [ ] **NV-08.7** (0,5h) Thêm service vào `docker-compose.yml`.
- [ ] **NV-08.8** (1h) Test TC36 (thông báo sắp hết hạn), TC37 (tắt notification thì đặt chỗ vẫn chạy, bật lại nhận tin tồn).

### NV-09 · Quản lý slot · Hùng · 4,5h · Nên có · *Cần trước: NV-02*
- [ ] **NV-09.1** (0,5h) Cột `hidden_at`; mọi truy vấn danh sách/đếm thêm `WHERE hidden_at IS NULL`.
- [ ] **NV-09.2** (1,5h) Node: `POST /api/slots`, `PATCH /api/slots/:code`, `DELETE /api/slots/:code` (ẩn bằng 1 câu UPDATE có điều kiện); emit `SLOT_ADDED` / `SLOT_HIDDEN`.
- [ ] **NV-09.3** (0,5h) Aggregator: 3 route tương ứng, kiểm quyền STAFF bãi đó / ADMIN; cache xử lý status `HIDDEN`.
- [ ] **NV-09.4** (1h) Frontend: nút thêm / sửa / ẩn slot trên chi tiết bãi (chỉ STAFF/ADMIN).
- [ ] **NV-09.5** (1h) Test TC38 (ẩn slot có xe 409), TC39 (thêm slot thì tổng số chỗ tăng realtime).

---

## B · Phân tán nâng cao

### PT-04 · Circuit breaker + retry · Huynh · 7h · Bắt buộc
- [ ] **PT-04.1** (1h) Viết node giả trong test (`http.createServer`) điều khiển được: lỗi N lần, chậm X ms, đếm số lần gọi.
- [ ] **PT-04.2** (1,5h) `nodes.js`: request thường lỗi cũng tăng `n.fails`; đủ ngưỡng thì `OFFLINE` ngay (mạch mở); thành công thì reset.
- [ ] **PT-04.3** (1,5h) Hàm retry 1 lần, chờ ngẫu nhiên 100–300 ms, nằm trong tổng ngân sách thời gian; chỉ bật cho GET, đặt chỗ, thanh toán.
- [ ] **PT-04.4** (0,5h) Đảm bảo `enter/exit/maintenance` không retry; comment giải thích vì sao.
- [ ] **PT-04.5** (1,5h) Test TC40 (mạch mở, 503 < 50 ms), TC41 (retry cứu GET), TC42 (`enter` chỉ gọi 1 lần).
- [ ] **PT-04.6** (1h) **[Trang]** Cập nhật `ly-thuyet-ap-dung-xuyen-suot.md`: đoạn ngắn về circuit breaker và retry an toàn.

### GS-07 · Bảo mật cơ bản · Huynh · 4,5h · Bắt buộc · *Cần trước: NV-07*
- [ ] **GS-07.1** (1h) `.env.example` (đủ biến, có chú thích), thêm `.env` vào `.gitignore`; compose dùng `${JWT_SECRET:?…}`, `${INTERNAL_KEY:?…}`.
- [ ] **GS-07.2** (0,5h) Cập nhật README: bước `cp .env.example .env` trước khi chạy.
- [ ] **GS-07.3** (1h) Hàm chuẩn hoá + kiểm biển số VN (chữ hoa, bỏ dấu cách); dùng ở đặt chỗ và xe vào.
- [ ] **GS-07.4** (0,5h) `express.json({limit:'10kb'})` ở node và Aggregator; kiểm độ dài `slotCode`.
- [ ] **GS-07.5** (0,5h) `add_header` bảo mật trong `frontend/nginx.conf`.
- [ ] **GS-07.6** (1h) Test TC54 (biển số sai 400), TC55 (thiếu `JWT_SECRET` thì compose báo lỗi).

### PT-01 · Nhiều bản Aggregator + cân bằng tải · Huynh · 13,5h · Bắt buộc
- [ ] **PT-01.1** (1h) Env `INSTANCE_ID`; header `X-Instance` trên mọi response.
- [ ] **PT-01.2** (1,5h) `events.js`: tên queue `aggregator.slot-updates.<INSTANCE_ID>`; kiểm 2 bản cùng nhận một sự kiện.
- [ ] **PT-01.3** (1h) Health check đọc lại `parking_nodes` từ DB mỗi vòng, thêm bãi mới vào registry.
- [ ] **PT-01.4** (1,5h) Compose: `aggregator-1`, `aggregator-2` dưới profile `ha`; bản mặc định vẫn là `aggregator`.
- [ ] **PT-01.5** (2h) `nginx.conf`: `upstream` với `resolve`, `proxy_next_upstream`, cho cả `/api/` và `/socket.io/`; một file cấu hình chạy được cả bản gọn và bản `ha` (dùng biến env của image nginx/`envsubst`).
- [ ] **PT-01.6** (0,5h) Frontend: `io({transports:['websocket']})`.
- [ ] **PT-01.7** (2h) Test e2e TC43 (tắt `aggregator-1`, 20 request đều 200), TC44 (client ở bản 2 nhận sự kiện từ thao tác qua bản 1).
- [ ] **PT-01.8** (1h) Thử tay: đăng nhập ở bản 1, gọi API ở bản 2 vẫn được; admin thêm bãi D ở bản 1, bản 2 thấy sau ≤ 5 giây.
- [ ] **PT-01.9** (1h) Xoá queue cũ `aggregator.slot-updates`; README: cách chạy profile `ha`.
- [ ] **PT-01.10** (2h) **[Trang]** Viết 1 trang cho báo cáo mục 9: vì sao Aggregator nhân bản được (stateless, cache dựng lại được).

### PT-05 · Nhân viên làm việc khi Aggregator sập · Huynh · 9h · Nên có
- [ ] **PT-05.1** (1h) `scripts/gen-keys.mjs`: sinh cặp khoá RSA, ghi `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` vào `.env`.
- [ ] **PT-05.2** (1h) `auth.js`: ký/kiểm RS256 bằng khoá riêng; giữ HS256 nếu chưa có khoá (để test cũ chạy).
- [ ] **PT-05.3** (2h) Node: middleware kiểm JWT bằng khoá công khai; route `/staff-api/slots`, `/staff-api/slots/:code/:action` (STAFF bãi này hoặc ADMIN); bật CORS cho origin frontend.
- [ ] **PT-05.4** (0,5h) Aggregator `/api/parkings` trả thêm `publicUrl` của mỗi bãi.
- [ ] **PT-05.5** (2h) Frontend trang nhân viên: lỗi mạng/5xx thì chuyển sang gọi thẳng `publicUrl` (lưu `localStorage`), hiện băng vàng; Aggregator sống lại thì quay về.
- [ ] **PT-05.6** (1,5h) Test TC45 (token A gọi node A 200, node B 403), TC46 (e2e: dừng mọi Aggregator, vẫn cho xe vào/ra; bật lại cache khớp).
- [ ] **PT-05.7** (1h) **[Hiệp]** Sửa HLD/README: bỏ dòng hạn chế "nhân viên đi qua Aggregator".

### PT-06 · Giả lập mạng xấu · Huynh · 9h · Bắt buộc · *Cần trước: PT-04*
- [ ] **PT-06.1** (1h) Service `toxiproxy` (profile `chaos`) + file cấu hình proxy `parking-b` (:18002 → `parking-b:8002`).
- [ ] **PT-06.2** (1h) `docker-compose.chaos.yml`: đổi `apiUrl` bãi B sang `http://toxiproxy:18002`.
- [ ] **PT-06.3** (2h) `scripts/net.mjs`: lệnh `latency`, `down`, `loss`, `reset` gọi API toxiproxy (:8474).
- [ ] **PT-06.4** (2h) **[Trang]** Chạy 4 kịch bản (chậm 1,5s; chậm 3,5s khi đặt; cắt mạng; chập chờn), chụp ảnh + ghi số liệu vào `tai-lieu/ket-qua-mang-xau.md`.
- [ ] **PT-06.5** (2h) Test e2e TC47: chậm 3,5s → 504 → retry cùng key → 200, DB đúng 1 reservation.
- [ ] **PT-06.6** (1h) **[Trang]** README: cách bật profile `chaos` và dùng `net.mjs`.

### PT-03 · Cụm RabbitMQ 3 nút · Huynh · 9h · Nên có
- [ ] **PT-03.1** (2h) Compose: `rabbitmq-2`, `rabbitmq-3` (profile `ha`), `hostname` cố định, chung `RABBITMQ_ERLANG_COOKIE`; `rabbitmq/rabbitmq.conf` dùng `classic_config`.
- [ ] **PT-03.2** (1h) Kiểm trên giao diện quản lý: đủ 3 nút trong cụm.
- [ ] **PT-03.3** (1h) Khai báo queue với `x-queue-type: quorum` ở Aggregator và notification.
- [ ] **PT-03.4** (1,5h) `relay.js`, `events.js`: đọc `RABBITMQ_URLS`, mỗi lần kết nối lại thử địa chỉ tiếp theo.
- [ ] **PT-03.5** (2h) Test TC48 (tắt nút đang nối, chuyển nút < 10s, không mất tin), TC49 (tắt 2/3 nút, outbox giữ tin, bật lại gửi hết).
- [ ] **PT-03.6** (1,5h) **[Trang]** Viết nửa trang về Raft/quorum queue cho báo cáo mục 8.

### PT-02 · Bản sao DB bãi A · Hùng · 13,5h · Nên có
- [ ] **PT-02.1** (1h) `db-a` chạy với `wal_level=replica`, `max_wal_senders=5`.
- [ ] **PT-02.2** (1,5h) `postgres/init-primary.sh`: tạo user `replicator`, thêm dòng `pg_hba.conf`.
- [ ] **PT-02.3** (2h) `db-a-replica` (profile `ha`): entrypoint chạy `pg_basebackup -R -X stream` khi thư mục rỗng; kiểm `pg_is_in_recovery()` = true.
- [ ] **PT-02.4** (1h) Kiểm sao chép: ghi ở primary, đọc ở replica thấy.
- [ ] **PT-02.5** (2h) Node A: `READ_DATABASE_URL`, pool đọc riêng cho danh sách slot, thống kê, lịch sử; mọi ghi và đọc trong luồng ghi dùng primary; replica lỗi thì rơi về primary.
- [ ] **PT-02.6** (1h) Script đo: 100 lần ghi rồi đọc, ghi trung bình và p95 độ trễ (TC50).
- [ ] **PT-02.7** (1h) Test TC51: dừng replica, node A vẫn chạy.
- [ ] **PT-02.8** (1h) Metric `replication_lag_seconds` (phối hợp Trang, GS-04).
- [ ] **PT-02.9** (2h) **[Loan]** `tai-lieu/runbook-failover.md`: các bước promote, đổi `DATABASE_URL`, dựng lại DB cũ làm replica.
- [ ] **PT-02.10** (1h) **[Loan + Hùng]** Tập failover 1 lần theo runbook, ghi thời gian, chụp ảnh.

### PT-07 · Saga đặt chỗ nhiều bãi · Huynh · 13,5h · Nếu kịp · *Cần trước: PT-04*
- [ ] **PT-07.1** (1h) Bảng `sagas` trong `aggregator-service/src/schema.sql`.
- [ ] **PT-07.2** (3h) `src/saga.js`: chạy lần lượt các bước, key bước `<sagaId>:<i>`, ghi trạng thái sau mỗi bước.
- [ ] **PT-07.3** (2h) Bù trừ: huỷ ngược các bước đã xong, 404 coi là xong; trạng thái `FAILED`.
- [ ] **PT-07.4** (1,5h) Khởi động lại thì tiếp tục saga `RUNNING/COMPENSATING`.
- [ ] **PT-07.5** (1h) Route `POST /api/group-reservations` + `GET /api/group-reservations/:id`, bắt buộc Idempotency-Key.
- [ ] **PT-07.6** (2h) Frontend: form đặt nhóm (nhiều xe, nhiều bãi), hiện tiến trình từng bước.
- [ ] **PT-07.7** (2h) Test TC52 (B OFFLINE thì A được trả lại), TC53 (kill Aggregator giữa saga, bật lại bù trừ xong).
- [ ] **PT-07.8** (1h) **[Trang]** Nửa trang so sánh Saga và 2PC cho báo cáo.

---

## C · Giám sát và chất lượng

### GS-01 · CI GitHub Actions · Huynh · 2,5h · Bắt buộc · **làm đầu tiên**
- [ ] **GS-01.1** (1h) `.github/workflows/ci.yml`: Node 20, `npm ci && npm test` cho `parking-node` và `aggregator-service` (aggregator cài parking-node trước); build `frontend`.
- [ ] **GS-01.2** (0,5h) Bật cache npm, kiểm CI xanh trên `dev`.
- [ ] **GS-01.3** (0,5h) Mở PR thử cố tình làm hỏng 1 test, thấy đỏ rồi đóng PR.
- [ ] **GS-01.4** (0,5h) Bật branch protection cho `dev` và `main`: bắt buộc check `ci`. Thêm badge CI vào README.

### GS-02 · Test e2e trong CI · Huynh · 4,5h · Nên có
- [ ] **GS-02.1** (2h) Job `e2e`: `docker compose up -d --build --wait` → `node --test tests/e2e.test.mjs`.
- [ ] **GS-02.2** (0,5h) Khi lỗi in `docker compose logs`; luôn `down -v` cuối job.
- [ ] **GS-02.3** (1h) Chỉ chạy khi PR vào `main` hoặc PR có nhãn `e2e`.
- [ ] **GS-02.4** (1h) Kiểm thời gian chạy; test chập chờn thì sửa thời gian chờ trong test.

### GS-03 · Log có cấu trúc + mã truy vết · Luân · 7h · Nên có
- [ ] **GS-03.1** (1h) `src/log.js` (khoảng 15 dòng) cho node và Aggregator: in 1 dòng JSON, lấy `requestId` từ `AsyncLocalStorage`.
- [ ] **GS-03.2** (1h) Aggregator: middleware lấy `X-Request-Id` hoặc sinh mới, trả lại trong header, gửi tiếp sang node trong `reg.call`.
- [ ] **GS-03.3** (0,5h) nginx: `proxy_set_header X-Request-Id $request_id`.
- [ ] **GS-03.4** (1h) Node: middleware nhận `X-Request-Id`; `emit` ghi `requestId` vào payload.
- [ ] **GS-03.5** (1h) Relay đặt `correlationId` của bản tin AMQP; consumer log `requestId`.
- [ ] **GS-03.6** (1h) Thay các `console.log/error` hiện có bằng `log`.
- [ ] **GS-03.7** (1,5h) **[Hiệp]** Kiểm `docker compose logs | grep <id>` thấy đủ chuỗi; chụp ảnh cho báo cáo; README: cách lần theo một request.

### GS-04 · Metrics + dashboard · Huynh · 13,5h · Nên có
- [ ] **GS-04.1** (1,5h) Thêm `prom-client`; `GET /metrics` + histogram `http_request_duration_seconds` ở node và Aggregator.
- [ ] **GS-04.2** (1h) Gauge node: `outbox_unpublished`, `parking_available_slots{type}`.
- [ ] **GS-04.3** (1h) Gauge Aggregator: `parking_node_up{parking}`, `circuit_open{parking}`.
- [ ] **GS-04.4** (0,5h) Bật plugin `rabbitmq_prometheus` (cổng 15692).
- [ ] **GS-04.5** (1,5h) `observability/prometheus.yml` + service Prometheus (profile `obs`).
- [ ] **GS-04.6** (1,5h) Service Grafana (:3001), provisioning datasource tự động.
- [ ] **GS-04.7** (3h) Dashboard 1 trang (7 ô: trạng thái bãi, request/s, p95, outbox, queue, chỗ trống, độ trễ replica), xuất JSON vào `observability/grafana/`.
- [ ] **GS-04.8** (1,5h) **[Trang]** Kiểm: tắt RabbitMQ thấy outbox tăng, bật lại về 0; chụp ảnh cho báo cáo.
- [ ] **GS-04.9** (1h) **[Trang]** README: cách bật profile `obs`, tài khoản Grafana.

### GS-05 · Test tải · Luân · 7h · Nên có
- [ ] **GS-05.1** (2h) `tests/load/k6.js`: kịch bản tra cứu 200 người dùng ảo, 2 phút; kịch bản đặt chỗ 50 người dùng ảo vào 10 slot.
- [ ] **GS-05.2** (1h) `tests/load/check-invariants.mjs`: truy vấn từng DB bãi, không slot nào có > 1 reservation ACTIVE.
- [ ] **GS-05.3** (1,5h) **[Trang]** Chạy với 1 bản Aggregator, ghi p50/p95/p99, request/s, tỉ lệ lỗi.
- [ ] **GS-05.4** (1h) **[Trang]** Chạy với 2 bản (profile `ha`), so sánh.
- [ ] **GS-05.5** (1,5h) **[Trang]** `tai-lieu/ket-qua-test-tai.md`: bảng số liệu + ảnh Grafana lúc chạy.

### GS-06 · Test hỗn loạn tự động · Huynh · 9h · Nếu kịp · *Cần trước: GS-05, PT-01, PT-03*
- [ ] **GS-06.1** (2h) `tests/chaos.mjs`: chạy tải nền 3 phút, cứ 15–30 giây tắt/bật ngẫu nhiên `parking-b`, `rabbitmq-2`, `aggregator-1`.
- [ ] **GS-06.2** (3h) Kiểm 4 bất biến sau khi hồi phục (không đặt trùng, outbox = 0, cache == node, mỗi key ≤ 1 reservation).
- [ ] **GS-06.3** (2h) **[Trang + Huynh]** Chạy 3 lần; lỗi tìm được thì mở Issue và sửa.
- [ ] **GS-06.4** (2h) **[Trang]** Ghi kết quả vào báo cáo mục 10.

---

## D · Giao diện

### UX-03 · Hoàn thiện giao diện · Luân · 9h · Bắt buộc · **làm tuần 1**
- [ ] **UX-03.1** (2h) Component dùng chung: `Toast`, `Loading`, `ErrorBox`, `Badge` (ONLINE/OFFLINE/dữ liệu cũ), `ConfirmButton`.
- [ ] **UX-03.2** (1,5h) `api.js` xử lý lỗi thống nhất: 401 về trang đăng nhập; 503/504/409 hiện câu tiếng Việt dễ hiểu.
- [ ] **UX-03.3** (1h) Menu theo vai trò (USER / STAFF / ADMIN), logo, màu nhóm.
- [ ] **UX-03.4** (2h) Rà từng trang ở bề rộng 375px; sửa bố cục vỡ.
- [ ] **UX-03.5** (1h) **[Loan + Luân]** Thống nhất câu chữ tiếng Việt; không còn lỗi hiện dạng JSON thô.
- [ ] **UX-03.6** (1,5h) Viết `frontend/HUONG-DAN-UI.md` ngắn: cách dùng các component cho người làm việc khác.

### UX-01 · Bản đồ + tìm bãi gần nhất · Luân · 9h · Nên có
- [ ] **UX-01.1** (1h) Cột `lat`, `lng` trong `parking_nodes`; toạ độ thật cho A, B, C trong `NODES`; form thêm bãi có toạ độ; `/api/parkings` trả toạ độ.
- [ ] **UX-01.2** (2h) Cài `leaflet`, `react-leaflet`; trang Bản đồ với marker 3 bãi.
- [ ] **UX-01.3** (1h) Lấy vị trí bằng `navigator.geolocation`; bị từ chối thì mặc định trung tâm Hà Nội.
- [ ] **UX-01.4** (1h) Hàm haversine; danh sách bãi sắp theo khoảng cách, bỏ bãi hết chỗ/OFFLINE.
- [ ] **UX-01.5** (1,5h) Màu marker theo % chỗ trống, đổi realtime theo `SLOT_UPDATED` / `NODE_STATUS`.
- [ ] **UX-01.6** (1,5h) Bấm marker mở chi tiết bãi / đặt chỗ; kiểm trên điện thoại.
- [ ] **UX-01.7** (1h) **[Hiệp]** Chụp ảnh cho báo cáo mục 11.

### UX-02 · Thống kê cho quản trị · Luân · 13,5h · Nên có · *Cần trước: NV-03, NV-06*
- [ ] **UX-02.1** (2h) Node `GET /api/stats?from=&to=`: lượt vào theo giờ, số phiên, doanh thu, thời gian gửi trung bình, tỉ lệ lấp đầy.
- [ ] **UX-02.2** (1h) Test unit cho truy vấn thống kê với dữ liệu mẫu.
- [ ] **UX-02.3** (1,5h) Aggregator `GET /api/admin/stats`: gom song song, cộng dồn, trả `unavailable`; STAFF chỉ nhận bãi mình.
- [ ] **UX-02.4** (3h) Trang Thống kê: 4 thẻ số + biểu đồ cột theo giờ (CSS/SVG) + bảng theo bãi.
- [ ] **UX-02.5** (1h) Bộ chọn khoảng ngày (`<input type="date">`).
- [ ] **UX-02.6** (1h) Băng cảnh báo "Số liệu thiếu bãi B" khi có bãi OFFLINE.
- [ ] **UX-02.7** (2h) Script tạo dữ liệu mẫu (vài trăm phiên qua `barrier.mjs`) để biểu đồ có số liệu khi demo.
- [ ] **UX-02.8** (2h) **[Hiệp]** Kiểm khi B tắt; chụp ảnh cho báo cáo.

### UX-04 · Màn hình cổng bãi · Luân · 9h · Nếu kịp · *Cần trước: NV-05*
- [ ] **UX-04.1** (1,5h) Trang `/gate/:parkingId`: 2 nút lớn Xe vào / Xe ra, ô nhập mã tay.
- [ ] **UX-04.2** (2,5h) Quét QR bằng camera: `BarcodeDetector` nếu có, không thì `html5-qrcode`.
- [ ] **UX-04.3** (1,5h) Gọi thẳng node của bãi (`/api/gate/scan`), đăng nhập STAFF như PT-05.
- [ ] **UX-04.4** (1,5h) Màn hình kết quả: xanh (mời vào, số slot) / đỏ (lý do), âm thanh báo.
- [ ] **UX-04.5** (2h) **[Hiệp]** Thử trên điện thoại/máy tính bảng thật, chụp ảnh.

---

## E · Tài liệu và bảo vệ

### TL-01 · Sửa HLD và kế hoạch PDF · Hiệp · 4,5h · Bắt buộc · hạn 12/10
- [ ] **TL-01.1** (1h) Kế hoạch: sửa phân công 4 → 6 người.
- [ ] **TL-01.2** (1h) HLD: số lớp ở Câu 2; ghi rõ cache Aggregator chỉ đọc; đổi "phân mảnh dọc" thành "tách bảng trong site".
- [ ] **TL-01.3** (0,5h) HLD Câu 3: sửa câu CAP.
- [ ] **TL-01.4** (0,5h) Ghi hạn chế điểm tập trung (sẽ bỏ dòng "nhân viên qua Aggregator" sau PT-05).
- [ ] **TL-01.5** (1h) Xuất lại PDF, thay vào `tai-lieu/`, tick checklist trong README.

### TL-02 · Sơ đồ kiến trúc bản hoàn chỉnh · Hiệp · 4,5h · Bắt buộc · hạn 26/10
- [ ] **TL-02.1** (1h) Phác tay các thành phần mới, gửi Huynh duyệt.
- [ ] **TL-02.2** (2h) Vẽ draw.io (giữ kiểu vẽ tay của nhóm): nginx LB → 2 Aggregator, cụm RabbitMQ 3 nút, DB A + replica, notification, Prometheus/Grafana, toxiproxy nét đứt.
- [ ] **TL-02.3** (0,5h) Xuất PNG/SVG vào `so-do/`.
- [ ] **TL-02.4** (1h) Vẽ thêm sơ đồ luồng nghiệp vụ: đặt → QR → vào → phí → thanh toán → ra.

### TL-03 · Báo cáo cuối kì · Hiệp ghép · 18h · Bắt buộc · nháp 02/11, xong 07/11
- [ ] **TL-03.1** (2h) Khung báo cáo (12 mục + phụ lục theo plan mục 11.1), mẫu trình bày, gửi mọi người 22/10.
- [ ] **TL-03.2** (2h) Viết mục 1, 4, 12 (phần của Hiệp).
- [ ] **TL-03.3** (mỗi người 3–4h) Mỗi người viết phần mình 1–3 trang + ảnh, nộp Hiệp **trước 02/11**.
- [ ] **TL-03.4** (4h) Ghép, thống nhất văn phong, đánh số hình/bảng.
- [ ] **TL-03.5** (3h) Phụ lục: hướng dẫn chạy, danh sách API, bảng TC01–TC55 (đạt/không đạt).
- [ ] **TL-03.6** (2h) Mục lục, tài liệu tham khảo; Huynh đọc duyệt.
- [ ] **TL-03.7** (1h) Sửa theo góp ý buổi tập demo 06/11, xuất PDF cuối.

### TL-04 · Slide + kịch bản demo · Hiệp + Huynh · 9h · Bắt buộc · hạn 07/11
- [ ] **TL-04.1** (4h) Hiệp: slide khoảng 15 trang theo plan mục 11.2.
- [ ] **TL-04.2** (2h) Huynh: cập nhật kịch bản demo (plan mục 10) theo những gì thực sự đã xong; thêm lệnh copy-paste sẵn vào `tai-lieu/kich-ban-demo.md`.
- [ ] **TL-04.3** (2h) Quay video demo dự phòng toàn bộ kịch bản (06/11).
- [ ] **TL-04.4** (1h) Chia ai nói slide nào, ai thao tác demo bước nào.

### TL-05 · Tập vấn đáp · Cả nhóm · 4,5h/người · Bắt buộc · hạn 09/11
- [ ] **TL-05.1** (1h) Mỗi người tự viết câu trả lời cho dòng "Nói" của các việc mình làm.
- [ ] **TL-05.2** (1,5h) Học 10 câu chung + câu có tên mình ở plan mục 11.3.
- [ ] **TL-05.3** (2h) Buổi hỏi chéo 08/11: mỗi người hỏi người khác 3 câu, ghi câu trả lời yếu để bổ sung.

---

## Z · Chạy nước rút và bảo vệ (03–09/11)

- [ ] **Z.1** (Trang) Chạy GS-05/GS-06 lần cuối trên `main`, cập nhật số liệu báo cáo.
- [ ] **Z.2** (Huynh) Merge `dev` → `main` lần cuối; gắn tag `v1.0`.
- [ ] **Z.3** (Huynh) Cập nhật README: cách chạy bản hoàn chỉnh, các profile, tài khoản, lệnh demo.
- [ ] **Z.4** (Trang) Chuẩn bị máy demo: `.env` khoá thật, build sẵn image, chạy được khi không có mạng.
- [ ] **Z.5** (Trang) Chuẩn bị máy dự phòng (clone + build sẵn).
- [ ] **Z.6** (Cả nhóm) 06/11: tập demo lần 1, bấm giờ, ghi lỗi.
- [ ] **Z.7** (Người phụ trách) Sửa lỗi từ buổi tập 1.
- [ ] **Z.8** (Cả nhóm) 08/11: tập demo lần 2 + hỏi chéo (TL-05.3).
- [ ] **Z.9** (Trang) 09/11: chạy e2e trên máy demo, đạt hết.
- [ ] **Z.10** (Hiệp) In/nộp báo cáo, slide theo yêu cầu của giảng viên.

---

## Việc lặp lại hằng tuần

- [ ] Thứ 2, 21:00: họp 30 phút (Huynh cập nhật board).
- [ ] Chủ nhật, 21:00: demo nội bộ, quyết định merge `dev` → `main`.
- [ ] Mỗi ngày làm: `git pull origin dev` vào nhánh đang làm.
- [ ] Mỗi PR: 1 người review (Luân cho giao diện, Hùng cho `schema.sql`), CI xanh mới merge.
- [ ] Vướng quá 2 giờ thì hỏi trong nhóm chat.
