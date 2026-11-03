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
    assert.deepEqual(s.getAppointment(appointment.id), appointment); // persisted
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
    const first = s.cancel(appointment.id);
    assert.equal(first.appointment.status, 'CANCELLED');
    assert.equal(first.changed, true);
    assert.equal(s.cancel(appointment.id).changed, false); // idempotent
    assert.ok(s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:00') }));
  });

  test('rejects a booking that fully contains an existing one', () => {
    s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-tyre', startAt: at('09:15') }); // 09:15-10:00
    rejects(() => s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:00') }),
      'NO_TECHNICIAN_AVAILABLE'); // 09:00-10:00
  });

  test('availability check rejects the same impossible requests as booking', () => {
    rejects(() => s.checkAvailability('dlr-hn', 'svc-ev', at('09:00')), 'NO_QUALIFIED_TECHNICIAN');
    rejects(() => s.checkAvailability('nope', 'svc-oil', at('09:00')), 'DEALERSHIP_NOT_FOUND');
  });

  test('replaying the same idempotency key returns the original appointment', () => {
    const req = { dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') };
    const first = s.book(req, 'key-1');
    const second = s.book(req, 'key-1');
    assert.equal(second.replayed, true);
    assert.equal(second.appointment.id, first.appointment.id);
    assert.equal(s.listAppointments('dlr-hcm').length, 1);
  });

  test('replaying a key after the appointment was cancelled returns the cancelled appointment, not a new booking', () => {
    const req = { dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') };
    const { appointment } = s.book(req, 'key-1');
    s.cancel(appointment.id);
    const replay = s.book(req, 'key-1');
    assert.equal(replay.replayed, true);
    assert.equal(replay.appointment.id, appointment.id);
    assert.equal(replay.appointment.status, 'CANCELLED');
    assert.equal(s.listAppointments('dlr-hcm').length, 1);
  });

  test('reusing an idempotency key for a different request is rejected', () => {
    s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') }, 'key-1');
    rejects(() => s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-3', serviceTypeId: 'svc-oil', startAt: at('11:00') }, 'key-1'),
      'IDEMPOTENCY_KEY_REUSED');
  });

  test('a start time equal to now is in the past; the next slot is bookable', () => {
    const clockAt0900 = createScheduler(db, () => Date.parse(at('09:00')));
    const book = (time: string) => () => clockAt0900.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at(time) });
    rejects(book('09:00'), 'START_TIME_IN_PAST');
    assert.ok(book('09:15')());
  });

  test('start times must sit exactly on the 15-minute grid, down to the millisecond', () => {
    const book = (startAt: string) => () => s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt });
    rejects(book('2030-03-04T09:00:30+07:00'), 'INVALID_START_TIME');
    rejects(book('2030-03-04T09:00:00.500+07:00'), 'INVALID_START_TIME');
    assert.ok(book('2030-03-04T09:00:00.000+07:00')());
  });

  test('opening hours are inclusive at both edges', () => {
    const book = (vehicleId: string, serviceTypeId: string, time: string) =>
      s.book({ dealershipId: 'dlr-hcm', vehicleId, serviceTypeId, startAt: at(time) });
    assert.ok(book('veh-1', 'svc-oil', '08:00')); // first slot of the day
    assert.ok(book('veh-2', 'svc-tyre', '16:15')); // 45 min, ends exactly at 17:00
    rejects(() => book('veh-3', 'svc-tyre', '16:30'), 'OUTSIDE_OPENING_HOURS'); // would end 17:15
  });

  test('start time is interpreted in the dealership time zone whatever offset the client sends', () => {
    const book = (vehicleId: string, startAt: string) =>
      () => s.book({ dealershipId: 'dlr-hcm', vehicleId, serviceTypeId: 'svc-oil', startAt });
    const { appointment } = book('veh-1', '2030-03-04T01:00:00Z')(); // 08:00 in UTC+7
    assert.equal(appointment.startAt, '2030-03-04T01:00:00.000Z');
    rejects(book('veh-2', '2030-03-04T00:45:00Z'), 'OUTSIDE_OPENING_HOURS'); // 07:45 local
    assert.ok(book('veh-2', '2030-03-04T10:00:00+09:00')()); // 08:00 local
  });

  test('assigns the first free qualified technician and bay', () => {
    const book = (vehicleId: string, serviceTypeId: string) =>
      s.book({ dealershipId: 'dlr-hcm', vehicleId, serviceTypeId, startAt: at('09:00') }).appointment;
    const first = book('veh-1', 'svc-oil');
    const second = book('veh-2', 'svc-oil');
    assert.deepEqual([first.technician.id, first.serviceBay.id], ['tech-an', 'bay-hcm-1']);
    assert.deepEqual([second.technician.id, second.serviceBay.id], ['tech-binh', 'bay-hcm-2']);
    s.cancel(second.id);
    assert.equal(book('veh-3', 'svc-ev').technician.id, 'tech-chi'); // the only EV technician
  });

  test('availability lists every free qualified technician and bay', () => {
    const r = s.checkAvailability('dlr-hcm', 'svc-oil', at('09:00'));
    assert.deepEqual(r.technicians.map((t) => t.id), ['tech-an', 'tech-binh', 'tech-chi']);
    assert.deepEqual(r.serviceBays.map((b) => b.id), ['bay-hcm-1', 'bay-hcm-2']);
    assert.equal(r.endAt, '2030-03-04T03:00:00.000Z');
    assert.deepEqual(s.checkAvailability('dlr-hcm', 'svc-brake', at('09:00')).technicians.map((t) => t.id), ['tech-an']);
  });

  test('dealerships do not share technicians or bays', () => {
    s.book({ dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') }); // fills dlr-hn
    const { appointment } = s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    assert.equal(appointment.serviceBay.id, 'bay-hcm-1');
  });

  test('the same vehicle can be booked back-to-back, and again after cancelling', () => {
    const book = (time: string) => s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at(time) });
    const first = book('09:00').appointment; // 09:00-10:00
    assert.ok(book('10:00')); // back-to-back is fine
    rejects(() => book('09:30'), 'VEHICLE_ALREADY_BOOKED');
    s.cancel(first.id);
    assert.ok(book('09:00')); // cancelled appointments do not block
  });

  test('lists appointments in a time range, ordered by start time', () => {
    for (const [vehicleId, time] of [['veh-2', '11:00'], ['veh-1', '09:00'], ['veh-3', '14:00']]) {
      s.book({ dealershipId: 'dlr-hcm', vehicleId, serviceTypeId: 'svc-oil', startAt: at(time) });
    }
    assert.deepEqual(s.listAppointments('dlr-hcm').map((a) => a.vehicle.id), ['veh-1', 'veh-2', 'veh-3']);
    assert.deepEqual(s.listAppointments('dlr-hcm', at('10:00'), at('14:00')).map((a) => a.vehicle.id), ['veh-2']); // to is exclusive
    assert.equal(s.listAppointments('dlr-hn').length, 0);
    rejects(() => s.listAppointments('nope'), 'DEALERSHIP_NOT_FOUND');
  });

  test("lists a dealership's technicians with skills and its bays", () => {
    const r = s.listResources('dlr-hcm');
    assert.deepEqual(r.technicians.find((t) => t.id === 'tech-chi')!.skills.sort(), ['EV', 'GENERAL']);
    assert.deepEqual(r.serviceBays.map((b) => b.id), ['bay-hcm-1', 'bay-hcm-2']);
    rejects(() => s.listResources('nope'), 'DEALERSHIP_NOT_FOUND');
  });

  test('cancelling an unknown appointment is a 404', () => {
    rejects(() => s.cancel('nope'), 'APPOINTMENT_NOT_FOUND');
  });

  test('database triggers block each kind of overlap even if application checks are bypassed', () => {
    // veh-1 oil 09:00-10:00 at dlr-hcm takes tech-an and bay-hcm-1 (first fit).
    s.book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    const insert = (vehicle: string, technician: string, bay: string) => () => db.prepare(
      `INSERT INTO appointments VALUES (?, 'dlr-hcm', 'cus-2', ?, 'svc-oil', ?, ?, ?, ?, 'CONFIRMED', NULL, 0, NULL)`,
    ).run(crypto.randomUUID(), vehicle, technician, bay, Date.parse(at('09:30')), Date.parse(at('10:30')));
    assert.throws(insert('veh-3', 'tech-binh', 'bay-hcm-1'), /BAY_DOUBLE_BOOKED/);
    assert.throws(insert('veh-3', 'tech-an', 'bay-hcm-2'), /TECHNICIAN_DOUBLE_BOOKED/);
    assert.throws(insert('veh-1', 'tech-binh', 'bay-hcm-2'), /VEHICLE_DOUBLE_BOOKED/);
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
