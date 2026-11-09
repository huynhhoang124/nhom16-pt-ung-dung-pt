# PD-27 – Khung đo trước/sau

Đo ngày 05/11/2026, mỗi cấu hình **một lượt** 2 phút, 300 người dùng ảo (240 đọc, 60 đặt), `grafana/k6` chạy cùng máy với toàn bộ stack (12 nhân, Docker được cấp 8,1 GB). Vì vậy số dưới đây phản ánh giới hạn của một máy, không phải năng lực khi mỗi dịch vụ chạy trên máy riêng. Chưa chụp ảnh Grafana.

**Kết quả chính**
- Không cấu hình nào đạt ngưỡng k6 mặc định (đọc p95 < 500 ms, đặt p95 < 3000 ms). Đọc p95 thấp nhất là 3175 ms.
- Broker làm đặt chỗ chậm hơn HTTP: p95 11588 ms so với 3983 ms. Thông lượng gần như bằng nhau, 109,1 so với 106,9 req/s.
- 6 bãi và 4 Aggregator đều chậm hơn và thông lượng thấp hơn bản nhỏ, do thêm container trên cùng một máy. Số này không cho kết luận về khả năng mở rộng.
- Đồng bộ và bất đồng bộ gần như bằng nhau ở p95 (đặt 4517 so với 4166 ms); riêng lượt đồng bộ có 1,56% trả 503, lượt bất đồng bộ 0%. Một lượt chưa đủ để kết luận nguyên nhân.
- **TC80 chưa chứng minh được:** bản "trước" (`COMMAND_MODE=http`, B chậm 1500 ms) đã có 504 = 0%, nên không có mức giảm 504 để so sánh. Bản "sau" (`broker`) có đặt p95 8454 ms, vượt ngưỡng 3000 ms.

Đối chiếu mục 3.3 của kế hoạch mở rộng GĐ2 v1.4, p95 đặt chỗ qua broker phải ≤ 300 ms trong vùng và ≤ 450 ms liên vùng. p95 tra cứu tổng hợp sáu bãi phải ≤ 250 ms. Các lượt đo dưới đây vượt cả ngưỡng chạy k6 và SLO của kế hoạch.

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

## Đo lại trên GitHub Actions ngày 08/11

Hai job dùng cùng loại runner Ubuntu và mỗi job dựng một stack riêng. Mỗi cấu hình chạy 2 phút, 300 VU, Toxiproxy làm chậm chiều phản hồi của bãi B 1,5 giây. Ngưỡng k6 lấy theo SLO, p95 đọc < 250 ms và đặt chỗ < 300 ms trong vùng.

| Commit | Chế độ | Đọc p95 (ms) | Đặt p95 (ms) | 504 |
|---|---|---:|---:|---:|
| `7f58824` | HTTP | 1.603 | 1.596 | 0% |
| `7f58824` | Broker | 1.609 | 1.706 | 0% |
| `1180d79` | HTTP | 160 | 1.610 | 0% |
| `1180d79` | Broker | 355 | 1.046 | 0% |
| `c87eba8` | HTTP | 143 | 1.595 | 0% |
| `c87eba8` | Broker | 355 | 870 | 0% |

Bản `1180d79` dùng chung lượt làm mới thông tin chỗ trống giữa các yêu cầu và kích hoạt gửi phản hồi ngay sau khi node commit lệnh. p95 đặt qua broker giảm 38,7% so với lượt broker trước. TC80 vẫn chưa đạt. p95 của lượt broker mới vượt ngưỡng và tỷ lệ lỗi HTTP là 4,48%. Hai lượt HTTP đều đã có 0% lỗi 504. Bản `c87eba8` gộp thao tác nhận lệnh vào một truy vấn nguyên tử. p95 đặt qua broker giảm tiếp xuống 870 ms, vẫn vượt ngưỡng. [Log và JSON của lượt c87eba8](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42471813096). Chỉ tiêu tra cứu 250 ms trong kế hoạch áp dụng cho sáu bãi. Lượt TC80 trên đây chạy ba bãi. Log và JSON ở mục Artifacts của [lượt 7f58824](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42470803318) và [lượt 1180d79](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42471407708).

## Nghiệm thu tối ưu ngày 08/11/2026

