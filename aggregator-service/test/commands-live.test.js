const test = require('node:test');
const assert = require('node:assert/strict');
const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');
const { makeCommands } = require('../src/commands');

test('real RabbitMQ: concurrent mandatory returns, routed confirm, and reconnect', { skip: !process.env.PD01_AMQP_URL }, async (t) => {
  const url = process.env.PD01_AMQP_URL;
  const connections = [];
  const pub = makeCommands(url, { connect: async (u) => { const conn = await amqp.connect(u); connections.push(conn); return conn; } });
  t.after(() => pub.close());
  // A temporary test destination avoids placing unprocessed probe commands in cmd.A.
  const admin = await amqp.connect(url); t.after(() => admin.close());
  const ch = await admin.createChannel();
  const id = `TEST-${randomUUID()}`;
  const { queue } = await ch.assertQueue('', { exclusive: true });
  await ch.bindQueue(queue, 'parking.commands', `cmd.${id}.#`);
  const messageId = `test:${randomUUID()}`;
  const accepted = pub.send(id, 'reserve', { probe: true }, { messageId });
  const missing = Array.from({ length: 20 }, () => assert.rejects(pub.send(`MISSING-${randomUUID()}`, 'reserve', {}, { messageId }), { code: 'PARKING_NOT_FOUND', status: 404 }));
  assert.equal((await accepted).status, 'BROKER_CONFIRMED');
  await Promise.all(missing);
  const message = await ch.get(queue, { noAck: true });
  assert.equal(message.properties.messageId, messageId);
  assert.equal(message.properties.deliveryMode, 2);
  assert.deepEqual(JSON.parse(message.content).payload, { probe: true });
  assert.equal(connections.length, 1);
  await connections[0].close();
  await pub.send(id, 'cancel', {});
  assert.equal(connections.length, 2);
});

test('real isolated RabbitMQ: cmd.A reject reaches durable cmd.expired', { skip: !process.env.PD01_AMQP_URL }, async (t) => {
  // Run ONLY against an isolated test stack with no command consumers or existing commands.
  const pub = makeCommands(process.env.PD01_AMQP_URL); t.after(() => pub.close());
  const conn = await amqp.connect(process.env.PD01_AMQP_URL); t.after(() => conn.close());
  const ch = await conn.createChannel();
  const messageId = `dlx-test:${randomUUID()}`;
  await pub.send('A', 'pd01-probe', {}, { messageId });
  async function ownMessage(queue) {
    await ch.prefetch(1);
    return new Promise((resolve, reject) => {
      const consumerTag = randomUUID();
      const timer = setTimeout(() => {
        ch.cancel(consumerTag).catch(() => {});
        reject(new Error(`No probe received from ${queue}`));
      }, 5000);
      ch.consume(queue, (m) => {
        // At-least-once DLX can leave duplicate probes from a previous run.
        // Only acknowledge our own test namespace; preserve any foreign command.
        if (m && m.properties.messageId !== messageId && m.properties.messageId?.startsWith('dlx-test:') && JSON.parse(m.content).type === 'pd01-probe') {
          ch.ack(m);
          return;
        }
        clearTimeout(timer);
        ch.cancel(consumerTag).then(() => {
          if (!m || m.properties.messageId !== messageId) {
            if (m) ch.nack(m, false, true);
            reject(new Error(`${queue} is not isolated; existing message requeued`));
          } else resolve(m);
        }, reject);
      }, { consumerTag }).catch((e) => { clearTimeout(timer); reject(e); });
    });
  }
  ch.nack(await ownMessage('cmd.A'), false, false);
  const expired = await ownMessage('cmd.expired');
  assert.equal(expired.properties.headers['x-death'][0].reason, 'rejected');
  assert.equal(expired.fields.routingKey, 'expired');
  ch.ack(expired);
  await ch.close(); // round trip after ack, before closing the connection.
});
