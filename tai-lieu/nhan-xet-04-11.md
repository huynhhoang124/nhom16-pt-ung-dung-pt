# Nhận xét PR ngày 04/11

Người nhận xét: Hoàng Văn Huynh. Nền so sánh: `dev` tại `306ab27`, sau khi merge #79, #78, #82, #55. Sau đó #80, #81 (qua #85) và #83 (qua #86) cũng đã vào `dev`.

## Đã merge

| PR | Người làm | Việc | Góp ý nhỏ, không chặn |
|---|---|---|---|
| #79 | Hùng | PD-02 | Lỗi hạ tầng cũng hẹn dòng đầu lại 30 s. |
| #78 | Luận | PD-10 | Không có. |
| #82 | Loan | PD-13 | Không có. |
| #55 | Loan | PD-17 | `hlc.update` trong `applyEvent` ném lỗi khi hlc sai định dạng; nên bắt lỗi. |

Kết quả e2e và phần test Huynh sửa thêm: xem PR #84.

## Loan – #64 PD-05: chưa merge

Commit mới `263db2c` chưa sửa được lỗi chặn.

1. **Lỗi chặn: TC60 PD-05 chạy trên mọi stack.** `tests/tc60.pd05.test.mjs` khai báo test chỉ có `{ timeout: 240000 }`, không có `skip`.
   - `tests/e2e.test.mjs` gọi `registerTc60Pd05Tests`, nên test này cũng chạy trên stack không bật `pd13`.
   - Lỗi đã gặp: `Expected exactly one running container for rabbitmq-2; found 0` trên `scale`, `rabbitmq must be healthy` trên `http` và `hashard`.
   - `compose('up', '-d', '--wait', 'parking-a-2')` ở `263db2c` không giải quyết việc này. Stack không có `pd13` thì không có cụm RabbitMQ và node dự phòng.
   - Sửa: thêm `skip: !process.env.PD13` vào khai báo test, rồi chạy với `PD13=1` trên cấu hình `ha,pd13`.
2. **Xung đột `tests/e2e.test.mjs`** sau khi #55 vào `dev`. Rebase lên `dev` và giữ phần của cả hai bên.
3. CI của PR bỏ qua job `e2e`, nên CI xanh chưa chứng minh được lỗi này đã hết. Sau khi sửa, chạy `tests/e2e.test.mjs` trên stack thường, phải bỏ qua TC60 PD-05 và không có lỗi.

## Hùng – #80 PD-08, #81 PD-04

Chất lượng tốt. Đã vào `dev` qua #85, Huynh sửa thêm lỗi tích hợp với PD-06. Không cần làm thêm về logic.

1. Không còn việc với #80 ở trạng thái draft.
2. **#80: `startDlq` trong `aggregator-service/src/dlq.js`** lặp 500 ms khi lỗi, không giãn cách, và log `DLQ cycle failed` không kèm lỗi. Nên thêm giãn cách và ghi `e.message`.
3. **Đóng #66 và #49.** Hai PR này đã được #79 và #80 thay thế, và đang xung đột.

## Hiệp – #83 PD-24

Đã vào `dev` qua #86. Huynh đã sửa các mục 2, 3 dưới đây, ghi lại để Hiệp biết.

1. Mô tả PR gần như trống. Thêm cách chạy và kết quả test theo quy tắc nhóm.
2. `ci.yml` có điều kiện `contains(github.head_ref,'PD-24')`. Điều kiện này chỉ dành cho nhánh của PR, nên bỏ trước khi merge.
3. Span `command.publish` bao cả thời gian chờ phản hồi, nên số đo publish bị sai. Tách phần chờ phản hồi thành span riêng.
4. PD-26: nhánh `feature/PD-26-jepsen-tests` dừng từ 28/10, chưa có PR. B14 đang chờ việc này.

## Trang – #58 PD-22, #62 PD-23: chưa merge

Không có commit mới từ sau nhận xét 01/11. Cả hai PR đều xung đột, các lỗi cũ chưa sửa.

1. Làm #58 trước: rebase lên `dev`, sửa TC37, thêm `ch.on('error')`, thêm timeout cho replay.
2. Sau đó rebase #62 và sửa các lỗi trong `tai-lieu/nhan-xet-thanh-vien-gd2.md`, mục Trang.

## Loan – PD-15

Chưa thấy nhánh. B12 đang chờ việc này.
