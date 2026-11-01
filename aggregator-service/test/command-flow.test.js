const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { makeCommandFlow } = require("../src/command-flow");
const { makeReplyHandler } = require("../src/command-replies");
const { signature } = require("../src/command-signature");
const { applyEvent } = require("../src/events");
const user = { sub: "user", role: "USER" },
  request = {
    parkingId: "A",
    type: "reserve",
    user,
    payload: { slotCode: "A01" },
    key: "key",
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
  };
test("instance ID cannot collide with the durable recovery queue", () =>
  assert.throws(() => makeCommandFlow({ instanceId: "recovery" }), {
    code: "INVALID_AGGREGATOR_ID",
  }));
async function completed(flow) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const row = await flow.get("user:key");
    if (row.status === "DONE") return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("command did not complete");
}
function reply(opts, result = { id: "reservation" }, code = 201) {
  const b = {
    schemaVersion: 1,
    type: "COMMAND_RESULT",
    commandType: "reserve",
    commandId: opts.messageId,
    parkingId: "A",
    actor: opts.actor,
    statusCode: code,
    result,
    traceparent: opts.traceparent,
    slot: { slotCode: "A01", status: "RESERVED", version: 2 },
  };
  const properties = {
    messageId: "reply",
    correlationId: opts.correlationId,
    type: "COMMAND_RESULT",
    headers: { traceparent: opts.traceparent },
  };
  properties.headers["x-reply-signature"] = signature("key", b, properties);
  return { content: Buffer.from(JSON.stringify(b)), properties };
}
async function setup(t, options = {}) {
  const db = new PGlite();
  await db.exec(
    fs.readFileSync(path.join(__dirname, "../src/schema.sql"), "utf8"),
  );
  const query = async (s, p) => {
    if (s.includes("pg_notify")) return { rows: [], rowCount: 1 };
    const r = await db.query(s, p);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) },
    calls = [],
    cache = new Map();
  let behaviour;
  const publisher = {
    send: async (_p, _t, _b, opts) => {
      calls.push(opts);
      return behaviour(opts);
    },
  };
  const flow = makeCommandFlow({
    pool,
    publisher,
    instanceId: "1",
    waitMs: 3000,
    ...options,
  });
  const handle = makeReplyHandler({
    pool,
    cache,
    internalKey: "key",
    signal: flow.signal,
  });
  behaviour = (opts) => handle(reply(opts));
  flow.setReady(true);
  flow.start();
  t.after(async () => {
    await flow.stop();
    await db.close();
  });
  return {
    pool,
    flow,
    handle,
    calls,
    cache,
    set(fn) {
      behaviour = fn;
    },
  };
}
test("reply before publisher confirm releases request; same key yields same command and result, mismatch 422", async (t) => {
  const { flow, calls, cache } = await setup(t);
  const a = await flow.execute(request);
  assert.equal(a.code, 201);
  assert.equal(a.body.commandId, "user:key");
  assert.deepEqual(await flow.execute(request), a);
  assert.equal(calls.length, 1);
  assert.equal(flow.pending.size, 0);
  assert.equal(calls[0].messageId, calls[0].correlationId);
  assert.equal(calls[0].replyTo, "agg.1");
  assert.equal(calls[0].traceparent, request.traceparent);
  await assert.rejects(
    flow.execute({ ...request, payload: { slotCode: "A02" } }),
    { code: "IDEMPOTENCY_KEY_REUSED" },
  );
  applyEvent(cache, {
    parkingId: "A",
    slot: "A01",
    status: "AVAILABLE",
    version: 1,
  });
  assert.equal(cache.get("A:A01").status, "RESERVED");
});
test("unknown publish stays PENDING/202; retry preserves identity and deadline", async (t) => {
  const { flow, set, calls, pool, handle } = await setup(t, { waitMs: 30 });
  set(() => {
    throw Object.assign(new Error("disconnect"), {
      code: "PUBLISH_UNKNOWN_RESULT",
    });
  });
  const a = await flow.execute(request);
  assert.equal(a.code, 202);
  let row = await flow.get("user:key");
  assert.equal(row.status, "PENDING");
  assert.equal(row.uncertain, true);
  set((opts) => handle(reply(opts)));
  await pool.query(
    "UPDATE commands SET next_publish_at=now()-interval '1 second'",
  );
  await flow.pump();
  row = await completed(flow);
  assert.equal(row.status, "DONE");
  assert.equal(calls[1].messageId, calls[0].messageId);
  assert.equal(calls[1].deadlineAt, calls[0].deadlineAt);
});
test("definite mandatory return is FAILED_TO_SEND; safe retry uses original row/ID", async (t) => {
  const { flow, set, handle } = await setup(t);
  set(() => {
    throw Object.assign(new Error("return"), {
      code: "PARKING_NOT_FOUND",
      status: 404,
    });
  });
  const a = await flow.execute(request);
  assert.equal(a.code, 404);
  assert.equal(a.body.sendStatus, "FAILED_TO_SEND");
  set((opts) => handle(reply(opts)));
  const b = await flow.execute(request);
  assert.equal(b.code, 201);
  assert.equal(b.body.commandId, a.body.commandId);
});
test("duplicate and conflicting late replies cannot overwrite terminal result; correlation/actor/signature checked", async (t) => {
  const { flow, handle, calls } = await setup(t);
  await flow.execute(request);
  const before = await flow.get("user:key");
  assert.equal(await handle(reply(calls[0])), true);
  assert.equal(await handle(reply(calls[0], { id: "different" })), false);
  assert.equal(
    await handle(reply({ ...calls[0], correlationId: "wrong" })),
    false,
  );
  assert.equal(
    await handle(
      reply({ ...calls[0], actor: { userId: "attacker", role: "ADMIN" } }),
    ),
    false,
  );
  const bad = reply(calls[0]);
  bad.content = Buffer.from("{}");
  assert.equal(await handle(bad), false);
  const after = await flow.get("user:key");
  assert.deepEqual(after.result, before.result);
  assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
});
test("durable intent survives crash after claim before send; expired lease safely republishes", async (t) => {
  let once = true;
  const { flow, pool, calls } = await setup(t, {
    waitMs: 30,
    leaseMs: 5000,
    afterClaim: () => {
      if (once) {
        once = false;
        throw new Error("test crash");
      }
    },
  });
  assert.equal((await flow.execute(request)).code, 202);
  assert.equal(calls.length, 0);
  await pool.query(
    "UPDATE commands SET publish_lease_until=now()-interval '1 second'",
  );
  await flow.pump();
  assert.equal((await completed(flow)).status, "DONE");
  assert.equal(calls.length, 1);
});
test("shutdown resolves outstanding waiters as accepted, never failed transaction", async (t) => {
  const { flow, set } = await setup(t);
  set(() => {});
  const p = flow.execute(request);
  await new Promise((r) => setTimeout(r, 10));
  await flow.stop();
  assert.equal((await p).code, 202);
  assert.equal(flow.pending.size, 0);
});

