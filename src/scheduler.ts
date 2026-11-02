import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SLOT_MINUTES = 15;
const MINUTE = 60_000;

export class BookingError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface BookingRequest {
  dealershipId: string;
  vehicleId: string;
  serviceTypeId: string;
  startAt: string; // ISO 8601 with offset
}

interface Dealership { id: string; utc_offset_minutes: number; open_minute: number; close_minute: number }
interface ServiceType { id: string; duration_minutes: number; required_skill: string }
interface Row { [key: string]: unknown }

export function createScheduler(db: DatabaseSync, now: () => number = Date.now) {
  const one = <T = Row>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...(params as never[])) as T | undefined;
  const all = <T = Row>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...(params as never[])) as T[];

  function requireDealership(id: string) {
    const dealership = one<Dealership>('SELECT * FROM dealerships WHERE id = ?', id);
    if (!dealership) throw new BookingError(404, 'DEALERSHIP_NOT_FOUND', `Dealership ${id} not found`);
    return dealership;
  }

  // Validates the request and resolves the time window. Shared by the availability check and booking,
  // so both return the same error for the same input.
  function resolveWindow(dealershipId: string, serviceTypeId: string, startAt: string) {
    const dealership = requireDealership(dealershipId);
    const service = one<ServiceType>('SELECT * FROM service_types WHERE id = ?', serviceTypeId);
    if (!service) throw new BookingError(404, 'SERVICE_TYPE_NOT_FOUND', `Service type ${serviceTypeId} not found`);

    const start = Date.parse(startAt);
    if (Number.isNaN(start)) throw new BookingError(400, 'INVALID_START_TIME', 'startAt must be an ISO 8601 date-time');
    if (start % (SLOT_MINUTES * MINUTE) !== 0) {
      throw new BookingError(400, 'INVALID_START_TIME', `startAt must be on a ${SLOT_MINUTES}-minute boundary`);
    }
    if (start <= now()) throw new BookingError(400, 'START_TIME_IN_PAST', 'startAt must be in the future');

    const duration = service.duration_minutes;
    // ponytail: fixed UTC offset per dealership, fine for Vietnam (no DST); use IANA time zones for DST regions.
    const localMinute = (((start / MINUTE + dealership.utc_offset_minutes) % 1440) + 1440) % 1440;
    if (localMinute < dealership.open_minute || localMinute + duration > dealership.close_minute) {
      throw new BookingError(422, 'OUTSIDE_OPENING_HOURS', 'The service must start and finish within dealership opening hours');
    }

    const qualified = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM technicians t JOIN technician_skills s ON s.technician_id = t.id
       WHERE t.dealership_id = ? AND s.skill = ?`, dealershipId, service.required_skill);
    if (!qualified?.n) {
      throw new BookingError(422, 'NO_QUALIFIED_TECHNICIAN', `This dealership has no technician qualified for ${service.required_skill} work`);
    }
    return { service, start, end: start + duration * MINUTE };
  }

  // Technicians with the required skill and service bays that are free for the whole window.
  function freeResources(dealershipId: string, skill: string, start: number, end: number) {
    const technicians = all<{ id: string; name: string }>(
      `SELECT t.id, t.name FROM technicians t
       JOIN technician_skills s ON s.technician_id = t.id AND s.skill = ?
       WHERE t.dealership_id = ? AND NOT EXISTS (
         SELECT 1 FROM appointments a WHERE a.technician_id = t.id AND a.status = 'CONFIRMED'
           AND a.start_at < ? AND a.end_at > ?)
       ORDER BY t.id`, skill, dealershipId, end, start);
    const bays = all<{ id: string; name: string }>(
      `SELECT b.id, b.name FROM service_bays b
       WHERE b.dealership_id = ? AND NOT EXISTS (
         SELECT 1 FROM appointments a WHERE a.bay_id = b.id AND a.status = 'CONFIRMED'
           AND a.start_at < ? AND a.end_at > ?)
       ORDER BY b.id`, dealershipId, end, start);
    return { technicians, bays };
  }

  // Workshop capacity only: whether this vehicle is already booked elsewhere is checked when booking.
  function checkAvailability(dealershipId: string, serviceTypeId: string, startAt: string) {
    const { service, start, end } = resolveWindow(dealershipId, serviceTypeId, startAt);
    const { technicians, bays } = freeResources(dealershipId, service.required_skill, start, end);
    return {
      available: technicians.length > 0 && bays.length > 0,
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      technicians,
      serviceBays: bays,
    };
  }

  const appointmentSelect = `
    SELECT a.*, c.name AS customer_name, v.vin, v.make, v.model, s.name AS service_name, s.duration_minutes,
           t.name AS technician_name, b.name AS bay_name
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    JOIN vehicles v ON v.id = a.vehicle_id
    JOIN service_types s ON s.id = a.service_type_id
    JOIN technicians t ON t.id = a.technician_id
    JOIN service_bays b ON b.id = a.bay_id`;

  const toAppointment = (r: Row) => ({
    id: r.id as string,
    status: r.status as 'CONFIRMED' | 'CANCELLED',
    dealershipId: r.dealership_id as string,
    customer: { id: r.customer_id, name: r.customer_name },
    vehicle: { id: r.vehicle_id, vin: r.vin, make: r.make, model: r.model },
    serviceType: { id: r.service_type_id, name: r.service_name, durationMinutes: r.duration_minutes },
    technician: { id: r.technician_id, name: r.technician_name },
    serviceBay: { id: r.bay_id, name: r.bay_name },
    startAt: new Date(r.start_at as number).toISOString(),
    endAt: new Date(r.end_at as number).toISOString(),
    createdAt: new Date(r.created_at as number).toISOString(),
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at as number).toISOString() : null,
  });

  function getAppointment(id: string) {
    const r = one(`${appointmentSelect} WHERE a.id = ?`, id);
    if (!r) throw new BookingError(404, 'APPOINTMENT_NOT_FOUND', `Appointment ${id} not found`);
    return toAppointment(r);
  }

  function book(req: BookingRequest, idempotencyKey?: string) {
    const { service, start, end } = resolveWindow(req.dealershipId, req.serviceTypeId, req.startAt);
    const vehicle = one<{ customer_id: string }>('SELECT customer_id FROM vehicles WHERE id = ?', req.vehicleId);
    if (!vehicle) throw new BookingError(404, 'VEHICLE_NOT_FOUND', `Vehicle ${req.vehicleId} not found`);
    const customerId = vehicle.customer_id; // A3: the customer is the vehicle's registered owner

    // Runs under the write lock: every read below sees all committed bookings and nobody can insert in between.
    function reserve() {
      if (idempotencyKey) {
        const prior = one('SELECT * FROM appointments WHERE idempotency_key = ?', idempotencyKey);
        if (prior) {
          const same = prior.dealership_id === req.dealershipId && prior.vehicle_id === req.vehicleId
            && prior.service_type_id === req.serviceTypeId && prior.start_at === start;
          if (!same) throw new BookingError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
          return { id: prior.id as string, replayed: true };
        }
      }
      const clash = one(
        `SELECT id FROM appointments WHERE vehicle_id = ? AND status = 'CONFIRMED' AND start_at < ? AND end_at > ?`,
        req.vehicleId, end, start);
      if (clash) throw new BookingError(409, 'VEHICLE_ALREADY_BOOKED', 'This vehicle already has an appointment at that time');

      const { technicians, bays } = freeResources(req.dealershipId, service.required_skill, start, end);
      if (technicians.length === 0) throw new BookingError(409, 'NO_TECHNICIAN_AVAILABLE', 'No qualified technician is free for the whole service duration');
      if (bays.length === 0) throw new BookingError(409, 'NO_BAY_AVAILABLE', 'No service bay is free for the whole service duration');

      // ponytail: first-fit allocation; balance technician workload here if utilisation becomes uneven.
      const id = randomUUID();
      db.prepare(
        `INSERT INTO appointments (id, dealership_id, customer_id, vehicle_id, service_type_id, technician_id, bay_id,
           start_at, end_at, status, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?)`,
      ).run(id, req.dealershipId, customerId, req.vehicleId, req.serviceTypeId,
        technicians[0].id, bays[0].id, start, end, idempotencyKey ?? null, now());
      return { id, replayed: false };
    }

    // BEGIN IMMEDIATE takes the write lock before we read, so check-then-insert is atomic across
    // connections and processes: two requests for the last free slot cannot both succeed.
    db.exec('BEGIN IMMEDIATE');
    let result: { id: string; replayed: boolean };
    try {
      result = reserve();
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      if (err instanceof Error && /DOUBLE_BOOKED/.test(err.message)) {
        throw new BookingError(409, 'SLOT_TAKEN', 'The slot was taken by another booking, please try again');
      }
      throw err;
    }
    return { appointment: getAppointment(result.id), replayed: result.replayed };
  }

  // Idempotent: cancelling twice is not an error, and `changed` tells the caller whether anything happened.
  function cancel(id: string) {
    const { changes } = db.prepare(
      `UPDATE appointments SET status = 'CANCELLED', cancelled_at = ? WHERE id = ? AND status = 'CONFIRMED'`,
    ).run(now(), id);
    return { appointment: getAppointment(id), changed: Number(changes) > 0 };
  }

  function listAppointments(dealershipId: string, from?: string, to?: string) {
    requireDealership(dealershipId);
    return all(
      `${appointmentSelect} WHERE a.dealership_id = ? AND a.start_at >= ? AND a.start_at < ? ORDER BY a.start_at`,
      dealershipId, from ? Date.parse(from) : 0, to ? Date.parse(to) : Number.MAX_SAFE_INTEGER,
    ).map(toAppointment);
  }

  function listResources(dealershipId: string) {
    requireDealership(dealershipId);
    const technicians = all<{ id: string; name: string; skills: string | null }>(
      `SELECT t.id, t.name, group_concat(s.skill) AS skills FROM technicians t
       LEFT JOIN technician_skills s ON s.technician_id = t.id WHERE t.dealership_id = ? GROUP BY t.id ORDER BY t.id`,
      dealershipId,
    ).map((t) => ({ ...t, skills: t.skills ? t.skills.split(',') : [] }));
    const serviceBays = all('SELECT id, name FROM service_bays WHERE dealership_id = ? ORDER BY id', dealershipId);
    return { technicians, serviceBays };
  }

  // Read-only reference data so a client can discover valid IDs.
  const referenceData = {
    dealerships: () => all('SELECT * FROM dealerships ORDER BY id'),
    serviceTypes: () => all('SELECT * FROM service_types ORDER BY id'),
    vehicles: () => all('SELECT * FROM vehicles ORDER BY id'),
  };

  return { checkAvailability, book, cancel, getAppointment, listAppointments, listResources, referenceData };
}

export type Scheduler = ReturnType<typeof createScheduler>;
