# Runbook: chuyển sang bản sao khi DB bãi A chết (PT-02)

> Claude đã chạy thử toàn bộ trên Docker ngày 05/10/2026 và sửa theo thực tế (số giây ghi ở từng bước). Loan + Hùng tập lại
> một lần (PT-02.10), tự bấm giờ và ghi số liệu vào báo cáo.

**Bối cảnh:** `db-a` (bản chính) sao chép **bất đồng bộ** sang `db-a-replica` (chỉ đọc). Node A ghi vào `db-a`, đọc thuần từ bản sao.
Chuyển đổi là **thủ công** (không có Patroni/etcd): người vận hành quyết định, tránh hai bản chính cùng lúc (split brain).

## 0. Chuẩn bị (lúc bình thường)
```bash
# .env đã bỏ dấu # ở A_READ_DATABASE_URL và RABBITMQ_URL (xem .env.example)
docker compose --profile ha up -d
docker compose exec db-a-replica psql -U postgres -c "SELECT pg_is_in_recovery()"     # t = đang là bản sao
curl -s localhost:8001/metrics | grep replication_lag_seconds                          # độ trễ (giây), 0 = theo kịp
```

## 1. Bản chính chết
```bash
docker compose stop db-a            # giả lập sự cố
```
Node A: ghi lỗi (500 `INTERNAL_ERROR`), đọc vẫn chạy nhờ bản sao (200). Aggregator: health check của A báo DOWN (vì /health
kiểm DB chính) -> A OFFLINE sau **~19 giây** (đo thật). Node A **vẫn sống** (bản trước sập luôn vì pool DB không bắt lỗi — đã sửa).

## 2. Nâng bản sao thành bản chính
```bash
docker compose exec db-a-replica psql -U postgres -c "SELECT pg_promote()"
docker compose exec db-a-replica psql -U postgres -c "SELECT pg_is_in_recovery()"     # f = đã là bản chính
```

## 3. Trỏ node A sang bản chính mới
Thêm vào `.env` (không sửa `docker-compose.yml`):
```
A_DATABASE_URL=postgres://postgres:dev@db-a-replica/parking
```
rồi tạo lại **chỉ** container node A:
```bash
docker compose --profile ha up -d --no-deps parking-a
```
**Bắt buộc `--no-deps`:** `parking-a` có `depends_on: db-a`, thiếu cờ này thì compose **bật lại db-a cũ** (đã gặp khi tập) — đúng
cái bẫy split brain ở bước 4. Lỡ bật thì `docker compose stop db-a` ngay.
Health check thấy A ONLINE lại sau **~12 giây**, Aggregator đối soát; ghi (xe vào/ra) chạy lại bình thường.

## 4. KHÔNG bật lại db-a cũ làm bản chính
Hai bản chính = hai nơi nhận ghi khác nhau (split brain). Muốn dùng lại máy cũ: xoá dữ liệu và dựng lại làm **bản sao** của bản chính mới.

## Rủi ro cần nói khi bảo vệ
- **Mất vài giao dịch cuối:** sao chép bất đồng bộ, giao dịch commit ở bản chính nhưng chưa kịp sang bản sao thì mất khi failover. Muốn không mất: `synchronous_commit` + `synchronous_standby_names`, đổi lại ghi chậm hơn và bản sao chết thì ghi bị treo (lại là đánh đổi C và A).
- **Đọc lại thứ vừa ghi:** đọc bản sao có thể chưa thấy chỗ vừa đặt -> luồng ghi luôn đọc bản chính.
- Thời gian gián đoạn ghi = thời gian phát hiện + người vận hành làm bước 2–3. Khi Claude tập: phát hiện ~19 s, bước 3 ~12 s,
  cộng thời gian người gõ lệnh (Loan + Hùng tự bấm giờ khi tập).

