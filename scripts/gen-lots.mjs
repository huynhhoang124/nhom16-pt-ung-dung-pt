// PD-12: sinh overlay Compose cho sáu bãi trên hai vùng và proxy mạng liên vùng.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ENDPOINTS = 'http://etcd-1:2379,http://etcd-2:2379,http://etcd-3:2379';
const LOTS = [
  { id: 'D', port: 8004, slots: 'CAR:1:10,CAR:2:10' },
  { id: 'E', port: 8005, slots: 'CAR:1:10,MOTO:1:10' },
  { id: 'F', port: 8006, slots: 'CAR:1:10,MOTO:1:10' },
];

function regionalAggregatorService({ zone, peerZone, instance, hostPort }) {
  const networkAliases = ['aggregator', `aggregator-${zone}`];
  return {
    profiles: ['scale'],
    build: './aggregator-service',
    image: 'nhom16/aggregator',
    environment: {
      INSTANCE_ID: `${zone}-${instance}`,
      PORT: 8000,
      DATABASE_URL: 'postgres://postgres:dev@db-agg/parking',
      RABBITMQ_URL: '${RABBITMQ_URL:-amqp://parking:parking@rabbitmq}',
      INTERNAL_KEY: '${INTERNAL_KEY:?Thiếu INTERNAL_KEY (chạy cp .env.example .env)}',
      JWT_SECRET: '${JWT_SECRET:?Thiếu JWT_SECRET (chạy cp .env.example .env)}',
      DEMO_PASSWORD: '${DEMO_PASSWORD:-123456}',
      JWT_PRIVATE_KEY_B64: '${JWT_PRIVATE_KEY_B64:-}',
      JWT_PUBLIC_KEY_B64: '${JWT_PUBLIC_KEY_B64:-}',
      ETCD_ENDPOINTS: ENDPOINTS,
      ZONE: zone,
      REGION_AGGREGATOR_URL: `http://aggregator-${peerZone}:8000`,
    },
    ...(hostPort ? { ports: [`${hostPort}:8000`] } : {}),
    networks: { default: { aliases: networkAliases } },
    depends_on: {
      'db-agg': { condition: 'service_healthy' },
      rabbitmq: { condition: 'service_healthy' },
    },
    mem_limit: '384m',
  };
}

function postgresService(id) {
  return {
    profiles: ['scale'],
    image: 'postgres:16-alpine',
    environment: { POSTGRES_PASSWORD: 'dev', POSTGRES_DB: 'parking' },
    command: ['postgres', '-c', 'shared_buffers=32MB'],
    healthcheck: {
      test: ['CMD-SHELL', 'pg_isready -U postgres -d parking'],
      interval: '3s',
      timeout: '3s',
      retries: 30,
    },
    mem_limit: '192m',
    shm_size: '64m',
    volumes: [`db-${id}-data:/var/lib/postgresql/data`],
  };
}

function parkingService({ id, port, slots }) {
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
      ZONE: 'nam',
      LEASE_TTL_S: '${LEASE_TTL_S:-5}',
      PARKING_ID: id,
      PORT: port,
      NODE_URL: `http://toxiproxy:${port + 10000}`,
      SLOTS: slots,
      DATABASE_URL: `postgres://postgres:dev@db-${key}/parking`,
    },
    ports: [`${port}:${port}`],
    depends_on: { [`db-${key}`]: { condition: 'service_healthy' } },
    mem_limit: '256m',
  };
}

export function makeScaleCompose() {
  const services = {
    'db-a': { command: ['postgres', '-c', 'shared_buffers=32MB'], mem_limit: '192m', shm_size: '64m' },
    'db-b': { command: ['postgres', '-c', 'shared_buffers=32MB'], mem_limit: '192m', shm_size: '64m' },
    'db-c': { command: ['postgres', '-c', 'shared_buffers=32MB'], mem_limit: '192m', shm_size: '64m' },
    'db-agg': { command: ['postgres', '-c', 'shared_buffers=32MB'], mem_limit: '192m', shm_size: '64m' },
    aggregator: { profiles: ['legacy'], environment: { ETCD_ENDPOINTS: ENDPOINTS, ZONE: 'bac' } },
    'aggregator-2': { profiles: ['legacy'], environment: { ETCD_ENDPOINTS: ENDPOINTS, ZONE: 'bac' } },
    frontend: { profiles: ['legacy'] },
    'parking-a': { environment: { ETCD_ENDPOINTS: ENDPOINTS, ZONE: 'bac' } },
    'parking-b': { environment: { ETCD_ENDPOINTS: ENDPOINTS, ZONE: 'bac' } },
    'parking-c': { environment: { ETCD_ENDPOINTS: ENDPOINTS, ZONE: 'bac' } },
  };
  const volumes = {};
  for (const lot of LOTS) {
    const id = lot.id.toLowerCase();
    services[`db-${id}`] = postgresService(id);
    services[`parking-${id}`] = parkingService(lot);
    volumes[`db-${id}-data`] = {};
  }

  for (const service of [
    regionalAggregatorService({ zone: 'bac', peerZone: 'nam', instance: 1, hostPort: 8000 }),
    regionalAggregatorService({ zone: 'bac', peerZone: 'nam', instance: 2, hostPort: 8010 }),
    regionalAggregatorService({ zone: 'nam', peerZone: 'bac', instance: 1 }),
    regionalAggregatorService({ zone: 'nam', peerZone: 'bac', instance: 2 }),
  ]) {
    const zone = service.environment.ZONE;
    const instance = service.environment.INSTANCE_ID;
    services[`aggregator-${zone}-${instance.slice(-1)}`] = service;
  }

  services['frontend-regional'] = {
    profiles: ['scale'],
    build: './frontend',
    ports: ['3000:80'],
    depends_on: ['aggregator-bac-1', 'aggregator-bac-2', 'aggregator-nam-1', 'aggregator-nam-2'],
  };

  services.toxiproxy = {
    profiles: ['scale'],
    image: 'ghcr.io/shopify/toxiproxy:2.9.0',
    command: ['-host=0.0.0.0', '-config=/config/scale.json'],
    ports: ['8474:8474'],
    volumes: ['./toxiproxy/scale.json:/config/scale.json:ro'],
    depends_on: LOTS.map(({ id }) => `parking-${id.toLowerCase()}`),
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
  return LOTS.map(({ id, port }) => ({
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
