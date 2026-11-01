import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {}
const root = new URL("..", import.meta.url),
  require = createRequire(
    new URL("../aggregator-service/package.json", import.meta.url),
  );
const amqp = require("amqplib"),
  { io } = createRequire(new URL("../frontend/package.json", import.meta.url))(
    "socket.io-client",
  );
const key = process.env.INTERNAL_KEY,
  base = "http://localhost:8000",
  second = "http://localhost:8100";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (...args) =>
  execFileSync("docker", ["compose", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const sql = (db, q) =>
  compose(
    "exec",
    "-T",
    db,
    "psql",
    "-U",
    "postgres",
    "-d",
    "parking",
    "-tAc",
    q,
  );
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const out = await fn();
      if (out) return out;
    } catch {}
    await sleep(100);
  }
  throw new Error("timeout");
}
async function http(url, { token, method = "GET", body, headers = {} } = {}) {
  const r = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
test(
  "PD03 broker request-reply on the actual service entrypoints",
  { skip: process.env.PD03_BROKER !== "1", timeout: 240000 },
  async (t) => {
    const suffix = Date.now().toString().slice(-5),
      prefix = `P${suffix}`,
      ids = [],
      sockets = [],
      slots = [];
    let n = 0,
      parked = new Set(),
      aggKilled = false;
    const login = async (name) =>
      (
        await http(base + "/api/auth/login", {
          method: "POST",
          body: {
            username: name,
            password: process.env.DEMO_PASSWORD ?? "123456",
          },
        })
      ).body;
    const session = await login("user1"),
      other = await login("user2"),
      admin = await login("admin");
    const connect = async (url, token) => {
      const socket = io(url, {
        transports: ["websocket"],
        auth: { token },
        reconnection: false,
      });
      sockets.push(socket);
      await until(() => socket.connected, 10000);
      return socket;
    };
    const socket = await connect(base, session.token),
      otherSocket = await connect(base, other.token),
      received = [],
      leaked = [];
    socket.on("COMMAND_RESULT", (m) => received.push(m));
    otherSocket.on("COMMAND_RESULT", (m) => leaked.push(m));
    const node = (id, path, options = {}) =>
      http(`http://localhost:${{ A: 8001, B: 8002, C: 8003 }[id]}${path}`, {
        ...options,
        headers: { "x-internal-key": key, ...options.headers },
      });
    async function slot(id) {
      const code = `${prefix}${++n}`;
      const r = await node(id, "/api/slots", {
        method: "POST",
        body: { slotCode: code, type: "CAR", floor: 1 },
      });
      assert.ok([200, 201].includes(r.status));
      slots.push({ id, code });
      return code;
    }
    const reserve = (id, code, k, headers = {}) =>
      http(base + `/api/parkings/${id}/reservations`, {
        method: "POST",
        token: session.token,
        headers: { "idempotency-key": k, ...headers },
        body: { slotCode: code, licensePlate: "30A-123.45" },
      });
    const remember = (k) => {
      const id = `${session.user.id}:${k}`;
      ids.push(id);
      return id;
    };
    t.after(async () => {
      sockets.forEach((s) => s.disconnect());
      for (const id of parked) compose("start", `parking-${id.toLowerCase()}`);
      if (aggKilled) compose("start", "aggregator");
      await until(
        async () => (await http(base + "/health")).status === 200,
        35000,
      );
      for (const db of ["db-a", "db-b", "db-c"]) {
        const chosen = slots
          .filter((s) => `db-${s.id.toLowerCase()}` === db)
          .map((s) => quote(s.code));
        if (!chosen.length) continue;
        const own = `SELECT id FROM parking_slots WHERE slot_code IN (${chosen.join(",")})`;
        sql(
          db,
          `DELETE FROM parking_sessions WHERE slot_id IN (${own}); DELETE FROM reservations WHERE slot_id IN (${own}); DELETE FROM parking_events WHERE slot_code IN (${chosen.join(",")}); DELETE FROM parking_slots WHERE id IN (${own})`,
        );
        if (ids.length)
          sql(
            db,
            `DELETE FROM command_reply_outbox WHERE command_id IN (${ids.map(quote).join(",")}); DELETE FROM inbox_messages WHERE message_id IN (${ids.map(quote).join(",")})`,
          );
      }
      if (ids.length)
        sql(
          "db-agg",
          `DELETE FROM commands WHERE id IN (${ids.map(quote).join(",")})`,
        );
    });
    await t.test(
      "TC51 201 <=3s, correlation/trace preserved, owner/admin only, immediate slot version",
      async () => {
        const code = await slot("A"),
          k = randomUUID(),
          id = remember(k),
          trace = "00-11111111111111111111111111111111-2222222222222222-01";
        const conn = await amqp.connect(
          process.env.PD03_AMQP_URL ??
            "amqp://parking:parking@localhost:5673/%2F",
        );
        try {
          const ch = await conn.createChannel(),
            q = await ch.assertQueue("", { exclusive: true });
          await ch.bindQueue(q.queue, "parking.replies", "agg.1");
          const start = Date.now(),
            r = await reserve("A", code, k, { traceparent: trace });
          assert.equal(r.status, 201);
          assert.equal(r.body.commandId, id);
          const responseMs = Date.now() - start;
        assert.ok(responseMs <= 3000);
          const m = await until(async () => {
            const m = await ch.get(q.queue, { noAck: true });
            return m && m.properties.correlationId === id ? m : false;
          });
          assert.equal(m.properties.headers.traceparent, trace);
          assert.equal(JSON.parse(m.content).traceparent, trace);
          assert.ok(Number.isInteger(JSON.parse(m.content).slot.version));
          await until(() => received.find((x) => x.commandId === id));
          assert.equal(
            leaked.some((x) => x.commandId === id),
            false,
          );
          assert.equal(
            (
              await http(second + `/api/commands/${encodeURIComponent(id)}`, {
                token: session.token,
              })
            ).body.status,
            "DONE",
          );
          assert.equal(
            (
              await http(base + `/api/commands/${encodeURIComponent(id)}`, {
                token: other.token,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await http(base + `/api/commands/${encodeURIComponent(id)}`, {
                token: admin.token,
              })
            ).status,
            200,
          );
          assert.equal((await reserve("A", code + "X", k)).status, 422);
          console.log("TC51 response ms:", responseMs);
        } finally {
          await conn.close();
        }
      },
    );
    await t.test(
      "TC52 ten HTTP requests same key -> same command/result and one reservation",
      async () => {
        const code = await slot("A"),
          k = randomUUID(),
          id = remember(k),
          responses = await Promise.all(
            Array.from({ length: 10 }, () => reserve("A", code, k)),
          );
        assert.ok(responses.every((r) => r.status === 201));
        assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
        assert.ok(responses.every((r) => r.body.commandId === id));
        assert.equal(
          sql(
            "db-a",
            `SELECT count(*) FROM reservations WHERE request_id=${quote(id)}`,
          ),
          "1",
        );
      },
    );
    await t.test(
      "TC54 node stopped 5s -> 202 then Socket.IO terminal",
      async () => {
        const code = await slot("B"),
          k = randomUUID(),
          id = remember(k);
        compose("stop", "parking-b");
        parked.add("B");
        try {
          const start = Date.now(),
            r = await reserve("B", code, k);
          assert.equal(r.status, 202);
          assert.equal(r.body.commandId, id);
          await sleep(Math.max(0, 5000 - (Date.now() - start)));
          compose("start", "parking-b");
          parked.delete("B");
          const event = await until(
            () => received.find((x) => x.commandId === id),
            15000,
          );
          assert.equal(event.status, "DONE");
          assert.equal(
            (
              await http(second + `/api/commands/${encodeURIComponent(id)}`, {
                token: session.token,
              })
            ).body.status,
            "DONE",
          );
        } finally {
          if (parked.has("B")) {
            compose("start", "parking-b");
            parked.delete("B");
          }
        }
      },
    );
    await t.test(
      "cancel and pay use broker and preserve old response payloads",
      async () => {
        const code = await slot("A"),
          k = randomUUID(),
          id = remember(k),
          r = await reserve("A", code, k);
        assert.equal(r.status, 201);
        const cancelKey = randomUUID();
        remember(cancelKey);
        const cancelled = await http(
          base + `/api/parkings/A/reservations/${r.body.id}`,
          {
            method: "DELETE",
            token: session.token,
            headers: { "idempotency-key": cancelKey },
          },
        );
        assert.equal(cancelled.status, 200);
        assert.equal(cancelled.body.status, "CANCELLED");
        const paidCode = await slot("A"),
          reserveKey = randomUUID();
        remember(reserveKey);
        const booking = await reserve("A", paidCode, reserveKey);
        assert.equal(booking.status, 201);
        const entered = await node("A", `/api/slots/${paidCode}/enter`, {
          method: "POST",
          body: {},
        });
        assert.equal(entered.status, 200);
        sql(
          "db-a",
          `UPDATE parking_sessions SET entered_at=now()-interval '20 minutes' WHERE slot_id=(SELECT id FROM parking_slots WHERE slot_code=${quote(paidCode)})`,
        );
        const sessionId = sql(
            "db-a",
            `SELECT id FROM parking_sessions WHERE slot_id=(SELECT id FROM parking_slots WHERE slot_code=${quote(paidCode)})`,
          ),
          payKey = randomUUID();
        remember(payKey);
        const paid = await http(base + `/api/me/sessions/A/${sessionId}/pay`, {
          method: "POST",
          token: session.token,
          headers: { "idempotency-key": payKey },
        });
        assert.equal(paid.status, 200);
        assert.ok(paid.body.paidAt);
      },
    );
    await t.test(
      "TC62 sender SIGKILL before reply -> aggregator-2 persists terminal result",
      async () => {
        const code = await slot("C"),
          k = randomUUID(),
          id = remember(k),
          s2 = await connect(second, session.token),
          seen = [];
        s2.on("COMMAND_RESULT", (m) => seen.push(m));
        compose("stop", "parking-c");
        parked.add("C");
        try {
          assert.equal((await reserve("C", code, k)).status, 202);
          compose("kill", "-s", "SIGKILL", "aggregator");
          aggKilled = true;
          compose("start", "parking-c");
          parked.delete("C");
          const row = await until(async () => {
            const r = await http(
              second + `/api/commands/${encodeURIComponent(id)}`,
              { token: session.token },
            );
            return r.body.status === "DONE" ? r.body : false;
          }, 15000);
          assert.ok(row.result.id);
          assert.equal(row.statusCode, 201);
          await until(() => seen.find((x) => x.commandId === id));
          assert.equal(
            sql(
              "db-c",
              `SELECT count(*) FROM reservations WHERE request_id=${quote(id)}`,
            ),
            "1",
          );
          console.log("TC62 terminal on surviving aggregator:", row.status);
        } finally {
          if (parked.has("C")) {
            compose("start", "parking-c");
            parked.delete("C");
          }
          compose("start", "aggregator");
          aggKilled = false;
          await until(
            async () => (await http(base + "/health")).status === 200,
            35000,
          );
        }
      },
    );
  },
);
