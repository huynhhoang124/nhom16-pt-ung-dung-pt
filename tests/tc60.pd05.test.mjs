
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(
  new URL('../aggregator-service/package.json', import.meta.url)
);
const amqp = require('amqplib');
const { makeCommands } = require('../aggregator-service/src/commands');

const options = { timeout: 120000 };
const url = process.env.PD02_AMQP_URL ?? 'amqp://parking:parking@localhost/%2F';

export function registerTc60Pd05Tests({
  ROOT,
  sh,
  sql,
  node,
  login,
  freeSlot,
  KEY,
}) {
  const docker = (...args) =>
    execFileSync('docker', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  async function waitFor(label, predicate, timeoutMs = 15000, intervalMs = 100) {
    const started = Date.now();
    let lastError;

    while (Date.now() - started < timeoutMs) {
      try {
        const result = await predicate();
        if (result) return result;
      } catch (error) {
        lastError = error;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `${label}: timeout after ${timeoutMs}ms` +
      (lastError ? `; last error: ${lastError.message}` : '')
    );
  }

  function listAConsumers() {
    const output = sh(
      'docker compose --profile ha exec -T rabbitmq rabbitmqctl list_consumers -p /'
    );

    return output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[0] === 'cmd.A')
      .map((parts) => ({
        consumerTag: parts[2],
        active: parts[5] === 'true',
      }));
  }

  test(
    'TC60 PD-05 SAC: 100 numbered commands preserve FIFO order after active consumer failure',
    options,
    async (t) => {
      const runId = randomUUID().replaceAll('-', '').slice(0, 12);
      const helperName = `pd05-sac-${runId}`;
      const prefix = `${runId}:pd05-`;
      const helperScript = `
const { Pool } = require('pg');
const {
  startCommandConsumer,
  makeCommandProcessor
} = require('./src/commands');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', (error) => {
  console.error('PD05 database pool error:', error.message);
});

const parkingId = process.env.PARKING_ID || 'A';
const internalKey = process.env.INTERNAL_KEY || 'dev';
const delayMs = Number(process.env.PD05_PROCESS_DELAY_MS || 0);

const processor = makeCommandProcessor({
  pool,
  parkingId,
  internalKey,
  reservationMinutes: Number(process.env.RESERVATION_MINUTES || 15),
  qrSecret: process.env.QR_SECRET ||
    (internalKey + ':qr:' + parkingId)
});

const log = {
  info: (msg, fields = {}) =>
    console.log(JSON.stringify({ msg, ...fields })),
  error: (msg, fields = {}) =>
    console.error(JSON.stringify({ msg, ...fields }))
};

const consumer = startCommandConsumer({
  url: process.env.RABBITMQ_URL,
  pool,
  parkingId,
  internalKey,
  log,
  processCommand: async (message) => {
    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return processor(message);
  }
});

async function shutdown() {
  try {
    await consumer.stop();
  } finally {
    await pool.end().catch(() => {});
    process.exit(0);
  }
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error(error);
  process.exit(1);
});
`;

      let connection;
      let channel;
      let commands;
      let helperCreated = false;
      let parkingAStopped = false;
      let allCommandsPublished = false;
      let firstMessageId;
      let messagePrefix;
      let actor;

      const token = await login('user1');
      actor = {
        userId: JSON.parse(
          Buffer.from(token.split('.')[1], 'base64url')
        ).sub,
        role: 'USER',
      };

      messagePrefix = `${actor.userId}:pd05-${runId}-`;
      firstMessageId = `${messagePrefix}001`;

      const slotCode = await freeSlot('A');

      connection = await amqp.connect(url);
      channel = await connection.createChannel();

      await channel.assertExchange('parking.replies', 'direct', {
        durable: true,
      });

      const { queue } = await channel.assertQueue('', {
        exclusive: true,
      });

      const replyTo = `test.${randomUUID()}`;
      await channel.bindQueue(queue, 'parking.replies', replyTo);

      await channel.consume(queue, (message) => {
        if (message) channel.ack(message);
      });

      commands = makeCommands(url, { signingKey: KEY });

      t.after(async () => {
        // Kill and remove the temporary consumer, if it was created.
        if (helperCreated) {
          try {
            docker('rm', '-f', helperName);
          } catch {}
        }

        // Always restore the original parking-a service.
        if (parkingAStopped) {
          try {
            docker('compose', 'start', 'parking-a');

            await waitFor(
              'parking-a HTTP service restored',
              async () => (await node('A', '/api/slots')).status === 200,
              20000
            );
          } catch (error) {
            console.error('TC60 cleanup: parking-a restore failed:', error.message);
          }
        }

        // Drain all submitted test messages before removing their DB records.
        let drained = !allCommandsPublished;

        if (allCommandsPublished) {
          try {
            await waitFor(
              'TC60 cleanup: all messages processed',
              () =>
                sql(
                  'db-a',
                  `SELECT count(*) FROM inbox_messages WHERE message_id LIKE '${messagePrefix}%'`
                ) === '100',
              30000
            );
            drained = true;
          } catch {}
        }

        if (drained && messagePrefix) {
          try {
            const stored = sql(
              'db-a',
              `SELECT result::text FROM inbox_messages WHERE message_id='${firstMessageId}'`
            );

            if (stored) {
              const result = JSON.parse(stored);
              if (result?.id) {
                await node('A', `/api/reservations/${result.id}`, {
                  method: 'DELETE',
                });
              }
            }
          } catch (error) {
            console.error('TC60 cleanup: reservation restore:', error.message);
          }

          try {
            sql(
                'db-a',
                `DELETE FROM command_reply_outbox WHERE command_id LIKE '${messagePrefix}%'`
            );

            sql(
                'db-a',
                `DELETE FROM inbox_messages WHERE message_id LIKE '${messagePrefix}%'`
            );
          } catch (error) {
            console.error('TC60 cleanup: test records:', error.message);
          }
        }

        await commands?.close().catch(() => {});
        await channel?.close().catch(() => {});
        await connection?.close().catch(() => {});
      });

      // Preconditions: cmd.A is empty and has only its normal active consumer.
      const initialQueue = await channel.checkQueue('cmd.A');
      assert.equal(initialQueue.messageCount, 0, 'cmd.A must be empty before TC60');

      const initialConsumers = listAConsumers();
      assert.equal(initialConsumers.length, 1, 'expected one initial cmd.A consumer');
      assert.equal(initialConsumers[0].active, true);

      // Stop the original active consumer before creating the test consumer.
      docker('compose', 'stop', 'parking-a');
      parkingAStopped = true;

      await waitFor(
        'original cmd.A consumer disconnected',
        () => listAConsumers().length === 0,
        10000
      );

      // Start the test consumer first. Its small delay creates a deterministic
      // backlog so that failure occurs while messages are still unacknowledged.
      helperCreated = true;

      docker(
        'compose',
        'run',
        '-d',
        '--no-deps',
        '--name',
        helperName,
        '-e',
        'PD05_PROCESS_DELAY_MS=50',
        'parking-a',
        'node',
        '-e',
        helperScript
      );

      await waitFor(
        'temporary consumer registered as active',
        () => {
          const consumers = listAConsumers();
          return consumers.length === 1 && consumers[0].active;
        },
        15000
      );

      // Restart the original node. It must register as the SAC standby.
      docker('compose', 'start', 'parking-a');

      const twoConsumers = await waitFor(
        'both cmd.A consumers registered',
        () => {
          const consumers = listAConsumers();
          return consumers.length === 2 &&
            consumers.filter((c) => c.active).length === 1 &&
            consumers.filter((c) => !c.active).length === 1
            ? consumers
            : false;
        },
        20000
      );

      const helperLogs = docker('logs', helperName);
      const readyLine = helperLogs
        .split(/\r?\n/)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((entry) => entry?.msg === 'command consumer ready');

      assert.ok(readyLine?.consumerTag, 'temporary consumer did not report ready');

      const helperTag = readyLine.consumerTag;
      assert.equal(
        twoConsumers.find((consumer) => consumer.active)?.consumerTag,
        helperTag,
        'the first consumer must remain the SAC active consumer'
      );

      // Send 100 numbered commands through the project's real command publisher.
      const messages = Array.from({ length: 100 }, (_, index) => {
        const sequence = index + 1;
        const messageId = `${messagePrefix}${String(sequence).padStart(3, '0')}`;

        const plateNumber = 600 + Math.floor(index / 99);
        const plateSuffix = (index % 99) + 1;

        return {
          messageId,
          payload: {
            slotCode,
            licensePlate:
              `30A-${String(plateNumber).padStart(3, '0')}.` +
              String(plateSuffix).padStart(2, '0'),
          },
        };
      });

      await Promise.all(
        messages.map(({ messageId, payload }) =>
          commands.send('A', 'reserve', payload, {
            messageId,
            replyTo,
            actor,
          })
        )
      );

      allCommandsPublished = true;

      const inboxCount = () =>
        Number(
          sql(
            'db-a',
            `SELECT count(*) FROM inbox_messages WHERE message_id LIKE '${messagePrefix}%'`
          )
        );

      await waitFor(
        'active consumer processes the first commands',
        () => inboxCount() >= 5,
        15000
      );

      // Kill the active consumer without a graceful cancel/ack.
      const failoverStarted = Date.now();
      docker('kill', helperName);

      await waitFor(
        'parking-a takes over within five seconds',
        () => {
          const consumers = listAConsumers();
          return consumers.length === 1 &&
            consumers[0].active &&
            consumers[0].consumerTag !== helperTag;
        },
        5000,
        50
      );

      const failoverMs = Date.now() - failoverStarted;
      assert.ok(
        failoverMs <= 5000,
        `SAC failover took ${failoverMs}ms; expected at most 5000ms`
      );

      // Every numbered command must eventually be committed to the inbox.
      await waitFor(
        'all 100 commands processed',
        () => inboxCount() === 100,
        30000
      );

      assert.equal(inboxCount(), 100);

      const processedCount = sql(
        'db-a',
        `SELECT count(*) FROM inbox_messages WHERE message_id LIKE '${messagePrefix}%' AND processed_at IS NOT NULL`
      );

      assert.equal(processedCount, '100', 'all inbox entries must be processed');

      // The zero-padded message IDs sort in submitted sequence order.
      // A violation means a later command was processed before an earlier one.
      const orderViolations = sql(
        'db-a',
        `SELECT count(*) FROM (SELECT processed_at, lag(processed_at) OVER (ORDER BY message_id) AS previous_processed_at FROM inbox_messages WHERE message_id LIKE '${messagePrefix}%') AS ordered WHERE previous_processed_at > processed_at`
      );
      assert.equal(
        orderViolations,
        '0',
        'processed_at must preserve the submitted command order'
      );

      // All commands target one slot: only the first reservation may succeed.
      const reservationsCreated = sql(
        'db-a',
        `SELECT count(*) FROM reservations WHERE request_id LIKE '${messagePrefix}%'`
      );

      assert.equal(
        reservationsCreated,
        '1',
        'only the first command should create a reservation for the selected slot'
      );
      console.log(`TC60 passed: 100 commands; SAC failover ${failoverMs}ms`);
    }
  );
}
