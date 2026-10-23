# Báo cáo Thực nghiệm: Quan sát Grafana khi RabbitMQ Tắt (GS-04.8)

> **Mã công việc:** GS-04.8  
> **Người thực hiện:** Nguyễn Văn Luận  
> **Thời điểm thực nghiệm:** Tháng 10/2026  
> **Công cụ hỗ trợ:** `node scripts/barrier.mjs` & `node scripts/demo-outbox-grafana.mjs`  
> **Bảng điều khiển giám sát:** Grafana (`http://localhost:3001`) – Dashboard *"Nhóm 16 – Bãi đỗ xe phân tán"*

---

## 1. Mục đích và Ý nghĩa kiến trúc

Kiểm chứng tính chịu lỗi của hệ thống theo mô hình **Transactional Outbox Pattern**:
1. **Tính tự chủ của Node bãi (Local Autonomy):** Khi Message Broker (RabbitMQ) gặp sự cố hoặc bị tắt hoàn toàn, barrier tại các bãi vẫn phải đóng/mở và ghi nhận lượt xe vào/ra bình thường. Không để sự cố mạng truyền thông trung tâm làm tê liệt dịch vụ tại cổng bãi.
2. **Lưu trữ sự kiện bền vững:** Mọi sự kiện phát sinh trong lúc mất broker sẽ được lưu vào bảng `parking_events` trong PostgreSQL của bãi với trạng thái `published_at IS NULL`.
3. **Giám sát trực quan:** Chỉ số `outbox_unpublished` trên Grafana phản ánh trực tiếp số lượng sự kiện đang chờ gửi.
4. **Tự phục hồi và đối soát:** Khi RabbitMQ hoạt động trở lại, background worker (relay) tự động kết nối lại, xả toàn bộ tin chờ vào Quorum Queue và cập nhật `published_at = now()`, đưa chỉ số `outbox_unpublished` trở về 0 mà không làm mất bất kỳ sự kiện nào (**At-least-once Delivery** & **Eventual Consistency**).

---

## 2. Hướng dẫn các bước chạy nhanh kịch bản

### Cách 1: Chạy tự động qua script hỗ trợ
```bash
node scripts/demo-outbox-grafana.mjs
```
*(Script sẽ tự động khởi động profile `obs`, dừng `rabbitmq`, gọi barrier cho xe vào, kiểm tra DB và bật lại `rabbitmq`)*

---

### Cách 2: Thao tác từng bước thủ công

