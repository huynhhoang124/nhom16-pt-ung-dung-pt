// PT-02.6: Đo độ trễ bản sao DB (TC50)
// Lặp 100 lần: ghi 1 dòng vào db-a, đo thời gian đến khi đọc được ở db-a-replica
// bằng cách dùng lệnh docker compose exec -T ... psql (tham khảo tests/load/check-invariants.mjs).
// Tính toán và in ra màn hình thời gian trung bình (avg) và p95 (đơn vị ms).
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const ROOT = new URL('..', import.meta.url);
const sql = (db, q) =>
  execSync(`docker compose exec -T ${db} psql -U postgres -d parking -tAc "${q.replace(/"/g, '\\"')}"`, {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ITERATIONS = 100;
const TABLE = '_replication_lag_bench';

async function main() {
  console.log('=== PT-02.6: ĐO ĐỘ TRỄ BẢN SAO DB (TC50) ===');
  console.log(`Kiểm tra kết nối và trạng thái bản sao...`);

  const primaryStatus = sql('db-a', 'SELECT pg_is_in_recovery()');
  const replicaStatus = sql('db-a-replica', 'SELECT pg_is_in_recovery()');

  if (primaryStatus !== 'f') {
    console.error('LỖI: db-a không phải là bản chính (pg_is_in_recovery != f)');
    process.exit(1);
  }
  if (replicaStatus !== 't') {
    console.error('LỖI: db-a-replica không phải là bản sao (pg_is_in_recovery != t)');
    process.exit(1);
  }

  console.log(`- db-a (Primary): OK (pg_is_in_recovery = f)`);
  console.log(`- db-a-replica (Standby): OK (pg_is_in_recovery = t)`);

  // Chuẩn bị bảng đo
  sql('db-a', `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT clock_timestamp())`);

  // Đợi bảng được replicate sang replica
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      sql('db-a-replica', `SELECT count(*) FROM ${TABLE}`);
      break;
    } catch {
      await sleep(200);
    }
  }

  const cleanup = () => {
    try {
      sql('db-a', `DROP TABLE IF EXISTS ${TABLE}`);
    } catch {}
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  const latencies = [];
  console.log(`\nBắt đầu đo ${ITERATIONS} lần lặp (ghi db-a -> đọc db-a-replica)...`);

  for (let i = 1; i <= ITERATIONS; i++) {
    const key = `k_${i}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const start = performance.now();

    // 1. Ghi 1 dòng vào db-a
    sql('db-a', `INSERT INTO ${TABLE} (id) VALUES ('${key}')`);

    // 2. Đo thời gian đến khi đọc được ở db-a-replica
    for (;;) {
      const found = sql('db-a-replica', `SELECT 1 FROM ${TABLE} WHERE id='${key}'`);
      if (found === '1') break;
      await sleep(2);
    }

    const elapsed = performance.now() - start;
    latencies.push(elapsed);

    if (i % 10 === 0 || i === ITERATIONS) {
      process.stdout.write(`Đã đo: ${i}/${ITERATIONS} lượt... (mới nhất: ${elapsed.toFixed(1)} ms)\n`);
    }
  }

  cleanup();

  // Tính toán số liệu
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avg = sum / latencies.length;
  const min = latencies[0];
  const max = latencies[latencies.length - 1];
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p90 = latencies[Math.floor(latencies.length * 0.9)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  console.log('\n================ KẾT QUẢ ĐO ĐỘ TRỄ BẢN SAO ================');
  console.log(`Số mẫu đo:             ${latencies.length}`);
  console.log(`Thời gian nhỏ nhất:    ${min.toFixed(2)} ms`);
  console.log(`Thời gian trung bình:  ${avg.toFixed(2)} ms (avg)`);
  console.log(`Phân vị 50 (Median):   ${p50.toFixed(2)} ms`);
  console.log(`Phân vị 90 (p90):      ${p90.toFixed(2)} ms`);
  console.log(`Phân vị 95 (p95):      ${p95.toFixed(2)} ms (p95)`);
  console.log(`Phân vị 99 (p99):      ${p99.toFixed(2)} ms`);
  console.log(`Thời gian lớn nhất:    ${max.toFixed(2)} ms`);
  console.log('===========================================================');
  console.log(`\n=> KẾT LUẬN: Độ trễ bản sao trung bình: ${avg.toFixed(2)} ms, p95: ${p95.toFixed(2)} ms.`);
}

main().catch((err) => {
  console.error('Lỗi thực thi:', err.message);
  process.exit(1);
});
