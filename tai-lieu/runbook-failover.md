# Runbook: chuyển sang bản sao khi DB bãi A chết (PT-02)

> Bản nháp do Claude soạn kèm code PT-02; Loan + Hùng tập thật một lần (PT-02.10) rồi sửa lại cho đúng thực tế.

**Bối cảnh:** `db-a` (bản chính) sao chép **bất đồng bộ** sang `db-a-replica` (chỉ đọc). Node A ghi vào `db-a`, đọc thuần từ bản sao.
Chuyển đổi là **thủ công** (không có Patroni/etcd): người vận hành quyết định, tránh hai bản chính cùng lúc (split brain).

## 0. Chuẩn bị (lúc bình thường)
```bash
docker compose --profile ha up -d
docker compose exec db-a-replica psql -U postgres -c "SELECT pg_is_in_recovery()"     # t = đang là bản sao
curl -s localhost:8001/metrics | grep replication_lag_seconds                          # độ trễ (giây), 0 = theo kịp
```

## 1. Bản chính chết
```bash
docker compose stop db-a            # giả lập sự cố
```
Node A: ghi lỗi (500), đọc vẫn chạy nhờ bản sao. Aggregator: health check của A báo DOWN (vì /health kiểm DB chính) -> A OFFLINE sau ~15 giây.

## 2. Nâng bản sao thành bản chính
```bash
docker compose exec db-a-replica psql -U postgres -c "SELECT pg_promote()"
docker compose exec db-a-replica psql -U postgres -c "SELECT pg_is_in_recovery()"     # f = đã là bản chính
```

## 3. Trỏ node A sang bản chính mới
Sửa `docker-compose.yml`, service `parking-a`: `DATABASE_URL: postgres://postgres:dev@db-a-replica/parking`, rồi:
```bash
docker compose up -d parking-a
```
Health check thấy A ONLINE lại, Aggregator đối soát.

## 4. KHÔNG bật lại db-a cũ làm bản chính
Hai bản chính = hai nơi nhận ghi khác nhau (split brain). Muốn dùng lại máy cũ: xoá dữ liệu và dựng lại làm **bản sao** của bản chính mới.

## Rủi ro cần nói khi bảo vệ
- **Mất vài giao dịch cuối:** sao chép bất đồng bộ, giao dịch commit ở bản chính nhưng chưa kịp sang bản sao thì mất khi failover. Muốn không mất: `synchronous_commit` + `synchronous_standby_names`, đổi lại ghi chậm hơn và bản sao chết thì ghi bị treo (lại là đánh đổi C và A).
- **Đọc lại thứ vừa ghi:** đọc bản sao có thể chưa thấy chỗ vừa đặt -> luồng ghi luôn đọc bản chính.
- Thời gian gián đoạn ghi = thời gian phát hiện + người vận hành làm bước 2–3 (ghi lại khi tập).
