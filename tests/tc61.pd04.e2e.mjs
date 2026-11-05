// SCALE=1 node --test tests/tc61.pd04.e2e.mjs
// Chạy riêng, không chạy đồng thời với test đổi cấu hình/dừng node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* explicit environment */ }
const root = fileURLToPath(new URL('..', import.meta.url));
const base = process.env.AGGREGATOR_URL ?? 'http://localhost:8000';
const compose = (...args) => execFileSync('docker', ['compose', '-f', 'docker-compose.yml',
  '-f', 'docker-compose.scale.yml', '--profile', 'scale', '--profile', 'coord', ...args],
{ cwd: root, encoding: 'utf8', timeout: 60000 }).trim();
const sql = (id, query) => compose('exec', '-T', `db-${id.toLowerCase()}`,
  'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'parking', '-tAc', query);
async function until(fn, ms = 60000) {
  const end = Date.now() + ms;
  do {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < end);
  throw new Error('TC61: hết thời gian chờ phản hồi');
}
async function api(path, token, body, key) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', connection: 'close',
      ...(token && { authorization: `Bearer ${token}` }), ...(key && { 'idempotency-key': key }) },
    body: body && JSON.stringify(body),
  });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json();
}

test('TC61: vùng Nam 2/3 khi F tắt, 3/3 khi F bật lại trong TTL 10 phút',
  { skip: !process.env.SCALE, timeout: 750000 }, async () => {
    const ids = ['D', 'E', 'F'];
    const config = JSON.parse(compose('config', '--format', 'json'));
    assert.ok(config.services['parking-f'], 'Service thật phải là parking-f');
    const { token } = await api('/api/auth/login', null,
      { username: 'admin', password: process.env.DEMO_PASSWORD ?? '123456' });
    assert.ok(token);
    await until(async () => {
      const nodes = await api('/api/parkings');
      return ['A', 'B', 'C', ...ids].every(id => nodes.some(n => n.parkingId === id && n.status === 'ONLINE'));
    }, 120000);
    const old = Object.fromEntries(ids.map(id => [id,
      JSON.parse(sql(id, "SELECT row_to_json(p) FROM pricing_rules p WHERE vehicle_type='CAR'"))]));
    const fee = 31061;
    let broadcastId, deadlineAt;
    try {
      compose('stop', 'parking-f');
      const first = await api('/api/admin/broadcast', token, {
        zone: 'nam', type: 'setPricing', body: { rules: [{ vehicleType: 'CAR', firstBlockMin: 120,
          firstBlockFee: fee, nextHourFee: 10000, overnightFee: 30000, maxDayFee: 150000 }] },
      }, `tc61-${randomUUID()}`);
      broadcastId = first.broadcastId;
      deadlineAt = new Date(first.deadlineAt).getTime();
      assert.ok(broadcastId);
      assert.deepEqual(first.targets, ids);
      const read = () => api(`/api/admin/broadcast/${encodeURIComponent(broadcastId)}`, token);
      const partial = await until(async () => {
        const view = await read();
        return view.applied.length === 2 && view;
      });
      assert.deepEqual(partial.applied, ['D', 'E']);
      assert.deepEqual(partial.missing, ['F']);
      assert.deepEqual(partial.rejected, []);
      // Vượt TTL lệnh thường (10 s), vẫn nằm trong TTL quản trị (10 phút).
      await new Promise(resolve => setTimeout(resolve, 12000));
      compose('start', 'parking-f');
      const final = await until(async () => {
        const view = await read();
        return view.applied.length === 3 && view;
      }, Math.max(1, deadlineAt - Date.now()));
      assert.ok(Date.now() < deadlineAt, 'F phải áp dụng trước hạn 10 phút');
      assert.deepEqual(final.applied, ids);
      assert.deepEqual(final.missing, []);
      assert.deepEqual(final.rejected, []);
      for (const id of ids) assert.equal(Number(sql(id,
        "SELECT first_block_fee FROM pricing_rules WHERE vehicle_type='CAR'")), fee);
    } finally {
      compose('start', 'parking-f');
      try {
        // Không khôi phục bảng giá khi lệnh đang chờ còn có thể ghi đè lên nó.
        if (broadcastId) await until(async () => {
          const view = await api(`/api/admin/broadcast/${encodeURIComponent(broadcastId)}`, token);
          return !view.missing.length || Date.now() >= deadlineAt;
        }, Math.max(60000, deadlineAt - Date.now() + 15000));
      } finally {
        for (const id of ids) {
          const r = old[id];
          sql(id, `UPDATE pricing_rules SET first_block_min=${r.first_block_min},
            first_block_fee=${r.first_block_fee},next_hour_fee=${r.next_hour_fee},
            overnight_fee=${r.overnight_fee},max_day_fee=${r.max_day_fee ?? 'NULL'} WHERE vehicle_type='CAR'`);
        }
      }
    }
  });
