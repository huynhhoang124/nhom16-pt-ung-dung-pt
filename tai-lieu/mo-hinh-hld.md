# Mô Hình Kiến Trúc HLD (High-Level Design) Hệ Thống Phân Tán

**Đề tài:** Hệ thống bãi đỗ xe thông minh liên kết nhiều bãi  
**Học phần:** Hệ thống / Ứng dụng phân tán – Học viện Công nghệ Bưu chính Viễn thông (PTIT) – Nhóm 16  
**Thành viên:** Vũ Văn Hùng, Hoàng Văn Huynh, Nguyễn Văn Luân, Trịnh Kim Loan, Đỗ Huyền Trang, Phạm Sỹ Hiệp  
**Tài liệu gốc đã nộp:** `tai-lieu/Nhom16_Mo_hinh_HLD.pdf` (bản hiệu chỉnh theo phản hồi phản biện)

---

## 1. Sơ đồ kiến trúc phân tán tổng thể (Hình 1)

Kiến trúc hệ thống được tổ chức theo mô hình phân tán 3 tầng kết hợp cơ chế điều phối và các site tự chủ:

```
                      +---------------------------------------+
                      |       Trình duyệt Web (React)         |
                      |    (Client: Người dùng, Nhân viên)    |
                      +-------------------+-------------------+
                                          |
                      +-------------------+-------------------+
                      |         TẦNG ĐIỀU PHỐI & REALTIME     |
                      |                                       |
                      |  Aggregator Service (:8000)           |
                      |  - Định tuyến, Scatter-gather         |
                      |  - Read-only Cache RAM cho tra cứu    |
                      |  - Xác thực JWT & phân quyền          |
                      |  - WebSocket Socket.IO (Realtime)     |
                      |                                       |
                      |  DB Aggregator (Postgres)             |
                      |  - Danh sách bãi, tài khoản, vai trò  |
                      |                                       |
                      |  Message Broker (RabbitMQ)            |
                      |  - Exchange topic: parking.events     |
                      |  - Quorum queues bền vững             |
                      +-------------------+-------------------+
                                          |
        +---------------------------------+---------------------------------+
        | (HTTP nội bộ + khóa JWT)        | (HTTP nội bộ + khóa JWT)        | (HTTP nội bộ + khóa JWT)
        v                                 v                                 v
+-----------------------+         +-----------------------+         +-----------------------+
|  SITE BÃI ĐỖ XE A     |         |  SITE BÃI ĐỖ XE B     |         |  SITE BÃI ĐỖ XE C     |
|                       |         |                       |         |                       |
|  Parking Node A (:8001|         |  Parking Node B (:8002|         |  Parking Node C (:8003|
|  - Xử lý đặt chỗ cục bộ|        |  - Xử lý đặt chỗ cục bộ|        |  - Xử lý đặt chỗ cục bộ|
|  - Barrier / Sensor   |         |  - Barrier / Sensor   |         |  - Barrier / Sensor   |
|  - Transactional Outbox|        |  - Transactional Outbox|        |  - Transactional Outbox|
|  - Xác thực JWT PT-05 |         |  - Xác thực JWT PT-05 |         |  - Xác thực JWT PT-05 |
|                       |         |                       |         |                       |
|  Database Bãi A (PG)  |         |  Database Bãi B (PG)  |         |  Database Bãi C (PG)  |
|  - parking_slots      |         |  - parking_slots      |         |  - parking_slots      |
|  - reservations       |         |  - reservations       |         |  - reservations       |
|  - parking_sessions   |         |  - parking_sessions   |         |  - parking_sessions   |
|  - parking_events     |         |  - parking_events     |         |  - parking_events     |
+-----------------------+         +-----------------------+         +-----------------------+
```

---

## 2. Câu 1: Vì sao cần phân tán?

**Trả lời:** Vì dữ liệu và nghiệp vụ của bài toán bãi đỗ xe vốn phát sinh tại nhiều bãi vật lý độc lập. Gom tất cả về một máy chủ tập trung sẽ tạo ra điểm lỗi duy nhất (Single Point of Failure), tạo điểm nghẽn về tải (Bottleneck), và làm cho mỗi bãi bị phụ thuộc hoàn toàn vào đường truyền mạng lên trung tâm ngay cả với những nghiệp vụ tức thời tại chỗ (như mở barrier cho xe vào/ra).

