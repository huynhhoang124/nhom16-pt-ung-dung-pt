import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Khi chạy `npm run dev`: chuyển /api và /socket.io sang Aggregator (giống nginx trong Docker).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:8000',
      '/socket.io': { target: 'http://localhost:8000', ws: true },
    },
  },
});
