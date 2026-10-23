const test = require('node:test');
const assert = require('node:assert/strict');

const { createHlc, compareHlc } = require('../src/hlc');

test('now tạo HLC đúng định dạng và tăng khi giờ vật lý đứng yên', () => {
  const clock = createHlc({
    clock: () => 1_800_000_000_000,
    skewMs: 0,
  });

  const first = clock.now();
  const second = clock.now();

  assert.match(first, /^\d{13}-\d{4}$/);
  assert.equal(first, '1800000000000-0000');
  assert.equal(second, '1800000000000-0001');
  assert.ok(compareHlc(second, first) > 0);
});

test('update nhận HLC xa hơn và duy trì thứ tự nhân quả', () => {
  const clock = createHlc({
    clock: () => 1_800_000_000_000,
    skewMs: 0,
  });

  const remote = '1800000000100-0007';

  assert.equal(clock.update(remote), '1800000000100-0008');
  assert.equal(clock.now(), '1800000000100-0009');
});

test('đồng hồ vật lý chạy lùi không làm HLC chạy lùi', () => {
  let physical = 1_800_000_001_000;

  const clock = createHlc({
    clock: () => physical,
    skewMs: 0,
  });

  const first = clock.now();

  physical -= 5_000;

  const second = clock.now();

  assert.ok(compareHlc(second, first) > 0);
});

test('CLOCK_SKEW_MS chỉ dịch thành phần thời gian của HLC', () => {
  const clock = createHlc({
    clock: () => 1_800_000_000_000,
    skewMs: 30_000,
  });

  assert.equal(clock.now(), '1800000030000-0000');
});

test('bộ đếm tràn thì tăng thành phần thời gian logic', () => {
  const clock = createHlc({
    clock: () => 1_800_000_000_000,
    skewMs: 0,
  });

  assert.equal(
    clock.update('1800000000000-9999'),
    '1800000000001-0000',
  );
});

test('update từ chối timestamp sai định dạng', () => {
  const clock = createHlc({
    clock: () => 1_800_000_000_000,
    skewMs: 0,
  });

  assert.throws(
    () => clock.update('not-an-hlc'),
    /HLC không đúng định dạng/,
  );
});