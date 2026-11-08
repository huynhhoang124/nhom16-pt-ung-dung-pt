import test from 'node:test';
import assert from 'node:assert/strict';
import { parkingProxyControl } from './config.mjs';

test('three-node topology controls each parking proxy independently', () => {
  assert.deepEqual(parkingProxyControl('A', ['A', 'B', 'C']), {
    port: 19474,
    name: 'parking-a',
  });
});

test('six-node topology controls each South proxy independently', () => {
  for (const id of ['D', 'E', 'F']) {
    const port = { D: 19477, E: 19478, F: 19479 }[id];
    assert.deepEqual(parkingProxyControl(id, ['A', 'B', 'C', 'D', 'E', 'F']), {
      port,
      name: `parking-${id.toLowerCase()}`,
    });
  }
});

test('six-node topology keeps North proxies on their individual proxies', () => {
  for (const [id, port] of [['A', 19474], ['B', 19475], ['C', 19476]]) {
    assert.deepEqual(parkingProxyControl(id, ['A', 'B', 'C', 'D', 'E', 'F']), {
      port,
      name: `parking-${id.toLowerCase()}`,
    });
  }
});