### Bốn lý do cốt lõi:
1. **Dữ liệu phát sinh tại từng bãi:** Mỗi bãi có barrier/cảm biến cơ học, nhân viên điều hành và tập vị trí đỗ (slot) riêng biệt. Xe vào/ra cần được xác nhận và cập nhật trạng thái tức thì tại chỗ (< 50ms). Do đó xử lý và lưu trữ dữ liệu bắt buộc phải đặt tại bãi (Node + Database riêng) thay vì phụ thuộc đường truyền xa lên trung tâm.
2. **Chịu lỗi và cô lập lỗi:** Nếu thiết kế tập trung, khi máy chủ hoặc cơ sở dữ liệu trung tâm gặp sự cố thì mọi bãi đỗ xe trong thành phố đều tê liệt. Trong kiến trúc phân tán, khi bãi B bị mất mạng hoặc mất điện, bãi A và C vẫn cho xe vào/ra và nhận đặt chỗ bình thường. Phía người dùng tra cứu vẫn nhận được kết quả của bãi A và C, chỉ riêng bãi B được gắn cờ `OFFLINE`.
3. **Khả năng mở rộng theo số bãi (Scalability):** Thêm một bãi mới chỉ cần triển khai thêm một Site độc lập và đăng ký địa chỉ vào danh sách node của Aggregator; hoàn toàn không phải di chuyển dữ liệu hay gây rủi ro downtime cho các bãi hiện có. Tải ghi (đặt chỗ, xe vào/ra) được phân chia đều về các bãi nên không xảy ra tranh chấp khóa trên một cơ sở dữ liệu chung.
4. **Tự chủ tại site nhưng vẫn thống nhất với người dùng (Transparency):** Mỗi bãi tự chủ vận hành (đặt giá, bảo trì slot, xử lý barrier, thu tiền mặt) nhưng người dùng chỉ cần một ứng dụng duy nhất, vì lớp Aggregator đã che giấu sự phân tán về mặt vật lý (tính trong suốt truy cập và vị trí).

### Bảng so sánh Kiến trúc Tập trung vs Kiến trúc Phân tán:

| Tiêu chí | Nếu tập trung một máy chủ | Khi phân tán theo bãi (Nhóm 16) |
|---|---|---|
| **Khi có sự cố** | Toàn bộ hệ thống dừng hoạt động | Chỉ bãi lỗi bị ảnh hưởng; các bãi khác vẫn hoạt động bình thường |
| **Tải ghi dữ liệu** | Toàn bộ bãi dồn ghi vào một cơ sở dữ liệu duy nhất | Mỗi bãi ghi trực tiếp vào cơ sở dữ liệu riêng của bãi |
| **Thêm bãi mới** | Sửa đổi hệ thống chung, tiềm ẩn rủi ro cho bãi cũ | Thêm site mới và đăng ký URL, bãi cũ không cần sửa đổi |
| **Xe vào/ra tại cổng**| Phụ thuộc đường mạng lên trung tâm | Xử lý ngay tại chỗ, độc lập không phụ thuộc trung tâm |

---

## 3. Câu 2: Phân tán ở đâu?

**Trả lời:** Hệ thống được phân tán toàn diện qua các lớp thành phần: dữ liệu bãi, xử lý cục bộ/điều phối, dữ liệu điều phối, triển khai độc lập, luồng thông điệp sự kiện và thiết bị ngoại vi tại site (khớp 6 thành phần trong bảng dưới). Mỗi bãi là một đơn vị độc lập gồm Node và Database riêng (mô hình Shared-Nothing); tầng điều phối ở giữa chỉ làm nhiệm vụ định tuyến và tổng hợp.

### Bảng chi tiết 6 lớp thành phần phân tán:

