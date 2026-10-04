// Dựng một "hệ phân tán thu nhỏ" trong tiến trình test:
// mỗi bãi = app Parking Node thật + DB PGlite riêng, Aggregator thật + DB PGlite riêng, nói chuyện qua HTTP thật.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { PGlite } = require('@electric-sql/pglite');
const { makeApp: makeNodeApp } = require('../../parking-node/src/app');
const { init: initNode } = require('../../parking-node/src/db');
const { makeRegistry } = require('../src/nodes');
const { makeAuth, seedUsers } = require('../src/auth');
const { makeApp } = require('../src/routes');

const KEY = 'test-key';

async function pglitePool() {
  const db = new PGlite();
  const query = async (sql, params) => {
    const r = params ? await db.query(sql, params) : (await db.exec(sql)).at(-1) ?? { rows: [] };
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  };
  return { query, connect: async () => ({ query, release() {} }) };
}

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () =>
    resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});

async function startNode(parkingId, count = 3) {
  const pool = await pglitePool();
  await initNode(pool, parkingId, count);
  const { server, url } = await listen(makeNodeApp({ pool, parkingId, internalKey: KEY }));
  return { pool, server, url };
}

// Node "giả" để mô phỏng bãi chậm hoặc chết: trả lời sau `delay` ms (hoặc không bao giờ).
async function startStub(delayMs) {
  let delay = delayMs;
  const { server, url } = await listen((req, res) => {
    if (delay === Infinity) return;   // treo: không bao giờ trả lời
    setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end('{"status":"UP","available":1,"total":1}'); }, delay);
  });
  return { server, url, setDelay: (d) => { delay = d; } };
}

// Node "chập chờn": `failures` request đầu trả 500, sau đó trả 200. Đếm số request nhận được (trừ /health).
async function startFlaky(failures) {
  const state = { failures, hits: 0 };
  const { server, url } = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end('{"status":"UP"}');
    state.hits++;
    if (state.failures-- > 0) { res.statusCode = 500; return res.end('{"error":"INTERNAL_ERROR"}'); }
    res.statusCode = req.method === 'POST' ? 201 : 200;
    res.end('{"ok":true}');
  });
  return { server, url, state };
}

async function startAggregator(nodes, { timeoutMs = 400, reserveTimeoutMs = 400 } = {}) {
  const pool = await pglitePool();
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8'));
  await seedUsers(pool, 'pw');
  const reg = makeRegistry({ internalKey: KEY, timeoutMs, failThreshold: 3 });
  for (const [id, url] of Object.entries(nodes)) {
    await pool.query('INSERT INTO parking_nodes(parking_id, name, api_url) VALUES ($1,$2,$3)', [id, `Bãi ${id}`, url]);
    reg.add({ parking_id: id, name: `Bãi ${id}`, api_url: url });
  }
  const cache = new Map();
  const app = makeApp({ pool, reg, cache, auth: makeAuth('secret'), reserveTimeoutMs });
  const { server, url } = await listen(app);

  const call = async (p, { method = 'GET', token, body, key } = {}) => {
    const r = await fetch(url + p, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const login = async (username) => (await call('/api/auth/login', { method: 'POST', body: { username, password: 'pw' } })).body.token;
  return { pool, reg, cache, server, call, login };
}

module.exports = { startNode, startStub, startFlaky, startAggregator, KEY };
