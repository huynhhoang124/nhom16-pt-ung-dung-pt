import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

export async function createHistory(filePath) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const file = await open(resolved, 'wx');
  let queue = Promise.resolve();
  return {
    filePath: resolved,
    append(entry) {
      queue = queue.then(() => file.appendFile(`${JSON.stringify(entry)}\n`, 'utf8'));
      return queue;
    },
    async close() {
      await queue;
      await file.close();
    },
  };
}

export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /token|password|authorization|secret/i.test(key) ? '[redacted]' : sanitize(child),
  ]));
}