| Lớp thành phần | Thành phần trên sơ đồ | Bản chất và hiện thực phân tán cụ thể |
|---|---|---|
| **1. Dữ liệu bãi** | Database A, B, C | **Phân mảnh ngang** theo `parking_id`: mỗi bãi sở hữu một CSDL Postgres độc lập, mỗi bản ghi thuộc duy nhất một bãi. **Tách bảng trong site** tại từng node: bảng định nghĩa vị trí `parking_slots` (ít biến động) tách biệt khỏi bảng phiên gửi xe `parking_sessions` và bảng trạng thái (thay đổi liên tục). Các bảng `reservations` và `parking_events` phân mảnh phái sinh theo slot, đảm bảo một giao dịch đặt chỗ chỉ nằm trọn trong một node duy nhất. |
| **2. Xử lý nghiệp vụ** | Parking Node A, B, C; Aggregator Service | Xử lý phân cấp: **Cấp bãi:** Node tự xử lý giao dịch đặt chỗ, xe vào/ra, tra cứu slot và khóa hàng (row-level locking) chống đặt trùng cục bộ. **Cấp điều phối:** Aggregator xử lý định tuyến thông minh, scatter-gather gọi song song các node, tổng hợp dữ liệu, failure detector (health check), xác thực JWT và phân quyền. |
| **3. Dữ liệu điều phối**| DB Aggregator | Lưu trữ danh mục bãi (`parkings`), tài khoản người dùng (`users`) và quyền hạn (`roles`). Tách biệt hoàn toàn, không lưu trữ dữ liệu vị trí hay phiên gửi xe của các bãi. |
| **4. Triển khai** | Khung nét đứt quanh từng site | Mỗi bãi là một đơn vị triển khai độc lập (container, port và mạng riêng), giao tiếp liên site qua mạng nội bộ bằng HTTP/REST, WebSocket, AMQP và kết nối SQL. |
| **5. Luồng thông điệp**| Message Broker (RabbitMQ) | Áp dụng Transactional Outbox: Khi slot thay đổi trạng thái, node ghi sự kiện vào DB bãi rồi relay worker mới publish lên topic `parking.events`. Aggregator subscribe để cập nhật cache và phát WebSocket realtime xuống client. |
| **6. Thiết bị ngoại vi**| Barrier / Cảm biến / Camera | Lắp đặt trực tiếp tại từng bãi, chỉ kết nối và gọi API vào chính Parking Node của bãi đó qua mạng nội bộ cổng. |

> **Làm rõ về thành phần điều phối tập trung:**  
> Aggregator, DB Aggregator và Message Broker đóng vai trò cổng điều phối trung tâm. Cần nhấn mạnh rằng **trạng thái slot tổng hợp tại Aggregator chỉ là bộ đệm đọc (read-only cache)** trong RAM nhằm phục vụ tra cứu nhanh và realtime; **dữ liệu gốc (single source of truth)** hoàn toàn được lưu trữ và bảo đảm tại cơ sở dữ liệu riêng của từng bãi. Do đó, việc tập trung lớp điều phối không làm mất đi tính tự chủ và toàn vẹn dữ liệu của các bãi.

---

## 4. Câu 3: Giải pháp phân tán là gì?

**Trả lời:** Áp dụng mô hình điều phối viên (Aggregator Pattern) kết hợp các Site tự chủ (Autonomous Sites). Dữ liệu được phân mảnh theo bãi; yêu cầu đơn bãi được định tuyến thẳng tới node tương ứng; yêu cầu toàn hệ thống áp dụng Scatter–Gather có timeout; duy trì nhất quán mạnh trong từng site và nhất quán cuối cùng trên toàn cục; cô lập lỗi bằng Failure Detector và trả về kết quả một phần.

### Bảng giải pháp các vấn đề kỹ thuật phân tán:

