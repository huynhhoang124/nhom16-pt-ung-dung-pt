// PD-12: sinh overlay Compose cho sáu bãi trên hai vùng và proxy mạng liên vùng.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ENDPOINTS = 'http://etcd-1:2379,http://etcd-2:2379,http://etcd-3:2379';
// Cả 6 bãi trong một danh sách. A–C đã có service trong docker-compose.yml nên chỉ ghi đè (base: true);
// D–F sinh đủ DB + node từ mẫu bên dưới. Bãi vùng Nam đi qua toxiproxy để giả lập trễ liên vùng.
const LOTS = [
  { id: 'A', zone: 'bac', base: true },
  { id: 'B', zone: 'bac', base: true },
  { id: 'C', zone: 'bac', base: true },
  { id: 'D', zone: 'nam', port: 8004, slots: 'CAR:1:10,CAR:2:10' },
  { id: 'E', zone: 'nam', port: 8005, slots: 'CAR:1:10,MOTO:1:10' },
  { id: 'F', zone: 'nam', port: 8006, slots: 'CAR:1:10,MOTO:1:10' },
];
const NEW_LOTS = LOTS.filter((lot) => !lot.base);
const DB_LIMITS = { command: ['postgres', '-c', 'shared_buffers=32MB'], mem_limit: '192m', shm_size: '64m' };
const sync = (id) => id === 'a' || id === 'd';
// Overlay 6 bãi ghi đè lệnh primary, không đặt synchronous_standby_names trên dòng lệnh,
// để db-x-sync-config bật đồng bộ cho A, D bằng ALTER SYSTEM sau khi replica đã streaming.
const primaryCommand = () => [...DB_LIMITS.command, '-c', 'wal_log_hints=on'];

function syncConfigService(id) {
  return {
    profiles: ['ha', 'scale'],
    image: 'postgres:16-alpine',
    environment: { PGPASSWORD: 'dev' },
    volumes: [`./postgres/configure-sync-${id}.sh:/configure-sync-${id}.sh:ro`],
    entrypoint: ['/bin/sh', `/configure-sync-${id}.sh`],
    depends_on: {
      [`db-${id}`]: { condition: 'service_healthy' },
      [`db-${id}-replica`]: { condition: 'service_healthy' },
    },
  };
}

function postgresService(id) {
  return {
    profiles: ['scale'],
    image: 'postgres:16-alpine',
    environment: { POSTGRES_PASSWORD: 'dev', POSTGRES_DB: 'parking' },
    command: primaryCommand(id),
    healthcheck: {
      test: ['CMD-SHELL', 'pg_isready -U postgres -d parking'],
      interval: '3s',
      timeout: '3s',
      retries: 30,
    },
    mem_limit: '192m',
    shm_size: '64m',
    volumes: [`db-${id}-data:/var/lib/postgresql/data`,
      './postgres/init-primary.sh:/docker-entrypoint-initdb.d/10-replication.sh:ro'],
  };
}

function replicaService(id) {
  return {
    profiles: ['ha', 'scale'],
    image: 'postgres:16-alpine',
    entrypoint: ['/bin/sh', '/replica-entrypoint.sh'],
    environment: {
      PGDATA: '/var/lib/postgresql/data', REPLICA_OF: `db-${id}`,
      REPLICATION_PASSWORD: 'replica', APPLICATION_NAME: `db-${id}-replica`,
    },
    volumes: [`db-${id}-replica-data:/var/lib/postgresql/data`,
      './postgres/replica-entrypoint.sh:/replica-entrypoint.sh:ro'],
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres'], interval: '3s', timeout: '3s', retries: 60 },
    depends_on: { [`db-${id}`]: { condition: 'service_healthy', required: false } },
  };
}

function parkingService({ id, zone, port, slots }) {
  const key = id.toLowerCase();
  return {
    profiles: ['scale'],
    build: './parking-node',
    image: 'nhom16/parking-node',
    environment: {
      INTERNAL_KEY: '${INTERNAL_KEY:?Thiếu INTERNAL_KEY (chạy cp .env.example .env)}',
      RABBITMQ_URL: '${RABBITMQ_URL:-amqp://parking:parking@rabbitmq}',
      RESERVATION_MINUTES: '${RESERVATION_MINUTES:-15}',
      JWT_PUBLIC_KEY_B64: '${JWT_PUBLIC_KEY_B64:-}',
      CORS_ORIGIN: '${CORS_ORIGIN:-http://localhost:3000}',
      ETCD_ENDPOINTS: ENDPOINTS,
      ZONE: zone,
      LEASE_TTL_S: '${LEASE_TTL_S:-5}',
      PARKING_ID: id,
      PORT: port,
      NODE_URL: `http://toxiproxy:${port + 10000}`,
      SLOTS: slots,
      DATABASE_URL: `postgres://postgres:dev@db-${key}/parking`,
      READ_DATABASE_URL: `postgres://postgres:dev@db-${key}-replica/parking`,
    },
    ports: [`${port}:${port}`],
    depends_on: { [`db-${key}`]: { condition: 'service_healthy' },
      ...(sync(key) ? { [`db-${key}-sync-config`]: { condition: 'service_completed_successfully', required: false } } : {}) },
    mem_limit: '256m',
  };
}

