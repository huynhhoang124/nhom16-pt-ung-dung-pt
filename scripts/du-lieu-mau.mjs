// UX-02.7: Script sinh dữ liệu mẫu cho trang Thống kê
// Sinh vài trăm lượt xe vào rồi xe ra (exit cash) ngẫu nhiên trên cả 3 bãi (A, B, C) với biển số ngẫu nhiên.
// Gọi thẳng API node kèm header x-internal-key lấy từ .env.
// Cách chạy: node scripts/du-lieu-mau.mjs [số_lượt] (mặc định 150 lượt)
import { execSync } from 'node:child_process';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {}

const ROOT = new URL('..', import.meta.url);
const INTERNAL_KEY = process.env.INTERNAL_KEY ?? 'dev';
const AGG_PORT = process.env.AGGREGATOR_PORT ?? 8000;
const AGG = process.env.AGGREGATOR_URL || `http://localhost:${AGG_PORT}`;
const COMPOSE = process.env.SCALE === '1'
  ? 'docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile scale --profile coord'
  : 'docker compose';

const NODES = {
  A: { port: 8001, db: 'db-a', name: 'Bãi A – PTIT Hà Đông' },
  B: { port: 8002, db: 'db-b', name: 'Bãi B – Cầu Giấy' },
  C: { port: 8003, db: 'db-c', name: 'Bãi C – Hoàn Kiếm' },
  D: { port: 8004, db: 'db-d', name: 'Bãi D – miền Nam' },
  E: { port: 8005, db: 'db-e', name: 'Bãi E – miền Nam' },
  F: { port: 8006, db: 'db-f', name: 'Bãi F – miền Nam' },
};

const TOTAL_TRIPS = Number.parseInt(process.argv[2], 10) > 0 ? Number.parseInt(process.argv[2], 10) : 150;

function randomPlate() {
  const cities = ['30', '29', '51', '14', '98', '17', '18', '36', '43'];
  const letters = 'ABCDEFGHKLMNPSTUVXYZ';
  const city = cities[Math.floor(Math.random() * cities.length)];
  const letter = letters[Math.floor(Math.random() * letters.length)];
  const num1 = String(Math.floor(100 + Math.random() * 900));
  const num2 = String(Math.floor(10 + Math.random() * 90));
  return `${city}${letter}-${num1}.${num2}`;
}

async function getAvailableSlots(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/slots/available`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.map((s) => s.slotCode) : [];
  } catch {
    return [];
  }
}

async function enterSlot(port, slotCode, licensePlate) {
  const res = await fetch(`http://localhost:${port}/api/slots/${slotCode}/enter`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': INTERNAL_KEY,
    },
    body: JSON.stringify({ licensePlate }),
  });
  return res.json().catch(() => ({}));
}

