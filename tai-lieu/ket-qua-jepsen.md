# PD-26 — Bộ kiểm thử kiểu Jepsen

Runner:

```bash
node tests/jepsen/run.mjs --seed 42 --nemesis partition --time 120
```

Runner tự khởi động topology PD-12 sáu bãi, RabbitMQ HA, etcd và failover manager; chạy tải và nemesis đồng thời; ghi lịch sử JSONL; sau đó kiểm sáu bất biến. Lịch sử chi tiết được ghi tại `tests/jepsen/history.jsonl` và không đưa vào Git. Mỗi lượt chạy được runner tự động thêm kết quả vào cuối tài liệu này.

## Trạng thái

Đã xác nhận TC78 và TC79 trên Docker ngày 2026-10-28. Các lượt PASS mới nhất đạt đủ 6/6 bất biến; các lượt FAIL trước đó được giữ lại để làm lịch sử chẩn đoán môi trường.
Lần tiếp tục ngày 2026-10-24: Docker Desktop không phản hồi lệnh `docker version` và `docker ps` trong thời hạn 15 giây; do đó chưa thể khởi chạy topology hoặc xác nhận TC78/TC79. Các kết quả FAIL bên dưới được giữ nguyên làm bằng chứng, không phải kết quả nghiệm thu.
## 2026-10-24T02:28:00.289Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T02:29:33.065Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile scale --profile coord --profile ha up -d --build failed: Image nhom16/aggregator Building 
 Image nhom16/parking-node Building 
 Image nhom16-parking-notification Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16-parking-frontend Building 
 Image nhom16/parking-node Built 
 Image nhom16/failover-manager Built 
 Image nhom16/parking-node Built 
 Image nhom16/failover-manager Built 
 Image nhom16/aggregator Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16-parking-notification Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16-parking-frontend Built 
