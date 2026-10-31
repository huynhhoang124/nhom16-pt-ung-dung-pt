
const express = require('express');
const { pool, initDb } = require('./db');
const { startConsumer } = require('./consumer');

const app = express();
const PORT = Number(process.env.PORT || 8011);

app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'stats-service' });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      message: 'Database unavailable',
    });
  }
});


app.get('/api/stats', async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from >= to
  ) {
    return res.status(400).json({ error: 'INVALID_RANGE' });
  }

  try {
    const [hourlyResult, sessionsResult, stateResult] = await Promise.all([
      pool.query(
        `SELECT parking_id,
                COALESCE(SUM(entries), 0)::int AS entries,
                COALESCE(SUM(exits), 0)::int AS exits,
                COALESCE(SUM(revenue), 0)::numeric(14, 2) AS revenue,
                EXTRACT(HOUR FROM hour AT TIME ZONE 'UTC')::int AS hour_of_day
         FROM stats_hourly
         WHERE hour >= $1 AND hour < $2
         GROUP BY parking_id, hour_of_day`,
        [from, to]
      ),
      pool.query(
        `SELECT parking_id,
                COUNT(*) FILTER (
                  WHERE entered_at >= $1 AND entered_at < $2
                )::int AS sessions,
                COUNT(*) FILTER (
                  WHERE exited_at >= $1 AND exited_at < $2
                )::int AS exited,
                COALESCE(
                  ROUND(AVG(EXTRACT(EPOCH FROM (exited_at - entered_at)) / 60)
                    FILTER (
                      WHERE entered_at IS NOT NULL
                        AND exited_at IS NOT NULL
                        AND exited_at >= $1 AND exited_at < $2
                    )),
                  0
                )::int AS avg_minutes
         FROM stats_sessions
         GROUP BY parking_id`,
        [from, to]
      ),
      pool.query(
        `SELECT parking_id, available, total
         FROM stats_parking_state`
      ),
    ]);

    const map = new Map();

    function getParking(id) {
      if (!map.has(id)) {
        map.set(id, {
          parkingId: id,
          entries: 0,
          exits: 0,
          revenue: 0,
          sessions: 0,
          exited: 0,
          avgMinutes: 0,
          occupied: 0,
          total: 0,
          byHour: Array(24).fill(0),
        });
      }
      return map.get(id);
    }

    for (const row of hourlyResult.rows) {
      const p = getParking(row.parking_id);
      p.entries += row.entries;
      p.exits += row.exits;
      p.revenue += Number(row.revenue);
      p.byHour[row.hour_of_day] += row.entries;
    }

    for (const row of sessionsResult.rows) {
      const p = getParking(row.parking_id);
      p.sessions = row.sessions;
      p.exited = row.exited;
      p.avgMinutes = row.avg_minutes;
    }

    for (const row of stateResult.rows) {
      const p = getParking(row.parking_id);
      p.total = row.total;
      p.occupied = Math.max(0, row.total - row.available);
    }

    const parkings = [...map.values()];
    const sum = (key) =>
      parkings.reduce((total, p) => total + (p[key] || 0), 0);
    const exited = sum('exited');

    const total = {
      entries: sum('entries'),
      exits: sum('exits'),
      sessions: sum('sessions'),
      exited,
      revenue: Number(sum('revenue').toFixed(2)),
      occupied: sum('occupied'),
      total: sum('total'),
      avgMinutes: exited
        ? Math.round(
            parkings.reduce((n, p) => n + p.avgMinutes * p.exited, 0) / exited
          )
        : 0,
      byHour: Array.from(
        { length: 24 },
        (_, hour) => parkings.reduce((n, p) => n + p.byHour[hour], 0)
      ),
    };

    res.json({
      entries: total.entries,
      exits: total.exits,
      revenue: total.revenue,
      total,
      parkings,
      unavailable: [],
    });
  } catch (error) {
    console.error('[stats-service] Stats query failed:', error.message);
    res.status(500).json({ error: 'STATS_QUERY_FAILED' });
  }
});


async function main() {
  await initDb();

  app.listen(PORT, () => {
    console.log(`[stats-service] API listening on port ${PORT}`);
  });

  startConsumer().catch((error) => {
    console.error('[stats-service] Consumer failed:', error);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error('[stats-service] Startup failed:', error);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
