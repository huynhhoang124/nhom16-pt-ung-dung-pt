// GS-06: test hỗn loạn. Vừa chạy tải (k6) vừa tắt/bật ngẫu nhiên các thành phần, rồi kiểm bất biến.
//   docker compose --profile ha up -d && node tests/chaos.mjs          (mặc định 3 phút)
// Không chứng minh được hệ chạy đúng bằng vài lần bấm tay; test này kiểm BẤT BIẾN dưới lỗi ngẫu nhiên.
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const MINUTES = Number(process.env.MINUTES ?? 3);
const VICTIMS = (process.env.VICTIMS ?? 'parking-b,rabbitmq-2,aggregator').split(',');
const sh = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const network = 'nhom16-parking_default';   // compose đặt name: nhom16-parking

console.log(`Chạy tải ${MINUTES} phút, tắt/bật ngẫu nhiên: ${VICTIMS.join(', ')}`);
const k6 = spawn('docker', ['run', '--rm', '-i', '--network', network, '-e', 'BASE=http://aggregator:8000', '-e', `DURATION=${MINUTES}m`, 'grafana/k6', 'run', '--quiet', '-'],
  { cwd: ROOT, stdio: ['pipe', 'inherit', 'inherit'] });
k6.stdin.end(readFileSync(new URL('load/k6.js', import.meta.url)));

const end = Date.now() + MINUTES * 60_000;
while (Date.now() < end - 30_000) {
  const v = VICTIMS[Math.floor(Math.random() * VICTIMS.length)];
  console.log(`[hỗn loạn] tắt ${v}`);
  sh(`docker compose stop ${v}`);
  await sleep(10_000 + Math.random() * 15_000);
  console.log(`[hỗn loạn] bật ${v}`);
  sh(`docker compose start ${v}`);
  await sleep(10_000 + Math.random() * 10_000);
}
await new Promise((r) => k6.on('exit', r));
console.log('Chờ 30 s cho hệ thống hồi phục (health check, đối soát, relay)...');
await sleep(30_000);
const code = spawn('node', ['tests/load/check-invariants.mjs'], { cwd: ROOT, stdio: 'inherit' });
code.on('exit', (c) => process.exit(c));
