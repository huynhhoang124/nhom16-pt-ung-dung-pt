import { compose, etcdValue, fetchJson, PARKING_IDS, parkingProxyControl, sleep } from './config.mjs';
import { createRandom } from './random.mjs';

const LEADER_ELECTION_KEY = '/nhom16/election/aggregator-jobs';

async function toxiproxy(parkingId, enabled) {
  const { port, name } = parkingProxyControl(parkingId);
  const response = await fetchJson(`http://localhost:${port}/proxies/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
    timeoutMs: 3000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Cannot set Toxiproxy ${parkingId} enabled=${enabled}: HTTP ${response.status}`);
  }
}

async function applyNetem(service, enabled) {
  compose(['exec', '-T', service, 'tc', 'qdisc',
    ...(enabled ? ['replace', 'dev', 'eth0', 'root', 'netem', 'loss', '20%'] : ['del', 'dev', 'eth0', 'root'])]);
}

export function packetLossTargets(parkingIds = PARKING_IDS) {
  const affected = parkingIds.length === 6 ? parkingIds.slice(3) : parkingIds;
  const services = affected.map((id) => `netem-${id.toLowerCase()}`);
  return { affected, services };
}

async function runWindow({ name, durationMs, parameters, record, activate, verify, restore }) {
  const startedAt = new Date().toISOString();
  let faultStartedAt;
  let faultEndedAt;
  let result;
  let restored = false;
  const errors = [];
  try {
    result = await activate();
    faultStartedAt = new Date().toISOString();
    await sleep(durationMs);
    if (verify) result = { ...result, ...(await verify(result)) };
    faultEndedAt = new Date().toISOString();
  } catch (cause) {
    errors.push(cause);
  } finally {
    try {
      result = { ...result, ...(await restore()) };
      restored = true;
    } catch (cause) {
      errors.push(cause);
    }
  }
  const endedAt = new Date().toISOString();
  const entry = {
    type: `nemesis:${name}`,
    parameters,
    startedAt,
    faultStartedAt,
    faultEndedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    result: { ...result, restored },
    ...(errors.length && { error: errors.map((cause) => cause.message).join('; ') }),
  };
  await record(entry);
  if (errors.length) throw new AggregateError(errors, `Nemesis ${name} failed: ${entry.error}`);
  return entry;
}

function requireSixParkingNodes(type) {
  if (PARKING_IDS.length !== 6) {
    throw new Error(`${type} nemesis requires the six-node PD-12 topology`);
  }
}

