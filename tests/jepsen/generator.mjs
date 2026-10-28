import { BASE_URL, PARKING_IDS, fetchJson, publicResult, sleep } from './common.mjs';

export function makeRandom(seed) {
  let state = (Number(seed) >>> 0) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeWorkerRandom(seed, workerIndex) {
  return makeRandom((seed ^ Math.imul(workerIndex + 1, 0x9e3779b9)) >>> 0);
}

function choose(random, values) {
  return values[Math.floor(random() * values.length)];
}

function plateFor(seed, workerIndex, number) {
  const serial = (Math.abs(seed) * 977 + workerIndex * 10000 + number) % 100000;
  return `30A-${String(Math.floor(serial / 100)).padStart(3, '0')}.${String(serial % 100).padStart(2, '0')}`;
}

function headers(token, key) {
  return {
    authorization: `Bearer ${token}`,
    ...(key && { 'idempotency-key': key }),
    'content-type': 'application/json',
  };
}

async function request(record, type, parameters, url, { method = 'GET', token, key, body, commandId } = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let result;
  try {
    const response = await fetchJson(url, {
      method,
      headers: headers(token, key),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    result = response;
  } catch (error) {
    result = { status: 0, error: error.message };
  }
  await record({
    type,
    parameters,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    result: publicResult(result),
    commandId: commandId ?? result.body?.commandId ?? null,
  });
  return result;
}

async function terminalResult(record, token, commandId, deadline, baseUrl) {
  if (!commandId) return null;
  while (Date.now() < deadline) {
    const response = await request(record, 'command-status', { commandId },
      `${baseUrl}/api/commands/${encodeURIComponent(commandId)}`, { token, commandId });
    if (response.status === 200 && response.body?.status !== 'PENDING') return response.body;
    await sleep(250);
  }
  return null;
}

async function login(record, username, password, baseUrl) {
  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await request(record, 'login', { username, attempt }, `${baseUrl}/api/auth/login`, {
      method: 'POST',
      body: { username, password },
    });
    if (response.status !== 0 || attempt === 3) break;
    await sleep(500 * attempt);
  }
  if (response.status !== 200 || !response.body?.token || !response.body?.user?.id) {
    throw new Error(`Không đăng nhập được tài khoản tải ${username}: HTTP ${response.status}`);
  }
  return { ...response.body.user, token: response.body.token };
}

async function runWorker({ seed, workerIndex, durationMs, record, signal, user, admin, baseUrl }) {
  const random = makeWorkerRandom(seed, workerIndex);
  const reservations = [];
  const occupied = [];
  const commandIds = new Set();
  const runId = Date.now().toString(36);
  let sequence = 0;
  const endAt = Date.now() + durationMs;

  while (Date.now() < endAt && !signal.aborted) {
    const parkingId = choose(random, PARKING_IDS);
    const snapshot = await request(record, 'inspect', { parkingId, workerIndex },
      `${baseUrl}/api/parkings/${parkingId}`, { token: user.token });
    const slots = snapshot.status === 200 && Array.isArray(snapshot.body?.slots) ? snapshot.body.slots : [];
    const available = slots.filter((slot) => slot.status === 'AVAILABLE');
    const candidates = [
      ...(available.length ? ['reserve', 'enter'] : []),
      ...(reservations.length ? ['cancel'] : []),
      ...(occupied.length ? ['exit'] : []),
    ];
    if (!candidates.length) {
      await sleep(200);
      continue;
    }

    const action = choose(random, candidates);
    const reservation = reservations.length ? choose(random, reservations) : null;
    const parked = occupied.length ? choose(random, occupied) : null;
    const slot = available.length ? choose(random, available) : null;
    const plate = plateFor(seed, workerIndex, sequence);
    const key = `jepsen-${runId}-${workerIndex}-${sequence}`;
    const commandId = `${user.id}:${key}`;
    sequence++;

    if (action === 'reserve' && slot) {
      commandIds.add(commandId);
      const startTime = random() < 0.15
        ? new Date(Date.now() + 7 * 86400_000 - 60_000).toISOString()
        : undefined;
      const response = await request(record, 'reserve', { parkingId, slotCode: slot.slotCode, licensePlate: plate, durationMinutes: 60 },
        `${baseUrl}/api/parkings/${parkingId}/reservations`, {
          method: 'POST', token: user.token, key, commandId,
          body: { slotCode: slot.slotCode, licensePlate: plate, durationMinutes: 60, ...(startTime && { startTime }) },
        });
      const final = response.status === 202 || response.status === 0
        ? await terminalResult(record, user.token, commandId, Date.now() + 5000, baseUrl)
        : response.body;
      const result = final?.result ?? final;
      const status = final?.statusCode ?? response.status;
      if (status >= 200 && status < 300 && result?.id) {
        reservations.push({ parkingId, id: result.id, slotCode: slot.slotCode });
      }
    } else if (action === 'cancel' && reservation) {
      const cancelKey = `${key}-cancel`;
      const cancelId = `${user.id}:${cancelKey}`;
      commandIds.add(cancelId);
      const response = await request(record, 'cancel', {
        parkingId: reservation.parkingId,
        reservationId: reservation.id,
      }, `${baseUrl}/api/parkings/${reservation.parkingId}/reservations/${reservation.id}`, {
        method: 'DELETE', token: user.token, key: cancelKey, commandId: cancelId,
      });
      const final = response.status === 202 || response.status === 0
        ? await terminalResult(record, user.token, cancelId, Date.now() + 5000, baseUrl)
        : response.body;
      if ((final?.statusCode ?? response.status) >= 200 && (final?.statusCode ?? response.status) < 300) {
        reservations.splice(reservations.indexOf(reservation), 1);
      }
    } else if (action === 'enter' && slot) {
      const response = await request(record, 'enter', { parkingId, slotCode: slot.slotCode, licensePlate: plate },
        `${baseUrl}/api/parkings/${parkingId}/slots/${encodeURIComponent(slot.slotCode)}/enter`, {
          method: 'POST', token: admin.token, body: { licensePlate: plate },
        });
      if (response.status >= 200 && response.status < 300) occupied.push({ parkingId, slotCode: slot.slotCode });
    } else if (action === 'exit' && parked) {
      const response = await request(record, 'exit', { parkingId: parked.parkingId, slotCode: parked.slotCode },
        `${baseUrl}/api/parkings/${parked.parkingId}/slots/${encodeURIComponent(parked.slotCode)}/exit`, {
          method: 'POST', token: admin.token, body: { cash: true },
        });
      if (response.status >= 200 && response.status < 300) occupied.splice(occupied.indexOf(parked), 1);
    }
    await sleep(50 + Math.floor(random() * 200));
  }
  return { operations: sequence, commandIds: [...commandIds] };
}

export async function runGenerator({
  seed,
  durationMs,
  record,
  signal,
  password = process.env.DEMO_PASSWORD ?? '123456',
  workerCount = 4,
  baseUrl = BASE_URL,
}) {
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 32) {
    throw new Error('workerCount must be an integer between 1 and 32');
  }
  const [user, admin] = await Promise.all([
    login(record, 'user1', password, baseUrl),
    login(record, 'admin', password, baseUrl),
  ]);
  const results = await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) =>
    runWorker({ seed, workerIndex, durationMs, record, signal, user, admin, baseUrl })));
  return {
    operations: results.reduce((total, result) => total + result.operations, 0),
    commandIds: results.flatMap((result) => result.commandIds),
  };
}
