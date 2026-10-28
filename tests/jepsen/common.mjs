import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const PARKING_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const BASE_URL = process.env.AGGREGATOR_URL ?? 'http://localhost:8000';
const CLUSTER_RABBITMQ_URL = [
  'amqp://parking:parking@rabbitmq/%2F',
  'amqp://parking:parking@rabbitmq-2/%2F',
  'amqp://parking:parking@rabbitmq-3/%2F',
].join(',');
export const COMPOSE_ARGS = [
  'compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.scale.yml', '-f', 'docker-compose.jepsen.yml',
  '--profile', 'scale', '--profile', 'coord', '--profile', 'ha',
];

export function docker(args, env = process.env) {
  const dockerEnv = {
    ...process.env,
    ...env,
    COMPOSE_PROJECT_NAME: env.COMPOSE_PROJECT_NAME ?? process.env.COMPOSE_PROJECT_NAME ?? 'nhom16-pd26',
    TOXIPROXY_PORT: env.TOXIPROXY_PORT ?? process.env.TOXIPROXY_PORT ?? '18474',
    ETCD_1_PORT: env.ETCD_1_PORT ?? process.env.ETCD_1_PORT ?? '12379',
    RABBITMQ_URL: env.RABBITMQ_URL ?? process.env.RABBITMQ_URL ?? CLUSTER_RABBITMQ_URL,
  };
  try {
    return execFileSync('docker', args, {
      cwd: ROOT,
      env: dockerEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    throw new Error(`docker ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`, { cause: error });
  }
}

export const compose = (args, env) => docker([...COMPOSE_ARGS, ...args], env);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createHistoryWriter(filePath) {
  const target = path.resolve(ROOT, filePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, '');
  let pending = Promise.resolve();
  return {
    filePath: target,
    write(entry) {
      pending = pending.then(() => appendFile(target, `${JSON.stringify(entry)}\n`));
      return pending;
    },
    flush() {
      return pending;
    },
  };
}

export async function fetchJson(url, options = {}) {
  const { timeoutMs = 5000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

export function publicResult(value) {
  if (Array.isArray(value)) return value.map(publicResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /^(token|qrToken|password|authorization)$/i.test(key) ? '[redacted]' : publicResult(child),
  ]));
}

export function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
