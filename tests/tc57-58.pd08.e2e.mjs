// Stack cô lập: COMMAND_MODE=broker docker compose -p pd08-b11-test -f docker-compose.yml
//   -f tests/pd08-compose.test.yml up -d --build
// COMMAND_MODE=broker COMPOSE_PROJECT_NAME=pd08-b11-test node --test tests/tc57-58.pd08.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* explicit environment */ }
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../aggregator-service/package.json', import.meta.url));
const amqp = require('amqplib');
const base = process.env.AGGREGATOR_URL ?? 'http://localhost:18010';
const nodeUrl = process.env.PARKING_A_URL ?? 'http://localhost:18101';
const key = process.env.INTERNAL_KEY ?? 'dev';
const compose = (args, env = {}) => execFileSync('docker', ['compose', '-f', 'docker-compose.yml',
  '-f', 'tests/pd08-compose.test.yml', ...args],
{ cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 }).trim();
const sql = (service, query) => compose(['exec', '-T', service, 'psql', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', 'parking', '-tAc', query]);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
async function until(fn, ms = 45000) {
  const end = Date.now() + ms;
  do {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < end);
  throw new Error('TC57/58: hết thời gian chờ broker/DB');
}
async function http(url, { token, method = 'GET', body, requestKey, internal = false } = {}) {
  const response = await fetch(url, {
    method, signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', connection: 'close',
      ...(token && { authorization: `Bearer ${token}` }),
      ...(requestKey && { 'idempotency-key': requestKey }),
      ...(internal && { 'x-internal-key': key }) },
    body: body && JSON.stringify(body),
  });
  return { code: response.status, body: await response.json() };
}

test('PD-08 + PD-03: TC57 retry DONE, TC58 retry hết giới hạn FAILED',
  { skip: process.env.COMMAND_MODE !== 'broker', timeout: 360000 }, async t => {
    assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', /^pd08-[a-z0-9-]+$/,
      'Chỉ chạy trên project pd08-* cô lập');
    const config = JSON.parse(compose(['config', '--format', 'json']));
    assert.equal(config.services.aggregator.environment.COMMAND_MODE, 'broker');
    assert.ok(Number(config.services.aggregator.environment.COMMAND_TTL_MS) >= 60000,
      'TTL phải đủ cho retry 2 s + 10 s');
    assert.equal(config.services['parking-a'].environment.NODE_ENV, 'test');
    const originalFault = config.services['parking-a'].environment;
    const login = await http(base + '/api/auth/login', { method: 'POST',
      body: { username: 'user1', password: process.env.DEMO_PASSWORD ?? '123456' } });
    assert.equal(login.code, 200);
    const { token, user } = login.body;
    assert.ok(token && user.id);
    const conn = await amqp.connect(process.env.PD08_AMQP_URL ?? 'amqp://parking:parking@localhost:5683/%2F');
    let ch;
    try {
      ch = await conn.createChannel();
      // Quan sát bản sao DLQ, không giành tin của worker cmd.dead đang chạy thật.
      const probe = await ch.assertQueue('', { exclusive: true });
      await ch.bindQueue(probe.queue, 'parking.dlx', 'dead');
      for (const [name, failures, expected] of [['TC57', 2, 'DONE'], ['TC58', 3, 'FAILED']]) {
        await t.test(`${name}: ${failures} lỗi tạm thời → ${expected}`, async () => {
          const requestKey = `${name}-${randomUUID()}`;
          const commandId = `${user.id}:${requestKey}`;
          let reservationId;
          try {
            compose(['up', '-d', '--no-deps', '--force-recreate', 'parking-a'],
              { PD08_FAULT_ID: commandId, PD08_FAULT_COUNT: String(failures) });
            await until(async () => {
              try {
                const health = await fetch(nodeUrl + '/health', { signal: AbortSignal.timeout(2000) });
                const nodes = await http(base + '/api/parkings');
                const queue = await ch.checkQueue('cmd.A');
                return health.ok && queue.consumerCount === 1 &&
                  nodes.body.some(n => n.parkingId === 'A' && n.status === 'ONLINE');
              } catch { return false; }
            }, 90000);
            const slots = await http(nodeUrl + '/api/slots/available', { internal: true });
            assert.equal(slots.code, 200);
            assert.ok(slots.body.length, 'Cần ít nhất một chỗ trống');
            const started = Date.now();
            const sent = await http(base + '/api/parkings/A/reservations', {
              token, method: 'POST', requestKey,
              body: { slotCode: slots.body[0].slotCode,
                licensePlate: `30A${String(Math.floor(Math.random() * 90000) + 10000)}` },
            });
            assert.equal(sent.code, 202);
            assert.equal(sent.body.commandId, commandId);
            const read = () => http(base + `/api/commands/${encodeURIComponent(commandId)}`, { token });
            const final = await until(async () => {
              const result = await read();
              assert.equal(result.code, 200);
              return result.body.status !== 'PENDING' && result.body;
            });
            reservationId = final.result?.id;
            assert.equal(final.status, expected);
            assert.ok(Date.now() - started >= 11900, 'Phải đi qua hai hàng retry 2 s và 10 s');
            const count = Number(sql('db-a',
              `SELECT count(*) FROM reservations WHERE request_id=${quote(commandId)}`));
            if (expected === 'DONE') {
              assert.equal(count, 1);
              assert.ok(reservationId);
              assert.equal(final.statusCode, 201);
              assert.equal(Number(sql('db-a',
                `SELECT count(*) FROM inbox_messages WHERE message_id=${quote(commandId)}`)), 1);
            } else {
              assert.equal(count, 0);
              const dead = await until(async () => {
                const m = await ch.get(probe.queue, { noAck: true });
                return m?.properties.messageId === commandId && m;
              });
              assert.equal(dead.properties.headers['x-retry'], 2);
              assert.equal(dead.properties.headers['x-failure-reason'], 'RETRY_EXHAUSTED');
              assert.equal(Number(sql('db-agg', `SELECT count(*) FROM dead_letters
                WHERE message_id=${quote(commandId)} AND reason='RETRY_EXHAUSTED'`)), 1);
              assert.equal(sql('db-agg', `SELECT status FROM commands WHERE id=${quote(commandId)}`), 'FAILED');
              assert.equal(final.result.error, 'RETRY_EXHAUSTED');
              assert.equal((await read()).body.status, 'FAILED');
            }
          } finally {
            // Kể cả assertion lỗi sau khi reserve, tìm reservation thật để huỷ đúng bản ghi của test.
            reservationId ??= sql('db-a', `SELECT id FROM reservations WHERE request_id=${quote(commandId)}`);
            if (reservationId) {
              const cancelled = await http(nodeUrl + `/api/reservations/${reservationId}`,
                { method: 'DELETE', internal: true });
              assert.equal(cancelled.code, 200);
            }
          }
        });
      }
    } finally {
      try {
        compose(['up', '-d', '--no-deps', '--force-recreate', 'parking-a'], {
          PD08_FAULT_ID: originalFault.RETRY_TEST_MESSAGE_ID,
          PD08_FAULT_COUNT: String(originalFault.RETRY_TEST_FAILURES),
        });
      } finally {
        await ch?.close().catch(() => {});
        await conn.close();
      }
    }
  });
