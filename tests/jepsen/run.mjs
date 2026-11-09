import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, compose, fetchJson, PARKING_IDS, PROJECT, sleep, validateParkingIds } from './config.mjs';
import { createHistory } from './history.mjs';
import { checkConfirmedDuringNemesis, checkInvariants, waitForTerminalCommands } from './invariants.mjs';
import { runNemesis } from './nemesis.mjs';
import { runWorkload } from './workload.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function topologyServices(nemesis) {
  const services = [
    'aggregator', 'db-agg', 'rabbitmq', 'rabbitmq-2', 'rabbitmq-3',
    ...PARKING_IDS.flatMap((id) => {
      const suffix = id.toLowerCase();
      return [`db-${suffix}`, `db-${suffix}-replica`, `parking-${suffix}`, `toxiproxy-${suffix}`];
    }),
  ];
  if (PARKING_IDS.length === 6) {
    services.push(
      'etcd-1', 'etcd-2', 'etcd-3',
      'aggregator-nam-1', 'aggregator-nam-2',
    );
    if (['db', 'random'].includes(nemesis)) {
      services.push('failover-manager-1', 'failover-manager-2');
    }
  }
  if (process.env.JEPSEN_NEMESIS === 'loss') {
    services.push(...(PARKING_IDS.length === 6
      ? ['netem-scale']
      : PARKING_IDS.map((id) => `netem-${id.toLowerCase()}`)));
  }
  return services;
}

function parseArgs(argv) {
  const options = { seed: 42, seconds: 60, nemesis: 'rabbitmq', workers: 4, scenario: null, history: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!['--seed', '--time', '--nemesis', '--workers', '--scenario', '--history'].includes(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--seed') options.seed = Number(value);
    else if (key === '--time') options.seconds = Number(value);
    else if (key === '--nemesis') options.nemesis = value;
    else if (key === '--workers') options.workers = Number(value);
    else if (key === '--scenario') options.scenario = value;
    else options.history = value;
  }
  if (!Number.isSafeInteger(options.seed)) throw new Error('--seed must be a safe integer');
  if (!Number.isInteger(options.seconds) || options.seconds < 20 || options.seconds > 3600) {
    throw new Error('--time must be between 20 and 3600 seconds');
  }
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 32) {
    throw new Error('--workers must be an integer between 1 and 32');
  }
  if (!['none', 'partition', 'rabbitmq', 'loss', 'db', 'leader', 'random'].includes(options.nemesis)) {
    throw new Error('--nemesis must be none, partition, rabbitmq, loss, db, leader, or random');
  }
  if (options.scenario && !['tc78', 'tc79'].includes(options.scenario)) {
    throw new Error('--scenario must be tc78 or tc79');
  }
  if (options.scenario === 'tc78') {
    validateParkingIds();
    if (PARKING_IDS.length !== 6) throw new Error('TC78 requires six parking nodes; merge/use the PD-12 topology first');
    if (options.nemesis !== 'partition') throw new Error('TC78 requires --nemesis partition');
    if (options.seconds < 40) throw new Error('TC78 needs at least 40 seconds for the 30-second partition and recovery');
  }
  if (options.scenario === 'tc79') {
    if (PARKING_IDS.length !== 3) throw new Error('TC79 on this branch is configured for three parking nodes');
    if (options.nemesis !== 'rabbitmq') throw new Error('TC79 requires --nemesis rabbitmq');
    if (options.seconds < 25) throw new Error('TC79 needs at least 25 seconds to cover broker isolation and recovery');
  }
  if (options.nemesis === 'partition' && options.seconds < 40) {
    throw new Error('partition needs at least 40 seconds for the 30-second fault and recovery');
  }
  if (options.nemesis === 'loss' && options.seconds < 40) {
    throw new Error('loss needs at least 40 seconds for the 30-second fault and recovery');
  }
  if (['db', 'leader', 'random'].includes(options.nemesis) && PARKING_IDS.length !== 6) {
    throw new Error(`${options.nemesis} nemesis requires six parking nodes with PD-12/PD-14b`);
  }
  if (['db', 'leader'].includes(options.nemesis) && options.seconds < 60) {
    throw new Error(`${options.nemesis} needs at least 60 seconds for failover and recovery`);
  }
  if (options.nemesis === 'random' && options.seconds < 300) {
    throw new Error('random nemesis requires --time 300 or more');
  }
  return options;
}

