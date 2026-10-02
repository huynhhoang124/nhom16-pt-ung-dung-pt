# Nhóm 16 – Bãi đỗ xe thông minh liên kết nhiều bãi

**Môn:** Hệ thống / Ứng dụng phân tán – PTIT

**Thành viên:** Vũ Văn Hùng, Hoàng Văn Huynh, Nguyễn Văn Luân, Trịnh Kim Loan, Đỗ Huyền Trang, Phạm Sỹ Hiệp

## Thư mục
- `tai-lieu/Nhom16_Mo_hinh_HLD.pdf` – mô hình HLD + trả lời 3 câu (vì sao / ở đâu / giải pháp phân tán). **Bản mới nhất.**
- `tai-lieu/Ke_hoach_trien_khai.pdf` – kế hoạch triển khai 33 trang (API, DB, kiểm thử, 7 giai đoạn).
- `tai-lieu/ly-thuyet-ap-dung-xuyen-suot.md` – lý thuyết ứng dụng phân tán áp vào 8 kịch bản của đề tài (đặt chỗ, sự kiện, node sập/phục hồi…), kèm vấn đáp.
- `so-do/kien-truc-phan-tan-drawio-nhom16.*` – sơ đồ kiến trúc kiểu draw.io (Bài tập 2, 20/09/2026).
- `so-do/kien-truc-phan-tan-bai-do-xe-thong-minh.*` – bản sơ đồ đầu tiên.

## Kiến trúc (theo HLD)
Client (Người dùng, Nhân viên, Quản trị) → **Aggregator** (+ DB Aggregator, Message Broker AMQP) → **Site A/B/C**, mỗi site có Parking Node, Database riêng và Barrier/cảm biến (shared-nothing).
- Tra cứu: scatter–gather có timeout; bãi lỗi → trả kết quả một phần + `OFFLINE`.
- Đặt chỗ: định tuyến thẳng tới node, khóa cục bộ, không cần 2PC; node OFFLINE → từ chối.
- Sự kiện: ghi bảng `events` rồi mới publish (outbox) → Aggregator → WebSocket.

## Cần sửa
- [ ] Phân công trong kế hoạch đang viết cho 4 người, cần sửa thành 6.
- [ ] HLD Câu 2 ghi "bốn lớp" nhưng bảng có 6 dòng.
- [ ] Trang 2 ghi Aggregator "không giữ dữ liệu slot", trang 3 lại có "trạng thái tổng hợp / đối soát". Cần ghi rõ: cache chỉ đọc, nguồn gốc ở DB bãi.
- [ ] Giao diện nhân viên đi qua Aggregator nên Aggregator sập thì không xác nhận xe vào/ra được. Sửa: cho gọi thẳng Node, hoặc ghi là hạn chế.
- [ ] "Phân mảnh dọc SLOT_DEF/SLOT_STATE" nằm cùng một DB, nên gọi là "tách bảng trong site".
