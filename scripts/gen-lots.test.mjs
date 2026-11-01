import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeProxyConfig, makeScaleCompose } from './gen-lots.mjs';

const root = new URL('../', import.meta.url);

test('PD-12 sinh đúng ba bãi Nam với DB, node, zone và lease etcd riêng', () => {
  const { services, volumes } = makeScaleCompose();
  for (const [id, port, slots] of [
    ['D', 8004, 'CAR:1:10,CAR:2:10'],
    ['E', 8005, 'CAR:1:10,MOTO:1:10'],
    ['F', 8006, 'CAR:1:10,MOTO:1:10'],
  ]) {
    const key = id.toLowerCase();
    const parking = services[`parking-${key}`];
    assert.ok(services[`db-${key}`]);
    assert.equal(parking.environment.PARKING_ID, id);
    assert.equal(parking.environment.PORT, port);
    assert.equal(parking.environment.ZONE, 'nam');
    assert.equal(parking.environment.SLOTS, slots);
    assert.match(parking.environment.ETCD_ENDPOINTS, /etcd-3:2379/);
    assert.equal(volumes[`db-${key}-data`] !== undefined, true);
  }
  assert.equal(services.aggregator.environment.ZONE, 'bac');
  assert.equal(services['parking-a'].environment.ZONE, 'bac');
  for (const id of ['a', 'b', 'c', 'agg', 'd', 'e', 'f']) {
    assert.equal(services[`db-${id}`].mem_limit, '192m');
    const command = ['postgres', '-c', 'shared_buffers=32MB'];
    if (id !== 'agg') command.push('-c', 'wal_log_hints=on');
    assert.deepEqual(services[`db-${id}`].command, command);
  }
});

test('PD-14a sáu bãi có replica, A/D đồng bộ và mọi node có metric bản sao', () => {
  const { services, volumes } = makeScaleCompose();
  const base = readFileSync(new URL('docker-compose.yml', root), 'utf8');
  const ha = readFileSync(new URL('docker-compose.ha.yml', root), 'utf8');

  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const primary = services[`db-${id}`];
    const replica = services[`db-${id}-replica`];
    const parking = services[`parking-${id}`];
    assert.deepEqual(replica.profiles, ['ha', 'scale']);
    assert.equal(replica.environment.REPLICA_OF, `db-${id}`);
    assert.equal(replica.environment.APPLICATION_NAME, `db-${id}-replica`);
    assert.equal(replica.depends_on[`db-${id}`].condition, 'service_healthy');
    assert.equal(parking.environment.READ_DATABASE_URL, `postgres://postgres:dev@db-${id}-replica/parking`);
    if (id === 'd' || id === 'e' || id === 'f') {
      assert.ok(primary.command.includes('wal_log_hints=on'));
      assert.ok(primary.volumes.includes('./postgres/init-primary.sh:/docker-entrypoint-initdb.d/10-replication.sh:ro'));
      assert.ok(volumes[`db-${id}-replica-data`]);
    }
    if (id === 'a' || id === 'd') {
      assert.ok(!primary.command.some((arg) => arg.startsWith('synchronous_standby_names=')));
      const config = services[`db-${id}-sync-config`];
      assert.deepEqual(config.profiles, ['ha', 'scale']);
      assert.deepEqual(config.entrypoint, ['/bin/sh', `/configure-sync-${id}.sh`]);
      assert.deepEqual(config.volumes, [`./postgres/configure-sync-${id}.sh:/configure-sync-${id}.sh:ro`]);
      assert.equal(config.depends_on[`db-${id}`].condition, 'service_healthy');
      assert.equal(config.depends_on[`db-${id}-replica`].condition, 'service_healthy');
      const script = readFileSync(new URL(`postgres/configure-sync-${id}.sh`, root), 'utf8');
      assert.ok(script.includes(`ANY 1 (\\"db-${id}-replica\\")`));
      assert.match(ha, new RegExp(`db-${id}-sync-config:[\\s\\S]*?profiles: \\[ha\\]`));
      assert.equal(services[`parking-${id}`].depends_on[`db-${id}-sync-config`].required, false);
    } else if (!['b', 'c'].includes(id)) {
      assert.ok(!primary.command.some((arg) => arg.startsWith('synchronous_standby_names=')));
    }
  }
  assert.match(base, /synchronous_standby_names=/);
  assert.match(base, /db-d:[\s\S]*?profiles: \[extra, ha\]/);
});

test('PD-14a file sinh ra khớp mẫu sáu bãi', () => {
  const generated = JSON.parse(readFileSync(new URL('docker-compose.scale.yml', root), 'utf8'));
  assert.deepEqual(generated, makeScaleCompose());
});

test('PD-12 proxy tạo một tuyến liên vùng cho mỗi bãi D-F', () => {
  assert.deepEqual(makeProxyConfig(), [
    { name: 'parking-d', listen: '0.0.0.0:18004', upstream: 'parking-d:8004', enabled: true },
    { name: 'parking-e', listen: '0.0.0.0:18005', upstream: 'parking-e:8005', enabled: true },
    { name: 'parking-f', listen: '0.0.0.0:18006', upstream: 'parking-f:8006', enabled: true },
  ]);
});
