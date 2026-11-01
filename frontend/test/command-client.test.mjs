import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { makeCommandClient } from "../src/command-client.js";
import { createHash } from "node:crypto";
function fixture(t, storage = new Map()) {
  const socket = new EventEmitter(),
    calls = [];
  let state = "PENDING",
    count = 0,
    current = { id: "u" },
    writeStatus = 202;
  const api = async (path, opts) => {
    calls.push({ path, opts });
    return opts
      ? {
          ok: writeStatus === 202,
          status: writeStatus,
          data: { commandId: "u:key", unknown: writeStatus === 503 },
        }
      : {
          ok: true,
          status: 200,
          data: {
            status: state,
            statusCode: 201,
            result: { id: "reservation" },
          },
        };
  };
  const client = makeCommandClient({
    api,
    socket,
    user: () => current,
    newKey: () => `key-${++count}`,
    digest: (s) => createHash("sha256").update(s).digest("hex"),
    storage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
    },
    intervalMs: 100000,
  });
  t.after(() => client.close());
  return {
    client,
    calls,
    storage,
    socket,
    done() {
      state = "DONE";
    },
    uncertain() {
      writeStatus = 503;
    },
    user(v) {
      current = v;
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
test("202 remains processing; polling resolves a lost socket event; key stable across retry", async (t) => {
  const { client, calls, done } = fixture(t);
  let pending = 0;
  const a = client.request(
    "/reserve",
    { method: "POST", body: { slot: "A01" } },
    () => pending++,
  );
  await tick();
  const b = client.request(
    "/reserve",
    { method: "POST", body: { slot: "A01" } },
    () => pending++,
  );
  await tick();
  assert.equal(pending, 2);
  assert.equal(
    calls.filter((c) => c.opts)[0].opts.headers["idempotency-key"],
    calls.filter((c) => c.opts)[1].opts.headers["idempotency-key"],
  );
  done();
  await client.poll();
  assert.equal((await a).status, 201);
  assert.equal((await b).data.id, "reservation");
});
test("uncertain persistence 503 is tracked by the original ID rather than treated as definitely failed", async (t) => {
  const f = fixture(t);
  f.uncertain();
  const result = f.client.request("/reserve", { method: "POST" });
  await tick();
  assert.equal(f.client.snapshot()[0].status, "PENDING");
  f.done();
  await f.client.poll();
  assert.equal((await result).status, 503);
  assert.equal(f.client.snapshot()[0].status, "DONE");
});
test("reload restores pending ID without republishing; reconnect polls DB; other users see none", async (t) => {
  const first = fixture(t);
  first.client.request("/reserve", { method: "POST" });
  await tick();
  first.client.close();
  const next = fixture(t, first.storage);
  assert.equal(next.client.snapshot()[0].status, "PENDING");
  next.done();
  next.socket.emit("connect");
  await tick();
  assert.equal(next.client.snapshot()[0].status, "DONE");
  assert.equal(next.calls.filter((c) => c.opts).length, 0);
  next.user({ id: "other" });
  assert.equal(next.client.snapshot().length, 0);
});

test("unknown persistence with missing DB row permits same-key retry instead of trapping the form", async (t) => {
  const storage = new Map();
  const socket = new EventEmitter();
  const writes = [];
  const client = makeCommandClient({
    api: async (_path, opts) => {
      if (opts) {
        writes.push(opts.headers["idempotency-key"]);
        return {
          ok: false,
          status: 503,
          data: { commandId: "u:stable", unknown: true },
        };
      }
      return { ok: false, status: 404, data: { error: "COMMAND_NOT_FOUND" } };
    },
    socket,
    user: () => ({ id: "u" }),
    newKey: () => "stable",
    digest: () => "same-action",
    intervalMs: 100000,
    storage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
    },
  });
  t.after(() => client.close());
  assert.equal(
    (await client.request("/reserve", { method: "POST" })).status,
    503,
  );
  assert.equal(
    (await client.request("/reserve", { method: "POST" })).status,
    503,
  );
  assert.deepEqual(writes, ["stable", "stable"]);
  assert.equal(client.snapshot()[0].status, "PENDING");
});