#### Bước 1: Khởi động hệ thống quan sát (Prometheus & Grafana)
```bash
docker compose --profile obs up -d
```
Truy cập giao diện Grafana tại: [http://localhost:3001](http://localhost:3001) (đã bật sẵn anonymous view, không cần mật khẩu). Mở Dashboard **"Nhóm 16 – Bãi đỗ xe phân tán"**, chú ý quan sát panel **"Sự kiện outbox chưa gửi"** (`outbox_unpublished`).

#### Bước 2: Dừng dịch vụ RabbitMQ để giả lập sự cố
```bash
docker compose stop rabbitmq
```
Lúc này message broker trung gian bị ngắt hoàn toàn.

#### Bước 3: Cho một số xe vào bãi độc lập (gọi thẳng Parking Node)
```bash
# Cho 2 xe vào bãi A
node scripts/barrier.mjs A A01 enter 30A-111.11
node scripts/barrier.mjs A A02 enter 30A-222.22

# Cho 1 xe vào bãi B
node scripts/barrier.mjs B B01 enter 29B-333.33
```
*Kết quả:* Các lệnh đều trả về HTTP 200, barrier mở bình thường dù RabbitMQ đang tắt.

#### Bước 4: Quan sát trên Grafana (Thời điểm 1: Outbox tăng)
- Panel **"Trạng thái các bãi"**: Vẫn giữ mức **1 (ONLINE)**.
- Panel **"Sự kiện outbox chưa gửi"**: Chỉ số tăng lên (ví dụ: bãi A tăng 2, bãi B tăng 1).
- Kiểm tra trực tiếp trong cơ sở dữ liệu:
  ```bash
  docker compose exec -T db-a psql -U postgres -d parking -tAc "SELECT count(*) FROM parking_events WHERE published_at IS NULL"
  ```

#### Bước 5: Bật lại RabbitMQ để hồi phục broker
```bash
docker compose start rabbitmq
```

#### Bước 6: Quan sát trên Grafana (Thời điểm 2: Outbox xả về 0)
- Trong vòng 5 – 10 giây, relay worker của các bãi tự động kết nối lại RabbitMQ.
- Panel **"Sự kiện outbox chưa gửi"** hạ nhanh về mức **0**.
- Mọi sự kiện đã được đẩy an toàn lên cụm RabbitMQ để Aggregator và Notification service tiếp nhận xử lý.

---

## 3. Bảng so sánh trạng thái hệ thống giữa 2 thời điểm

| Tiêu chí quan sát | Thời điểm 1: Khi RabbitMQ dừng (Outbox tăng) | Thời điểm 2: Khi RabbitMQ bật lại (Outbox về 0) | Đánh giá & Cơ chế kỹ thuật |
|---|---|---|---|
| **Trạng thái RabbitMQ broker** | `STOPPED` (Ngừng hoạt động) | `RUNNING / HEALTHY` (Đã phục hồi) | Mô phỏng sự cố broker và khôi phục hoạt động |
| **Thao tác barrier (`/enter`)** | **Thành công (HTTP 200)** | **Thành công (HTTP 200)** | Node bãi hoạt động tự chủ, không bị phụ thuộc broker |
| **Chỉ số `outbox_unpublished`** | **Tăng (> 0, lưu trong DB)** | **Hạ về 0 (đã chuyển gửi hết)** | Transactional Outbox lưu trữ bền vững trên PostgreSQL |
| **Panel "Trạng thái các bãi"** | **1 (ONLINE)** | **1 (ONLINE)** | Sự cố broker không làm sập trạng thái hoạt động của bãi |
| **Tính toàn vẹn dữ liệu** | **Bảo toàn 100% trong DB** | **Chuyển giao 100% vào Queue** | Đạt tính nhất quán cuối cùng (Eventual Consistency) |

---

## 4. Vị trí gắn ảnh minh chứng thực nghiệm

### Minh chứng 1: Thời điểm RabbitMQ tắt – Outbox tăng lên
*(Vị trí dán ảnh chụp màn hình Grafana hiển thị panel "Sự kiện outbox chưa gửi" tăng lên tương ứng với số xe vào bãi)*  
> **Gợi ý lưu ảnh:** Lưu ảnh chụp màn hình vào file `tai-lieu/anh/GS-04.8-01-outbox-tang.png`  
> <!-- Đính kèm ảnh: ![Outbox tăng khi RabbitMQ tắt](./anh/GS-04.8-01-outbox-tang.png) -->

**Nhật ký kiểm tra DB tại Thời điểm 1:**
```text
$ docker compose exec -T db-a psql -U postgres -d parking -tAc "SELECT count(*) FROM parking_events WHERE published_at IS NULL"
2
$ docker compose exec -T db-b psql -U postgres -d parking -tAc "SELECT count(*) FROM parking_events WHERE published_at IS NULL"
1
=> Nhận xét: Sự kiện được lưu an toàn trong DB cục bộ, panel outbox_unpublished trên Grafana ghi nhận giá trị > 0.
```

---

### Minh chứng 2: Thời điểm RabbitMQ bật lại – Outbox xả về 0
*(Vị trí dán ảnh chụp màn hình Grafana hiển thị panel "Sự kiện outbox chưa gửi" đã hạ hoàn toàn về 0)*  
> **Gợi ý lưu ảnh:** Lưu ảnh chụp màn hình vào file `tai-lieu/anh/GS-04.8-02-outbox-ve-0.png`  
> <!-- Đính kèm ảnh: ![Outbox xả về 0 sau khi RabbitMQ bật lại](./anh/GS-04.8-02-outbox-ve-0.png) -->

**Nhật ký kiểm tra DB tại Thời điểm 2:**
```text
$ docker compose exec -T db-a psql -U postgres -d parking -tAc "SELECT count(*) FROM parking_events WHERE published_at IS NULL"
0
$ docker compose exec -T db-b psql -U postgres -d parking -tAc "SELECT count(*) FROM parking_events WHERE published_at IS NULL"
0
=> Nhận xét: Relay worker tự động đẩy hết toàn bộ tin tồn sang RabbitMQ, outbox_unpublished về 0.
```

---

## 5. Kết luận chuyên môn

1. **Độc lập phân tán:** Bãi đỗ xe vẫn phục vụ khách bình thường kể cả khi hạ tầng mạng truyền thông hoặc broker tin nhắn trung tâm bị gián đoạn hoàn toàn.
2. **Không mất mát dữ liệu:** Nhờ Transactional Outbox Pattern, không có hiện tượng mất sự kiện giữa thao tác ghi cơ sở dữ liệu và gửi tin nhắn broker.
3. **Khả năng quan sát thời gian thực:** Grafana và Prometheus phản ánh chính xác từng biến động của hàng đợi outbox, hỗ trợ người vận hành nắm bắt ngay trạng thái nghẽn tin hoặc broker gặp sự cố.
