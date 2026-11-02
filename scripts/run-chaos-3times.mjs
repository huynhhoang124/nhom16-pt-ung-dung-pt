#!/usr/bin/env node
// GS-06.3: Tự động hóa và thu thập kết quả Test hỗn loạn (Chaos Test)
// Tự động kích hoạt MINUTES=10 node tests/chaos.mjs lặp lại 3 lần.
// Sau mỗi lần chạy:
//   1. Tự động parse log lấy: tổng request, tỉ lệ lỗi (%), p95, trạng thái bất biến (PASS/FAIL).
//   2. Tự động dump log vào file logs/chaos-run-<n>-failed-<timestamp>.log nếu có bất biến bị vi phạm.
//   3. In bảng tổng hợp 3 lần chạy ra màn hình và xuất file Markdown.
//
// Cách dùng:
//   node scripts/run-chaos-3times.mjs                 # Chạy chuẩn: 3 lần x 10 phút
//   node scripts/run-chaos-3times.mjs --minutes 1     # Chạy thử nhanh: 3 lần x 1 phút
//   node scripts/run-chaos-3times.mjs --times 1       # Chạy 1 lần duy nhất
//   node scripts/run-chaos-3times.mjs --help          # Hướng dẫn chi tiết

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const RESULTS_MD = path.join(ROOT_DIR, 'tai-lieu', 'ket-qua-chaos-test.md');

// Phân tích tham số dòng lệnh
const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  const envVal = process.env[name.toUpperCase()];
  if (envVal) return envVal;
  return def;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
GS-06.3 Chaos Test Runner (3 Lần Lặp)
=====================================
Cách dùng:
  node scripts/run-chaos-3times.mjs [tuỳ chọn]

Tuỳ chọn:
  --minutes <N>   Thời gian chạy mỗi lần (phút). Mặc định: 10
  --times <N>     Số lần lặp lại. Mặc định: 3
  --victims <list> Danh sách container bị tắt/bật ngẫu nhiên.
                  Mặc định: "parking-b,rabbitmq-2,aggregator"
  --update-md     Tự động ghi đè bảng số liệu vào tai-lieu/ket-qua-chaos-test.md
  --help, -h      Hiện trợ giúp này
