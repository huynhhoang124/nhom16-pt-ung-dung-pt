// Tạo chứng chỉ HTTPS tự ký cho bản dev, để điện thoại trong mạng LAN dùng được CAMERA ở màn Cổng
// (trình duyệt chỉ cho mở camera trên HTTPS hoặc localhost; iPhone không có cách nào bỏ qua).
//   node scripts/dev-cert.mjs            # tạo frontend/.cert/{key,cert}.pem, hạn 30 ngày
//   cd frontend && npm run dev:https     # https://<IP-LAN>:5173 (proxy /api tới Aggregator :8000)
// Chứng chỉ tự ký: lần đầu mở trên điện thoại sẽ có cảnh báo -> chọn "Tiếp tục / Visit this website".
// Cần openssl (có sẵn trong Git for Windows / macOS / Linux). Thư mục .cert nằm ngoài git.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../frontend/.cert/', import.meta.url));
mkdirSync(dir, { recursive: true });

// Mọi địa chỉ IPv4 của máy (Wi-Fi, LAN, hotspot...) + localhost -> mở bằng IP nào cũng khớp chứng chỉ.
const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4').map((i) => i.address);
const san = ['DNS:localhost', ...new Set(ips)].map((x) => (/^\d/.test(x) ? `IP:${x}` : x)).join(',');

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
  '-keyout', `${dir}key.pem`, '-out', `${dir}cert.pem`, '-subj', '/CN=nhom16-dev', '-addext', `subjectAltName=${san}`], { stdio: 'inherit' });

console.log(`Đã tạo ${dir}cert.pem cho: ${san}`);
const lan = ips.filter((ip) => !ip.startsWith('127.'));
console.log(`Chạy: cd frontend && npm run dev:https  →  mở trên điện thoại: ${lan.map((ip) => `https://${ip}:5173`).join('  hoặc  ')}`);
