# Lý thuyết Ứng dụng phân tán – áp dụng xuyên suốt đề tài Bãi đỗ xe thông minh (Nhóm 16)

**Cách dùng:** đọc theo thứ tự §0 → §3. Mỗi kịch bản đi hết một luồng chạy của hệ thống; ở **từng bước** có ghi *lý thuyết nào đang tác động*, *quyết định thiết kế*, *nếu làm sai thì hỏng gì*. §4 là tra cứu nhanh lý thuyết lõi, §5–§6 để ôn vấn đáp.

**Độ tin cậy nguồn:** lý thuyết lõi lấy từ **Kleppmann, *Distributed Systems* (Cambridge 2021/22)** (đã đọc bài 1–7 và phần CRDT của bài 8) và **microservices.io (Transactional Outbox)**. Các mục đánh dấu *(chung)* (Saga, PACELC, chi tiết RabbitMQ, chi tiết SQL) là kiến thức chung của người viết, chưa đối chiếu nguồn. Đoạn SQL chỉ để **minh hoạ ý**, chưa chạy thử trên DB nào.

---

## 0. Khai báo mô hình hệ thống (bước đầu tiên của mọi thiết kế phân tán)

Thuật toán phân tán chỉ đúng *dưới một giả định*. Nhóm nên ghi rõ vào báo cáo:

| Thành phần | Giả định của đồ án | Hệ quả thiết kế |
|---|---|---|
| **Mạng** (Aggregator↔Node, Node↔Broker) | *Fair-loss*: tin có thể mất/trùng/đảo thứ tự, thử lại thì rốt cuộc tới | Phải có **retry + khử trùng**; không tin "gửi rồi là tới" |
| **Node** (Parking Node, Aggregator, Broker) | *Crash-recovery*: chết, mất RAM, sống lại, **dữ liệu trên đĩa còn** | Trạng thái quan trọng phải ghi **DB trước**; RAM chỉ là cache |
| **Thời gian** | *Partially synchronous*: thường nhanh, đôi lúc trễ/đứng (GC, tải, mạng) | Dùng **timeout** nhưng không coi timeout là sự thật; an toàn không được phụ thuộc thời gian |
| **Tin cậy** | Các thành phần tin nhau (không Byzantine) | Chỉ cần xác thực USER/STAFF/ADMIN ở biên, không cần chịu node phản bội |

> Vì sao quan trọng: nếu giả định "synchronous" thì health check sẽ không bao giờ sai; thực tế sai, nên mọi quyết định "OFFLINE", "timeout" bên dưới đều phải *chịu được việc phát hiện nhầm*.

---

## 1. Bản đồ hệ thống (để gắn nhãn cho các kịch bản)

```
 [C] Client: USER / STAFF / ADMIN  (React, HTTP + WebSocket)
        │  REST/JSON            ▲ WebSocket (đẩy realtime)
        ▼                       │
 [G] Aggregator ── [D] DB Aggregator (danh sách node, tài khoản, vai trò)
        │   ▲
 HTTP   │   │ AMQP subscribe
        ▼   │
 [M] Message Broker (AMQP, RabbitMQ)
        ▲  publish
 ┌──────┴────────┬────────────────┐
 [A] Site A      [B] Site B       [C'] Site C     (mỗi site độc lập, shared-nothing)
  Node + DB riêng + bảng events (outbox) + Barrier/cảm biến → gọi Node bằng HTTP
```
Từ đây gọi: **G** = Aggregator, **D** = DB Aggregator, **M** = Broker, **Node-X** = node của bãi X.

**Điểm tập trung (SPOF):** G, D, M. **Điểm phân tán:** dữ liệu (shard theo `parking_id`), xử lý (Node), triển khai (site), luồng tin (M).

---

## 2. Ma trận: khái niệm lý thuyết → xuất hiện ở đâu

