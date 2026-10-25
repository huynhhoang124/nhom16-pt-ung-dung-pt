import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* .env is optional in CI */ }

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { io } = require('socket.io-client');
const base = process.env.BASE ?? 'http://localhost:8000';
const jaeger = process.env.JAEGER ?? 'http://localhost:16686';
const nodes = {
  A: process.env.PARKING_A ?? 'http://localhost:8001',
  B: process.env.PARKING_B ?? 'http://localhost:8002',
  C: process.env.PARKING_C ?? 'http://localhost:8003',
};
const internalKey = process.env.INTERNAL_KEY;
const password = process.env.DEMO_PASSWORD ?? '123456';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body && { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function until(label, fn, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: lastError });
}

function socketEvent(socket, name, predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, onEvent);
      reject(new Error(`Timed out waiting for Socket.IO ${name}`));
    }, timeoutMs);
    const onEvent = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(name, onEvent);
      resolve(value);
    };
    socket.on(name, onEvent);
  });
}

function spanTags(span) {
  return Object.fromEntries((span.tags ?? []).map(({ key, value }) => [
    key,
    typeof value === 'object'
      ? value?.stringValue ?? value?.intValue ?? value?.boolValue ?? value?.floatValue ?? value?.value
      : value,
  ]));
}

async function loadTrace(traceId) {
  const response = await fetch(`${jaeger}/api/traces/${traceId}`);
  if (!response.ok) return null;
  const body = await response.json();
  return body.data?.flatMap((trace) => trace.spans.map((span) => ({
    ...span,
    serviceName: trace.processes?.[span.processID]?.serviceName,
    attributes: spanTags(span),
  }))) ?? null;
}

const bookingTraceId = randomBytes(16).toString('hex');
const bookingRequestId = `pd24-${randomUUID()}`;
const slotCode = `T${randomBytes(4).toString('hex').toUpperCase()}`;
const idempotencyKey = randomUUID();
const createdSlots = [];
let reservationId;
let socket;
let adminTokenForCleanup;

function newTraceparent(traceId) {
  return `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
}

function newPlate() {
  return `30A-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}.${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
}

async function createSlot(parkingId, code, key) {
  const result = await request(`${nodes[parkingId]}/api/slots`, {
    method: 'POST',
    headers: { 'x-internal-key': key },
    body: { slotCode: code, floor: 1, type: 'CAR' },
  });
  assert.ok([200, 201].includes(result.status), `Slot creation failed: ${JSON.stringify(result.body)}`);
  createdSlots.push({ parkingId, code });
}

async function requireJaegerTrace(traceId, predicate, label) {
  const spans = await until(`${label} in Jaeger`, async () => {
    const found = await loadTrace(traceId);
    return found?.length && predicate(found) ? found : null;
  });
  return spans;
}