test("DB insert acknowledgement loss preserves the same ID as unknown, recovered intent can still finish", async (t) => {
  const { flow, pool } = await setup(t);
  const original = pool.query;
  let first = true;
  pool.query = async (s, p) => {
    const out = await original(s, p);
    if (first && s.includes("INSERT INTO commands")) {
      first = false;
      throw new Error("DB connection lost after commit");
    }
    return out;
  };
  await assert.rejects(
    flow.execute(request),
    (e) =>
      e.code === "COMMAND_PERSISTENCE_UNKNOWN" &&
      e.commandId === "user:key" &&
      e.unknown === true,
  );
  assert.equal((await completed(flow)).id, "user:key");
  assert.equal((await flow.execute(request)).body.commandId, "user:key");
});

test("crash after broker confirm before durable send update recovers with identical ID/deadline", async (t) => {
  let crash = true;
  const f = await setup(t, {
    waitMs: 30,
    afterPublish: () => {
      if (crash) {
        crash = false;
        throw new Error("test exit after confirm");
      }
    },
  });
  f.set(() => {});
  assert.equal((await f.flow.execute(request)).code, 202);
  assert.equal((await f.flow.get("user:key")).publish_state, "UNKNOWN");
  f.set((opts) => f.handle(reply(opts)));
  await f.pool.query(
    "UPDATE commands SET next_publish_at=now()-interval '1 second'",
  );
  await f.flow.pump();
  await completed(f.flow);
  assert.equal(f.calls[0].messageId, f.calls[1].messageId);
  assert.equal(f.calls[0].deadlineAt, f.calls[1].deadlineAt);
});
test("reply topology not ready prevents publish; retry after recovery retains the same command", async (t) => {
  const f = await setup(t);
  f.flow.setReady(false);
  const rejected = await f.flow.execute(request);
  assert.equal(rejected.code, 503);
  assert.equal(rejected.body.sendStatus, "FAILED_TO_SEND");
  assert.equal(f.calls.length, 0);
  f.flow.setReady(true);
  const done = await f.flow.execute(request);
  assert.equal(done.code, 201);
  assert.equal(done.body.commandId, rejected.body.commandId);
});

