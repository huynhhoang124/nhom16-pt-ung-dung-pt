const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const base = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const ha = readFileSync(path.join(root, 'docker-compose.ha.yml'), 'utf8');
const service = (text, name) => text.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|^volumes:|$(?![\\s\\S]))`, 'm'))?.[1];

test('PD-14a bỏ HA không bị giá trị đồng bộ cũ trong volume chặn ghi A/D', () => {
  for (const id of ['a', 'd']) {
    assert.match(service(base, `db-${id}`), /synchronous_standby_names=/);
    const primary = service(ha, `db-${id}`);
    assert.match(primary, /wal_log_hints=on/);
    assert.doesNotMatch(primary, /synchronous_standby_names=/);
    assert.match(service(ha, `parking-${id}`), /condition: service_completed_successfully\n\s+required: false/);
  }
  assert.match(service(base, 'db-d'), /profiles: \[extra, ha\]/);
});

test('PD-14a HA bật metric bản sao A–D, mặc định không đọc replica vắng mặt', () => {
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.ok(service(ha, `parking-${id}`).includes(
      `READ_DATABASE_URL: postgres://postgres:dev@db-${id}-replica/parking`));
  }
  for (const id of ['a', 'b', 'c']) {
    assert.ok(service(base, `parking-${id}`).includes(`\${${id.toUpperCase()}_READ_DATABASE_URL:-}`));
  }
});
