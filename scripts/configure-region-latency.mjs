// PD-12: cấu hình độ trễ mô phỏng liên vùng ở chiều trả về của các proxy bãi Nam.
const proxies = ['parking-d', 'parking-e', 'parking-f'];
const api = process.env.TOXIPROXY_API ?? 'http://toxiproxy:8474';
const delay = { latency: 40, jitter: 10 };

async function request(path, method = 'GET', body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

async function configure(name) {
  const toxicName = 'inter_region_latency';
  const toxics = await request(`/proxies/${name}/toxics`);
  if (toxics.some((toxic) => toxic.name === toxicName)) {
    await request(`/proxies/${name}/toxics/${toxicName}`, 'DELETE');
  }
  await request(`/proxies/${name}/toxics`, 'POST', {
    name: toxicName,
    type: 'latency',
    stream: 'downstream',
    toxicity: 1,
    attributes: delay,
  });
}

async function main() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await Promise.all(proxies.map(configure));
      console.log('Đã đặt độ trễ liên vùng 40 ± 10 ms cho các bãi D-F.');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Toxiproxy không sẵn sàng sau 30 giây: ${lastError?.message ?? 'unknown error'}`);
}

main().catch((error) => {
  console.error(`Không cấu hình được mạng liên vùng: ${error.message}`);
  process.exitCode = 1;
});
