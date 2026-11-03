// The real server keeps its data across restarts, and re-seeding on start does not duplicate reference data.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer, stopServer } from './fixtures/server.ts';

test('appointments survive a server restart and seed data is not duplicated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-restart-'));
  const dbPath = join(dir, 'nested', 'scheduler.db'); // server must create the missing directory
  try {
    let server = await startServer(dbPath);
    const booked = await fetch(`${server.url}/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: '2030-03-04T09:00:00+07:00' }),
    }).then((r) => r.json());
    await stopServer(server.proc);

    server = await startServer(dbPath);
    try {
      const after = await fetch(`${server.url}/appointments/${booked.id}`).then((r) => r.json());
      assert.equal(after.status, 'CONFIRMED');
      assert.equal((await fetch(`${server.url}/dealerships`).then((r) => r.json())).length, 2);
      assert.equal((await fetch(`${server.url}/vehicles`).then((r) => r.json())).length, 3);
    } finally {
      await stopServer(server.proc);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
