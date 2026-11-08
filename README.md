# Nhóm 16 – Bãi đỗ xe thông minh liên kết nhiều bãi

PD-03: [API request–reply, cấu hình và runbook](tai-lieu/pd-03-request-reply.md).

PD-08: [retry 2s/10s, DLQ, trang đẩy lại và kiểm thử trực tiếp trên dev](tai-lieu/pd-08-retry-dlq.md).

**Môn:** Hệ thống / Ứng dụng phân tán – PTIT

**Thành viên:** Vũ Văn Hùng, Hoàng Văn Huynh, Nguyễn Văn Luân, Trịnh Kim Loan, Đỗ Huyền Trang, Phạm Sỹ Hiệp

> Nhóm đọc trước: **`tai-lieu/ke-hoach-thuc-hien-btl.md`** (hiện trạng, phân công, lịch, kịch bản demo).

## Chạy hệ thống
Cần Docker Desktop đang bật.
```bash
cp .env.example .env            # lần đầu: khoá bí mật; máy demo thì đổi khoá thành chuỗi ngẫu nhiên
docker compose up -d --build
```
- Web: http://localhost:3000. Tự đăng ký tài khoản người dùng, hoặc dùng tài khoản demo (mật khẩu `123456`): `user1`, `user2`, `staff-a`/`staff-b`/`staff-c` (nhân viên từng bãi), `admin`.
- RabbitMQ: http://localhost:15672 (parking / parking) · Aggregator: :8000 · Parking A/B/C: :8001/:8002/:8003
- Thêm bãi D để demo mở rộng: xem [Kịch bản demo: thêm bãi mới](#kịch-bản-demo-thêm-bãi-mới) bên dưới.
- Cổng 3000 / 8000 đã có chương trình khác chiếm (container của project khác, hoặc bản dev không Docker đang chạy) thì web/Aggregator không lên: kiểm tra `netstat -ano | findstr :3000` rồi tắt chương trình đó trước.
- `ETCD_ENDPOINTS` trong `.env` chỉ bật khi chạy kèm `--profile coord` (cụm etcd). Bật mà không chạy etcd thì các bãi kẹt lúc khởi động ("Không thể đọc etcd ban đầu") và luôn hiện mất kết nối.
- Mở rộng PD-12 thành 6 bãi ở 2 vùng: `node scripts/gen-lots.mjs`, rồi `docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile scale --profile coord up -d --build`. A–C thuộc vùng Bắc; D–F thuộc vùng Nam, đăng ký lease qua cụm etcd và đi qua Toxiproxy với độ trễ 40 ± 10 ms. Kiểm tra: `$env:SCALE='1'; $env:COORD='1'; node --test tests/e2e.test.mjs` (PowerShell). Không dùng `--wait`: service `region-latency` chạy xong thì thoát nên `--wait` báo lỗi. Aggregator đặt `ZONE` thì gọi bãi cùng vùng trước.
- Giả lập barrier gọi thẳng bãi: `node scripts/barrier.mjs A A05 enter 30A-123.45` (đọc khoá từ `.env`)
- Sinh dữ liệu mẫu trang Thống kê: `node scripts/du-lieu-mau.mjs [số_lượt]` (mặc định 150 lượt xe vào/ra ngẫu nhiên trên 3 bãi; đặt `SCALE=1` để chạy trên cả 6)
- Chịu lỗi nâng cao: bỏ dấu `#` ở 2 dòng `A_READ_DATABASE_URL` và `RABBITMQ_URL` trong `.env` (xem `.env.example`), rồi `docker compose --profile ha up -d` thêm bản sao DB bãi A, aggregator-2 và 2 nút RabbitMQ (cụm 3 nút, quorum queue). Thử `docker compose stop aggregator` hoặc `docker compose stop rabbitmq`: hệ thống vẫn chạy
- Nâng cấp RabbitMQ: giữ volume, đối chiếu tham số queue trước khi nạp definitions; xem [PD-01: topology, kiểm thử và chuyển đổi bảo toàn dữ liệu](tai-lieu/pd-01-command-topology.md).
- Mạng xấu: `docker compose -f docker-compose.yml -f docker-compose.chaos.yml --profile chaos up -d`, rồi `node scripts/net.mjs B latency 3500` / `down` / `loss 30` / `reset`
- Giám sát: `docker compose --profile obs up -d` → Grafana http://localhost:3001 (dashboard nạp sẵn), Prometheus :9090
- Lần theo một request qua mọi dịch vụ (log JSON, mã ở header `X-Request-Id` của response): `docker compose logs | grep <mã>`
- Dừng: `docker compose down` (giữ dữ liệu) · `docker compose down -v` (xoá sạch)

## Kịch bản demo: thêm bãi mới
Bãi A, B, C nạp sẵn; bãi D có sẵn máy chủ (`parking-d`) nhưng **chưa đăng ký** — dùng để demo mở rộng không sửa code, không khởi động lại trung tâm.
1. `.env` để `ETCD_ENDPOINTS=` (rỗng). Nếu bật etcd, bãi D **tự đăng ký** và hiện trong bảng, chỉ còn bước "Sửa" tên/vị trí.
2. `docker compose up -d --build`, vào http://localhost:3000, đăng nhập `admin` → **Quản trị**.
3. Bật máy chủ bãi D: `docker compose --profile extra up -d`. Đợi đến khi `docker compose logs parking-d` có dòng "Parking D chạy ở cổng 8004".
4. Form **Thêm bãi mới**: gõ mã `D` → địa chỉ máy chủ tự gợi ý `http://parking-d:8004` → **Kiểm tra kết nối** (phải ✅ "máy chủ bãi D") → đặt tên → chọn vị trí trên bản đồ (bấm / kéo ghim / tìm địa chỉ) → **Thêm bãi**.
5. Vài giây sau bãi D "Đang kết nối"; Tổng quan và Bản đồ có bãi D; `user1` đặt chỗ được ở D.
6. (Tuỳ chọn) chịu lỗi: `docker compose stop parking-d` → sau ~15 s bãi D "Mất kết nối", khách thấy dữ liệu cũ và không đặt được; `docker compose start parking-d` để bật lại.

Địa chỉ máy chủ của bãi là nơi service `parking-node` của bãi đó chạy (biến `NODE_URL`), **trung tâm phải gọi tới được**: trong Docker dùng tên service (`http://parking-d:8004`), không dùng `localhost`. Bãi chỉ gỡ được khi đang mất kết nối (thêm nhầm / đã ngừng chạy).

## Làm giao diện không cần Docker
```bash
node scripts/dev-no-docker.cjs     # 3 bãi + Aggregator bằng PGlite trong 1 tiến trình (dữ liệu trong RAM)
cd frontend && npm run dev         # http://localhost:3000 (cổng 3000 bận thì: npm run dev -- --port 5173)
```
Bản này không có bãi D, không có RabbitMQ; khoá nội bộ là `dev` (khác Docker) nên không trộn với container Docker. Dữ liệu mất khi tắt.

## Test quét QR bằng điện thoại
Trình duyệt **chỉ cho dùng camera trên HTTPS hoặc `localhost`**. Điện thoại vào `http://<IP-máy>:3000` vẫn **hiện** mã QR được nhưng **không quét** được (iPhone: mọi trình duyệt, kể cả Chrome, đều chặn).
- **Điện thoại hiện QR, laptop quét:** điện thoại mở `http://<IP-máy>:3000` → `user1` đặt chỗ "Ngay bây giờ" ở bãi A → *Đặt chỗ của tôi* → chạm mã QR (mở toàn màn hình, giữ màn hình sáng). Laptop mở `http://localhost:3000` → `staff-a` → *Cổng* → *Quét mã QR*. Máy quét không đọc được: giảm độ sáng điện thoại, đưa cách 15–25 cm, nghiêng nhẹ cho đỡ loá.
- **Điện thoại làm máy quét (cần HTTPS):** chạy hệ thống (Docker hoặc `dev-no-docker`), rồi
  ```bash
  node scripts/dev-cert.mjs          # chứng chỉ tự ký cho các IP của máy (frontend/.cert, ngoài git)
  cd frontend && npm run dev:https   # https://<IP-máy>:5173, proxy /api tới Aggregator :8000
  ```
  Điện thoại mở `https://<IP-máy>:5173` → cảnh báo chứng chỉ → *Hiện chi tiết → Truy cập trang web này* → `staff-a` → *Cổng* → *Quét mã QR*. Trên chính máy tính dùng `https://127.0.0.1:5173`.
- Điện thoại không vào được: cùng Wi-Fi chưa; Windows để mạng Wi-Fi ở chế độ **Private** hoặc mở cổng (PowerShell Admin: `New-NetFirewallRule -DisplayName "Nhom16 dev" -Direction Inbound -Protocol TCP -LocalPort 3000,5173 -Action Allow`); Wi-Fi công cộng hay chặn thiết bị nói chuyện với nhau → dùng hotspot của điện thoại.

## Giao diện (nhánh personal/luan-ui)
- Một giao diện chung đỏ–navy cho mọi vai trò (`frontend/src/theme.css`), có chế độ tối; mỗi màn có URL riêng (`#/mine`, `#/parking/A/A05`...).
- Người dùng: chọn nhanh giờ đến, tóm tắt giờ ra / hạn giữ chỗ / phí ước tính trước khi đặt, "Xe của tôi", vé chia nhóm (đang trong bãi / đang giữ / sắp tới) kèm chỉ đường.
- Thanh toán trong bãi: trả xong có **15 phút** để ra; ra muộn hơn mà phí đã tăng thì trả thêm phần chênh (ứng dụng hoặc tiền mặt ở cổng).
- Nhân viên: vào thẳng bãi mình, thông tin xe trong ô, đối chiếu biển số với vé, bước thu tiền mặt riêng, cảnh báo vé khi khoá bảo trì, màn Cổng tự nhận vào/ra + chế độ toàn màn hình, làm việc thẳng với bãi khi trung tâm sập.
- Quản trị: sửa/gỡ bãi, kiểm tra kết nối trước khi thêm, chọn vị trí trên bản đồ, Thống kê lọc theo bãi.

## Kiểm thử
```bash
cd parking-node && npm install && npm test          # PGlite, không cần Docker
cd ../aggregator-service && npm install && npm test # cần npm install ở parking-node trước
cd ../notification-service && npm install && npm test   # quy tắc thông báo (NV-08)
cd ../frontend && npm install && cd ..
node --test tests/e2e.test.mjs                      # test trên Docker; tự dọn dữ liệu sau khi chạy
#   TC46 cần khoá RS256: node scripts/gen-keys.mjs rồi docker compose up -d
#   TC43, TC44 cần --profile ha: HA=1 node --test tests/e2e.test.mjs
docker run --rm -i --network nhom16-parking_default -e BASE=http://aggregator:8000 grafana/k6 run - < tests/load/k6.js   # GS-05 test tải
node tests/load/check-invariants.mjs                # GS-05/06 kiểm bất biến (không đặt trùng, outbox về 0...)
node tests/chaos.mjs                                # GS-06 vừa tải vừa tắt/bật ngẫu nhiên (cần --profile ha)
```

## PD-22 và PD-23

Aggregator đọc lại tối đa 10 phút từ `events.stream` khi bắt đầu nhận sự kiện. Muốn bật thống kê CQRS, đặt `USE_STATS_SERVICE=true` trong `.env` và chạy `docker compose --profile stats up -d --build`. Dịch vụ lưu vị trí đọc trong Postgres và tiếp tục từ đó sau khi khởi động lại. Thống kê CQRS chỉ gồm dữ liệu nhận được qua stream. Với dữ liệu có từ trước khi bật stream, dùng chế độ thống kê trực tiếp mặc định.

## PD-26 – kiểm thử Jepsen

Harness mới ở `tests/jepsen/` chạy workload có seed, lưu history JSONL và kiểm sáu bất biến trên Docker Compose riêng, dùng cổng Aggregator/bãi `18000–18006` và cổng Toxiproxy `19474–19479` để không đụng stack phát triển:

```powershell
node --test tests/jepsen/*.test.mjs
node tests/jepsen/run.mjs --scenario tc79 --seed 42 --time 60
node tests/jepsen/run.mjs --nemesis loss --seed 42 --time 60
```

TC79 chạy workload trên ba bãi và cô lập một nút RabbitMQ. TC78 cần topology sáu bãi của PD-12:

```powershell
$env:JEPSEN_PARKING_IDS = 'A,B,C,D,E,F'
node tests/jepsen/run.mjs --scenario tc78 --nemesis partition --seed 42 --time 120
Remove-Item Env:JEPSEN_PARKING_IDS
```

`docker-compose.scale.yml` được dùng tự động cho sáu bãi. Các lựa chọn nemesis độc lập: `none`, `rabbitmq`, `loss` (mất 20% gói) và `partition` (cắt kết nối tới vùng Nam trong 30 giây). History nằm trong `tests/jepsen/results/`, có in seed và được Git bỏ qua. Mặc định runner tự dọn Docker project tạm sau khi chạy; đặt `JEPSEN_PROJECT` để giữ project phục vụ kiểm tra thủ công. Dùng `node tests/jepsen/run.mjs --help` để xem các tùy chọn.

PD-26 bổ sung nemesis `db`, `leader`, và `random` cho topology sáu bãi. `db` dừng primary A để failover-manager promote replica; `leader` pause Aggregator leader 15 giây; `random` chạy cả hai theo lịch tái lập được từ seed trong cửa sổ ít nhất 300 giây. Bất biến 6 kiểm tra một primary đang hoạt động và đối chiếu `db_epoch` với epoch trong etcd. Chạy hai seed:

```powershell
$env:JEPSEN_PARKING_IDS = 'A,B,C,D,E,F'
node tests/jepsen/run.mjs --nemesis random --seed 42 --time 300
node tests/jepsen/run.mjs --nemesis random --seed 43 --time 300
Remove-Item Env:JEPSEN_PARKING_IDS
```

## Kiến trúc
```
Trình duyệt ── Aggregator ── DB Aggregator
                  │  ▲ RabbitMQ (parking.events → aggregator.slot-updates.<bản>)
                  ▼  │
   Parking Node A/B/C ── DB A / DB B / DB C (mỗi bãi 1 DB riêng; parking_events = outbox)
```

| File | Lý thuyết áp dụng |
|---|---|
| `parking-node/src/slots.js` | Giao dịch cục bộ, compare-and-swap (`UPDATE … WHERE`), idempotency key, Transactional Outbox, tombstone (huỷ không xoá cứng), hết hạn theo đồng hồ của bãi |
| `parking-node/src/schema.sql` | Shared-nothing, unique index chống đặt trùng ở tầng DB, `version` per-slot |
| `parking-node/src/relay.js` | Outbox relay, at-least-once, publisher confirm, giữ thứ tự |
| `aggregator-service/src/nodes.js` | Failure detector (health check, 3 lần lỗi), scatter–gather có timeout, kết quả một phần |
| `aggregator-service/src/routes.js` | Định tuyến theo shard, CAP (ghi từ chối khi OFFLINE / đọc trả dữ liệu cũ), timeout không rõ kết quả (hai tướng quân), phân quyền |
| `aggregator-service/src/events.js` | Chống tin trùng/sai thứ tự bằng version, anti-entropy (đối soát), consumer ack thủ công |
| `tests/e2e.test.mjs` | Chứng minh: cô lập dữ liệu, tranh chấp đồng thời, chịu lỗi node/broker/aggregator |

## Thư mục tài liệu
- `tai-lieu/tien-do.md` – **tiến độ + bàn giao mới nhất (đọc trước)**.
- `tai-lieu/ke-hoach-thuc-hien-btl.md` – kế hoạch bản cơ bản.
- `tai-lieu/ke-hoach-chi-tiet-ban-hoan-chinh.md` – kế hoạch chi tiết bản hoàn chỉnh: đặc tả 32 việc, phân công, lịch theo tuần, demo, báo cáo.
- `tai-lieu/danh-sach-viec-nho.md` – 32 việc chia thành việc nhỏ 1–4 giờ, có người làm và thứ tự.
- `tai-lieu/ly-thuyet-ap-dung-xuyen-suot.md` – lý thuyết áp vào 8 kịch bản của đề tài, kèm vấn đáp.
- `tai-lieu/ap-dung-vao-btl.md` – thiết kế chi tiết (schema, API, test case, dàn báo cáo).
- `tai-lieu/Nhom16_Mo_hinh_HLD.pdf` – mô hình HLD đã nộp (bản mới nhất).
- `tai-lieu/Ke_hoach_trien_khai.pdf` – kế hoạch triển khai 33 trang đã nộp (đã cập nhật phân công 6 người).
- `tai-lieu/mo-hinh-hld.md` – mô hình HLD dạng Markdown đầy đủ, chuẩn hóa thuật ngữ phân tán.
- `tai-lieu/kiem-thu-cong-qr.md` – checklist và ghi nhận kiểm thử màn hình cổng + quét QR trên điện thoại thật (UX-04.5).
- `so-do/` – sơ đồ kiến trúc draw.io.

## Cần sửa trong tài liệu đã nộp (Đã hoàn thành - TL-01)
- [x] Phân công trong kế hoạch đang viết cho 4 người, cần sửa thành 6 (đã sửa trang 32 `Ke_hoach_trien_khai.pdf` và `ke-hoach-chi-tiet-ban-hoan-chinh.md`).
- [x] HLD Câu 2 ghi "bốn lớp" nhưng bảng có 6 dòng (đã hiệu chỉnh khớp 6 thành phần phân tán).
- [x] Trang 2 ghi Aggregator "không giữ dữ liệu slot", trang 3 lại có "trạng thái tổng hợp / đối soát". Cần ghi rõ: cache chỉ đọc (read-only), nguồn gốc ở DB bãi.
- [x] Giao diện nhân viên đi qua Aggregator: đã giải quyết dứt điểm bằng tính năng PT-05 (nhân viên xác thực offline và gọi thẳng Parking Node khi Aggregator sập).
- [x] "Phân mảnh dọc SLOT_DEF/SLOT_STATE" nằm cùng một DB, nên gọi là "tách bảng trong site".
- [x] Câu CAP: chỉ phải chọn khi có phân vùng mạng (ghi chọn nhất quán C, đọc chọn sẵn sàng A).

## PD-01 – Kênh publish lệnh RabbitMQ

Topology lệnh tự nạp trên mọi broker: `parking.commands`, `parking.dlx`, quorum queue `cmd.A/B/C` có Single Active Consumer và đích bền vững `cmd.expired`. DLX và giới hạn lệnh dùng policy có thể cập nhật. Definitions không tạo sẵn queue/binding sự kiện; dịch vụ đang chạy tự tạo chúng, tránh tạo queue Aggregator `.2` khi chưa bật bản thứ hai. Vhost thống nhất là `/` (URI `/%2F`). Tài khoản `parking/parking` trong definitions chỉ dành cho demo; cấu hình riêng bằng `RABBITMQ_DEFINITIONS_FILE` và `RABBITMQ_URL`.

Endpoint bổ sung `POST /api/admin/parkings/:id/commands` (ADMIN) dùng broker thật; return `NO_ROUTE` trả 404, confirm trả 202 `BROKER_CONFIRMED`, `processed:false`. Các API nghiệp vụ tiếp tục dùng HTTP. Xem [hướng dẫn chạy, envelope, mã lỗi, kiểm chứng và giới hạn PD-01](tai-lieu/pd-01-command-topology.md).

## PD-02 – Inbox tại parking node

Node nhận lệnh đã được server ký từ `cmd.<PARKING_ID>`, ghi inbox + nghiệp vụ + outbox phản hồi trong cùng transaction rồi mới ack. Tin giao lại dùng kết quả cũ; key dùng cho nội dung khác trả 422. `INTERNAL_KEY` phải nhất quán giữa Aggregator và node. Dọn inbox quá 7 ngày mỗi 30 giây; không bảo đảm dedup vô hạn.

API nghiệp vụ cũ tiếp tục dùng HTTP. PD-02 chưa có HTTP request–reply/tra cứu kết quả của PD-03. Xem [thiết kế, schema, nâng cấp bảo toàn dữ liệu và TC52/TC53 broker](tai-lieu/pd-02-command-inbox.md). Chạy `node --test --test-name-pattern='PD-02' tests/e2e.test.mjs` trên stack Docker test cô lập; test khôi phục service và không xóa volume.

## PD-04 – Phát lệnh quản trị A–F

Đăng nhập `admin`, mở **Quản trị** để đổi bảng giá, khóa/mở tầng hoặc cấm/bỏ cấm biển số tại A–F. Một publish qua broker; kết quả từng bãi được lưu bền vững và tự cập nhật khi phản hồi muộn. Chạy trực tiếp trên stack dev, không cần candidate, patch hay source ngoài. Xem [API, topology, cách chạy và bằng chứng giao diện/DB thật](tai-lieu/pd-04-broadcast-abc.md). Phần nối PD-03 và TC61 sáu bãi do Huynh tiếp nhận.
