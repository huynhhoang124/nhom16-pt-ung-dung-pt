// Giả lập barrier/cảm biến của một bãi: gọi THẲNG Parking Node, không qua Aggregator.
// Chứng minh xe vào/ra tại bãi không phụ thuộc trung tâm (tắt aggregator vẫn chạy được).
//   node scripts/barrier.mjs A A05 enter [biển-số]
//   node scripts/barrier.mjs A A05 exit
const PORTS = { A: 8001, B: 8002, C: 8003, D: 8004 };
const [parkingId, slot, action = 'enter', plate] = process.argv.slice(2);

if (!PORTS[parkingId] || !slot || !['enter', 'exit'].includes(action)) {
  console.log('Cách dùng: node scripts/barrier.mjs <A|B|C|D> <mã slot> <enter|exit> [biển số]');
  process.exit(1);
}

const r = await fetch(`http://localhost:${PORTS[parkingId]}/api/slots/${slot}/${action}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-key': process.env.INTERNAL_KEY ?? 'dev' },
  body: JSON.stringify({ licensePlate: plate }),
}).catch((e) => ({ status: 0, json: async () => ({ error: e.message }) }));
console.log(r.status, await r.json());
process.exit(r.status === 200 ? 0 : 1);
