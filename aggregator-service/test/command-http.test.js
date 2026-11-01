const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const { makeApp } = require("../src/routes");
const { makeAuth } = require("../src/auth");

test("broker HTTP contracts: 201/202, ownership/admin lookup, server actor and malformed body", async (t) => {
  const calls = [];
  let pending = false;
  const flow = {
    execute: async (command) => {
      calls.push(command);
      return {
        code: pending ? 202 : 201,
        body: {
          commandId: "owner:key",
          ...(pending ? { status: "PENDING" } : { id: "reservation" }),
        },
      };
    },
    get: async () => ({
      id: "owner:key",
      user_id: "owner",
      parking_id: "A",
      type: "reserve",
      status: "DONE",
      result: { id: "reservation" },
      status_code: 201,
      publish_state: "CONFIRMED",
    }),
  };
  const reg = {
    all: () => [],
    get: () => {
      throw new Error("broker path must not use HTTP node registry");
    },
  };
  const app = makeApp({
    pool: {},
    reg,
    cache: new Map(),
    auth: makeAuth("key"),
    commandFlow: flow,
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const auth = (sub, role = "USER") => ({
    authorization: `Bearer ${jwt.sign({ sub, role }, "key")}`,
  });
  const lookup = (sub, role) =>
    fetch(url + "/api/commands/owner%3Akey", { headers: auth(sub, role) });
  assert.equal((await fetch(url + "/api/commands/owner%3Akey")).status, 401);
  assert.equal((await lookup("other")).status, 404);
  assert.equal((await lookup("owner")).status, 200);
  assert.equal((await lookup("admin", "ADMIN")).status, 200);
  const send = (body) =>
    fetch(url + "/api/parkings/A/reservations", {
      method: "POST",
      headers: {
        ...auth("owner"),
        "content-type": "application/json",
        "idempotency-key": "key",
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await send({
        slotCode: "A01",
        actor: { userId: "attacker", role: "ADMIN" },
      })
    ).status,
    201,
  );
  assert.equal(calls[0].user.sub, "owner");
  assert.equal(calls[0].user.role, "USER");
  pending = true;
  const accepted = await send({ slotCode: "A01" });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get("location"), "/api/commands/owner%3Akey");
  assert.equal((await send([])).status, 400);
  assert.equal(calls.length, 2);
});
