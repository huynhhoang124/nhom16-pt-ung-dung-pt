const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pglitePool } = require('./helpers');
const { makeLoginBuckets } = require('../src/auth');

test('PD-21: 5 lần sai thì khoá, reset/nạp lại thì mở; 2 bản Aggregator dùng chung bucket', async () => {
  const pool = await pglitePool();
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8'));
  const [a, b] = [makeLoginBuckets(), makeLoginBuckets()];   // như 2 bản Aggregator khác nhau
  for (let i = 0; i < 5; i++) {
    assert.equal(await a.blocked(pool, 'user2'), false, `lần ${i + 1}`);
    await (i % 2 ? b : a).hit(pool, 'user2');                 // sai xen kẽ giữa 2 bản
  }
  assert.equal(await a.blocked(pool, 'user2'), true);
  assert.equal(await b.blocked(pool, 'user2'), true);
  assert.equal(await a.blocked(pool, 'user1'), false);       // người khác không ảnh hưởng

  await pool.query("UPDATE login_buckets SET updated_at = now() - interval '15 minutes'");
  assert.equal(await a.blocked(pool, 'user2'), false);       // nạp lại đủ sau 15 phút

  for (let i = 0; i < 5; i++) await a.hit(pool, 'user2');
  assert.equal(await a.blocked(pool, 'user2'), true);
  await b.reset(pool, 'user2');
  assert.equal(await a.blocked(pool, 'user2'), false);
  await pool.end();
});
