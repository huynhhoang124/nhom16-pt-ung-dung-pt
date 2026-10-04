# Nhóm 16 – Bãi đỗ xe thông minh liên kết nhiều bãi

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
- Lần theo một request qua mọi dịch vụ (log JSON, mã ở header `X-Request-Id` của response): `docker compose logs | grep <mã>`
- Dừng: `docker compose down` (giữ dữ liệu) · `docker compose down -v` (xoá sạch)

## Kiểm thử
```bash
cd parking-node && npm install && npm test          # PGlite, không cần Docker
cd ../aggregator-service && npm install && npm test # cần npm install ở parking-node trước
cd ../frontend && npm install && cd ..
node --test tests/e2e.test.mjs                      # 9 test trên Docker; tự dọn dữ liệu sau khi chạy
```

## Kiến trúc
```
Trình duyệt ── Aggregator ── DB Aggregator
                  │  ▲ RabbitMQ (parking.events → aggregator.slot-updates)
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
- `tai-lieu/ke-hoach-thuc-hien-btl.md` – kế hoạch thực hiện cho nhóm (đọc trước).
- `tai-lieu/ke-hoach-chi-tiet-ban-hoan-chinh.md` – kế hoạch chi tiết bản hoàn chỉnh: đặc tả 32 việc, phân công, lịch theo tuần, demo, báo cáo.
- `tai-lieu/danh-sach-viec-nho.md` – 32 việc chia thành việc nhỏ 1–4 giờ, có người làm và thứ tự.
- `tai-lieu/ly-thuyet-ap-dung-xuyen-suot.md` – lý thuyết áp vào 8 kịch bản của đề tài, kèm vấn đáp.
- `tai-lieu/ap-dung-vao-btl.md` – thiết kế chi tiết (schema, API, test case, dàn báo cáo).
- `tai-lieu/Nhom16_Mo_hinh_HLD.pdf` – mô hình HLD đã nộp (bản mới nhất).
- `tai-lieu/Ke_hoach_trien_khai.pdf` – kế hoạch triển khai 33 trang đã nộp.
- `so-do/` – sơ đồ kiến trúc draw.io.

## Cần sửa trong tài liệu đã nộp
- [ ] Phân công trong kế hoạch đang viết cho 4 người, cần sửa thành 6.
- [ ] HLD Câu 2 ghi "bốn lớp" nhưng bảng có 6 dòng.
- [ ] Trang 2 ghi Aggregator "không giữ dữ liệu slot", trang 3 lại có "trạng thái tổng hợp / đối soát". Cần ghi rõ: cache chỉ đọc, nguồn gốc ở DB bãi.
- [ ] Giao diện nhân viên đi qua Aggregator nên Aggregator sập thì không xác nhận xe vào/ra được (barrier vẫn gọi thẳng node). Ghi là hạn chế.
- [ ] "Phân mảnh dọc SLOT_DEF/SLOT_STATE" nằm cùng một DB, nên gọi là "tách bảng trong site".
- [ ] Câu CAP: chỉ phải chọn khi có phân vùng mạng (ghi chọn nhất quán, đọc chọn sẵn sàng).