time="2026-10-24T09:28:26+07:00" level=warning msg="Found orphan containers (nhom16-parking-otel-collector-1, nhom16-parking-jaeger-1, nhom16-parking-frontend-regional-1, nhom16-parking-aggregator-bac-2-1, nhom16-parking-aggregator-bac-1-1, nhom16-parking-aggregator-nam-1-1, nhom16-parking-aggregator-nam-2-1) for this project. If you removed or renamed this service in your compose file, you can run this command with the --remove-orphans flag to clean it up."
 Container nhom16-parking-db-a-1 Recreate 
 Container nhom16-parking-db-agg-1 Recreate 
 Container nhom16-parking-db-b-1 Recreate 
 Container nhom16-parking-db-c-1 Recreate 
 Container nhom16-parking-rabbitmq-2-1 Recreate 
 Container nhom16-parking-failover-manager-1-1 Creating 
 Container nhom16-parking-parking-e-1 Recreate 
 Container nhom16-parking-rabbitmq-1 Recreate 
 Container nhom16-parking-etcd-3-1 Recreate 
 Container nhom16-parking-failover-manager-2-1 Creating 
 Container nhom16-parking-rabbitmq-3-1 Recreate 
 Container nhom16-parking-parking-d-1 Recreate 
 Container nhom16-parking-parking-f-1 Recreate 
 Container nhom16-parking-failover-manager-2-1 Created 
 Container nhom16-parking-failover-manager-1-1 Created 
 Container nhom16-parking-etcd-3-1 Recreated 
 Container nhom16-parking-db-agg-1 Recreated 
 Container nhom16-parking-aggregator-1 Recreate 
 Container nhom16-parking-aggregator-2-1 Recreate 
 Container nhom16-parking-parking-f-1 Recreated 
 Container nhom16-parking-db-c-1 Recreated 
 Container nhom16-parking-parking-c-1 Recreate 
 Container nhom16-parking-db-b-1 Recreated 
 Container nhom16-parking-parking-b-1 Recreate 
 Container nhom16-parking-db-a-1 Recreated 
 Container nhom16-parking-db-a-replica-1 Recreate 
 Container nhom16-parking-parking-a-1 Recreate 
 Container nhom16-parking-rabbitmq-2-1 Recreated 
 Container nhom16-parking-rabbitmq-3-1 Recreated 
 Container nhom16-parking-parking-d-1 Recreated 
 Container nhom16-parking-parking-e-1 Recreated 
 Container nhom16-parking-toxiproxy-1 Recreate 
 Container nhom16-parking-aggregator-2-1 Recreated 
 Container nhom16-parking-toxiproxy-1 Recreated 
 Container nhom16-parking-region-latency-1 Recreate 
 Container nhom16-parking-aggregator-1 Recreated 
 Container nhom16-parking-frontend-1 Recreate 
 Container nhom16-parking-parking-b-1 Recreated 
 Container nhom16-parking-parking-a-1 Recreated 
 Container nhom16-parking-db-a-replica-1 Recreated 
 Container nhom16-parking-rabbitmq-1 Recreated 
 Container nhom16-parking-notification-1 Recreate 
 Container nhom16-parking-parking-c-1 Recreated 
 Container nhom16-parking-region-latency-1 Recreated 
 Container nhom16-parking-frontend-1 Recreated 
 Container nhom16-parking-notification-1 Recreated 
 Container nhom16-parking-db-a-1 Starting 
 Container nhom16-parking-rabbitmq-3-1 Starting 
 Container nhom16-parking-rabbitmq-2-1 Starting 
 Container nhom16-parking-rabbitmq-1 Starting 
 Container nhom16-parking-etcd-3-1 Starting 
 Container nhom16-parking-db-e-1 Starting 
 Container nhom16-parking-db-f-1 Starting 
 Container nhom16-parking-db-agg-1 Starting 
 Container nhom16-parking-etcd-2-1 Starting 
 Container nhom16-parking-etcd-1-1 Starting 
 Container nhom16-parking-db-b-1 Starting 
 Container nhom16-parking-db-d-1 Starting 
 Container nhom16-parking-db-c-1 Starting 
 Container nhom16-parking-db-e-1 Started 
 Container nhom16-parking-db-e-1 Waiting 
 Container nhom16-parking-db-d-1 Started 
 Container nhom16-parking-db-d-1 Waiting 
 Container nhom16-parking-etcd-2-1 Started 
 Container nhom16-parking-db-b-1 Started 
 Container nhom16-parking-db-b-1 Waiting 
 Container nhom16-parking-db-a-1 Started 
 Container nhom16-parking-db-a-1 Waiting 
 Container nhom16-parking-db-a-1 Waiting 
 Container nhom16-parking-db-agg-1 Started 
 Container nhom16-parking-db-agg-1 Waiting 
 Container nhom16-parking-db-agg-1 Waiting 
 Container nhom16-parking-etcd-1-1 Started 
 Container nhom16-parking-failover-manager-1-1 Starting 
 Container nhom16-parking-failover-manager-2-1 Starting 
 Container nhom16-parking-db-f-1 Started 
 Container nhom16-parking-db-f-1 Waiting 
 Container nhom16-parking-db-c-1 Started 
 Container nhom16-parking-db-c-1 Waiting 
 Container nhom16-parking-rabbitmq-3-1 Started 
 Container nhom16-parking-etcd-3-1 Started 
 Container nhom16-parking-rabbitmq-2-1 Started 
 Container nhom16-parking-rabbitmq-1 Started 
 Container nhom16-parking-rabbitmq-1 Waiting 
 Container nhom16-parking-failover-manager-2-1 Started 
 Container nhom16-parking-failover-manager-1-1 Started 
 Container nhom16-parking-db-b-1 Healthy 
 Container nhom16-parking-parking-b-1 Starting 
 Container nhom16-parking-db-a-1 Healthy 
 Container nhom16-parking-db-a-replica-1 Starting 
 Container nhom16-parking-db-a-1 Healthy 
 Container nhom16-parking-parking-a-1 Starting 
 Container nhom16-parking-db-agg-1 Healthy 
 Container nhom16-parking-aggregator-1 Starting 
 Container nhom16-parking-db-agg-1 Healthy 
 Container nhom16-parking-aggregator-2-1 Starting 
 Container nhom16-parking-db-c-1 Healthy 
 Container nhom16-parking-parking-c-1 Starting 
 Container nhom16-parking-parking-b-1 Started 
 Container nhom16-parking-parking-a-1 Started 
 Container nhom16-parking-aggregator-1 Started 
 Container nhom16-parking-frontend-1 Starting 
 Container nhom16-parking-db-a-replica-1 Started 
 Container nhom16-parking-aggregator-2-1 Started 
 Container nhom16-parking-parking-c-1 Started 
 Container nhom16-parking-frontend-1 Started 
 Container nhom16-parking-db-e-1 Healthy 
 Container nhom16-parking-parking-e-1 Starting 
 Container nhom16-parking-db-d-1 Healthy 
 Container nhom16-parking-parking-d-1 Starting 
 Container nhom16-parking-db-f-1 Healthy 
 Container nhom16-parking-parking-f-1 Starting 
 Container nhom16-parking-parking-d-1 Started 
 Container nhom16-parking-parking-e-1 Started 
 Container nhom16-parking-parking-f-1 Started 
 Container nhom16-parking-toxiproxy-1 Starting 
 Container nhom16-parking-rabbitmq-1 Error dependency rabbitmq failed to start
Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:8474 -> 127.0.0.1:0: listen tcp 0.0.0.0:8474: bind: An attempt was made to access a socket in a way forbidden by its access permissions.

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-24T02:31:43.054Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T02:32:25.314Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile scale --profile coord --profile ha up -d --build failed: Image nhom16-pd26-notification Building 
 Image nhom16-pd26-frontend Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/aggregator Building 
 Image nhom16/failover-manager Building 
 Image nhom16/failover-manager Built 
 Image nhom16/failover-manager Built 
 Image nhom16-pd26-notification Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16-pd26-frontend Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/aggregator Built 
 Volume nhom16-pd26_db-agg-data Creating 
 Volume nhom16-pd26_db-b-data Creating 
 Volume nhom16-pd26_rabbitmq-3-data Creating 
 Volume nhom16-pd26_rabbitmq-data Creating 
 Volume nhom16-pd26_db-f-data Creating 
 Volume nhom16-pd26_etcd-2-data Creating 
 Volume nhom16-pd26_db-d-data Creating 
 Volume nhom16-pd26_db-e-data Creating 
 Volume nhom16-pd26_etcd-3-data Creating 
 Volume nhom16-pd26_db-a-replica-data Creating 
 Volume nhom16-pd26_etcd-1-data Creating 
 Volume nhom16-pd26_rabbitmq-2-data Creating 
 Volume nhom16-pd26_db-agg-data Creating 
 Volume nhom16-pd26_rabbitmq-3-data Creating 
 Volume nhom16-pd26_etcd-1-data Creating 
 Volume nhom16-pd26_etcd-2-data Creating 
 Volume nhom16-pd26_db-a-data Creating 
 Volume nhom16-pd26_db-a-replica-data Creating 
 Volume nhom16-pd26_db-a-data Creating 
 Network nhom16-pd26_default Creating 
 Volume nhom16-pd26_db-b-data Creating 
 Volume nhom16-pd26_db-d-data Creating 
 Volume nhom16-pd26_rabbitmq-data Creating 
 Volume nhom16-pd26_db-f-data Creating 
 Volume nhom16-pd26_rabbitmq-2-data Creating 
 Volume nhom16-pd26_db-e-data Creating 
 Volume nhom16-pd26_etcd-3-data Creating 
 Volume nhom16-pd26_db-c-data Creating 
 Volume nhom16-pd26_db-c-data Creating 
 Network nhom16-pd26_default Creating 
 Volume nhom16-pd26_db-agg-data Created 
 Volume nhom16-pd26_db-agg-data Created 
 Volume nhom16-pd26_db-a-replica-data Created 
 Volume nhom16-pd26_db-a-replica-data Created 
 Volume nhom16-pd26_rabbitmq-data Created 
 Volume nhom16-pd26_rabbitmq-data Created 
 Volume nhom16-pd26_etcd-1-data Created 
 Volume nhom16-pd26_etcd-1-data Created 
 Volume nhom16-pd26_etcd-3-data Created 
 Volume nhom16-pd26_etcd-3-data Created 
 Volume nhom16-pd26_db-e-data Created 
 Volume nhom16-pd26_db-e-data Created 
 Volume nhom16-pd26_rabbitmq-3-data Created 
 Volume nhom16-pd26_rabbitmq-3-data Created 
 Volume nhom16-pd26_rabbitmq-2-data Created 
 Volume nhom16-pd26_rabbitmq-2-data Created 
 Volume nhom16-pd26_db-c-data Created 
 Volume nhom16-pd26_db-c-data Created 
 Volume nhom16-pd26_etcd-2-data Created 
 Volume nhom16-pd26_etcd-2-data Created 
 Volume nhom16-pd26_db-f-data Created 
 Volume nhom16-pd26_db-f-data Created 
 Volume nhom16-pd26_db-a-data Created 
 Volume nhom16-pd26_db-a-data Created 
 Volume nhom16-pd26_db-d-data Created 
 Volume nhom16-pd26_db-d-data Created 
 Volume nhom16-pd26_db-b-data Created 
 Volume nhom16-pd26_db-b-data Created 
 Network nhom16-pd26_default Created 
 Network nhom16-pd26_default Created 
 Container nhom16-pd26-db-c-1 Creating 
 Container nhom16-pd26-db-b-1 Creating 
 Container nhom16-pd26-etcd-2-1 Creating 
 Container nhom16-pd26-db-a-1 Creating 
 Container nhom16-pd26-etcd-3-1 Creating 
 Container nhom16-pd26-db-agg-1 Creating 
 Container nhom16-pd26-db-f-1 Creating 
 Container nhom16-pd26-etcd-1-1 Creating 
 Container nhom16-pd26-db-e-1 Creating 
 Container nhom16-pd26-rabbitmq-2-1 Creating 
 Container nhom16-pd26-rabbitmq-1 Creating 
 Container nhom16-pd26-rabbitmq-3-1 Creating 
 Container nhom16-pd26-db-d-1 Creating 
 Container nhom16-pd26-etcd-2-1 Created 
 Container nhom16-pd26-db-agg-1 Created 
 Container nhom16-pd26-aggregator-1 Creating 
 Container nhom16-pd26-aggregator-2-1 Creating 
 Container nhom16-pd26-db-c-1 Created 
 Container nhom16-pd26-parking-c-1 Creating 
 Container nhom16-pd26-db-a-1 Created 
 Container nhom16-pd26-parking-a-1 Creating 
 Container nhom16-pd26-db-a-replica-1 Creating 
 Container nhom16-pd26-etcd-3-1 Created 
 Container nhom16-pd26-db-e-1 Created 
 Container nhom16-pd26-parking-e-1 Creating 
 Container nhom16-pd26-etcd-1-1 Created 
 Container nhom16-pd26-failover-manager-2-1 Creating 
 Container nhom16-pd26-failover-manager-1-1 Creating 
 Container nhom16-pd26-db-f-1 Created 
 Container nhom16-pd26-parking-f-1 Creating 
 Container nhom16-pd26-rabbitmq-2-1 Created 
 Container nhom16-pd26-rabbitmq-1 Created 
 Container nhom16-pd26-notification-1 Creating 
 Container nhom16-pd26-db-b-1 Created 
 Container nhom16-pd26-parking-b-1 Creating 
 Container nhom16-pd26-rabbitmq-3-1 Created 
 Container nhom16-pd26-db-d-1 Created 
 Container nhom16-pd26-parking-d-1 Creating 
 Container nhom16-pd26-failover-manager-1-1 Created 
 Container nhom16-pd26-failover-manager-2-1 Created 
 Container nhom16-pd26-notification-1 Created 
 Container nhom16-pd26-db-a-replica-1 Created 
 Container nhom16-pd26-aggregator-1 Created 
 Container nhom16-pd26-frontend-1 Creating 
 Container nhom16-pd26-frontend-1 Created 
 Container nhom16-pd26-aggregator-2-1 Created 
 Container nhom16-pd26-parking-c-1 Created 
 Container nhom16-pd26-parking-a-1 Created 
 Container nhom16-pd26-parking-e-1 Created 
 Container nhom16-pd26-parking-f-1 Created 
 Container nhom16-pd26-parking-b-1 Created 
 Container nhom16-pd26-parking-d-1 Created 
 Container nhom16-pd26-toxiproxy-1 Creating 
 Container nhom16-pd26-toxiproxy-1 Created 
 Container nhom16-pd26-region-latency-1 Creating 
 Container nhom16-pd26-region-latency-1 Created 
 Container nhom16-pd26-etcd-3-1 Starting 
 Container nhom16-pd26-rabbitmq-3-1 Starting 
 Container nhom16-pd26-rabbitmq-1 Starting 
 Container nhom16-pd26-db-b-1 Starting 
 Container nhom16-pd26-db-c-1 Starting 
 Container nhom16-pd26-db-e-1 Starting 
 Container nhom16-pd26-db-f-1 Starting 
 Container nhom16-pd26-db-agg-1 Starting 
 Container nhom16-pd26-db-a-1 Starting 
 Container nhom16-pd26-etcd-1-1 Starting 
 Container nhom16-pd26-rabbitmq-2-1 Starting 
 Container nhom16-pd26-db-d-1 Starting 
 Container nhom16-pd26-etcd-2-1 Starting 
 Container nhom16-pd26-db-e-1 Started 
 Container nhom16-pd26-db-e-1 Waiting 
 Container nhom16-pd26-db-b-1 Started 
 Container nhom16-pd26-db-b-1 Waiting 
 Container nhom16-pd26-etcd-1-1 Started 
 Container nhom16-pd26-failover-manager-1-1 Starting 
 Container nhom16-pd26-failover-manager-2-1 Starting 
 Container nhom16-pd26-etcd-3-1 Started 
 Container nhom16-pd26-db-a-1 Started 
 Container nhom16-pd26-db-a-1 Waiting 
 Container nhom16-pd26-db-a-1 Waiting 
 Container nhom16-pd26-db-d-1 Started 
 Container nhom16-pd26-db-d-1 Waiting 
 Container nhom16-pd26-db-c-1 Started 
 Container nhom16-pd26-db-c-1 Waiting 
 Container nhom16-pd26-etcd-2-1 Started 
 Container nhom16-pd26-db-agg-1 Started 
 Container nhom16-pd26-db-agg-1 Waiting 
 Container nhom16-pd26-db-agg-1 Waiting 
 Container nhom16-pd26-db-f-1 Started 
 Container nhom16-pd26-db-f-1 Waiting 
 Container nhom16-pd26-rabbitmq-3-1 Started 
 Container nhom16-pd26-rabbitmq-1 Started 
 Container nhom16-pd26-rabbitmq-1 Waiting 
 Container nhom16-pd26-rabbitmq-2-1 Started 
 Container nhom16-pd26-failover-manager-2-1 Started 
 Container nhom16-pd26-failover-manager-1-1 Started 
 Container nhom16-pd26-db-a-1 Healthy 
 Container nhom16-pd26-parking-a-1 Starting 
 Container nhom16-pd26-db-a-1 Healthy 
 Container nhom16-pd26-db-a-replica-1 Starting 
 Container nhom16-pd26-db-d-1 Healthy 
 Container nhom16-pd26-parking-d-1 Starting 
 Container nhom16-pd26-db-c-1 Healthy 
 Container nhom16-pd26-parking-c-1 Starting 
 Container nhom16-pd26-db-agg-1 Healthy 
 Container nhom16-pd26-aggregator-2-1 Starting 
 Container nhom16-pd26-db-agg-1 Healthy 
 Container nhom16-pd26-aggregator-1 Starting 
 Container nhom16-pd26-db-f-1 Healthy 
 Container nhom16-pd26-parking-f-1 Starting 
 Container nhom16-pd26-parking-a-1 Started 
 Container nhom16-pd26-parking-d-1 Started 
 Container nhom16-pd26-db-a-replica-1 Started 
 Container nhom16-pd26-parking-c-1 Started 
 Container nhom16-pd26-aggregator-2-1 Started 
 Container nhom16-pd26-parking-f-1 Started 
 Container nhom16-pd26-aggregator-1 Started 
 Container nhom16-pd26-frontend-1 Starting 
 Container nhom16-pd26-db-e-1 Healthy 
 Container nhom16-pd26-parking-e-1 Starting 
 Container nhom16-pd26-db-b-1 Healthy 
 Container nhom16-pd26-parking-b-1 Starting 
 Container nhom16-pd26-frontend-1 Started 
 Container nhom16-pd26-parking-e-1 Started 
 Container nhom16-pd26-toxiproxy-1 Starting 
 Container nhom16-pd26-parking-b-1 Started 
 Container nhom16-pd26-toxiproxy-1 Started 
 Container nhom16-pd26-region-latency-1 Starting 
 Container nhom16-pd26-region-latency-1 Started 
 Container nhom16-pd26-rabbitmq-1 Error dependency rabbitmq failed to start
