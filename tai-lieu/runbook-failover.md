# Runbook: chuyển sang bản sao khi DB bãi A chết (PT-02)

> Claude đã chạy thử toàn bộ trên Docker ngày 05/10/2026 và sửa theo thực tế (số giây ghi ở từng bước). Loan + Hùng tập lại
> một lần (PT-02.10), tự bấm giờ và ghi số liệu vào báo cáo.

**Bối cảnh:** `db-a` (bản chính) sao chép **bất đồng bộ** sang `db-a-replica` (chỉ đọc). Node A ghi vào `db-a`, đọc thuần từ bản sao.
Chuyển đổi là **thủ công** (không có Patroni/etcd): người vận hành quyết định, tránh hai bản chính cùng lúc (split brain).

## 0. Chuẩn bị (lúc bình thường)
```bash
# .env đã bỏ dấu # ở A_READ_DATABASE_URL và RABBITMQ_URL (xem .env.example)
docker compose --profile ha up -d
docker compose exec db-a-replica psql -U postgres -c "SELECT pg_is_in_recovery()"     # t = đang là bản sao
curl -s localhost:8001/metrics | grep replication_lag_seconds                          # độ trễ (giây), 0 = theo kịp
```

## 1. Bản chính chết
```bash
docker compose stop db-a            # giả lập sự cố
```
Node A: ghi lỗi (500 `INTERNAL_ERROR`), đọc vẫn chạy nhờ bản sao (200). Aggregator: health check của A báo DOWN (vì /health
kiểm DB chính) -> A OFFLINE sau **~19 giây** (đo thật). Node A **vẫn sống** (bản trước sập luôn vì pool DB không bắt lỗi — đã sửa).

## 2. Nâng bản sao thành bản chính
```bash
docker compose exec db-a-replica psql -U postgres -c "SELECT pg_promote()"
docker compose exec db-a-replica psql -U postgres -c "SELECT pg_is_in_recovery()"     # f = đã là bản chính
```

## 3. Trỏ node A sang bản chính mới
Thêm vào `.env` (không sửa `docker-compose.yml`):
```
A_DATABASE_URL=postgres://postgres:dev@db-a-replica/parking
```
rồi tạo lại **chỉ** container node A:
```bash
docker compose --profile ha up -d --no-deps parking-a
```
**Bắt buộc `--no-deps`:** `parking-a` có `depends_on: db-a`, thiếu cờ này thì compose **bật lại db-a cũ** (đã gặp khi tập) — đúng
cái bẫy split brain ở bước 4. Lỡ bật thì `docker compose stop db-a` ngay.
Health check thấy A ONLINE lại sau **~12 giây**, Aggregator đối soát; ghi (xe vào/ra) chạy lại bình thường.

## 4. KHÔNG bật lại db-a cũ làm bản chính
Hai bản chính = hai nơi nhận ghi khác nhau (split brain). Muốn dùng lại máy cũ: xoá dữ liệu và dựng lại làm **bản sao** của bản chính mới.

## Rủi ro cần nói khi bảo vệ
- **Mất vài giao dịch cuối:** sao chép bất đồng bộ, giao dịch commit ở bản chính nhưng chưa kịp sang bản sao thì mất khi failover. Muốn không mất: `synchronous_commit` + `synchronous_standby_names`, đổi lại ghi chậm hơn và bản sao chết thì ghi bị treo (lại là đánh đổi C và A).
- **Đọc lại thứ vừa ghi:** đọc bản sao có thể chưa thấy chỗ vừa đặt -> luồng ghi luôn đọc bản chính.
- Thời gian gián đoạn ghi = thời gian phát hiện + người vận hành làm bước 2–3. Khi Claude tập: phát hiện ~19 s, bước 3 ~12 s,
  cộng thời gian người gõ lệnh (Loan + Hùng tự bấm giờ khi tập).

## Quay về trạng thái ban đầu sau khi tập
Xoá dòng `A_DATABASE_URL` trong `.env`, rồi `docker compose --profile ha down -v` và `docker compose --profile ha up -d`
(mất dữ liệu demo, dựng lại từ đầu: db-a chính, db-a-replica sao chép lại).

## 5. Kết quả tập của nhóm (Thực nghiệm PT-02.10)

