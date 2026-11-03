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

  test('concurrent requests in one process for the last slot produce exactly one booking (cross-process race: see scheduler.test.ts)', async () => {
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

  test('client errors use the same error envelope', async () => {
    const badJson = await app.inject({ method: 'POST', url: '/appointments', payload: '{bad', headers: { 'content-type': 'application/json' } });
    assert.equal(badJson.statusCode, 400);
    assert.equal(badJson.json().error.code, 'BAD_REQUEST');
    const noRoute = await app.inject({ method: 'GET', url: '/nope' });
    assert.equal(noRoute.statusCode, 404);
    assert.equal(noRoute.json().error.code, 'ROUTE_NOT_FOUND');
    const noDealer = await app.inject({ method: 'GET', url: '/appointments?dealershipId=zzz' });
    assert.equal(noDealer.statusCode, 404);
    assert.equal(noDealer.json().error.code, 'DEALERSHIP_NOT_FOUND');
    const neverPossible = await app.inject({ method: 'GET', url: `/dealerships/dlr-hn/availability?serviceTypeId=svc-ev&startAt=${encodeURIComponent(at('09:00'))}` });
    assert.equal(neverPossible.statusCode, 422);
  });

  test('validates every input at the API boundary', async () => {
    const valid = { dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') };
    const cases: [string, Awaited<ReturnType<typeof book>>][] = [
      ['unknown field', await book({ ...valid, technicianId: 'tech-an' })],
      ['empty id', await book({ ...valid, vehicleId: '' })],
      ['no time zone offset', await book({ ...valid, startAt: '2030-03-04T09:00:00' })],
      ['impossible date', await book({ ...valid, startAt: '2030-02-30T09:00:00+07:00' })],
      ['idempotency key too long', await book(valid, { 'idempotency-key': 'x'.repeat(201) })],
    ];
    for (const [name, res] of cases) {
      assert.equal(res.statusCode, 400, name);
      assert.equal(res.json().error.code, 'VALIDATION_ERROR', name);
    }
    const noService = await app.inject({ method: 'GET', url: `/dealerships/dlr-hcm/availability?startAt=${encodeURIComponent(at('09:00'))}` });
    assert.equal(noService.statusCode, 400);
    const badRange = await app.inject({ method: 'GET', url: '/appointments?dealershipId=dlr-hcm&from=yesterday' });
    assert.equal(badRange.statusCode, 400);
    const noDealer = await app.inject({ method: 'GET', url: '/appointments' });
    assert.equal(noDealer.statusCode, 400);
  });

  test('maps each business rule to its HTTP status', async () => {
    const cases: [object, number, string][] = [
      [{ dealershipId: 'nope', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') }, 404, 'DEALERSHIP_NOT_FOUND'],
      [{ dealershipId: 'dlr-hcm', vehicleId: 'nope', serviceTypeId: 'svc-oil', startAt: at('09:00') }, 404, 'VEHICLE_NOT_FOUND'],
      [{ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'nope', startAt: at('09:00') }, 404, 'SERVICE_TYPE_NOT_FOUND'],
      [{ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:10') }, 400, 'INVALID_START_TIME'],
      [{ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: '2030-02-28T09:00:00+07:00' }, 400, 'START_TIME_IN_PAST'],
      [{ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('16:30') }, 422, 'OUTSIDE_OPENING_HOURS'],
      [{ dealershipId: 'dlr-hn', vehicleId: 'veh-1', serviceTypeId: 'svc-ev', startAt: at('09:00') }, 422, 'NO_QUALIFIED_TECHNICIAN'],
    ];
    for (const [body, status, code] of cases) {
      const res = await book(body);
      assert.deepEqual([res.statusCode, res.json().error.code], [status, code]);
    }
  });

  test('idempotent replay keeps the Location header; a reused key with another body is 422', async () => {
    const body = { dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') };
    const first = await book(body, { 'idempotency-key': 'k' });
    const replay = await book(body, { 'idempotency-key': 'k' });
    assert.equal(replay.headers.location, first.headers.location);
    const reused = await book({ ...body, startAt: at('10:00') }, { 'idempotency-key': 'k' });
    assert.deepEqual([reused.statusCode, reused.json().error.code], [422, 'IDEMPOTENCY_KEY_REUSED']);
  });

  test('reference data and resources endpoints', async () => {
    const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
    assert.deepEqual((await get('/dealerships')).map((d: { id: string }) => d.id), ['dlr-hcm', 'dlr-hn']);
    assert.equal((await get('/service-types')).length, 4);
    assert.equal((await get('/vehicles')).length, 3);
    const missing = await app.inject({ method: 'GET', url: '/dealerships/nope/resources' });
    assert.deepEqual([missing.statusCode, missing.json().error.code], [404, 'DEALERSHIP_NOT_FOUND']);
    const cancelMissing = await app.inject({ method: 'POST', url: '/appointments/nope/cancel' });
    assert.equal(cancelMissing.statusCode, 404);
  });

  test('echoes x-request-id and exposes metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'trace-123' } });
    assert.equal(res.headers['x-request-id'], 'trace-123');
    await book({ dealershipId: 'dlr-hcm', vehicleId: 'veh-1', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    assert.match(metrics, /appointments_booked_total 1/);
    const id = JSON.parse((await app.inject({ method: 'GET', url: '/appointments?dealershipId=dlr-hcm' })).body)[0].id;
    await app.inject({ method: 'POST', url: `/appointments/${id}/cancel` });
    await app.inject({ method: 'POST', url: `/appointments/${id}/cancel` });
    assert.match((await app.inject({ method: 'GET', url: '/metrics' })).body, /appointments_cancelled_total 1\n/);
    assert.match(metrics, /http_requests_total\{method="GET",route="\/health",status="200"\} 1/);
    await book({ dealershipId: 'dlr-hn', vehicleId: 'veh-2', serviceTypeId: 'svc-oil', startAt: at('09:00') });
    await book({ dealershipId: 'dlr-hn', vehicleId: 'veh-3', serviceTypeId: 'svc-oil', startAt: at('09:00') }); // conflict
    assert.match((await app.inject({ method: 'GET', url: '/metrics' })).body, /booking_conflicts_total\{code="NO_TECHNICIAN_AVAILABLE"\} 1/);
  });
});

test('serves the demo page and dealership resources', async () => {
  const db = openDb();
  seed(db);
  const app = buildApp(db, { now: () => NOW });
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  const resources = (await app.inject({ method: 'GET', url: '/dealerships/dlr-hcm/resources' })).json();
  assert.deepEqual(resources.technicians.find((t: { id: string }) => t.id === 'tech-an').skills.sort(), ['BRAKES', 'GENERAL']);
  assert.equal(resources.serviceBays.length, 2);
});
