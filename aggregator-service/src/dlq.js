const { createHash, randomUUID } = require("node:crypto");
const amqp = require("amqplib");
const { makeConnector } = require("./amqp-connect");
const { makeTransfer } = require("./command-transfer");
const {
  canonical,
  signature,
  trusted,
  proof,
  equal,
} = require("./retry-contract");
const { validateAdmin } = require("./admin-payload");
const ADMIN_TYPES = ["setPricing", "lockFloor", "banPlates"];
const fail = (code, status = 422) =>
  Object.assign(new Error(code), { code, status });
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const TYPES = {
  reserve: ["slotCode", "licensePlate", "startTime", "durationMinutes"],
  cancel: ["reservationId"],
  pay: ["sessionId", "method"],
};
function validPayload(type, p) {
  if (ADMIN_TYPES.includes(type)) return validateAdmin(type, p) === null;
  if (
    !object(p) ||
    !Object.hasOwn(TYPES, type) ||
    Object.keys(p).some((k) => !TYPES[type].includes(k))
  )
    return false;
  if (type === "reserve")
    return (
      /^[A-Za-z0-9_-]{1,64}$/.test(p.slotCode ?? "") &&
      typeof p.licensePlate === "string" &&
      p.licensePlate.length <= 32 &&
      /^\d{2}[A-Z]{1,2}\d?\d{4,5}$/.test(
        p.licensePlate.toUpperCase().replace(/[\s.\-]/g, ""),
      ) &&
      (p.durationMinutes === undefined ||
        (Number.isInteger(p.durationMinutes) &&
          p.durationMinutes >= 30 &&
          p.durationMinutes <= 1440)) &&
      (p.startTime === undefined ||
        (typeof p.startTime === "string" &&
          Number.isFinite(Date.parse(p.startTime))))
    );
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      p[type === "pay" ? "sessionId" : "reservationId"] ?? "",
    ) &&
    (type !== "pay" || p.method === undefined || p.method === "ONLINE")
  );
}
function view(row) {
  let b;
  try {
    b = JSON.parse(Buffer.from(row.content_base64, "base64"));
  } catch {
    b = {};
  }
  if (!object(b)) b = {};
  const safe = object(b.payload) ? b.payload : {};
  const payload = Object.fromEntries(
    (Object.hasOwn(TYPES, b.type) ? TYPES[b.type] : [])
      .filter((k) => k in safe)
      .map((k) => [
        k,
        k === "licensePlate"
          ? "[đã che]"
          : typeof safe[k] === "number"
            ? safe[k]
            : typeof safe[k] === "string" && safe[k].length <= 128
              ? safe[k]
              : "[đã che]",
      ]),
  );
  return {
    id: row.id,
    messageId: row.message_id,
    routingKey: row.routing_key,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    replayMessageId: row.replay_message_id,
    type: Object.hasOwn(TYPES, b.type) || ADMIN_TYPES.includes(b.type) ? b.type : undefined,
    parkingId:
      typeof b.parkingId === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(b.parkingId)
        ? b.parkingId
        : undefined,
    payload,
  };
}
function makeDlq({
  pool,
  url,
  internalKey,
  publish = makeTransfer(url),
  markFailed = async () => {},
  claimReplay,
  ttlMs = 10000,
}) {
  async function store(m) {
    const p = m.properties,
      h = p.headers ?? {},
      key = h["x-original-routing-key"] ?? m.fields.routingKey;
    const claimed = h["x-failure-reason"] ?? "UNVERIFIED";
    const verified = equal(
      h["x-dlq-signature"],
      proof(internalKey, m.content, p, claimed, key),
    );
    const reason = verified ? claimed : "UNVERIFIED";
    const hash = createHash("sha256")
      .update(
        canonical({
          content: m.content.toString("base64"),
          id: p.messageId ?? null,
          key,
          reason,
        }),
      )
      .digest("hex");
    const stored = await pool.query(
      `INSERT INTO dead_letters(dedup_key,message_id,content_base64,properties,routing_key,reason)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedup_key) DO NOTHING RETURNING id`,
      [hash, p.messageId ?? null, m.content.toString("base64"), p, key, reason],
    );
    if (stored.rowCount) require("./metrics").incCmdDead(); // PD-25: mọi đường vào cmd.dead đều qua đây
    if (verified && reason !== "UNVERIFIED") await markFailed(p.messageId, reason);
  }
  async function list({ limit = 20, offset = 0 } = {}) {
    const r = await pool.query(
      "SELECT * FROM dead_letters ORDER BY id DESC LIMIT $1 OFFSET $2",
      [limit, offset],
    );
    return { items: r.rows.map(view), limit, offset };
  }
  async function replay(id, input, admin) {
    if (
      !object(input) ||
      Object.keys(input).some((k) => !["payload", "type"].includes(k))
    )
      throw fail("INVALID_REPLAY");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const row = (
        await c.query("SELECT * FROM dead_letters WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!row) throw fail("DLQ_NOT_FOUND", 404);
      if (row.status !== "READY") throw fail("REPLAY_ALREADY_REQUESTED", 409);
      let b;
      try {
        b = JSON.parse(Buffer.from(row.content_base64, "base64"));
      } catch {
        throw fail("UNRECOVERABLE_ENVELOPE");
      }
      if (
        !trusted(internalKey, b, row.properties) ||
        !object(b.actor) ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(b.actor.userId ?? "") ||
        !["USER", "STAFF", "ADMIN"].includes(b.actor.role) ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(b.parkingId ?? "") ||
        !row.message_id?.startsWith(`${b.actor.userId}:`)
      )
        throw fail("UNTRUSTED_ENVELOPE");
      const type = Object.hasOwn(input, "type") ? input.type : b.type,
        payload = Object.hasOwn(input, "payload") ? input.payload : b.payload;
      if (!validPayload(type, payload)) throw fail("INVALID_PAYLOAD");
      const changed =
        type !== b.type || canonical(payload) !== canonical(b.payload);
      // Lệnh quản trị chỉ phát lại nguyên bản, cùng ID: mỗi bãi tự chống trùng bằng inbox, không có bãi nào để claim.
      // Only a signed failure before business execution permits an edited new command.
      if (changed && (row.reason !== "INVALID_SCHEMA" || ADMIN_TYPES.includes(type) || ADMIN_TYPES.includes(b.type)))
        throw fail("EDIT_REQUIRES_PRE_EXECUTION_FAILURE", 409);
      const messageId = changed
        ? `${b.actor.userId}:replay-${row.dedup_key.slice(0, 32)}`
        : row.message_id;
      if (changed) {
        if (Date.now() - new Date(row.created_at).getTime() > 7 * 86400000)
          throw fail("REPLAY_DEDUP_WINDOW_EXPIRED", 409);
        if (!claimReplay) throw fail("INBOX_CLAIM_UNAVAILABLE", 503);
        await claimReplay(b.parkingId, row.message_id, messageId);
      }
      const issuedAt = Date.now();
      b = {
        ...b,
        schemaVersion: 1,
        type,
        payload,
        issuedAt,
        deadlineAt: issuedAt + ttlMs,
        causationId: row.message_id,
      };
      const headers = { schemaVersion: 1, actor: b.actor, "x-retry": 0 };
      for (const k of ["causationId", "traceparent", "hlc", "fencingToken"])
        if (b[k] !== undefined) headers[k] = b[k];
      const properties = {
        messageId,
        correlationId: randomUUID(),
        replyTo: row.properties.replyTo,
        type,
        contentType: "application/json",
        expiration: String(ttlMs),
        headers,
      };
      headers["x-command-signature"] = signature(internalKey, b, properties);
      await c.query(
        `UPDATE dead_letters SET status='PUBLISHING',replay_message_id=$2,replay_body=$3,replay_properties=$4,
        replay_admin=$5,replay_requested_at=now() WHERE id=$1`,
        [id, messageId, b, properties, admin],
      );
      await c.query("COMMIT");
      return { id, status: "PUBLISHING", messageId, processed: false };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  // Durable publish intent; crash/unknown republishes with the SAME ID, never deletes inbox.
  async function relay() {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const row = (
        await c.query(
          "SELECT * FROM dead_letters WHERE status='PUBLISHING' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",
        )
      ).rows[0];
      if (row) {
        const b = row.replay_body,
          p = {
            ...row.replay_properties,
            headers: { ...row.replay_properties.headers },
          };
        const remaining = b.deadlineAt - Date.now();
        if (remaining <= 0)
          await c.query(
            "UPDATE dead_letters SET status='REPLAY_EXPIRED' WHERE id=$1",
            [row.id],
          );
        else {
          p.expiration = String(remaining);
          p.headers["x-command-signature"] = signature(internalKey, b, p);
          const original = JSON.parse(
            Buffer.from(row.content_base64, "base64"),
          );
          const admin =
            row.routing_key ===
            `cmd.${original.parkingId}.${original.type}.admin`;
          if (
            (await publish(
              "parking.commands",
              `cmd.${b.parkingId}.${b.type}${admin ? ".admin" : ""}`,
              Buffer.from(JSON.stringify(b)),
              p,
            )) === false
          )
            throw fail("PUBLISH_NOT_CONFIRMED", 503);
          await c.query(
            "UPDATE dead_letters SET status='BROKER_CONFIRMED',replayed_at=now() WHERE id=$1",
            [row.id],
          );
        }
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  return { store, list, replay, relay, close: () => publish.close?.() };
}
function mountDlq(app, { dlq, need }) {
  app.get("/api/admin/dlq", need("ADMIN"), async (req, res) => {
    const limit = Number(req.query.limit ?? 20),
      offset = Number(req.query.offset ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      return res.status(400).json({ error: "INVALID_PAGINATION" });
    try {
      res.json(await dlq.list({ limit, offset }));
    } catch {
      res.status(503).json({ error: "DLQ_UNAVAILABLE" });
    }
  });
  app.post("/api/admin/dlq/:id/replay", need("ADMIN"), async (req, res) => {
    if (!/^[1-9]\d{0,17}$/.test(req.params.id))
      return res.status(400).json({ error: "INVALID_ID" });
    try {
      res
        .status(202)
        .json(await dlq.replay(req.params.id, req.body, req.user.sub));
    } catch (e) {
      res.status(e.status ?? 503).json({ error: e.code ?? "DLQ_UNAVAILABLE" });
    }
  });
}
function startDlq({
  url,
  dlq,
  log = console,
  connect = (u) => amqp.connect(u, { timeout: 2000 }),
  intervalMs = 500,
  timers = { setInterval, clearInterval },
}) {
  const connectAny = makeConnector(url, connect);
  let stopped = false,
    current,
    job;
  async function retire(s) {
    if (!s || s.dead) return;
    s.dead = true;
    if (current === s) current = undefined;
    await s.conn.close().catch(() => {});
  }
  function tick() {
    if (stopped || job) return job;
    job = (async () => {
      try {
        let s = current;
        if (!s) {
          const conn = await connectAny();
          s = { conn, dead: false };
          current = s;
          conn.on("error", () => {
            void retire(s);
          });
          conn.on("close", () => {
            void retire(s);
          });
          if (stopped) {
            await retire(s);
            return;
          }
          s.ch = await conn.createChannel();
          s.ch.on("error", () => {
            void retire(s);
          });
          s.ch.on("close", () => {
            void retire(s);
          });
          await s.ch.checkQueue("cmd.dead");
        }
        if (s.dead || stopped) return;
        const m = await s.ch.get("cmd.dead", { noAck: false });
        if (m) {
          await dlq.store(m);
          if (!s.dead && !stopped) s.ch.ack(m);
        }
        if (!stopped) await dlq.relay();
      } catch {
        log.error("DLQ cycle failed");
        await retire(current);
      }
    })().finally(() => {
      job = undefined;
    });
    return job;
  }
  const timer = timers.setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      stopped = true;
      timers.clearInterval(timer);
      await job;
      await retire(current);
      await dlq.close();
    },
  };
}
module.exports = { makeDlq, mountDlq, startDlq, validPayload, view };
