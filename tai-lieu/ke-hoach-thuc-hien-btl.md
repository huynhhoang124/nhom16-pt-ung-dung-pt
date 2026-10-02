# Kế hoạch thực hiện BTL cuối kì – Nhóm 16
**Đề tài:** Bãi đỗ xe thông minh liên kết nhiều bãi · **Môn:** Hệ thống / Ứng dụng phân tán – PTIT
**Cập nhật:** 02/10/2026 · **Người soạn:** Hoàng Văn Huynh (code do Claude viết, cả nhóm review)

> Mọi người đọc mục 1–3 trước (10 phút). Mục 4 là việc của từng người. Mục 6 là kịch bản demo cả nhóm phải thuộc.

---

## 1. Hiện trạng: hệ thống đã chạy được

Code nằm trên nhánh **`dev`** của repo https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt (sẽ gộp vào `main` bằng PR).

| Phần | Trạng thái | Kiểm chứng |
|---|---|---|
| Parking Node (slot, đặt chỗ, xe vào/ra, huỷ, hết hạn, khoá bảo trì) | ✅ xong | 14 test |
| Outbox → RabbitMQ (relay, tự kết nối lại) | ✅ xong | có trong 14 test trên |
| Aggregator (định tuyến, tra cứu song song, health check, JWT, đối soát, realtime) | ✅ xong | 11 test |
| Frontend React (đăng nhập, tổng quan, chi tiết bãi, đặt chỗ, nhân viên, quản trị) | ✅ xong | đã chạy thử trên trình duyệt, cả màn hình điện thoại |
| Docker Compose (11 container) | ✅ chạy được | `docker compose up` |
| Test toàn hệ thống trên Docker | ✅ 9/9 đạt | Postgres + RabbitMQ thật |
| Tài liệu hướng dẫn chạy, báo cáo, slide | ⏳ đang làm | mục 4–5 |

**Test e2e đã bắt được 1 lỗi thật và đã sửa:** hai request đặt chỗ cùng `Idempotency-Key` chạy song song, request chờ khoá nhận 409 thay vì kết quả của chính lượt đặt đó. Đây là ví dụ hay để kể khi bảo vệ (vì sao phải test trên DB thật với nhiều kết nối).

---

## 2. Kiến trúc (thuộc lòng sơ đồ này)

```
Trình duyệt (React, :3000)
   │ REST + WebSocket (Socket.IO)
Aggregator (:8000) ── DB Aggregator (danh sách bãi, tài khoản)
   │ HTTP + khoá nội bộ            ▲ nhận sự kiện (queue aggregator.slot-updates)
   ▼                               │
Parking Node A/B/C (:8001–8003) ── relay ──► RabbitMQ (exchange parking.events, UI :15672)
   │
DB A / DB B / DB C  (mỗi bãi 1 Postgres riêng; bảng parking_events = outbox)
```

**5 ý phải nói được khi bảo vệ:**
1. **Dữ liệu phân tán thật:** mỗi bãi một DB riêng; node A không có địa chỉ DB của B (có test chứng minh).
2. **Chống đặt trùng:** một câu `UPDATE … WHERE status='AVAILABLE'` trong giao dịch của DB bãi, thêm unique index "mỗi slot tối đa 1 đặt chỗ ACTIVE". Không cần 2PC vì mỗi lượt đặt chỉ chạm một DB.
3. **Chịu lỗi:** health check 5 giây, OFFLINE sau 3 lần lỗi liên tiếp. Bãi OFFLINE thì đặt chỗ bị từ chối ngay (503), tra cứu vẫn trả các bãi còn lại. Bãi sống lại thì Aggregator đối soát.
4. **Không mất sự kiện:** ghi sự kiện vào bảng `parking_events` cùng giao dịch (Transactional Outbox) rồi relay mới gửi lên RabbitMQ. Broker hay Aggregator tắt thì tin nằm chờ, bật lại thì gửi tiếp. Tin trùng/cũ bị bỏ nhờ `version` của từng slot.
5. **Mạng chập chờn khi đặt chỗ:** Aggregator timeout trả 504 "chưa rõ kết quả". Người dùng bấm "Thử lại" với cùng `Idempotency-Key`, không bao giờ bị đặt hai lần.

Lý thuyết đầy đủ: `tai-lieu/ly-thuyet-ap-dung-xuyen-suot.md` (§6 có 10 câu vấn đáp mẫu).

---

## 3. Cách chạy trên máy mình (mỗi người phải tự chạy được)

**Cần:** Docker Desktop (đang bật), Git, Node.js ≥ 20 (chỉ để chạy test).

```bash
git clone https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt.git
cd nhom16-pt-ung-dung-pt
git checkout dev
docker compose up -d --build        # lần đầu 3–5 phút (tải image)
```

| Địa chỉ | Là gì |
|---|---|
| http://localhost:3000 | Web (đăng nhập bên dưới) |
| http://localhost:15672 | RabbitMQ (parking / parking) |
| http://localhost:8000 | Aggregator API |
| http://localhost:8001 / 8002 / 8003 | Parking Node A / B / C |

