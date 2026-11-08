// Read-only timing diagnostics for the isolated TC80 stack.
import { execFileSync } from 'node:child_process';
const read = (service, query) => JSON.parse(execFileSync('docker',
  ['compose', 'exec', '-T', service, 'psql', '-U', 'postgres', '-d', 'parking', '-tAc', query],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim());
const commands = read('db-agg', `SELECT coalesce(json_agg(t),'[]') FROM (
  SELECT id,created_at,updated_at,status FROM commands WHERE id LIKE '%:k6-%'
) t`);
const replies = new Map();
for (const service of ['db-a', 'db-b', 'db-c']) {
  for (const row of read(service, `SELECT coalesce(json_agg(t),'[]') FROM (
    SELECT command_id,created_at,published_at FROM command_reply_outbox WHERE command_id LIKE '%:k6-%'
  ) t`)) replies.set(row.command_id, row);
}
const stages = { beforeNode: [], nodeAndRelay: [], afterNode: [], total: [] };
for (const command of commands) {
  const reply = replies.get(command.id);
  if (!reply || command.status === 'PENDING') continue;
  const start = Date.parse(command.created_at), node = Date.parse(reply.created_at);
  const end = Date.parse(command.updated_at);
  stages.beforeNode.push(node - start);
  if (reply.published_at) stages.nodeAndRelay.push(Date.parse(reply.published_at) - node);
  stages.afterNode.push(end - node);
  stages.total.push(end - start);
}
const summary = values => {
  values.sort((a, b) => a - b);
  return { count: values.length, p50: values[Math.floor(values.length * .5)],
    p95: values[Math.floor(values.length * .95)], p99: values[Math.floor(values.length * .99)] };
};
console.log(JSON.stringify(Object.fromEntries(Object.entries(stages).map(([key, values]) => [key, summary(values)])), null, 2));

for (const [service, port] of [['parking-a',8001], ['parking-b',8002], ['parking-c',8003]]) {
  const metrics = execFileSync('docker', ['compose', 'exec', '-T', service, 'node', '-e',
    "fetch('http://localhost:"+port+"/metrics').then(r=>r.text()).then(console.log)"], { encoding: 'utf8' });
  console.log(service, metrics.split('\n').filter(line => line.startsWith('command_consumer_stage_seconds')).join('\n'));
}

for (const service of ['db-a','db-b','db-c','db-agg']) {
  console.log(service, read(service, `SELECT row_to_json(w) FROM pg_stat_wal w`));
}
