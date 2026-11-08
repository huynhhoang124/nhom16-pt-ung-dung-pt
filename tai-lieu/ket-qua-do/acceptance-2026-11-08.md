# Nghiệm thu hiệu năng 08/11/2026

- Runtime: 4bf3378ae107b82e66d2d36bab704389e46225fc.
- Test-only follow-up: 7b2e8180148a5ccbf49e712d2e5d028b22f41162.
- Runner: GitHub Actions ubuntu-latest; Docker Compose stack cùng máy, dữ liệu seed mới mỗi job.
- TC80: broker, ba bãi A/B/C, một Aggregator, B downstream latency 1500 ms; 240 VU đọc +60 VU đặt trong 2 phút. Độ trễ đặt tới kết quả cuối.
- TC80 lượt 1: run 42489837577, p95 đặt 209 ms, p99 281 ms; đọc p95 22,68 ms.
- TC80 lượt 2: run 42489834410, p95 đặt 174 ms, p99 252 ms; đọc p95 21,38 ms.
- Hai lượt: toàn bộ thresholds đạt, check 100%, HTTP error/503/504=0; 12 bất biến đạt.
- PD20 cùng runtime: hai node B dùng cùng DB và đăng ký etcd; primary chậm qua proxy, secondary trực tiếp. 100 VU đọc snapshot đủ slot/không stale, 2 phút mỗi vế; tắt rồi bật HEDGE_ENABLED.
- PD20 lượt 1: p99 baseline 1601,83530063 ms; hedged 35,19239087 ms; giảm 97,80299567%.
- Đối chiếu kết quả và giới hạn đo trong ../ket-qua-do-so-sanh.md.
- Không thay ngưỡng, workload, fsync, xác thực, idempotency hay tiêu chí kết quả cuối để làm test đạt.
- CI cuối và merge được theo dõi tại PR #100: https://github.com/huynhhoang124/nhom16-pt-ung-dung-pt/pull/100