**Tài khoản demo** (mật khẩu `123456`): `user1`, `user2` (người dùng) · `staff-a`, `staff-b`, `staff-c` (nhân viên từng bãi) · `admin` (quản trị).

**Chạy test:**
```bash
cd parking-node && npm install && npm test                 # 14 test, không cần Docker
cd ../aggregator-service && npm install && npm test        # 11 test, cần đã npm install parking-node
cd ../frontend && npm install && cd ..
node --test tests/e2e.test.mjs                             # 9 test trên Docker (khoảng 45 giây)
```

**Dừng / xoá sạch dữ liệu:** `docker compose down` (giữ dữ liệu) · `docker compose down -v` (xoá hết, chạy lại từ đầu).

---

## 4. Phân công: ai đọc gì, review gì, trình bày gì

Code đã viết xong. Việc của mỗi người là **hiểu kỹ phần mình, review, tự chạy, viết phần báo cáo tương ứng và trả lời được câu hỏi** về phần đó.

| Thành viên | Phần phụ trách | File cần đọc kỹ | Viết trong báo cáo | Câu hỏi phải trả lời được |
|---|---|---|---|---|
| **Vũ Văn Hùng** | Parking Node + DB | `parking-node/src/slots.js`, `schema.sql`, `app.js` | Thiết kế DB, xử lý tương tranh | Vì sao 20 người cùng đặt chỉ 1 người được? Vì sao không cần 2PC? |
| **Hoàng Văn Huynh** | Aggregator + điều phối | `aggregator-service/src/nodes.js`, `routes.js`, `auth.js` | Kiến trúc, định tuyến, tra cứu song song, bảo mật | Health check báo nhầm thì sao? Timeout khi đặt chỗ thì sao? |
| **Nguyễn Văn Luân** | Frontend | `frontend/src/pages/*.jsx`, `api.js` | Giao diện, realtime phía người dùng | Màn hình cập nhật realtime thế nào? Nút "Thử lại" an toàn vì sao? |
| **Trịnh Kim Loan** | Outbox + RabbitMQ + đối soát | `parking-node/src/relay.js`, `aggregator-service/src/events.js` | Luồng sự kiện, chống mất/trùng tin | Broker tắt thì tin đi đâu? Tin đến sai thứ tự thì sao? |
| **Đỗ Huyền Trang** | Docker, demo, test e2e | `docker-compose.yml`, `tests/e2e.test.mjs`, `scripts/barrier.mjs` | Triển khai, kiểm thử | Chứng minh dữ liệu phân tán thật thế nào? Demo tắt bãi B ra sao? |
| **Phạm Sỹ Hiệp** | Báo cáo + slide + sửa HLD | `tai-lieu/*` | Ghép báo cáo, mở đầu/kết luận, sửa HLD theo checklist mục 7 | CAP của hệ thống? Hạn chế và hướng mở rộng? |

**Cách review:** đọc code trên GitHub (nhánh `dev`). Chỗ nào không hiểu thì ghi câu hỏi vào nhóm chat hoặc comment trên PR. Comment trong code đều bằng tiếng Việt.

---

## 5. Lịch theo tuần

| Tuần | Thời gian | Việc chung | Mốc phải xong |
|---|---|---|---|
| 1 | 03/10 – 09/10 | Mỗi người cài Docker và chạy được hệ thống (mục 3), đọc mục 2 | Cả 6 người chụp màn hình web chạy trên máy mình gửi nhóm |
| 2 | 10/10 – 16/10 | Đọc kỹ phần mình (mục 4), ghi câu hỏi; Huynh tổng hợp và giải đáp | Mỗi người giải thích được phần mình trong 3 phút |
| 3 | 17/10 – 23/10 | Viết phần báo cáo của mình (1–3 trang) gửi Hiệp; Hiệp sửa HLD | Bản nháp báo cáo đủ các mục |
| 4 | 24/10 – 30/10 | Ghép báo cáo + slide; tập demo (mục 6) ít nhất 2 lần cả nhóm | Báo cáo + slide hoàn chỉnh; demo chạy trơn |
| 5+ | từ 31/10 | Dự phòng: sửa lỗi, tập vấn đáp (10 câu ở `ly-thuyet-ap-dung-xuyen-suot.md` §6) | Sẵn sàng bảo vệ |

Phần code còn lại (Claude làm, tuần 1): README hướng dẫn chạy, cập nhật tài liệu `ap-dung-vao-btl.md` theo bản đã chạy, mở PR gộp `dev` → `main`.

---

## 6. Kịch bản demo khi bảo vệ (khoảng 10 phút)

Chuẩn bị: `docker compose up -d`, mở 2 cửa sổ trình duyệt (một `user1`, một `staff-a`), một terminal, và sẵn trang RabbitMQ.