| Khái niệm lý thuyết | Kịch bản (§3) | Thành phần |
|---|---|---|
| Partial failure, fault vs failure, SPOF | S1, S5, S7 | G, D, M, mỗi Node |
| Failure detector (eventually perfect) | S1, S5, S6 | Health check ở G |
| Hai tướng quân / RPC không biết kết quả | S2 | G → Node (timeout) |
| Retry, at-least-once, **idempotent**, exactly-once | S2, S4 | Client→G→Node, relay→M→G |
| Sharding ngang (khác replication) | S2, S7 | D (bảng định tuyến), DB từng site |
| Giao dịch cục bộ, atomic update, linearizable trong 1 bản | S2, S3 | DB từng site |
| 2PC / Saga (và vì sao **không cần**) | S2, S8 | — |
| Transactional Outbox, dual write | S4, S6 | bảng `events` + relay |
| Pub/Sub, thứ tự FIFO, receive vs deliver | S4 | M, G |
| Lamport/thứ tự sự kiện, `version` per-slot | S4 | `slot.version` |
| Đồng hồ vật lý, monotonic, skew | S1, S2, S5 | timeout, hết hạn đặt chỗ |
| CAP / PACELC | S1, S2, S5 | cả hệ thống |
| Eventual consistency, anti-entropy, state-based merge | S4, S6 | cache ở G, đối soát |
| Quorum, replication, Raft | S7, S8 | (hướng mở rộng) |

---

## 3. Các kịch bản xuyên suốt

### S1. Tra cứu chỗ trống toàn hệ thống

| # | Chuyện xảy ra | Lý thuyết tác động | Quyết định / lý do |
|---|---|---|---|
| 1 | USER gọi `GET /slots` tới **G** (xác thực, lấy danh sách node từ **D**) | *Location transparency*: user không biết bãi nằm ở node nào | G là điểm vào duy nhất; che vị trí dữ liệu |
| 2 | G gửi **song song** tới Node-A, B, C | *Scatter–gather*; gọi tuần tự thì chậm theo node chậm nhất cộng dồn | Song song + **timeout riêng** |
| 3 | Node-C không trả lời kịp | **Partial failure** + *failure detector*: không phân biệt được C **chết / chậm / tin mất / tin trễ** | Bỏ qua C, **không** chờ vô hạn |
| 4 | G trả kết quả A, B + `C: OFFLINE` | **CAP**: lúc này chọn **Availability** cho thao tác đọc; kết quả là **eventual/stale** | *Kết quả một phần có nhãn* tốt hơn lỗi toàn cục |
| 5 | Timeout đo bằng gì? | *Monotonic clock* (đo khoảng thời gian trên **một** máy), không dùng giờ lệch/nhảy (NTP step) | Dùng đồng hồ monotonic của runtime (vd `performance.now()`/`time.monotonic()`) |

**Nếu làm sai:** chờ mọi node → một node chậm kéo cả hệ thống chậm (mất lợi ích phân tán). Không gắn nhãn → user tưởng bãi C hết chỗ trong khi thật ra không biết.
**Lưu ý trung thực:** `OFFLINE` có thể là **báo nhầm** (xem S5).

---

### S2. Đặt chỗ (luồng quan trọng nhất)

| # | Chuyện xảy ra | Lý thuyết tác động | Quyết định / lý do |
|---|---|---|---|
| 1 | Client gửi `POST /reservations` kèm **`request_id`** (UUID sinh ở client) | **Idempotency key**: để *retry an toàn* | Cột `request_id` có ràng buộc **UNIQUE** |
| 2 | G tra D xem slot thuộc bãi nào, rồi **định tuyến thẳng** tới Node-B (không đi qua bãi khác) | **Sharding ngang theo `parking_id`**; yêu cầu một bãi → một node | Giữ yêu cầu nằm trong **một shard** |
| 3 | Node-B thực hiện **một giao dịch cục bộ** (chèn reservation, cập nhật slot, ghi `events`) | **Atomicity** trong 1 DB; *linearizable* vì chỉ có **một bản** dữ liệu | Không cần 2PC (không có giao dịch xuyên site) |
| 4 | Hai người cùng đặt một slot | **Race condition** → *compare-and-swap* cục bộ | `UPDATE … WHERE state='FREE'` rồi kiểm tra số dòng bị ảnh hưởng |
| 5 | Node trả `201`; nhưng **mạng chập chờn, G không nhận được** → G timeout | **Hai tướng quân / RPC**: G **không biết** Node đã commit hay chưa | **Không** báo "thất bại" vội, **không** coi là chưa đặt |
| 6 | Client/G **retry** với cùng `request_id` | **At-least-once + idempotent = exactly-once về hiệu quả** | Lần 2 bị `UNIQUE` chặn → trả **kết quả của lần 1**; hoặc cho `GET /reservations?request_id=` để hỏi lại trạng thái |
| 7 | Node-B OFFLINE (health check) | **CAP: chọn Consistency** cho ghi | **Từ chối** ngay, không xếp hàng ngầm (xếp hàng ngầm → đặt chỗ "ma" khi B sống lại) |

