import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDb, seed } from '../src/db.ts';

const NOW = Date.parse('2030-03-01T00:00:00Z');
const at = (time: string) => `2030-03-04T${time}:00+07:00`;

describe('REST API', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    const db = openDb();
    seed(db);
    app = buildApp(db, { now: () => NOW });
  });

  const book = (body: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/appointments', payload: body, headers });

  test('POST /appointments creates an appointment that GET returns', async () => {
    const res = await book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    assert.equal(res.statusCode, 201);
    const created = res.json();
    assert.equal(res.headers.location, `/appointments/${created.id}`);

    const fetched = await app.inject({ method: 'GET', url: res.headers.location as string });
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.json(), created);
  });

  test('rejects invalid payloads with 400', async () => {
    const missing = await book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', startAt: at('09:00') });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, 'VALIDATION_ERROR');
    const badDate = await book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: 'tomorrow' });
    assert.equal(badDate.statusCode, 400);
  });

  test('returns 409 with a machine-readable code when no resource is free', async () => {
    await book({ dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    const res = await book({ dealershipId: 'dlr-hn', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:30') });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'NO_TECHNICIAN_AVAILABLE');
  });

  test('availability endpoint reflects existing bookings', async () => {
    const url = `/dealerships/dlr-hn/availability?serviceTypeId=svc-oil&startAt=${encodeURIComponent(at('09:00'))}`;
    assert.equal((await app.inject({ method: 'GET', url })).json().available, true);
    await book({ dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    const after = (await app.inject({ method: 'GET', url })).json();
    assert.equal(after.available, false);
    assert.deepEqual(after.technicians, []);
  });

  test('Idempotency-Key makes retries safe', async () => {
    const body = { dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') };
    const first = await book(body, { 'idempotency-key': 'abc' });
    const retry = await book(body, { 'idempotency-key': 'abc' });
    assert.equal(first.statusCode, 201);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().id, first.json().id);
  });

  test('parallel requests for the last slot produce exactly one booking', async () => {
    const responses = await Promise.all(['veh-1', 'veh-2', 'veh-3'].map((vehicleId) =>
      book({ dealershipId: 'dlr-hn', vehicleId, serviceTypeId: 'svc-oil', startAt: at('09:00') })));
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409, 409]);
  });

  test('cancel endpoint and unknown appointment', async () => {
    const created = (await book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') })).json();
    const cancelled = await app.inject({ method: 'POST', url: `/appointments/${created.id}/cancel` });
    assert.equal(cancelled.json().status, 'CANCELLED');
    const missing = await app.inject({ method: 'GET', url: '/appointments/does-not-exist' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'APPOINTMENT_NOT_FOUND');
  });

  test('echoes x-request-id and exposes metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'trace-123' } });
    assert.equal(res.headers['x-request-id'], 'trace-123');
    await book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    assert.match(metrics, /appointments_booked_total 1/);
    assert.match(metrics, /http_requests_total\{method="GET",route="\/health",status="200"\} 1/);
  });
});