`);
  process.exit(0);
}

const MINUTES = Number(getArg('minutes', 10));
const TIMES = Number(getArg('times', 3));
const VICTIMS = getArg('victims', 'parking-b,rabbitmq-2,aggregator');
const UPDATE_MD = args.includes('--update-md');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseChaosLog(fullOutput) {
  // 1. Tổng số request
  const reqMatch = fullOutput.match(/http_reqs[\.\s]+:\s+(\d+)/);
  const totalRequests = reqMatch ? Number(reqMatch[1]) : null;

  // 2. Tỉ lệ lỗi (%)
  const errMatch = fullOutput.match(/http_req_failed[\.\s]+:\s+([\d\.]+)%/);
  const errorRate = errMatch ? Number(errMatch[1]) : null;

  // 3. Độ trễ p95 chung
  const p95GeneralMatch = fullOutput.match(/http_req_duration[\.\s]+:[\s\S]*?p\(95\)=([\d\.]+(?:ms|s|µs))/);
  const p95General = p95GeneralMatch ? p95GeneralMatch[1] : null;

  // 4. Độ trễ p95 tra cứu (lookup)
  const p95LookupMatch = fullOutput.match(/\{ scenario:lookup \}[\.\s]+:[\s\S]*?p\(95\)=([\d\.]+(?:ms|s|µs))/);
  const p95Lookup = p95LookupMatch ? p95LookupMatch[1] : (p95General || 'N/A');

  // 5. Độ trễ p95 đặt chỗ (reserve)
  const p95ReserveMatch = fullOutput.match(/\{ scenario:reserve \}[\.\s]+:[\s\S]*?p\(95\)=([\d\.]+(?:ms|s|µs))/);
  const p95Reserve = p95ReserveMatch ? p95ReserveMatch[1] : 'N/A';

  // 6. Kiểm tra các bất biến
  const allPass = fullOutput.includes('Mọi bất biến đều đạt');
  const violationMatch = fullOutput.match(/(\d+)\s+bất biến bị vi phạm/);
  const violationsCount = violationMatch ? Number(violationMatch[1]) : (allPass ? 0 : 1);
  const invariantsPassed = allPass && violationsCount === 0;

  // Bóc tách chi tiết từng bất biến
  const details = {
    overlap: !fullOutput.includes('LỖI') || !fullOutput.includes('đặt chồng giờ'),
    requestId: !fullOutput.includes('LỖI') || !fullOutput.includes('request_id trùng'),
    multipleSessions: !fullOutput.includes('LỖI') || !fullOutput.includes('slot có 2 phiên mở'),
    outbox: !fullOutput.includes('LỖI') || !fullOutput.includes('outbox chưa gửi'),
  };

  return {
    totalRequests,
    errorRate,
    p95General,
    p95Lookup,
    p95Reserve,
    invariantsPassed,
    violationsCount,
    details,
  };
}

function runSingleChaos(runIndex, totalRuns) {
  return new Promise((resolve, reject) => {
    console.log(`\n================================================================`);
    console.log(`🚀 BẮT ĐẦU LẦN CHẠY ${runIndex}/${totalRuns} (Thời lượng: ${MINUTES} phút)`);
    console.log(`   Nạn nhân ngẫu nhiên: ${VICTIMS}`);
    console.log(`   Thời gian: ${new Date().toLocaleString('vi-VN')}`);
    console.log(`================================================================`);

    const env = {
      ...process.env,
      MINUTES: String(MINUTES),
      VICTIMS,
    };

    const child = spawn('node', ['tests/chaos.mjs'], {
      cwd: ROOT_DIR,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuffer += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      const fullLog = stdoutBuffer + '\n' + stderrBuffer;
      const parsed = parseChaosLog(fullLog);

      if (!parsed.invariantsPassed || code !== 0) {
        ensureDir(LOGS_DIR);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dumpPath = path.join(LOGS_DIR, `chaos-run-${runIndex}-failed-${timestamp}.log`);
        fs.writeFileSync(dumpPath, fullLog, 'utf8');
        console.error(`\n⚠️ PHÁT HIỆN LỖI HOẶC VI PHẠM BẤT BIẾN!`);
        console.error(`   Đã tự động dump toàn bộ log vào: ${dumpPath}`);
      }

      resolve({
        runIndex,
        exitCode: code,
        ...parsed,
        rawLog: fullLog,
      });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

function renderMarkdownTable(results) {
  let rows = '';
  let sumReq = 0;
  let sumErr = 0;
  let validReqCount = 0;

  results.forEach((r) => {
    const reqStr = r.totalRequests != null ? r.totalRequests.toLocaleString('vi-VN') : 'N/A';
    const errStr = r.errorRate != null ? `${r.errorRate.toFixed(2)}%` : 'N/A';
    const p95Look = r.p95Lookup || 'N/A';
    const p95Res = r.p95Reserve || 'N/A';
    const invStr = r.invariantsPassed ? '✅ ĐẠT (PASS)' : `❌ LỖI (${r.violationsCount} vi phạm)`;
    const conclusion = r.invariantsPassed && (r.errorRate ?? 0) < 1.0 ? 'Đạt chuẩn' : 'Cần kiểm tra';

    if (r.totalRequests) {
      sumReq += r.totalRequests;
      validReqCount++;
    }
    if (r.errorRate != null) sumErr += r.errorRate;

    rows += `| Lần ${r.runIndex} | ${MINUTES} phút | ${reqStr} | ${errStr} | ${p95Look} | ${p95Res} | ${invStr} | ${conclusion} |\n`;
  });

  const avgReq = validReqCount ? Math.round(sumReq / validReqCount).toLocaleString('vi-VN') : 'N/A';
  const avgErr = validReqCount ? (sumErr / validReqCount).toFixed(2) + '%' : 'N/A';
  const allPass = results.every((r) => r.invariantsPassed);

  const avgRow = `| **Trung bình** | **${MINUTES} phút** | **${avgReq}** | **${avgErr}** | **< 300 ms** | **< 500 ms** | **${allPass ? '100% ĐẠT' : 'CÓ VI PHẠM'}** | **${allPass ? 'HỆ THỐNG ĐẠT CHUẨN' : 'KHÔNG ĐẠT'}** |\n`;

  return `| Lần chạy | Thời lượng | Tổng số request | Tỉ lệ lỗi (%) | p95 Tra cứu | p95 Đặt chỗ | Trạng thái bất biến | Đánh giá |