dependency failed to start: container nhom16-pd26-rabbitmq-1 exited (1)

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-24T02:38:34.814Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T02:40:06.644Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile scale --profile coord --profile ha up -d --build --wait --wait-timeout 180 failed: Image nhom16/failover-manager Building 
 Image nhom16/aggregator Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-v2-frontend Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-v2-notification Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/failover-manager Built 
 Image nhom16/aggregator Built 
 Image nhom16/failover-manager Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16-pd26-v2-notification Built 
 Image nhom16-pd26-v2-frontend Built 
 Volume nhom16-pd26-v2_db-d-data Creating 
 Volume nhom16-pd26-v2_db-a-replica-data Creating 
 Volume nhom16-pd26-v2_db-e-data Creating 
 Volume nhom16-pd26-v2_db-f-data Creating 
 Network nhom16-pd26-v2_default Creating 
 Volume nhom16-pd26-v2_etcd-1-data Creating 
 Volume nhom16-pd26-v2_db-a-data Creating 
 Volume nhom16-pd26-v2_db-d-data Creating 
 Volume nhom16-pd26-v2_db-a-data Creating 
 Network nhom16-pd26-v2_default Creating 
 Volume nhom16-pd26-v2_db-agg-data Creating 
 Volume nhom16-pd26-v2_rabbitmq-data Creating 
 Volume nhom16-pd26-v2_db-agg-data Creating 
 Volume nhom16-pd26-v2_rabbitmq-data Creating 
 Volume nhom16-pd26-v2_etcd-3-data Creating 
 Volume nhom16-pd26-v2_etcd-3-data Creating 
 Volume nhom16-pd26-v2_db-e-data Creating 
 Volume nhom16-pd26-v2_db-a-replica-data Creating 
 Volume nhom16-pd26-v2_rabbitmq-3-data Creating 
 Volume nhom16-pd26-v2_rabbitmq-3-data Creating 
 Volume nhom16-pd26-v2_etcd-1-data Creating 
 Volume nhom16-pd26-v2_db-b-data Creating 
 Volume nhom16-pd26-v2_db-b-data Creating 
 Volume nhom16-pd26-v2_db-f-data Creating 
 Volume nhom16-pd26-v2_rabbitmq-2-data Creating 
 Volume nhom16-pd26-v2_rabbitmq-2-data Creating 
 Volume nhom16-pd26-v2_etcd-2-data Creating 
 Volume nhom16-pd26-v2_db-c-data Creating 
 Volume nhom16-pd26-v2_db-c-data Creating 
 Volume nhom16-pd26-v2_etcd-2-data Creating 
 Volume nhom16-pd26-v2_rabbitmq-data Created 
 Volume nhom16-pd26-v2_rabbitmq-data Created 
 Volume nhom16-pd26-v2_db-agg-data Created 
 Volume nhom16-pd26-v2_db-agg-data Created 
 Volume nhom16-pd26-v2_db-b-data Created 
 Volume nhom16-pd26-v2_db-b-data Created 
 Volume nhom16-pd26-v2_db-d-data Created 
 Volume nhom16-pd26-v2_db-d-data Created 
 Volume nhom16-pd26-v2_db-a-replica-data Created 
 Volume nhom16-pd26-v2_db-a-replica-data Created 
 Volume nhom16-pd26-v2_etcd-2-data Created 
 Volume nhom16-pd26-v2_etcd-2-data Created 
 Volume nhom16-pd26-v2_db-a-data Created 
 Volume nhom16-pd26-v2_db-a-data Created 
 Volume nhom16-pd26-v2_rabbitmq-2-data Created 
 Volume nhom16-pd26-v2_rabbitmq-2-data Created 
 Volume nhom16-pd26-v2_etcd-3-data Created 
 Volume nhom16-pd26-v2_etcd-3-data Created 
 Volume nhom16-pd26-v2_db-e-data Created 
 Volume nhom16-pd26-v2_db-e-data Created 
 Volume nhom16-pd26-v2_db-c-data Created 
 Volume nhom16-pd26-v2_db-c-data Created 
 Volume nhom16-pd26-v2_rabbitmq-3-data Created 
 Volume nhom16-pd26-v2_rabbitmq-3-data Created 
 Volume nhom16-pd26-v2_etcd-1-data Created 
 Volume nhom16-pd26-v2_etcd-1-data Created 
 Volume nhom16-pd26-v2_db-f-data Created 
 Volume nhom16-pd26-v2_db-f-data Created 
 Network nhom16-pd26-v2_default Created 
 Network nhom16-pd26-v2_default Created 
 Container nhom16-pd26-v2-db-b-1 Creating 
 Container nhom16-pd26-v2-db-a-1 Creating 
 Container nhom16-pd26-v2-etcd-2-1 Creating 
 Container nhom16-pd26-v2-etcd-1-1 Creating 
 Container nhom16-pd26-v2-rabbitmq-3-1 Creating 
 Container nhom16-pd26-v2-rabbitmq-1 Creating 
 Container nhom16-pd26-v2-db-d-1 Creating 
 Container nhom16-pd26-v2-db-agg-1 Creating 
 Container nhom16-pd26-v2-db-f-1 Creating 
 Container nhom16-pd26-v2-rabbitmq-2-1 Creating 
 Container nhom16-pd26-v2-db-c-1 Creating 
 Container nhom16-pd26-v2-etcd-3-1 Creating 
 Container nhom16-pd26-v2-db-e-1 Creating 
 Container nhom16-pd26-v2-etcd-2-1 Created 
 Container nhom16-pd26-v2-etcd-1-1 Created 
 Container nhom16-pd26-v2-failover-manager-1-1 Creating 
 Container nhom16-pd26-v2-failover-manager-2-1 Creating 
 Container nhom16-pd26-v2-etcd-3-1 Created 
 Container nhom16-pd26-v2-db-f-1 Created 
 Container nhom16-pd26-v2-db-agg-1 Created 
 Container nhom16-pd26-v2-parking-f-1 Creating 
 Container nhom16-pd26-v2-aggregator-1 Creating 
 Container nhom16-pd26-v2-aggregator-2-1 Creating 
 Container nhom16-pd26-v2-db-d-1 Created 
 Container nhom16-pd26-v2-parking-d-1 Creating 
 Container nhom16-pd26-v2-db-a-1 Created 
 Container nhom16-pd26-v2-db-a-replica-1 Creating 
 Container nhom16-pd26-v2-parking-a-1 Creating 
 Container nhom16-pd26-v2-db-e-1 Created 
 Container nhom16-pd26-v2-parking-e-1 Creating 
 Container nhom16-pd26-v2-db-b-1 Created 
 Container nhom16-pd26-v2-parking-b-1 Creating 
 Container nhom16-pd26-v2-rabbitmq-1 Created 
 Container nhom16-pd26-v2-notification-1 Creating 
 Container nhom16-pd26-v2-rabbitmq-3-1 Created 
 Container nhom16-pd26-v2-db-c-1 Created 
 Container nhom16-pd26-v2-rabbitmq-2-1 Created 
 Container nhom16-pd26-v2-parking-c-1 Creating 
 Container nhom16-pd26-v2-failover-manager-1-1 Created 
 Container nhom16-pd26-v2-failover-manager-2-1 Created 
 Container nhom16-pd26-v2-notification-1 Created 
 Container nhom16-pd26-v2-db-a-replica-1 Created 
 Container nhom16-pd26-v2-aggregator-1 Created 
 Container nhom16-pd26-v2-frontend-1 Creating 
 Container nhom16-pd26-v2-frontend-1 Created 
 Container nhom16-pd26-v2-parking-f-1 Created 
 Container nhom16-pd26-v2-aggregator-2-1 Created 
 Container nhom16-pd26-v2-parking-d-1 Created 
 Container nhom16-pd26-v2-parking-a-1 Created 
 Container nhom16-pd26-v2-parking-e-1 Created 
 Container nhom16-pd26-v2-toxiproxy-1 Creating 
 Container nhom16-pd26-v2-toxiproxy-1 Created 
 Container nhom16-pd26-v2-region-latency-1 Creating 
 Container nhom16-pd26-v2-region-latency-1 Created 
 Container nhom16-pd26-v2-parking-b-1 Created 
 Container nhom16-pd26-v2-parking-c-1 Created 
 Container nhom16-pd26-v2-db-a-1 Starting 
 Container nhom16-pd26-v2-etcd-3-1 Starting 
 Container nhom16-pd26-v2-db-d-1 Starting 
 Container nhom16-pd26-v2-rabbitmq-2-1 Starting 
 Container nhom16-pd26-v2-rabbitmq-1 Starting 
 Container nhom16-pd26-v2-db-f-1 Starting 
 Container nhom16-pd26-v2-db-agg-1 Starting 
 Container nhom16-pd26-v2-etcd-1-1 Starting 
 Container nhom16-pd26-v2-db-b-1 Starting 
 Container nhom16-pd26-v2-db-e-1 Starting 
 Container nhom16-pd26-v2-rabbitmq-3-1 Starting 
 Container nhom16-pd26-v2-etcd-2-1 Starting 
 Container nhom16-pd26-v2-db-c-1 Starting 
 Container nhom16-pd26-v2-db-f-1 Started 
 Container nhom16-pd26-v2-db-f-1 Waiting 
 Container nhom16-pd26-v2-db-d-1 Started 
 Container nhom16-pd26-v2-db-d-1 Waiting 
 Container nhom16-pd26-v2-db-b-1 Started 
 Container nhom16-pd26-v2-db-b-1 Waiting 
 Container nhom16-pd26-v2-etcd-3-1 Started 
 Container nhom16-pd26-v2-db-a-1 Started 
 Container nhom16-pd26-v2-db-a-1 Waiting 
 Container nhom16-pd26-v2-db-a-1 Waiting 
 Container nhom16-pd26-v2-db-e-1 Started 
 Container nhom16-pd26-v2-db-e-1 Waiting 
 Container nhom16-pd26-v2-etcd-2-1 Started 
 Container nhom16-pd26-v2-etcd-1-1 Started 
 Container nhom16-pd26-v2-failover-manager-1-1 Starting 
 Container nhom16-pd26-v2-failover-manager-2-1 Starting 
 Container nhom16-pd26-v2-db-agg-1 Started 
 Container nhom16-pd26-v2-db-agg-1 Waiting 
 Container nhom16-pd26-v2-db-agg-1 Waiting 
 Container nhom16-pd26-v2-rabbitmq-1 Started 
 Container nhom16-pd26-v2-rabbitmq-1 Waiting 
 Container nhom16-pd26-v2-db-c-1 Started 
 Container nhom16-pd26-v2-db-c-1 Waiting 
 Container nhom16-pd26-v2-rabbitmq-3-1 Started 
 Container nhom16-pd26-v2-rabbitmq-2-1 Started 
 Container nhom16-pd26-v2-failover-manager-1-1 Started 
 Container nhom16-pd26-v2-failover-manager-2-1 Started 
 Container nhom16-pd26-v2-db-f-1 Healthy 
 Container nhom16-pd26-v2-parking-f-1 Starting 
 Container nhom16-pd26-v2-db-d-1 Healthy 
 Container nhom16-pd26-v2-parking-d-1 Starting 
 Container nhom16-pd26-v2-db-a-1 Healthy 
 Container nhom16-pd26-v2-db-a-replica-1 Starting 
 Container nhom16-pd26-v2-db-a-1 Healthy 
 Container nhom16-pd26-v2-parking-a-1 Starting 
 Container nhom16-pd26-v2-db-e-1 Healthy 
 Container nhom16-pd26-v2-parking-e-1 Starting 
 Container nhom16-pd26-v2-parking-f-1 Started 
 Container nhom16-pd26-v2-db-agg-1 Healthy 
 Container nhom16-pd26-v2-aggregator-1 Starting 
 Container nhom16-pd26-v2-db-agg-1 Healthy 
 Container nhom16-pd26-v2-aggregator-2-1 Starting 
 Container nhom16-pd26-v2-parking-d-1 Started 
 Container nhom16-pd26-v2-db-c-1 Healthy 
 Container nhom16-pd26-v2-parking-c-1 Starting 
 Container nhom16-pd26-v2-db-a-replica-1 Started 
 Container nhom16-pd26-v2-parking-a-1 Started 
 Container nhom16-pd26-v2-parking-e-1 Started 
 Container nhom16-pd26-v2-toxiproxy-1 Starting 
 Container nhom16-pd26-v2-aggregator-2-1 Started 
 Container nhom16-pd26-v2-aggregator-1 Started 
 Container nhom16-pd26-v2-frontend-1 Starting 
 Container nhom16-pd26-v2-parking-c-1 Started 
 Container nhom16-pd26-v2-db-b-1 Healthy 
 Container nhom16-pd26-v2-parking-b-1 Starting 
 Container nhom16-pd26-v2-toxiproxy-1 Started 
 Container nhom16-pd26-v2-region-latency-1 Starting 
 Container nhom16-pd26-v2-frontend-1 Started 
 Container nhom16-pd26-v2-parking-b-1 Started 
 Container nhom16-pd26-v2-region-latency-1 Started 
 Container nhom16-pd26-v2-rabbitmq-1 Healthy 
 Container nhom16-pd26-v2-notification-1 Starting 
 Container nhom16-pd26-v2-notification-1 Started 
 Container nhom16-pd26-v2-db-f-1 Waiting 
 Container nhom16-pd26-v2-parking-a-1 Waiting 
 Container nhom16-pd26-v2-etcd-1-1 Waiting 
 Container nhom16-pd26-v2-parking-d-1 Waiting 
 Container nhom16-pd26-v2-etcd-2-1 Waiting 
 Container nhom16-pd26-v2-toxiproxy-1 Waiting 
 Container nhom16-pd26-v2-parking-b-1 Waiting 
 Container nhom16-pd26-v2-aggregator-2-1 Waiting 
 Container nhom16-pd26-v2-db-c-1 Waiting 
 Container nhom16-pd26-v2-etcd-3-1 Waiting 
 Container nhom16-pd26-v2-region-latency-1 Waiting 
 Container nhom16-pd26-v2-db-e-1 Waiting 
 Container nhom16-pd26-v2-parking-c-1 Waiting 
 Container nhom16-pd26-v2-notification-1 Waiting 
 Container nhom16-pd26-v2-db-agg-1 Waiting 
 Container nhom16-pd26-v2-aggregator-1 Waiting 
 Container nhom16-pd26-v2-frontend-1 Waiting 
 Container nhom16-pd26-v2-rabbitmq-2-1 Waiting 
 Container nhom16-pd26-v2-parking-e-1 Waiting 
 Container nhom16-pd26-v2-failover-manager-1-1 Waiting 
 Container nhom16-pd26-v2-db-d-1 Waiting 
 Container nhom16-pd26-v2-rabbitmq-3-1 Waiting 
 Container nhom16-pd26-v2-db-b-1 Waiting 
 Container nhom16-pd26-v2-failover-manager-2-1 Waiting 
 Container nhom16-pd26-v2-db-a-replica-1 Waiting 
 Container nhom16-pd26-v2-parking-f-1 Waiting 
 Container nhom16-pd26-v2-rabbitmq-1 Waiting 
 Container nhom16-pd26-v2-db-a-1 Waiting 
 Container nhom16-pd26-v2-toxiproxy-1 Healthy 
 Container nhom16-pd26-v2-parking-b-1 Healthy 
