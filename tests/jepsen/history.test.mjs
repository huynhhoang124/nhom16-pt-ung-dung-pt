import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHistory, sanitize } from './history.mjs';

test('history writes complete JSONL records in order', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pd26-history-'));
  try {
    const filePath = path.join(directory, 'run.jsonl');
    const history = await createHistory(filePath);
    await Promise.all([
      history.append({ type: 'operation', startedAt: 'a', endedAt: 'b' }),
      history.append({ type: 'nemesis', startedAt: 'c', endedAt: 'd' }),
    ]);
    await history.close();
    const records = (await readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map((record) => record.type), ['operation', 'nemesis']);
    await assert.rejects(() => createHistory(filePath), { code: 'EEXIST' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('history redacts credentials recursively', () => {
  assert.deepEqual(sanitize({
    commandId: 'safe',
    token: 'secret',
    nested: { authorization: 'Bearer secret', count: 2 },
  }), {
    commandId: 'safe',
    token: '[redacted]',
    nested: { authorization: '[redacted]', count: 2 },
  });
});
