
const { connect, Offset } = require('rabbitmq-stream-js-client');
const { pool } = require('./db');

const STREAM_HOST = process.env.STREAM_HOST || 'rabbitmq';
const STREAM_PORT = Number(process.env.STREAM_PORT || 5552);
const STREAM_NAME = process.env.STREAM_NAME || 'events.stream';
const CONSUMER_NAME = 'stats-service-v1';

function getHour(timestamp) {
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date;
}

async function processEvent(message, offset) {
  let event;

  try {
    event = JSON.parse(message.content.toString('utf8'));
    console.log('[stats-service] EVENT:', JSON.stringify(event));
  } catch (error) {
    console.error('[stats-service] Invalid event JSON:', error.message);
    return;
  }

  const eventId = String(event.eventId ?? event.id ?? offset);
  const parkingId = event.parkingId;
  const type = String(
    event.event === 'PAYMENT_COMPLETED' ||
    event.event === 'PAYMENT_SUCCESS'
      ? event.event
      : event.type || ''
  ).toUpperCase();
  const occurredAt = event.occurredAt || event.createdAt || new Date().toISOString();

  // Bỏ qua marker hoặc sự kiện không có parkingId.
  if (!parkingId) return;

  const hour = getHour(occurredAt);
  const zone = String(event.zone || event.floor || 'default');

  let entries = 0;
  let exits = 0;
  let revenue = 0;

  if (['CAR_ENTER', 'VEHICLE_ENTER'].includes(type)) {
    entries = 1;
  } else if (['CAR_EXIT', 'VEHICLE_EXIT'].includes(type)) {
    exits = 1;
  } else if (['PAYMENT_COMPLETED', 'PAYMENT_SUCCESS'].includes(type)) {
    revenue = Number(
      event.fee ??
      event.amount ??
      event.revenue ??
      event.session?.fee ??
      0
    );
  } else if (type !== 'SLOT_UPDATED') {
    return;
  }

  if (!Number.isFinite(revenue)) {
    console.warn('[stats-service] Invalid revenue:', eventId);
    return;
  }

  const sessionId =
  event.sessionId ??
  event.session?.id ??
  event.session?.sessionId ??
  null;
  const available = Number(event.available);
  const total = Number(event.total);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO stats_processed_events (event_id)
       VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId]
    );

    // Đã xử lý sự kiện này thì không cộng thống kê lần nữa.
    if (inserted.rowCount === 0) {
      await client.query('COMMIT');
      return;
    }

    if (entries || exits || revenue) {
      await client.query(
        `INSERT INTO stats_hourly
           (hour, parking_id, zone, entries, exits, revenue)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (hour, parking_id, zone)
         DO UPDATE SET
           entries = stats_hourly.entries + EXCLUDED.entries,
           exits = stats_hourly.exits + EXCLUDED.exits,
           revenue = stats_hourly.revenue + EXCLUDED.revenue`,
        [hour, String(parkingId), zone, entries, exits, revenue]
      );
    }

    if (Number.isInteger(available) && Number.isInteger(total)) {
      await client.query(
        `INSERT INTO stats_parking_state
           (parking_id, available, total, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (parking_id)
         DO UPDATE SET
           available = EXCLUDED.available,
           total = EXCLUDED.total,
           updated_at = NOW()`,
        [String(parkingId), available, total]
      );
    }

    if (sessionId && entries) {
      await client.query(
        `INSERT INTO stats_sessions
           (session_id, parking_id, entered_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id)
         DO UPDATE SET
           entered_at = COALESCE(stats_sessions.entered_at, EXCLUDED.entered_at),
           updated_at = NOW()`,
        [String(sessionId), String(parkingId), occurredAt]
      );
    }

    if (sessionId && exits) {
      const fee = Number(
        event.fee ??
        event.amount ??
        event.revenue ??
        event.session?.fee ??
        0
      );

      await client.query(
        `INSERT INTO stats_sessions
          (session_id, parking_id, exited_at, fee)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (session_id)
        DO UPDATE SET
          exited_at = EXCLUDED.exited_at,
          fee = GREATEST(stats_sessions.fee, EXCLUDED.fee),
          updated_at = NOW()`,
        [String(sessionId), String(parkingId), occurredAt, fee]
      );
    }

    if (sessionId && revenue) {
      await client.query(
        `INSERT INTO stats_sessions
           (session_id, parking_id, fee)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id)
         DO UPDATE SET
           fee = GREATEST(stats_sessions.fee, EXCLUDED.fee),
           updated_at = NOW()`,
        [String(sessionId), String(parkingId), revenue]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function startConsumer() {
  const client = await connect({
    hostname: STREAM_HOST,
    port: STREAM_PORT,
    username: process.env.STREAM_USER || 'parking',
    password: process.env.STREAM_PASSWORD || 'parking',
    vhost: process.env.STREAM_VHOST || '/',
  });

  try {
    await pool.query(
      `INSERT INTO stats_consumer_offsets
         (consumer_name, stream_name, last_offset)
       VALUES ($1, $2, -1)
       ON CONFLICT (consumer_name) DO NOTHING`,
      [CONSUMER_NAME, STREAM_NAME]
    );

    const saved = await pool.query(
      `SELECT last_offset
       FROM stats_consumer_offsets
       WHERE consumer_name = $1`,
      [CONSUMER_NAME]
    );

    const lastOffset = BigInt(saved.rows[0].last_offset);
    const startOffset =
      lastOffset < 0n ? Offset.first() : Offset.offset(lastOffset + 1n);

    const consumer = await client.declareConsumer(
      { stream: STREAM_NAME, offset: startOffset },
      async (message) => {
        const offset = BigInt(message.offset);

        try {
          await processEvent(message, offset.toString());

          await pool.query(
            `UPDATE stats_consumer_offsets
             SET last_offset = GREATEST(last_offset, $2),
                 updated_at = NOW()
             WHERE consumer_name = $1`,
            [CONSUMER_NAME, offset.toString()]
          );
        } catch (error) {
          console.error(
            `[stats-service] Failed at offset ${offset}:`,
            error.message
          );
        }
      }
    );

    console.log(
      `[stats-service] Consuming ${STREAM_NAME} from offset ${lastOffset + 1n}`
    );

    return { client, consumer };
  } catch (error) {
    await client.close();
    throw error;
  }
}

module.exports = { startConsumer, processEvent };
