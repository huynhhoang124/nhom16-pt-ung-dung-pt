import test from 'node:test';
import assert from 'node:assert/strict';
import { choose, createRandom, makeOperationId } from './random.mjs';
import { validateParkingIds } from './config.mjs';

test('a seed reproduces the same random stream', () => {
  const first = createRandom(42);
  const second = createRandom(42);
  assert.deepEqual(Array.from({ length: 20 }, first), Array.from({ length: 20 }, second));
});

test('different seeds produce different operation choices', () => {
  const first = createRandom(42);
  const second = createRandom(43);
  assert.notDeepEqual(Array.from({ length: 20 }, first), Array.from({ length: 20 }, second));
});

test('operation IDs are stable and workers do not collide', () => {
  assert.equal(makeOperationId(42, 0, 7), makeOperationId(42, 0, 7));
  assert.notEqual(makeOperationId(42, 0, 7), makeOperationId(42, 1, 7));
  assert.notEqual(makeOperationId(42, 0, 7, 'run-one'), makeOperationId(42, 0, 7, 'run-two'));
});

test('choose rejects empty collections', () => {
  assert.throws(() => choose(createRandom(1), []), /empty list/);
});

test('parking configuration only accepts three or all six unique IDs', () => {
  assert.deepEqual(validateParkingIds(['A', 'B', 'C']), ['A', 'B', 'C']);
  assert.deepEqual(validateParkingIds(['A', 'B', 'C', 'D', 'E', 'F']), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.throws(() => validateParkingIds(['A', 'B']), /three or six/);
  assert.throws(() => validateParkingIds(['A', 'B', 'C', 'D', 'E', 'X']), /unique parking IDs/);
});
