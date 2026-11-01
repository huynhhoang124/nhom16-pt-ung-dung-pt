// PD-16: vòng băm nhất quán chọn phân mảnh users theo username.
// Điểm trên vòng = 4 byte đầu SHA-1 (số 0..2^32-1); mỗi phân mảnh 128 nút ảo. Thêm 1 phân mảnh chỉ chuyển ~1/N khoá.
const { createHash } = require('node:crypto');

const VNODES = 128;
const hash = (s) => createHash('sha1').update(String(s).toLowerCase()).digest().readUInt32BE(0);

function makeRing(shards = [], vnodes = VNODES) {
  const ring = { points: [], shards: new Set() };
  const sort = () => ring.points.sort((a, b) => a.at - b.at || (a.shard < b.shard ? -1 : 1));

  ring.addShard = (shard) => {
    if (ring.shards.has(shard)) return ring;
    ring.shards.add(shard);
    for (let i = 0; i < vnodes; i++) ring.points.push({ at: hash(`${shard}-${i}`), shard });
    sort();
    return ring;
  };
  ring.removeShard = (shard) => {
    ring.shards.delete(shard);
    ring.points = ring.points.filter((p) => p.shard !== shard);
    return ring;
  };
  // Điểm đầu tiên >= hash(username), quá cuối vòng thì quay về điểm đầu
  ring.shardFor = (username) => {
    if (typeof username !== 'string' || !username) throw new Error('INVALID_USERNAME');
    if (!ring.points.length) throw new Error('NO_USER_SHARDS');
    const h = hash(username);
    let lo = 0, hi = ring.points.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ring.points[mid].at < h) lo = mid + 1; else hi = mid; }
    return ring.points[lo % ring.points.length].shard;
  };

  shards.forEach(ring.addShard);
  return ring;
}

// Tên phân mảnh = host trong URL (vd db-users-1): đổi mật khẩu/cổng không làm đổi chủ khoá.
const shardName = (url) => new URL(url).hostname;

// USERS_DATABASE_URLS="postgres://...@db-users-1/users,postgres://...@db-users-2/users".
// Không cấu hình thì mọi username dùng pool db-agg như cũ.
// agg: pool db-agg, chứa bảng shard_migrations; cờ write_blocked bật khi scripts/them-phan-manh.mjs đang chuyển dữ liệu.
function makeUserShards({ urls = '', agg, makePool }) {
  const list = urls.split(',').map((u) => u.trim()).filter(Boolean);
  const writable = async () => {
    const r = await agg.query('SELECT 1 FROM shard_migrations WHERE write_blocked LIMIT 1').catch(() => ({ rows: [] }));
    return !r.rows.length;
  };
  if (!list.length) return { sharded: false, for: () => agg, all: () => [agg], writable };
  const pools = new Map(list.map((u) => [shardName(u), makePool(u)]));
  const ring = makeRing([...pools.keys()]);
  return { sharded: true, ring, for: (username) => pools.get(ring.shardFor(username)), all: () => [...pools.values()], writable };
}

module.exports = { makeRing, hash, shardName, makeUserShards, VNODES };