function readLeader() {
  const raw = etcdValue(LEADER_ELECTION_KEY);
  if (!raw) throw new Error('Aggregator leader election key is missing from etcd');
  let leader;
  try {
    leader = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Aggregator leader election value is invalid JSON: ${error.message}`, { cause: error });
  }
  if (typeof leader.instanceId !== 'string' || !leader.instanceId) {
    throw new Error('Aggregator leader election value has no instanceId');
  }
  return leader;
}

function aggregatorService(instanceId) {
  const services = new Map([
    ['1', 'aggregator'],
    ['2', 'aggregator-2'],
    ['nam-1', 'aggregator-nam-1'],
    ['nam-2', 'aggregator-nam-2'],
  ]);
  const service = services.get(instanceId);
  if (!service) throw new Error(`No Compose service is mapped to Aggregator instance ${instanceId}`);
  return service;
}

async function waitForDatabaseFailover(parkingId, oldEpoch, timeoutMs = 45_000) {
  const epochKey = `/nhom16/parking/${parkingId}/db/epoch`;
  const primaryKey = `/nhom16/parking/${parkingId}/db/primary`;
  const replicaService = `db-${parkingId.toLowerCase()}-replica`;
  const deadline = Date.now() + timeoutMs;
  let latest = 'failover has not completed';
  while (Date.now() < deadline) {
    try {
      const [primaryUrl, epochValue] = [etcdValue(primaryKey), etcdValue(epochKey)];
      const primaryHost = primaryUrl ? new URL(primaryUrl).hostname : null;
      const epoch = Number(epochValue);
      if (primaryHost === replicaService && Number.isSafeInteger(epoch) && epoch > oldEpoch) {
        const state = JSON.parse(compose([
          'exec', '-T', replicaService, 'psql', '-U', 'postgres', '-d', 'parking', '-tA',
        ], {
          input: `SELECT json_build_object('primary', NOT pg_is_in_recovery(), 'epoch', (SELECT max(epoch)::text FROM db_epoch))::text`,
        }));
        if (state.primary && Number(state.epoch) === epoch) {
          return { newPrimary: replicaService, etcdEpoch: epoch, dbEpoch: Number(state.epoch) };
        }
        latest = `${replicaService} is not writable at etcd epoch ${epoch}`;
      } else {
        latest = `primary=${primaryHost ?? 'unset'}, etcd epoch=${epochValue ?? 'unset'}, expected epoch > ${oldEpoch}`;
      }
    } catch (error) {
      latest = error.message;
    }
    await sleep(1000);
  }
  throw new Error(`Parking ${parkingId} DB failover did not converge within ${timeoutMs}ms: ${latest}`);
}

async function runDatabaseFailover({ record }) {
  requireSixParkingNodes('db');
  const parkingId = 'A';
  const service = `db-${parkingId.toLowerCase()}`;
  const epochKey = `/nhom16/parking/${parkingId}/db/epoch`;
  const oldEpoch = Number(etcdValue(epochKey) ?? 1);
  if (!Number.isSafeInteger(oldEpoch) || oldEpoch < 1) {
    throw new Error(`Invalid initial etcd DB epoch for parking ${parkingId}: ${oldEpoch}`);
  }
  return runWindow({
    name: 'db',
    durationMs: 15_000,
    parameters: { parkingId, service, durationMs: 15_000, recovery: 'promote-replica' },
    record,
    activate: async () => ({ stoppedPrimary: service, output: compose(['stop', service]) }),
    verify: () => waitForDatabaseFailover(parkingId, oldEpoch),
    restore: async () => ({ oldPrimaryRemainsStopped: true }),
  });
}

async function waitForLeaderChange(oldInstanceId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = oldInstanceId;
  while (Date.now() < deadline) {
    try {
      latest = readLeader().instanceId;
      if (latest !== oldInstanceId) return { successorInstanceId: latest };
    } catch (error) {
      latest = error.message;
    }
    await sleep(500);
  }
  throw new Error(`Aggregator leader did not change from ${oldInstanceId} within ${timeoutMs}ms (current: ${latest})`);
}

async function runLeaderPause({ record }) {
  requireSixParkingNodes('leader');
  const initialLeader = readLeader();
  const service = aggregatorService(initialLeader.instanceId);
  const containerId = compose(['ps', '-q', service]);
  if (!containerId) throw new Error(`Leader service ${service} has no running Compose container`);
  let paused = false;
  return runWindow({
    name: 'leader',
    durationMs: 15_000,
    parameters: { instanceId: initialLeader.instanceId, service, durationMs: 15_000 },
    record,
    activate: async () => {
      const output = compose(['pause', service]);
      paused = true;
      return { pausedService: service, output };
    },
    verify: () => waitForLeaderChange(initialLeader.instanceId),
    restore: async () => {
      if (!paused) return {};
      const output = compose(['unpause', service]);
      paused = false;
      return { unpausedService: service, unpauseOutput: output };
    },
  });
}

export function randomFaultSchedule(seed, durationMs) {
  if (!Number.isSafeInteger(seed)) throw new TypeError('seed must be a safe integer');
  if (!Number.isFinite(durationMs) || durationMs < 300_000) {
    throw new RangeError('random nemesis requires at least 300 seconds');
  }
  const random = createRandom(seed);
  const types = random() < 0.5 ? ['db', 'leader'] : ['leader', 'db'];
  return types.map((type, index) => {
    const minFraction = index === 0 ? 0.15 : 0.60;
    const maxFraction = index === 0 ? 0.30 : 0.75;
    const offsetMs = Math.floor(durationMs * (minFraction + random() * (maxFraction - minFraction)));
    return { type, offsetMs };
  });
}

async function runRandomNemesis({ durationMs, seed, record }) {
  requireSixParkingNodes('random');
  const startedAt = Date.now();
  const schedule = randomFaultSchedule(seed, durationMs);
  const entries = [];
  for (const fault of schedule) {
    await sleep(Math.max(0, startedAt + fault.offsetMs - Date.now()));
    entries.push(fault.type === 'db'
      ? await runDatabaseFailover({ record })
      : await runLeaderPause({ record }));
  }
  return entries;
}

export async function runNemesis({ type, durationMs, seed = 42, record, signal }) {
  if (!['none', 'partition', 'rabbitmq', 'loss', 'db', 'leader', 'random'].includes(type)) {
    throw new Error('Unsupported nemesis; use none, partition, rabbitmq, loss, db, leader, or random');
  }
  if (type === 'none') return null;
  if (type === 'random' && durationMs < 300_000) {
    throw new Error('random nemesis requires a 300-second workload');
  }
  const delay = Math.min(10_000, Math.floor(durationMs / 4));
  await sleep(delay);
  if (signal.aborted) return null;

  if (type === 'db') return runDatabaseFailover({ record });
  if (type === 'leader') return runLeaderPause({ record });
  if (type === 'random') return runRandomNemesis({ durationMs, seed, record });

  if (type === 'partition') {
    if (PARKING_IDS.length !== 6) throw new Error('North/South partition requires six parking nodes (PD-12 topology)');
    const south = PARKING_IDS.slice(3);
    return runWindow({
      name: type,
      durationMs: 30_000,
      parameters: { north: PARKING_IDS.slice(0, 3), south, durationMs: 30_000 },
      record,
      activate: async () => {
        for (const id of south) await toxiproxy(id, false);
        return { disabledSouthProxies: south };
      },
      restore: async () => {
        const errors = [];
        for (const id of [...south].reverse()) {
          try {
            await toxiproxy(id, true);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Could not restore every South parking proxy');
      },
    });
  }

  if (type === 'rabbitmq') {
    const service = 'rabbitmq-2';
    return runWindow({
      name: type,
      durationMs: 15_000,
      parameters: { service, durationMs: 15_000 },
      record,
      activate: async () => ({ stopped: service, output: compose(['stop', service]) }),
      restore: async () => {
        compose(['start', service]);
        const deadline = Date.now() + 120_000;
        let latest = 'node has not rejoined the RabbitMQ cluster';
        while (Date.now() < deadline) {
          try {
            latest = compose(['exec', '-T', service, 'rabbitmqctl', 'cluster_status']);
            if (latest.includes(`rabbit@${service}`)) return;
          } catch (error) {
            latest = error.message;
          }
          await sleep(1000);
        }
        throw new Error(`${service} did not rejoin the RabbitMQ cluster within 120s: ${latest}`);
      },
    });
  }

  const { affected, services } = packetLossTargets();
  return runWindow({
    name: type,
    durationMs: 30_000,
    parameters: { services, affected, packetLossPercent: 20, durationMs: 30_000 },
    record,
    activate: async () => {
      for (const service of services) await applyNetem(service, true);
      return { affected, services, packetLossPercent: 20 };
    },
    restore: async () => {
      const errors = [];
      for (const service of [...services].reverse()) {
        try {
          await applyNetem(service, false);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Could not remove packet-loss rules from every proxy');
    },
  });
}
