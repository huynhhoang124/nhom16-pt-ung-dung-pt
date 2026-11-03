
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // Dùng biến môi trường nếu chưa có .env.
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const requireFrontend = createRequire(
  new URL('../frontend/package.json', import.meta.url)
);
const { io } = requireFrontend('socket.io-client');

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

// D nằm trong profile extra; các service còn lại là service mặc định.
function compose(...args) {
  return docker('compose', '--profile', 'extra', ...args);
}

function sql(database, query) {
  return compose(
    'exec', '-T', database,
    'psql', '-U', 'postgres', '-d', 'parking', '-tAc', query
  ).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(description, fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }

    await sleep(300);
  }

  throw new Error(
    `Hết thời gian chờ: ${description}` +
    (lastError ? `; lỗi cuối: ${lastError.message}` : '')
  );
}

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${AGG}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const result = await response.json().catch(() => null);

  return {
    status: response.status,
    body: result,
  };
}

async function loginAdmin() {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: {
      username: 'admin',
      password: DEMO_PASSWORD,
    },
  });

  assert.equal(
    result.status,
    200,
    `Đăng nhập admin thất bại: ${JSON.stringify(result.body)}`
  );
  assert.ok(result.body?.token, 'Admin phải có JWT');

  return result.body.token;
}

async function adminNodes(token) {
  const result = await request('/api/admin/nodes', { token });

  assert.equal(
    result.status,
    200,
    `Không lấy được danh sách node: ${JSON.stringify(result.body)}`
  );

  return result.body;
}

async function ensureDRegistered(token) {
  // Xác nhận Parking Node D thật sự đã chạy.
  await until(
    'Parking Node D /health',
    async () => {
      const response = await fetch('http://localhost:8004/health');
      return response.ok;
    },
    60_000
  );

  let nodes = await adminNodes(token);
  let d = nodes.find((node) => node.parkingId === 'D');

  // Nếu D chưa đăng ký, thêm D vào Aggregator.
  if (!d) {
    const added = await request('/api/admin/nodes', {
      method: 'POST',
      token,
      body: {
        parkingId: 'D',
        name: 'Bãi D',
        apiUrl: 'http://parking-d:8004',
      },
    });

    assert.ok(
      [201, 409].includes(added.status),
      `Đăng ký bãi D thất bại: ${JSON.stringify(added.body)}`
    );

    nodes = await adminNodes(token);
    d = nodes.find((node) => node.parkingId === 'D');
  }

  assert.ok(d, 'Bãi D phải có trong Aggregator');

  assert.equal(
    d.url?.replace(/\/$/, ''),
    'http://parking-d:8004',
    `API URL của D phải là http://parking-d:8004, thực tế: ${d.url}`
  );

  // Aggregator phải xác nhận cả A và D ONLINE.
  await until(
    'Aggregator nhận diện A và D ONLINE',
    async () => {
      const current = await adminNodes(token);
      const a = current.find((node) => node.parkingId === 'A');
      const dNode = current.find((node) => node.parkingId === 'D');

      return a?.status === 'ONLINE' && dNode?.status === 'ONLINE';
    },
    60_000
  );
}

