import { readFile } from 'node:fs/promises';
import { BASE_URL, PARKING_IDS, compose, etcdValue, fetchJson, parkingProxyControl, quoteSql, sleep } from './config.mjs';

function sqlJson(service, query) {
  const raw = compose(['exec', '-T', service, 'psql', '-U', 'postgres', '-d', 'parking', '-tA'], { input: query });
  return JSON.parse(raw);
}

async function acceptedOperations(historyPath) {
  const contents = await readFile(historyPath, 'utf8');
  const accepted = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.type === 'operation' && entry.accepted && entry.commandId) {
      accepted.set(entry.commandId, entry);
    }
  }
  return [...accepted.values()];
}

async function commandRows(historyPath) {
  const operations = await acceptedOperations(historyPath);
  const ids = operations.map((entry) => entry.commandId);
  const array = ids.length ? `ARRAY[${ids.map(quoteSql).join(',')}]::text[]` : 'ARRAY[]::text[]';
  return sqlJson('db-agg', `SELECT COALESCE(json_agg(json_build_object(
    'id', id, 'status', status, 'statusCode', status_code, 'parkingId', parking_id,
    'type', type, 'payload', payload, 'publishState', publish_state
  )), '[]'::json)::text FROM commands WHERE id = ANY(${array})`);
}

