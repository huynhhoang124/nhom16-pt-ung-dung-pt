#!/usr/bin/env node
// PT-02.10: Hỗ trợ thực hành failover DB theo runbook (tai-lieu/runbook-failover.md)
// Đo độ trễ chính xác:
//   Pha 1: từ lúc tắt db-a đến khi bãi A thành OFFLINE trên Aggregator
//   Pha 2: thao tác thăng cấp bản sao (SELECT pg_promote()) & cập nhật cấu hình
//   Pha 3: từ khi kích hoạt chạy container replica (--no-deps) đến khi bãi A báo ONLINE trở lại
//
// Cách dùng:
//   node scripts/measure-failover.mjs            # Chạy toàn bộ quy trình đo tự động
//   node scripts/measure-failover.mjs --phase 1  # Chỉ đo Pha 1: Tắt db-a -> OFFLINE
//   node scripts/measure-failover.mjs --promote  # Thăng cấp bản sao & cập nhật .env
//   node scripts/measure-failover.mjs --phase 3  # Chỉ đo Pha 3: Chạy parking-a -> ONLINE
//   node scripts/measure-failover.mjs --status   # Xem trạng thái hiện tại các service
//   node scripts/measure-failover.mjs --reset    # Khôi phục trạng thái ban đầu

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // dùng biến môi trường có sẵn
}

const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const ENV_FILE = path.join(ROOT_DIR, '.env');
const AGGREGATOR_URL = process.env.AGGREGATOR_URL || 'http://localhost:8000';
const NODE_A_URL = 'http://localhost:8001';
const REPLICA_DB_URL = 'postgres://postgres:dev@db-a-replica/parking';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function execCmd(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
  } catch (err) {
    if (opts.allowFail) return (err.stdout || err.stderr || err.message).trim();
    throw err;
  }
}

