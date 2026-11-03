
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createScheduledJobsLock,
} = require('../src/scheduled-lock');

const logger = {
  info() {},
  warn() {},
  error() {},
};

function fakeDatabase() {
  let currentOwner = null;
  let nextId = 0;

  const sessions = [];

  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.id = ++nextId;
      this.closed = false;
      sessions.push(this);
    }

    async connect() {}

    async query(sql) {
      if (this.closed) {
        throw new Error('Connection closed');
      }

      if (sql.includes('pg_try_advisory_lock')) {
        const locked =
          currentOwner === null ||
          currentOwner === this;

        if (locked) currentOwner = this;

        return { rows: [{ locked }] };
      }

      if (sql.includes('pg_advisory_unlock')) {
        const unlocked = currentOwner === this;

        if (unlocked) currentOwner = null;

        return { rows: [{ unlocked }] };
      }

      if (sql.includes('SELECT 1')) {
        return { rows: [{ ok: 1 }] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    }

    async end() {
      this.closed = true;

      if (currentOwner === this) {
        currentOwner = null;
      }
    }

    disconnect() {
      this.closed = true;

      if (currentOwner === this) {
        currentOwner = null;
      }

      this.emit('error', new Error('Connection lost'));
    }
  }

  return {
    FakeClient,
    sessions,
    owner: () => currentOwner,
  };
}

function startLock(db, parkingId = 'A') {
  return createScheduledJobsLock('fake-db', {
    parkingId,
    log: logger,
    ClientClass: db.FakeClient,
  });
}

async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timeout waiting for condition');
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('PD-13: one node acquires advisory lock', async () => {
  const db = fakeDatabase();
  const lock = startLock(db);

  try {
    await until(() => lock.isOwner());

    assert.equal(lock.isOwner(), true);
    assert.notEqual(db.owner(), null);
  } finally {
    await lock.stop();
  }
});

test('PD-13: two nodes cannot both own the lock', async () => {
  const db = fakeDatabase();

  const first = startLock(db);
  const second = startLock(db);

  try {
    await until(() => first.isOwner() || second.isOwner());

    assert.notEqual(
      first.isOwner(),
      second.isOwner()
    );
  } finally {
    await first.stop();
    await second.stop();
  }
});

test('PD-13: standby takes over after shutdown', async () => {
  const db = fakeDatabase();

  const first = startLock(db);
  const second = startLock(db);

  try {
    await until(() => first.isOwner() || second.isOwner());

    const active = first.isOwner() ? first : second;
    const standby = first.isOwner() ? second : first;

    assert.equal(standby.isOwner(), false);

    await active.stop();

    await until(() => standby.isOwner());

    assert.equal(standby.isOwner(), true);
    assert.equal(active.isOwner(), false);
  } finally {
    await first.stop();
    await second.stop();
  }
});

test('PD-13: disconnect removes ownership', async () => {
  const db = fakeDatabase();
  const lock = startLock(db);

  try {
    await until(() => lock.isOwner());

    const originalSession = db.owner();

    originalSession.disconnect();

    assert.equal(lock.isOwner(), false);
    assert.equal(db.owner(), null);

    await until(() => lock.isOwner());

    assert.notEqual(db.owner(), originalSession);
  } finally {
    await lock.stop();
  }
});

test('PD-13: shutdown releases lock', async () => {
  const db = fakeDatabase();
  const lock = startLock(db);

  await until(() => lock.isOwner());

  await lock.stop();

  assert.equal(lock.isOwner(), false);
  assert.equal(db.owner(), null);
});