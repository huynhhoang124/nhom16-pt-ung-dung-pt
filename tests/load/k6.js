// PD-27: 300 VU (240 đọc + 60 đặt), chạy bằng grafana/k6, không cần cài k6.
// BASE=http://frontend bash scripts/do-so-sanh.sh http-3-bai
// Chỉ chạy trên stack thử; đặt thành công thì huỷ để quay vòng slot.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE || 'http://frontend').replace(/\/$/, '');
const PARKINGS = (__ENV.PARKING_IDS || 'A,B,C').split(',').map((id) => id.trim()).filter(Boolean);
const LOOKUP_VUS = Number(__ENV.LOOKUP_VUS || 240);
const RESERVE_VUS = Number(__ENV.RESERVE_VUS || 60);
const POLL_TIMEOUT_MS = Number(__ENV.POLL_TIMEOUT_MS || 30000);
const POLL_INTERVAL_MS = Number(__ENV.POLL_INTERVAL_MS || 500);
const DEBUG_SLOW_MS = Number(__ENV.DEBUG_SLOW_MS || 0);
const json = { headers: { 'Content-Type': 'application/json' } };
const status503 = new Rate('response_503');
const status504 = new Rate('response_504');
const lookupDuration = new Trend('lookup_duration_ms', true);
const reserveDuration = new Trend('reserve_duration_ms', true);
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 409));

export const options = {
  scenarios: {
    lookup: { executor: 'constant-vus', vus: LOOKUP_VUS, duration: __ENV.DURATION || '2m', exec: 'lookup' },
    reserve: { executor: 'constant-vus', vus: RESERVE_VUS, duration: __ENV.DURATION || '2m', exec: 'reserve' },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
  thresholds: {
    lookup_duration_ms: [`p(95)<${__ENV.LOOKUP_P95_MS || 500}`],
    reserve_duration_ms: [`p(95)<${__ENV.RESERVE_P95_MS || 3000}`],
    http_req_failed: [`rate<${__ENV.MAX_ERROR_RATE || 0.01}`],
    checks: [`rate>${__ENV.MIN_CHECK_RATE || 0.99}`],
    response_503: [`rate<=${__ENV.MAX_503_RATE || 0}`],
    response_504: [`rate<=${__ENV.MAX_504_RATE || 0}`],
  },
};

function body(response) {
  try { return response.json(); } catch { return null; }
}

// Mọi HTTP của workload (kể cả poll/huỷ) cùng mẫu số; setup không tính vào hai tỉ lệ này.
function record(response, operation) {
  status503.add(response.status === 503);
  status504.add(response.status === 504);
  if (DEBUG_SLOW_MS && (response.timings.duration >= DEBUG_SLOW_MS || response.status >= 500)) {
    console.log(`${operation} ${response.timings.duration.toFixed(0)}ms status=${response.status} requestId=${response.headers['X-Request-Id'] || '-'} instance=${response.headers['X-Instance'] || '-'}`);
  }
  return response;
}

// 202 chỉ là đã nhận lệnh, phải hỏi tới kết quả cuối; không coi 200 của endpoint poll là đặt thành công.
function resolve(response, auth) {
  if (response.status !== 202) return { code: response.status, result: body(response) };
  const id = body(response)?.commandId;
  if (!id) return { code: 0 };
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    sleep(POLL_INTERVAL_MS / 1000);
    const poll = record(http.get(`${BASE}/api/commands/${encodeURIComponent(id)}`, auth), 'poll');
    const command = body(poll);
    if (poll.status === 200 && command?.status !== 'PENDING' && command?.statusCode != null) {
      return { code: command.statusCode, result: command.result };
    }
    if (poll.status !== 200) return { code: poll.status };
  }
  return { code: 0 }; // hết thời gian chờ: check thất bại, không phát lại lệnh bằng key khác
}

