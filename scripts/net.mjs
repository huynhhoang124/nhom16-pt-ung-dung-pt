// PT-06: điều khiển toxiproxy (đường mạng Aggregator -> bãi). Cần chạy compose với docker-compose.chaos.yml.
//   node scripts/net.mjs B latency 1500   chậm 1,5 s mỗi chiều (dưới timeout 2 s: chậm nhưng vẫn chạy)
//   node scripts/net.mjs B latency 3500   vượt timeout: đặt chỗ trả 504, "Thử lại" cùng key -> không đặt trùng
//   node scripts/net.mjs B down           cắt mạng Aggregator–B (B vẫn sống, barrier vẫn cho xe vào)
//   node scripts/net.mjs B loss 30        30% kết nối bị treo rồi cắt (mạng chập chờn -> circuit breaker)
//   node scripts/net.mjs B reset          gỡ hết, mạng bình thường
//   node scripts/net.mjs                  xem trạng thái
const API = process.env.TOXIPROXY ?? 'http://localhost:8474';
const [bay, cmd, arg] = process.argv.slice(2);
const proxy = bay && `parking-${bay.toLowerCase()}`;

async function call(path, method = 'GET', body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  if (!r.ok && r.status !== 404) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
const reset = async () => {
  for (const t of (await call(`/proxies/${proxy}/toxics`)) ?? []) await call(`/proxies/${proxy}/toxics/${t.name}`, 'DELETE');
  await call(`/proxies/${proxy}`, 'POST', { enabled: true });
};
// latency chỉ đặt chiều trả về (downstream): đặt cả 2 chiều thì "1500" thành ~3 s mỗi request, vượt timeout 2 s.
const toxic = (type, attributes, toxicity = 1, streams = ['upstream', 'downstream']) =>
  Promise.all(streams.map((stream) =>
    call(`/proxies/${proxy}/toxics`, 'POST', { name: `${type}_${stream}`, type, stream, toxicity, attributes })));

try {
  if (!cmd) {
    for (const [name, p] of Object.entries(await call('/proxies'))) {
      console.log(`${name}: ${p.enabled ? 'BẬT' : 'CẮT MẠNG'}  ${p.toxics.map((t) => `${t.type}(${JSON.stringify(t.attributes)}, ${Math.round(t.toxicity * 100)}%)`).join(', ') || 'bình thường'}`);
    }
  } else if (cmd === 'reset') { await reset(); console.log(`${proxy}: mạng bình thường`); }
  else if (cmd === 'down') { await call(`/proxies/${proxy}`, 'POST', { enabled: false }); console.log(`${proxy}: đã cắt mạng`); }
  else if (cmd === 'latency') { await reset(); await toxic('latency', { latency: Number(arg ?? 1500), jitter: 100 }, 1, ['downstream']); console.log(`${proxy}: chậm ${arg ?? 1500} ms`); }
  else if (cmd === 'loss') { await reset(); await toxic('timeout', { timeout: 1000 }, Number(arg ?? 30) / 100); console.log(`${proxy}: ${arg ?? 30}% kết nối bị treo rồi cắt`); }
  else { console.log('Lệnh: latency <ms> | down | loss <phần trăm> | reset'); process.exit(1); }
} catch (e) {
  console.error(`Không gọi được toxiproxy (${e.message}). Đã chạy compose với -f docker-compose.chaos.yml --profile chaos chưa?`);
  process.exit(1);
}
