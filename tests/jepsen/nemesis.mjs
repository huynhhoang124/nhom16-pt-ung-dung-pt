import { BASE_URL, PARKING_IDS, compose, fetchJson, sleep } from './common.mjs';
import { makeRandom } from './generator.mjs';

const API = process.env.TOXIPROXY ?? `http://localhost:${process.env.TOXIPROXY_PORT ?? 18474}`;
const FAULTS = ['partition', 'rabbitmq', 'db', 'leader', 'clock-skew', 'loss'];

async function setProxy(name, enabled) {
  const response = await fetchJson(`${API}/proxies/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`Toxiproxy ${name} enabled=${enabled}: HTTP ${response.status}`);
}

async function addLoss(name) {
  const response = await fetchJson(`${API}/proxies/${name}/toxics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'jepsen_loss',
      type: 'timeout',
      stream: 'downstream',
      toxicity: 0.2,
      attributes: { timeout: 1000 },
    }),
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`Toxiproxy loss ${name}: HTTP ${response.status}`);
}

async function removeLoss(name) {
  const response = await fetchJson(`${API}/proxies/${name}/toxics/jepsen_loss`, { method: 'DELETE' });
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`Toxiproxy reset ${name}: HTTP ${response.status}`);
  }
}

async function waitHealthy(parkingId, deadline) {
  const port = 8000 + PARKING_IDS.indexOf(parkingId) + 1;
  const url = `http://localhost:${port}/health`;
  while (Date.now() < deadline) {
    try {
      const response = await fetchJson(url, { timeoutMs: 1000 });
      if (response.status === 200) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Parking ${parkingId} did not recover before deadline`);
}

async function runFault(type, parameters, durationMs, record, action, restore = async () => {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let result = {};
  let failure;
  try {
    result = await action();
    await sleep(durationMs);
  } catch (error) {
    failure = error;
  }
  try {
    await restore();
  } catch (error) {
    failure ??= error;
  }
  if (failure) result = { ...result, error: failure.message, restored: false };
  else result = { ...result, restored: true };
  await record({
    type: `nemesis:${type}`,
    parameters,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    result,
    commandId: null,
  });
  if (failure) throw failure;
}

async function partition(durationMs, record) {
  const names = ['parking-d', 'parking-e', 'parking-f'];
  const disabled = [];
  await runFault('partition', { regions: ['North:A-C', 'South:D-F'], durationMs }, durationMs, record, async () => {
    for (const name of names) {
      await setProxy(name, false);
      disabled.push(name);
    }
    return { disabled };
  }, async () => {
    for (const name of disabled.reverse()) await setProxy(name, true);
  });
}

async function isolateRabbit(durationMs, random, record) {
  const service = random() < 0.5 ? 'rabbitmq-2' : 'rabbitmq-3';
  await runFault('rabbitmq-isolation', { service, durationMs }, durationMs, record, async () => {
    compose(['stop', service]);
    return { stopped: service };
  }, () => compose(['start', service]));
}

async function stopDatabase(durationMs, random, record) {
  const parkingId = PARKING_IDS[Math.floor(random() * PARKING_IDS.length)];
  const service = `db-${parkingId.toLowerCase()}`;
  await runFault('database-stop', { parkingId, service, durationMs }, durationMs, record, async () => {
    compose(['stop', service]);
    return { stopped: service };
  }, () => compose(['start', service]));
}

async function pauseLeader(durationMs, record) {
  let service;
  let paused = false;
  await runFault('leader-pause', { durationMs }, durationMs, record, async () => {
    const leaders = [];
    for (const [candidate, url] of [['aggregator', BASE_URL], ['aggregator-2', 'http://localhost:8010']]) {
      const response = await fetchJson(`${url}/api/leader`, { timeoutMs: 2000 }).catch(() => null);
      if (response?.status === 200 && response.body?.isLeader) leaders.push(candidate);
    }
    if (leaders.length !== 1) throw new Error(`Expected one active Aggregator leader, found ${leaders.length}`);
    service = leaders[0];
    compose(['pause', service]);
    paused = true;
    return { paused: service };
  }, () => {
    if (paused) compose(['unpause', service]);
  });
}

async function skewClock(durationMs, random, record) {
  const parkingId = PARKING_IDS[Math.floor(random() * PARKING_IDS.length)];
  const service = `parking-${parkingId.toLowerCase()}`;
  const skewMs = (random() < 0.5 ? -1 : 1) * (60_000 + Math.floor(random() * 240_000));
  const apply = (clockSkew) => compose(['up', '-d', '--no-deps', '--force-recreate', service], {
    ...process.env,
    CLOCK_SKEW_MS: String(clockSkew),
    ENABLE_TEST_FAULTS: '1',
  });
  let changed = false;
  await runFault('clock-skew', { parkingId, skewMs, durationMs }, durationMs, record, async () => {
    apply(skewMs);
    changed = true;
    await waitHealthy(parkingId, Date.now() + 30_000);
    return { applied: true };
  }, async () => {
    if (changed) {
      apply(0);
      await waitHealthy(parkingId, Date.now() + 30_000);
    }
  });
}

async function packetLoss(durationMs, record) {
  const names = ['parking-d', 'parking-e', 'parking-f'];
  let added = [];
  await runFault('packet-loss', { regions: ['North:A-C', 'South:D-F'], lossPercent: 20, durationMs }, durationMs, record, async () => {
    for (const name of names) {
      await addLoss(name);
      added.push(name);
    }
    return { affected: added, lossPercent: 20 };
  }, async () => {
    for (const name of added.reverse()) await removeLoss(name);
  });
}

export async function runNemesis({ type, durationMs, seed, record, signal }) {
  if (!['none', 'random', ...FAULTS].includes(type)) throw new Error(`Unsupported nemesis: ${type}`);
  if (type === 'none') return 'none';
  const random = makeRandom(seed ^ 0x51ed270b);
  const selected = type === 'random' ? FAULTS[Math.floor(random() * FAULTS.length)] : type;
  const faultDuration = selected === 'partition' || selected === 'loss' ? 30_000 : 15_000;
  if (durationMs < faultDuration + 5000) {
    throw new Error(`${selected} requires --time of at least ${(faultDuration + 5000) / 1000} seconds`);
  }
  const delay = Math.min(Math.floor(durationMs * 0.25), durationMs - faultDuration);
  await sleep(delay);
  if (signal.aborted) return selected;

  if (selected === 'partition') await partition(faultDuration, record);
  else if (selected === 'rabbitmq') await isolateRabbit(faultDuration, random, record);
  else if (selected === 'db') await stopDatabase(faultDuration, random, record);
  else if (selected === 'leader') await pauseLeader(15_000, record);
  else if (selected === 'clock-skew') await skewClock(faultDuration, random, record);
  else if (selected === 'loss') await packetLoss(faultDuration, record);
  return selected;
}
