import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeRandom, makeWorkerRandom, runGenerator } from './generator.mjs';

test('seeded generator returns a reproducible sequence', () => {
  const first = makeRandom(42);
  const second = makeRandom(42);
  assert.deepEqual(Array.from({ length: 8 }, first), Array.from({ length: 8 }, second));
});

test('different seeds produce different operation streams', () => {
  const first = makeRandom(42);
  const second = makeRandom(43);
  assert.notDeepEqual(Array.from({ length: 8 }, first), Array.from({ length: 8 }, second));
});

test('workers get reproducible but distinct random streams', () => {
  const first = makeWorkerRandom(42, 0);
  const repeat = makeWorkerRandom(42, 0);
  const second = makeWorkerRandom(42, 1);
  assert.deepEqual(Array.from({ length: 8 }, first), Array.from({ length: 8 }, repeat));
  assert.notDeepEqual(Array.from({ length: 8 }, second), Array.from({ length: 8 }, makeWorkerRandom(42, 0)));
});

test('generator runs seeded workers concurrently and records their identities', async (t) => {
  let activeRequests = 0;
  let maxConcurrentRequests = 0;
  const server = createServer(async (request, response) => {
    activeRequests++;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.url === '/api/auth/login') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { username } = JSON.parse(Buffer.concat(chunks).toString());
      send(200, { token: `${username}-token`, user: { id: username } });
    } else if (request.method === 'GET' && request.url.startsWith('/api/parkings/')) {
      send(200, { slots: [{ slotCode: 'CAR:1', status: 'AVAILABLE' }] });
    } else {
      send(200, { commandId: 'user1:test-command', id: 'reservation-1' });
    }
    activeRequests--;
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const history = [];
  const controller = new AbortController();
  await runGenerator({
    seed: 42,
    durationMs: 150,
    workerCount: 4,
    signal: controller.signal,
    baseUrl: `http://127.0.0.1:${address.port}`,
    record: async (entry) => history.push(entry),
  });

  const workerIds = new Set(history
    .filter((entry) => entry.type === 'inspect')
    .map((entry) => entry.parameters.workerIndex));
  assert.deepEqual([...workerIds].sort(), [0, 1, 2, 3]);
  assert.ok(maxConcurrentRequests > 1, 'expected overlapping requests from concurrent workers');
});
