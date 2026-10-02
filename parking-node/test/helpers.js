// PGlite = PostgreSQL thật chạy trong tiến trình (WASM), bọc lại theo API của pg.Pool.
// Chỉ có MỘT kết nối: kiểm được logic SQL, KHÔNG kiểm được tranh chấp song song (việc đó để e2e trên Postgres thật).
const { PGlite } = require('@electric-sql/pglite');
const { init } = require('../src/db');

async function makePool(prefix = 'A', count = 5) {
  const db = new PGlite();
  const query = async (sql, params) => {
    const r = params ? await db.query(sql, params) : (await db.exec(sql)).at(-1) ?? { rows: [] };
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }), db };
  await init(pool, prefix, count);
  return pool;
}

const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];

module.exports = { makePool, one };
