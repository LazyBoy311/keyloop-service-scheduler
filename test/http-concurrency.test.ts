// Two real server processes share one database file (like two instances behind a load balancer)
// and receive HTTP requests at the same time. This is the end-to-end proof that the write lock,
// the triggers and the idempotency check hold across processes, not just inside one.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb, seed } from '../src/db.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (time: string) => `2030-03-04T${time}:00+07:00`;

function startServer(dbPath: string): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
    cwd: root,
    env: { ...process.env, PORT: '0', DB_PATH: dbPath, LOG_LEVEL: 'info' },
  });
  return new Promise((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (chunk) => {
      out += chunk;
      const port = out.match(/Server listening at http:\/\/[^"\s]+:(\d+)/)?.[1];
      if (port) resolve({ url: `http://127.0.0.1:${port}`, proc });
    });
    proc.stderr!.on('data', (chunk) => { out += chunk; });
    proc.once('exit', (code) => reject(new Error(`server exited with ${code}: ${out}`)));
  });
}

const stop = (proc: ChildProcess) => new Promise<void>((resolve) => {
  if (proc.exitCode !== null) return resolve();
  proc.once('exit', () => resolve());
  proc.kill();
});

describe('two server instances sharing one database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-http-'));
  const dbPath = join(dir, 'shared.db');
  let servers: { url: string; proc: ChildProcess }[] = [];

  before(async () => {
    const db = openDb(dbPath); // create schema once, so the two servers do not race on CREATE TABLE
    seed(db);
    db.close();
    servers = [await startServer(dbPath), await startServer(dbPath)];
  });

  after(async () => {
    await Promise.all(servers.map((s) => stop(s.proc)));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  beforeEach(() => {
    // Each test starts with no appointments. WAL mode lets this connection write while the servers are idle.
    const db = openDb(dbPath);
    db.exec('DELETE FROM appointments');
    db.close();
  });

  const post = (server: number, body: object, headers: Record<string, string> = {}) =>
    fetch(`${servers[server].url}/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const confirmed = async (dealershipId: string) => {
    const list = await fetch(`${servers[0].url}/appointments?dealershipId=${dealershipId}`).then((r) => r.json());
    return list.filter((a: { status: string }) => a.status === 'CONFIRMED');
  };

  test('parallel requests to both instances for the last slot: exactly one wins', async () => {
    // dlr-hn has one bay and one technician. Every vehicle is sent to both instances at once.
    const requests = ['veh-1', 'veh-2', 'veh-3'].flatMap((vehicleId) => [0, 1].map((server) =>
      post(server, { dealershipId: 'dlr-hn', vehicleId, serviceTypeId: 'svc-oil', startAt: at('09:00') })));
    const results = await Promise.all(requests);

    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409), JSON.stringify(results));
    assert.equal((await confirmed('dlr-hn')).length, 1);
  });

  test('parallel requests never exceed the number of free bays', async () => {
    // dlr-hcm has 3 GENERAL technicians but only 2 bays.
    const results = await Promise.all(['veh-1', 'veh-2', 'veh-3'].map((vehicleId, i) =>
      post(i % 2, { dealershipId: 'dlr-hcm', vehicleId, serviceTypeId: 'svc-oil', startAt: at('09:00') })));

    assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 409]);
    assert.equal(results.find((r) => r.status === 409)!.body.error.code, 'NO_BAY_AVAILABLE');
    const booked = await confirmed('dlr-hcm');
    assert.equal(new Set(booked.map((a: { serviceBay: { id: string } }) => a.serviceBay.id)).size, 2);
    assert.equal(new Set(booked.map((a: { technician: { id: string } }) => a.technician.id)).size, 2);
  });

  test('the same Idempotency-Key retried on both instances at once books only once', async () => {
    const body = { dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-brake', startAt: at('09:00') };
    const headers = { 'idempotency-key': 'retry-123' };
    const [a, b] = await Promise.all([post(0, body, headers), post(1, body, headers)]);

    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.id, b.body.id);
    assert.equal((await confirmed('dlr-hcm')).length, 1);
  });

  test('a booking made on one instance is immediately visible on the other', async () => {
    await post(0, { dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    const url = `${servers[1].url}/dealerships/dlr-hn/availability?serviceTypeId=svc-oil&startAt=${encodeURIComponent(at('09:30'))}`;
    assert.equal((await fetch(url).then((r) => r.json())).available, false);
    const second = await post(1, { dealershipId: 'dlr-hn', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:30') });
    assert.equal(second.body.error.code, 'NO_TECHNICIAN_AVAILABLE');
  });

  test('cancel on one instance frees the slot for a booking on the other', async () => {
    const first = await post(0, { dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    await fetch(`${servers[0].url}/appointments/${first.body.id}/cancel`, { method: 'POST' });
    const second = await post(1, { dealershipId: 'dlr-hn', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    assert.equal(second.status, 201);
  });
});
