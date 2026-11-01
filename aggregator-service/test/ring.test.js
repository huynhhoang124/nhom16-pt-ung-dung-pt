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

test('mỗi user mẫu nằm đúng một phân mảnh; cờ write_blocked chặn ghi', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { pglitePool } = require('./helpers');
  const { makeUserShards } = require('../src/ring');
  const { seedUsers, makeAuth } = require('../src/auth');
  const schema = fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8');
  const dbs = { 'db-users-1': await pglitePool(), 'db-users-2': await pglitePool() };
  const agg = await pglitePool();
  for (const p of [...Object.values(dbs), agg]) await p.query(schema);
  const users = makeUserShards({
    urls: 'postgres://x@db-users-1/users,postgres://x@db-users-2/users', agg, makePool: (u) => dbs[new URL(u).hostname],
  });
  await seedUsers(users, 'pw');
  const counts = await Promise.all(Object.values(dbs).map(async (p) => Number((await p.query('SELECT count(*) AS n FROM users')).rows[0].n)));
  assert.equal(counts[0] + counts[1], 6);
  assert.ok(counts.every((n) => n > 0), `phân bố: ${counts}`);
  const auth = makeAuth('secret');
  assert.ok(await auth.login(users.for('user1'), 'user1', 'pw'));
  const other = Object.values(dbs).find((p) => p !== users.for('user1'));
  assert.equal(await auth.login(other, 'user1', 'pw'), null);

  assert.equal(await users.writable(), true);   // chưa có bảng shard_migrations
  await agg.query('CREATE TABLE shard_migrations(id SERIAL PRIMARY KEY, write_blocked BOOLEAN NOT NULL DEFAULT false)');
  await agg.query('INSERT INTO shard_migrations(write_blocked) VALUES (true)');
  assert.equal(await users.writable(), false);
  for (const p of [...Object.values(dbs), agg]) await p.end();
});