export async function waitForTerminalCommands(historyPath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let pending = [];
  while (Date.now() < deadline) {
    const operations = await acceptedOperations(historyPath);
    const rows = await commandRows(historyPath);
    const byId = new Map(rows.map((row) => [row.id, row]));
    pending = operations.filter((entry) => !['DONE', 'FAILED', 'EXPIRED'].includes(byId.get(entry.commandId)?.status));
    if (!pending.length) return;
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${pending.length} accepted commands did not reach a terminal state within ${timeoutMs}ms`);
}

function expectedEffects(rows, parkingId) {
  return JSON.stringify(rows
    .filter((row) => row.parkingId === parkingId && Number(row.statusCode) >= 200 && Number(row.statusCode) < 300)
    .map((row) => ({
      id: row.id,
      type: row.type,
      reservationId: row.payload?.reservationId ?? null,
    })));
}

function parkingSnapshotSql(expectedJson) {
  const expected = `${quoteSql(expectedJson)}::jsonb`;
  return `WITH expected AS (
      SELECT * FROM jsonb_to_recordset(${expected}) AS e(id text, type text, "reservationId" text)
    ), versions AS (
      SELECT slot_code, (payload->>'version')::bigint AS version,
        lag((payload->>'version')::bigint) OVER (PARTITION BY slot_code ORDER BY id) AS previous
      FROM parking_events
      WHERE payload ? 'version' AND payload->>'version' ~ '^[0-9]+$'
    )
    SELECT json_build_object(
      'overlaps', (SELECT count(*) FROM reservations a JOIN reservations b
        ON a.slot_id=b.slot_id AND a.id<b.id
        AND a.status IN ('ACTIVE','USED') AND b.status IN ('ACTIVE','USED')
        AND tstzrange(a.start_time,a.end_time) && tstzrange(b.start_time,b.end_time)),
      'duplicateRequests', (SELECT count(*) FROM (
        SELECT request_id FROM reservations GROUP BY request_id HAVING count(*) > 1
      ) duplicates),
      'openSessions', (SELECT count(*) FROM (
        SELECT slot_id FROM parking_sessions WHERE exited_at IS NULL
        GROUP BY slot_id HAVING count(*) > 1
      ) duplicates),
      'pendingEvents', (SELECT count(*) FROM parking_events WHERE published_at IS NULL),
      'pendingReplies', (SELECT count(*) FROM command_reply_outbox WHERE published_at IS NULL),
      'versionGaps', (SELECT count(*) FROM versions WHERE previous IS NOT NULL AND version <> previous + 1),
      'badEffects', (SELECT count(*) FROM expected e WHERE
        (e.type = 'reserve' AND (
          (SELECT count(*) FROM inbox_messages i WHERE i.message_id=e.id AND i.processed_at IS NOT NULL) <> 1
          OR (SELECT count(*) FROM reservations r WHERE r.request_id=e.id) <> 1
        ))
        OR (e.type = 'cancel' AND (
          (SELECT count(*) FROM inbox_messages i WHERE i.message_id=e.id AND i.processed_at IS NOT NULL) <> 1
          OR (SELECT count(*) FROM reservations r WHERE r.id::text=e."reservationId" AND r.status='CANCELLED') <> 1
        ))
      ),
      'slots', (SELECT COALESCE(json_agg(json_build_object(
        'slotCode', slot_code, 'status', status, 'version', version
      ) ORDER BY slot_code), '[]'::json) FROM parking_slots WHERE status <> 'HIDDEN')
    )::text`;
}

export function parkingDatabaseService(parkingId, primaryUrl = null) {
  const primary = `db-${parkingId.toLowerCase()}`;
  const replica = `${primary}-replica`;
  if (!primaryUrl) return primary;
  const host = new URL(primaryUrl).hostname;
  if (host !== primary && host !== replica) {
    throw new Error(`Unexpected etcd primary host for parking ${parkingId}: ${host}`);
  }
  return host;
}

function activeParkingDatabaseService(parkingId) {
  const primaryUrl = PARKING_IDS.length === 6
    ? etcdValue(`/nhom16/parking/${parkingId}/db/primary`)
    : null;
  return parkingDatabaseService(parkingId, primaryUrl);
}

async function readParkingState(parkingId, rows) {
  return sqlJson(activeParkingDatabaseService(parkingId), parkingSnapshotSql(expectedEffects(rows, parkingId)));
}

function sortedSlots(slots) {
  return slots.filter((slot) => slot.status !== 'HIDDEN')
    .map((slot) => [slot.slotCode, slot.status, Number(slot.version)])
    .sort(([a], [b]) => a.localeCompare(b));
}

async function setProxy(parkingId, enabled) {
  const { port, name } = parkingProxyControl(parkingId);
  const response = await fetchJson(`http://localhost:${port}/proxies/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
    timeoutMs: 2000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Toxiproxy ${parkingId} enable=${enabled}: HTTP ${response.status}`);
  }
}

async function waitForStatus(expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = [];
  while (Date.now() < deadline) {
    const response = await fetchJson(`${BASE_URL}/api/parkings`, { timeoutMs: 3000 }).catch(() => null);
    actual = response?.body ?? [];
    if (PARKING_IDS.every((id) => actual.some((parking) =>
      parking.parkingId === id && parking.status === expected))) return actual;
    await sleep(500);
  }
  throw new Error(`Aggregator did not report all parking nodes ${expected}: ${JSON.stringify(actual)}`);
}

async function checkCacheConvergence(rows) {
  const deadline = Date.now() + 30_000;
  let states = [];
  while (Date.now() < deadline) {
    states = await Promise.all(PARKING_IDS.map((id) => readParkingState(id, rows)));
    if (states.every((state) => Number(state.pendingEvents) === 0 && Number(state.pendingReplies) === 0)) break;
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  if (!states.length || states.some((state) =>
    Number(state.pendingEvents) !== 0 || Number(state.pendingReplies) !== 0)) {
    throw new Error(`Outboxes did not drain within 30s: ${JSON.stringify(states.map((state) => ({
      pendingEvents: state.pendingEvents, pendingReplies: state.pendingReplies,
    })))}`);
  }

  const disabled = [];
  try {
    for (const id of PARKING_IDS) {
      disabled.push(id);
      await setProxy(id, false);
    }
    await waitForStatus('OFFLINE', Math.max(1, deadline - Date.now()));
    let mismatches = [];
    while (Date.now() < deadline) {
      mismatches = [];
      for (const id of PARKING_IDS) {
        const state = states[PARKING_IDS.indexOf(id)];
        const response = await fetchJson(`${BASE_URL}/api/parkings/${id}`, { timeoutMs: 3000 }).catch(() => null);
        const expected = sortedSlots(state.slots ?? []);
        const actual = sortedSlots(response?.body?.slots ?? []);
        if (response?.status !== 200 || response.body?.stale !== true ||
            JSON.stringify(actual) !== JSON.stringify(expected)) {
          const actualBySlot = new Map(actual.map(([slot, status, version]) => [slot, [status, version]]));
          const differences = expected.filter(([slot, status, version]) =>
            JSON.stringify(actualBySlot.get(slot)) !== JSON.stringify([status, version]))
            .slice(0, 3)
            .map(([slot, status, version]) =>
              `${slot}: expected=${status}@${version}, actual=${actualBySlot.has(slot)
                ? `${actualBySlot.get(slot)[0]}@${actualBySlot.get(slot)[1]}` : 'missing'}`);
          mismatches.push(`${id}: HTTP ${response?.status ?? 'unavailable'}, stale=${response?.body?.stale}, ` +
            `slots=${actual.length}/${expected.length}${differences.length ? `, differences=${differences.join(', ')}` : ''}`);
        }
      }
      if (!mismatches.length) {
        return { details: 'all outboxes drained and cached snapshots converged within 30s', states };
      }
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`cache did not converge within 30s: ${mismatches.join('; ')}`);
  } finally {
    const restoreErrors = [];
    for (const id of disabled.reverse()) {
      try {
        await setProxy(id, true);
      } catch (error) {
        restoreErrors.push(error);
      }
    }
    try {
      await waitForStatus('ONLINE');
    } catch (error) {
      restoreErrors.push(error);
    }
    if (restoreErrors.length) throw new AggregateError(restoreErrors, 'Could not restore all parking proxies after cache check');
  }
}

async function checkPrimaryPairs() {
  const failures = [];
  const runningServices = new Set(compose(['ps', '--status', 'running', '--services'])
    .split(/\r?\n/).filter(Boolean));
  for (const id of PARKING_IDS) {
    const states = [];
    for (const service of [`db-${id.toLowerCase()}`, `db-${id.toLowerCase()}-replica`]) {
      if (!runningServices.has(service)) continue;
      const state = sqlJson(service,
        `SELECT json_build_object('service', ${quoteSql(service)}, 'primary', NOT pg_is_in_recovery(),
          'epoch', CASE WHEN to_regclass('public.db_epoch') IS NULL THEN NULL
            ELSE (SELECT max(epoch)::text FROM db_epoch) END)::text`);
      states.push(state);
    }
    const etcdEpoch = PARKING_IDS.length === 6
      ? Number(etcdValue(`/nhom16/parking/${id}/db/epoch`) ?? 1)
      : null;
    const result = evaluatePrimaryPair(id, states, etcdEpoch);
    if (!result.passed) {
      failures.push(result.details);
    }
  }
  return failures.length ? failures.join('; ') : 'exactly one writable primary per pair; running db_epoch values match etcd';
}

export function evaluatePrimaryPair(parkingId, states, etcdEpoch = null) {
  if (!states.length) return { passed: false, details: `${parkingId}: no running database in the pair` };
  const primaryCount = states.filter((state) => state.primary).length;
  if (primaryCount !== 1) {
    return {
      passed: false,
      details: `${parkingId}: ${primaryCount} writable primaries among ${states.map((state) => state.service).join(', ')}`,
    };
  }
  const expectedEpoch = etcdEpoch === null ? null : Number(etcdEpoch);
  for (const state of states) {
    if (state.epoch === null || !Number.isSafeInteger(Number(state.epoch))) {
      return { passed: false, details: `${parkingId}: ${state.service} has no valid db_epoch` };
    }
    if (expectedEpoch !== null && Number(state.epoch) !== expectedEpoch) {
      return {
        passed: false,
        details: `${parkingId}: ${state.service} db_epoch=${state.epoch} != etcd_epoch=${expectedEpoch}`,
      };
    }
  }
  if (expectedEpoch === null && new Set(states.map((state) => Number(state.epoch))).size !== 1) {
    return { passed: false, details: `${parkingId}: primary and replica db_epoch values differ` };
  }
  return { passed: true, details: `${parkingId}: one writable primary, db_epoch=${states.find((state) => state.primary).epoch}` };
}

export async function checkInvariants({ historyPath }) {
  const operations = await acceptedOperations(historyPath);
  const rows = await commandRows(historyPath);
  const commandById = new Map(rows.map((row) => [row.id, row]));
  const missingOrPending = operations.filter((entry) => {
    const row = commandById.get(entry.commandId);
    return !row || !['DONE', 'FAILED', 'EXPIRED'].includes(row.status);
  });

  let states;
  let cacheDetails;
  try {
    const cache = await checkCacheConvergence(rows);
    states = cache.states;
    cacheDetails = cache.details;
  } catch (error) {
    cacheDetails = error.message;
    states = await Promise.all(PARKING_IDS.map((id) => readParkingState(id, rows)));
  }

  const count = (field) => states.reduce((sum, state) => sum + Number(state[field] ?? 0), 0);
  let primaryDetails;
  try {
    primaryDetails = await checkPrimaryPairs();
  } catch (error) {
    primaryDetails = `could not verify DB primary/epoch state: ${error.message}`;
  }
  const primaryPassed = primaryDetails.startsWith('exactly one writable primary per pair');

  return [
    { number: 1, name: 'No overlapping active reservations', passed: count('overlaps') === 0, details: `overlaps=${count('overlaps')}` },
    { number: 2, name: 'Every successful command has exactly one effect', passed: operations.length > 0 && count('badEffects') === 0,
      details: `${rows.filter((row) => Number(row.statusCode) >= 200 && Number(row.statusCode) < 300).length} successful commands; ${count('badEffects')} missing/duplicate effects` },
    { number: 3, name: 'Every accepted command is terminal', passed: operations.length > 0 && missingOrPending.length === 0,
      details: `${operations.length} accepted command IDs; ${missingOrPending.length} missing or non-terminal` },
    { number: 4, name: 'Outboxes empty and cache converged within 30s',
      passed: cacheDetails.startsWith('all outboxes'),
      details: cacheDetails },
    { number: 5, name: 'Slot versions increase continuously', passed: count('versionGaps') === 0, details: `version gaps=${count('versionGaps')}` },
    { number: 6, name: 'One writable primary; DB epoch matches etcd', passed: primaryPassed, details: primaryDetails },
  ];
}

export async function checkConfirmedDuringNemesis(historyPath, nemesisEntry) {
  const operations = await acceptedOperations(historyPath);
  const start = Date.parse(nemesisEntry.faultStartedAt);
  const end = Date.parse(nemesisEntry.faultEndedAt);
  const during = operations.filter((entry) => {
    const began = Date.parse(entry.startedAt);
    return began >= start && began <= end;
  });
  const rows = await commandRows(historyPath);
  return evaluateConfirmedDuringNemesis(during, rows);
}

export function evaluateConfirmedDuringNemesis(operations, rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const confirmed = operations.filter((entry) => entry.response?.publishState === 'CONFIRMED' ||
    byId.get(entry.commandId)?.publishState === 'CONFIRMED');
  const lost = confirmed.filter((entry) => {
    const row = byId.get(entry.commandId);
    return !row || !['DONE', 'FAILED', 'EXPIRED'].includes(row.status);
  });
  const passed = confirmed.length > 0 && lost.length === 0;
  const unconfirmed = operations.length - confirmed.length;
  const details = !confirmed.length
    ? `no publisher-confirmed command was issued during broker isolation (${operations.length} command(s) issued)`
    : `${confirmed.length} publisher-confirmed command(s) issued during broker isolation; ` +
      `${lost.length} were missing or non-terminal${unconfirmed ? `; ${unconfirmed} remained unconfirmed` : ''}`;
  return { passed, details };
}
