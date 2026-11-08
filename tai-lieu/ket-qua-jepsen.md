# Kết quả kiểm thử Jepsen Giai đoạn 2

Chạy trên Docker của GitHub Actions ngày 08/11/2026. Mỗi lượt dựng cụm riêng và lưu lịch sử JSONL trong mục Artifacts.

| Kịch bản | Seed | Thời lượng tải | Kết quả |
|---|---:|---:|---|
| TC78, phân hoạch Bắc và Nam trong 30 giây | 42 | 120 giây | 6/6 bất biến đạt |
| TC79, cô lập một nút RabbitMQ | 42 | 60 giây | Đạt, các lệnh đã confirm vẫn có kết quả cuối |
| Failover DB và tạm dừng leader | 42 | 300 giây | 6/6 bất biến đạt. 1.933 lệnh đã nhận đều kết thúc. |
| Failover DB và tạm dừng leader | 43 | 300 giây | 6/6 bất biến đạt. 1.836 lệnh đã nhận đều kết thúc. |

Nguồn số liệu và lịch sử [lượt CI trên commit 7f58824](https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/actions/runs/42470803318).