Minh hoạ ý (chưa chạy, PostgreSQL):
```sql
BEGIN;
INSERT INTO reservations(request_id, slot_id, user_id, status)
VALUES ($req, $slot, $user, 'ACTIVE')
ON CONFLICT (request_id) DO NOTHING;      -- retry: không chèn lần 2
-- nếu 0 dòng được chèn → đã xử lý trước đó: ROLLBACK và trả kết quả cũ

UPDATE slot_state SET state='RESERVED', version=version+1
WHERE slot_id=$slot AND state='FREE';     -- atomic CAS
-- nếu 0 dòng bị ảnh hưởng → slot đã bị người khác lấy: ROLLBACK, trả 409

INSERT INTO events(type, slot_id, version, payload)   -- outbox, cùng giao dịch (xem S4)
VALUES ('SLOT_UPDATED', $slot, $newVersion, $json);
COMMIT;
```

**Câu hỏi hay gặp:** *"Vì sao không cần 2PC?"* → Một lượt đặt chỗ chỉ chạm **một DB**, nên là giao dịch cục bộ. 2PC chỉ cần khi giao dịch phủ **nhiều node**; mà 2PC còn **chặn** (nếu coordinator sập sau prepare thì participant kẹt giữ khoá) — nên tránh được là lợi lớn của phân mảnh theo bãi. Nếu sau này có *"đặt combo nhiều bãi"* thì mới cần **Saga** *(chung)*: đặt A, rồi B, B lỗi thì chạy bước bù trừ huỷ A.

**Hết hạn đặt chỗ:** tính theo **đồng hồ của chính Node-B** (một nguồn duy nhất), vì timestamp vật lý giữa các máy có thể lệch/trái nhân quả. Không tin giờ do client gửi lên.

---

### S3. Xe vào/ra qua Barrier

| # | Chuyện xảy ra | Lý thuyết tác động | Quyết định / lý do |
|---|---|---|---|
| 1 | Cảm biến/Barrier gọi **chỉ** Node của bãi mình qua HTTP | Phân tán *thiết bị*; **cô lập lỗi theo bãi** | Xe vào/ra không phụ thuộc mạng lên trung tâm → B mất kết nối vẫn cho xe qua |
| 2 | Node ghi DB bãi **trước**, rồi mới trả barrier mở | **Crash-recovery**: RAM mất khi sập, đĩa còn | Ghi bền trước, phản hồi sau |
| 3 | Barrier gọi trùng (thiết bị retry) | **Idempotent** | Mỗi lần quét có `scan_id`/sự kiện duy nhất |
| 4 | STAFF xác nhận xe qua giao diện → **G** → Node | G là **SPOF** cho đường này | **Hạn chế đã ghi trong README**: hoặc cho STAFF gọi thẳng Node, hoặc ghi rõ là hạn chế |

---

### S4. Sự kiện realtime (Node → Broker → Aggregator → WebSocket)

Đây là chỗ lý thuyết dày nhất.

| # | Chuyện xảy ra | Lý thuyết tác động | Quyết định / lý do |
|---|---|---|---|
| 1 | Node cần vừa **ghi DB** vừa **publish lên M** | **Dual write problem**: hai việc không nguyên tử. Commit xong chết trước publish → **mất sự kiện**; publish xong DB rollback → **sự kiện ma** | **Transactional Outbox**: ghi `events` **cùng giao dịch** với dữ liệu (xem SQL S2) |
| 2 | *Relay* đọc bảng `events` chưa gửi, publish lên M, rồi đánh dấu đã gửi | *Polling publisher* (hoặc log tailing); **at-least-once** | Relay chết giữa publish và đánh dấu → **gửi trùng** |
| 3 | M chuyển tin tới G (Pub/Sub); node không cần biết ai đang nghe | **Decoupling**; broker làm *middleware phát tin* | Hàng đợi giữ tin khi G tạm chết (queue `durable`, ack thủ công) *(chung)* |
| 4 | G nhận tin trùng | **Idempotent consumer** | G lưu `event_id` đã xử lý, bỏ qua trùng |
| 5 | Hai sự kiện của cùng slot **đến sai thứ tự** (reliable link cho phép đảo thứ tự) | **Thứ tự sự kiện / Lamport**: cần số logic nhân quả | `slot.version` do **Node** tăng trong giao dịch; G chỉ áp tin có `version` **lớn hơn** bản đang giữ |
| 6 | G đẩy xuống client qua WebSocket | *Eventual consistency* giữa DB bãi và màn hình | Màn hình có thể trễ chút; nguồn sự thật luôn là **DB bãi** |