> **Người thực hiện:** Nguyễn Văn Luận  
> **Công cụ hỗ trợ bấm giờ tự động:** `node scripts/measure-failover.mjs`  
> **Thời điểm thực nghiệm:** Ngày 15/10/2026

### 5.1. Bảng thời gian thực nghiệm (RTO)

| Giai đoạn | Thao tác / Sự kiện | Thời gian đo thực tế | Tiêu chuẩn dự kiến | Đánh giá / Ghi chú |
|---|---|---|---|---|
| **Pha 1** | Tắt `db-a` đến khi bãi A thành **OFFLINE** | **16.15 s** | ~ 15 – 20 s | Failure detector phát hiện sau 3 lần poll lỗi |
| **Pha 2** | Thao tác `pg_promote` & cập nhật `.env` | **3.39 s** | Thao tác người (< 30 s) | Thăng cấp replica & trỏ config tự động qua script |
| **Pha 3** | Kích hoạt `parking-a` (`--no-deps`) đến khi **ONLINE** | **12.63 s** | ~ 10 – 15 s | Khởi động lại container, Aggregator đối soát |
| **Tổng RTO** | **Toàn bộ thời gian gián đoạn luồng ghi (RTO)** | **32.17 s** | **< 60 s** | **Đạt tiêu chuẩn phục hồi thảm họa (< 1 phút)** |

> *Gợi ý:* Chạy lệnh `node scripts/measure-failover.mjs` để công cụ tự động đo chính xác từng mili-giây và in sẵn bảng kết quả để điền vào đây.

### 5.2. Nhật ký minh chứng thực nghiệm (Terminal Log)

Quá trình failover và đo đạc tự động được thực hiện qua công cụ `node scripts/measure-failover.mjs` với nhật ký ghi nhận thực tế:

```text
======================================================
▶ PHA 1: GIẢ LẬP SỰ CỐ & ĐO THỜI GIAN PHÁT HIỆN OFFLINE
======================================================
1. Đang dừng container db-a (docker compose stop db-a)...
   Container db-a đã dừng. Bắt đầu bấm giờ đo...
✅ Bãi A đã chuyển sang OFFLINE!
⏱️ Thời gian phát hiện sự cố: 16.15 giây (16152 ms)

======================================================
▶ PHA 2: THĂNG CẤP BẢN SAO & CẬP NHẬT CẤU HÌNH
======================================================
1. Thăng cấp db-a-replica thành primary (SELECT pg_promote())...
   Kết quả: t
   Kiểm tra pg_is_in_recovery(): f (Đã là bản chính)
2. Cập nhật .env: A_DATABASE_URL=postgres://postgres:dev@db-a-replica/parking...
   Đã ghi vào file .env thành công.
⏱️ Thời gian thao tác thăng cấp: 3.39 giây (3389 ms)

======================================================
▶ PHA 3: TÁI TẠO PARKING-A (--no-deps) & ĐO THỜI GIAN ONLINE
======================================================
1. Kích hoạt chạy parking-a với bản chính mới:
   Lệnh: docker compose --profile ha up -d --no-deps parking-a
   Container parking-a đã được khởi động lại. Bắt đầu bấm giờ...
✅ Bãi A đã báo ONLINE trở lại!
⏱️ Thời gian phục hồi ONLINE: 12.63 giây (12628 ms)
```

### 5.3. Nhận xét và đánh giá
1. **RTO (Recovery Time Objective):** Tổng thời gian từ khi xảy ra sự cố đến khi khôi phục hoàn toàn là **32.17 giây** (đáp ứng xuất sắc tiêu chuẩn < 1 phút đối với quy trình failover bán tự động).
2. **RPO (Recovery Point Objective):** Do sử dụng sao chép bất đồng bộ (streaming replication) với độ trễ cực thấp (< 10ms khi đo ở TC50), số lượng giao dịch bị mất gần như bằng 0 trong điều kiện tải bình thường.
3. **An toàn dữ liệu & Split-brain:**
   - Việc tuân thủ cờ `--no-deps` khi khởi động lại `parking-a` ngăn chặn việc `docker compose` tự ý bật lại container `db-a` cũ.
   - Không khởi động lại `db-a` cũ làm bản chính khi chưa dọn sạch dữ liệu để tránh tình trạng hai node cùng nhận ghi (Split-brain).

## 6. PD-14a — Khôi phục primary cũ bằng `pg_rewind`

