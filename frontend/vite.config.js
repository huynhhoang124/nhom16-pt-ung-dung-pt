import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev:https`: phục vụ HTTPS cho cả mạng LAN để điện thoại dùng được camera ở màn Cổng.
// Chứng chỉ tạo bằng `node scripts/dev-cert.mjs` (frontend/.cert, nằm ngoài git).
const https = process.env.npm_lifecycle_event === 'dev:https';
const cert = new URL('./.cert/', import.meta.url);
if (https && !existsSync(new URL('cert.pem', cert))) {
  throw new Error('Chưa có chứng chỉ HTTPS. Chạy trước: node scripts/dev-cert.mjs (ở thư mục gốc dự án).');
}

// Khi chạy `npm run dev`: chuyển /api và /socket.io sang Aggregator (giống nginx trong Docker).
export default defineConfig({
  plugins: [react()],
  server: {
    port: https ? 5173 : 3000,
    ...(https && {
      host: true,   // nghe trên mọi địa chỉ để điện thoại trong LAN vào được
      strictPort: true,
      https: { key: readFileSync(new URL('key.pem', cert)), cert: readFileSync(new URL('cert.pem', cert)) },
    }),
    proxy: {
      '/api': 'http://localhost:8000',
      '/socket.io': { target: 'http://localhost:8000', ws: true },
    },
  },
});
