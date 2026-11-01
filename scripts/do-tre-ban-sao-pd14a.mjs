
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const require = createRequire('/app/package.json');
const { Client } = require('pg');

const lot = (process.argv[2] ?? '').toLowerCase();
const rounds = Number(process.argv[3] ?? 20);

if (!/^[a-f]$/.test(lot) ||
    !Number.isInteger(rounds) ||
    rounds < 1 || rounds > 100) {
  console.error('Usage: node do-tre-ban-sao.mjs A [rounds]');
  process.exit(2);
}

const primaryName = `db-${lot}`;
const replicaName = `db-${lot}-replica`;
const table = 'public.pd14a_replication_probe';

function connection(host) {
  return new Client({
    host,
    port: 5432,
    user: process.env.PD14A_DB_USER ?? 'postgres',
    password: process.env.PD14A_DB_PASSWORD ?? 'dev',
    database: process.env.PD14A_DB_NAME ?? 'parking',
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
}

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p / 100) - 1];
}

async function waitUntilVisible(replica, token, timeoutMs) {
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    const result = await replica.query(
      `SELECT EXISTS(
         SELECT 1 FROM ${table} WHERE token = $1
       ) AS visible`,
      [token]
    );

    if (result.rows[0].visible) return true;

    await sleep(25);
  }

  return false;
}

async function main() {
  const primary = connection(primaryName);
  const replica = connection(replicaName);
  const tokens = [];
  const samples = [];

  try {
    await primary.connect();
    await replica.connect();

    const status = await primary.query(
      `SELECT state, sync_state
       FROM pg_stat_replication
       WHERE application_name = $1`,
      [replicaName]
    );

    const info = status.rows[0];
    if (!info || info.state !== 'streaming') {
      throw new Error(`${replicaName} is not streaming`);
    }

    const expectedSync = lot === 'a' || lot === 'd';
    const validSync = ['sync', 'quorum'].includes(info.sync_state);

    if (expectedSync ? !validSync : info.sync_state !== 'async') {
      throw new Error(
        `Unexpected sync_state: ${info.sync_state}`
      );
    }

    console.log(`Parking: ${lot.toUpperCase()}`);
    console.log(`Primary: ${primaryName}`);
    console.log(`Replica: ${replicaName}`);
    console.log(`State: ${info.state}/${info.sync_state}`);
    console.log(`Rounds: ${rounds}`);

    // Test-only table; no business data is modified.
    await primary.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        token text PRIMARY KEY
      )
    `);

    // Wait until the table itself is visible on the standby.
    let tableReady = false;
    const tableDeadline = performance.now() + 10000;

    while (performance.now() < tableDeadline) {
      const result = await replica.query(`
        SELECT to_regclass(
          'public.pd14a_replication_probe'
        ) IS NOT NULL AS ready
      `);
      if (result.rows[0].ready) {
        tableReady = true;
        break;
      }
      await sleep(50);
    }

    if (!tableReady) {
      throw new Error('Probe table did not reach replica');
    }

    for (let i = 1; i <= rounds; i++) {
      const token = randomUUID();
      tokens.push(token);

      // Start before INSERT so the result includes COMMIT.
      const start = performance.now();

      await primary.query(
        `INSERT INTO ${table}(token) VALUES($1)`,
        [token]
      );

      const committedAt = performance.now();
      const visible = await waitUntilVisible(
        replica, token, 5000
      );
      const visibleAt = performance.now();

      const commitMs = committedAt - start;
      const totalMs = visibleAt - start;
      const postCommitMs = visibleAt - committedAt;

      samples.push({
        visible, commitMs, totalMs, postCommitMs
      });

      console.log(
        `${String(i).padStart(2)} | ` +
        `commit=${commitMs.toFixed(1)}ms | ` +
        `total=${totalMs.toFixed(1)}ms | ` +
        `${visible ? 'VISIBLE' : 'TIMEOUT'}`
      );
    }

    const successful = samples.filter(s => s.visible);
    const times = successful.map(s => s.totalMs);
    const passed = successful.length === rounds &&
      times.every(t => t < 1000);

    console.log('\n--- SUMMARY ---');
    console.log(`Success: ${successful.length}/${rounds}`);

    if (times.length) {
      const avg = times.reduce((a, b) => a + b, 0)
        / times.length;

      console.log(`Average: ${avg.toFixed(1)} ms`);
      console.log(`P95: ${percentile(times, 95).toFixed(1)} ms`);
      console.log(`Maximum: ${Math.max(...times).toFixed(1)} ms`);
    }

    console.log(
      `Observed visibility < 1000 ms: ${passed ? 'PASS' : 'FAIL'}`
    );

    if (!passed) process.exitCode = 1;
  } finally {
    // Cleanup only the records created by this run.
    if (tokens.length) {
      try {
        await primary.query(
          `DELETE FROM ${table} WHERE token = ANY($1::text[])`,
          [tokens]
        );
      } catch (error) {
        console.error('Cleanup warning:', error.message);
        process.exitCode = 1;
      }
    }

    await replica.end().catch(() => {});
    await primary.end().catch(() => {});
  }
}

main().catch(error => {
  console.error('PD-14a test error:', error.message);
  process.exitCode = 1;
});
