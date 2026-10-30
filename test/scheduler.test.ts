import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { openDb, seed } from '../src/db.ts';
import { BookingError, createScheduler, type Scheduler } from '../src/scheduler.ts';

// Seeded dealerships are UTC+7 and open 08:00-17:00 local time.
export const NOW = Date.parse('2030-03-01T00:00:00Z');
const at = (time: string) => `2030-03-04T${time}:00+07:00`;

function rejects(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => err instanceof BookingError && err.code === code);
}

describe('scheduler', () => {
  let s: Scheduler;
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb();
    seed(db);
    s = createScheduler(db, () => NOW);
  });

  test('books a confirmed appointment linking customer, vehicle, technician and bay', () => {
    const { appointment } = s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-3', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    assert.equal(appointment.status, 'CONFIRMED');
    assert.deepEqual(appointment.customer, { id: 'cus-2', name: 'Vo Tuan' }); // owner of veh-3
    assert.equal(appointment.vehicle.id, 'veh-3');
    assert.ok(appointment.technician.id);
    assert.ok(appointment.serviceBay.id);
    assert.equal(appointment.startAt, '2030-03-04T02:00:00.000Z');
    assert.equal(appointment.endAt, '2030-03-04T03:00:00.000Z'); // 60-minute service
    assert.deepEqual(s.getAppointment(appointment.id as string), appointment); // persisted
  });

  test('only assigns a technician who has the required skill', () => {
    const { appointment } = s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-brake', startAt: at('09:00') });
    assert.equal(appointment.technician.id, 'tech-an'); // the only BRAKES technician
  });

  test('rejects when the only qualified technician is busy for part of the window', () => {
    s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-brake', startAt: at('09:00') }); // 09:00-10:30
    rejects(() => s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-2', serviceTypeId: 'svc-brake', startAt: at('10:00') }),
      'NO_TECHNICIAN_AVAILABLE');
  });

  test('allows back-to-back appointments (end time is exclusive)', () => {
    s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-brake', startAt: at('09:00') }); // ends 10:30
    const { appointment } = s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-2', serviceTypeId: 'svc-brake', startAt: at('10:30') });
    assert.equal(appointment.technician.id, 'tech-an');
  });

  test('rejects when every service bay is occupied even if technicians are free', () => {
    // 3 GENERAL technicians but only 2 bays at dlr-hcm.
    s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    rejects(() => s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-3', serviceTypeId: 'svc-oil', startAt: at('09:30') }),
      'NO_BAY_AVAILABLE');
    assert.equal(s.checkAvailability('dlr-hcm', 'svc-oil', at('09:30')).available, false);
    assert.equal(s.checkAvailability('dlr-hcm', 'svc-oil', at('10:00')).available, true);
  });

  test('rejects a second appointment for the same vehicle at an overlapping time', () => {
    s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    rejects(() => s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:30') }),
      'VEHICLE_ALREADY_BOOKED');
  });

  test('rejects when the dealership has nobody qualified at all', () => {
    rejects(() => s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-2', serviceTypeId: 'svc-ev', startAt: at('09:00') }),
      'NO_QUALIFIED_TECHNICIAN');
  });

  test('enforces opening hours, future start and 15-minute slots', () => {
    const book = (serviceTypeId: string, startAt: string) =>
      () => s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId, startAt });
    rejects(book('svc-oil', at('07:45')), 'OUTSIDE_OPENING_HOURS');
    rejects(book('svc-oil', at('16:30')), 'OUTSIDE_OPENING_HOURS'); // would finish 17:30
    rejects(book('svc-oil', '2030-02-28T09:00:00+07:00'), 'START_TIME_IN_PAST');
    rejects(book('svc-oil', at('09:10')), 'INVALID_START_TIME');
    assert.ok(s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('16:00') }));
  });

  test('returns 404-style errors for unknown references', () => {
    rejects(() => s.book({ dealershipId: 'nope', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') }), 'DEALERSHIP_NOT_FOUND');
    rejects(() => s.book({ dealershipId: 'dlr-hcm', vehicleId: 'nope', serviceTypeId: 'svc-oil', startAt: at('09:00') }), 'VEHICLE_NOT_FOUND');
    rejects(() => s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'nope', startAt: at('09:00') }), 'SERVICE_TYPE_NOT_FOUND');
  });

  test('cancelling frees the technician and bay', () => {
    const { appointment } = s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    rejects(() => s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:00') }), 'NO_TECHNICIAN_AVAILABLE');
    assert.equal(s.cancel(appointment.id as string).status, 'CANCELLED');
    assert.ok(s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:00') }));
  });

  test('replaying the same idempotency key returns the original appointment', () => {
    const req = { dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') };
    const first = s.book(req, 'key-1');
    const second = s.book(req, 'key-1');
    assert.equal(second.replayed, true);
    assert.equal(second.appointment.id, first.appointment.id);
    assert.equal(s.listAppointments('dlr-hcm').length, 1);
  });

  test('database triggers block an overlapping insert even if application checks are bypassed', () => {
    const { appointment } = s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    assert.throws(() => db.prepare(
      `INSERT INTO appointments VALUES ('x', 'dlr-hn', 'cus-2', 'veh-3', 'svc-oil', 'tech-dung', 'bay-hn-1', ?, ?, 'CONFIRMED', NULL, 0, NULL)`,
    ).run(Date.parse(appointment.startAt) + 30 * 60_000, Date.parse(appointment.endAt) + 30 * 60_000), /DOUBLE_BOOKED/);
  });
});

test('concurrent bookings from separate connections never double-book the last slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-'));
  const dbPath = join(dir, 'race.db');
  const db = openDb(dbPath);
  seed(db);
  db.close();
  try {
    // dlr-hn has one bay and one technician, so exactly one of these can win.
    const vehicles = ['veh-1', 'veh-2', 'veh-3'];
    const results = await Promise.all(vehicles.map((vehicleId) => new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL('./fixtures/book-worker.ts', import.meta.url), {
        workerData: { dbPath, now: NOW, req: { dealershipId: 'dlr-hn', vehicleId, serviceTypeId: 'svc-oil', startAt: at('09:00') } },
      });
      let result = '';
      worker.once('message', (m: string) => { result = m; });
      worker.once('error', reject);
      worker.once('exit', () => resolve(result)); // wait for exit so Windows releases the db file
    })));
    assert.equal(results.filter((r) => r === 'CONFIRMED').length, 1, `results: ${results}`);
    assert.equal(results.filter((r) => r === 'NO_TECHNICIAN_AVAILABLE' || r === 'SLOT_TAKEN').length, 2, `results: ${results}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