**Vì sao không cần vector clock / total order:** mỗi slot chỉ có **một người ghi** (Node chủ) → `version` tăng một chiều là đủ để sắp thứ tự (như Lamport trên một node). Total order broadcast/consensus chỉ cần khi *nhiều node cùng ghi một trạng thái chung*.

**Phân biệt nhận vs giao (receive vs deliver):** tin tới G chưa chắc phải đẩy ngay; nếu `version` thấp hơn thì **giữ lại/bỏ** thay vì giao cho client.

Minh hoạ ý relay (chưa chạy):
```sql
SELECT id, payload FROM events WHERE published_at IS NULL
ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED;   -- polling publisher
-- publish từng tin kèm publisher confirm; sau đó:
UPDATE events SET published_at = now() WHERE id = ANY($ids);
-- chết giữa 2 bước → lần sau publish lại (trùng) → consumer phải idempotent
```

---

### S5. Bãi B mất kết nối (kịch bản demo chính)

| # | Chuyện xảy ra | Lý thuyết tác động | Quyết định / lý do |
|---|---|---|---|
| 1 | G health-check B, không thấy trả lời trong timeout | **Failure detector** *eventually perfect*: có thể **đánh nhầm** (B chỉ chậm) | Đánh dấu OFFLINE sau **N lần liên tiếp** thất bại (giảm báo nhầm) — *gợi ý thiết kế* |
| 2 | Ghi/đặt chỗ ở B bị **từ chối** | **CAP: C hơn A** (cho ghi) | Báo lỗi ngay, không xếp hàng ngầm |
| 3 | Tra cứu trả A, C + `B: OFFLINE` | **CAP: A hơn C** (cho đọc) | Kết quả một phần có nhãn |
| 4 | A, C vẫn đặt chỗ, xe vào/ra bình thường | **Blast radius chỉ một site** nhờ *shared-nothing* | Đây là điểm cộng nhất của kiến trúc để trình bày |
| 5 | Nếu B thật ra vẫn chạy, chỉ đứt đường tới G | Barrier vẫn gọi Node-B cục bộ và xe vẫn vào/ra (S3) | Thiệt hại là *mất availability từ phía người dùng qua G*, **không** gây đặt trùng |

**Điểm ăn tiền:** dù detector báo nhầm, hệ thống vẫn **an toàn** (chỉ từ chối thừa), không bao giờ cho kết quả sai (không đặt trùng). Đó là khác biệt giữa *safety* và *liveness*: lỗi phát hiện chỉ làm giảm *liveness*.

---

### S6. Bãi B phục hồi

| # | Chuyện xảy ra | Lý thuyết tác động | Quyết định / lý do |
|---|---|---|---|
| 1 | B khởi động lại | **Crash-recovery**: RAM mất, **DB và bảng `events` còn** | Mọi trạng thái cần giữ phải nằm trong DB |
| 2 | Relay của B tiếp tục gửi các `events` chưa publish | **Outbox** không mất tin dù broker/G từng không với tới | Tin trễ nhưng **không mất**, có thể **trùng** → consumer idempotent |
| 3 | Health check thấy B sống lại | *Eventually perfect*: sau cùng đúng | Đổi trạng thái `ONLINE` |
| 4 | G **đối soát**: lấy snapshot slot từ Node-B và gộp vào cache | **Anti-entropy** / *state-based merge*: giữ bản có `version` lớn hơn cho từng slot | Phép gộp "lấy max version mỗi slot" là **giao hoán, kết hợp, idempotent** → áp nhiều lần vẫn đúng, không phụ thuộc thứ tự tin |
| 5 | Có xung đột ghi? | **Không**, vì chỉ Node-B ghi slot của B (một writer) | Không cần LWW (LWW sẽ mất dữ liệu khi ghi đồng thời) |
| 6 | Reservation bị huỷ trong lúc offline? | **Tombstone** (đánh dấu huỷ + version), đừng xoá cứng | Phân biệt "đã huỷ" với "chưa từng tạo" để đối soát đúng |

