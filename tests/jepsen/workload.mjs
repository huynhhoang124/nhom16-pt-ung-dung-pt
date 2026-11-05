import { randomUUID } from 'node:crypto';
import { BASE_URL, PARKING_IDS, fetchJson, sleep } from './config.mjs';
import { choose, createRandom, makeOperationId } from './random.mjs';
import { sanitize } from './history.mjs';

function headers(token, key) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(key && { 'idempotency-key': key }),
  };
}

async function auth(username, password) {
  const response = await fetchJson(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (response.status !== 200 || !response.body?.token || !response.body?.user?.id) {
    throw new Error(`Jepsen login failed for ${username}: HTTP ${response.status}`);
  }
  return response.body;
}

function recordOperation(record, fields, action) {
  const startedAt = new Date().toISOString();
  return Promise.resolve().then(action).then(async (result) => {
    const endedAt = new Date().toISOString();
    await record({
      type: 'operation',
      ...fields,
      startedAt,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
      ...sanitize(result),
    });
    return result;
  }, async (error) => {
    const endedAt = new Date().toISOString();
    await record({
      type: 'operation',
      ...fields,
      startedAt,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
      accepted: false,
      error: error.message,
    });
    return { status: 0 };
  });
}

async function terminalCommand(token, commandId, initial) {
  if (!commandId) return initial.body;
  if (initial.status !== 202) return initial.body;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetchJson(`${BASE_URL}/api/commands/${encodeURIComponent(commandId)}`, {
      headers: headers(token),
      timeoutMs: 3000,
    }).catch(() => null);
    if (response?.status === 200 && response.body?.status !== 'PENDING') return response.body;
    await sleep(250);
  }
  return null;
}

function plateFor(seed, worker, sequence) {
  const serial = ((seed >>> 0) % 10000 + worker * 10000 + sequence) % 100000;
  return `30A-${String(Math.floor(serial / 100)).padStart(3, '0')}.${String(serial % 100).padStart(2, '0')}`;
}

