const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlate, isPlate } = require('../src/plate');

test('biển số: chuẩn hoá và kiểm định dạng', () => {
  assert.equal(normalizePlate(' 30a-123.45 '), '30A12345');
  for (const ok of ['30A-123.45', '30A-1234', '29B1-123.45', '51LD-123.45', '29-B1 1234']) assert.ok(isPlate(normalizePlate(ok)), ok);
  for (const bad of ['', 'abc', '3A-12345', '30-12345', '30A-123', '30ABC-12345', '30A-1234567']) assert.ok(!isPlate(normalizePlate(bad)), bad);
});