test("additive migration keeps old results and leaves legacy pending commands UNKNOWN without republishing", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE commands(id TEXT PRIMARY KEY,parking_id TEXT,type TEXT,user_id TEXT,status TEXT,result JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
    INSERT INTO commands(id,parking_id,type,user_id,status,result) VALUES
    ('legacy:pending','A','reserve','legacy','PENDING',NULL),('legacy:done','A','reserve','legacy','DONE','{"id":"retained"}');`);
  const schema = fs.readFileSync(
    path.join(__dirname, "../src/schema.sql"),
    "utf8",
  );
  await db.exec(schema);
  await db.exec(schema);
  const rows = (await db.query("SELECT * FROM commands ORDER BY id")).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].result, { id: "retained" });
  assert.equal(rows[1].status, "PENDING");
  assert.equal(rows[1].publish_state, "UNKNOWN");
  assert.equal(rows[1].uncertain, true);
  assert.equal(rows[1].envelope, null);
  assert.equal(rows[1].correlation_id, "legacy:pending");
  await db.exec(`INSERT INTO commands(id,parking_id,type,user_id,request_hash,payload,actor,envelope,correlation_id,reply_to)
    VALUES ('new:key','A','reserve','new','hash','{}','{}','{"issuedAt":1,"deadlineAt":2}','new:key','agg.1')`);
  const fresh = (await db.query("SELECT * FROM commands WHERE id='new:key'")).rows[0];
  assert.equal(fresh.status, 'PENDING');assert.equal(fresh.publish_state, 'QUEUED');assert.equal(fresh.uncertain, false);
  assert(fresh.created_at);assert(fresh.updated_at);
});

test("late reply after HTTP 202 persists terminal result; accepted duplicate retries a failed notification", async (t) => {
  const f = await setup(t, { waitMs: 30 });
  f.set(() => {});
  assert.equal((await f.flow.execute(request)).code, 202);
  assert.equal(f.flow.pending.size, 0);
  let attempts = 0;
  const handle = makeReplyHandler({
    pool: f.pool,
    internalKey: "key",
    signal: async () => {
      if (++attempts === 1) throw new Error("notify connection lost");
    },
  });
  await assert.rejects(handle(reply(f.calls[0])), /notify connection lost/);
  assert.equal((await f.flow.get("user:key")).status, "DONE");
  assert.equal(await handle(reply(f.calls[0])), true);
  assert.equal(attempts, 2);
  assert.equal((await f.flow.execute(request)).code, 201);
});
