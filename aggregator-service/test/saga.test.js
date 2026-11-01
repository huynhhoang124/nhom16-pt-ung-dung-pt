const test = require('node:test');
const assert = require('node:assert/strict');
const { startAggregator, startNode } = require('./helpers');
const { makeSagas } = require('../src/saga');
const { makeCommandProcessor } = require('../../parking-node/src/commands');
const { signature } = require('../../parking-node/src/command-signature');

const item = (parkingId) => ({ parkingId, slotCode: `${parkingId}01`, licensePlate: '30A-123.45' });

async function system(t, failedParking) {
  const nodes = {};
  for (const id of ['A', 'B', 'C']) {
    nodes[id] = await startNode(id);
    t.after(() => nodes[id].server.close());
  }
  const agg = await startAggregator(Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, n.url])));
  t.after(() => agg.server.close());
  let leader = true;
  let token = 10;
  const calls = [];
  const processors = Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id,
    makeCommandProcessor({ pool: n.pool, parkingId: id, internalKey: 'test-key' })]));
  const flow = { async execute({ parkingId, type, user, payload, key, fencingToken }) {
    const saga = (await agg.pool.query('SELECT steps FROM sagas WHERE id=$1', [payload.sagaId])).rows[0];
    calls.push({ parkingId, type, key, fencingToken, steps: saga.steps });
    if (parkingId === failedParking && type === 'reserve') return { code: 409, body: { error: 'SLOT_TAKEN' } };
    const body = { schemaVersion: 1, type, parkingId, actor: { userId: user.sub, role: 'USER' }, payload, fencingToken };
    const properties = { messageId: key, correlationId: key, replyTo: 'agg.test', type, headers: { fencingToken } };
    properties.headers['x-command-signature'] = signature('test-key', body, properties);
    const out = await processors[parkingId]({ content: Buffer.from(JSON.stringify(body)), properties,
      fields: { routingKey: `cmd.${parkingId}.${type}` } });
    return { code: out.code, body: out.body };
  } };
  const sagas = makeSagas({ pool: agg.pool, commandFlow: flow, leader: { isLeader: () => leader, getToken: () => token } });
  return { nodes, agg, calls, sagas, setLeader(v) { leader = v; }, setToken(v) { token = v; } };
}

test('TC75: ba bãi chỉ ACTIVE sau khi confirm; nhật ký ghi trước mỗi lệnh', async (t) => {
  const { nodes, calls, sagas } = await system(t);
  const { saga } = await sagas.start('user1', 'three', ['A', 'B', 'C'].map(item));
  assert.equal(saga.status, 'COMPLETED');
  assert.deepEqual(saga.steps.map((s) => s.state), ['DONE', 'DONE', 'DONE']);
  assert.deepEqual(calls.map((c) => c.type), ['reserve', 'reserve', 'reserve', 'confirm', 'confirm', 'confirm']);
  assert(calls.every((c) => c.steps.some((s) => s.messageId === c.key)));
  assert(calls.every((c) => c.fencingToken === 10));
  for (const id of ['A', 'B', 'C']) {
    assert.equal((await nodes[id].pool.query('SELECT status FROM reservations')).rows[0].status, 'ACTIVE');
  }
});

test('TC76: bước ba lỗi; leader mới tiếp tục bù trừ đang dở', async (t) => {
  const { nodes, agg, calls, sagas, setLeader, setToken } = await system(t, 'C');
  const { saga } = await sagas.start('user1', 'fail', ['A', 'B', 'C'].map(item));
  assert.equal(saga.status, 'FAILED');
  assert.deepEqual(saga.steps.map((s) => s.state), ['COMPENSATED', 'COMPENSATED', 'FAILED']);
  assert.deepEqual(calls.map((c) => c.type), ['reserve', 'reserve', 'reserve', 'cancel', 'cancel']);
  const id = saga.id;
  await agg.pool.query("UPDATE sagas SET status='COMPENSATING', steps=jsonb_set(steps,'{0,state}','\"DONE\"'), updated_at=now()-interval '2 minutes' WHERE id=$1", [id]);
  setLeader(false);
  assert.equal(await sagas.recover(0), 0);
  setToken(11); setLeader(true);
  assert.equal(await sagas.recover(0), 1);
  assert.equal((await agg.pool.query('SELECT status FROM sagas WHERE id=$1', [id])).rows[0].status, 'FAILED');
  assert.equal((await nodes.A.pool.query('SELECT status FROM reservations')).rows[0].status, 'CANCELLED');
});

test('follower chỉ ghi PENDING; leader nhận và chạy saga', async (t) => {
  const { agg, sagas, setLeader } = await system(t);
  setLeader(false);
  const { saga } = await sagas.start('user1', 'pending', ['A', 'B'].map(item));
  assert.equal(saga.status, 'PENDING');
  setLeader(true);
  assert.equal(await sagas.recover(0), 1);
  assert.equal((await agg.pool.query('SELECT status FROM sagas WHERE id=$1', [saga.id])).rows[0].status, 'COMPLETED');
});
