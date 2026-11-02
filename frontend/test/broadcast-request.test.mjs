import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeBroadcastRequest } from "../src/broadcast-request.js";
function fixture(storage = new Map()) {
  let count = 0;
  const options = {
    storage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    storageKey: "admin:request",
    digest: (value) => createHash("sha256").update(value).digest("hex"),
    newKey: () => `key-${++count}`,
  };
  return { storage, create: () => makeBroadcastRequest(options) };
}
const input = {
  zone: "nam",
  type: "banPlates",
  body: { plates: ["30A-123.45"], banned: true },
};
test("same operation/reload reuses key before response; payload and plates are not stored", async () => {
  const f = fixture();
  const a = await f.create().prepare(input, "admin");
  const reloaded = f.create();
  const b = await reloaded.prepare(
    {
      type: "banPlates",
      body: { banned: true, plates: ["30A-123.45"] },
      zone: "nam",
    },
    "admin",
  );
  assert.equal(b.key, a.key);
  assert.equal(b.broadcastId, a.broadcastId);
  assert.equal(reloaded.read().broadcastId, "admin:broadcast-key-1");
  assert(!JSON.stringify([...f.storage.values()]).includes("30A"));
  assert(!JSON.stringify([...f.storage.values()]).includes("plates"));
});
test("changed operation or explicit compose-new gets a new key; malformed storage is ignored", async () => {
  const f = fixture();
  const c = f.create();
  const a = await c.prepare(input, "admin");
  const b = await c.prepare({ ...input, zone: "all" }, "admin");
  assert.notEqual(b.key, a.key);
  c.clear();
  assert.equal(c.read(), null);
  const d = await c.prepare(input, "admin");
  assert.notEqual(d.key, a.key);
  f.storage.set("admin:request", '{"key":"bad.*"}');
  assert.equal(f.create().read(), null);
});