export function setup() {
  // Cùng tài khoản/mật khẩu demo với tests/e2e.test.mjs.
  const login = http.post(`${BASE}/api/auth/login`, JSON.stringify({
    username: __ENV.DEMO_USERNAME || 'user1', password: __ENV.DEMO_PASSWORD || '123456',
  }), json);
  const token = body(login)?.token;
  if (login.status !== 200 || !token) fail(`Đăng nhập demo thất bại: ${login.status}`);
  const slots = [];
  for (const id of PARKINGS) {
    const response = http.get(`${BASE}/api/parkings/${encodeURIComponent(id)}`);
    const parking = body(response);
    if (response.status !== 200 || parking?.stale || !parking?.slots?.length) fail(`Không lấy được slot bãi ${id}`);
    for (const slot of parking.slots) {
      if (slot.status === 'AVAILABLE') slots.push({ parkingId: id, slotCode: slot.slotCode });
    }
    if (!slots.some((slot) => slot.parkingId === id)) fail(`Bãi ${id} không có slot trống`);
  }
  if (!slots.length) fail('Không có slot để đặt');
  return { token, slots, runId: Date.now().toString(36) };
}

export function lookup() {
  const response = record(http.get(`${BASE}/api/parkings/availability`), 'lookup');
  lookupDuration.add(response.timings.duration);
  check(response, { 'tra cứu 200': (r) => r.status === 200 });
  sleep(0.5);
}

export function reserve({ token, slots, runId }) {
  const { parkingId, slotCode } = slots[Math.floor(Math.random() * slots.length)];
  const key = `k6-${runId}-${__VU}-${__ITER}`;
  const auth = { headers: { ...json.headers, Authorization: `Bearer ${token}`, 'Idempotency-Key': key } };
  const url = `${BASE}/api/parkings/${encodeURIComponent(parkingId)}/reservations`;
  const started = Date.now();
  const response = record(http.post(url, JSON.stringify({ slotCode, licensePlate: '30A-999.99' }), auth), 'reserve');
  check(response, { 'đặt: 201/202/409': (r) => [201, 202, 409].includes(r.status) });
  const final = resolve(response, auth);
  reserveDuration.add(Date.now() - started);
  check(final, { 'đặt có kết quả cuối 201/409': (r) => [201, 409].includes(r.code) });
  if (final.code === 201) {
    const id = final.result?.id;
    if (!check(id, { 'đặt trả reservation id': (value) => Boolean(value) })) return;
    sleep(0.2);
    const cancelAuth = { headers: { ...auth.headers, 'Idempotency-Key': `${key}-cancel` } };
    const cancelled = record(http.del(`${url}/${encodeURIComponent(id)}`, null, cancelAuth), 'cancel');
    check(resolve(cancelled, cancelAuth), { 'huỷ hoàn tất 200': (r) => r.code === 200 });
  }
  sleep(0.2);
}

export function handleSummary(data) {
  const values = (name) => data.metrics[name]?.values || {};
  const percentiles = (name) => ({
    p50_ms: values(name).med ?? null, p95_ms: values(name)['p(95)'] ?? null, p99_ms: values(name)['p(99)'] ?? null,
  });
  const report = {
    configuration: __ENV.CONFIG_NAME || 'manual',
    workload: { base: BASE, parking_ids: PARKINGS, lookup_vus: LOOKUP_VUS, reserve_vus: RESERVE_VUS,
      duration: __ENV.DURATION || '2m', poll_timeout_ms: POLL_TIMEOUT_MS },
    http: percentiles('http_req_duration'),
    lookup: percentiles('lookup_duration_ms'),
    reserve: percentiles('reserve_duration_ms'), // từ POST tới kết quả cuối, gồm thời gian poll khi 202
    requests_per_second: values('http_reqs').rate ?? null,
    iterations_per_second: values('iterations').rate ?? null,
    response_503_rate: values('response_503').rate ?? null,
    response_504_rate: values('response_504').rate ?? null,
    metrics: data.metrics, // giữ cả thresholds và số mẫu để đối chiếu, không thay số thiếu bằng 0
  };
  return { [__ENV.SUMMARY_PATH || '/results/summary.json']: JSON.stringify(report, null, 2),
    stdout: `${JSON.stringify({ configuration: report.configuration, lookup: report.lookup, reserve: report.reserve,
      requests_per_second: report.requests_per_second, response_503_rate: report.response_503_rate,
      response_504_rate: report.response_504_rate }, null, 2)}\n` };
}