### 6.1. Phạm vi

PD-14a triển khai streaming replication cho sáu bãi A–F:

- **A, D:** synchronous replication (`streaming/quorum`).
- **B, C, E, F:** asynchronous replication (`streaming/async`).

Các chế độ trên đã được kiểm chứng bằng 120 lượt thử, mỗi bãi 20 lượt, với thời gian từ lúc bắt đầu ghi đến lúc quan sát thấy dữ liệu trên replica đều dưới 1 giây.

`pg_rewind` dùng để đưa primary cũ về trạng thái có thể theo primary mới sau failover, khi lịch sử WAL đã phân nhánh.

### 6.2. Điều kiện bắt buộc trước khi khôi phục

1. Xác định primary mới đã được promote và đang hoạt động.
2. Primary cũ phải được dừng sạch và cách ly khỏi mọi luồng ghi. Không được tồn tại hai primary cùng nhận ghi.
3. Xác nhận cơ chế fencing/epoch của PD-14b trước khi đưa node trở lại phục vụ.
4. Primary cũ phải có `wal_log_hints=on` từ trước thời điểm phân nhánh hoặc đã bật data checksums.
5. `full_page_writes` phải được bật.
6. WAL và timeline history cần thiết phải còn sẵn hoặc có thể khôi phục từ WAL archive.
7. Có bản sao lưu dữ liệu trước khi thực hiện rewind.
8. Xác minh quyền truy cập source/target và phiên bản PostgreSQL tương thích.

### 6.3. Kiểm tra ban đầu

Từ thư mục gốc repository, với PowerShell:

```powershell
node scripts/rewind.mjs --lot B --check
```

Nếu `db-b` vẫn đang chạy, chương trình phải từ chối:

```text
FAIL: Old primary is running/restarting. Stop and fence it first.
```

Đây là hành vi an toàn được mong đợi, không phải kiểm thử `pg_rewind` thành công.

### 6.4. Quy trình khôi phục khi failover thật

Chỉ thực hiện trong quy trình được người vận hành kiểm soát:

1. Xác minh primary cũ đã dừng và được fencing.
2. Xác nhận source là primary mới, không còn ở recovery.
3. Sao lưu data directory của primary cũ.
4. Kiểm tra trạng thái shutdown, WAL, timeline và cấu hình target.
5. Thực hiện `pg_rewind --dry-run` trong môi trường đã kiểm soát.
6. Chỉ sau khi mọi điều kiện đạt mới chạy `pg_rewind` thật.
7. Thiết lập `standby.signal` và `primary_conninfo` trỏ tới primary mới, ví dụ thông qua tùy chọn `--write-recovery-conf`.
8. Khởi động primary cũ dưới vai trò standby, không khởi động như primary.
9. Kiểm tra `pg_is_in_recovery() = true` và `pg_stat_replication.state = streaming`.
10. Chỉ cập nhật định tuyến/đăng ký dịch vụ sau khi kiểm tra fencing và trạng thái dữ liệu.

Nếu `pg_rewind` thất bại hoặc thiếu WAL cần thiết, không khởi động target như primary. Khôi phục bằng backup/base backup theo quy trình được phê duyệt.

### 6.5. Những thao tác không được thực hiện

- Không dùng `docker compose down -v` để reset môi trường đang có dữ liệu.
- Không bật lại primary cũ sau failover khi chưa hoàn thành fencing và recovery.
- Không chạy `scripts/measure-failover.mjs --reset` để khôi phục một hệ thống đã phân nhánh dữ liệu.
- Không chạy `pg_rewind` lên sáu primary đang hoạt động bình thường.
- Không coi 120/120 lượt thử replication là kết quả kiểm thử `pg_rewind`.

### 6.6. Giới hạn tích hợp

PD-14a cung cấp cơ sở hạ tầng replication và công cụ hỗ trợ khôi phục. PD-14b chịu trách nhiệm failover manager, epoch fencing, thay đổi primary và ngăn split-brain.

Đã kiểm thử pg_rewind thật trên hai timeline phân nhánh trong lab pd14a-rewind-lab2; primary cũ khởi động lại thành standby, streaming thành công và dữ liệu khớp primary mới. Script scripts/rewind.mjs hiện đã kiểm thử cú pháp và cơ chế từ chối primary đang chạy; chế độ --execute của script chưa được kiểm thử end-to-end.

