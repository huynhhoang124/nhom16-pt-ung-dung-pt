import test from 'node:test';
import assert from 'node:assert/strict';
import { packetLossTargets, randomFaultSchedule } from './nemesis.mjs';

test('packet loss targets each active proxy on a three-node topology', () => {
  assert.deepEqual(packetLossTargets(['A', 'B', 'C']), {
    affected: ['A', 'B', 'C'],
    services: ['netem-a', 'netem-b', 'netem-c'],
  });
});

test('packet loss targets the three South proxies on a six-node topology', () => {
  assert.deepEqual(packetLossTargets(['A', 'B', 'C', 'D', 'E', 'F']), {
    affected: ['D', 'E', 'F'],
    services: ['netem-d', 'netem-e', 'netem-f'],
  });
});

test('random fault schedule is reproducible and exercises DB and leader faults', () => {
  const first = randomFaultSchedule(42, 300_000);
  assert.deepEqual(randomFaultSchedule(42, 300_000), first);
  assert.deepEqual(first.map((fault) => fault.type).sort(), ['db', 'leader']);
  assert.ok(first[0].offsetMs < first[1].offsetMs);
  assert.ok(first[0].offsetMs >= 45_000 && first[0].offsetMs <= 90_000);
  assert.ok(first[1].offsetMs >= 180_000 && first[1].offsetMs <= 225_000);
  assert.notDeepEqual(randomFaultSchedule(43, 300_000), first);
});

test('random fault schedule requires the requested 300-second verification window', () => {
  assert.throws(() => randomFaultSchedule(42, 299_999), /at least 300 seconds/);
});