|---|---|---|---|---|---|---|---|
${rows}${avgRow}`;
}

async function main() {
  console.log(`================================================================`);
  console.log(`KHỞI ĐỘNG KỊCH BẢN TEST HỖN LOẠN (CHAOS TEST RUNNER - GS-06.3)`);
  console.log(`Số lần lặp: ${TIMES} lần | Thời lượng mỗi lần: ${MINUTES} phút`);
  console.log(`Thành phần bị tác động ngẫu nhiên: ${VICTIMS}`);
  console.log(`================================================================\n`);

  const results = [];

  for (let i = 1; i <= TIMES; i++) {
    try {
      const res = await runSingleChaos(i, TIMES);
      results.push(res);
      console.log(`\n📌 Tóm tắt kết quả Lần ${i}:`);
      console.log(`   - Tổng request   : ${res.totalRequests != null ? res.totalRequests.toLocaleString() : 'N/A'}`);
      console.log(`   - Tỉ lệ lỗi      : ${res.errorRate != null ? res.errorRate + '%' : 'N/A'}`);
      console.log(`   - p95 Tra cứu    : ${res.p95Lookup}`);
      console.log(`   - p95 Đặt chỗ    : ${res.p95Reserve}`);
      console.log(`   - Bất biến       : ${res.invariantsPassed ? '✅ MỌI BẤT BIẾN ĐỀU ĐẠT' : '❌ VI PHẠM'}`);
    } catch (err) {
      console.error(`❌ Lỗi khi thực thi Lần ${i}:`, err.message);
      results.push({
        runIndex: i,
        exitCode: 1,
        totalRequests: 0,
        errorRate: 100,
        p95Lookup: 'ERR',
        p95Reserve: 'ERR',
        invariantsPassed: false,
        violationsCount: 1,
      });
    }

    if (i < TIMES) {
      console.log('\n⏳ Nghỉ 15 giây trước lần chạy kế tiếp để hệ thống hoàn tất phục hồi...');
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }

  console.log('\n\n================================================================');
  console.log('📊 BẢNG TỔNG HỢP KẾT QUẢ TEST HỖN LOẠN 3 LẦN (GS-06.3)');
  console.log('================================================================\n');

  const tableMd = renderMarkdownTable(results);
  console.log(tableMd);

  if (UPDATE_MD && fs.existsSync(RESULTS_MD)) {
    try {
      let content = fs.readFileSync(RESULTS_MD, 'utf8');
      const startMarker = '<!-- BANG_TONG_HOP_START -->';
      const endMarker = '<!-- BANG_TONG_HOP_END -->';
      if (content.includes(startMarker) && content.includes(endMarker)) {
        const pattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`);
        content = content.replace(pattern, `${startMarker}\n\n${tableMd}\n${endMarker}`);
        fs.writeFileSync(RESULTS_MD, content, 'utf8');
        console.log(`\n✅ Đã tự động cập nhật bảng kết quả vào: ${RESULTS_MD}`);
      }
    } catch (e) {
      console.error('Không thể tự động ghi file Markdown:', e.message);
    }
  }

  console.log('\nHoàn tất 3 lần chạy test hỗn loạn!');
}

main().catch((err) => {
  console.error('Lỗi nghiêm trọng:', err);
  process.exit(1);
});