container nhom16-pd26-v2-region-latency-1 exited (0)

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-24T02:41:38.429Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T02:43:32.020Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- Không đăng nhập được tài khoản tải user1: HTTP 0

| Bất biến | Kết quả | Chi tiết |
|---|---|---|
| 1. No overlapping ACTIVE reservations | ĐẠT | no overlapping ACTIVE/USED reservations |
| 2. Successful command has exactly one effect | LỖI | No command IDs recorded in history |
| 3. Every accepted command is terminal | LỖI | No command IDs recorded in history |
| 4. Outbox empty and cache converged within 30s | LỖI | did not converge within 30s: fetch failed |
| 5. Slot versions are contiguous and monotonic | ĐẠT | all recorded slot versions are contiguous |
| 6. Exactly one writable DB primary by epoch | ĐẠT | db-a epoch=1 primary=true; db-a-replica epoch=1 primary=false; active primaries=1 |

## 2026-10-24T02:45:24.051Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T02:48:46.468Z
- Lịch sử: `tests/jepsen/history.jsonl`

| Bất biến | Kết quả | Chi tiết |
|---|---|---|
| 1. No overlapping ACTIVE reservations | ĐẠT | no overlapping ACTIVE/USED reservations |
| 2. Successful command has exactly one effect | LỖI | 0 successful commands; each has one inbox/effect record |
| 3. Every accepted command is terminal | LỖI | 0 accepted commands ended in a terminal state |
| 4. Outbox empty and cache converged within 30s | ĐẠT | all six outboxes are empty and caches match database snapshots |
| 5. Slot versions are contiguous and monotonic | ĐẠT | all recorded slot versions are contiguous |
| 6. Exactly one writable DB primary by epoch | ĐẠT | db-a epoch=1 primary=true; db-a-replica epoch=1 primary=false; active primaries=1 |

## 2026-10-24T02:49:24.979Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T02:51:42.276Z
- Lịch sử: `tests/jepsen/history.jsonl`

| Bất biến | Kết quả | Chi tiết |
|---|---|---|
| 1. No overlapping ACTIVE reservations | ĐẠT | no overlapping ACTIVE/USED reservations |
| 2. Successful command has exactly one effect | LỖI | 0 successful commands; each has one inbox/effect record |
| 3. Every accepted command is terminal | LỖI | 876995b5-a6e5-49ea-8c9d-34bf823d373d:jepsen-mvlsx230-5: nonterminal status PENDING; 876995b5-a6e5-49ea-8c9d-34bf823d373d:jepsen-mvlsx230-7: nonterminal status PENDING; 876995b5-a6e5-49ea-8c9d-34bf823d373d:jepsen-mvlsx230-10: nonterminal status PENDING; 876995b5-a6e5-49ea-8c9d-34bf823d373d:jepsen-mvlsx230-12: nonterminal status PENDING; 876995b5-a6e5-49ea-8c9d-34bf823d373d:jepsen-mvlsx230-20: nonterminal status PENDING |
| 4. Outbox empty and cache converged within 30s | ĐẠT | all six outboxes are empty and caches match database snapshots |
| 5. Slot versions are contiguous and monotonic | ĐẠT | all recorded slot versions are contiguous |
| 6. Exactly one writable DB primary by epoch | ĐẠT | db-a epoch=1 primary=true; db-a-replica epoch=1 primary=false; active primaries=1 |