Giữ nguyên workload TC80: 240 VU đọc + 60 VU đặt trong 2 phút, ba bãi A/B/C, broker, B chậm downstream 1500 ms bằng Toxiproxy. Mỗi lượt dùng một runner GitHub Actions Ubuntu riêng với Docker Compose; không quy đổi sang hiệu năng máy Windows hay triển khai liên vùng. Độ trễ đặt tính tới kết quả cuối, gồm polling nếu trả 202; 409 vẫn là tranh chấp hợp lệ. Không thay ngưỡng đọc <250 ms, đặt <300 ms, lỗi HTTP <1%, checks >99%, 503/504 bằng 0.

Các sửa đổi: gửi lệnh theo lô có pipeline publisher confirm; ghi phản hồi bằng UPDATE nguyên tử và xử lý song song có giới hạn; thông báo kết quả ngay cho HTTP waiter; kích hoạt lại relay khi có commit mới; tái sử dụng kết nối Nginx và khóa ký đã phân tích. Thứ tự lệnh giữ bằng thời gian PostgreSQL với độ chính xác microsecond. Kết nối AMQP đặt TCP_NODELAY để các frame nhỏ không chờ gom gói và delayed ACK. Giao dịch node bớt lượt truy vấn kiểm tra, lấy giờ và ghi sự kiện; giờ nghiệp vụ vẫn lấy từ PostgreSQL. Xác nhận publisher được ghi bền một lần cho mỗi lô thay vì từng lệnh. RabbitMQ dùng hai scheduler và tắt busy waiting trên máy demo chạy chung; không tắt fsync hoặc publisher confirm.

| Revision/lượt | Đọc p95 (ms) | Đặt p95 (ms) | Đặt p99 (ms) | Kết luận |
|---|---:|---:|---:|---|
| 5548730 / 42485402779 | 14,70 | 168 | 248 | Qua ngưỡng một lượt |
| 5548730 / 42485729282 | 24,07 | 574 | 953 | Không đạt khi lặp lại; chưa dùng để nghiệm thu |
| 87a9e9c / 42486133387 | 59,15 | 538 | 689,73 | TCP_NODELAY chưa đủ |
| 87a9e9c / 42486162895 | 15,31 | 185 | 256 | Một lượt đạt, còn biến động |
| 7e59039 / 42486490118 | 21,71 | 219 | 289 | Qua ngưỡng và bất biến |
| 7e59039 / 42486516688 | 23,03 | 514 | 793,61 | Pipeline relay chưa đủ ổn định |
| 383e53a / 42487186982 | 48,84 | 420,60 | 561,84 | Chưa đạt |
| c13173a / 42487626315 | 43,46 | 401 | 534 | Giảm truy vấn node, chưa đạt |
| c13173a / 42487674442 | 46,06 | 405,90 | 603,54 | Chưa đạt khi lặp |
| d366438 / 42488122775 | 25,56 | 547,50 | 859,40 | Gộp xác nhận broker, chưa đạt |
| 013a577 / 42488184397 | 54,17 | 396 | 528 | Chưa đạt |
| 7b2e818 / 42490077058 | 45,56 | 371 | 496,86 | Cùng runtime 4bf3378, lượt bổ sung vẫn biến động |

Lượt 5548730 đầu có 673,75 HTTP req/s, 82.292 HTTP workload, không có 503/504 hoặc trạng thái ngoài dự kiến. [Log/JSON lưu trong repo](ket-qua-do/tc80-5548730/tc80-acceptance.json). Hai lượt khác runner cho kết quả biến động, nên không chọn riêng lượt tốt để kết luận ổn định.

### TC80 sau tối ưu giao dịch

Runtime `4bf3378`; `7b2e818` chỉ tách test kết nối để mỗi image chạy độc lập. Hai runner riêng chạy đủ 300 VU trong 2 phút, cùng seed và cùng cấu hình broker/B chậm 1500 ms:

| Lượt | Đọc p95 (ms) | Đặt p95/p99 (ms) | HTTP req/s | Lỗi HTTP | Checks | 503/504 |
|---|---:|---:|---:|---:|---:|---:|
| [42489837577](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42489837577) | 22,68 | 209 / 281 | 654,17 | 0% | 100% | 0% / 0% |
| [42489834410](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42489834410) | 21,38 | 174 / 252 | 662,03 | 0% | 100% | 0% / 0% |

