const test = require('node:test');
const assert = require('node:assert/strict');
const { mountMetrics } = require('../src/metrics');
const { applyEvent } = require('../src/events');

// Không cần HTTP server/DB: đọc đúng handler /metrics của app.
function metricsReader() {
  let handler;
  mountMetrics({ use() {}, get(path, fn) { if (path === '/metrics') handler = fn; } }, { reg: { all: () => [] } });
  return async () => {
    let text;
    await handler({}, { set() {}, end(value) { text = value; } });
    return text.split('\n').filter((line) => line.startsWith('hlc_drift_ms{')).sort();
  };
}

const event = (hlc, version = 1) => ({ parkingId: 'A', slot: 'A01', status: 'AVAILABLE', version, hlc });

test('hlc_drift_ms đo độ lệch tuyệt đối theo bãi, kể cả tin cũ', async (t) => {
  t.mock.method(Date, 'now', () => 1800000000000);
  const read = metricsReader();
  const cache = new Map();
  assert.equal(applyEvent(cache, event('1800000000250-0007')), true);
  assert.match((await read()).join('\n'), /parking_id="A".* 250$/);
  assert.equal(applyEvent(cache, event('1799999999900-0000')), false);
  assert.match((await read()).join('\n'), /parking_id="A".* 100$/);
  assert.equal(cache.get('A:A01').hlc, '1800000000250-0007');
});

test('HLC sai/thiếu không chặn cập nhật slot và không làm đổi gauge', async (t) => {
  t.mock.method(Date, 'now', () => 1800000000000);
  const read = metricsReader();
  const cache = new Map();
  applyEvent(cache, event('1800000000010-0000'));
  const before = await read();
  const invalid = ['bad', '1800000000000-x', '1800000000000-00000', 123, {}, '', null, undefined];
  for (const [i, value] of invalid.entries()) {
    assert.equal(applyEvent(cache, event(value, i + 2)), true);
    assert.deepEqual(cache.get('A:A01'), { status: 'AVAILABLE', version: i + 2 });
  }
  assert.deepEqual(await read(), before);
});