## 2026-10-24T02:57:07.333Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T02:58:28.586Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile scale --profile coord --profile ha up -d --build failed: Image nhom16/aggregator Building 
 Image nhom16/failover-manager Building 
 Image nhom16-pd26-v3-frontend Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-v3-notification Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-v3-notification Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/failover-manager Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16-pd26-v3-frontend Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/failover-manager Built 
 Image nhom16/aggregator Built 
 Volume nhom16-pd26-v3_db-agg-data Creating 
 Volume nhom16-pd26-v3_db-a-data Creating 
 Network nhom16-pd26-v3_default Creating 
 Volume nhom16-pd26-v3_db-a-replica-data Creating 
 Volume nhom16-pd26-v3_db-d-data Creating 
 Volume nhom16-pd26-v3_db-e-data Creating 
 Volume nhom16-pd26-v3_db-f-data Creating 
 Volume nhom16-pd26-v3_etcd-1-data Creating 
 Volume nhom16-pd26-v3_etcd-2-data Creating 
 Volume nhom16-pd26-v3_etcd-3-data Creating 
 Volume nhom16-pd26-v3_rabbitmq-3-data Creating 
 Volume nhom16-pd26-v3_rabbitmq-data Creating 
 Volume nhom16-pd26-v3_rabbitmq-3-data Creating 
 Volume nhom16-pd26-v3_db-a-data Creating 
 Volume nhom16-pd26-v3_etcd-2-data Creating 
 Volume nhom16-pd26-v3_db-d-data Creating 
 Volume nhom16-pd26-v3_db-c-data Creating 
 Volume nhom16-pd26-v3_db-f-data Creating 
 Volume nhom16-pd26-v3_etcd-3-data Creating 
 Volume nhom16-pd26-v3_db-a-replica-data Creating 
 Volume nhom16-pd26-v3_etcd-1-data Creating 
 Volume nhom16-pd26-v3_db-e-data Creating 
 Volume nhom16-pd26-v3_db-agg-data Creating 
 Volume nhom16-pd26-v3_db-c-data Creating 
 Volume nhom16-pd26-v3_rabbitmq-2-data Creating 
 Volume nhom16-pd26-v3_db-b-data Creating 
 Volume nhom16-pd26-v3_rabbitmq-2-data Creating 
 Volume nhom16-pd26-v3_rabbitmq-data Creating 
 Volume nhom16-pd26-v3_db-b-data Creating 
 Network nhom16-pd26-v3_default Creating 
 Volume nhom16-pd26-v3_db-c-data Created 
 Volume nhom16-pd26-v3_db-c-data Created 
 Volume nhom16-pd26-v3_db-a-data Created 
 Volume nhom16-pd26-v3_db-a-data Created 
 Volume nhom16-pd26-v3_etcd-1-data Created 
 Volume nhom16-pd26-v3_etcd-1-data Created 
 Volume nhom16-pd26-v3_db-b-data Created 
 Volume nhom16-pd26-v3_db-b-data Created 
 Volume nhom16-pd26-v3_etcd-3-data Created 
 Volume nhom16-pd26-v3_etcd-3-data Created 
 Volume nhom16-pd26-v3_rabbitmq-3-data Created 
 Volume nhom16-pd26-v3_rabbitmq-3-data Created 
 Volume nhom16-pd26-v3_db-d-data Created 
 Volume nhom16-pd26-v3_db-d-data Created 
 Volume nhom16-pd26-v3_rabbitmq-2-data Created 
 Volume nhom16-pd26-v3_rabbitmq-2-data Created 
 Volume nhom16-pd26-v3_db-agg-data Created 
 Volume nhom16-pd26-v3_db-agg-data Created 
 Volume nhom16-pd26-v3_db-a-replica-data Created 
 Volume nhom16-pd26-v3_db-a-replica-data Created 
 Volume nhom16-pd26-v3_db-e-data Created 
 Volume nhom16-pd26-v3_db-e-data Created 
 Volume nhom16-pd26-v3_etcd-2-data Created 
 Volume nhom16-pd26-v3_etcd-2-data Created 
 Volume nhom16-pd26-v3_db-f-data Created 
 Volume nhom16-pd26-v3_db-f-data Created 
 Volume nhom16-pd26-v3_rabbitmq-data Created 
 Volume nhom16-pd26-v3_rabbitmq-data Created 
 Network nhom16-pd26-v3_default Created 
 Network nhom16-pd26-v3_default Created 
 Container nhom16-pd26-v3-db-d-1 Creating 
 Container nhom16-pd26-v3-db-c-1 Creating 
 Container nhom16-pd26-v3-etcd-3-1 Creating 
 Container nhom16-pd26-v3-etcd-2-1 Creating 
 Container nhom16-pd26-v3-etcd-1-1 Creating 
 Container nhom16-pd26-v3-db-f-1 Creating 
 Container nhom16-pd26-v3-db-b-1 Creating 
 Container nhom16-pd26-v3-db-agg-1 Creating 
 Container nhom16-pd26-v3-rabbitmq-3-1 Creating 
 Container nhom16-pd26-v3-rabbitmq-2-1 Creating 
 Container nhom16-pd26-v3-rabbitmq-1 Creating 
 Container nhom16-pd26-v3-db-a-1 Creating 
 Container nhom16-pd26-v3-db-e-1 Creating 
 Container nhom16-pd26-v3-etcd-3-1 Created 
 Container nhom16-pd26-v3-etcd-2-1 Created 
 Container nhom16-pd26-v3-etcd-1-1 Created 
 Container nhom16-pd26-v3-failover-manager-1-1 Creating 
 Container nhom16-pd26-v3-failover-manager-2-1 Creating 
 Container nhom16-pd26-v3-db-d-1 Created 
 Container nhom16-pd26-v3-parking-d-1 Creating 
 Container nhom16-pd26-v3-db-agg-1 Created 
 Container nhom16-pd26-v3-aggregator-1 Creating 
 Container nhom16-pd26-v3-aggregator-2-1 Creating 
 Container nhom16-pd26-v3-db-a-1 Created 
 Container nhom16-pd26-v3-db-a-replica-1 Creating 
 Container nhom16-pd26-v3-parking-a-1 Creating 
 Container nhom16-pd26-v3-db-f-1 Created 
 Container nhom16-pd26-v3-parking-f-1 Creating 
 Container nhom16-pd26-v3-db-e-1 Created 
 Container nhom16-pd26-v3-parking-e-1 Creating 
 Container nhom16-pd26-v3-rabbitmq-3-1 Created 
 Container nhom16-pd26-v3-db-c-1 Created 
 Container nhom16-pd26-v3-parking-c-1 Creating 
 Container nhom16-pd26-v3-db-b-1 Created 
 Container nhom16-pd26-v3-parking-b-1 Creating 
 Container nhom16-pd26-v3-rabbitmq-1 Created 
 Container nhom16-pd26-v3-notification-1 Creating 
 Container nhom16-pd26-v3-rabbitmq-2-1 Created 
 Container nhom16-pd26-v3-failover-manager-2-1 Created 
 Container nhom16-pd26-v3-failover-manager-1-1 Created 
 Container nhom16-pd26-v3-notification-1 Created 
 Container nhom16-pd26-v3-db-a-replica-1 Created 
 Container nhom16-pd26-v3-parking-d-1 Created 
 Container nhom16-pd26-v3-aggregator-1 Created 
 Container nhom16-pd26-v3-frontend-1 Creating 
 Container nhom16-pd26-v3-aggregator-2-1 Created 
 Container nhom16-pd26-v3-frontend-1 Created 
 Container nhom16-pd26-v3-parking-a-1 Created 
 Container nhom16-pd26-v3-parking-f-1 Created 
 Container nhom16-pd26-v3-parking-e-1 Created 
 Container nhom16-pd26-v3-toxiproxy-1 Creating 
 Container nhom16-pd26-v3-toxiproxy-1 Created 
 Container nhom16-pd26-v3-region-latency-1 Creating 
 Container nhom16-pd26-v3-parking-c-1 Created 
 Container nhom16-pd26-v3-region-latency-1 Created 
 Container nhom16-pd26-v3-parking-b-1 Created 
 Container nhom16-pd26-v3-db-d-1 Starting 
 Container nhom16-pd26-v3-rabbitmq-2-1 Starting 
 Container nhom16-pd26-v3-db-b-1 Starting 
 Container nhom16-pd26-v3-db-agg-1 Starting 
 Container nhom16-pd26-v3-etcd-2-1 Starting 
 Container nhom16-pd26-v3-rabbitmq-1 Starting 
 Container nhom16-pd26-v3-rabbitmq-3-1 Starting 
 Container nhom16-pd26-v3-etcd-3-1 Starting 
 Container nhom16-pd26-v3-db-e-1 Starting 
 Container nhom16-pd26-v3-etcd-1-1 Starting 
 Container nhom16-pd26-v3-db-a-1 Starting 
 Container nhom16-pd26-v3-db-c-1 Starting 
 Container nhom16-pd26-v3-db-f-1 Starting 
 Container nhom16-pd26-v3-rabbitmq-2-1 Started 
 Container nhom16-pd26-v3-db-b-1 Started 
 Container nhom16-pd26-v3-db-b-1 Waiting 
 Container nhom16-pd26-v3-rabbitmq-3-1 Started 
 Container nhom16-pd26-v3-db-agg-1 Started 
 Container nhom16-pd26-v3-db-agg-1 Waiting 
 Container nhom16-pd26-v3-db-agg-1 Waiting 
 Container nhom16-pd26-v3-db-d-1 Started 
 Container nhom16-pd26-v3-db-d-1 Waiting 
 Container nhom16-pd26-v3-db-f-1 Started 
 Container nhom16-pd26-v3-db-f-1 Waiting 
 Container nhom16-pd26-v3-db-e-1 Started 
 Container nhom16-pd26-v3-db-e-1 Waiting 
 Container nhom16-pd26-v3-db-a-1 Started 
 Container nhom16-pd26-v3-db-a-1 Waiting 
 Container nhom16-pd26-v3-db-a-1 Waiting 
 Container nhom16-pd26-v3-db-c-1 Started 
 Container nhom16-pd26-v3-db-b-1 Healthy 
 Container nhom16-pd26-v3-parking-b-1 Starting 
 Container nhom16-pd26-v3-db-a-1 Healthy 
 Container nhom16-pd26-v3-parking-a-1 Starting 
 Container nhom16-pd26-v3-db-a-1 Healthy 
 Container nhom16-pd26-v3-db-a-replica-1 Starting 
 Container nhom16-pd26-v3-db-f-1 Healthy 
 Container nhom16-pd26-v3-parking-f-1 Starting 
 Container nhom16-pd26-v3-db-d-1 Healthy 
 Container nhom16-pd26-v3-parking-d-1 Starting 
 Container nhom16-pd26-v3-db-agg-1 Healthy 
 Container nhom16-pd26-v3-aggregator-1 Starting 
 Container nhom16-pd26-v3-db-agg-1 Healthy 
 Container nhom16-pd26-v3-aggregator-2-1 Starting 
 Container nhom16-pd26-v3-db-e-1 Healthy 
 Container nhom16-pd26-v3-parking-e-1 Starting 
 Container nhom16-pd26-v3-db-a-replica-1 Started 
Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint nhom16-pd26-v3-etcd-2-1 (9868f836f3b89d292e990f3fe0b6233764e5abe9244a81b5c34c5d875aec8d84): Bind for 0.0.0.0:22379 failed: port is already allocated

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-24T02:59:31.097Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T03:05:10.606Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile scale --profile coord --profile ha up -d --build failed: Image nhom16/parking-node Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-v3-frontend Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/failover-manager Building 
 Image nhom16/aggregator Building 
 Image nhom16-pd26-v3-notification Building 
 Image nhom16/parking-node Built 
 Image nhom16-pd26-v3-notification Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16-pd26-v3-frontend Built 
 Image nhom16/failover-manager Built 
 Image nhom16/parking-node Built 
 Image nhom16/failover-manager Built 
 Image nhom16/parking-node Built 
 Image nhom16/aggregator Built 
 Container nhom16-pd26-v3-failover-manager-1-1 Recreate 
 Container nhom16-pd26-v3-failover-manager-2-1 Recreate 
 Container nhom16-pd26-v3-parking-a-1 Recreate 
 Container nhom16-pd26-v3-parking-b-1 Recreate 
 Container nhom16-pd26-v3-parking-c-1 Recreate 
 Container nhom16-pd26-v3-parking-d-1 Recreate 
 Container nhom16-pd26-v3-parking-e-1 Recreate 
 Container nhom16-pd26-v3-parking-f-1 Recreate 
 Container nhom16-pd26-v3-failover-manager-1-1 Recreated 
 Container nhom16-pd26-v3-failover-manager-2-1 Recreated 
 Container nhom16-pd26-v3-parking-d-1 Recreated 
 Container nhom16-pd26-v3-parking-e-1 Recreated 
 Container nhom16-pd26-v3-parking-c-1 Recreated 
 Container nhom16-pd26-v3-parking-a-1 Recreated 
 Container nhom16-pd26-v3-parking-f-1 Recreated 
 Container nhom16-pd26-v3-parking-b-1 Recreated 
 Container nhom16-pd26-v3-etcd-3-1 Starting 
 Container nhom16-pd26-v3-rabbitmq-2-1 Starting 
 Container nhom16-pd26-v3-db-e-1 Starting 
 Container nhom16-pd26-v3-db-agg-1 Starting 
 Container nhom16-pd26-v3-db-f-1 Starting 
 Container nhom16-pd26-v3-db-d-1 Starting 
 Container nhom16-pd26-v3-rabbitmq-1 Starting 
 Container nhom16-pd26-v3-db-b-1 Starting 
 Container nhom16-pd26-v3-rabbitmq-3-1 Starting 
 Container nhom16-pd26-v3-etcd-2-1 Starting 
 Container nhom16-pd26-v3-db-a-1 Starting 
 Container nhom16-pd26-v3-etcd-1-1 Starting 
 Container nhom16-pd26-v3-db-c-1 Starting 
 Container nhom16-pd26-v3-etcd-3-1 Started 
 Container nhom16-pd26-v3-db-e-1 Started 
 Container nhom16-pd26-v3-db-e-1 Waiting 
 Container nhom16-pd26-v3-etcd-2-1 Started 
 Container nhom16-pd26-v3-db-f-1 Started 
 Container nhom16-pd26-v3-db-f-1 Waiting 
 Container nhom16-pd26-v3-rabbitmq-1 Started 
 Container nhom16-pd26-v3-rabbitmq-1 Waiting 
 Container nhom16-pd26-v3-etcd-1-1 Started 
 Container nhom16-pd26-v3-failover-manager-2-1 Starting 
 Container nhom16-pd26-v3-failover-manager-1-1 Starting 
 Container nhom16-pd26-v3-db-agg-1 Started 
 Container nhom16-pd26-v3-db-agg-1 Waiting 
 Container nhom16-pd26-v3-db-agg-1 Waiting 
 Container nhom16-pd26-v3-db-b-1 Started 
 Container nhom16-pd26-v3-db-b-1 Waiting 
 Container nhom16-pd26-v3-db-d-1 Started 
 Container nhom16-pd26-v3-db-d-1 Waiting 
 Container nhom16-pd26-v3-rabbitmq-3-1 Started 
 Container nhom16-pd26-v3-db-a-1 Started 
 Container nhom16-pd26-v3-db-a-1 Waiting 
 Container nhom16-pd26-v3-db-a-1 Waiting 
 Container nhom16-pd26-v3-rabbitmq-2-1 Started 
 Container nhom16-pd26-v3-db-c-1 Started 
 Container nhom16-pd26-v3-db-c-1 Waiting 
 Container nhom16-pd26-v3-failover-manager-2-1 Started 
 Container nhom16-pd26-v3-failover-manager-1-1 Started 
 Container nhom16-pd26-v3-db-e-1 Healthy 
 Container nhom16-pd26-v3-parking-e-1 Starting 
 Container nhom16-pd26-v3-db-f-1 Healthy 
 Container nhom16-pd26-v3-parking-f-1 Starting 
 Container nhom16-pd26-v3-db-agg-1 Healthy 
 Container nhom16-pd26-v3-db-agg-1 Healthy 
 Container nhom16-pd26-v3-aggregator-1 Starting 
 Container nhom16-pd26-v3-aggregator-2-1 Starting 
 Container nhom16-pd26-v3-parking-e-1 Started 
 Container nhom16-pd26-v3-aggregator-2-1 Started 
 Container nhom16-pd26-v3-aggregator-1 Started 
 Container nhom16-pd26-v3-frontend-1 Starting 
 Container nhom16-pd26-v3-db-b-1 Healthy 
 Container nhom16-pd26-v3-parking-b-1 Starting 
 Container nhom16-pd26-v3-db-d-1 Healthy 
 Container nhom16-pd26-v3-parking-d-1 Starting 
 Container nhom16-pd26-v3-parking-f-1 Started 
 Container nhom16-pd26-v3-db-a-1 Healthy 
 Container nhom16-pd26-v3-parking-a-1 Starting 
 Container nhom16-pd26-v3-db-a-1 Healthy 
 Container nhom16-pd26-v3-db-a-replica-1 Starting 
 Container nhom16-pd26-v3-db-c-1 Healthy 
 Container nhom16-pd26-v3-parking-c-1 Starting 
 Container nhom16-pd26-v3-frontend-1 Started 
 Container nhom16-pd26-v3-parking-b-1 Started 
 Container nhom16-pd26-v3-parking-d-1 Started 
 Container nhom16-pd26-v3-toxiproxy-1 Starting 
 Container nhom16-pd26-v3-db-a-replica-1 Started 
 Container nhom16-pd26-v3-parking-a-1 Started 
 Container nhom16-pd26-v3-parking-c-1 Started 
 Container nhom16-pd26-v3-toxiproxy-1 Started 
 Container nhom16-pd26-v3-region-latency-1 Starting 
 Container nhom16-pd26-v3-region-latency-1 Started 
 Container nhom16-pd26-v3-rabbitmq-1 Error dependency rabbitmq failed to start
