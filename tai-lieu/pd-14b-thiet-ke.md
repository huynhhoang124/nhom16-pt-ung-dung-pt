# PD-14b – Failover tự động (#32)

Nguồn: `failover-manager/src/{leader,manager,index}.js`, `parking-node/src/dynamic-pool.js`.

`failover-manager` tranh khoá `/nhom16/election/failover` bằng CAS, lease TTL 5 s. Chỉ leader giám sát danh sách `PARKINGS`; vòng kiểm tra đặt lịch mỗi 1 s, không chạy chồng. Primary lỗi 3 lần liên tiếp thì kiểm tra replica bằng `pg_last_wal_replay_lsn()`. Mỗi phép kiểm tra sức khỏe primary hoặc replica giới hạn kết nối ở 500 ms và truy vấn ở 1 s. Pool động tại node giới hạn kết nối ở 1 s và truy vấn ở 2 s để request tới primary cũ kết thúc trong thời gian hữu hạn. Kết nối dùng để promote giữ giới hạn riêng. Đây là tham số, không phải số đo failover.

Thứ tự bảo vệ ghi:
1. CAS tăng `/nhom16/parking/<bãi>/db/epoch` từ N lên N+1, đồng thời kiểm payload khoá leader. CAS thất bại thì không promote.
2. Chờ `FAILOVER_WAIT_WINDOW_MS` (mặc định 6000 ms), phải lớn hơn `ETCD_WATCH_WINDOW_MS` của node (mặc định 5000 ms). Node nhận epoch mới thì từ chối DB còn epoch cũ bằng `409 STALE_DB_EPOCH`; mất liên lạc etcd quá cửa sổ thì trả `503 ETCD_UNREACHABLE`. Heartbeat đọc cả địa chỉ primary lẫn epoch để bù watcher bị đứt.
3. Kiểm lại quyền leader và epoch sau khi chờ, rồi `pg_promote()`. Promote lỗi: giữ N+1, báo `FAILOVER_PROMOTE_FAILED`, không trỏ primary sang replica lỗi.
4. Promote thành công mới ghi địa chỉ primary lên etcd, rồi cập nhật `db_epoch` trên DB mới (tối đa 10 lần thử). Trong khoảng địa chỉ đã đổi nhưng DB chưa cập nhật epoch, node vẫn chặn ghi do epoch lệch; pool tự đổi theo watch/heartbeat.

Bãi có `sync=true` (A, D theo cấu hình triển khai): replica lỗi ít nhất 3 s hoặc 3 lần kiểm tra, trong khi primary sống, thì RESET `synchronous_standby_names` và reload. Code ghi cảnh báo vì chuyển async có thể mất giao dịch khi primary chết; không tự bật lại sync hay tự gắn primary cũ làm replica. Khôi phục bằng runbook/rewind, không cho primary cũ nhận ghi trực tiếp ngoài đường kiểm epoch của node. Kiểm chứng còn cần: TC68–TC70, TC65–TC66 và `scripts/measure-failover.mjs`; tài liệu này không khẳng định thời gian/RPO đã đo.