---

### S7. Mở rộng và chịu lỗi cho điểm tập trung

| Vấn đề | Lý thuyết | Hướng giải (HLD đã nêu "Hướng mở rộng") |
|---|---|---|
| Thêm bãi mới | Sharding: thêm shard | Thêm site + đăng ký vào D; không đụng dữ liệu bãi cũ |
| **G** sập | SPOF; G **không giữ trạng thái** nên nhân bản dễ | Nhiều bản G sau Load Balancer (stateless); cache chỉ-đọc |
| **D** sập | Cần **replication** (primary-backup hoặc quorum) | Bản sao DB điều phối; ghi qua leader, follower áp log theo thứ tự commit |
| **M** sập | Cluster broker | Cụm broker; RabbitMQ có quorum queue dùng Raft *(chung)* |
| Tự động chuyển leader | **Consensus/Raft**: quorum, term, tối đa một leader mỗi term | Chỉ nêu ở mức nguyên lý: n=3 chịu 1 node hỏng, n=5 chịu 2 |

---

### S8. "Nếu nhóm nhân bản DB mỗi bãi?" (câu hỏi vặn)

Hiện **không** nhân bản (shared-nothing). Nếu bị hỏi, biết sẽ đổi gì:
- Cần **quorum**: n replica, ghi w, đọc r, **r + w > n** thì đọc thấy ghi gần nhất. n=3, r=w=2 chịu 1 node hỏng.
- Quorum read/write **chưa chắc linearizable**; muốn vậy cần ABD (đọc xong ghi ngược) hoặc dùng leader + consensus. CAS (đặt chỗ) linearizable cần total-order/consensus.
- Lúc đó mới có **CAP đúng nghĩa**: partition → hoặc từ chối (C) hoặc trả bản cũ (A). Đồ án hiện tại: C trong site là hiển nhiên vì chỉ một bản.
- Chi phí tăng: độ trễ, phức tạp, và phải chọn giữa *LWW* (mất dữ liệu) hay *multi-value* (giữ xung đột).

---

## 4. Lý thuyết lõi cô đọng (tra cứu)

**Mô hình & lỗi**
- Mạng: reliable / fair-loss / arbitrary. Node: crash-stop / **crash-recovery** / Byzantine. Thời gian: synchronous / **partially synchronous** / asynchronous.
- **Hai tướng quân**: qua kênh mất tin không thể chắc chắn hai bên cùng hành động → không có tri thức chung ngoài việc gửi tin. Hành động *hoàn tác được* thì giải được bằng "hỏi lại trạng thái".
- **Failure detector**: gửi + timeout; không hoàn hảo trong hệ partially synchronous; chỉ có *eventually perfect*.
- **Availability**: 99% ≈ 3,7 ngày/năm chết; 99,9% ≈ 8,8 giờ; 99,99% ≈ 53 phút; 99,999% ≈ 5,3 phút. SLO (mục tiêu) vs SLA (hợp đồng).
- **Fault** (một phần hỏng) ≠ **failure** (cả hệ hỏng); **SPOF** = phần mà hỏng là cả hệ hỏng.

**Thời gian & thứ tự**
- Đồng hồ vật lý trôi (drift ~≤50 ppm ≈ 4 s/ngày), lệch (skew); NTP chỉ giảm chứ không triệt. Time-of-day clock có thể nhảy lùi; **monotonic** chỉ tiến, dùng đo khoảng thời gian trên **một** máy.
- **Happens-before (→)**: cùng node thì theo thứ tự; gửi → nhận; bắc cầu. Bán phần; không có đường tin thì **đồng thời**.
- **Lamport**: sự kiện `t+=1`; gửi kèm t; nhận `t=max(t,t')+1`. a→b ⇒ L(a)<L(b) (không ngược lại). **Vector clock** bắt được cả "đồng thời", tốn kích thước theo số node.
- Ví dụ: A gửi m1 lúc t=2; B nhận → max(0,2)+1=3; B gửi m2 → 4; C nhận → max(0,4)+1=5.