dependency failed to start: container nhom16-pd26-v3-rabbitmq-1 is unhealthy

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-24T03:07:22.263Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T03:11:11.721Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- Six-bay topology did not become ready within 120s: fetch failed

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-24T03:13:27.429Z · seed 42 · nemesis partition · 40s — FAIL

- Thời điểm kết thúc: 2026-10-24T03:17:47.800Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- docker compose -f docker-compose.yml -f docker-compose.scale.yml -f docker-compose.jepsen.yml --profile scale --profile coord --profile ha exec -T db-a psql -U postgres -d parking -tAc SELECT count(*) FROM reservations a JOIN reservations b ON a.slot_id=b.slot_id AND a.id<b.id
       AND a.status IN ('ACTIVE','USED') AND b.status IN ('ACTIVE','USED')
       AND tstzrange(a.start_time,a.end_time) && tstzrange(b.start_time,b.end_time) failed: request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.55/containers/json?filters=%7B%22label%22%3A%7B%22com.docker.compose.config-hash%22%3Atrue%2C%22com.docker.compose.project%3Dnhom16-pd26-final%22%3Atrue%2C%22com.docker.compose.service%3Ddb-a%22%3Atrue%7D%7D, check if the server supports the requested API version

| Bất biến | Kết quả | Chi tiết |
|---|---|---|
## 2026-10-28T03:06:41.833Z · seed 42 · nemesis none · 35s — FAIL

