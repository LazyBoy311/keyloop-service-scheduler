# Unified Service Scheduler
[![CI](https://github.com/LazyBoy311/keyloop-service-scheduler/actions/workflows/ci.yml/badge.svg)](https://github.com/LazyBoy311/keyloop-service-scheduler/actions/workflows/ci.yml)

Keyloop technical assessment, **Scenario A (Ownership)**: a backend service that books dealership service appointments. A booking is confirmed only if a **service bay** and a **technician qualified for the job** are both free for the **entire service duration**.

- System design: [`docs/system-design.md`](docs/system-design.md)
- API contract: [`openapi.yaml`](openapi.yaml)
- Production readiness: what is still missing before go-live, and in what order ([design doc, section 8](docs/system-design.md#8-production-readiness))
- Implemented layer: **backend** (REST API + persistent SQL database). The frontend is stubbed by a minimal demo page (below), the OpenAPI contract, the cURL examples and the API test suite.

## Demo UI

`npm start`, then open **http://localhost:3000**. The page is a single static HTML file (`public/index.html`, no framework) served by the API. It lets you:

- check availability and book a service, with the API's error code shown on conflicts;
- see the day's **workshop timeline** per technician and per service bay, with the requested window highlighted, so it is visible *why* a slot was rejected;
- cancel appointments, and watch the raw API calls in a log panel.

![Demo UI](docs/demo-ui.png)

## Quick start

Requirements: **Node.js 22.18+ or 24** (uses the built-in SQLite driver and native TypeScript support, so there is no database to install and no build step).

```bash
npm install
npm test          # 51 tests: business rules, REST API, concurrent booking races, restart
npm run typecheck # tsc --noEmit
npm start         # http://localhost:3000, data in ./data/scheduler.db
```

Or with Docker (no Node.js needed):

```bash
docker build -t service-scheduler .
docker run -p 3000:3000 -v scheduler-data:/app/data service-scheduler
```

The image uses the same SQLite file, kept in a volume. PostgreSQL is the production path (see the design doc, section 4), not needed to run this submission.

Environment variables: `PORT` (default `3000`), `DB_PATH` (default `data/scheduler.db`, or `:memory:`), `LOG_LEVEL` (default `info`).

Reference data is seeded on start:

| Dealership | Bays | Technicians (skills) |
|---|---|---|
| `dlr-hcm` (UTC+7, 08:00-17:00) | `bay-hcm-1`, `bay-hcm-2` | `tech-an` (GENERAL, BRAKES), `tech-binh` (GENERAL), `tech-chi` (GENERAL, EV) |
| `dlr-hn` (UTC+7, 08:00-17:00) | `bay-hn-1` | `tech-dung` (GENERAL) |

Service types: `svc-oil` 60 min GENERAL, `svc-tyre` 45 min GENERAL, `svc-brake` 90 min BRAKES, `svc-ev` 120 min EV.
Vehicles: `veh-1`, `veh-2` (owner `cus-1`), `veh-3` (owner `cus-2`).

## API walkthrough (cURL)

```bash
# 1. Is a brake job possible at 09:00 local time?
curl "http://localhost:3000/dealerships/dlr-hcm/availability?serviceTypeId=svc-brake&startAt=2030-03-04T09:00:00%2B07:00"
# -> {"available":true,"technicians":[{"id":"tech-an",...}],"serviceBays":[...], ...}

# 2. Book it (Idempotency-Key makes a retry safe)
curl -X POST http://localhost:3000/appointments \
  -H "content-type: application/json" -H "idempotency-key: demo-1" \
  -d '{"dealershipId":"dlr-hcm","vehicleId":"veh-1","serviceTypeId":"svc-brake","startAt":"2030-03-04T09:00:00+07:00"}'
# -> 201 {"id":"...","status":"CONFIRMED","customer":{"id":"cus-1",...},"technician":{"id":"tech-an",...},"serviceBay":{"id":"bay-hcm-1",...}, ...}

# 3. Another brake job overlapping 10:00-11:30: the only BRAKES technician is busy until 10:30
curl -X POST http://localhost:3000/appointments -H "content-type: application/json" \
  -d '{"dealershipId":"dlr-hcm","vehicleId":"veh-2","serviceTypeId":"svc-brake","startAt":"2030-03-04T10:00:00+07:00"}'
# -> 409 {"error":{"code":"NO_TECHNICIAN_AVAILABLE","message":"..."}}

# 4. Read, list, cancel
curl http://localhost:3000/appointments/<id>
curl "http://localhost:3000/appointments?dealershipId=dlr-hcm"
curl -X POST http://localhost:3000/appointments/<id>/cancel

# 5. Operations
curl http://localhost:3000/health
curl http://localhost:3000/metrics
```

### Error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `BAD_REQUEST`, `INVALID_START_TIME`, `START_TIME_IN_PAST` | Malformed request, not on the 15-minute grid, or in the past |
| 404 | `DEALERSHIP_NOT_FOUND`, `SERVICE_TYPE_NOT_FOUND`, `VEHICLE_NOT_FOUND`, `APPOINTMENT_NOT_FOUND`, `ROUTE_NOT_FOUND` | Unknown reference or route |
| 409 | `NO_TECHNICIAN_AVAILABLE`, `NO_BAY_AVAILABLE`, `VEHICLE_ALREADY_BOOKED`, `SLOT_TAKEN` | Resources not free for the whole window |
| 422 | `OUTSIDE_OPENING_HOURS`, `NO_QUALIFIED_TECHNICIAN`, `IDEMPOTENCY_KEY_REUSED` | Can never be booked as requested, or a key reused for a different request |

## Project layout

```
src/
  db.ts          schema, overlap triggers, seed data
  scheduler.ts   business rules: time window, availability, atomic booking, cancel
  app.ts         Fastify routes, validation, error mapping, metrics, request id
  server.ts      bootstrap + graceful shutdown
public/index.html  demo UI (test harness for the frontend layer)
test/
  scheduler.test.ts         business rules + multi-connection race (worker threads)
  api.test.ts               HTTP contract via fastify.inject
  http-concurrency.test.ts  two real server processes on one DB, parallel HTTP requests
  server-restart.test.ts    data survives a restart, seeding is idempotent
docs/system-design.md
openapi.yaml
```

## How correctness is guaranteed

- **Entire-duration check.** Overlap uses half-open intervals (`a.start < b.end AND a.end > b.start`), so partial overlaps are rejected and back-to-back bookings are allowed.
- **No double booking under concurrency.** Check and insert run in one `BEGIN IMMEDIATE` transaction. In addition, database triggers reject any overlapping confirmed appointment for the same bay, technician or vehicle. A test races three worker threads on separate DB connections for the last slot and asserts exactly one wins. Another starts two real server processes on the same database file and fires parallel HTTP requests at both: the last slot, the bay limit and a retried Idempotency-Key all hold.
- **Safe retries.** `Idempotency-Key` returns the original appointment instead of booking twice. The key is looked up under the same write lock, so retries racing on separate instances are safe too, and reusing a key for a different request is rejected.

## AI Collaboration Narrative

> Draft. Rewrite this in your own words before submitting; it is evaluated as your story.

**Tool.** Claude Code (agentic CLI) as the implementer. I acted as tech lead: I chose the scenario and layer, set constraints and reviewed every step.

**Strategy.**
1. *Context first.* I gave the AI the full challenge PDF and the business context (after-sales, service bays, technician skills), then had it propose assumptions before writing any code. I accepted or changed each assumption, and they are recorded in the design doc.
2. *Constraints up front.* Backend in TypeScript (my strongest stack). Minimal dependencies. A real SQL database that reviewers can run without Docker. Every business rule must have a test.
3. *Small, verifiable steps.* Schema, then domain logic, then HTTP layer, then tests, then docs. I ran the tests and the type checker after each step instead of trusting the generated code.

**Verification and refinement.**
- **Concurrency.** Double booking is the main risk in a scheduler, so I required defence in depth from the start: a locking transaction and a database-level invariant. I also required a test that proves it with separate database connections, because parallel HTTP calls inside one Node process never truly interleave and would prove nothing.
- **Caught in review.** The first `listAppointments` loaded each appointment with a separate query (N+1). This was refactored to one joined query shared with `getAppointment`.
- **Debugging.** The concurrency test failed on Windows with `EPERM` while deleting the temp database. The cause was that worker threads had not released the file yet. The fix was to wait for each worker's `exit` event before cleanup. The assertion itself had passed, so the bug was in the test harness, not the booking logic.
- **Smoke test.** Beyond automated tests, I ran the server and walked through the cURL flow above (201, then 409, then metrics) to check real behaviour.

**Owning the result.** I can explain every line. The key decisions (auto-assignment, half-open intervals, 409 vs 422 split, SQLite now and PostgreSQL `EXCLUDE` later) are mine and documented with their trade-offs.