**Phát tin**
- FIFO < Causal < Total order < FIFO-total order. Total order không giao cho chính mình ngay được (phải chờ cả nhóm). Phân biệt *receive* và *deliver* (có thể phải buffer).

**Replication & nhất quán**
- Ngữ nghĩa gửi: at-most-once / at-least-once / **exactly-once = at-least-once + idempotent hoặc dedup**. Idempotent: `f(f(x))=f(x)` (thêm vào tập: có; `+1`: không).
- **Tombstone + timestamp**, **anti-entropy**, **read repair**. Ghi đồng thời: **LWW** (đơn giản, mất dữ liệu) hoặc multi-value.
- **Quorum**: r+w>n; đa số ⌊n/2⌋+1. **SMR**: mọi cập nhật qua total-order broadcast, áp xác định. Primary-backup.
- **State-based CRDT**: phép gộp giao hoán + kết hợp + idempotent ⇒ chịu mất/trùng tin. (Dùng cho đối soát S6.)

**Giao dịch & đồng thuận**
- **2PC**: prepare rồi commit/abort; coordinator sập sau prepare ⇒ participant **kẹt giữ khoá** (in-doubt). Khác consensus: phải chờ **tất cả** node.
- **Saga** *(chung)*: chuỗi giao dịch cục bộ + bước bù trừ.
- **Consensus ≡ total-order broadcast**. **FLP**: bất đồng bộ + có thể crash ⇒ không đảm bảo kết thúc; thực tế dùng timeout (an toàn không phụ thuộc thời gian, *liveness* mới phụ thuộc).
- **Raft**: Follower/Candidate/Leader; term tăng mỗi lần bầu; mỗi node một phiếu mỗi term ⇒ tối đa một leader mỗi term; leader phải được quorum xác nhận mỗi quyết định; chịu f lỗi với 2f+1 node.

**Nhất quán mô hình**
- **Linearizability** = như chỉ có một bản dữ liệu, theo *thời gian thực* (≠ serializability). **CAP** đúng: **khi có partition** mới phải chọn linearizable *hoặc* available; "chọn 2 trong 3" gây hiểu lầm. **PACELC** *(chung)*: nếu P thì A/C, **E**lse thì Latency/C.
- **Eventual consistency**; **strong eventual consistency** = mọi replica nhận đủ cập nhật + cùng tập cập nhật ⇒ cùng trạng thái.

**Outbox (microservices.io):** ghi dữ liệu + bản tin cùng một giao dịch DB; relay (polling hoặc log tailing) publish sau; có thể trùng ⇒ consumer idempotent.

**RabbitMQ *(chung)*:** Producer → Exchange (direct/fanout/topic) → Queue → Consumer; ack thủ công; queue `durable` + message `persistent`; publisher confirms; prefetch (QoS); dead-letter exchange.

---

## 5. Từ quyết định thiết kế → lý thuyết (để giải thích "vì sao")

| Quyết định trong HLD | Lý thuyết đứng sau | Kịch bản |
|---|---|---|
| Mỗi bãi 1 DB riêng | Shared-nothing, sharding, cô lập lỗi | S2, S5 |
| Aggregator là điểm vào duy nhất | Location transparency; (đổi lại: SPOF) | S1, S7 |
| Định tuyến thẳng tới node | Giữ yêu cầu trong một shard → giao dịch cục bộ | S2 |
| Không dùng 2PC | 2PC chặn + không có giao dịch xuyên site | S2 |
| Scatter–gather + timeout | Partial failure, availability cho đọc | S1 |
| Kết quả một phần + `OFFLINE` | CAP (A cho đọc), eventual consistency | S1, S5 |
| Từ chối ghi khi node OFFLINE | CAP (C cho ghi), tránh đặt chỗ ma | S5 |
| Bảng `events` rồi mới publish | Transactional Outbox, dual write | S4 |
| Pub/Sub qua Broker | Decoupling, at-least-once | S4 |
| Node phục hồi → đối soát | Anti-entropy, state-based merge | S6 |
| Health check từng node | Failure detector (eventually perfect) | S1, S5, S6 |
| Role USER/STAFF/ADMIN ở Aggregator | Bảo mật ở biên (không Byzantine trong nội bộ) | S3 |

