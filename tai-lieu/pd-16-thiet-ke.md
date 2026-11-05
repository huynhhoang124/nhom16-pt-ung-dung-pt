# PD-16 – Phân mảnh users (#34)

Nguồn: `aggregator-service/src/ring.js`, `scripts/them-phan-manh.mjs`; theo trả lời B4 trong `PLAN.md`.

Vòng băm lấy 4 byte đầu SHA-1 của chuỗi viết thường thành số trên vòng 2³². Mỗi phân mảnh có 128 nút ảo; `shardFor(username)` tìm nhị phân điểm đầu tiên ≥ hash, qua cuối thì quay về đầu vòng. `addShard`/`removeShard` cập nhật vòng; tên phân mảnh là hostname trong URL nên đổi mật khẩu/cổng không đổi chủ khoá. `USERS_DATABASE_URLS` cung cấp các pool; không cấu hình thì dùng pool `db-agg` như cũ. Đây không phải tự phát hiện phân mảnh chết: không đổi vòng chỉ vì một DB tạm mất kết nối.

Chỉ `users` và dữ liệu giới hạn đăng nhập `login_buckets` của B9 nằm theo username; request đã xác thực có username trong JWT. `commands`, `sagas` vẫn ở `db-agg` vì là dữ liệu điều phối, không thêm bảng ánh xạ UUID → username, không dò mọi phân mảnh khi đăng nhập. Mục tiêu TC72 về phân bố/chuyển khoá là tiêu chí test, không phải số đo được công bố ở đây.

Script thêm phân mảnh (2 → 3) hiện dùng **chặn ghi → chép → đối chiếu → đổi cấu hình đọc → xoá bản cũ**, không có ghi đôi. Trạng thái chung ở `db-agg.shard_migrations`; `--add <url> --dry-run` chỉ liệt kê user đổi chủ, nhưng vẫn kết nối `db-agg` và chạy `CREATE TABLE IF NOT EXISTS`. Lượt thật bật `write_blocked`, chờ `DRAIN_MS` (mặc định 3000 ms), chỉ chép user mà vòng mới giao cho phân mảnh thêm vào. Bản chép được đối chiếu số lượng và MD5 của các cột user đã sắp xếp; sai thì đánh dấu FAILED, mở lại ghi, giữ vòng cũ. Đúng thì VERIFIED và vẫn chặn ghi. Người vận hành cập nhật `USERS_DATABASE_URLS` trên **mọi** Aggregator, khởi động lại để chuyển đọc, rồi mới chạy `--cleanup` xoá bản cũ và mở ghi. `--import-agg` chép một lần user cũ từ `db-agg` vào vòng hiện tại.

Giới hạn cần giữ khi vận hành: script hiện chỉ chép cột của `users`, không chuyển `login_buckets`; không được coi bộ đếm đăng nhập là đã được bảo toàn khi di chuyển. Khoảng drain là chờ cố định, chưa đếm request ghi đang chạy; `--cleanup` không tự chứng minh tất cả Aggregator đã đổi vòng. Lỗi sau VERIFIED cần kiểm tra cấu hình trước khi xoá dữ liệu. Chưa chạy di chuyển/TC72/TC73 trong đợt viết tài liệu này.

## Chạy thử 05/11/2026

Chạy `scripts/them-phan-manh.mjs` từ 2 lên 3 phân mảnh trên Docker, với 6 user mẫu:
- `--add`: chép 1 user sang `db-users-3`, checksum khớp. Trong lúc này đăng ký trả `503 USERS_MIGRATING`.
- Đặt `USERS_DATABASE_URLS` mới, khởi động lại Aggregator, rồi `--cleanup`: xoá 1 bản cũ, mở lại ghi.
- Sau đó `admin`, `user1`, `user2` đăng nhập được, đăng ký user mới được. Số user trên 3 phân mảnh: 5, 1, 1.
