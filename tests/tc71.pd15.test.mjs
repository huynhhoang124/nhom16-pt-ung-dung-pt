import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // Dùng biến môi trường nếu chưa có .env.
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGG = process.env.AGGREGATOR_URL ?? 'http://localhost:8000';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? '123456';

function docker(...args) {
  return execFileSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function compose(...args) {
  return docker('compose', '--profile', 'ha', ...args);
}

function psql(service, query) {
  return compose(
    'exec', '-T', service,
    'psql',
    '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres',
    '-d', 'parking',
    '-A', '-t', '-F', '|',
    '-c', query,
  ).trim();
}

function replicaDelay() {
  const output = psql(
    'db-a-replica',
    `SELECT setting, COALESCE(source, ''), context
     FROM pg_settings
     WHERE name = 'recovery_min_apply_delay'`,
  );

  const [setting, source, context] = output.split('|');

  return { setting, source, context };
}

const REPLICA_AUTO_CONF =
  '/var/lib/postgresql/data/postgresql.auto.conf';

const REPLICA_BACKUP =
  '/tmp/tc71-postgresql.auto.conf.pd15.bak';

function replicaShell(script) {
  return compose(
    'exec',
    '-T',
    '-u', 'postgres',
    'db-a-replica',
    'sh',
    '-c',
    script,
  );
}

function backupReplicaConfig() {
  return replicaShell([
    'set -eu',
    `test -f '${REPLICA_AUTO_CONF}'`,
    `test -w '${REPLICA_AUTO_CONF}'`,
    `test ! -e '${REPLICA_BACKUP}'`,
    `! grep -Fq 'recovery_min_apply_delay' '${REPLICA_AUTO_CONF}'`,
    `cp -p '${REPLICA_AUTO_CONF}' '${REPLICA_BACKUP}'`,
  ].join(' && '));
}

function applyReplicaDelay() {
  return replicaShell(
    `printf '%s\\n' '' '# Temporary TC71 setting' "recovery_min_apply_delay = '2s'" >> '${REPLICA_AUTO_CONF}'`,
  );
}

function restoreReplicaConfig() {
  return replicaShell([
    'set -eu',
    `test -f '${REPLICA_BACKUP}'`,
    `cp -p '${REPLICA_BACKUP}' '${REPLICA_AUTO_CONF}'`,
  ].join(' && '));
}

function removeReplicaBackup() {
  return replicaShell(`rm -f '${REPLICA_BACKUP}'`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(description, callback, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(
    `TC71 timeout: ${description}` +
    (lastError ? `; lỗi cuối: ${lastError.message}` : ''),
  );
}

async function request(path, {
  method = 'GET',
  token,
  body,
  headers = {},
} = {}) {
  const response = await fetch(`${AGG}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const result = await response.json().catch(() => null);

  return {
    status: response.status,
    body: result,
    headers: response.headers,
  };
}

async function loginUser() {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: {
      username: 'user1',
      password: DEMO_PASSWORD,
    },
  });

  assert.equal(
    result.status,
    200,
    `Đăng nhập USER thất bại: ${JSON.stringify(result.body)}`,
  );

  assert.ok(result.body?.token, 'USER phải có JWT');
  assert.ok(result.body?.user?.id, 'USER phải có ID');

  return result.body;
}

function availableSlot() {
  return psql(
    'db-a',
    `SELECT slot_code
     FROM parking_slots
     WHERE status = 'AVAILABLE'
     ORDER BY slot_code
     LIMIT 1`,
  );
}

function replicaIsBehind(lsn) {
  const result = psql(
    'db-a-replica',
    `SELECT CASE
       WHEN pg_last_wal_replay_lsn() < '${lsn}'::pg_lsn THEN 'yes'
       ELSE 'no'
     END`,
  );

  return result === 'yes';
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function licensePlate() {
  const digits = String(Date.now()).slice(-5).padStart(5, '0');
  return `30A-${digits.slice(0, 3)}.${digits.slice(3)}`;
}

test('TC71 - Read-your-writes khi replica trễ 2 giây', {
  timeout: 120_000,
}, async () => {
  let user;
  let reservationId;
  let requestId;
  let baseline;
  let delayConfigured = false;
  let testFailed = false;

  try {
    // Chỉ chạy khi replica đang ở cấu hình mặc định đã xác nhận.
    baseline = replicaDelay();

    assert.equal(
      baseline.setting,
      '0',
      'Replica phải bắt đầu với recovery_min_apply_delay = 0',
    );
    assert.equal(
      baseline.source,
      'default',
      'Replica phải bắt đầu với source = default để có thể khôi phục an toàn',
    );
    assert.equal(baseline.context, 'sighup');

    // Remote apply sẽ làm COMMIT chờ replica replay, không phù hợp TC71.
    const syncSettings = psql(
      'db-a',
      `SELECT current_setting('synchronous_commit'),
              current_setting('synchronous_standby_names')`,
    );

    const [syncCommit, syncStandbyNames] = syncSettings.split('|');

    assert.notEqual(
      syncCommit,
      'remote_apply',
      `Không chạy TC71 khi synchronous_commit=remote_apply; synchronous_standby_names=${syncStandbyNames}`,
    );

    user = await loginUser();

    const slotCode = availableSlot();

    assert.ok(slotCode, 'Parking A phải có ít nhất một slot AVAILABLE');

    const idempotencyKey =
      `tc71-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    requestId = `${user.user.id}:${idempotencyKey}`;

    // Thiết lập delay 2 giây trên replica và reload cấu hình.
    backupReplicaConfig();
    delayConfigured = true;

    applyReplicaDelay();

    assert.equal(
      psql('db-a-replica', 'SELECT pg_reload_conf()'),
      't',
      'Replica phải reload được cấu hình',
    );

    await until(
      'recovery_min_apply_delay chuyển thành 2000 ms',
      () => replicaDelay().setting === '2000',
    );

    // Ghi reservation qua Aggregator vào Primary A.
    const created = await request('/api/parkings/A/reservations', {
      method: 'POST',
      token: user.token,
      headers: {
        'idempotency-key': idempotencyKey,
      },
      body: {
        slotCode,
        licensePlate: licensePlate(),
        durationMinutes: 120,
      },
    });

    reservationId = created.body?.id;

    // Nếu response thiếu ID nhưng transaction đã commit,
    // tìm lại bằng requestId để vẫn có thể dọn dữ liệu.
    if (!reservationId) {
      reservationId = psql(
        'db-a',
        `SELECT id
         FROM reservations
         WHERE request_id = ${sqlLiteral(requestId)}
         LIMIT 1`,
      ) || null;
    }

    assert.equal(
      created.status,
      201,
      `Tạo reservation thất bại: ${JSON.stringify(created.body)}`,
    );

    assert.ok(
      reservationId,
      `Reservation phải có ID: ${JSON.stringify(created.body)}`,
    );

    // Xác nhận Aggregator đã chuyển X-LSN từ Parking Node về client.
    const lsn = created.headers.get('x-lsn');

    assert.ok(lsn, 'Response tạo reservation phải có header X-LSN');

    assert.match(
      lsn,
      /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/,
      `X-LSN không hợp lệ: ${lsn}`,
    );

    // Chứng minh replica chưa replay đến LSN vừa ghi.
    assert.equal(
      replicaIsBehind(lsn),
      true,
      `Replica đã theo kịp ${lsn}; không còn điều kiện để kiểm tra TC71`,
    );

    // Đọc ngay lịch sử đặt chỗ, gửi LSN riêng cho Parking A.
    const read = await request('/api/me/reservations', {
      token: user.token,
      headers: {
        'x-min-lsn': JSON.stringify({ A: lsn }),
      },
    });

    assert.equal(
      read.status,
      200,
      `Đọc lịch sử reservation thất bại: ${JSON.stringify(read.body)}`,
    );

    assert.ok(
      Array.isArray(read.body?.reservations),
      'Response phải chứa mảng reservations',
    );

    const found = read.body.reservations.find(
      (item) => item.id === reservationId && item.parkingId === 'A',
    );

    assert.ok(
      found,
      `Read-your-writes thất bại: không tìm thấy reservation ${reservationId}; response=${JSON.stringify(read.body)}`,
    );

    assert.equal(
      found.status,
      'ACTIVE',
      'Reservation vừa tạo phải có trạng thái ACTIVE',
    );

    console.log(
      `[TC71] PASS: reservation=${reservationId}, X-LSN=${lsn}, replica chưa replay nhưng GET đã thấy dữ liệu`,
    );
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    const cleanupErrors = [];

    // Khôi phục cấu hình replica trước khi dọn reservation.
    if (delayConfigured && baseline) {
    try {
        restoreReplicaConfig();

        assert.equal(
        psql('db-a-replica', 'SELECT pg_reload_conf()'),
        't',
        'Không reload được cấu hình sau khi khôi phục',
        );

        await until(
        'khôi phục recovery_min_apply_delay về baseline',
        () => {
            const current = replicaDelay();

            return current.setting === baseline.setting &&
            current.source === baseline.source;
        },
        15_000,
        );

        removeReplicaBackup();

        console.log('[TC71] Replica delay đã được khôi phục.');
    } catch (error) {
        cleanupErrors.push(`Khôi phục replica: ${error.message}`);
    }
    }

    // Dọn reservation qua API nghiệp vụ, không xóa cứng bằng SQL.
    if (user && requestId && !reservationId) {
      try {
        reservationId = psql(
          'db-a',
          `SELECT id
           FROM reservations
           WHERE request_id = ${sqlLiteral(requestId)}
           LIMIT 1`,
        ) || null;
      } catch (error) {
        cleanupErrors.push(`Tìm reservation để dọn: ${error.message}`);
      }
    }

    if (user && reservationId) {
      try {
        const removed = await request(
          `/api/parkings/A/reservations/${encodeURIComponent(reservationId)}`,
          {
            method: 'DELETE',
            token: user.token,
          },
        );

        assert.equal(
          removed.status,
          200,
          `Không hủy được reservation test: ${JSON.stringify(removed.body)}`,
        );

        console.log(`[TC71] Đã dọn reservation ${reservationId}.`);
      } catch (error) {
        cleanupErrors.push(`Dọn reservation: ${error.message}`);
      }
    }

    if (cleanupErrors.length) {
      const message = cleanupErrors.join('\n');

      if (testFailed) {
        console.error(`[TC71] CẢNH BÁO CLEANUP:\n${message}`);
      } else {
        throw new Error(`[TC71] Cleanup thất bại:\n${message}`);
      }
    }
  }
});