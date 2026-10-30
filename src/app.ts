import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { BookingError, createScheduler } from './scheduler.ts';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } } as const;

export function buildApp(db: DatabaseSync, opts: FastifyServerOptions & { now?: () => number } = {}) {
  const { now, ...fastifyOpts } = opts;
  const app = Fastify({
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    ...fastifyOpts,
  });
  const scheduler = createScheduler(db, now);

  // ponytail: in-process counters in Prometheus text format; swap for prom-client / OpenTelemetry when deployed.
  const metrics = new Map<string, number>();
  const inc = (name: string, value = 1) => metrics.set(name, (metrics.get(name) ?? 0) + value);

  app.addHook('onSend', async (req, reply) => { reply.header('x-request-id', req.id); });
  app.addHook('onResponse', async (req, reply) => {
    const labels = `method="${req.method}",route="${req.routeOptions.url ?? 'unknown'}",status="${reply.statusCode}"`;
    inc(`http_requests_total{${labels}}`);
    inc(`http_request_duration_ms_sum{${labels}}`, reply.elapsedTime);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof BookingError) {
      if (err.status === 409) inc(`booking_conflicts_total{code="${err.code}"}`);
      req.log.info({ code: err.code }, err.message);
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: e.message } });
    req.log.error(err);
    return reply.status(e.statusCode ?? 500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
  });

  app.get('/health', async () => {
    db.prepare('SELECT 1').get();
    return { status: 'ok' };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.type('text/plain; version=0.0.4');
    return [...metrics].map(([k, v]) => `${k} ${v}`).join('\n') + '\n';
  });

  // Read-only reference data so a client can discover valid IDs.
  app.get('/dealerships', async () => db.prepare('SELECT * FROM dealerships ORDER BY id').all());
  app.get('/service-types', async () => db.prepare('SELECT * FROM service_types ORDER BY id').all());
  app.get('/vehicles', async () => db.prepare('SELECT * FROM vehicles ORDER BY id').all());

  app.get('/dealerships/:id/availability', {
    schema: {
      params: idParam,
      querystring: {
        type: 'object',
        required: ['serviceTypeId', 'startAt'],
        properties: { serviceTypeId: { type: 'string' }, startAt: { type: 'string', format: 'date-time' } },
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { serviceTypeId, startAt } = req.query as { serviceTypeId: string; startAt: string };
    return scheduler.checkAvailability(id, serviceTypeId, startAt);
  });

  app.post('/appointments', {
    schema: {
      headers: { type: 'object', properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 200 } } },
      body: {
        type: 'object',
        required: ['dealershipId', 'vehicleId', 'serviceTypeId', 'startAt'],
        additionalProperties: false,
        properties: {
          dealershipId: { type: 'string', minLength: 1 },
          vehicleId: { type: 'string', minLength: 1 },
          serviceTypeId: { type: 'string', minLength: 1 },
          startAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (req, reply) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    const { appointment, replayed } = scheduler.book(req.body as never, key);
    if (!replayed) inc('appointments_booked_total');
    req.log.info({ appointmentId: appointment.id, replayed }, 'appointment confirmed');
    return reply.status(replayed ? 200 : 201).header('location', `/appointments/${appointment.id}`).send(appointment);
  });

  app.get('/appointments', {
    schema: {
      querystring: {
        type: 'object',
        required: ['dealershipId'],
        properties: {
          dealershipId: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (req) => {
    const { dealershipId, from, to } = req.query as { dealershipId: string; from?: string; to?: string };
    return scheduler.listAppointments(dealershipId, from, to);
  });

  app.get('/appointments/:id', { schema: { params: idParam } }, async (req) =>
    scheduler.getAppointment((req.params as { id: string }).id));

  app.post('/appointments/:id/cancel', { schema: { params: idParam } }, async (req) => {
    const appointment = scheduler.cancel((req.params as { id: string }).id);
    inc('appointments_cancelled_total');
    return appointment;
  });

  return app;
}
