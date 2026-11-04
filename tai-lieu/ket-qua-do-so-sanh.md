# PD-27 – Khung đo trước/sau

**Chưa chạy đo.** Ô trống là chưa có dữ liệu, không phải 0. Không suy ra kết quả TC80 từ việc nhận 202.

Độ trễ ghi theo ms; thông lượng là HTTP request/s; tỉ lệ 503/504 ghi theo %. Ghi riêng tra cứu và đặt chỗ để poll/huỷ không che độ trễ nghiệp vụ. Đặt chỗ đo từ POST đến kết quả cuối (cả thời gian chờ/poll khi nhận 202); 409 là tranh chấp hợp lệ, không phải một lần đặt thành công.

| Cặp | Cấu hình | Đọc p50/p95/p99 | Đặt p50/p95/p99 | HTTP req/s | 503 (%) | 504 (%) | JSON/log, ảnh Grafana |
|---|---|---|---|---|---|---|---|
| Kênh lệnh | http | | | | | | |
| | broker | | | | | | |
| Số bãi | 3 (A–C) | | | | | | |
| | 6 (A–F) | | | | | | |
| Aggregator | 2 | | | | | | |
| | 4 | | | | | | |
| Sao chép A | đồng bộ | | | | | | |
| | bất đồng bộ | | | | | | |

| TC80 – 300 VU, B chậm 1500 ms | Đọc p95 (ms) | Đặt p95 (ms) | 504 (%) | Ngưỡng p95 đã dùng | Đạt/chưa đạt | JSON/log, ảnh |
|---|---|---|---|---|---|---|
| Trước | | | | | | |
| Sau | | | | | | |

## Cách chạy lại

Chạy trên stack thử, không chạy cùng e2e/chaos khác. Script **không** đổi cấu hình theo tên; người chạy dựng đúng stack trước và ghi Compose/env, revision, thời lượng, số bãi/Aggregator, chế độ lệnh và trạng thái replica cùng ảnh Grafana. Hai vế chỉ đổi một biến; giữ 300 VU (240 đọc + 60 đặt), thời lượng, dữ liệu seed và ngưỡng giống nhau. Đồng bộ đồng hồ Windows/WSL/Docker trước khi đo (xem `ket-qua-test-tai.md`).

Chạy bằng Bash/Git Bash ở gốc repo, cần Docker Desktop và stack đang UP; không cần cài k6:

```bash
# Mặc định network nhom16-parking_default, BASE=http://frontend (Nginx chia tải).
# Stack đã dựng COMMAND_MODE=http:
BASE=http://frontend PARKING_IDS=A,B,C DURATION=2m bash scripts/do-so-sanh.sh http-r1
# Dựng lại stack với COMMAND_MODE=broker, giữ các biến khác, rồi:
BASE=http://frontend PARKING_IDS=A,B,C DURATION=2m bash scripts/do-so-sanh.sh broker-r1
# Sau khi dựng stack 6 bãi: PARKING_IDS=A,B,C,D,E,F, tên ví dụ 6-bai-r1.
# Đo 2/4 Aggregator vẫn qua frontend; không BASE tới một bản Aggregator riêng.
```

`bash scripts/do-so-sanh.sh <tên>` chạy image `grafana/k6`, lưu `tai-lieu/ket-qua-do/<tên>.json` và `.log`; không ghi đè lượt cũ. Project/network khác thì đặt `K6_NETWORK`. Tên cấu hình chỉ gồm chữ, số, `_`, `-`. JSON có p50/p95/p99, HTTP req/s, iteration/s, tỉ lệ 503/504 (0..1, nhân 100 khi điền bảng), raw metrics và thresholds. Tỉ lệ 503/504 tính trên toàn HTTP workload gồm đọc/đặt/poll/huỷ, không gồm setup; HTTP req/s của k6 có cả setup. Giữ cùng cách đếm giữa các lượt. Poll quá hạn là check lỗi, không giả thành thành công; chỗ chưa rõ kết quả cần đối soát trước lượt sau (`node tests/load/check-invariants.mjs`).

Các biến k6 được script chuyển vào container: `BASE`, `PARKING_IDS`, `DURATION`, `DEMO_USERNAME`, `DEMO_PASSWORD`, `LOOKUP_VUS`, `RESERVE_VUS`, `LOOKUP_P95_MS`, `RESERVE_P95_MS`, `MAX_ERROR_RATE`, `MIN_CHECK_RATE`, `MAX_503_RATE`, `MAX_504_RATE`, `POLL_TIMEOUT_MS`, `POLL_INTERVAL_MS`, `DEBUG_SLOW_MS`. Mặc định p95 đọc < 500 ms, đặt < 3000 ms; lỗi HTTP < 1%, check > 99%, 503/504 ≤ 0; đây là **ngưỡng chạy**, không phải số đo. Khi đối chiếu SLO mục 3.3, đặt ngưỡng đúng bản đặc tả và giữ nguyên ở hai vế. k6 trả mã khác 0 khi vượt ngưỡng; vẫn giữ JSON/log, không sửa ngưỡng sau chạy để biến kết quả thành đạt.

TC80 cần stack có `docker-compose.chaos.yml --profile chaos`, Aggregator gọi B qua toxiproxy; giữ cấu hình đó cho cả hai vế:

```bash
node scripts/net.mjs B latency 1500
# Sau khi đã dựng cấu hình cần đo; luôn gỡ độ trễ dù k6 thất bại.
trap 'node scripts/net.mjs B reset' EXIT
BASE=http://frontend PARKING_IDS=A,B,C DURATION=2m \
  MAX_504_RATE=0 bash scripts/do-so-sanh.sh tc80-truoc-r1
```

Lặp lại với cấu hình sau, tên `tc80-sau-r1`, cùng ngưỡng và độ trễ. `net.mjs` đặt latency downstream và jitter 100 ms. 504 bằng 0 chỉ đạt khi rate có mẫu thật và bằng 0, đồng thời p95/check/HTTP-error đạt; không điền kết luận từ ô thiếu dữ liệu. Với cặp sao chép A, giữ replica sống ở cả hai vế, đổi `synchronous_standby_names` theo cấu hình HA và kiểm bằng `SHOW synchronous_standby_names`, `pg_stat_replication`; không dừng replica để giả lập async. Sau mỗi lượt chụp dashboard “Kênh lệnh”, “Điều phối”, gắn đường dẫn ảnh vào hàng tương ứng. Chưa có ảnh/số đo thì để trống.
