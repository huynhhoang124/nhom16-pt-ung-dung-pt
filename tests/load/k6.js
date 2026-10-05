// GS-05: test tải bằng k6 (chạy bằng Docker, không cần cài):
//   docker run --rm -i --network nhom16-parking_default -e BASE=http://aggregator:8000 grafana/k6 run - < tests/load/k6.js
// Kịch bản: 200 người tra cứu liên tục + 50 người tranh nhau đặt 10 slot của bãi A (đặt được thì huỷ ngay để quay vòng).
// Sau khi chạy: node tests/load/check-invariants.mjs (không đặt trùng, outbox về 0).
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://localhost:8000';
const SLOTS = Array.from({ length: 10 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
const json = { headers: { 'content-type': 'application/json' } };
// 409 (slot vừa có người đặt) là kết quả nghiệp vụ đúng, không tính là lỗi
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    lookup: { executor: 'constant-vus', vus: 200, duration: __ENV.DURATION || '2m', exec: 'lookup' },
    reserve: { executor: 'constant-vus', vus: 50, duration: __ENV.DURATION || '2m', exec: 'reserve' },
  },
  thresholds: {
    'http_req_duration{scenario:lookup}': ['p(95)<500'],
    'http_req_duration{scenario:reserve}': ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const r = http.post(`${BASE}/api/auth/login`, JSON.stringify({ username: 'user1', password: __ENV.DEMO_PASSWORD || '123456' }), json);
  return { token: r.json('token') };
}

export function lookup() {
  check(http.get(`${BASE}/api/parkings/availability`), { 'tra cứu 200': (r) => r.status === 200 });
  sleep(0.5);
}

export function reserve({ token }) {
  const auth = { headers: { ...json.headers, authorization: `Bearer ${token}`, 'idempotency-key': `${__VU}-${__ITER}-${Date.now()}` } };
  const slot = SLOTS[Math.floor(Math.random() * SLOTS.length)];
  const r = http.post(`${BASE}/api/parkings/A/reservations`, JSON.stringify({ slotCode: slot, licensePlate: '30A-999.99' }), auth);
  check(r, { 'đặt: 201 hoặc 409': (x) => x.status === 201 || x.status === 409 });
  if (r.status === 201) {
    sleep(0.2);
    http.del(`${BASE}/api/parkings/A/reservations/${r.json('id')}`, null, { headers: auth.headers });
  }
  sleep(0.2);
}
