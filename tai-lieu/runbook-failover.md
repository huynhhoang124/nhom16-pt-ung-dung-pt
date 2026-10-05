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