Hai lượt này **đạt p95 đặt <300 ms** và toàn bộ ngưỡng k6. Lượt CI bổ sung 7b2e818 còn 371 ms (bảng trên), nên vẫn tiếp tục giảm tải kiểm tra sức khỏe RabbitMQ trước khi tích hợp. 12 kiểm tra bất biến trên ba DB đều đạt sau tải: không đặt chồng, không trùng request_id, không có hai phiên mở trên một slot, outbox sự kiện gửi hết. Lượt 1 có 103.919 checks và 79.953 HTTP; lượt 2 có 105.666 checks và 80.861 HTTP; không có check lỗi. HTTP count có setup theo quy ước k6, còn kiểm 503/504 chỉ tính workload.

Bằng chứng đầy đủ: [lượt 1](ket-qua-do/tc80-4bf3378-r1/), [lượt 2](ket-qua-do/tc80-4bf3378-r2/), gồm JSON, log k6, log bất biến, thời gian các giai đoạn và Docker CPU. Khác biệt quyết định ở bản cuối: gộp inbox/result/reply outbox trong một câu SQL, dùng snapshot từ dòng slot đang khóa để ký phản hồi và tạo reservation trực tiếp từ CTE giữ slot. Vẫn giữ commit bền, outbox, xác thực chữ ký, idempotency, SAVEPOINT và thứ tự xử lý consumer.

Đây là hai phép đo trên runner Ubuntu với stack cùng máy. Kết quả cũ biến động được giữ ở bảng trên; không dùng số này để cam kết mọi phần cứng hoặc đường truyền liên vùng. 504 đã bằng 0 trong cả một số lượt trước, nên không khẳng định có mức giảm 504 từ số 0.

### PD-20: p99 trên hai replica thật

Dựng bằng `tests/pd20.compose.yml`: hai node B cùng dữ liệu PostgreSQL, đăng ký qua etcd; node primary qua proxy chậm 1500 ms, secondary đi trực tiếp. Chạy 100 VU đọc đầy đủ `/api/parkings/B` trong 2 phút mỗi vế, lần lượt `HEDGE_ENABLED=false/true`; mỗi yêu cầu kiểm HTTP 200, snapshot đủ slot và không stale. Luồng đọc học replica phản hồi nhanh sau lần hedge thắng và tiếp tục dùng replica đó khi đang cooldown; không tăng thêm request trong cooldown.

| Revision/lượt | p99 tắt hedge (ms) | p99 bật hedge (ms) | Mức giảm |
|---|---:|---:|---:|
| a1051aa / 42485002101 | 1.602,67 | 107,36 | 93,30% |
| 5548730 / 42485402779 | 1.602,21 | 58,82 | 96,33% |
| 4bf3378 / 42489837577 | 1.601,84 | 35,19 | 97,80% |
| 4bf3378 / 42489834410 | 1.641,52 | 103,08 | 93,72% |

Mọi vế đều qua kiểm tra HTTP/checks. Hai lượt runtime cuối đều vượt mục tiêu giảm p99 30%. Lượt 42489837577 có 7.524 checks baseline và 114.084 checks khi bật hedge; checks 100%, HTTP error 0%. [JSON runtime cuối lượt 1](ket-qua-do/pd20-4bf3378-r1/), [lượt 2](ket-qua-do/pd20-4bf3378-r2/). JSON gốc: [tắt hedge](ket-qua-do/pd20-5548730/hedge-false.json), [bật hedge](ket-qua-do/pd20-5548730/hedge-true.json). Đây là kết quả của cấu hình hai replica có một replica chậm; chưa chứng minh mọi phân bố độ trễ hoặc tải liên vùng.

Workflow `Performance acceptance` buộc k6 thất bại khi vượt ngưỡng, kiểm tra bất biến sau tải và lưu artifacts. Các job TC80 cũ trong GĐ2 integration có chế độ cảnh báo nên không thay thế gate này. Chưa chụp thêm ảnh Grafana.

## Kết quả trên bản tối ưu cuối

Commit ứng dụng `faf490c` chạy trên hai runner GitHub Ubuntu độc lập. TC80 giữ 300 VU trong hai phút, lệnh qua broker và bãi B trễ phản hồi 1.500 ms. p95 đặt chỗ tính đến kết quả cuối, kể cả lần phải poll sau HTTP 202.