- Thời điểm kết thúc: 2026-10-28T03:07:18.796Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- docker compose -f docker-compose.yml -f docker-compose.scale.yml -f docker-compose.jepsen.yml --profile scale --profile coord --profile ha up -d --build failed: Image nhom16/failover-manager Building 
 Image nhom16/aggregator Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-frontend Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-notification Building 
 Image nhom16/parking-node Built 
 Image nhom16/aggregator Built 
 Image nhom16-pd26-frontend Built 
 Image nhom16/failover-manager Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16-pd26-notification Built 
 Image nhom16/parking-node Built 
 Image nhom16/failover-manager Built 
 Image nhom16/parking-node Built 
 Container nhom16-pd26-db-agg-1 Recreate 
 Container nhom16-pd26-db-a-1 Recreate 
 Container nhom16-pd26-db-d-1 Recreate 
 Container nhom16-pd26-db-f-1 Recreate 
 Container nhom16-pd26-rabbitmq-2-1 Recreate 
 Container nhom16-pd26-db-e-1 Recreate 
 Container nhom16-pd26-rabbitmq-1 Recreate 
 Container nhom16-pd26-db-c-1 Recreate 
 Container nhom16-pd26-rabbitmq-3-1 Recreate 
 Container nhom16-pd26-region-latency-1 Recreate 
 Container nhom16-pd26-db-b-1 Recreate 
 Container nhom16-pd26-region-latency-1 Recreated 
 Container nhom16-pd26-db-agg-1 Recreated 
 Container nhom16-pd26-aggregator-2-1 Recreate 
 Container nhom16-pd26-aggregator-1 Recreate 
 Container nhom16-pd26-db-f-1 Recreated 
 Container nhom16-pd26-parking-f-1 Recreate 
 Container nhom16-pd26-db-e-1 Recreated 
 Container nhom16-pd26-parking-e-1 Recreate 
 Container nhom16-pd26-db-c-1 Recreated 
 Container nhom16-pd26-parking-c-1 Recreate 
 Container nhom16-pd26-db-b-1 Recreated 
 Container nhom16-pd26-parking-b-1 Recreate 
 Container nhom16-pd26-db-d-1 Recreated 
 Container nhom16-pd26-parking-d-1 Recreate 
 Container nhom16-pd26-db-a-1 Recreated 
 Container nhom16-pd26-parking-a-1 Recreate 
 Container nhom16-pd26-db-a-replica-1 Recreate 
 Container nhom16-pd26-aggregator-1 Recreated 
 Container nhom16-pd26-rabbitmq-1 Recreated 
 Container nhom16-pd26-aggregator-2-1 Recreated 
 Container nhom16-pd26-db-a-replica-1 Recreated 
 Container nhom16-pd26-parking-f-1 Recreated 
 Container nhom16-pd26-rabbitmq-3-1 Recreated 
 Container nhom16-pd26-rabbitmq-2-1 Recreated 
 Container nhom16-pd26-parking-e-1 Recreated 
 Container nhom16-pd26-parking-b-1 Recreated 
 Container nhom16-pd26-parking-c-1 Recreated 
 Container nhom16-pd26-parking-d-1 Recreated 
 Container nhom16-pd26-parking-a-1 Recreated 
 Container nhom16-pd26-rabbitmq-3-1 Starting 
 Container nhom16-pd26-db-d-1 Starting 
 Container nhom16-pd26-rabbitmq-2-1 Starting 
 Container nhom16-pd26-db-e-1 Starting 
 Container nhom16-pd26-db-f-1 Starting 
 Container nhom16-pd26-etcd-2-1 Starting 
 Container nhom16-pd26-etcd-1-1 Starting 
 Container nhom16-pd26-rabbitmq-1 Starting 
 Container nhom16-pd26-db-b-1 Starting 
 Container nhom16-pd26-db-c-1 Starting 
 Container nhom16-pd26-db-a-1 Starting 
 Container nhom16-pd26-etcd-3-1 Starting 
 Container nhom16-pd26-db-agg-1 Starting 
 Container nhom16-pd26-etcd-2-1 Started 
 Container nhom16-pd26-db-e-1 Started 
 Container nhom16-pd26-rabbitmq-2-1 Started 
 Container nhom16-pd26-db-d-1 Started 
 Container nhom16-pd26-rabbitmq-3-1 Started 
 Container nhom16-pd26-db-a-1 Started 
 Container nhom16-pd26-db-agg-1 Started 
 Container nhom16-pd26-db-c-1 Started 
 Container nhom16-pd26-db-f-1 Started 
 Container nhom16-pd26-db-b-1 Started 
 Container nhom16-pd26-rabbitmq-1 Started 
 Container nhom16-pd26-etcd-3-1 Started 
Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:2379 -> 127.0.0.1:0: listen tcp 0.0.0.0:2379: bind: An attempt was made to access a socket in a way forbidden by its access permissions.

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-28T03:09:04.641Z · seed 42 · nemesis none · 35s — FAIL

- Thời điểm kết thúc: 2026-10-28T03:09:29.523Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- docker compose -f docker-compose.yml -f docker-compose.scale.yml -f docker-compose.jepsen.yml --profile scale --profile coord --profile ha up -d --build failed: Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-frontend Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-notification Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16/failover-manager Building 
 Image nhom16/aggregator Building 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16-pd26-frontend Built 
 Image nhom16/failover-manager Built 
 Image nhom16/failover-manager Built 
 Image nhom16/aggregator Built 
 Image nhom16-pd26-notification Built 
 Network nhom16-pd26_default Creating 
 Network nhom16-pd26_default Creating 
 Network nhom16-pd26_default Created 
 Network nhom16-pd26_default Created 
 Container nhom16-pd26-db-b-1 Creating 
 Container nhom16-pd26-rabbitmq-1 Creating 
 Container nhom16-pd26-db-a-1 Creating 
 Container nhom16-pd26-etcd-2-1 Creating 
 Container nhom16-pd26-db-agg-1 Creating 
 Container nhom16-pd26-etcd-1-1 Creating 
 Container nhom16-pd26-rabbitmq-3-1 Creating 
 Container nhom16-pd26-db-f-1 Creating 
 Container nhom16-pd26-etcd-3-1 Creating 
 Container nhom16-pd26-db-d-1 Creating 
 Container nhom16-pd26-db-c-1 Creating 
 Container nhom16-pd26-rabbitmq-2-1 Creating 
 Container nhom16-pd26-db-e-1 Creating 
 Container nhom16-pd26-etcd-1-1 Created 
 Container nhom16-pd26-failover-manager-1-1 Creating 
 Container nhom16-pd26-failover-manager-2-1 Creating 
 Container nhom16-pd26-etcd-2-1 Created 
 Container nhom16-pd26-rabbitmq-1 Created 
 Container nhom16-pd26-notification-1 Creating 
 Container nhom16-pd26-rabbitmq-3-1 Created 
 Container nhom16-pd26-db-a-1 Created 
 Container nhom16-pd26-db-a-replica-1 Creating 
 Container nhom16-pd26-parking-a-1 Creating 
 Container nhom16-pd26-db-b-1 Created 
 Container nhom16-pd26-parking-b-1 Creating 
 Container nhom16-pd26-rabbitmq-2-1 Created 
 Container nhom16-pd26-etcd-3-1 Created 
 Container nhom16-pd26-db-f-1 Created 
 Container nhom16-pd26-parking-f-1 Creating 
 Container nhom16-pd26-db-d-1 Created 
 Container nhom16-pd26-parking-d-1 Creating 
 Container nhom16-pd26-db-c-1 Created 
 Container nhom16-pd26-parking-c-1 Creating 
 Container nhom16-pd26-db-e-1 Created 
 Container nhom16-pd26-parking-e-1 Creating 
 Container nhom16-pd26-db-agg-1 Created 
 Container nhom16-pd26-aggregator-2-1 Creating 
 Container nhom16-pd26-aggregator-1 Creating 
 Container nhom16-pd26-failover-manager-2-1 Created 
 Container nhom16-pd26-failover-manager-1-1 Created 
 Container nhom16-pd26-notification-1 Created 
 Container nhom16-pd26-db-a-replica-1 Created 
 Container nhom16-pd26-parking-b-1 Created 
 Container nhom16-pd26-parking-a-1 Created 
 Container nhom16-pd26-parking-f-1 Created 
 Container nhom16-pd26-parking-d-1 Created 
 Container nhom16-pd26-parking-c-1 Created 
 Container nhom16-pd26-aggregator-1 Created 
 Container nhom16-pd26-frontend-1 Creating 
 Container nhom16-pd26-frontend-1 Created 
 Container nhom16-pd26-aggregator-2-1 Created 
 Container nhom16-pd26-parking-e-1 Created 
 Container nhom16-pd26-toxiproxy-1 Creating 
 Container nhom16-pd26-toxiproxy-1 Created 
 Container nhom16-pd26-region-latency-1 Creating 
 Container nhom16-pd26-region-latency-1 Created 
 Container nhom16-pd26-rabbitmq-3-1 Starting 
 Container nhom16-pd26-db-a-1 Starting 
 Container nhom16-pd26-db-e-1 Starting 
 Container nhom16-pd26-etcd-1-1 Starting 
 Container nhom16-pd26-etcd-3-1 Starting 
 Container nhom16-pd26-etcd-2-1 Starting 
 Container nhom16-pd26-db-d-1 Starting 
 Container nhom16-pd26-db-f-1 Starting 
 Container nhom16-pd26-rabbitmq-1 Starting 
 Container nhom16-pd26-db-c-1 Starting 
 Container nhom16-pd26-db-agg-1 Starting 
 Container nhom16-pd26-rabbitmq-2-1 Starting 
 Container nhom16-pd26-db-b-1 Starting 
 Container nhom16-pd26-db-f-1 Started 
 Container nhom16-pd26-db-agg-1 Started 
 Container nhom16-pd26-db-d-1 Started 
 Container nhom16-pd26-db-e-1 Started 
 Container nhom16-pd26-db-b-1 Started 
 Container nhom16-pd26-etcd-3-1 Started 
 Container nhom16-pd26-db-c-1 Started 
 Container nhom16-pd26-etcd-2-1 Started 
 Container nhom16-pd26-rabbitmq-1 Started 
 Container nhom16-pd26-rabbitmq-2-1 Started 
 Container nhom16-pd26-db-a-1 Started 
 Container nhom16-pd26-rabbitmq-3-1 Started 
Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:2379 -> 127.0.0.1:0: listen tcp 0.0.0.0:2379: bind: An attempt was made to access a socket in a way forbidden by its access permissions.

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-28T03:10:24.499Z · seed 42 · nemesis none · 35s — FAIL

