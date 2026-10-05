const test = require('node:test');
const assert = require('node:assert/strict');
const { makeConnector } = require('../src/amqp-connect');

test('PT-03 nối cụm RabbitMQ: nút đầu chết thì sang nút kế; lần sau bắt đầu từ nút đang sống', async () => {
  const dead = new Set(['amqp://r1']);
  const tried = [];
  const connect = async (u) => { tried.push(u); if (dead.has(u)) throw new Error(`down ${u}`); return { u }; };
  const c = makeConnector('amqp://r1, amqp://r2,amqp://r3', connect);
  assert.deepEqual(await c(), { u: 'amqp://r2' });
  assert.deepEqual(tried, ['amqp://r1', 'amqp://r2']);
  dead.add('amqp://r2');
  assert.deepEqual(await c(), { u: 'amqp://r3' });         // r2 vừa chết -> r3
  for (const u of ['amqp://r1', 'amqp://r3']) dead.add(u);
  await assert.rejects(c(), /down/);                        // cả cụm chết -> báo lỗi, người gọi tự thử lại sau
  dead.clear();
  assert.ok(await c());
  assert.deepEqual(await makeConnector('amqp://one', async (u) => ({ u }))(), { u: 'amqp://one' });   // 1 nút như cũ
});
