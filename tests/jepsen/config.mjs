import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const BASE_URL = process.env.JEPSEN_BASE_URL ?? 'http://localhost:18000';
export const PROJECT = process.env.JEPSEN_PROJECT ?? `pd26-jepsen-${process.pid}-${Date.now().toString(36)}`;
export const PARKING_IDS = (process.env.JEPSEN_PARKING_IDS ?? 'A,B,C').split(',').map((id) => id.trim().toUpperCase());
export const PORTS = Object.fromEntries('ABCDEF'.split('').map((id, index) => [id, 8001 + index]));
export const TOXIPROXY_CONTROL_PORTS = Object.fromEntries('ABCDEF'.split('').map((id, index) =>
  [id, Number(process.env[`JEPSEN_TOXI_PORT_${id}`] ?? 19474 + index)]));

export function parkingProxyControl(id, parkingIds = PARKING_IDS) {
  return {
    port: TOXIPROXY_CONTROL_PORTS[id],
    name: `parking-${id.toLowerCase()}`,
  };
}

export const RABBIT_URLS = [
  'amqp://parking:parking@rabbitmq/%2F',
  'amqp://parking:parking@rabbitmq-2/%2F',
  'amqp://parking:parking@rabbitmq-3/%2F',
].join(',');

export function docker(args, { input, env = process.env } = {}) {
  try {
    return execFileSync('docker', args, {
      cwd: ROOT,
      env: {
        ...env,
        INTERNAL_KEY: env.INTERNAL_KEY ?? 'pd26-jepsen-internal-key',
        JWT_SECRET: env.JWT_SECRET ?? 'pd26-jepsen-jwt-secret',
        DEMO_PASSWORD: env.DEMO_PASSWORD ?? '123456',
        COMMAND_MODE: 'broker',
        RABBITMQ_URL: RABBIT_URLS,
        PD26_JEPSEN_NODES: JSON.stringify(PARKING_IDS.map((id) => ({
          parkingId: id,
          name: `Jepsen parking ${id}`,
          apiUrl: `http://toxiproxy-${id.toLowerCase()}:1800${PORTS[id] - 8000}`,
          address: `Jepsen ${id}`,
          publicUrl: `http://localhost:${PORTS[id]}`,
          zone: ['D', 'E', 'F'].includes(id) ? 'nam' : 'bac',
        }))),
      },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    throw new Error(`docker ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`, { cause: error });
  }
}

const composeArgs = [
  'compose', '-p', PROJECT,
  '-f', path.join(ROOT, 'docker-compose.yml'),
  ...String(process.env.JEPSEN_COMPOSE_FILES ??
    (PARKING_IDS.length === 6 ? 'docker-compose.scale.yml' : '')).split(';').filter(Boolean)
    .flatMap((file) => ['-f', path.resolve(ROOT, file)]),
  '-f', path.join(ROOT, 'docker-compose.jepsen.yml'),
  '--profile', 'ha', '--profile', 'jepsen',
  ...(PARKING_IDS.length === 6 ? ['--profile', 'scale', '--profile', 'coord'] : []),
];

export const compose = (args, options) => docker([
  ...composeArgs,
  ...(process.env.JEPSEN_NEMESIS === 'loss' ? ['--profile', 'netem'] : []),
  ...args,
], options);

export function etcdValue(key) {
  return compose([
    'exec', '-T', '-e', 'ETCDCTL_API=3', 'etcd-1',
    'etcdctl', '--endpoints=http://etcd-1:2379', 'get', '--print-value-only', key,
  ]) || null;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson(url, options = {}) {
  const { timeoutMs = 5000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

export function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function validateParkingIds(ids = PARKING_IDS) {
  if (![3, 6].includes(ids.length) || ids.some((id) => !/^[A-F]$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('PD-26 requires exactly three or six unique parking IDs from A-F');
  }
  if (ids.length === 6 && [...ids].sort().join('') !== 'ABCDEF') {
    throw new Error('six-parking topology must contain A-F');
  }
  return ids;
}