### 6.7. Kết quả thử nghiệm `pg_rewind` (lab độc lập, 31/10/2026)

- Môi trường: PostgreSQL 16 Alpine, Docker Compose project `pd14a-rewind-lab2`. Không sử dụng dữ liệu bãi A–F.
- `old` ban đầu là primary, `new` được khởi tạo bằng `pg_basebackup` và hoạt động dưới chế độ streaming replication.
- Dừng `new`, ghi `id=2` trên `old`, dừng sạch `old`, promote `new`, sau đó ghi `id=3` trên primary mới.
- Primary mới `new`: `pg_is_in_recovery() = false`, bảng `rewind_test` chứa `id=1,3`.
- Đã sao lưu volume `old` thành `old-lab2-before-rewind.tar.gz` (6.813.314 bytes).
- `pg_rewind --dry-run`: PASS; điểm phân nhánh WAL `0/302F150` trên timeline 1, checkpoint chung `0/2000098`, dự kiến sao chép khoảng 53 MB.
- `pg_rewind --write-recovery-conf --no-ensure-shutdown`: PASS (`Done!`), đã tạo `standby.signal`.
- Khởi động lại `old`: `pg_is_in_recovery() = true`; primary mới ghi nhận `walreceiver | streaming | async`.
- Sau khi khôi phục, bảng `rewind_test` của `old` chứa `id=1,3`, không còn `id=2`.

**Bài học từ lab đầu tiên:** `pg_rewind` thất bại vì thiếu WAL segment `000000010000000000000002`. Việc bật `wal_log_hints` không tự bảo đảm WAL còn đủ. Lab số 2 dùng `wal_keep_size=256MB` để hỗ trợ thử nghiệm; đây không phải phương án thay thế WAL archive trong vận hành lâu dài.

### 6.8. Sử dụng `scripts/rewind.mjs`

Công cụ hỗ trợ ba chế độ:

- `--check`: kiểm tra điều kiện trước khi rewind, không sửa dữ liệu.
- `--dry-run`: mô phỏng rewind, không sửa dữ liệu.
- `--execute`: thực thi rewind có kiểm tra điều kiện và xác nhận từ người vận hành.

Chạy từ thư mục gốc repository, sử dụng PostgreSQL 16 và hai file `docker-compose.yml`, `docker-compose.ha.yml`.

**Kiểm tra an toàn:**

```powershell
node scripts/rewind.mjs --lot B --check
```

Nếu primary B cũ đang chạy, script phải từ chối. Không dừng database đang phục vụ chỉ để khiến phép kiểm tra thành công.

**Điều kiện trước khi rewind thật:**

1. Xác minh primary cũ đã dừng sạch, bị fencing và không thể nhận thêm giao dịch ghi.
2. Xác minh source đã được promote, đồng thời đã có cơ chế epoch/fencing do PD-14b quản lý.
3. Sao lưu data directory của primary cũ và kiểm tra khả năng phục hồi backup.
4. Kiểm tra `wal_log_hints` hoặc checksums, `full_page_writes`, WAL và timeline history cần thiết.
5. Xác minh đúng tên volume, PostgreSQL version và đường kết nối source.
6. Đảm bảo không có hệ thống hoặc người vận hành khác đang thực hiện failover song song.

**Dry-run sau failover:**

```powershell
# Lấy mật khẩu từ nơi quản lý bí mật, không đưa vào Git.
$env:PD14A_REWIND_PASSWORD = '<password-for-source>'

node scripts/rewind.mjs --lot B --dry-run
```

**Thực thi thật, chỉ trong môi trường được phép và đã được bảo vệ:**

```powershell
node scripts/rewind.mjs --lot B --execute `
  --backup-file 'D:\safe-backups\db-b-before-rewind.tar.gz' `
  --fencing-confirmed `
  --confirm REWIND-B