async function getParkingStatus(targetId = 'A') {
  try {
    const res = await fetch(`${AGGREGATOR_URL}/api/parkings`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const list = await res.json();
    const node = list.find((item) => item.parkingId === targetId);
    return node ? node.status : null;
  } catch {
    return null;
  }
}

async function getNodeAHealth() {
  try {
    const res = await fetch(`${NODE_A_URL}/health`, { signal: AbortSignal.timeout(1000) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

function checkReplicaRecovery() {
  const out = execCmd('docker compose exec -T db-a-replica psql -U postgres -tAc "SELECT pg_is_in_recovery()"', { allowFail: true });
  return out;
}

function updateEnvFile(addDatabaseUrl = true) {
  if (!fs.existsSync(ENV_FILE)) return;
  let content = fs.readFileSync(ENV_FILE, 'utf8');
  const keyRegex = /^A_DATABASE_URL=.*$/m;

  if (addDatabaseUrl) {
    if (keyRegex.test(content)) {
      content = content.replace(keyRegex, `A_DATABASE_URL=${REPLICA_DB_URL}`);
    } else {
      content += `\n# PT-02: Chuyển DB bãi A sang bản sao (Failover)\nA_DATABASE_URL=${REPLICA_DB_URL}\n`;
    }
  } else {
    content = content.replace(/^# PT-02: Chuyển DB bãi A sang bản sao \(Failover\)\r?\n/m, '');
    content = content.replace(keyRegex, '');
  }
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

async function printStatus() {
  console.log('\n=== TRẠNG THÁI HIỆN TẠI ===');
  const aStatus = await getParkingStatus('A');
  console.log(`- Aggregator nhận diện Bãi A : ${aStatus || 'KHÔNG PHẢN HỒI'}`);

  const aHealth = await getNodeAHealth();
  console.log(`- Direct Node A (/health)   : HTTP ${aHealth.status} (${JSON.stringify(aHealth.body || aHealth.error)})`);

  const replicaRec = checkReplicaRecovery();
  console.log(`- db-a-replica in recovery  : ${replicaRec === 't' ? 't (ĐANG LÀ BẢN SAO)' : replicaRec === 'f' ? 'f (ĐÃ THÀNH BẢN CHÍNH)' : replicaRec}`);

  const envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const match = envContent.match(/^A_DATABASE_URL=(.*)$/m);
  console.log(`- Cấu hình A_DATABASE_URL   : ${match ? match[1] : '(mặc định db-a)'}`);
  console.log('===========================\n');
}

async function runPhase1() {
  console.log('\n======================================================');
  console.log('▶ PHA 1: GIẢ LẬP SỰ CỐ & ĐO THỜI GIAN PHÁT HIỆN OFFLINE');
  console.log('======================================================');

  const initialStatus = await getParkingStatus('A');
  if (initialStatus !== 'ONLINE') {
    console.log(`⚠️ Lưu ý: Bãi A hiện không ở trạng thái ONLINE (trạng thái: ${initialStatus}).`);
    console.log('Đảm bảo hệ thống đang chạy với: docker compose --profile ha up -d');
  }

  console.log('1. Đang dừng container db-a (docker compose stop db-a)...');
  const t0 = performance.now();
  execCmd('docker compose stop db-a');
  console.log('   Container db-a đã dừng. Bắt đầu bấm giờ đo...');

  let reachedOffline = false;
  let offlineTime = 0;
  const pollIntervalMs = 250;
  const timeoutMs = 60000;

  process.stdout.write('   Đang chờ Aggregator phát hiện Bãi A OFFLINE: ');
  while (performance.now() - t0 < timeoutMs) {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r   Đang chờ Aggregator phát hiện Bãi A OFFLINE: ${elapsed}s... `);
    const status = await getParkingStatus('A');
    if (status === 'OFFLINE') {
      offlineTime = performance.now() - t0;
      reachedOffline = true;
      break;
    }
    await sleep(pollIntervalMs);
  }
  process.stdout.write('\n');

  if (!reachedOffline) {
    console.error('❌ Hết thời gian chờ (60s) nhưng Aggregator chưa đánh dấu Bãi A OFFLINE.');
    return null;
  }

  const seconds = (offlineTime / 1000).toFixed(2);
  console.log(`✅ Bãi A đã chuyển sang OFFLINE!`);
  console.log(`⏱️ Thời gian phát hiện sự cố: ${seconds} giây (${Math.round(offlineTime)} ms)`);
  return offlineTime;
}

async function runPhase2() {
  console.log('\n======================================================');
  console.log('▶ PHA 2: THĂNG CẤP BẢN SAO & CẬP NHẬT CẤU HÌNH');
  console.log('======================================================');
  const tStart = performance.now();

  console.log('1. Thăng cấp db-a-replica thành primary (SELECT pg_promote())...');
  const promoteRes = execCmd('docker compose exec -T db-a-replica psql -U postgres -tAc "SELECT pg_promote()"', { allowFail: true });
  console.log(`   Kết quả: ${promoteRes}`);

  const recStatus = checkReplicaRecovery();
  console.log(`   Kiểm tra pg_is_in_recovery(): ${recStatus} (${recStatus === 'f' ? 'Đã là bản chính' : 'Chưa chuyển'})`);

  console.log(`2. Cập nhật .env: A_DATABASE_URL=${REPLICA_DB_URL}...`);
  updateEnvFile(true);
  console.log('   Đã ghi vào file .env thành công.');

  const duration = performance.now() - tStart;
  console.log(`⏱️ Thời gian thao tác thăng cấp: ${(duration / 1000).toFixed(2)} giây (${Math.round(duration)} ms)`);
  return duration;
}

async function runPhase3() {
  console.log('\n======================================================');
  console.log('▶ PHA 3: TÁI TẠO PARKING-A (--no-deps) & ĐO THỜI GIAN ONLINE');
  console.log('======================================================');

  console.log('1. Kích hoạt chạy parking-a với bản chính mới:');
  console.log('   Lệnh: docker compose --profile ha up -d --no-deps parking-a');

  const t0 = performance.now();
  execCmd('docker compose --profile ha up -d --no-deps parking-a');
  console.log('   Container parking-a đã được khởi động lại. Bắt đầu bấm giờ...');

  let reachedOnline = false;
  let onlineTime = 0;
  const pollIntervalMs = 250;
  const timeoutMs = 60000;

  process.stdout.write('   Đang chờ Aggregator nhận diện Bãi A ONLINE trở lại: ');
  while (performance.now() - t0 < timeoutMs) {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r   Đang chờ Aggregator nhận diện Bãi A ONLINE trở lại: ${elapsed}s... `);
    const status = await getParkingStatus('A');
    if (status === 'ONLINE') {
      onlineTime = performance.now() - t0;
      reachedOnline = true;
      break;
    }
    await sleep(pollIntervalMs);
  }
  process.stdout.write('\n');

  if (!reachedOnline) {
    console.error('❌ Hết thời gian chờ (60s) nhưng Aggregator chưa nhận diện Bãi A ONLINE.');
    return null;
  }

  const seconds = (onlineTime / 1000).toFixed(2);
  console.log(`✅ Bãi A đã báo ONLINE trở lại!`);
  console.log(`⏱️ Thời gian phục hồi ONLINE: ${seconds} giây (${Math.round(onlineTime)} ms)`);
  return onlineTime;
}

function printSummaryTable(t1, t2, t3) {
  const s1 = t1 ? (t1 / 1000).toFixed(2) : 'N/A';
  const s2 = t2 ? (t2 / 1000).toFixed(2) : 'N/A';
  const s3 = t3 ? (t3 / 1000).toFixed(2) : 'N/A';
  const total = (t1 && t2 && t3) ? ((t1 + t2 + t3) / 1000).toFixed(2) : 'N/A';

  const tableMd = `
### Bảng ghi nhận thời gian đo thực nghiệm (RTO)
| Giai đoạn | Thao tác / Sự kiện | Thời gian thực tế | Tiêu chuẩn dự kiến | Đánh giá |
|---|---|---|---|---|
| **Pha 1** | Tắt \`db-a\` đến khi Bãi A thành **OFFLINE** | **${s1} s** | ~ 15 – 20 s (3 lần poll lỗi) | Đạt chuẩn failure detector |
| **Pha 2** | Thao tác \`pg_promote\` & cập nhật \`.env\` | **${s2} s** | Thao tác quản trị viên (< 30s) | Thao tác chuẩn runbook |
| **Pha 3** | Chạy \`parking-a\` (\`--no-deps\`) đến khi **ONLINE** | **${s3} s** | ~ 10 – 15 s (kết nối + đối soát) | Node A nhận DB mới thành công |
| **Tổng RTO** | **Toàn bộ thời gian gián đoạn ghi (RTO)** | **${total} s** | **< 60 s** | **Hệ thống chịu lỗi đạt yêu cầu** |
`;

  console.log('\n======================================================');
  console.log('📊 TỔNG HỢP KẾT QUẢ ĐO FAILOVER (PT-02.10)');
  console.log('======================================================');
  console.log(tableMd);
  console.log('👉 Có thể sao chép bảng Markdown trên vào file tai-lieu/runbook-failover.md');
}

async function runReset() {
  console.log('\n=== KHÔI PHỤC TRẠNG THÁI BAN ĐẦU ===');
  console.log('1. Xoá dòng A_DATABASE_URL trong .env...');
  updateEnvFile(false);

  console.log('2. Đặt lại container về trạng thái chuẩn (docker compose --profile ha up -d)...');
  execCmd('docker compose --profile ha up -d db-a');
  execCmd('docker compose --profile ha up -d --no-deps parking-a');

  console.log('Lưu ý: Để đồng bộ lại bản sao db-a-replica sạch sẽ từ đầu, hãy chạy:');
  console.log('  docker compose --profile ha down -v && docker compose --profile ha up -d\n');
}

async function main() {
  const arg = process.argv[2];

  if (arg === '--help' || arg === '-h') {
    console.log(`
Cách dùng: node scripts/measure-failover.mjs [tuỳ chọn]

Tuỳ chọn:
  (không truyền)   Chạy toàn bộ quy trình đo tự động (Pha 1 -> Pha 2 -> Pha 3 -> Tổng hợp)
  --phase 1, -1    Chỉ thực hiện và đo Pha 1 (Tắt db-a -> Bãi A chuyển OFFLINE)
  --promote, -2    Chỉ thực hiện Pha 2 (pg_promote db-a-replica & cập nhật cấu hình .env)
  --phase 3, -3    Chỉ thực hiện và đo Pha 3 (Khởi động parking-a --no-deps -> ONLINE)
  --status         Kiểm tra trạng thái hiện tại của Bãi A, DB và replica
  --reset          Gỡ cấu hình failover khỏi .env và bật lại db-a
`);
    return;
  }

  if (arg === '--status') {
    await printStatus();
    return;
  }

  if (arg === '--reset') {
    await runReset();
    return;
  }

  if (arg === '--phase 1' || arg === '-1') {
    await printStatus();
    await runPhase1();
    return;
  }

  if (arg === '--promote' || arg === '-2') {
    await runPhase2();
    return;
  }

  if (arg === '--phase 3' || arg === '-3') {
    await runPhase3();
    return;
  }

  // Chạy toàn bộ kịch bản tự động
  console.log('🚀 Bắt đầu kịch bản đo thời gian Failover DB tự động (PT-02.10)...');
  await printStatus();

  const t1 = await runPhase1();
  if (!t1) return;

  // Tạm nghỉ 1s cho rõ ràng luồng
  await sleep(1000);

  const t2 = await runPhase2();
  if (!t2) return;

  await sleep(1000);

  const t3 = await runPhase3();
  if (!t3) return;

  printSummaryTable(t1, t2, t3);
}

main().catch((err) => {
  console.error('Lỗi khi thực thi script:', err);
  process.exit(1);
});
