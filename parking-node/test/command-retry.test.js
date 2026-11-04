const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  makeRetryOrDead,
  withDeadline,
  testFailures,
} = require("../src/command-retry");
const { signature, trusted } = require("../src/retry-contract");
function msg(deadlineAt = 60000) {
  const b = {
    schemaVersion: 1,
    type: "reserve",
    parkingId: "A",
    actor: { userId: "u", role: "USER" },
    payload: {},
    issuedAt: 0,
    deadlineAt,
  };
  const properties = {
    messageId: "u:key",
    correlationId: "corr",
    replyTo: "agg.1",
    expiration: "60000",
    type: "reserve",
    headers: { actor: b.actor, traceparent: "trace" },
  };
  properties.headers["x-command-signature"] = signature("key", b, properties);
  return {
    content: Buffer.from(JSON.stringify(b)),
    properties,
    fields: { routingKey: "cmd.A.reserve" },
  };
}
test("retry 2s then 10s then dead preserves identity and immutable deadline", async () => {
  let m = msg();
  const sent = [];
  const transfer = makeRetryOrDead({
    internalKey: "key",
    now: () => 100,
    publish: async (ex, key, content, p) => {
      sent.push({ ex, key, content, p });
    },
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(await transfer({ message: m, error: new Error("db") }), true);
    const s = sent.at(-1);
    assert.equal(s.p.messageId, "u:key");
    assert.equal(s.p.correlationId, "corr");
    assert.equal(s.p.replyTo, "agg.1");
    assert.equal(s.p.expiration, undefined);
    assert.equal(JSON.parse(s.content).deadlineAt, 60000);
    assert.ok(trusted("key", JSON.parse(s.content), s.p));
    m = { content: s.content, properties: s.p, fields: { routingKey: s.key } };
  }
  assert.deepEqual(
    sent.map((s) => s.key),
    ["retry.1", "retry.2", "dead"],
  );
  assert.deepEqual(sent[0].p.headers.CC, ["cmd.A.reserve"]);
  assert.equal(sent[2].p.headers.CC, undefined);
});
test("publish failure never reports safe ack; no hot retry or lost source", async () => {
  const transfer = makeRetryOrDead({
    internalKey: "key",
    now: () => 1,
    publish: async () => {
      throw new Error("nack");
    },
  });
  await assert.rejects(
    transfer({ message: msg(), error: new Error("db") }),
    /nack/,
  );
});
test("invalid schema goes dead, expired goes expired, independent of x-death", async () => {
  const keys = [];
  const transfer = makeRetryOrDead({
    internalKey: "key",
    now: () => 50,
    publish: async (_, k) => keys.push(k),
  });
  await transfer({ message: msg(), error: new Error("bad"), permanent: true });
  const m = msg(10);
  m.properties.headers["x-death"] = [{ count: 10, reason: "delivery_limit" }];
  await transfer({ message: m, error: new Error("db") });
  assert.deepEqual(keys, ["dead", "expired"]);
});
test("deadline guards execution and authenticated retry routing; untrusted body rejected", async () => {
  let calls = 0;
  const process = withDeadline(
    async (m) => {
      calls++;
      assert.equal(m.fields.routingKey, "cmd.A.reserve");
    },
    { internalKey: "key", parkingId: "A", now: () => 100 },
  );
  await assert.rejects(process(msg(50)), { code: "COMMAND_EXPIRED" });
  assert.equal(calls, 0);
  await process(msg());
  assert.equal(calls, 1);
  const m = msg();
  m.fields.routingKey = "retry.1";
  m.properties.headers["x-original-routing-key"] = "cmd.B.pay";
  await assert.rejects(process(m), { code: "INVALID_ROUTING" });
  m.properties.headers["x-original-routing-key"] = "cmd.A.reserve";
  await process(m);
  assert.equal(calls, 2);
  m.content = Buffer.from(m.content.toString().replace("60000", "99999"));
  await assert.rejects(process(m), { code: "UNTRUSTED_COMMAND" });
});
test("test hook is off by default in production and scoped to one ID", () => {
  const off = testFailures({ enabled: false, messageId: "u:key", count: 2 });
  off(msg());
  const on = testFailures({ enabled: true, messageId: "u:key", count: 2 });
  assert.throws(() => on(msg()), { code: "TEST_TRANSIENT" });
  assert.throws(() => on(msg()));
  on(msg());
});

test("test hook can exhaust all three deliveries without affecting another command", () => {
  const fault = testFailures({ enabled: true, messageId: "u:key", count: 3 });
  const other = msg();
  other.properties.messageId = "u:other";
  fault(other);
  for (let i = 0; i < 3; i++) assert.throws(() => fault(msg()), { code: "TEST_TRANSIENT" });
  fault(msg());
});

test("business 409 returns normally; no retry classification is invoked", async () => {
  const wrapped = withDeadline(
    async () => ({ code: 409, body: { error: "TIME_CONFLICT" } }),
    { internalKey: "key", parkingId: "A", now: () => 1 },
  );
  assert.equal((await wrapped(msg())).code, 409);
});

test("rolled-back infrastructure status is retried; business conflicts remain terminal", async () => {
  for (const code of ["STALE_DB_EPOCH", "ETCD_UNREACHABLE"]) {
    const wrapped = withDeadline(
      async () => ({ code: 503, body: { error: code } }),
      { internalKey: "key", parkingId: "A", now: () => 1 },
    );
    await assert.rejects(wrapped(msg()), { code });
  }
});

test("expired redelivery may return a committed inbox result, never admit an unprocessed ID", async () => {
  let calls = 0;
  const options = {
    internalKey: "key",
    parkingId: "A",
    now: () => 100,
    pool: { query: async () => ({ rowCount: 1 }) },
  };
  const wrapped = withDeadline(async () => {
    calls++;
    return { code: 201 };
  }, options);
  assert.equal((await wrapped(msg(50))).code, 201);
  assert.equal(calls, 1);
  options.pool.query = async () => ({ rowCount: 0 });
  await assert.rejects(wrapped(msg(50)), { code: "COMMAND_EXPIRED" });
  assert.equal(calls, 1);
});

test("retry preserves the admin lane and rejects cross-parking original routes", async () => {
  const m = msg();
  m.fields.routingKey = "cmd.A.reserve.admin";
  let sent;
  const transfer = makeRetryOrDead({
    internalKey: "key",
    now: () => 1,
    publish: async (...args) => {
      sent = args;
    },
  });
  await transfer({ message: m, error: new Error("DB") });
  assert.deepEqual(sent[3].headers.CC, ["cmd.A.reserve.admin"]);
  const retry = {
    content: sent[2],
    properties: sent[3],
    fields: { routingKey: "retry.1" },
  };
  const wrapped = withDeadline(
    async (delivery) =>
      assert.equal(delivery.fields.routingKey, "cmd.A.reserve.admin"),
    { internalKey: "key", parkingId: "A", now: () => 1 },
  );
  await wrapped(retry);
});

test("legacy no-deadline success stays compatible; failure cannot start an unbounded renewed TTL", async () => {
  const m = msg(),
    b = JSON.parse(m.content);
  delete b.issuedAt;
  delete b.deadlineAt;
  m.content = Buffer.from(JSON.stringify(b));
  m.properties.headers["x-command-signature"] = signature(
    "key",
    b,
    m.properties,
  );
  assert.equal(
    await withDeadline(async () => 201, { internalKey: "key", parkingId: "A" })(
      m,
    ),
    201,
  );
  let route;
  await makeRetryOrDead({
    internalKey: "key",
    publish: async (_, key) => {
      route = key;
    },
  })({ message: m, error: new Error("DB") });
  assert.equal(route, "dead");
  await assert.rejects(
    makeRetryOrDead({
      internalKey: "key",
      now: () => 1,
      publish: async () => false,
    })({ message: msg(), error: new Error("DB") }),
    { code: "PUBLISH_NOT_CONFIRMED" },
  );
});

test("two transient failures roll back the real inbox transaction before the third delivery commits once", async (t) => {
  const { makePool, one } = require("./helpers");
  const { makeCommandProcessor } = require("../src/commands");
  const pool = await makePool();
  t.after(() => pool.db.close());
  const m = msg(),
    b = JSON.parse(m.content);
  b.issuedAt = Date.now();
  b.deadlineAt = b.issuedAt + 60000;
  b.traceparent = "trace";
  b.payload = { slotCode: "A01", licensePlate: "30A-123.45" };
  m.content = Buffer.from(JSON.stringify(b));
  m.properties.headers["x-command-signature"] = signature(
    "key",
    b,
    m.properties,
  );
  const run = makeCommandProcessor({
    pool,
    parkingId: "A",
    internalKey: "key",
    beforeDispatch: testFailures({
      enabled: true,
      messageId: "u:key",
      count: 2,
    }),
  });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(run(m), { code: "TEST_TRANSIENT" });
    assert.equal(
      (await one(pool, "SELECT count(*)::int AS n FROM inbox_messages")).n,
      0,
    );
    assert.equal(
      (await one(pool, "SELECT count(*)::int AS n FROM reservations")).n,
      0,
    );
    assert.equal(
      (
        await one(
          pool,
          "SELECT status FROM parking_slots WHERE slot_code='A01'",
        )
      ).status,
      "AVAILABLE",
    );
  }
  assert.equal((await run(m)).code, 201);
  assert.equal((await run(m)).duplicate, true);
  assert.equal(
    (await one(pool, "SELECT count(*)::int AS n FROM reservations")).n,
    1,
  );
});