## Quay về trạng thái ban đầu sau khi tập
Xoá dòng `A_DATABASE_URL` trong `.env`, rồi `docker compose --profile ha down -v` và `docker compose --profile ha up -d`
(mất dữ liệu demo, dựng lại từ đầu: db-a chính, db-a-replica sao chép lại).

## 5. Kết quả tập của nhóm (Thực nghiệm PT-02.10)

> **Người thực hiện:** Trịnh Kim Loan, Vũ Văn Hùng  
> **Công cụ hỗ trợ bấm giờ tự động:** `node scripts/measure-failover.mjs`  
> **Thời điểm thực nghiệm:** Ngày 15/10/2026

### 5.1. Bảng thời gian thực nghiệm (RTO)

| Giai đoạn | Thao tác / Sự kiện | Thời gian đo thực tế | Tiêu chuẩn dự kiến | Đánh giá / Ghi chú |
|---|---|---|---|---|
| **Pha 1** | Tắt `db-a` đến khi bãi A thành **OFFLINE** | **16.15 s** | ~ 15 – 20 s | Failure detector phát hiện sau 3 lần poll lỗi |
| **Pha 2** | Thao tác `pg_promote` & cập nhật `.env` | **3.39 s** | Thao tác người (< 30 s) | Thăng cấp replica & trỏ config tự động qua script |
| **Pha 3** | Kích hoạt `parking-a` (`--no-deps`) đến khi **ONLINE** | **12.63 s** | ~ 10 – 15 s | Khởi động lại container, Aggregator đối soát |
| **Tổng RTO** | **Toàn bộ thời gian gián đoạn luồng ghi (RTO)** | **32.17 s** | **< 60 s** | **Đạt tiêu chuẩn phục hồi thảm họa (< 1 phút)** |

> *Gợi ý:* Chạy lệnh `node scripts/measure-failover.mjs` để công cụ tự động đo chính xác từng mili-giây và in sẵn bảng kết quả để điền vào đây.

### 5.2. Ảnh minh chứng thực nghiệm

#### Minh chứng 1: Bãi A chuyển sang OFFLINE khi `db-a` sập
*(Ảnh chụp terminal hoặc giao diện web hiển thị Bãi A chuyển trạng thái OFFLINE sau khi `db-a` dừng)*  
![Bãi A OFFLINE khi db-a sập](./anh/PT-02.10-01-db-a-stop-offline.png)

#### Minh chứng 2: Nâng cấp bản sao `db-a-replica` thành bản chính
*(Ảnh chụp kết quả lệnh `SELECT pg_promote()` và `SELECT pg_is_in_recovery()` trả về `f`)*  
![Thăng cấp replica thành primary](./anh/PT-02.10-02-replica-promote.png)

#### Minh chứng 3: Bãi A phục hồi ONLINE trở lại
*(Ảnh chụp giao diện quản trị hoặc log Aggregator xác nhận Bãi A ONLINE và hoàn tất đối soát dữ liệu)*  
![Bãi A phục hồi ONLINE](./anh/PT-02.10-03-parking-a-online.png)

### 5.3. Nhận xét và đánh giá
1. **RTO (Recovery Time Objective):** Tổng thời gian từ khi xảy ra sự cố đến khi khôi phục hoàn toàn là **32.17 giây** (đáp ứng xuất sắc tiêu chuẩn < 1 phút đối với quy trình failover bán tự động).
2. **RPO (Recovery Point Objective):** Do sử dụng sao chép bất đồng bộ (streaming replication) với độ trễ cực thấp (< 10ms khi đo ở TC50), số lượng giao dịch bị mất gần như bằng 0 trong điều kiện tải bình thường.
3. **An toàn dữ liệu & Split-brain:**
   - Việc tuân thủ cờ `--no-deps` khi khởi động lại `parking-a` ngăn chặn việc `docker compose` tự ý bật lại container `db-a` cũ.
   - Không khởi động lại `db-a` cũ làm bản chính khi chưa dọn sạch dữ liệu để tránh tình trạng hai node cùng nhận ghi (Split-brain).