| # | Làm | Nói |
|---|---|---|
| 1 | Mở trang Tổng quan: 3 bãi, số chỗ trống | "3 bãi, 3 DB riêng, người dùng chỉ thấy một hệ thống: tính trong suốt." |
| 2 | `staff-a` bấm slot A01 → "Xe vào"; cửa sổ `user1` đổi ngay | "Node ghi DB và sự kiện cùng một giao dịch (outbox), relay đẩy lên RabbitMQ, Aggregator đẩy WebSocket." |
| 3 | Terminal: `node scripts/barrier.mjs A A02 enter` | "Barrier gọi thẳng node của bãi, xe vào/ra không phụ thuộc trung tâm." |
| 4 | `user1` đặt B05. Mở tab thứ hai cũng đặt B05 | "Chỉ một người thành công: UPDATE có điều kiện trong một DB, không cần 2PC." |
| 5 | Terminal: `docker compose stop parking-b`, chờ khoảng 15 giây | "Health check 3 lần lỗi thì OFFLINE. A, C vẫn chạy; đặt chỗ ở B bị từ chối (chọn nhất quán); xem B vẫn thấy dữ liệu cũ có cảnh báo (chọn sẵn sàng): CAP khi có phân vùng mạng." |
| 6 | `docker compose start parking-b` | "B ONLINE lại, Aggregator đối soát, dữ liệu khớp." |
| 7 | `docker compose stop aggregator`, chạy barrier ở bãi A, xem queue trên RabbitMQ có tin, rồi `start aggregator` | "Trung tâm tắt thì bãi vẫn chạy; sự kiện chờ trong queue, bật lại thì xử lý hết." |
| 8 *(nếu còn giờ)* | `docker compose --profile extra up -d`; `admin` thêm bãi D (`http://parking-d:8004`) | "Thêm bãi mới không sửa code: tính mở rộng." |

Dự phòng nếu demo lỗi: chạy `node --test tests/e2e.test.mjs` cho xem 9 test đạt.

---

## 7. Checklist trước buổi bảo vệ

**Tài liệu (Hiệp chính, mọi người góp)**
- [ ] Kế hoạch 33 trang: sửa phân công 4 → 6 người theo mục 4.
- [ ] HLD Câu 2: ghi "bốn lớp" nhưng bảng có 6 dòng → sửa cho khớp.
- [ ] HLD: Aggregator "không giữ dữ liệu slot" nhưng có "trạng thái tổng hợp" → ghi rõ: cache trong RAM chỉ để đọc, nguồn gốc ở DB bãi.
- [ ] HLD: "phân mảnh dọc SLOT_DEF/SLOT_STATE" → thực tế là tách bảng trong một site.
- [ ] HLD Câu 3: câu CAP sửa thành "chỉ phải chọn khi có phân vùng mạng: ghi chọn nhất quán, đọc chọn sẵn sàng".
- [ ] Ghi hạn chế: Aggregator, DB Aggregator, RabbitMQ là điểm tập trung; nhân viên thao tác qua Aggregator.
- [ ] Báo cáo có ảnh chụp: tổng quan, bãi OFFLINE, RabbitMQ queue, kết quả test.

**Kỹ thuật (Trang chính)**
- [ ] Máy demo chạy `docker compose up` thành công **trước buổi bảo vệ 1 ngày**.
- [ ] Tải sẵn image (không phụ thuộc mạng phòng thi).
- [ ] Chạy e2e 9/9 đạt trên máy demo.
- [ ] Tập kịch bản mục 6 hai lần.

**Mỗi người**
- [ ] Tự chạy được hệ thống trên máy mình.
- [ ] Trả lời được câu hỏi ở cột cuối mục 4.

---

## 8. Rủi ro và cách xử lý

| Rủi ro | Cách xử lý |
|---|---|
| Máy yếu, Docker chạy chậm | 11 container cần khoảng 2 GB RAM; tắt bớt ứng dụng khác. Demo trên máy khoẻ nhất nhóm. |
| Cổng 3000/8000/5432… bị chiếm | Tắt ứng dụng đang dùng cổng đó, hoặc báo Huynh để đổi cổng trong `docker-compose.yml`. |
| Mất mạng phòng thi | Đã build sẵn image, hệ thống chạy offline hoàn toàn. |
| Thành viên chưa hiểu phần mình | Tuần 2 Huynh tổ chức buổi giải đáp, đi qua code từng phần. |
| Demo lỗi giữa chừng | `docker compose down && docker compose up -d`; dự phòng chạy test e2e. |

---

## Tài liệu liên quan trong repo
- `tai-lieu/ly-thuyet-ap-dung-xuyen-suot.md`: lý thuyết theo từng kịch bản, 10 câu vấn đáp
- `tai-lieu/ap-dung-vao-btl.md`: thiết kế chi tiết (schema, API, test case)
- `tai-lieu/Nhom16_Mo_hinh_HLD.pdf`, `tai-lieu/Ke_hoach_trien_khai.pdf`: tài liệu đã nộp
