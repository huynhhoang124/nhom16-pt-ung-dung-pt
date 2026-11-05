
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

const COMPOSE_ARGS = [
  '-f', 'docker-compose.yml',
  '-f', 'docker-compose.pd13.yml',
  '--profile', 'ha',
  '--profile', 'pd13',
];

const MANAGEMENT_URL = () =>
  (process.env.PD05_RABBITMQ_MANAGEMENT_URL ?? 'http://localhost:15672')
    .replace(/\/+$/, '');

const MANAGEMENT_USER = () =>
  process.env.PD05_RABBITMQ_USER ?? 'parking';

const MANAGEMENT_PASSWORD = () =>
  process.env.PD05_RABBITMQ_PASSWORD ?? 'parking';

const AMQP_URL = () =>
  process.env.PD02_AMQP_URL ?? 'amqp://parking:parking@localhost/%2F';

export function registerTc60Pd05Tests({
  ROOT,
  node,
  login,
  freeSlot,
  KEY,
}) {
  const docker = (...args) =>
    execFileSync('docker', args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  const compose = (...args) =>
    docker('compose', ...COMPOSE_ARGS, ...args);

  // Run SQL through docker exec with separate arguments.
  // Avoid passing SQL through the Windows shell.
  function querySql(db, query) {
    return compose(
      'exec',
      '-T',
      db,
      'psql',
      '-U',
      'postgres',
      '-d',
      'parking',
      '-tAc',
      query
    );
  }

  function inspectContainer(containerId) {
    return JSON.parse(docker('inspect', containerId))[0];
  }

  function serviceContainer(service) {
    const ids = compose('ps', '-q', service)
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean);

    assert.equal(
      ids.length,
      1,
      `Expected exactly one running container for ${service}; found ${ids.length}`
    );

    return {
      service,
      containerId: ids[0],
      info: inspectContainer(ids[0]),
    };
  }

  function defaultNetworkIp(container) {
    const networks = Object.entries(
      container.info.NetworkSettings.Networks ?? {}
    );

    const entry =
      networks.find(([name]) => name.endsWith('_default')) ??
      networks[0];

    assert.ok(entry, `${container.service} has no Docker network`);

    const ip = entry[1].IPAddress;
    assert.ok(ip, `${container.service} has no Docker IP`);

    return ip;
  }

  function containerEnv(container, name) {
    const entry = (container.info.Config.Env ?? [])
      .find(value => value.startsWith(`${name}=`));

    return entry?.slice(name.length + 1);
  }

  function databaseTarget(container) {
    const value = containerEnv(container, 'DATABASE_URL');

    assert.ok(
      value,
      `${container.service} is missing DATABASE_URL`
    );

    const parsed = new URL(value);

    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  }

  async function healthy(nodeInfo) {
    try {
      const response = await fetch(nodeInfo.healthUrl, {
        signal: AbortSignal.timeout(3000),
      });

      return response.status === 200;
    } catch {
      return false;
    }
  }

  async function waitFor(
    label,
    predicate,
    timeoutMs = 15000,
    intervalMs = 100
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
      try {
        const result = await predicate();
        if (result) return result;
      } catch (error) {
        lastError = error;
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `${label}: timeout after ${timeoutMs}ms` +
      (lastError ? `; last error: ${lastError.message}` : '')
    );
  }

  async function managementGet(path) {
    const credentials = Buffer
      .from(`${MANAGEMENT_USER()}:${MANAGEMENT_PASSWORD()}`)
      .toString('base64');

    const response = await fetch(`${MANAGEMENT_URL()}${path}`, {
      headers: {
        Authorization: `Basic ${credentials}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(
        `RabbitMQ Management API ${path}: HTTP ${response.status}`
      );
    }

    return response.json();
  }

  async function listAConsumers() {
    const consumers = await managementGet('/api/consumers/%2F');

    return consumers
      .filter(item => item.queue?.name === 'cmd.A')
      .map(item => ({
        consumerTag: item.consumer_tag,
        active: item.active === true,
        peerHost: item.channel_details?.peer_host,
      }));
  }

  async function queueInfo() {
    return managementGet('/api/queues/%2F/cmd.A');
  }

  function inboxCount(messagePrefix) {
    return Number(
      querySql(
        'db-a',
        `SELECT count(*) FROM inbox_messages WHERE message_id LIKE '${messagePrefix}%'`
      )
    );
  }

  test(
    'TC60 PD-05 SAC: 100 numbered commands preserve FIFO after real PD-13 node failure',
    { timeout: 240000 },
    async t => {
      const runId = randomUUID().replaceAll('-', '').slice(0, 12);

      let connection;
      let channel;
      let commands;

      let activeNode;
      let publishAttemptedCount = 0;

      let messagePrefix;
      let firstMessageId;
      let actor;

      // Register cleanup before setup so failed preconditions do not skip cleanup.
      t.after(async () => {
        // Restore the node that was active when the test started.
        if (activeNode) {
          try {
            const state = inspectContainer(activeNode.containerId).State;

            if (state.Paused) {
              docker('unpause', activeNode.containerId);
            }

            if (!state.Running) {
              docker('start', activeNode.containerId);
            }

            await waitFor(
              `${activeNode.service} restored`,
              () => healthy(activeNode),
              45000
            );
          } catch (error) {
            console.error(
              `TC60 cleanup: ${activeNode.service} restore failed:`,
              error.message
            );
          }
        }

        // Only remove test records after every attempted publish is processed.
        // If a publisher confirm fails ambiguously, preserve the records safely.
        let drained = publishAttemptedCount === 0;

        if (publishAttemptedCount > 0 && messagePrefix) {
          try {
            await waitFor(
              `TC60 cleanup: all ${publishAttemptedCount} attempted messages processed`,
              () => inboxCount(messagePrefix) === publishAttemptedCount,
              45000
            );

            drained = true;
          } catch (error) {
            console.error(
              'TC60 cleanup: messages were not fully drained:',
              error.message
            );
          }
        }

        if (drained && messagePrefix) {
          try {
            const stored = querySql(
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
            console.error(
              'TC60 cleanup: reservation restore:',
              error.message
            );
          }

          try {
            querySql(
              'db-a',
              `DELETE FROM command_reply_outbox WHERE command_id LIKE '${messagePrefix}%'`
            );

            querySql(
              'db-a',
              `DELETE FROM inbox_messages WHERE message_id LIKE '${messagePrefix}%'`
            );
          } catch (error) {
            console.error(
              'TC60 cleanup: test records:',
              error.message
            );
          }
        }

        await commands?.close().catch(() => {});
        await channel?.close().catch(() => {});
        await connection?.close().catch(() => {});
      });

      // ---------------------------------------------------------------
      // 1. Preconditions: three-node RabbitMQ HA cluster.
      // ---------------------------------------------------------------

      for (const service of ['rabbitmq', 'rabbitmq-2', 'rabbitmq-3']) {
        const broker = serviceContainer(service);

        assert.equal(
          broker.info.State.Health?.Status,
          'healthy',
          `${service} must be healthy`
        );
      }

      const clusterStatus = compose(
        'exec', '-T', 'rabbitmq',
        'rabbitmqctl', 'cluster_status'
      );

      for (const member of [
        'rabbit@rabbitmq',
        'rabbit@rabbitmq-2',
        'rabbit@rabbitmq-3',
      ]) {
        assert.ok(
          clusterStatus.includes(member),
          `RabbitMQ cluster is missing ${member}`
        );
      }

      // ---------------------------------------------------------------
      // 2. Discover the two real PD-13 Parking A containers.
      // ---------------------------------------------------------------
      // TC60 cần hai Parking A nodes thật.
      // Chỉ khởi động replica khi TC60 bắt đầu để không ảnh hưởng TC53 (PD-02).
      compose('up', '-d', '--wait', 'parking-a-2');
      const parkingNodes = [
        {
          service: 'parking-a',
          healthUrl: 'http://localhost:8001/health',
        },
        {
          service: 'parking-a-2',
          healthUrl: 'http://localhost:8101/health',
        },
      ].map(item => {
        const container = serviceContainer(item.service);

        return {
          ...container,
          healthUrl: item.healthUrl,
          ip: defaultNetworkIp(container),
        };
      });

      for (const parking of parkingNodes) {
        assert.equal(
          parking.info.State.Running,
          true,
          `${parking.service} must be running`
        );

        assert.equal(
          containerEnv(parking, 'PARKING_ID'),
          'A',
          `${parking.service} must use PARKING_ID=A`
        );

        assert.equal(
          await healthy(parking),
          true,
          `${parking.service} must respond HTTP 200`
        );
      }

      assert.notEqual(
        parkingNodes[0].ip,
        parkingNodes[1].ip,
        'The two Parking A nodes must have different Docker IPs'
      );

      assert.equal(
        databaseTarget(parkingNodes[0]),
        databaseTarget(parkingNodes[1]),
        'Both Parking A nodes must use the same database'
      );

      // ---------------------------------------------------------------
      // 3. Verify cmd.A is empty and both real nodes registered.
      // ---------------------------------------------------------------

      const initialQueue = await queueInfo();

      assert.equal(initialQueue.type, 'quorum', 'cmd.A must be a quorum queue');

      assert.equal(
        initialQueue.arguments?.['x-single-active-consumer'],
        true,
        'cmd.A must have x-single-active-consumer enabled'
      );

      assert.equal(initialQueue.messages, 0, 'cmd.A must be empty');
      assert.equal(initialQueue.messages_ready, 0);
      assert.equal(initialQueue.messages_unacknowledged, 0);

      const consumers = await waitFor(
        'both PD-13 nodes registered as cmd.A consumers',
        async () => {
          const current = await listAConsumers();
          return current.length === 2 ? current : false;
        },
        20000,
        100
      );

      assert.equal(
        consumers.filter(item => item.active).length,
        1,
        'cmd.A must have exactly one active consumer'
      );

      assert.equal(
        consumers.filter(item => !item.active).length,
        1,
        'cmd.A must have exactly one standby consumer'
      );

      const expectedIps = parkingNodes.map(item => item.ip).sort();
      const actualIps = consumers.map(item => item.peerHost).sort();

      assert.deepEqual(
        actualIps,
        expectedIps,
        'cmd.A consumers must belong to the two real PD-13 containers'
      );

      const activeConsumer = consumers.find(item => item.active);

      activeNode = parkingNodes.find(
        item => item.ip === activeConsumer.peerHost
      );

      const standbyNode = parkingNodes.find(
        item => item.ip !== activeConsumer.peerHost
      );

      assert.ok(activeNode, 'Cannot map active consumer to a Parking node');
      assert.ok(standbyNode, 'Cannot identify the standby Parking node');

      console.log(
        `[TC60] Active: ${activeNode.service} (${activeNode.ip})`
      );

      console.log(
        `[TC60] Standby: ${standbyNode.service} (${standbyNode.ip})`
      );

      // ---------------------------------------------------------------
      // 4. Prepare the real command publisher and reply queue.
      // ---------------------------------------------------------------

      const token = await login('user1');

      const jwtPayload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
      );

      actor = {
        userId: jwtPayload.sub,
        role: 'USER',
      };

      messagePrefix = `${actor.userId}:pd05-${runId}-`;
      firstMessageId = `${messagePrefix}001`;

      const slotCode = await freeSlot('A');

      connection = await amqp.connect(AMQP_URL());
      channel = await connection.createChannel();

      await channel.assertExchange('parking.replies', 'direct', {
        durable: true,
      });

      const { queue: replyQueue } = await channel.assertQueue('', {
        exclusive: true,
        autoDelete: true,
      });

      const replyTo = `test.${randomUUID()}`;

      await channel.bindQueue(
        replyQueue,
        'parking.replies',
        replyTo
      );

      await channel.consume(replyQueue, message => {
        if (message) channel.ack(message);
      });

      commands = makeCommands(AMQP_URL(), {
        signingKey: KEY,
      });

      const messages = Array.from({ length: 100 }, (_, index) => {
        const sequence = index + 1;

        const plateNumber = 600 + Math.floor(index / 99);
        const plateSuffix = (index % 99) + 1;

        return {
          messageId:
            `${messagePrefix}${String(sequence).padStart(3, '0')}`,
          payload: {
            slotCode,
            licensePlate:
              `30A-${String(plateNumber).padStart(3, '0')}.` +
              String(plateSuffix).padStart(2, '0'),
          },
        };
      });

      const redeliverBefore = Number(
        initialQueue.message_stats?.redeliver ?? 0
      );

      // ---------------------------------------------------------------
      // 5. Create a deterministic backlog on the real active node.
      // ---------------------------------------------------------------

      // Pause only the active Parking process. Its RabbitMQ connection stays
      // registered, so RabbitMQ can deliver up to the consumer prefetch limit.
      docker('pause', activeNode.containerId);

      // Await each publisher confirm before sending the next command.
      // This preserves the intended publication sequence for FIFO verification.
      for (const { messageId, payload } of messages) {
        // Count the attempt before awaiting the confirm.
        // A failed confirm may leave the broker's publish outcome uncertain.
        publishAttemptedCount++;

        await commands.send('A', 'reserve', payload, {
          messageId,
          replyTo,
          actor,
          expiration: 300000,
        });
      }

      await waitFor(
        'active consumer has unacknowledged messages and a ready backlog',
        async () => {
          const current = await queueInfo();

          return current.messages_unacknowledged > 0 &&
            current.messages_ready > 0
            ? current
            : false;
        },
        15000,
        50
      );

      // Let the active node process some messages before failing it.
      docker('unpause', activeNode.containerId);

      const progress = await waitFor(
        'active consumer commits part of the numbered command batch',
        async () => {
          const processed = inboxCount(messagePrefix);
          const current = await queueInfo();

          return processed > 0 &&
            processed < 100 &&
            current.messages_unacknowledged > 0
            ? { processed, queue: current }
            : false;
        },
        20000,
        25
      );

      assert.ok(
        progress.processed > 0 && progress.processed < 100,
        'Failure must happen after partial processing but before all 100 commands finish'
      );

      assert.ok(
        progress.queue.messages_unacknowledged > 0,
        'There must be unacknowledged commands at failure time'
      );

      console.log(
        `[TC60] Before failure: ${progress.processed}/100 processed; ` +
        `${progress.queue.messages_unacknowledged} unacknowledged`
      );

      // ---------------------------------------------------------------
      // 6. Kill the active real node and verify SAC failover.
      // ---------------------------------------------------------------

      const failoverStarted = Date.now();

      docker('kill', activeNode.containerId);

      const newActiveConsumer = await waitFor(
        'standby node takes over cmd.A within five seconds',
        async () => {
          const current = await listAConsumers();

          return current.length === 1 &&
            current[0].active &&
            current[0].peerHost === standbyNode.ip
            ? current[0]
            : false;
        },
        5000,
        50
      );

      const failoverMs = Date.now() - failoverStarted;

      assert.ok(
        newActiveConsumer.active,
        'The standby node must become active'
      );

      assert.ok(
        failoverMs <= 5000,
        `SAC failover took ${failoverMs}ms; expected at most 5000ms`
      );

      console.log(
        `[TC60] Failover PASS: ${standbyNode.service} active in ${failoverMs}ms`
      );

      // RabbitMQ must record at least one redelivery after the active
      // consumer connection is lost with unacknowledged messages.
      const redeliverAfter = await waitFor(
        'RabbitMQ records message redelivery',
        async () => {
          const current = await queueInfo();
          const count = Number(current.message_stats?.redeliver ?? 0);

          return count > redeliverBefore ? count : false;
        },
        15000,
        50
      );

      assert.ok(
        redeliverAfter > redeliverBefore,
        'At least one unacknowledged message must be redelivered'
      );

      // ---------------------------------------------------------------
      // 7. Verify all 100 commands, FIFO ordering and no duplicate effects.
      // ---------------------------------------------------------------

      await waitFor(
        'all 100 commands processed after failover',
        () => inboxCount(messagePrefix) === 100,
        45000,
        100
      );

      const processedCount = querySql(
        'db-a',
        `SELECT count(*) FROM inbox_messages
         WHERE message_id LIKE '${messagePrefix}%'
           AND processed_at IS NOT NULL`
      );

      assert.equal(
        processedCount,
        '100',
        'All 100 inbox entries must be processed'
      );

      const orderViolationQuery = `
        SELECT COALESCE(
          string_agg(
            previous_message_id || ' [' || previous_processed_at::text ||
            '] -> ' || message_id || ' [' || processed_at::text || ']',
            '; '
          ),
          ''
        )
        FROM (
          SELECT
            message_id,
            processed_at,
            lag(message_id) OVER (ORDER BY message_id) AS previous_message_id,
            lag(processed_at) OVER (ORDER BY message_id) AS previous_processed_at
          FROM inbox_messages
          WHERE message_id LIKE '${messagePrefix}%'
        ) AS ordered
        WHERE previous_processed_at > processed_at
      `.replace(/\s+/g, ' ').trim();

      const orderViolations = querySql('db-a', orderViolationQuery);

      assert.equal(
        orderViolations,
        '',
        `processed_at violated FIFO: ${orderViolations}`
      );

      const reservationsCreated = querySql(
        'db-a',
        `SELECT count(*)
         FROM reservations
         WHERE request_id LIKE '${messagePrefix}%'`
      );

      assert.equal(
        reservationsCreated,
        '1',
        'Only the first command should create a reservation for the selected slot'
      );

      const duplicateReplies = querySql(
        'db-a',
        `SELECT count(*)
         FROM (
           SELECT command_id
           FROM command_reply_outbox
           WHERE command_id LIKE '${messagePrefix}%'
           GROUP BY command_id
           HAVING count(*) > 1
         ) AS duplicates`
      );

      assert.equal(
        duplicateReplies,
        '0',
        'A command must not create duplicate reply outbox records'
      );

      console.log(
        `TC60 passed: 100 commands; ` +
        `${progress.processed} processed before failure; ` +
        `SAC failover ${failoverMs}ms; ` +
        `${redeliverAfter - redeliverBefore} redeliveries`
      );
    }
  );
}