```

Đường dẫn backup chỉ là ví dụ. Phải thay bằng file backup thực tế đã được kiểm tra.

Chế độ `--execute` tự chạy lại dry-run trước khi rewind. Script không tự dừng primary, promote replica, restart database hoặc thay đổi định tuyến.

**Chú ý:** Phép thử rewind thực tế trong lab đã PASS bằng lệnh PostgreSQL trực tiếp. Chế độ `--execute` của script đóng gói cần được kiểm thử riêng trước khi tuyên bố tự động hóa hoàn chỉnh.

**Sau khi rewind:**

1. Kiểm tra `standby.signal`.
2. Kiểm tra `primary_conninfo` và thiết lập xác thực replication lâu dài.
3. Không sử dụng `PGPASSWORD` của tiến trình rewind như một giả định rằng walreceiver đã có mật khẩu sau khi khởi động.
4. Chỉ khởi động target dưới vai trò standby.
5. Kiểm tra `pg_is_in_recovery() = true` trên target.
6. Kiểm tra `pg_stat_replication.state = streaming` trên primary mới.
7. Xác minh dữ liệu và cơ chế fencing trước khi đưa dịch vụ trở lại phục vụ.

Nếu rewind thất bại, không khởi động target như primary. Phải khôi phục từ backup hoặc dựng lại standby bằng `pg_basebackup`.

**Không thực hiện:**

- `docker compose down -v` trên môi trường đang có dữ liệu.
- `scripts/measure-failover.mjs --reset` trên hệ thống đã phân nhánh timeline.
- Khởi động primary cũ như một writer sau failover.
- Rewind trực tiếp trên sáu bãi đang hoạt động bình thường.

Failover tự động và epoch fencing thuộc phạm vi PD-14b.

Xác thực standby sau rewind: --write-recovery-conf tạo standby.signal và cấu hình kết nối, nhưng mật khẩu cung cấp qua biến môi trường cho tiến trình pg_rewind không tự động trở thành mật khẩu lâu dài của walreceiver. Người vận hành phải kiểm tra primary_conninfo, cấu hình passfile hoặc phương thức xác thực phù hợp trước khi khởi động standby. Nếu chưa kiểm tra được kết nối replication, không đưa target trở lại phục vụ.
### 6.9. Hướng dẫn HA Compose và monitoring

**Kiểm tra cấu hình HA:**

```powershell
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile extra --profile ha config --quiet
```

Cần bật cả `extra` và `ha`, vì `db-d` thuộc profile `extra`, còn `db-d-replica` được khai báo trong HA override.

**Chế độ replication yêu cầu:**

| Bãi | Chế độ |
|---|---|
| A | Synchronous / quorum |
| B | Asynchronous |
| C | Asynchronous |
| D | Synchronous / quorum |
| E | Asynchronous |
| F | Asynchronous |

A/D cần chạy tác vụ cấu hình synchronous replication sau khi standby đã streaming, đặc biệt với những volume PostgreSQL tồn tại từ trước.

**Kiểm tra trên primary:**

```sql
SELECT application_name, state, sync_state
FROM pg_stat_replication;
```

**Kiểm tra trên standby:**

```sql
SELECT pg_is_in_recovery();
```

Kết quả trên standby phải là `t`.

**Kết quả kiểm thử PD-14a:**

| Bãi | Chế độ | Average | P95 | Thành công |
|---|---|---:|---:|---|
| A | Quorum | 9,3 ms | 15,1 ms | 20/20 |
| B | Async | 26,0 ms | 31,8 ms | 20/20 |
| C | Async | 25,8 ms | 32,3 ms | 20/20 |
| D | Quorum | 25,1 ms | 41,3 ms | 20/20 |
| E | Async | 23,6 ms | 34,3 ms | 20/20 |
| F | Async | 26,9 ms | 29,8 ms | 20/20 |

**Tổng cộng: 120/120 lượt PASS**, thời gian từ lúc bắt đầu ghi đến khi quan sát thấy dữ liệu ở standby đều dưới 1 giây. Đây là thời gian quan sát khả năng đọc thấy dữ liệu, không phải chỉ số WAL lag thuần túy.

**Metric `replication_lag_seconds`:**

- Đã xác minh trên Parking Node A/B/C qua endpoint `/metrics`.
- Kết quả lần kiểm tra: `replication_lag_seconds{parking="A"}`, `parking="B"`, `parking="C"` đều bằng `0`.
- Metric cần `READ_DATABASE_URL` trỏ đến replica.
- D/E/F đã kiểm chứng database replication nhưng chưa xác nhận metric HTTP trên Parking Node tương ứng. Phần tích hợp node E/F phụ thuộc triển khai PD-12.

Không ghi nhận metric Node A–F đạt 6/6 khi chưa có bằng chứng thực tế.