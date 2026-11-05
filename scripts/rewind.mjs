#!/usr/bin/env node
// PD-14a: operator-controlled pg_rewind.
// Does not automatically stop, promote, restart, or delete volumes.
//
// Usage:
// node scripts/rewind.mjs --lot B --check
// node scripts/rewind.mjs --lot B --dry-run
// node scripts/rewind.mjs --lot B --execute --backup-file PATH \
//   --fencing-confirmed --confirm REWIND-B

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

const argv = process.argv.slice(2);

function option(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const lot = (option('--lot') || '').toLowerCase();
const modes = ['--check', '--dry-run', '--execute']
  .filter(x => argv.includes(x));

if (!/^[a-f]$/.test(lot) || modes.length !== 1) {
  console.error(
    'Usage: node scripts/rewind.mjs --lot A-F --check|--dry-run|--execute'
  );
  process.exit(2);
}

const mode = modes[0];
const oldName = `db-${lot}`;
const newName = `db-${lot}-replica`;

const compose = [
  'compose',
  '-f', 'docker-compose.yml',
  '-f', 'docker-compose.ha.yml',
  '--profile', 'extra',
  '--profile', 'ha',
];

const DATA = '/var/lib/postgresql/data';

function fail(message) {
  throw new Error(message);
}

function docker(args, timeout = 30000) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function serviceId(service) {
  const id = docker([
    ...compose, 'ps', '-a', '-q', service,
  ]);

  if (!id) {
    fail(`Container for ${service} not found`);
  }

  return id;
}

function inspect(id) {
  return JSON.parse(docker(['inspect', id]))[0];
}

function sql(service, query) {
  return docker([
    ...compose,
    'exec', '-T', service,
    'psql', '-U', 'postgres',
    '-d', 'postgres',
    '-AtXc', query,
  ]);
}

function controlInfo(volume) {
  return docker([
    'run', '--rm',
    '--user', 'postgres',
    '--mount',
    `type=volume,source=${volume},target=${DATA},readonly`,
    '--entrypoint', 'pg_controldata',
    'postgres:16-alpine',
    '-D', DATA,
  ]);
}

function field(info, name) {
  const line = info.split(/\r?\n/).find(
    x => x.toLowerCase().startsWith(name.toLowerCase() + ':')
  );

  if (!line) {
    fail(`pg_controldata missing field: ${name}`);
  }

  return line.slice(line.indexOf(':') + 1).trim();
}

function runRewind({ dry, volume, network }) {
  const args = [
    'run', '--rm',
    '--network', network,
    '--user', 'postgres',
    '-e', 'PGPASSWORD',

    '--mount',
    `type=volume,source=${volume},target=${DATA}${dry ? ',readonly' : ''}`,

    '--entrypoint', 'pg_rewind',
    'postgres:16-alpine',

    `--target-pgdata=${DATA}`,
    `--source-server=host=${newName} port=5432 user=postgres dbname=postgres`,

    '--no-ensure-shutdown',
    '--progress',

    ...(dry
      ? ['--dry-run']
      : ['--write-recovery-conf']),
  ];

  const result = spawnSync('docker', args, {
    stdio: 'inherit',
    timeout: 180000,
    env: {
      ...process.env,
      PGPASSWORD: process.env.PD14A_REWIND_PASSWORD,
    },
  });

  if (result.error) {
    fail(result.error.message);
  }

  if (result.status !== 0) {
    fail(
      `pg_rewind ${dry ? 'dry-run' : 'execute'} failed ` +
      `(exit ${result.status}). DO NOT start the old primary.`
    );
  }
}

try {
  console.log(
    `PD-14a ${mode}: ${oldName} (target) <- ${newName} (source)`
  );

  const old = inspect(serviceId(oldName));
  const newer = inspect(serviceId(newName));

  if (old.State.Running || old.State.Restarting) {
    fail('Old primary is running/restarting. Stop and fence it first.');
  }

  if (!newer.State.Running) {
    fail('Promoted source is not running.');
  }

  if (sql(newName, 'SELECT pg_is_in_recovery()') !== 'f') {
    fail('Source has NOT been promoted.');
  }

  if (sql(newName, 'SHOW full_page_writes') !== 'on') {
    fail('Source full_page_writes is off.');
  }

  const oldMount = old.Mounts.find(
    x => x.Destination === DATA
  );

  const newMount = newer.Mounts.find(
    x => x.Destination === DATA
  );

  if (
    !oldMount ||
    !newMount ||
    oldMount.Type !== 'volume' ||
    newMount.Type !== 'volume'
  ) {
    fail('Expected two named PostgreSQL data volumes.');
  }

  if (oldMount.Name === newMount.Name) {
    fail('Source and target share a volume!');
  }

  const info = controlInfo(oldMount.Name);

  const state = field(info, 'Database cluster state');

  if (state !== 'shut down') {
    fail(`Target not cleanly shut down: ${state}`);
  }

  const hints = field(info, 'wal_log_hints setting');
  const checksums = Number(
    field(info, 'Data page checksum version')
  );

  if (hints !== 'on' && !(checksums > 0)) {
    fail(
      'Target has neither wal_log_hints nor data checksums.'
    );
  }

  const targetSystemId = field(
    info, 'Database system identifier'
  );

  const sourceSystemId = sql(
    newName,
    'SELECT system_identifier FROM pg_control_system()'
  );

  if (targetSystemId !== sourceSystemId) {
    fail(
      'Source and target do not belong to the same PostgreSQL cluster.'
    );
  }

  const oldNetworks = Object.keys(
    old.NetworkSettings.Networks || {}
  );

  const newNetworks = Object.keys(
    newer.NetworkSettings.Networks || {}
  );

  const network = oldNetworks.find(
    x => newNetworks.includes(x)
  );

  if (!network) {
    fail('Source and target have no shared Docker network.');
  }

  console.log(
    'PASS: old stopped cleanly; source promoted; ' +
    'distinct volumes; system ID matches; ' +
    `wal_log_hints=${hints}.`
  );

  console.log(`Target volume: ${oldMount.Name}`);
  console.log(`Docker network: ${network}`);

  console.log(
    'IMPORTANT: Operator must separately confirm ' +
    'fencing/epoch, backup, WAL retention, credentials, and routing.'
  );

  if (mode === '--check') {
    console.log('CHECK PASS. No data modified.');
    process.exit(0);
  }

  if (!process.env.PD14A_REWIND_PASSWORD) {
    fail(
      'Set PD14A_REWIND_PASSWORD in the current shell. ' +
      'Do not commit it.'
    );
  }

  if (mode === '--execute') {
    const backup = option('--backup-file');

    if (
      !backup ||
      !existsSync(backup) ||
      !statSync(backup).isFile() ||
      statSync(backup).size === 0
    ) {
      fail(
        'Provide a real nonempty backup via --backup-file PATH.'
      );
    }

    if (!argv.includes('--fencing-confirmed')) {
      fail(
        'Missing --fencing-confirmed ' +
        '(manual verification required).'
      );
    }

    if (option('--confirm') !== `REWIND-${lot.toUpperCase()}`) {
      fail(
        `Pass --confirm REWIND-${lot.toUpperCase()}.`
      );
    }

    console.log('Running mandatory dry-run first...');
  }

  runRewind({
    dry: true,
    volume: oldMount.Name,
    network,
  });

  if (mode === '--dry-run') {
    console.log('DRY-RUN PASS. Target unchanged.');
    process.exit(0);
  }

  if (inspect(old.Id).State.Running) {
    fail(
      'Old primary started during dry-run; refusing execute.'
    );
  }

  console.log(
    'Dry-run PASS. Executing rewind on the ' +
    'explicitly selected old volume...'
  );

  runRewind({
    dry: false,
    volume: oldMount.Name,
    network,
  });

  console.log(
    'REWIND DONE. DO NOT start old yet. ' +
    'Configure standby authentication/passfile ' +
    'and verify standby.signal first.'
  );

  console.log(
    'After startup verify pg_is_in_recovery()=true ' +
    'and source pg_stat_replication=streaming.'
  );

} catch (error) {
  console.error(
    `FAIL: ${error.stderr?.toString()?.trim() || error.message}`
  );
  process.exit(1);
}