function barrier(parkingId, slot, action, extra) {
  const args = [
    'scripts/barrier.mjs',
    parkingId,
    slot,
    action,
  ];

  if (extra !== undefined) args.push(extra);

  return execFileSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function freeSlot(database) {
  return sql(
    database,
    `SELECT slot_code
     FROM parking_slots
     WHERE status = 'AVAILABLE'
     ORDER BY slot_code
     LIMIT 1`
  );
}

function readHlc(database, beforeId, eventType, slot) {
  return sql(
    database,
    `SELECT hlc::text
     FROM parking_events
     WHERE id > ${beforeId}
       AND event_type = '${eventType}'
       AND slot_code = '${slot}'
     ORDER BY id DESC
     LIMIT 1`
  );
}

const plate = () =>
  `30A-${String(Math.random()).slice(2, 5)}.${String(Math.random()).slice(2, 4)}`;

async function runTc74({ expectedSkew, enterDThroughAggregator }) {
  // Kiểm tra clock skew thật bên trong container D.
  const actualSkew = compose(
    'exec', '-T', 'parking-d', 'printenv', 'CLOCK_SKEW_MS'
  );

  assert.equal(
    actualSkew,
    String(expectedSkew),
    `Bãi D phải chạy với CLOCK_SKEW_MS=${expectedSkew}`
  );

  // Kiểm tra và đăng ký D nếu chưa có.
  const adminToken = await loginAdmin();
  await ensureDRegistered(adminToken);

  const slotA = await until(
    'Có slot AVAILABLE ở A',
    () => freeSlot('db-a') || null
  );

  const slotD = await until(
    'Có slot AVAILABLE ở D',
    () => freeSlot('db-d') || null
  );

  const licensePlate = plate();

  // Lấy ID cuối trước khi thao tác để không đọc nhầm event cũ.
  const beforeA = Number(
    sql('db-a', 'SELECT COALESCE(MAX(id), 0) FROM parking_events')
  );

  const beforeD = Number(
    sql('db-d', 'SELECT COALESCE(MAX(id), 0) FROM parking_events')
  );

  let aInside = false;
  let dInside = false;
  const events = [];

  // Socket nhận SLOT_UPDATED sau khi Aggregator đã applyEvent/hlc.update.
  const socket = io(AGG, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 10_000,
  });

  socket.on('SLOT_UPDATED', (event) => events.push(event));

  try {
    await until(
      'Socket.IO kết nối Aggregator',
      () => socket.connected,
      15_000
    );

    // Chuỗi nghiệp vụ: xe vào A -> xe ra A.
    barrier('A', slotA, 'enter', licensePlate);
    aInside = true;

    barrier('A', slotA, 'exit', 'cash');
    aInside = false;

    // Chờ Aggregator nhận đúng CAR_EXIT của A.
    // Trong index.js: applyEvent() chạy trước push(e).
    await until(
      'Aggregator đã nhận CAR_EXIT của A',
      () => events.some(
        (event) =>
          event.parkingId === 'A' &&
          event.slot === slotA &&
          event.type === 'CAR_EXIT' &&
          event.status === 'AVAILABLE'
      ),
      30_000
    );

    // Dương: giữ luồng trực tiếp cũ.
    // Âm: xe vào D qua Aggregator để kiểm tra x-hlc qua HTTP.
    if (enterDThroughAggregator) {
      const result = await request(
        `/api/parkings/D/slots/${encodeURIComponent(slotD)}/enter`,
        {
          method: 'POST',
          token: adminToken,
          body: { licensePlate },
        }
      );

      assert.equal(
        result.status,
        200,
        `Aggregator đưa xe vào D thất bại: ${JSON.stringify(result.body)}`
      );
    } else {
      barrier('D', slotD, 'enter', licensePlate);
    }

    dInside = true;

    // Đọc HLC của hai event mới.
    const exitHlc = await until(
      'Có HLC CAR_EXIT mới ở A',
      () => readHlc('db-a', beforeA, 'CAR_EXIT', slotA) || null,
      30_000
    );

    const enterHlc = await until(
      'Có HLC CAR_ENTER mới ở D',
      () => readHlc('db-d', beforeD, 'CAR_ENTER', slotD) || null,
      30_000
    );

    // HLC của CAR_ENTER phải được lưu trong parking_sessions.
    const sessionHlc = sql(
      'db-d',
      `SELECT ps.hlc
       FROM parking_sessions ps
       JOIN parking_events pe
         ON pe.payload->>'sessionId' = ps.id::text
       WHERE pe.id > ${beforeD}
         AND pe.event_type = 'CAR_ENTER'
         AND pe.slot_code = '${slotD}'
       ORDER BY pe.id DESC
       LIMIT 1`
    );

    assert.equal(
      sessionHlc,
      enterHlc,
      'HLC CAR_ENTER phải trùng với HLC lưu trong parking_sessions'
    );

    assert.match(exitHlc, /^\d{13}-\d{4}$/, 'HLC CAR_EXIT không hợp lệ');
    assert.match(enterHlc, /^\d{13}-\d{4}$/, 'HLC CAR_ENTER không hợp lệ');

    // HLC cố định 13 chữ số-4 chữ số nên so sánh chuỗi được.
    assert.ok(
      exitHlc < enterHlc,
      `Thứ tự nhân quả sai: CAR_EXIT A=${exitHlc}, CAR_ENTER D=${enterHlc}`
    );

    console.log(`TC74 CLOCK_SKEW_MS=${expectedSkew}`);
    console.log('CAR_EXIT A :', exitHlc);
    console.log('CAR_ENTER D:', enterHlc);
    console.log('Session HLC:', sessionHlc);
  } finally {
    socket.close();

    // Dọn xe thử nghiệm để không để slot bị OCCUPIED.
    if (dInside) {
      try {
        barrier('D', slotD, 'exit', 'cash');
      } catch (error) {
        console.error('Không dọn được xe thử nghiệm ở D:', error.message);
      }
    }

    if (aInside) {
      try {
        barrier('A', slotA, 'exit', 'cash');
      } catch (error) {
        console.error('Không dọn được xe thử nghiệm ở A:', error.message);
      }
    }
  }
}

const enabled = process.env.HLC_TEST === '1';
const selectedSkew = Number(process.env.HLC_EXPECTED_SKEW);

test(
  'TC74 - Bãi D lệch +30 giây, thứ tự CAR_EXIT A trước CAR_ENTER D',
  {
    timeout: 180_000,
    skip: !enabled || selectedSkew !== 30000,
  },
  async () => runTc74({
    expectedSkew: 30000,
    enterDThroughAggregator: false,
  })
);

test(
  'TC74 - Bãi D lệch -30 giây, xe vào D qua Aggregator vẫn đúng HLC',
  {
    timeout: 180_000,
    skip: !enabled || selectedSkew !== -30000,
  },
  async () => runTc74({
    expectedSkew: -30000,
    enterDThroughAggregator: true,
  })
);
