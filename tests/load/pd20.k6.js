import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const duration = new Trend('pd20_read_ms', true);
const base = __ENV.BASE || 'http://frontend';
export const options = {
  vus: 100,
  duration: __ENV.DURATION || '2m',
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: { checks: ['rate>0.99'], http_req_failed: ['rate<0.01'] },
};

export function setup() {
  const response = http.get(`${base}/api/parkings/B`);
  if (response.status !== 200 || response.json().stale) fail('Parking B is not ready');
  const expected = response.json().slots.length;
  if (!expected) fail('Parking B has no slots');
  return { expected };
}

export default function ({ expected }) {
  const response = http.get(`${base}/api/parkings/B`);
  duration.add(response.timings.duration);
  check(response, {
    'live complete snapshot': (r) => r.status === 200 && !r.json().stale && r.json().slots.length === expected,
  });
  sleep(0.1);
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH || '/results/pd20.json']: JSON.stringify(data, null, 2) };
}
