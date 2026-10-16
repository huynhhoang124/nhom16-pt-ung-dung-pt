const test = require('node:test');
const assert = require('node:assert/strict');
const { readThrough } = require('../src/db');

test('PT-02 đọc bản sao; bản sao lỗi -> đọc bản chính và bỏ qua bản sao một lúc', async () => {
  let replicaUp = true;
  const calls = [];
  const replica = { query: async (q) => { calls.push(`replica:${q}`); if (!replicaUp) throw new Error('down'); return 'R'; } };
  const primary = { query: async (q) => { calls.push(`primary:${q}`); return 'P'; } };
  let fallbacks = 0;
  const ro = readThrough(replica, primary, { backoffMs: 50, onFallback: () => fallbacks++ });
  assert.equal(await ro.query('a'), 'R');
  replicaUp = false;
  assert.equal(await ro.query('b'), 'P');              // thử bản sao, lỗi -> bản chính
  assert.equal(await ro.query('c'), 'P');              // đang bỏ qua bản sao: không thử lại
  assert.deepEqual(calls, ['replica:a', 'replica:b', 'primary:b', 'primary:c']);
  replicaUp = true;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await ro.query('d'), 'R');              // hết thời gian bỏ qua: quay lại bản sao
  assert.equal(fallbacks, 1);
});
