// Giả lập barrier/cảm biến của một bãi: gọi THẲNG Parking Node, không qua Aggregator.
// Chứng minh xe vào/ra tại bãi không phụ thuộc trung tâm (tắt aggregator vẫn chạy được).
//   node scripts/barrier.mjs A A05 enter [biển-số]
//   node scripts/barrier.mjs A A05 exit [cash]     (cash = thu tiền mặt rồi cho ra; chưa trả thì node trả 402 kèm số tiền)
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* chưa có .env: dùng biến môi trường / mặc định */ }
const PORTS = { A: 8001, B: 8002, C: 8003, D: 8004 };
const [parkingId, slot, action = 'enter', arg] = process.argv.slice(2);
const cash = action === 'exit' && arg === 'cash';
const plate = action === 'enter' ? arg : undefined;

if (!PORTS[parkingId] || !slot || !['enter', 'exit'].includes(action)) {
  console.log('Cách dùng: node scripts/barrier.mjs <A|B|C|D> <mã slot> enter [biển số]  |  ... exit [cash]');
  process.exit(1);
}

const r = await fetch(`http://localhost:${PORTS[parkingId]}/api/slots/${slot}/${action}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-key': process.env.INTERNAL_KEY ?? 'dev' },
  body: JSON.stringify({ licensePlate: plate, cash }),
}).catch((e) => ({ status: 0, json: async () => ({ error: e.message }) }));
console.log(r.status, await r.json());
process.exit(r.status === 200 ? 0 : 1);
