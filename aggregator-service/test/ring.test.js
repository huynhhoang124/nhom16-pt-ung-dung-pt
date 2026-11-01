const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRing, hash } = require('../src/ring');
const { createHash } = require('node:crypto');

const shards = ['db-users-1', 'db-users-2'];

test('vòng băm dùng 4 byte đầu SHA-1, không phân biệt hoa thường', () => {
  assert.equal(hash('User1'), createHash('sha1').update('user1').digest().readUInt32BE(0));
  const ring = makeRing(shards);
  assert.equal(ring.shardFor('USER1'), ring.shardFor('user1'));
  assert.equal(ring.points.length, 256);
  assert.throws(() => ring.shardFor(null), /INVALID_USERNAME/);
  assert.throws(() => makeRing([]).shardFor('user1'), /NO_USER_SHARDS/);
});

test('TC72: 10 000 username lệch không quá 10%, thêm bãi 3 chuyển 30–36%', () => {
  const ring = makeRing(shards);
  const names = Array.from({ length: 10000 }, (_, i) => `user${i}`);
  const before = names.map((name) => ring.shardFor(name));
  for (const shard of shards) {
    const count = before.filter((owner) => owner === shard).length;
    assert.ok(Math.abs(count - 5000) / 5000 <= 0.1, `${shard}: ${count}`);
  }
  ring.addShard('db-users-3');
  let moved = 0;
  names.forEach((name, i) => {
    const owner = ring.shardFor(name);
    if (owner !== before[i]) { moved++; assert.equal(owner, 'db-users-3'); }
  });
  assert.ok(moved >= 3000 && moved <= 3600, `số khoá chuyển: ${moved}`);
  assert.equal(ring.points.length, 384);
  ring.addShard('db-users-3');
  assert.equal(ring.points.length, 384);
  ring.removeShard('db-users-3');
  assert.deepEqual(names.map((name) => ring.shardFor(name)), before);
});

test('thứ tự cấu hình không làm đổi chủ khoá; vòng quay lại điểm đầu', () => {
  const a = makeRing(shards), b = makeRing([...shards].reverse());
  for (let i = 0; i < 200; i++) assert.equal(a.shardFor(`u${i}`), b.shardFor(`u${i}`));
  a.removeShard('db-users-1');
  assert.equal(a.shardFor('user1'), 'db-users-2');
  a.removeShard('db-users-2');
  assert.throws(() => a.shardFor('user1'), /NO_USER_SHARDS/);
});
