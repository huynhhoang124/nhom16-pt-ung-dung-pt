const test = require('node:test');
const assert = require('node:assert/strict');
const { makeConnector } = require('../src/amqp-connect');

test('all broker connection attempts disable Nagle and retain the connection timeout', async () => {
  const connector = makeConnector;
  const options = [];
  const connect = connector('amqp://one,amqp://two', async (url, socketOptions) => {
    options.push(socketOptions);
    if (url.endsWith('one')) throw new Error('offline');
    return {};
  });
  await connect();
  assert.deepEqual(options, [{ timeout: 2000, noDelay: true }, { timeout: 2000, noDelay: true }]);
});