async function exitSlot(port, slotCode) {
  const res = await fetch(`http://localhost:${port}/api/slots/${slotCode}/exit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': INTERNAL_KEY,
    },
    body: JSON.stringify({ cash: true }),
  });
  return res.json().catch(() => ({}));
}

function updateSessionTimes(db, sessionId, minutesAgo, durationMinutes) {
  try {
    const q = `UPDATE parking_sessions SET entered_at = now() - interval '${minutesAgo} minutes', exited_at = now() - interval '${Math.max(1, minutesAgo - durationMinutes)} minutes' WHERE id='${sessionId}'`;
    execSync(`${COMPOSE} exec -T ${db} psql -U postgres -d parking -tAc "${q}"`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {}
}

async function getAdminToken() {
  const password = process.env.DEMO_PASSWORD || '123456';
  try {
    const r = await fetch(`${AGG}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    });
    const d = await r.json();
    return d.token;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`=== UX-02.7: SINH DỮ LIỆU MẪU CHO TRANG THỐNG KÊ ===`);
  const parkingKeys = process.env.SCALE === '1' ? Object.keys(NODES) : ['A', 'B', 'C'];
  console.log(`Số lượt xe dự kiến sinh: ${TOTAL_TRIPS} lượt trên ${parkingKeys.length} bãi (${parkingKeys.join(', ')})\n`);
  let successfulTrips = 0;

  for (let i = 1; i <= TOTAL_TRIPS; i++) {
    // Chọn bãi ngẫu nhiên
    const pid = parkingKeys[Math.floor(Math.random() * parkingKeys.length)];
    const nodeInfo = NODES[pid];

    const availableSlots = await getAvailableSlots(nodeInfo.port);
    if (!availableSlots.length) continue;

    const slotCode = availableSlots[Math.floor(Math.random() * availableSlots.length)];
    const plate = randomPlate();

    // 1. Cho xe vào qua API
    const enterRes = await enterSlot(nodeInfo.port, slotCode, plate);
    const sessionId = enterRes?.session?.id;

    if (!sessionId) continue;

    // 2. Cho xe ra (exit cash) qua API
    const exitRes = await exitSlot(nodeInfo.port, slotCode);

    // 3. Phân bổ thời gian thực tế vào quá khứ (1 đến 7 ngày qua, khung giờ 7-22h)
    const daysAgo = Math.floor(Math.random() * 7);
    const hour = Math.floor(7 + Math.random() * 15); // giờ từ 7h - 22h
    const minute = Math.floor(Math.random() * 60);
    const totalMinutesAgo = daysAgo * 1440 + ((23 - hour) * 60 + (60 - minute));
    const durationMinutes = Math.floor(25 + Math.random() * 180); // đỗ từ 25p - 200p

    updateSessionTimes(nodeInfo.db, sessionId, totalMinutesAgo, durationMinutes);

    successfulTrips++;

    if (i % 25 === 0 || i === TOTAL_TRIPS) {
      process.stdout.write(`Đã sinh: ${successfulTrips}/${TOTAL_TRIPS} lượt xe vào/ra thành công...\n`);
    }
  }

  // Để lại một vài xe đang đỗ thực tế trong bãi để có trạng thái OCCUPIED
  console.log('\nĐang tạo thêm một số phiên xe đang đỗ trong bãi (OCCUPIED)...');
  for (const pid of parkingKeys) {
    const nodeInfo = NODES[pid];
    const slots = await getAvailableSlots(nodeInfo.port);
    const toPark = Math.min(3, slots.length);
    for (let k = 0; k < toPark; k++) {
      await enterSlot(nodeInfo.port, slots[k], randomPlate());
    }
    console.log(`- ${nodeInfo.name}: Đã đưa ${toPark} xe vào đỗ.`);
  }

  console.log(`\n✅ Hoàn tất sinh ${successfulTrips} phiên xe.`);

  // Đọc dữ liệu thống kê tổng hợp từ Aggregator
  console.log('\n--- Kiểm tra API thống kê của Aggregator ---');
  const token = await getAdminToken();
  if (token) {
    try {
      const res = await fetch(`${AGG}/api/admin/stats`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      console.log('Kết quả tổng hợp từ 3 bãi:');
      console.log(`- Tổng lượt xe: ${data.total?.sessions}`);
      console.log(`- Doanh thu: ${data.total?.revenue?.toLocaleString('vi-VN')} đ`);
      console.log(`- Thời gian gửi trung bình: ${data.total?.avgMinutes} phút`);
      console.log(`- Tỉ lệ lấp đầy: ${data.total?.occupied}/${data.total?.total} chỗ`);
      console.log('- Phân bố theo giờ (24h):', data.total?.byHour?.join(' '));
    } catch (e) {
      console.log('Không lấy được thống kê:', e.message);
    }
  } else {
    console.log('Đăng nhập admin không thành công, bỏ qua bước kiểm tra API tổng hợp.');
  }

  console.log('\nXem kết quả trực quan trên giao diện: http://localhost:3000 (đăng nhập: admin / 123456)');
}

main().catch((err) => {
  console.error('Lỗi thực thi:', err.message);
  process.exit(1);
});