| Vấn đề phân tán | Giải pháp kỹ thuật đã hiện thực |
|---|---|
| **Tổ chức hệ thống** | Aggregator là cổng vào duy nhất cho ứng dụng người dùng; client không gọi trực tiếp DB. Mỗi site bãi đỗ xe là một đơn vị tự chủ, hoàn toàn không truy cập chéo DB của bãi khác. |
| **Định vị dữ liệu** | Phân mảnh theo `parking_id`. Aggregator định tuyến request trực tiếp tới đúng URL của Parking Node tương ứng dựa trên danh mục bãi. |
| **Yêu cầu đơn bãi (Đặt chỗ, Vào/Ra)** | Định tuyến thẳng tới Parking Node đích qua HTTP/REST; không đi qua và không phụ thuộc vào bất kỳ bãi nào khác. |
| **Yêu cầu toàn cục (Tra cứu chỗ trống)** | **Scatter–Gather:** Aggregator phát lời gọi song song tới toàn bộ các node với cơ chế timeout (ví dụ: 1.5s). Node chậm hoặc mất kết nối sẽ bị bỏ qua; hệ thống trả về kết quả một phần kèm trạng thái `OFFLINE` của bãi lỗi. |
| **Giao tiếp liên tiến trình** | **Đồng bộ (HTTP/REST):** Dành cho tra cứu, đặt chỗ và quét barrier. **Bất đồng bộ (AMQP):** Message Broker trao đổi sự kiện outbox. **WebSocket (Socket.IO):** Đẩy thông tin realtime xuống giao diện. |
| **Nhất quán và Đồng thời (Định lý CAP)** | **Trong từng site:** Sử dụng giao dịch ACID với câu lệnh `UPDATE ... WHERE status='AVAILABLE'` và unique index chống đặt trùng ở mức DB. Giao dịch trọn vẹn trong 1 DB nên không cần 2PC.<br>**Toàn cục:** Đạt nhất quán cuối cùng (Eventual Consistency) qua luồng sự kiện Outbox.<br>**Định lý CAP:** Chỉ phải đánh đổi khi xảy ra **phân vùng mạng (Partition)**: Thao tác ghi (đặt chỗ, vào/ra) **ưu tiên tính Nhất quán C** (từ chối 503 khi bãi OFFLINE để chống đặt trùng); thao tác đọc (tra cứu chỗ trống) **ưu tiên tính Sẵn sàng A** (trả về kết quả một phần từ các bãi còn sống). |
| **Chịu lỗi và Tự phục hồi** | Failure Detector: Aggregator gửi heartbeat định kỳ 5s; nếu bãi lỗi 3 lần liên tiếp thì đánh dấu `OFFLINE`. Khi bãi sống lại, Aggregator tự động chạy cơ chế đối soát (Anti-entropy) để đồng bộ trạng thái mới nhất. Sự kiện tại bãi được bảo toàn trong bảng `parking_events` nhờ Transactional Outbox. |
| **Tính trong suốt** | Người dùng chỉ thấy một hệ thống duy nhất: không cần quan tâm bãi nằm ở IP hay cổng nào. Khi có bãi lỗi, kết quả một phần vẫn thể hiện rõ ràng trên giao diện. |
| **Bảo mật và Xác thực** | Xác thực tập trung bằng JWT (USER, STAFF, ADMIN) tại Aggregator. Khi gọi xuống node bãi, request kèm mã khóa nội bộ `x-internal-key`. |

### Ví dụ minh họa thực tế:
1. **Quy trình đặt chỗ tại Bãi B:** Client gửi yêu cầu đặt chỗ tới Aggregator -> Aggregator xác thực JWT, tra cứu địa chỉ node B -> gửi `POST /api/reservations` xuống Parking Node B. Node B thực thi giao dịch khóa dòng slot, ghi bản ghi `reservations`, ghi sự kiện `CAR_RESERVED` vào bảng `parking_events`. Relay worker đẩy sự kiện lên RabbitMQ -> Aggregator nhận sự kiện và phát WebSocket cập nhật giao diện người dùng realtime.
2. **Xử lý khi Bãi C mất kết nối mạng:** Người dùng tra cứu danh sách bãi -> Aggregator gửi request song song tới A, B, C. Bãi C không phản hồi trong ngưỡng timeout 1.5s -> Aggregator trả về kết quả chỗ trống của bãi A, B kèm theo trạng thái `bãi C: OFFLINE`. Người dùng vẫn xem được các bãi khác bình thường.

---

## 5. Hạn chế và Hướng mở rộng

* **Đánh giá điểm tập trung:**
  * Lớp điều phối (Aggregator, DB Aggregator và Message Broker) đóng vai trò trung gian định tuyến.
  * *Điểm đã hoàn thiện:* Với tính năng **PT-05 (Offline Staff Capability)**, hệ thống đã giải quyết triệt để hạn chế nhân viên bị phụ thuộc vào Aggregator. Khi Aggregator gặp sự cố, nhân viên tại bãi vẫn có thể đăng nhập và quét QR gọi trực tiếp vào Parking Node của bãi thông qua cặp khóa bất đối xứng RSA (RS256) được cấu hình tại bãi.
* **Hướng mở rộng sản xuất (Production Roadmap):**
  1. Triển khai nhiều instance Aggregator phía sau Load Balancer (HAProxy / Nginx) kết hợp cơ chế chia sẻ phiên (Session Replication / Redis).
  2. Xây dựng cụm RabbitMQ Cluster 3 nút với Quorum Queues (đã có kịch bản chạy thử nghiệm tại `docker compose --profile ha`).
  3. Áp dụng Read-replica cho DB bãi và DB điều phối (đã có runbook failover `PT-02.10`).
