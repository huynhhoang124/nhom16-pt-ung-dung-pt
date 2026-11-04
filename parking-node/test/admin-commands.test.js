const test = require("node:test"),
  assert = require("node:assert/strict");
const { makePool } = require("./helpers");
const { decodeAdmin, dispatchAdminIn } = require("../src/admin-commands");
const { signature } = require("../src/command-signature");
const { reserve, moveSlot } = require("../src/slots");
function message(extra = {}) {
  const issuedAt = Date.now(),
    body = {
      schemaVersion: 1,
      type: "lockFloor",
      parkingId: "zone-bac",
      targets: ["A"],
      actor: { userId: "admin", role: "ADMIN" },
      payload: { floor: 1, locked: true },
      issuedAt,
      deadlineAt: issuedAt + 600000,
      ...extra,
    };
  const properties = {
    messageId: "admin:broadcast-key",
    correlationId: "admin:broadcast-key",
    replyTo: "agg.broadcast",
    type: body.type,
    expiration: "600000",
    headers: {},
  };
  properties.headers["x-command-signature"] = signature(
    "key",
    body,
    properties,
  );
  return {
    content: Buffer.from(JSON.stringify(body)),
    properties,
    fields: { routingKey: `cmd.${body.parkingId}.${body.type}` },
  };
}
test("admin envelope: signed server ADMIN, target/routing/properties and 10-minute deadline", () => {
  assert.equal(decodeAdmin(message(), "A", "key").type, "lockFloor");
  for (const m of [
    message({ actor: { userId: "user1", role: "USER" } }),
    message({ targets: ["B"] }),
    message({ deadlineAt: 1 }),
    message({ parkingId: "A" }),
  ])
    assert.throws(() => decodeAdmin(m, "A", "key"));
  const m = message();
  m.properties.correlationId = "other";
  assert.throws(() => decodeAdmin(m, "A", "key"));
});
test("admin mutations persist in DB; rollback, locked floors, bans, expiry and business rejection", async () => {
  const pool = await makePool("A", 3);
  const c = await pool.connect();
  const apply = async (extra) => {
    const env = decodeAdmin(message(extra), "A", "key");
    await c.query("BEGIN");
    try {
      const out = await dispatchAdminIn(c, env, { parkingId: "A" });
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  };
  try {
    assert.equal((await apply({})).code, 200);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM parking_slots WHERE status='MAINTENANCE'",
        )
      ).rows[0].n,
      3,
    );
    assert.equal(
      (
        await reserve(pool, "A", {
          requestId: "u:key",
          userId: "u",
          slotCode: "A01",
          licensePlate: "30A12345",
        })
      ).code,
      409,
    );
    assert.equal(
      (
        await moveSlot(
          pool,
          "A",
          "A01",
          ["MAINTENANCE"],
          "AVAILABLE",
          "MAINTENANCE_OFF",
        )
      ).code,
      409,
    );
    assert.equal(
      (await apply({ payload: { floor: 1, locked: false } })).code,
      200,
    );
    assert.equal(
      (
        await apply({
          type: "banPlates",
          payload: { plates: ["30A-123.45"], banned: true },
        })
      ).code,
      200,
    );
    assert.equal(
      (
        await reserve(pool, "A", {
          requestId: "u:key2",
          userId: "u",
          slotCode: "A01",
          licensePlate: "30A12345",
        })
      ).code,
      403,
    );
    await apply({
      type: "banPlates",
      payload: { plates: ["30A12345"], banned: false },
    });
    const rule = {
      vehicleType: "CAR",
      firstBlockMin: 120,
      firstBlockFee: 31000,
      nextHourFee: 10000,
      overnightFee: 30000,
    };
    await c.query("BEGIN");
    await dispatchAdminIn(
      c,
      decodeAdmin(
        message({ type: "setPricing", payload: { rules: [rule] } }),
        "A",
        "key",
      ),
      { parkingId: "A" },
    );
    await c.query("ROLLBACK");
    assert.equal(
      (
        await pool.query(
          "SELECT first_block_fee FROM pricing_rules WHERE vehicle_type='CAR'",
        )
      ).rows[0].first_block_fee,
      25000,
    );
    await apply({ type: "setPricing", payload: { rules: [rule] } });
    assert.equal(
      (
        await pool.query(
          "SELECT first_block_fee FROM pricing_rules WHERE vehicle_type='CAR'",
        )
      ).rows[0].first_block_fee,
      31000,
    );
    const issuedAt = Date.now() - 600001;
    assert.equal(
      (
        await apply({
          issuedAt,
          deadlineAt: issuedAt + 600000,
          payload: { floor: 1, locked: true },
        })
      ).code,
      410,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM parking_slots WHERE status='MAINTENANCE'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await apply({ payload: { floor: 1, locked: "yes" } })).code,
      400,
    );
    assert.equal(
      (await apply({ payload: { floor: 99, locked: true } })).code,
      404,
    );
    assert.equal(
      (
        await reserve(pool, "A", {
          requestId: "u:key3",
          userId: "u",
          slotCode: "A01",
          licensePlate: "30A12345",
        })
      ).code,
      201,
    );
    assert.equal(
      (await apply({ payload: { floor: 1, locked: true } })).code,
      409,
    );
  } finally {
    c.release();
    await pool.db.close();
  }
});

test("admin shares the real inbox transaction: duplicate, key reuse and outbox rollback", async (t) => {
  const { makeCommandProcessor } = require("../src/commands");
  const pool = await makePool("A", 3);
  t.after(() => pool.db.close());
  const process = makeCommandProcessor({
    pool,
    parkingId: "A",
    internalKey: "key",
  });
  const m = message();
  const first = await process(m);
  const duplicate = await process(m);
  assert.equal(first.code, 200);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.body, first.body);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM inbox_messages")).rows[0]
      .n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM command_reply_outbox"))
      .rows[0].n,
    2,
  );
  assert(
    (await pool.query("SELECT version FROM parking_slots")).rows.every(
      (s) => Number(s.version) === 1,
    ),
  );
  assert.equal(
    (await process(message({ payload: { floor: 2, locked: true } }))).code,
    422,
  );
  const rollback = message({ payload: { floor: 1, locked: false } });
  rollback.properties.messageId = rollback.properties.correlationId =
    "admin:broadcast-rollback";
  rollback.properties.headers["x-command-signature"] = signature(
    "key",
    JSON.parse(rollback.content),
    rollback.properties,
  );
  const broken = {
    connect: async () => {
      const c = await pool.connect();
      return {
        release: c.release,
        query: (sql, params) => {
          if (sql.startsWith("INSERT INTO command_reply_outbox"))
            throw new Error("outbox unavailable");
          return c.query(sql, params);
        },
      };
    },
  };
  await assert.rejects(
    makeCommandProcessor({ pool: broken, parkingId: "A", internalKey: "key" })(
      rollback,
    ),
    /outbox unavailable/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inbox_messages WHERE message_id='admin:broadcast-rollback'",
      )
    ).rows[0].n,
    0,
  );
  assert(
    (await pool.query("SELECT status,version FROM parking_slots")).rows.every(
      (s) => s.status === "MAINTENANCE" && Number(s.version) === 1,
    ),
  );
  assert.equal((await process(rollback)).code, 200);
  assert(
    (await pool.query("SELECT status,version FROM parking_slots")).rows.every(
      (s) => s.status === "AVAILABLE" && Number(s.version) === 2,
    ),
  );
});