try {
  assert.ok(internalKey, 'Set INTERNAL_KEY to the value used by the compose stack');
  const healthy = await until('Aggregator command pipeline', async () => {
    const r = await request(`${base}/health`);
    return r.status === 200 && r.body?.status === 'UP' && r.body?.commandsReady === true;
  });
  assert.ok(healthy);

  const user = await request(`${base}/api/auth/login`, {
    method: 'POST',
    body: { username: 'user1', password },
  });
  assert.equal(user.status, 200, 'Demo USER login must succeed');
  const admin = await request(`${base}/api/auth/login`, {
    method: 'POST',
    body: { username: 'admin', password },
  });
  assert.equal(admin.status, 200, 'Demo ADMIN login must succeed');
  adminTokenForCleanup = admin.body.token;

  socket = io(base, { transports: ['websocket'], auth: { token: user.body.token }, reconnection: false });
  await until('Socket.IO connection', () => socket.connected);
  const slotUpdate = socketEvent(socket, 'SLOT_UPDATED', (event) => event.slot === slotCode);
  const commandResult = socketEvent(socket, 'COMMAND_RESULT', (event) => event.commandId === `${user.body.user.id}:${idempotencyKey}`);
  slotUpdate.catch(() => {});
  commandResult.catch(() => {});

  if (Object.values(nodes).some((url) => !/^https?:\/\//.test(url)) || !internalKey) {
    throw new Error('Parking Node URLs and INTERNAL_KEY are required');
  }
  await createSlot('A', slotCode, internalKey);

  const booking = await request(`${base}/api/parkings/A/reservations`, {
    method: 'POST',
    token: user.body.token,
    headers: {
      'idempotency-key': idempotencyKey,
      traceparent: newTraceparent(bookingTraceId),
      'x-request-id': bookingRequestId,
    },
    body: { slotCode, licensePlate: newPlate() },
  });
  assert.ok([201, 202].includes(booking.status), `Booking failed: ${JSON.stringify(booking.body)}`);
  assert.ok(booking.body.commandId, 'Broker booking response must include commandId');
  const terminal = booking.status === 201 ? booking : await commandResult;
  reservationId = terminal.body?.id ?? terminal.result?.id;
  assert.ok(reservationId, 'Completed command must include the reservation id');
  await slotUpdate;

  const spans = await requireJaegerTrace(bookingTraceId,
    (found) => found.some((span) => span.operationName === 'socket.emit'), 'TC77 spans');
  const has = (label, predicate) => {
    assert.ok(spans.some(predicate), `TC77 missing ${label}; trace: ${jaeger}/trace/${bookingTraceId}`);
  };

  has('Aggregator HTTP booking span', (span) =>
    span.serviceName === 'aggregator' && span.operationName.toLowerCase().includes('reservations'));
  has('command AMQP publish span', (span) =>
    span.serviceName === 'aggregator' && span.operationName === 'command.publish'
      && span.attributes['messaging.destination.name'] === 'parking.commands');
  has('Parking Node command AMQP receive span', (span) =>
    span.serviceName === 'parking-node'
      && (span.operationName.toLowerCase().includes('consume') || String(span.attributes['messaging.destination.name'] ?? '').includes('cmd.A')));
  has('Parking Node PostgreSQL span', (span) =>
    span.serviceName === 'parking-node' && Object.keys(span.attributes).some((key) => key.startsWith('db.')));
  has('outbox publish span', (span) =>
    span.serviceName === 'parking-node' && span.operationName === 'outbox.publish');
  has('Aggregator event consumer span', (span) =>
    span.serviceName === 'aggregator' && span.operationName === 'event.process');
  has('Socket.IO emit span', (span) =>
    span.serviceName === 'aggregator' && span.operationName === 'socket.emit');

  console.log(JSON.stringify({
    test: 'TC77',
    traceId: bookingTraceId,
    jaeger: `${jaeger}/trace/${bookingTraceId}`,
    requestId: bookingRequestId,
    spans: spans.map(({ serviceName, operationName }) => ({ serviceName, operationName })),
  }, null, 2));

  const sagaSlots = [`T${randomBytes(4).toString('hex').toUpperCase()}`, `T${randomBytes(4).toString('hex').toUpperCase()}`];
  await createSlot('A', sagaSlots[0], internalKey);
  await createSlot('B', sagaSlots[1], internalKey);
  const sagaTraceId = randomBytes(16).toString('hex');
  const saga = await request(`${base}/api/group-reservations`, {
    method: 'POST',
    token: user.body.token,
    headers: {
      'idempotency-key': randomUUID(),
      traceparent: newTraceparent(sagaTraceId),
      'x-request-id': `pd24-saga-${randomUUID()}`,
    },
    body: { items: [
      { parkingId: 'A', slotCode: sagaSlots[0], licensePlate: newPlate() },
      { parkingId: 'B', slotCode: sagaSlots[1], licensePlate: newPlate() },
      { parkingId: 'C', slotCode: `MISSING${randomBytes(2).toString('hex').toUpperCase()}`, licensePlate: newPlate() },
    ] },
  });
  assert.equal(saga.status, 201, `Saga failed to start: ${JSON.stringify(saga.body)}`);
  assert.equal(saga.body.status, 'FAILED', 'Final invalid slot must trigger compensation');
  assert.deepEqual(saga.body.steps.slice(0, 2).map((step) => step.state), ['COMPENSATED', 'COMPENSATED']);
  const sagaSpans = await requireJaegerTrace(sagaTraceId,
    (found) => found.some((span) => span.operationName === 'saga.compensate'), 'Saga compensation spans');
  assert.ok(sagaSpans.some((span) => span.serviceName === 'aggregator' && span.operationName === 'saga.start'));
  assert.ok(sagaSpans.some((span) => span.serviceName === 'aggregator' && span.operationName === 'saga.execute'));
  assert.equal(sagaSpans.filter((span) => span.serviceName === 'aggregator'
    && span.operationName === 'saga.step' && span.attributes['saga.action'] === 'compensate').length, 2);
  console.log(JSON.stringify({
    test: 'PD-07 Saga compensation trace',
    traceId: sagaTraceId,
    jaeger: `${jaeger}/trace/${sagaTraceId}`,
    spans: sagaSpans.map(({ serviceName, operationName, attributes }) => ({
      serviceName, operationName, action: attributes['saga.action'],
    })),
  }, null, 2));
} finally {
  socket?.disconnect();
  if (reservationId) {
    await request(`${nodes.A}/api/reservations/${encodeURIComponent(reservationId)}`, {
      method: 'DELETE',
      headers: { 'x-internal-key': internalKey },
    });
  }
  if (adminTokenForCleanup) {
    for (const { parkingId, code } of createdSlots) {
      await request(`${base}/api/parkings/${parkingId}/slots/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        token: adminTokenForCleanup,
      });
    }
  }
}