async function runWorker({ seed, runTag, worker, durationMs, record, signal, user, admin }) {
  const random = createRandom((seed ^ Math.imul(worker + 1, 0x9e3779b9)) | 0);
  const endAt = Date.now() + durationMs;
  const reservations = [];
  const occupied = [];
  let sequence = 0;

  while (!signal.aborted && Date.now() < endAt) {
    const parkingId = choose(random, PARKING_IDS);
    const snapshot = await fetchJson(`${BASE_URL}/api/parkings/${parkingId}`, { timeoutMs: 3000 }).catch(() => null);
    const slots = snapshot?.status === 200 && Array.isArray(snapshot.body?.slots) ? snapshot.body.slots : [];
    const available = slots.filter((slot) => slot.status === 'AVAILABLE');
    const candidates = [
      ...(available.length ? ['reserve', 'enter'] : []),
      ...(reservations.length ? ['cancel'] : []),
      ...(occupied.length ? ['exit'] : []),
    ];
    if (!candidates.length) {
      await sleep(150);
      continue;
    }

    const action = choose(random, candidates);
    const operationId = makeOperationId(seed, worker, sequence++, runTag);
    const slot = available.length ? choose(random, available) : null;
    const reservation = reservations.length ? choose(random, reservations) : null;
    const parked = occupied.length ? choose(random, occupied) : null;
    if (action === 'reserve' && slot) {
      const key = `${operationId}-r`;
      await recordOperation(record, { operationId, worker, action, parkingId, slotCode: slot.slotCode, requestId: `${user.user.id}:${key}` }, async () => {
        const response = await fetchJson(`${BASE_URL}/api/parkings/${parkingId}/reservations`, {
          method: 'POST',
          headers: headers(user.token, key),
          body: JSON.stringify({ slotCode: slot.slotCode, licensePlate: plateFor(seed, worker, sequence) }),
        });
        const commandId = response.body?.commandId;
        const terminal = await terminalCommand(user.token, commandId, response);
        const finalStatus = terminal?.statusCode ?? response.status;
        const finalBody = terminal?.result ?? response.body;
        if (finalStatus >= 200 && finalStatus < 300 && finalBody?.id) {
          reservations.push({ parkingId, id: finalBody.id });
        }
        return {
          httpStatus: response.status,
          accepted: response.status >= 200 && response.status < 300 && Boolean(commandId),
          commandId: commandId ?? null,
          commandStatus: terminal?.status ?? (response.status === 202 ? 'PENDING' : null),
          commandStatusCode: finalStatus,
          reservationId: finalBody?.id ?? null,
          response: response.body,
        };
      });
    } else if (action === 'cancel' && reservation) {
      const key = `${operationId}-c`;
      await recordOperation(record, { operationId, worker, action, parkingId: reservation.parkingId, reservationId: reservation.id }, async () => {
        const response = await fetchJson(`${BASE_URL}/api/parkings/${reservation.parkingId}/reservations/${encodeURIComponent(reservation.id)}`, {
          method: 'DELETE',
          headers: headers(user.token, key),
        });
        const commandId = response.body?.commandId;
        const terminal = await terminalCommand(user.token, commandId, response);
        const finalStatus = terminal?.statusCode ?? response.status;
        if (finalStatus >= 200 && finalStatus < 300) reservations.splice(reservations.indexOf(reservation), 1);
        return {
          httpStatus: response.status,
          accepted: response.status >= 200 && response.status < 300 && Boolean(commandId),
          commandId: commandId ?? null,
          commandStatus: terminal?.status ?? (response.status === 202 ? 'PENDING' : null),
          commandStatusCode: finalStatus,
          response: response.body,
        };
      });
    } else if (action === 'enter' && slot) {
      await recordOperation(record, { operationId, worker, action, parkingId, slotCode: slot.slotCode }, async () => {
        const response = await fetchJson(`${BASE_URL}/api/parkings/${parkingId}/slots/${encodeURIComponent(slot.slotCode)}/enter`, {
          method: 'POST',
          headers: headers(admin.token),
          body: JSON.stringify({ licensePlate: plateFor(seed, worker, sequence) }),
        });
        if (response.status >= 200 && response.status < 300) occupied.push({ parkingId, slotCode: slot.slotCode });
        return { httpStatus: response.status, accepted: response.status >= 200 && response.status < 300, response: response.body };
      });
    } else if (action === 'exit' && parked) {
      await recordOperation(record, { operationId, worker, action, parkingId: parked.parkingId, slotCode: parked.slotCode }, async () => {
        const response = await fetchJson(`${BASE_URL}/api/parkings/${parked.parkingId}/slots/${encodeURIComponent(parked.slotCode)}/exit`, {
          method: 'POST',
          headers: headers(admin.token),
          body: JSON.stringify({ cash: true }),
        });
        if (response.status >= 200 && response.status < 300) occupied.splice(occupied.indexOf(parked), 1);
        return { httpStatus: response.status, accepted: response.status >= 200 && response.status < 300, response: response.body };
      });
    }

    await sleep(40 + Math.floor(random() * 160));
  }

  for (const reservation of reservations) {
    const operationId = makeOperationId(seed, worker, sequence++, runTag);
    const key = `cleanup-${runTag}-${worker}-${sequence}`;
    await recordOperation(record, { operationId, worker, action: 'cleanup-cancel',
      parkingId: reservation.parkingId, reservationId: reservation.id, requestId: `${user.user.id}:${key}` }, async () => {
      const response = await fetchJson(`${BASE_URL}/api/parkings/${reservation.parkingId}/reservations/${encodeURIComponent(reservation.id)}`, {
        method: 'DELETE',
        headers: headers(user.token, key),
      });
      const commandId = response.body?.commandId;
      const terminal = await terminalCommand(user.token, commandId, response);
      const finalStatus = terminal?.statusCode ?? response.status;
      return {
        httpStatus: response.status,
        accepted: response.status >= 200 && response.status < 300 && Boolean(commandId),
        commandId: commandId ?? null,
        commandStatus: terminal?.status ?? (response.status === 202 ? 'PENDING' : null),
        commandStatusCode: finalStatus,
        response: response.body,
      };
    });
  }
  for (const parked of occupied) {
    await recordOperation(record, { operationId: makeOperationId(seed, worker, sequence++, runTag), worker, action: 'cleanup-exit',
      parkingId: parked.parkingId, slotCode: parked.slotCode }, async () => {
      const response = await fetchJson(`${BASE_URL}/api/parkings/${parked.parkingId}/slots/${encodeURIComponent(parked.slotCode)}/exit`, {
        method: 'POST',
        headers: headers(admin.token),
        body: JSON.stringify({ cash: true }),
      });
      return { httpStatus: response.status, accepted: response.status >= 200 && response.status < 300, response: response.body };
    });
  }
}

export async function runWorkload({ seed, durationMs, record, signal, workers = 4 }) {
  const runTag = randomUUID().slice(0, 8);
  const [user, admin] = await Promise.all([
    auth('user1', process.env.DEMO_PASSWORD ?? '123456'),
    auth('admin', process.env.DEMO_PASSWORD ?? '123456'),
  ]);
  await record({ type: 'workload-ready', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), workers, seed, runTag });
  await Promise.all(Array.from({ length: workers }, (_, worker) =>
    runWorker({ seed, runTag, worker, durationMs, record, signal, user, admin })));
}