---

## 6. Vấn đáp xuyên suốt (hướng trả lời ngắn)

1. **Vì sao phân tán?** Dữ liệu và nghiệp vụ sinh ra tại bãi; cô lập lỗi (S5); mở rộng theo bãi (S7). Cái giá: mạng/node lỗi bất định → timeout, health check, kết quả một phần.
2. **Chống đặt trùng thế nào?** Atomic update trong **một DB** (S2 bước 4). Không cần 2PC vì không xuyên site.
3. **Timeout giữa G và Node thì sao?** Không biết đã commit hay chưa (hai tướng quân) → retry với `request_id`, `UNIQUE` chặn lần hai (S2 bước 5–6).
4. **Node B sập?** S5: từ chối ghi ở B, tra cứu trả A,C + nhãn, A,C chạy bình thường; B sống lại thì đối soát (S6).
5. **Detector báo nhầm?** Chỉ làm giảm *liveness* (từ chối thừa), không phá *safety* (không đặt trùng).
6. **Mất/trùng sự kiện?** Outbox ⇒ không mất; trùng ⇒ idempotent consumer + `version` (S4).
7. **CAP của hệ?** Ghi: C (từ chối khi OFFLINE). Đọc: A (trả một phần). "C" trong site hiển nhiên vì một bản; thiệt hại chỉ ở mức site.
8. **Sharding hay replication?** Sharding (theo `parking_id`). Không nhân bản dữ liệu slot nên không có vấn đề đồng nhất bản sao (S8 nếu bị vặn).
9. **Aggregator sập?** SPOF; stateless nên nhân bản sau LB (S7).
10. **Eventual consistency ở đâu?** Màn hình realtime và cache ở G; nguồn sự thật là DB bãi (S4, S6).

---

## 7. Việc cần sửa/bổ sung trong HLD sau khi học

Đã có trong README: phân công 4→6 người; "bốn lớp" nhưng bảng 6 dòng; Aggregator "không giữ dữ liệu slot" vs "trạng thái tổng hợp"; STAFF qua Aggregator; "phân mảnh dọc" thực chất là tách bảng trong site.

Thêm sau khi học (đã bám các kịch bản trên):
1. Thêm **khai báo mô hình hệ thống** (§0) vào Câu 3.
2. Sửa câu **CAP** theo S5/§4 (chọn chỉ khi có partition; "C" trong site).
3. Ghi rõ **health check có thể báo nhầm** và hệ vẫn an toàn.
4. Thêm **consumer idempotent** (`event_id`) và **`version` per-slot** vào phần sự kiện.
5. Thêm **`request_id` unique** cho đặt chỗ (S2).
6. Hết hạn đặt chỗ dùng **đồng hồ của Node**.
7. Đặt `events` thêm cột `published_at`, nói rõ relay là **polling**.

---

## 8. Chưa đọc kỹ / cần làm tiếp
- Chưa đọc: Kleppmann bài 8 phần Spanner; MIT 6.824; bài báo gốc *CAP Twelve Years Later* và PACELC; từng trang tutorial RabbitMQ; Tanenbaum/van Steen; slide của thầy cô PTIT.
- Nên làm: bài tập Lamport/vector clock (Kleppmann bài tập 10–13); RabbitMQ tutorial 1–3 + Publisher Confirms; viết thử bảng `events` + relay polling để kiểm chứng đoạn SQL ở trên (hiện chưa chạy).

## Nguồn
- Kleppmann, *Distributed Systems* notes: https://www.cl.cam.ac.uk/teaching/2122/ConcDisSys/dist-sys-notes.pdf · video: https://www.youtube.com/playlist?list=PLeKd45zvjcDFUEv_ohr_HdUFe97RItdiB
- Transactional outbox: https://microservices.io/patterns/data/transactional-outbox
- RabbitMQ tutorials: https://www.rabbitmq.com/tutorials
- Raft trực quan: http://thesecretlivesofdata.com/raft/
- Giáo trình miễn phí: van Steen & Tanenbaum, *Distributed Systems* (3rd ed.) — https://www.distributed-systems.net/index.php/books/ds3/
