const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSagas } = require('../src/saga');

test('Saga bù trừ ngược các bãi đã đặt khi một bước thất bại', async () => {
  let record;
  const calls = [];
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('INSERT INTO sagas')) {
        record = { id: 'saga-1', user_id: 'user-1', created_at: new Date(), updated_at: new Date() };
        return { rows: [{ ...record, steps: JSON.parse(params[2]) }] };
      }
      if (sql.startsWith('UPDATE sagas')) {
        record.status = params[1];
        record.steps = JSON.parse(params[2]);
        return { rows: [] };
      }
      if (sql.includes('WHERE id=$1')) return { rows: [{ ...record }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const reg = {
    get: (id) => ({ id, status: 'ONLINE' }),
    async call(node, path, opts) {
      calls.push({ parkingId: node.id, path, body: opts.body });
      if (opts.method === 'DELETE') return { status: 200, json: async () => ({ status: 'CANCELLED' }) };
      if (node.id === 'C') return { status: 409, json: async () => ({ error: 'SLOT_TAKEN' }) };
      return { status: 201, json: async () => ({ id: `reservation-${node.id}` }) };
    },
  };

  const result = await makeSagas({ pool, reg }).start('user-1', 'request-1', [
    { parkingId: 'A', slotCode: 'A01', licensePlate: '30A-111.11' },
    { parkingId: 'B', slotCode: 'B01', licensePlate: '30A-222.22' },
    { parkingId: 'C', slotCode: 'C01', licensePlate: '30A-333.33' },
  ]);

  assert.equal(result.saga.status, 'FAILED');
  assert.deepEqual(result.saga.steps.map((step) => step.state), ['COMPENSATED', 'COMPENSATED', 'FAILED']);
  assert.deepEqual(calls.filter((call) => call.path.includes('/api/reservations/')).map((call) => call.parkingId), ['B', 'A']);
});
