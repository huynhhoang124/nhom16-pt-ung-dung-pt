import { readFile } from 'node:fs/promises';
import { BASE_URL, PARKING_IDS, compose, fetchJson, quoteSql, sleep } from './common.mjs';

function sql(service, query) {
  return compose(['exec', '-T', service, 'psql', '-U', 'postgres', '-d', 'parking', '-tAc', query]);
}

function sqlJson(service, query) {
  const value = sql(service, query);
  return value ? JSON.parse(value) : [];
}

function sqlArray(values) {
  return values.length ? `ARRAY[${values.map(quoteSql).join(',')}]` : 'ARRAY[]::text[]';
}

async function readCommandIds(historyPath) {
  const text = await readFile(historyPath, 'utf8');
  const ids = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.commandId && entry.commandId.includes(':jepsen-')) {
      const observed = entry.result?.body?.commandId === entry.commandId;
      ids.set(entry.commandId, Boolean(ids.get(entry.commandId) || observed));
    }
  }
  return [...ids].map(([id, observed]) => ({ id, observed }));
}

async function checkTerminalCommands(historyPath) {
  const commands = await readCommandIds(historyPath);
  if (!commands.length) return { passed: false, details: 'No command IDs recorded in history' };
  const rows = sqlJson('db-agg', `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT id, status FROM commands WHERE id = ANY(${sqlArray(commands.map(({ id }) => id))})
  ) t`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const failures = [];
  let accepted = 0;
  for (const { id, observed } of commands) {
    const row = byId.get(id);
    if (!row) {
      if (observed) failures.push(`${id}: accepted response but missing from commands`);
      continue;
    }
    accepted++;
    if (!['DONE', 'FAILED', 'EXPIRED'].includes(row.status)) failures.push(`${id}: nonterminal status ${row.status}`);
  }
  return { passed: failures.length === 0 && accepted > 0, details: failures.join('; ') || `${accepted} accepted commands ended in a terminal state` };
}

async function checkCommandEffects(historyPath) {
  const commands = await readCommandIds(historyPath);
  if (!commands.length) return { passed: false, details: 'No command IDs recorded in history' };
  const rows = sqlJson('db-agg', `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT id, status, status_code, parking_id, type, payload::text AS payload
    FROM commands WHERE id = ANY(${sqlArray(commands.map(({ id }) => id))})
  ) t`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const failures = [];
  let successful = 0;
  const successfulRows = [];
  for (const { id, observed } of commands) {
    const row = byId.get(id);
    if (!row) {
      if (observed) failures.push(`${id}: accepted response but missing from commands`);
      continue;
    }
    const { status, status_code: statusCode, parking_id: parkingId, type, payload: payloadText } = row;
    const code = Number(statusCode);
    if (!Number.isInteger(code) || code < 200 || code >= 300) continue;
    successful++;
    if (status !== 'DONE') failures.push(`${id}: successful status code ${code} but command status ${status}`);
    successfulRows.push({ id, parkingId, type, code, payload: JSON.parse(payloadText) });
  }

  for (const parking of PARKING_IDS) {
    const target = successfulRows.filter((row) => row.parkingId === parking);
    if (!target.length) continue;
    const db = `db-${parking.toLowerCase()}`;
    const inboxRows = sqlJson(db, `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
      SELECT message_id, command_type, status_code, count(*)::int AS count
      FROM inbox_messages
      WHERE message_id = ANY(${sqlArray(successfulRows.map(({ id }) => id))}) AND processed_at IS NOT NULL
      GROUP BY message_id, command_type, status_code
    ) t`);
    const inboxByKey = new Map(inboxRows.map((row) => [`${row.message_id}|${row.command_type}|${row.status_code}`, row.count]));
    const reserveEffects = new Map(sqlJson(db, `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
      SELECT request_id, count(*)::int AS count FROM reservations
      WHERE request_id = ANY(${sqlArray(target.filter(({ type }) => type === 'reserve').map(({ id }) => id))}) GROUP BY request_id
    ) t`).map((row) => [row.request_id, row.count]));
    const cancelEffects = new Map(sqlJson(db, `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
      SELECT id, count(*)::int AS count FROM reservations
      WHERE id::text = ANY(${sqlArray(target.filter(({ type }) => type === 'cancel').map(({ payload }) => payload.reservationId))}) AND status = 'CANCELLED' GROUP BY id
    ) t`).map((row) => [row.id, row.count]));
    const payEffects = new Map(sqlJson(db, `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
      SELECT payment_key, count(*)::int AS count FROM parking_sessions
      WHERE payment_key = ANY(${sqlArray(target.filter(({ type }) => type === 'pay').map(({ id }) => id))}) GROUP BY payment_key
    ) t`).map((row) => [row.payment_key, row.count]));
    for (const row of target) {
      const inboxCount = Number(inboxByKey.get(`${row.id}|${row.type}|${row.code}`) ?? 0);
      if (inboxCount !== 1) failures.push(`${row.id}: expected one inbox record at ${parking}, found ${inboxCount}`);
      if (row.type === 'reserve' && Number(reserveEffects.get(row.id) ?? 0) !== 1) {
        failures.push(`${row.id}: expected one reservation effect, found ${reserveEffects.get(row.id) ?? 0}`);
      } else if (row.type === 'cancel' && Number(cancelEffects.get(row.payload.reservationId) ?? 0) !== 1) {
        failures.push(`${row.id}: cancellation did not leave exactly one cancelled reservation`);
      } else if (row.type === 'pay' && Number(payEffects.get(row.id) ?? 0) !== 1) {
        failures.push(`${row.id}: expected one payment effect, found ${payEffects.get(row.id) ?? 0}`);
      }
    }
  }
  return {
    passed: failures.length === 0 && successful > 0,
    details: `${successful} successful commands; ${failures.length ? failures.join('; ') : 'each has one inbox/effect record'}`,
  };
}

function checkOverlappingReservations() {
  const failures = [];
  for (const id of PARKING_IDS) {
    const count = Number(sql(`db-${id.toLowerCase()}`,
      `SELECT count(*) FROM reservations a JOIN reservations b ON a.slot_id=b.slot_id AND a.id<b.id
       AND a.status IN ('ACTIVE','USED') AND b.status IN ('ACTIVE','USED')
       AND tstzrange(a.start_time,a.end_time) && tstzrange(b.start_time,b.end_time)`));
    if (count) failures.push(`${id}: ${count} overlapping active reservations`);
  }
  return { passed: failures.length === 0, details: failures.join('; ') || 'no overlapping ACTIVE/USED reservations' };
}

function checkVersions() {
  const failures = [];
  for (const id of PARKING_IDS) {
    const count = Number(sql(`db-${id.toLowerCase()}`,
      `WITH versions AS (
         SELECT slot_code, (payload->>'version')::bigint AS version,
                lag((payload->>'version')::bigint) OVER (PARTITION BY slot_code ORDER BY id) AS previous
         FROM parking_events WHERE payload ? 'version' AND event_type <> 'RESERVATION_EXPIRING'
       )
       SELECT count(*) FROM versions WHERE previous IS NOT NULL AND version <> previous + 1`));
    if (count) failures.push(`${id}: ${count} non-contiguous slot versions`);
  }
  return { passed: failures.length === 0, details: failures.join('; ') || 'all recorded slot versions are contiguous' };
}

async function checkOutboxesAndCache() {
  const deadline = Date.now() + 30_000;
  let lastProblem = 'outbox or cache has not converged';
  while (Date.now() < deadline) {
    try {
      const differences = [];
      for (const id of PARKING_IDS) {
        const db = `db-${id.toLowerCase()}`;
        const pendingEvents = Number(sql(db, 'SELECT count(*) FROM parking_events WHERE published_at IS NULL'));
        const pendingReplies = Number(sql(db, 'SELECT count(*) FROM command_reply_outbox WHERE published_at IS NULL'));
        if (pendingEvents || pendingReplies) differences.push(`${id}: outbox events=${pendingEvents}, replies=${pendingReplies}`);

        const databaseSlots = sql(db,
          `SELECT slot_code || E'\\t' || status || E'\\t' || version FROM parking_slots WHERE status <> 'HIDDEN' ORDER BY slot_code`)
          .split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'));
        const response = await fetchJson(`${BASE_URL}/api/parkings/${id}`, { timeoutMs: 2000 });
        if (response.status !== 200 || !Array.isArray(response.body?.slots)) {
          differences.push(`${id}: cache snapshot unavailable (HTTP ${response.status})`);
          continue;
        }
        const cachedSlots = response.body.slots.filter((slot) => slot.status !== 'HIDDEN')
          .map((slot) => [slot.slotCode, slot.status, String(slot.version)])
          .sort(([a], [b]) => a.localeCompare(b));
        const sortedDatabaseSlots = databaseSlots.sort(([a], [b]) => a.localeCompare(b));
        if (JSON.stringify(cachedSlots) !== JSON.stringify(sortedDatabaseSlots)) {
          differences.push(`${id}: Aggregator cache differs from database`);
        }
      }
      if (!differences.length) return { passed: true, details: 'all six outboxes are empty and caches match database snapshots' };
      lastProblem = differences.join('; ');
    } catch (error) {
      lastProblem = error.message;
    }
    await sleep(1000);
  }
  return { passed: false, details: `did not converge within 30s: ${lastProblem}` };
}

function checkEpochs() {
  const read = (service) => {
    const [recovery, epoch] = sql(service,
      `SELECT pg_is_in_recovery()::text || E'\\t' || COALESCE((SELECT epoch::text FROM db_epoch LIMIT 1), 'missing')`).split('\t');
    return { service, primary: recovery === 'false', epoch: Number(epoch) };
  };
  const states = [read('db-a'), read('db-a-replica')];
  const primaries = states.filter((state) => state.primary);
  const invalidEpoch = states.some((state) => !Number.isSafeInteger(state.epoch) || state.epoch < 1);
  const passed = primaries.length === 1 && !invalidEpoch;
  return {
    passed,
    details: `db-a epoch=${states[0].epoch} primary=${states[0].primary}; db-a-replica epoch=${states[1].epoch} primary=${states[1].primary}; active primaries=${primaries.length}`,
  };
}

export async function checkInvariants({ historyPath }) {
  const results = [
    { name: '1. No overlapping ACTIVE reservations', ...checkOverlappingReservations() },
    { name: '2. Successful command has exactly one effect', ...await checkCommandEffects(historyPath) },
    { name: '3. Every accepted command is terminal', ...await checkTerminalCommands(historyPath) },
    { name: '4. Outbox empty and cache converged within 30s', ...await checkOutboxesAndCache() },
    { name: '5. Slot versions are contiguous and monotonic', ...checkVersions() },
    { name: '6. Exactly one writable DB primary by epoch', ...checkEpochs() },
  ];
  return results;
}
