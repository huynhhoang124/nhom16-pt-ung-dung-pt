
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const COMPOSE_FILES = [
  '-f', 'docker-compose.yml',
  '-f', 'docker-compose.pd13.yml',
];

const PARKINGS = [
  {
    id: 'A',
    db: 'db-a',
    alias: 'parking-a',
    nodes: [
      {
        service: 'parking-a',
        container: 'nhom16-parking-parking-a-1',
        url: 'http://localhost:8001/health',
      },
      {
        service: 'parking-a-2',
        container: 'nhom16-parking-parking-a-2-1',
        url: 'http://localhost:8101/health',
      },
    ],
  },
  {
    id: 'B',
    db: 'db-b',
    alias: 'parking-b',
    nodes: [
      {
        service: 'parking-b',
        container: 'nhom16-parking-parking-b-1',
        url: 'http://localhost:8002/health',
      },
      {
        service: 'parking-b-2',
        container: 'nhom16-parking-parking-b-2-1',
        url: 'http://localhost:8102/health',
      },
    ],
  },
  {
    id: 'C',
    db: 'db-c',
    alias: 'parking-c',
    nodes: [
      {
        service: 'parking-c',
        container: 'nhom16-parking-parking-c-1',
        url: 'http://localhost:8003/health',
      },
      {
        service: 'parking-c-2',
        container: 'nhom16-parking-parking-c-2-1',
        url: 'http://localhost:8103/health',
      },
    ],
  },
];

function docker(...args) {
  return execFileSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function compose(...args) {
  return docker(
    'compose',
    ...COMPOSE_FILES,
    '--profile',
    'pd13',
    ...args
  );
}

function inspect(container) {
  return JSON.parse(docker('inspect', container))[0];
}

function getNetwork(node) {
  const networks = inspect(node.container).NetworkSettings.Networks;

  // Use the Compose default network; do not hardcode container IPs.
  const entry = Object.entries(networks).find(([name]) =>
    name.endsWith('_default')
  );

  assert.ok(entry, `${node.service} không có Compose default network`);

  return entry[1];
}

function getIp(node) {
  return getNetwork(node).IPAddress;
}

function lockHolders(parking) {
  const query = `
    SELECT host(a.client_addr)
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory'
      AND l.classid = 13013
      AND l.objid = 1
      AND l.granted
    ORDER BY a.client_addr
  `.replace(/\s+/g, ' ').trim();

  const result = compose(
    'exec', '-T', parking.db,
    'psql', '-U', 'postgres', '-d', 'parking',
    '-tA', '-c', query
  );

  return result
    ? result.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    : [];
}

async function health(node) {
  try {
    const response = await fetch(node.url, {
      signal: AbortSignal.timeout(3000),
    });

    return response.status === 200;
  } catch {
    return false;
  }
}

async function until(label, callback, timeout = 30_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch {
      // Transient errors can happen during failover.
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`TC60 timeout: ${label}`);
}

function databaseTarget(node) {
  const connectionString = docker(
    'exec', node.container,
    'printenv', 'DATABASE_URL'
  );

  const db = new URL(connectionString);

  // Compare DB identity without exposing credentials.
  return `${db.hostname}:${db.port || 5432}${db.pathname}`;
}

function verifyCompose(config, parking) {
  for (const node of parking.nodes) {
    const service = config.services[node.service];

    assert.ok(service, `Thiếu Compose service ${node.service}`);

    const aliases =
      service.networks?.default?.aliases ?? [];

    assert.ok(
      aliases.includes(parking.alias),
      `${node.service} thiếu DNS alias ${parking.alias}`
    );

    assert.equal(
      service.environment.PARKING_ID,
      parking.id,
      `${node.service} sai PARKING_ID`
    );
  }
}

async function verifyInitialState(parking) {
  const [first, second] = parking.nodes;

  for (const node of parking.nodes) {
    assert.equal(
      await health(node),
      true,
      `${node.service} chưa HTTP 200`
    );

    const aliases = getNetwork(node).Aliases ?? [];

    assert.ok(
      aliases.includes(parking.alias),
      `${node.service} thiếu runtime alias ${parking.alias}`
    );
  }

  assert.equal(
    databaseTarget(first),
    databaseTarget(second),
    `Hai Node bãi ${parking.id} không dùng chung database`
  );

  const ip1 = getIp(first);
  const ip2 = getIp(second);

  assert.ok(ip1 && ip2, `Bãi ${parking.id} thiếu Docker IP`);
  assert.notEqual(ip1, ip2, `Bãi ${parking.id} trùng Docker IP`);

  await until(`bãi ${parking.id} có một chủ khóa`, () => {
    const holders = lockHolders(parking);
    return holders.length === 1 &&
      [ip1, ip2].includes(holders[0]);
  });

  const holderIp = lockHolders(parking)[0];
  const owner = parking.nodes.find(
    node => getIp(node) === holderIp
  );

  assert.ok(
    owner,
    `Bãi ${parking.id}: không tìm được Node giữ khóa ${holderIp}`
  );

  const standby = parking.nodes.find(
    node => node.container !== owner.container
  );

  return { owner, standby };
}

async function verifyFailover(parking) {
  const { owner, standby } = await verifyInitialState(parking);

  const standbyIp = getIp(standby);

  console.log(
    `[${parking.id}] Owner: ${owner.service} (${getIp(owner)})`
  );
  console.log(
    `[${parking.id}] Standby: ${standby.service} (${standbyIp})`
  );

  // Restoration is attempted even if stop/failover assertions fail.
  try {
    docker('stop', '--time', '5', owner.container);

    await until(
      `bãi ${parking.id}: standby nhận advisory lock`,
      () => {
        const holders = lockHolders(parking);
        return holders.length === 1 &&
          holders[0] === standbyIp;
      },
      30_000
    );

    await until(
      `bãi ${parking.id}: standby HTTP 200`,
      () => health(standby),
      15_000
    );

    assert.equal(
      lockHolders(parking)[0],
      standbyIp,
      `Bãi ${parking.id}: standby không giữ khóa`
    );

    console.log(
      `[${parking.id}] Failover PASS: standby giữ lock và HTTP 200`
    );
  } finally {
    // Starting a running container is harmless; this also covers
    // a stop command that succeeded before reporting an error.
    docker('start', owner.container);

    await until(
      `bãi ${parking.id}: owner phục hồi HTTP`,
      () => health(owner),
      45_000
    );
  }

  await until(
    `bãi ${parking.id}: một chủ khóa sau phục hồi`,
    () => {
      const holders = lockHolders(parking);
      const liveIps = parking.nodes.map(getIp);

      return holders.length === 1 &&
        liveIps.includes(holders[0]);
    }
  );

  for (const node of parking.nodes) {
    assert.equal(
      await health(node),
      true,
      `Bãi ${parking.id}: ${node.service} chưa HTTP 200`
    );
  }

  console.log(
    `[${parking.id}] Recovery PASS: 2 HTTP nodes, 1 lock owner`
  );
}

test('TC60 - Hai Parking Node mỗi bãi, advisory lock failover', {
  timeout: 240_000,
}, async t => {
  // All three subtests run sequentially to avoid simultaneous outages.
  const config = JSON.parse(
    compose('config', '--format', 'json')
  );

  for (const parking of PARKINGS) {
    await t.test(`Bãi ${parking.id}: two-node failover`, {
      timeout: 70_000,
    }, async () => {
      verifyCompose(config, parking);
      await verifyFailover(parking);
    });
  }
});