- Thời điểm kết thúc: 2026-10-28T03:10:59.065Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- docker compose -f docker-compose.yml -f docker-compose.scale.yml -f docker-compose.jepsen.yml --profile scale --profile coord --profile ha up -d --build failed: Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-frontend Building 
 Image nhom16/aggregator Building 
 Image nhom16-pd26-notification Building 
 Image nhom16/failover-manager Building 
 Image nhom16/parking-node Building 
 Image nhom16/parking-node Building 
 Image nhom16-pd26-notification Built 
 Image nhom16/parking-node Built 
 Image nhom16/failover-manager Built 
 Image nhom16/aggregator Built 
 Image nhom16-pd26-frontend Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/parking-node Built 
 Image nhom16/failover-manager Built 
 Network nhom16-pd26_default Creating 
 Network nhom16-pd26_default Creating 
 Network nhom16-pd26_default Created 
 Network nhom16-pd26_default Created 
 Container nhom16-pd26-db-agg-1 Creating 
 Container nhom16-pd26-db-a-1 Creating 
 Container nhom16-pd26-rabbitmq-3-1 Creating 
 Container nhom16-pd26-rabbitmq-2-1 Creating 
 Container nhom16-pd26-etcd-1-1 Creating 
 Container nhom16-pd26-etcd-3-1 Creating 
 Container nhom16-pd26-db-d-1 Creating 
 Container nhom16-pd26-rabbitmq-1 Creating 
 Container nhom16-pd26-db-b-1 Creating 
 Container nhom16-pd26-db-c-1 Creating 
 Container nhom16-pd26-etcd-2-1 Creating 
 Container nhom16-pd26-db-f-1 Creating 
 Container nhom16-pd26-db-e-1 Creating 
 Container nhom16-pd26-etcd-3-1 Created 
 Container nhom16-pd26-db-agg-1 Created 
 Container nhom16-pd26-aggregator-1 Creating 
 Container nhom16-pd26-aggregator-2-1 Creating 
 Container nhom16-pd26-db-c-1 Created 
 Container nhom16-pd26-parking-c-1 Creating 
 Container nhom16-pd26-etcd-1-1 Created 
 Container nhom16-pd26-failover-manager-1-1 Creating 
 Container nhom16-pd26-failover-manager-2-1 Creating 
 Container nhom16-pd26-rabbitmq-3-1 Created 
 Container nhom16-pd26-db-d-1 Created 
 Container nhom16-pd26-parking-d-1 Creating 
 Container nhom16-pd26-db-b-1 Created 
 Container nhom16-pd26-parking-b-1 Creating 
 Container nhom16-pd26-etcd-2-1 Created 
 Container nhom16-pd26-db-e-1 Created 
 Container nhom16-pd26-parking-e-1 Creating 
 Container nhom16-pd26-rabbitmq-2-1 Created 
 Container nhom16-pd26-rabbitmq-1 Created 
 Container nhom16-pd26-notification-1 Creating 
 Container nhom16-pd26-db-f-1 Created 
 Container nhom16-pd26-parking-f-1 Creating 
 Container nhom16-pd26-db-a-1 Created 
 Container nhom16-pd26-parking-a-1 Creating 
 Container nhom16-pd26-db-a-replica-1 Creating 
 Container nhom16-pd26-parking-c-1 Created 
 Container nhom16-pd26-aggregator-1 Created 
 Container nhom16-pd26-frontend-1 Creating 
 Container nhom16-pd26-aggregator-2-1 Created 
 Container nhom16-pd26-failover-manager-1-1 Created 
 Container nhom16-pd26-failover-manager-2-1 Created 
 Container nhom16-pd26-parking-d-1 Created 
 Container nhom16-pd26-notification-1 Created 
 Container nhom16-pd26-parking-b-1 Created 
 Container nhom16-pd26-parking-e-1 Created 
 Container nhom16-pd26-parking-a-1 Created 
 Container nhom16-pd26-parking-f-1 Created 
 Container nhom16-pd26-toxiproxy-1 Creating 
 Container nhom16-pd26-db-a-replica-1 Created 
 Container nhom16-pd26-frontend-1 Created 
 Container nhom16-pd26-toxiproxy-1 Created 
 Container nhom16-pd26-region-latency-1 Creating 
 Container nhom16-pd26-region-latency-1 Created 
 Container nhom16-pd26-db-b-1 Starting 
 Container nhom16-pd26-db-agg-1 Starting 
 Container nhom16-pd26-rabbitmq-3-1 Starting 
 Container nhom16-pd26-rabbitmq-1 Starting 
 Container nhom16-pd26-rabbitmq-2-1 Starting 
 Container nhom16-pd26-db-a-1 Starting 
 Container nhom16-pd26-etcd-1-1 Starting 
 Container nhom16-pd26-db-e-1 Starting 
 Container nhom16-pd26-db-d-1 Starting 
 Container nhom16-pd26-db-c-1 Starting 
 Container nhom16-pd26-etcd-3-1 Starting 
 Container nhom16-pd26-db-f-1 Starting 
 Container nhom16-pd26-etcd-2-1 Starting 
 Container nhom16-pd26-db-b-1 Started 
 Container nhom16-pd26-db-b-1 Waiting 
 Container nhom16-pd26-db-c-1 Started 
 Container nhom16-pd26-db-c-1 Waiting 
 Container nhom16-pd26-db-a-1 Started 
 Container nhom16-pd26-db-a-1 Waiting 
 Container nhom16-pd26-db-a-1 Waiting 
 Container nhom16-pd26-etcd-2-1 Started 
 Container nhom16-pd26-etcd-3-1 Started 
 Container nhom16-pd26-db-agg-1 Started 
 Container nhom16-pd26-db-agg-1 Waiting 
 Container nhom16-pd26-db-agg-1 Waiting 
 Container nhom16-pd26-db-e-1 Started 
 Container nhom16-pd26-db-e-1 Waiting 
 Container nhom16-pd26-etcd-1-1 Started 
 Container nhom16-pd26-failover-manager-1-1 Starting 
 Container nhom16-pd26-failover-manager-2-1 Starting 
 Container nhom16-pd26-db-d-1 Started 
 Container nhom16-pd26-db-d-1 Waiting 
 Container nhom16-pd26-rabbitmq-2-1 Started 
 Container nhom16-pd26-rabbitmq-1 Started 
 Container nhom16-pd26-rabbitmq-1 Waiting 
 Container nhom16-pd26-db-f-1 Started 
 Container nhom16-pd26-db-f-1 Waiting 
 Container nhom16-pd26-rabbitmq-3-1 Started 
 Container nhom16-pd26-failover-manager-2-1 Started 
 Container nhom16-pd26-failover-manager-1-1 Started 
 Container nhom16-pd26-db-b-1 Healthy 
 Container nhom16-pd26-parking-b-1 Starting 
 Container nhom16-pd26-db-c-1 Healthy 
 Container nhom16-pd26-parking-c-1 Starting 
 Container nhom16-pd26-db-a-1 Healthy 
 Container nhom16-pd26-parking-a-1 Starting 
 Container nhom16-pd26-db-a-1 Healthy 
 Container nhom16-pd26-db-a-replica-1 Starting 
 Container nhom16-pd26-db-agg-1 Healthy 
 Container nhom16-pd26-aggregator-1 Starting 
 Container nhom16-pd26-db-agg-1 Healthy 
 Container nhom16-pd26-aggregator-2-1 Starting 
 Container nhom16-pd26-db-e-1 Healthy 
 Container nhom16-pd26-parking-e-1 Starting 
 Container nhom16-pd26-db-d-1 Healthy 
 Container nhom16-pd26-parking-d-1 Starting 
 Container nhom16-pd26-db-f-1 Healthy 
 Container nhom16-pd26-parking-f-1 Starting 
 Container nhom16-pd26-parking-b-1 Started 
 Container nhom16-pd26-parking-c-1 Started 
 Container nhom16-pd26-parking-a-1 Started 
 Container nhom16-pd26-db-a-replica-1 Started 
 Container nhom16-pd26-aggregator-2-1 Started 
 Container nhom16-pd26-aggregator-1 Started 
 Container nhom16-pd26-frontend-1 Starting 
 Container nhom16-pd26-parking-e-1 Started 
 Container nhom16-pd26-parking-d-1 Started 
 Container nhom16-pd26-parking-f-1 Started 
 Container nhom16-pd26-toxiproxy-1 Starting 
 Container nhom16-pd26-frontend-1 Started 
 Container nhom16-pd26-toxiproxy-1 Started 
 Container nhom16-pd26-region-latency-1 Starting 
 Container nhom16-pd26-region-latency-1 Started 
 Container nhom16-pd26-rabbitmq-1 Error dependency rabbitmq failed to start
dependency failed to start: container nhom16-pd26-rabbitmq-1 exited (1)

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-28T03:11:59.701Z · seed 42 · nemesis none · 35s — FAIL

- Thời điểm kết thúc: 2026-10-28T03:15:20.689Z
- Lịch sử: `tests/jepsen/history.jsonl`

Lỗi chạy:
- Six-bay topology did not become ready within 120s: fetch failed

| Bất biến | Kết quả | Chi tiết |
|---|---|---|

## 2026-10-28T03:31:10.301Z · seed 42 · nemesis none · 35s — PASS

- Thời điểm kết thúc: 2026-10-28T03:33:09.622Z
- Lịch sử: `tests/jepsen/history.jsonl`

| Bất biến | Kết quả | Chi tiết |
|---|---|---|
| 1. No overlapping ACTIVE reservations | ĐẠT | no overlapping ACTIVE/USED reservations |
| 2. Successful command has exactly one effect | ĐẠT | 139 successful commands; each has one inbox/effect record |
| 3. Every accepted command is terminal | ĐẠT | 145 accepted commands ended in a terminal state |
| 4. Outbox empty and cache converged within 30s | ĐẠT | all six outboxes are empty and caches match database snapshots |
| 5. Slot versions are contiguous and monotonic | ĐẠT | all recorded slot versions are contiguous |
| 6. Exactly one writable DB primary by epoch | ĐẠT | db-a epoch=1 primary=true; db-a-replica epoch=1 primary=false; active primaries=1 |

## 2026-10-28T03:33:21.717Z · seed 42 · nemesis partition · 40s — PASS

- Thời điểm kết thúc: 2026-10-28T03:35:19.538Z
- Lịch sử: `tests/jepsen/history.jsonl`

| Bất biến | Kết quả | Chi tiết |
|---|---|---|
| 1. No overlapping ACTIVE reservations | ĐẠT | no overlapping ACTIVE/USED reservations |
| 2. Successful command has exactly one effect | ĐẠT | 193 successful commands; each has one inbox/effect record |
| 3. Every accepted command is terminal | ĐẠT | 197 accepted commands ended in a terminal state |
| 4. Outbox empty and cache converged within 30s | ĐẠT | all six outboxes are empty and caches match database snapshots |
| 5. Slot versions are contiguous and monotonic | ĐẠT | all recorded slot versions are contiguous |
| 6. Exactly one writable DB primary by epoch | ĐẠT | db-a epoch=1 primary=true; db-a-replica epoch=1 primary=false; active primaries=1 |

## 2026-10-28T03:35:38.558Z · seed 42 · nemesis rabbitmq · 35s — PASS

- Thời điểm kết thúc: 2026-10-28T03:37:28.497Z
- Lịch sử: `tests/jepsen/history.jsonl`

| Bất biến | Kết quả | Chi tiết |
|---|---|---|
| 1. No overlapping ACTIVE reservations | ĐẠT | no overlapping ACTIVE/USED reservations |
| 2. Successful command has exactly one effect | ĐẠT | 134 successful commands; each has one inbox/effect record |
| 3. Every accepted command is terminal | ĐẠT | 135 accepted commands ended in a terminal state |
| 4. Outbox empty and cache converged within 30s | ĐẠT | all six outboxes are empty and caches match database snapshots |
| 5. Slot versions are contiguous and monotonic | ĐẠT | all recorded slot versions are contiguous |
| 6. Exactly one writable DB primary by epoch | ĐẠT | db-a epoch=1 primary=true; db-a-replica epoch=1 primary=false; active primaries=1 |

