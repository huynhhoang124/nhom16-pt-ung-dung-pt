// Prepared integration contract for PD-03. Must not pass by exercising only the legacy HTTP path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('TC52 HTTP broker contract: pending PD-03 request-reply and command lookup', {
  skip: process.env.PD03_HTTP_COMMANDS !== '1' ? 'PD-03 not implemented; TC52 currently verified at broker level' : false,
  timeout: 120000,
}, async (t) => {
  try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}
  const base = process.env.PD03_HTTP_BASE ?? 'http://localhost:8000';
  const request = async (url, token, options = {}) => {
    const r = await fetch(base + url, { ...options, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers } });
    return { status: r.status, body: await r.json() };
  };
  const logged = await request('/api/auth/login', null, { method: 'POST', body: JSON.stringify({ username: 'user1', password: process.env.DEMO_PASSWORD ?? '123456' }) });
  assert.equal(logged.status, 200);
  const token = logged.body.token;
  const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub;
  const parkingId = 'A';
  const detail = await request(`/api/parkings/${parkingId}`, token);
  const slot = detail.body.slots.find((s) => s.status === 'AVAILABLE'); assert(slot);
  const key = `http-${randomUUID()}`;
  const commandId = `${userId}:${key}`;
  let reservationId;
  t.after(async () => {
    if (!reservationId) {
      const mine = await request('/api/me/reservations', token);
      reservationId = mine.body.reservations?.find((r) => r.parkingId === parkingId && r.requestId === commandId)?.id;
    }
    if (reservationId) await request(`/api/parkings/${parkingId}/reservations/${reservationId}`, token, { method: 'DELETE' });
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => request(`/api/parkings/${parkingId}/reservations`, token, {
    method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify({ slotCode: slot.slotCode, licensePlate: '30A-665.52' }),
  })));
  assert(results.every((r) => [200, 201, 202].includes(r.status)));
  // This endpoint is absent before PD-03: legacy HTTP idempotency alone is insufficient evidence.
  let command;
  for (let i = 0; i < 100; i++) {
    command = await request(`/api/commands/${encodeURIComponent(commandId)}`, token);
    assert.equal(command.status, 200, 'Requires PD-03 command lookup, not just old HTTP routes');
    if (command.body.status === 'DONE') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(command.body.status, 'DONE');
  reservationId = command.body.result.id;
  assert(reservationId);
  const mine = await request('/api/me/reservations', token);
  assert.equal(mine.body.reservations.filter((r) => r.parkingId === parkingId && r.requestId === commandId).length, 1);
});