const HELP = `PD-26 Jepsen-style checker

Usage:
  node tests/jepsen/run.mjs --scenario tc79 --seed 42 --time 60
  node tests/jepsen/run.mjs --scenario tc78 --seed 42 --nemesis partition --time 120
  node tests/jepsen/run.mjs --seed 42 --nemesis loss --time 60

Nemesis: none | rabbitmq | loss | partition | db | leader | random
TC79 runs on three parking nodes. TC78 requires the six-node PD-12 topology.
DB failover and leader-pause nemeses require six nodes. Random runs include both with a seeded schedule.
Set JEPSEN_PARKING_IDS=A,B,C,D,E,F to use the included six-node scale topology.`;

async function waitForTopology(record) {
  const deadline = Date.now() + 180_000;
  let latest = 'services not ready';
  while (Date.now() < deadline) {
    const startedAt = new Date().toISOString();
    try {
      const health = await fetchJson(`${BASE_URL}/health`, { timeoutMs: 2000 });
      const nodes = await fetchJson(`${BASE_URL}/api/parkings`, { timeoutMs: 3000 });
      const ready = health.status === 200 && health.body?.status === 'UP' &&
        PARKING_IDS.every((id) => nodes.body?.some((node) => node.parkingId === id && node.status === 'ONLINE'));
      const endedAt = new Date().toISOString();
      await record({
        type: 'preflight',
        startedAt,
        endedAt,
        result: {
          ready,
          aggregatorStatus: health.status,
          parkings: (nodes.body ?? []).map(({ parkingId, status }) => ({ parkingId, status })),
        },
      });
      if (ready) return;
      latest = JSON.stringify(nodes.body ?? health.body);
    } catch (error) {
      latest = error.message;
    }
    await sleep(1000);
  }
  throw new Error(`topology did not become ready within 180 seconds: ${latest}`);
}

