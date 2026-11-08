import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConfirmedDuringNemesis, evaluatePrimaryPair, parkingDatabaseService } from './invariants.mjs';

test('TC79 passes when confirmed commands remain present and terminal', () => {
  const operations = [
    { commandId: 'confirmed', response: { publishState: 'CONFIRMED' } },
    { commandId: 'unconfirmed', response: { publishState: 'AWAITING_RESULT' } },
  ];
  const rows = [
    { id: 'confirmed', publishState: 'CONFIRMED', status: 'DONE' },
    { id: 'unconfirmed', publishState: 'AWAITING_RESULT', status: 'FAILED' },
  ];

  assert.deepEqual(evaluateConfirmedDuringNemesis(operations, rows), {
    passed: true,
    details: '1 publisher-confirmed command(s) issued during broker isolation; 0 were missing or non-terminal; 1 remained unconfirmed',
  });
});

test('TC79 fails when a publisher-confirmed command is missing or non-terminal', () => {
  const operations = [
    { commandId: 'missing', response: { publishState: 'CONFIRMED' } },
    { commandId: 'pending', response: { publishState: 'CONFIRMED' } },
  ];
  const rows = [{ id: 'pending', publishState: 'CONFIRMED', status: 'PENDING' }];

  assert.deepEqual(evaluateConfirmedDuringNemesis(operations, rows), {
    passed: false,
    details: '2 publisher-confirmed command(s) issued during broker isolation; 2 were missing or non-terminal',
  });
});

test('TC79 fails if isolation did not exercise a publisher confirmation', () => {
  const operations = [{ commandId: 'unconfirmed', response: { publishState: 'AWAITING_RESULT' } }];
  const rows = [{ id: 'unconfirmed', publishState: 'AWAITING_RESULT', status: 'FAILED' }];

  assert.deepEqual(evaluateConfirmedDuringNemesis(operations, rows), {
    passed: false,
    details: 'no publisher-confirmed command was issued during broker isolation (1 command(s) issued)',
  });
});

test('DB invariant passes after primary failover when the stopped former primary is absent', () => {
  assert.deepEqual(evaluatePrimaryPair('A', [
    { service: 'db-a-replica', primary: true, epoch: '2' },
  ], 2), {
    passed: true,
    details: 'A: one writable primary, db_epoch=2',
  });
});

test('DB invariant fails when a running primary has a stale etcd/db epoch', () => {
  assert.deepEqual(evaluatePrimaryPair('A', [
    { service: 'db-a', primary: true, epoch: '1' },
    { service: 'db-a-replica', primary: false, epoch: '1' },
  ], 2), {
    passed: false,
    details: 'A: db-a db_epoch=1 != etcd_epoch=2',
  });
});

test('DB invariant fails if a database pair has split writable primaries', () => {
  assert.deepEqual(evaluatePrimaryPair('A', [
    { service: 'db-a', primary: true, epoch: '2' },
    { service: 'db-a-replica', primary: true, epoch: '2' },
  ], 2), {
    passed: false,
    details: 'A: 2 writable primaries among db-a, db-a-replica',
  });
});

test('database state reads follow the current primary URL from etcd', () => {
  assert.equal(parkingDatabaseService('A', 'postgres://postgres:dev@db-a-replica:5432/parking'), 'db-a-replica');
  assert.throws(() => parkingDatabaseService('A', 'postgres://postgres:dev@db-b:5432/parking'), /Unexpected etcd primary host/);
});