export function makeScaleCompose() {
  const services = {
    'db-agg': { ...DB_LIMITS },
    aggregator: { environment: { ETCD_ENDPOINTS: ENDPOINTS, ZONE: 'bac', REGIONAL_PEER_URL: 'http://aggregator-nam:8000' } },
    'aggregator-2': { profiles: ['ha', 'scale'], environment: { ETCD_ENDPOINTS: ENDPOINTS, ZONE: 'bac', REGIONAL_PEER_URL: 'http://aggregator-nam:8000' } },
    'aggregator-nam-1': { environment: { ETCD_ENDPOINTS: ENDPOINTS } },
    'aggregator-nam-2': { environment: { ETCD_ENDPOINTS: ENDPOINTS } },
  };
  const volumes = {};
  for (const lot of LOTS) {
    const id = lot.id.toLowerCase();
    services[`db-${id}-replica`] = replicaService(id);
    if (sync(id)) services[`db-${id}-sync-config`] = syncConfigService(id);
    if (lot.base) {
      services[`db-${id}`] = { ...DB_LIMITS, command: primaryCommand(id) };
      services[`parking-${id}`] = { environment: {
        ETCD_ENDPOINTS: ENDPOINTS, ZONE: lot.zone,
        READ_DATABASE_URL: `postgres://postgres:dev@db-${id}-replica/parking`,
      }, ...(sync(id) ? { depends_on: {
        [`db-${id}`]: { condition: 'service_healthy' },
        [`db-${id}-sync-config`]: { condition: 'service_completed_successfully', required: false },
      } } : {}) };
    } else {
      services[`db-${id}`] = postgresService(id);
      services[`parking-${id}`] = parkingService(lot);
      volumes[`db-${id}-data`] = {};
      volumes[`db-${id}-replica-data`] = {};
    }
  }

  services.toxiproxy = {
    profiles: ['scale'],
    image: 'ghcr.io/shopify/toxiproxy:2.9.0',
    command: ['-host=0.0.0.0', '-config=/config/scale.json'],
    ports: ['8474:8474'],
    volumes: ['./toxiproxy/scale.json:/config/scale.json:ro'],
    depends_on: NEW_LOTS.map(({ id }) => `parking-${id.toLowerCase()}`),
    mem_limit: '64m',
  };
  services['region-latency'] = {
    profiles: ['scale'],
    image: 'node:22-alpine',
    working_dir: '/app',
    command: ['node', 'configure-region-latency.mjs'],
    volumes: ['./scripts/configure-region-latency.mjs:/app/configure-region-latency.mjs:ro'],
    depends_on: ['toxiproxy'],
    restart: 'on-failure',
  };

  return { services, volumes };
}

export function makeProxyConfig() {
  return NEW_LOTS.filter((lot) => lot.zone === 'nam').map(({ id, port }) => ({
    name: `parking-${id.toLowerCase()}`,
    listen: `0.0.0.0:${port + 10000}`,
    upstream: `parking-${id.toLowerCase()}:${port}`,
    enabled: true,
  }));
}

export async function writeFiles(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const composePath = path.join(root, 'docker-compose.scale.yml');
  const proxyPath = path.join(root, 'toxiproxy', 'scale.json');
  await Promise.all([
    writeFile(composePath, `${JSON.stringify(makeScaleCompose(), null, 2)}\n`, 'utf8'),
    writeFile(proxyPath, `${JSON.stringify(makeProxyConfig(), null, 2)}\n`, 'utf8'),
  ]);
  return { composePath, proxyPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFiles()
    .then(({ composePath, proxyPath }) => {
      console.log(`Đã sinh ${composePath}`);
      console.log(`Đã sinh ${proxyPath}`);
    })
    .catch((error) => {
      console.error(`Không sinh được cấu hình 6 bãi: ${error.message}`);
      process.exitCode = 1;
    });
}