| Lượt | Đọc p95 | Đặt p95 / p99 | Lỗi HTTP / 503 / 504 | Bất biến sau tải |
|---|---:|---:|---:|---|
| [42496634085](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42496634085) | 14,23 ms | 139 / 212 ms | 0% / 0% / 0% | 12/12 |
| [42496629219](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42496629219) | 23,86 ms | 254 / 400,77 ms | 0% / 0% / 0% | 12/12 |

Hai lượt đều dưới ngưỡng p95 300 ms và checks đạt 100%. Trên bản trước khi gom các commit đồng thời, một lượt còn 323 ms. [Kết quả bản trước](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42494036003).

PD-20 đo với 100 VU, mỗi vế hai phút, hai replica B và một replica trễ 1.500 ms. Lượt 1 giảm p99 từ 1.600,68 xuống 27,03 ms (98,31%). Lượt 2 giảm từ 1.604,78 xuống 90,45 ms (94,36%). JSON và log kiểm tra sau tải nằm trong `tai-lieu/ket-qua-do/*-faf490c-r*`. Log CPU, thông tin phần cứng và số liệu WAL đầy đủ nằm trong Artifacts của các lượt chạy.

PostgreSQL ở Aggregator gom các commit đồng thời trong tối đa 500 µs. Intent, giao dịch đặt chỗ, inbox và kết quả cuối vẫn chờ ghi bền. Chỉ dấu giao tin đã được RabbitMQ xác nhận dùng commit bất đồng bộ. Nếu mất dấu khi sập, hệ thống phát lại cùng ID và bên nhận xử lý trùng. [Tài liệu PostgreSQL về commit_delay](https://www.postgresql.org/docs/16/runtime-config-wal.html#GUC-COMMIT-DELAY).

## Kiểm tra lại lượt TC80 338 ms

Lượt 338 ms có 22,4% lệnh bãi B chờ hơn 100 ms trong hàng consumer, so với 1,9% và 8,9% ở hai lượt đạt của bản trước. p95 từ lúc lưu lệnh đến khi giao dịch node bắt đầu là 199 ms. Từ lúc giao dịch node bắt đầu đến lúc Aggregator ghi kết quả là 94 ms ở p95. Các percentile từng giai đoạn được tính riêng. [Lượt trượt](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42498232640/attempts/1).

Aggregator chuyển quét hết hạn sang nhịp bảo trì, gộp thông báo kết quả vào giao dịch cập nhật và bỏ lượt đọc lại ở bản vừa ghi. Node bỏ rollback khi câu giữ slot không đổi dòng nào và vẫn kiểm tra idempotency. Nginx ghi access log theo lô. Bản chỉ tối ưu Aggregator từng có một lượt 307 ms, nên tiếp tục tối ưu node và proxy. [Lượt 307 ms](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42500492832).

| Lượt độc lập, runtime ba69300 | Đọc p95 | Đặt p95 | Đặt p99 |
|---|---:|---:|---:|
| [42501009645](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42501009645) | 20,77 ms | 183 ms | 247 ms |
| [42501005467](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42501005467) | 17,12 ms | 141 ms | 204 ms |
| [42501008634](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42501008634) | 14,72 ms | 125 ms | 190 ms |

Ba lượt chạy 300 VU trong hai phút, B chậm 1.500 ms và đạt cả 12 bất biến sau tải. Mọi ngưỡng k6 đều qua, 503/504 bằng 0. Dữ liệu demo mới dùng 10 slot/bãi. Overlay `tests/load/benchmark-slots.compose.yml` giữ A/B/C ở 40/60/30 slot khi chạy TC80 và PD-20 để so sánh với kết quả cũ.

Sau khi tách seed demo, lượt `eb19475` đạt 283 ms. Lượt `0e31bd5` chỉ đổi test TC01 và có p95 353 ms, chạy lại 301 ms. Lượt 353 ms có WAL sync trung bình ở DB bãi B khoảng 0,99 ms/lần, so với 0,26–0,41 ms/lần ở ba lượt đạt. Bản sửa kế tiếp đưa kiểm tra request ID vào câu giữ slot, và chỉ lấy khóa quản trị khi thao tác cần kiểm tra chính sách đặt chỗ. [Lượt 283 ms](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42501525189) · [Lượt 353 và 301 ms](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42502224604).

## Kiểm chứng lại khi nghiệm thu GĐ2

Các lượt dưới đây dùng cùng runtime TC80 qua Nginx, 300 VU trong hai phút, 130 slot của bộ đo và bãi B trễ 1.500 ms. Các commit giữa các lượt chỉ đổi failover manager, profile sáu bãi, kiểm thử và tài liệu ngoài stack đo. Mỗi lượt đạt các ngưỡng k6 và 12 bất biến sau tải.

| Lượt | Đọc p95 | Đặt p95 |
|---|---:|---:|
| [42584345731](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42584345731) | 19,30 ms | 154 ms |
| [42585148487](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42585148487) | 20,67 ms | 156 ms |
| [42585749642](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42585749642) | 17,05 ms | 136 ms |
| [42585766630](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42585766630) | 35,22 ms | 269 ms |
| [42586082392](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42586082392) | 43,80 ms | 290 ms |

PD-20 ở lượt 42586082392 giảm p99 từ 1.601,68 ms xuống 39,25 ms (97,55%). Hai lượt thử lại trên runtime trước đó từng vượt 300 ms (369,65 và 590 ms). Lượt sau trên cùng runtime lại đạt p95 521,75 ms. p95 từ khi ghi intent tới khi node bắt đầu giao dịch tăng lên 280 ms. 22,9% lệnh ở B chờ trong bộ đệm consumer trên 100 ms. DB Aggregator thực hiện 28.866 lần đồng bộ WAL trong lượt này. [Lượt vượt ngưỡng](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42587003507).

Aggregator gom ý định trong cửa sổ 2 ms, tối đa 20 lệnh mỗi câu INSERT. Chỉ phát lệnh sau khi INSERT thành công. Bản `26f51ae` đo 155, 280 và 496 ms. Lượt 496 ms thực hiện 25.739 lần đồng bộ WAL trên DB Aggregator, mất trung bình 1,53 ms/lần. Cùng commit, lượt 155 ms đo trung bình 0,62 ms/lần. [Lượt 496 ms](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42588001343) · [Lượt 155 ms](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42588011599) · [Lượt 280 ms](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42588011865).

Bản kế tiếp gom tối đa 16 phản hồi trong một giao dịch. Cập nhật cache và ACK RabbitMQ vẫn diễn ra sau khi PostgreSQL xác nhận COMMIT.

## Ba lượt trên bản 12b259e

Runtime có gom ghi intent, gom giao dịch ghi kết quả và tái sử dụng snapshot khi trả xung đột slot. Cả ba lượt chạy đủ 300 VU hai phút, B trễ 1.500 ms. Mọi ngưỡng k6 và 12 bất biến sau tải đều đạt.

| Lượt | Đọc p95 | Đặt p95 | PD-20 p99 tắt / bật hedge | Giảm p99 |
|---|---:|---:|---:|---:|
| [42590443489](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42590443489) | 15,70 ms | 275 ms | 1.601,99 / 37,76 ms | 97,64% |
| [42590437526](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42590437526) | 12,59 ms | 184 ms | 1.602,00 / 53,19 ms | 96,68% |
| [42590442256](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42590442256) | 10,83 ms | 150 ms | 1.601,89 / 68,87 ms | 95,70% |

JSON gốc và kiểm tra sau tải được lưu trong `ket-qua-do/tc80-12b259e-r1` tới `r3`, và `pd20-12b259e-r1` tới `r3`. Các số đo vượt ngưỡng trên bản trước vẫn được ghi ở trên.

## Nghiệm thu cấu hình 10 slot mỗi bãi

Theo yêu cầu chốt 10 slot cho mọi bãi, gate TC80 dùng A/B/C tổng 30 slot. CI kiểm tra trực tiếp mỗi bãi có đúng 10 slot trước khi tạo tải. Workload giữ 240 VU đọc, 60 VU đặt, hai phút, B chậm 1.500 ms và ngưỡng p95 đặt dưới 300 ms. Counter `reservations_created` buộc có đặt thành công trong lượt đo.

Bộ dữ liệu 130 slot được giữ riêng để chạy lại các bảng lịch sử. Trên bộ này, hai lượt 6a72da9 đạt p95 414 và 428,55 ms. Mỗi bảng cần đọc cùng số slot ghi trong cấu hình tương ứng. [Lượt 414 ms](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42595605931) · [Lượt 428,55 ms](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42595646824).

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
