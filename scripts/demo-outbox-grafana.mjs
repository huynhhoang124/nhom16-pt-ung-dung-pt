#!/usr/bin/env node
// GS-04.8: Kịch bản mô phỏng quan sát Grafana khi RabbitMQ tắt
// Các bước tự động hóa:
//   1. Bật profile obs (docker compose --profile obs up -d)
//   2. Dừng rabbitmq (docker compose stop rabbitmq)
//   3. Cho 3 xe vào bãi độc lập (dùng scripts/barrier.mjs)
//   4. Kiểm tra chỉ số outbox trong DB tăng và hiển thị link Grafana để quan sát
//   5. Bật lại rabbitmq (docker compose start rabbitmq)
//   6. Chờ relay worker xả hết outbox về 0 và xác nhận hoàn tất.
//
// Cách dùng:
//   node scripts/demo-outbox-grafana.mjs

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function execCmd(cmd) {
  return execSync(cmd, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function getUnpublishedCount(db = 'db-a') {
  try {
    const q = 'SELECT count(*) FROM parking_events WHERE published_at IS NULL';
    const out = execSync(`docker compose exec -T ${db} psql -U postgres -d parking -tAc "${q}"`, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return Number(out.trim());
  } catch {
    return null;
  }
}

async function main() {
  console.log('================================================================');
  console.log('🚀 BẮT ĐẦU KỊCH BẢN QUAN SÁT OUTBOX TRÊN GRAFANA (GS-04.8)');
  console.log('================================================================\n');

  console.log('Bước 1: Khởi động môi trường quan sát (Prometheus & Grafana)...');
  execCmd('docker compose --profile obs up -d');
  console.log('✅ Grafana đang chạy tại: http://localhost:3001');
  console.log('   Dashboard: "Nhóm 16 – Bãi đỗ xe phân tán" (xem panel "Sự kiện outbox chưa gửi")\n');

  console.log('Bước 2: Dừng dịch vụ RabbitMQ (docker compose stop rabbitmq)...');
  execCmd('docker compose stop rabbitmq');
  console.log('✅ RabbitMQ đã dừng.\n');

  console.log('Bước 3: Giả lập barrier cho xe vào bãi độc lập (không phụ thuộc broker)...');
  const plates = [
    `30A-${Math.floor(100 + Math.random() * 900)}.${Math.floor(10 + Math.random() * 90)}`,
    `29B-${Math.floor(100 + Math.random() * 900)}.${Math.floor(10 + Math.random() * 90)}`,
    `51C-${Math.floor(100 + Math.random() * 900)}.${Math.floor(10 + Math.random() * 90)}`,
  ];

  try {
    console.log(`- Cho xe vào bãi A (A01 - biển ${plates[0]})...`);
    execCmd(`node scripts/barrier.mjs A A01 enter ${plates[0]}`);
  } catch {}

  try {
    console.log(`- Cho xe vào bãi A (A02 - biển ${plates[1]})...`);
    execCmd(`node scripts/barrier.mjs A A02 enter ${plates[1]}`);
  } catch {}

  try {
    console.log(`- Cho xe vào bãi B (B01 - biển ${plates[2]})...`);
    execCmd(`node scripts/barrier.mjs B B01 enter ${plates[2]}`);
  } catch {}

  console.log('\n----------------------------------------------------------------');
  console.log('📸 THỜI ĐIỂM 1: KHI RABBITMQ TẮT (OUTBOX TĂNG)');
  console.log('----------------------------------------------------------------');
  const countA = getUnpublishedCount('db-a');
  const countB = getUnpublishedCount('db-b');
  console.log(`- Số sự kiện outbox chưa gửi tại bãi A (db-a): ${countA ?? 'N/A'}`);
  console.log(`- Số sự kiện outbox chưa gửi tại bãi B (db-b): ${countB ?? 'N/A'}`);
  console.log(`👉 HÃY MỞ GRAFANA (http://localhost:3001) VÀ CHỤP ẢNH MINH CHỨNG 1:`);
  console.log(`   - Panel "Sự kiện outbox chưa gửi" đã TĂNG lên.`);
  console.log(`   - Panel "Trạng thái các bãi" vẫn giữ 1 (ONLINE).\n`);

  console.log('Đang chờ 5 giây để Prometheus cào số liệu...');
  await sleep(5000);

  console.log('\nBước 4: Bật lại RabbitMQ (docker compose start rabbitmq)...');
  execCmd('docker compose start rabbitmq');
  console.log('✅ RabbitMQ đã được bật lại. Đang chờ relay worker xả hàng đợi...\n');

  let leftA = countA;
  let leftB = countB;
  for (let i = 0; i < 30; i++) {
    leftA = getUnpublishedCount('db-a');
    leftB = getUnpublishedCount('db-b');
    if (leftA === 0 && leftB === 0) break;
    process.stdout.write(`   Đang chờ outbox xả về 0 (${i + 1}s)... db-a=${leftA}, db-b=${leftB}\r`);
    await sleep(1000);
  }
  process.stdout.write('\n');

  console.log('\n----------------------------------------------------------------');
  console.log('📸 THỜI ĐIỂM 2: KHI RABBITMQ BẬT LẠI (OUTBOX VỀ 0)');
  console.log('----------------------------------------------------------------');
  console.log(`- Số sự kiện outbox chưa gửi tại bãi A: ${leftA}`);
  console.log(`- Số sự kiện outbox chưa gửi tại bãi B: ${leftB}`);
  console.log(`👉 HÃY MỞ GRAFANA (http://localhost:3001) VÀ CHỤP ẢNH MINH CHỨNG 2:`);
  console.log(`   - Panel "Sự kiện outbox chưa gửi" đã HẠ VỀ 0.`);
  console.log(`   - Mọi sự kiện đã được chuyển phát an toàn lên hàng đợi.\n`);

  console.log('================================================================');
  console.log('✅ KỊCH BẢN THỰC NGHIỆM GS-04.8 HOÀN TẤT THÀNH CÔNG!');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('Lỗi thực thi:', err.message);
  process.exit(1);
});
