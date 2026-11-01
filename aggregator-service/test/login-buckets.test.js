const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pglitePool } = require('./helpers');
const { makeLoginBuckets } = require('../src/auth');

test('PD-21: mỗi lần thử giữ 1 token; hết 5 thì khoá ở mọi bản, reset/nạp lại/dọn thì mở', async () => {
  const pool = await pglitePool();
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8'));
  const [a, b] = [makeLoginBuckets(), makeLoginBuckets()];   // như 2 bản Aggregator khác nhau
  for (let i = 0; i < 5; i++) assert.equal(await (i % 2 ? b : a).take(pool, 'user2'), true, `lần ${i + 1}`);
  assert.equal(await a.take(pool, 'user2'), false);           // lần 6 bị khoá, ở cả hai bản
  assert.equal(await b.take(pool, 'user2'), false);
  assert.equal(await a.take(pool, 'user1'), true);            // người khác không ảnh hưởng

  // Đồng thời: 20 request cùng lúc chỉ 5 cái được thử
  await a.reset(pool, 'user3');
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).take(pool, 'user3')));
  assert.equal(results.filter(Boolean).length, 5);

  await pool.query("UPDATE login_buckets SET updated_at = now() - interval '15 minutes'");
  assert.equal(await a.take(pool, 'user2'), true);            // nạp lại đủ sau 15 phút
  await b.reset(pool, 'user2');
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM login_buckets WHERE username='user2'")).rows[0].n), 0);

  await pool.query("UPDATE login_buckets SET updated_at = now() - interval '16 minutes'");
  await a.cleanup(pool);                                      // bucket đã nạp đầy bị dọn
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM login_buckets')).rows[0].n), 0);
  await pool.end();
});
