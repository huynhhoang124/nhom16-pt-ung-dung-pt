import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { checkInvariants } from './checkers.mjs';
import { BASE_URL, PARKING_IDS, ROOT, compose, createHistoryWriter, fetchJson, sleep } from './common.mjs';
import { runGenerator } from './generator.mjs';
import { runNemesis } from './nemesis.mjs';

const HELP = `Usage: node tests/jepsen/run.mjs [--seed 42] [--nemesis partition] [--time 120]
Nemesis: none | random | partition | rabbitmq | db | leader | clock-skew | loss
The runner starts the six-bay Compose topology, writes tests/jepsen/history.jsonl,
checks all six invariants, and appends the outcome to tai-lieu/ket-qua-jepsen.md.`;

function rabbitClusterReady() {
  const output = compose(['exec', '-T', 'rabbitmq', 'rabbitmqctl', 'cluster_status', '--formatter', 'json']);
  const cluster = JSON.parse(output);
  const members = [...(cluster.disk_nodes ?? cluster.nodes?.disc ?? []), ...(cluster.ram_nodes ?? cluster.nodes?.ram ?? [])];
  const running = cluster.running_nodes ?? members;
  return ['rabbit@rabbitmq', 'rabbit@rabbitmq-2', 'rabbit@rabbitmq-3']
    .every((node) => members.includes(node) && running.includes(node));
}

function parseArgs(argv) {
  const options = { seed: 42, nemesis: 'partition', time: 120, history: 'tests/jepsen/history.jsonl' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!['--seed', '--nemesis', '--time', '--history'].includes(key)) throw new Error(`Unknown option: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--seed') options.seed = Number(value);
    else if (key === '--nemesis') options.nemesis = value;
    else if (key === '--time') options.time = Number(value);
    else options.history = value;
  }
  if (!Number.isSafeInteger(options.seed)) throw new Error('--seed must be a safe integer');
  if (!Number.isInteger(options.time) || options.time < 35 || options.time > 86_400) throw new Error('--time must be 35..86400 seconds');
  if (!['none', 'random', 'partition', 'rabbitmq', 'db', 'leader', 'clock-skew', 'loss'].includes(options.nemesis)) {
    throw new Error(`Unsupported --nemesis ${options.nemesis}`);
  }
  const historyPath = path.resolve(ROOT, options.history);
  const historyRelative = path.relative(ROOT, historyPath);
  if (!options.history || path.isAbsolute(options.history) || path.posix.isAbsolute(options.history) ||
      historyRelative === '' || historyRelative === '..' || historyRelative.startsWith(`..${path.sep}`) || path.isAbsolute(historyRelative)) {
    throw new Error('--history must be a relative file path inside the repository');
  }
  return options;
}

async function waitForSixBays(record) {
  const deadline = Date.now() + 120_000;
  let lastStatus = 'Aggregator did not respond';
  while (Date.now() < deadline) {
    const startedAt = new Date().toISOString();
    try {
      const response = await fetchJson(`${BASE_URL}/api/parkings`, { timeoutMs: 3000 });
      const nodes = Array.isArray(response.body) ? response.body : [];
      const ready = PARKING_IDS.every((id) => nodes.some((node) => node.parkingId === id && node.status === 'ONLINE'));
      await record({
        type: 'preflight',
        parameters: { expectedParkingIds: PARKING_IDS },
        startedAt,
        endedAt: new Date().toISOString(),
        result: { status: response.status, nodes: nodes.map(({ parkingId, status }) => ({ parkingId, status })) },
        commandId: null,
      });
      if (response.status === 200 && ready) {
        try {
          if (rabbitClusterReady()) return;
          lastStatus = 'RabbitMQ cluster is missing one or more of its three nodes';
        } catch (error) {
          lastStatus = `RabbitMQ cluster is not ready: ${error.message}`;
        }
      } else {
        lastStatus = `six online nodes not ready: ${nodes.map((node) => `${node.parkingId}:${node.status}`).join(', ')}`;
      }
    } catch (error) {
      lastStatus = error.message;
    }
    await sleep(1000);
  }
  throw new Error(`Six-bay topology did not become ready within 120s: ${lastStatus}`);
}

function reportText({ options, startedAt, endedAt, checks, failures, historyPath }) {
  const status = failures.length === 0 && checks.every((check) => check.passed) ? 'PASS' : 'FAIL';
  const lines = [
    `## ${startedAt} · seed ${options.seed} · nemesis ${options.nemesis} · ${options.time}s — ${status}`,
    '',
    `- Thời điểm kết thúc: ${endedAt}`,
    `- Lịch sử: \`${path.relative(ROOT, historyPath).replaceAll('\\', '/')}\``,
    ...(failures.length ? ['', 'Lỗi chạy:', ...failures.map((failure) => `- ${failure}`)] : []),
    '',
    '| Bất biến | Kết quả | Chi tiết |',
    '|---|---|---|',
    ...checks.map((check) => `| ${check.name} | ${check.passed ? 'ĐẠT' : 'LỖI'} | ${check.details.replaceAll('|', '\\|')} |`),
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const history = await createHistoryWriter(options.history);
  const startedAt = new Date().toISOString();
  console.log(`PD-26 Jepsen-style run: seed=${options.seed} nemesis=${options.nemesis} duration=${options.time}s`);
  console.log(`Lịch sử: ${history.filePath}`);
  await history.write({ type: 'run-start', parameters: options, startedAt, endedAt: startedAt, result: { seed: options.seed }, commandId: null });

  const failures = [];
  let checks = [];
  try {
    console.log('Khởi động sáu bãi + RabbitMQ HA + etcd/failover topology...');
    compose(['up', '-d', '--build']);
    await waitForSixBays((entry) => history.write(entry));

    const controller = new AbortController();
    const tasks = [
      runGenerator({
        seed: options.seed,
        durationMs: options.time * 1000,
        record: (entry) => history.write(entry),
        signal: controller.signal,
      }),
      runNemesis({
        type: options.nemesis,
        durationMs: options.time * 1000,
        seed: options.seed,
        record: (entry) => history.write(entry),
        signal: controller.signal,
      }),
    ].map((task) => task.catch((error) => {
      controller.abort(error);
      throw error;
    }));
    const outcomes = await Promise.allSettled(tasks);
    for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason.message);

    console.log('Đợi recovery và kiểm tra sáu bất biến...');
    checks = await checkInvariants({ historyPath: history.filePath });
  } catch (error) {
    failures.push(error.message);
  }

  await history.flush();
  const endedAt = new Date().toISOString();
  const report = reportText({ options, startedAt, endedAt, checks, failures, historyPath: history.filePath });
  const reportPath = path.join(ROOT, 'tai-lieu', 'ket-qua-jepsen.md');
  await appendFile(reportPath, `${report}\n`);
  for (const check of checks) console.log(`${check.passed ? 'ĐẠT' : 'LỖI'} ${check.name}: ${check.details}`);
  for (const failure of failures) console.error(`LỖI chạy: ${failure}`);
  console.log(`Kết quả lưu tại ${reportPath}`);
  if (failures.length || checks.some((check) => !check.passed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`PD-26 runner failed: ${error.message}`);
  process.exitCode = 1;
});