function printChecks(checks) {
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.number}. ${check.name}: ${check.details}`);
  }
}

async function waitForRabbitNode() {
  const deadline = Date.now() + 120_000;
  let latest = 'broker is not running';
  while (Date.now() < deadline) {
    try {
      latest = compose(['exec', '-T', 'rabbitmq', 'rabbitmq-diagnostics', '-q', 'check_running']);
      return;
    } catch (error) {
      latest = error.message;
    }
    await sleep(1000);
  }
  throw new Error(`RabbitMQ primary did not become ready within 120s: ${latest}`);
}

async function waitForRabbitCluster(expected, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = 'cluster status unavailable';
  while (Date.now() < deadline) {
    try {
      latest = compose(['exec', '-T', 'rabbitmq', 'rabbitmqctl', 'cluster_status']);
      if (expected.every((node) => latest.includes(node))) return;
    } catch (error) {
      latest = error.message;
    }
    await sleep(1000);
  }
  throw new Error(`RabbitMQ cluster did not report ${expected.join(', ')} within ${timeoutMs / 1000}s: ${latest}`);
}

async function ensureAggregatorPortIsAvailable() {
  let response;
  try {
    response = await fetchJson(`${BASE_URL}/health`, { timeoutMs: 1000 });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return;
    throw new Error(`Cannot verify that ${BASE_URL} is available for Jepsen: ${error.message}`, { cause: error });
  }
  throw new Error(`HTTP ${response.status} already responds at ${BASE_URL}; stop the existing stack before starting Jepsen`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  validateParkingIds();
  await ensureAggregatorPortIsAvailable();
  process.env.JEPSEN_NEMESIS = options.nemesis;
  const startedAt = new Date().toISOString();
  const defaultHistory = path.join(ROOT, 'tests', 'jepsen', 'results',
    `run-${startedAt.replace(/[:.]/g, '-')}-seed-${options.seed}.jsonl`);
  const historyPath = options.history ? path.resolve(options.history) : defaultHistory;
  if (options.history && !path.relative(ROOT, historyPath).startsWith('..')) {
    throw new Error('custom --history must be outside the repository to avoid committing run artifacts');
  }
  await mkdir(path.dirname(historyPath), { recursive: true });
  const history = await createHistory(historyPath);
  const record = (entry) => history.append(entry);
  const controller = new AbortController();
  let nemesisEntry = null;
  let endRecorded = false;
  const failures = [];

  console.log(`PD-26 run: seed=${options.seed}, scenario=${options.scenario ?? 'general'}, nemesis=${options.nemesis}, time=${options.seconds}s`);
  console.log(`Docker project: ${PROJECT}${process.env.JEPSEN_PROJECT ? ' (preserved after run)' : ' (temporary)'}`);
  console.log(`Parking nodes: ${PARKING_IDS.join(', ')}`);
  console.log(`History: ${history.filePath}`);
  await record({ type: 'run-start', parameters: options, parkingIds: PARKING_IDS, startedAt, seed: options.seed });

  try {
    console.log('Starting isolated Jepsen Docker topology...');
    const services = topologyServices(options.nemesis);
    compose(['up', '-d', '--build', ...services.filter((service) =>
      service !== 'rabbitmq-2' && service !== 'rabbitmq-3')]);
    await waitForRabbitNode();
    compose(['up', '-d', 'rabbitmq-2']);
    await waitForRabbitCluster(['rabbit@rabbitmq', 'rabbit@rabbitmq-2']);
    compose(['up', '-d', 'rabbitmq-3']);
    await waitForRabbitCluster(['rabbit@rabbitmq', 'rabbit@rabbitmq-2', 'rabbit@rabbitmq-3']);
    const prepareRabbit = await readFile(path.join(ROOT, 'scripts', 'prepare-rabbit-ha.sh'), 'utf8');
    compose(['exec', '-T', 'rabbitmq', 'sh', '-s'], { input: prepareRabbit.replaceAll('\r\n', '\n') });
    await waitForTopology(record);
    const tasks = [
      runWorkload({
        seed: options.seed,
        durationMs: options.seconds * 1000,
        workers: options.workers,
        record,
        signal: controller.signal,
      }),
      runNemesis({
        type: options.nemesis,
        durationMs: options.seconds * 1000,
        seed: options.seed,
        record,
        signal: controller.signal,
      }).then((entry) => { nemesisEntry = entry; }),
    ].map((task) => task.catch((error) => {
      controller.abort(error);
      throw error;
    }));
    for (const outcome of await Promise.allSettled(tasks)) {
      if (outcome.status === 'rejected') failures.push(outcome.reason.message);
    }

    console.log('Waiting for services to recover...');
    await waitForTopology(record);
    console.log('Retrying accepted commands until terminal...');
    await waitForTerminalCommands(history.filePath);
    console.log('Checking the six invariants...');
    const checks = await checkInvariants({ historyPath: history.filePath });
    printChecks(checks);

    if (options.scenario === 'tc79') {
      if (!nemesisEntry || nemesisEntry.type !== 'nemesis:rabbitmq') {
        failures.push('TC79 did not complete RabbitMQ isolation');
      } else {
        const tc79 = await checkConfirmedDuringNemesis(history.filePath, nemesisEntry);
        console.log(`${tc79.passed ? 'PASS' : 'FAIL'} TC79: ${tc79.details}`);
        if (!tc79.passed) failures.push(tc79.details);
      }
    }
    if (options.nemesis === 'random') {
      const types = (Array.isArray(nemesisEntry) ? nemesisEntry : []).map((entry) => entry.type);
      if (!types.includes('nemesis:db') || !types.includes('nemesis:leader')) {
        failures.push('random nemesis did not complete both DB failover and leader pause');
      }
    }
    if (checks.some((check) => !check.passed)) failures.push('one or more invariants failed');

    const endedAt = new Date().toISOString();
    await record({ type: 'run-end', startedAt, endedAt, seed: options.seed, passed: failures.length === 0, failures });
    endRecorded = true;
    console.log(`History saved: ${history.filePath}`);
    if (failures.length) {
      for (const failure of failures) console.error(`FAIL run: ${failure}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS seed=${options.seed}`);
    }
  } catch (error) {
    controller.abort(error);
    if (!endRecorded) {
      const endedAt = new Date().toISOString();
      await record({
        type: 'run-end',
        startedAt,
        endedAt,
        seed: options.seed,
        passed: false,
        failures: [...failures, error.message],
      });
    }
    throw error;
  } finally {
    controller.abort();
    if (!process.env.JEPSEN_PROJECT) {
      try {
        compose(['down', '-v', '--remove-orphans']);
      } catch (error) {
        console.error(`Could not clean temporary Docker project ${PROJECT}: ${error.message}`);
        process.exitCode = 1;
      }
    }
    await history.close();
  }
}

main().catch((error) => {
  console.error(`PD-26 runner failed: ${error.message}`);
  process.exitCode = 1;
});
