const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { makeAuth } = require('../src/auth');
const { makeApp } = require('../src/routes');

test('administrative endpoint publishes unknown parking, preserves old routes, and maps publish outcomes', async (t) => {
  const sent = [];
  let error;
  const commands = { send: async (...args) => {
    sent.push(args);
    if (error) throw error;
    return { messageId: 'id', correlationId: 'id', status: 'BROKER_CONFIRMED' };
  } };
  const reg = { all: () => [], get: () => { throw new Error('must not precheck registry'); } };
  const app = makeApp({ pool: {}, reg, cache: new Map(), auth: makeAuth('test'), commands, commandMode:'http' });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (role = 'ADMIN', payload = { type: 'reserve', payload: { slotCode: 'A07' } }) => fetch(base + '/api/admin/parkings/UNKNOWN/commands', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt.sign({ sub: 'admin1', role }, 'test')}` }, body: JSON.stringify(payload),
  });
  const health=await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(),{status:'UP',commandsReady:true});
  assert.deepEqual(await (await fetch(base + '/api/parkings')).json(), []);
  assert.equal((await call('USER')).status, 403); assert.equal(sent.length, 0);
  const accepted = await call(); assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { messageId: 'id', correlationId: 'id', status: 'BROKER_CONFIRMED', processed: false });
  assert.deepEqual(sent[0].slice(0, 3), ['UNKNOWN', 'reserve', { slotCode: 'A07' }]);
  assert.deepEqual(sent[0][3].actor, { userId: 'admin1', role: 'ADMIN' });
  for (const [code, status] of [['PARKING_NOT_FOUND', 404], ['BROKER_UNAVAILABLE', 503], ['PUBLISH_NACKED', 503], ['PUBLISH_UNKNOWN_RESULT', 504], ['INVALID_COMMAND', 400]]) {
    error = Object.assign(new Error(code), { code, status });
    const r = await call(); assert.equal(r.status, status); assert.deepEqual(await r.json(), { error: code });
  }
});
