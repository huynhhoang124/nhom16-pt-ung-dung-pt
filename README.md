# Nhóm 16 – Bãi đỗ xe thông minh liên kết nhiều bãi

PD-03: [API request–reply, cấu hình và runbook](tai-lieu/pd-03-request-reply.md).

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
- Thêm bãi D để demo mở rộng: `docker compose --profile extra up -d`, rồi đăng ký trên trang Quản trị với `http://parking-d:8004`.
- Giả lập barrier gọi thẳng bãi: `node scripts/barrier.mjs A A05 enter 30A-123.45` (đọc khoá từ `.env`)
- Sinh dữ liệu mẫu trang Thống kê: `node scripts/du-lieu-mau.mjs [số_lượt]` (mặc định 150 lượt xe vào/ra ngẫu nhiên trên cả 3 bãi)
- Chịu lỗi nâng cao: bỏ dấu `#` ở 2 dòng `A_READ_DATABASE_URL` và `RABBITMQ_URL` trong `.env` (xem `.env.example`), rồi `docker compose --profile ha up -d` thêm bản sao DB bãi A, aggregator-2 và 2 nút RabbitMQ (cụm 3 nút, quorum queue). Thử `docker compose stop aggregator` hoặc `docker compose stop rabbitmq`: hệ thống vẫn chạy
- Nâng cấp RabbitMQ: giữ volume, đối chiếu tham số queue trước khi nạp definitions; xem [PD-01: topology, kiểm thử và chuyển đổi bảo toàn dữ liệu](tai-lieu/pd-01-command-topology.md).
- Mạng xấu: `docker compose -f docker-compose.yml -f docker-compose.chaos.yml --profile chaos up -d`, rồi `node scripts/net.mjs B latency 3500` / `down` / `loss 30` / `reset`
- Giám sát: `docker compose --profile obs up -d` → Grafana http://localhost:3001 (dashboard nạp sẵn), Prometheus :9090
- Lần theo một request qua mọi dịch vụ (log JSON, mã ở header `X-Request-Id` của response): `docker compose logs | grep <mã>`
- Dừng: `docker compose down` (giữ dữ liệu) · `docker compose down -v` (xoá sạch)

## Làm giao diện không cần Docker
```bash
node scripts/dev-no-docker.cjs     # 3 bãi + Aggregator bằng PGlite trong 1 tiến trình (dữ liệu trong RAM)
cd frontend && npm run dev         # http://localhost:3000
```

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
