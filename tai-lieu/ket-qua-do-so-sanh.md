# PD-27 – Khung đo trước/sau

Đo ngày 05/11/2026, mỗi cấu hình **một lượt** 2 phút, 300 người dùng ảo (240 đọc, 60 đặt), `grafana/k6` chạy cùng máy với toàn bộ stack (12 nhân, Docker được cấp 8,1 GB). Vì vậy số dưới đây phản ánh giới hạn của một máy, không phải năng lực khi mỗi dịch vụ chạy trên máy riêng. Chưa chụp ảnh Grafana.

**Kết quả chính**
- Không cấu hình nào đạt ngưỡng k6 mặc định (đọc p95 < 500 ms, đặt p95 < 3000 ms). Đọc p95 thấp nhất là 3175 ms.
- Broker làm đặt chỗ chậm hơn HTTP: p95 11588 ms so với 3983 ms. Thông lượng gần như bằng nhau, 109,1 so với 106,9 req/s.
- 6 bãi và 4 Aggregator đều chậm hơn và thông lượng thấp hơn bản nhỏ, do thêm container trên cùng một máy. Số này không cho kết luận về khả năng mở rộng.
- Đồng bộ và bất đồng bộ gần như bằng nhau ở p95 (đặt 4517 so với 4166 ms); riêng lượt đồng bộ có 1,56% trả 503, lượt bất đồng bộ 0%. Một lượt chưa đủ để kết luận nguyên nhân.
- **TC80 chưa chứng minh được:** bản "trước" (`COMMAND_MODE=http`, B chậm 1500 ms) đã có 504 = 0%, nên không có mức giảm 504 để so sánh. Bản "sau" (`broker`) có đặt p95 8454 ms, vượt ngưỡng 3000 ms.

Chưa đối chiếu được "SLO mục 3.3" của PLAN B15: trong repo không có tài liệu nào nêu mục này, nên chỉ so với ngưỡng mặc định của `tests/load/k6.js`.

**Cấu hình thật của từng dòng**
- `http`, `broker`: `docker-compose.yml`, 3 bãi, 1 Aggregator. Dòng "3 (A–C)" dùng lại số của `http`.
- `6bai`: thêm `docker-compose.scale.yml`, profile `scale,coord`.
- `2agg`: thêm `docker-compose.ha.yml`, profile `ha`, nên có cả cụm RabbitMQ 3 nút. Vì vậy `2agg` không chỉ khác `http` ở số Aggregator.
- `4agg`: stack `scale` (2 bản vùng Bắc, 2 bản vùng Nam, 6 bãi), tải chỉ gửi vào A, B, C qua `frontend`. Vì vậy `4agg` không chỉ khác `2agg` ở số Aggregator.
- `sync`, `async`: stack `ha`, tải chỉ vào bãi A. `async` đặt `synchronous_standby_names=''` trước khi đo; `sync` giữ `ANY 1 ("db-a-replica")`.
- TC80: `docker-compose.chaos.yml`, `node scripts/net.mjs B latency 1500`.

Độ trễ ghi theo ms; thông lượng là HTTP request/s; tỉ lệ 503/504 ghi theo %. Ghi riêng tra cứu và đặt chỗ để poll/huỷ không che độ trễ nghiệp vụ. Đặt chỗ đo từ POST đến kết quả cuối (cả thời gian chờ/poll khi nhận 202); 409 là tranh chấp hợp lệ, không phải một lần đặt thành công.

| Cặp | Cấu hình | Đọc p50/p95/p99 | Đặt p50/p95/p99 | HTTP req/s | 503 (%) | 504 (%) | JSON/log, ảnh Grafana |
|---|---|---|---|---|---|---|---|
| Kênh lệnh | http | 2272/3672/4994 | 2287/3983/4978 | 106.9 | 0.00 | 0.00 | `http.json`, `http.log` |
| | broker | 1894/3175/14851 | 6261/11588/17161 | 109.1 | 0.00 | 0.00 | `broker.json`, `broker.log` |
| Số bãi | 3 (A–C) | 2272/3672/4994 | 2287/3983/4978 | 106.9 | 0.00 | 0.00 | `http.json`, `http.log` |
| | 6 (A–F) | 3195/10224/15988 | 2660/9692/11712 | 69.0 | 0.17 | 0.00 | `6bai.json`, `6bai.log` |
| Aggregator | 2 | 2583/5426/13451 | 2664/5814/7627 | 94.2 | 0.00 | 0.01 | `2agg.json`, `2agg.log` |
| | 4 | 2717/7519/14544 | 2251/6922/8766 | 82.7 | 0.31 | 0.01 | `4agg.json`, `4agg.log` |
| Sao chép A | đồng bộ | 1442/4205/13514 | 1655/4517/13867 | 136.8 | 1.56 | 0.12 | `sync.json`, `sync.log` |
| | bất đồng bộ | 1548/3771/4942 | 1678/4166/5490 | 135.9 | 0.00 | 0.01 | `async.json`, `async.log` |

| TC80 – 300 VU, B chậm 1500 ms | Đọc p95 (ms) | Đặt p95 (ms) | 504 (%) | Ngưỡng p95 đã dùng | Đạt/chưa đạt | JSON/log, ảnh |
|---|---|---|---|---|---|---|
| Trước | 3933 | 3092 | 0.00 | đọc 500, đặt 3000 | Chưa đạt | `tc80-truoc.json`, `tc80-truoc.log` |
| Sau | 3187 | 8454 | 0.00 | đọc 500, đặt 3000 | Chưa đạt | `tc80-sau.json`, `tc80-sau.log` |

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
