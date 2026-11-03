# System Design: Unified Service Scheduler

**Scenario A (Ownership domain).** Replaces manual workshop booking with an API that books a service appointment only when a service bay **and** a qualified technician are free for the whole service duration.

## 1. Problem and scope

After-sales (service, parts, warranty) is the steadiest source of dealership profit, and the workshop's capacity is two scarce resources: **service bays** and **skilled technicians**. Manual booking (phone + spreadsheet) leads to double-booked bays, jobs given to technicians without the right qualification, and idle capacity.

In scope (backend layer, fully implemented):

1. **Resource-constrained booking**: request a service for a vehicle, service type, dealership and start time.
2. **Real-time availability check**: before confirming, check that a bay and a technician holding the required skill are both free for the entire duration.
3. **Confirmed appointment record**: persist an appointment that links customer, vehicle, technician and bay.

Frontend is out of scope as a product, and stubbed by a minimal demo page (`public/index.html`, served at `/`), the OpenAPI contract (`openapi.yaml`), cURL examples in the README and the API test suite.

## 2. Assumptions (requirements were intentionally ambiguous)

| # | Assumption | Why |
|---|---|---|
| A1 | Each **service type** has a fixed duration and one required skill (e.g. Brake inspection = 90 min, `BRAKES`). | Makes "qualified technician" and "entire duration" concrete. |
| A2 | One appointment uses exactly **one bay and one technician** for its whole duration. | Typical for routine service jobs; multi-technician jobs are future work. |
| A3 | The **customer is the vehicle's registered owner**; the client sends `vehicleId`. | Avoids booking a car on behalf of an unrelated customer. |
| A4 | The system **auto-assigns** the technician and bay (first fit). The customer chooses the time, not the person. | Matches how service advisors book; keeps the API simple. |
| A5 | Start times are on a **15-minute grid**, in the future, and the job must **start and finish within opening hours** (08:00-17:00 local). | Reduces calendar fragmentation; jobs do not run overnight. |
| A6 | A **vehicle** cannot have two overlapping appointments (at any dealership). | A car cannot be in two places. |
| A7 | Time intervals are half-open `[start, end)`, so back-to-back bookings are allowed. | Standard interval semantics. |
| A8 | Dealerships use a fixed UTC offset (Vietnam has no DST). | Simplification; IANA time zones are listed as future work. |
| A9 | Reference data (dealerships, bays, technicians, skills, vehicles) comes from the DMS; here it is seeded. | Master-data management is not part of the scenario. |

## 3. Architecture

```mermaid
flowchart LR
    Client["Client<br/>(service advisor UI, customer portal,<br/>cURL / test harness)"] -->|HTTPS + JSON| API

    subgraph Service["Scheduler service (Node.js + Fastify)"]
        API["HTTP layer<br/>routing, JSON-schema validation,<br/>error mapping, request id"]
        Domain["Scheduling domain<br/>window rules, availability,<br/>allocation, booking transaction"]
        Obs["Observability<br/>structured logs (pino),<br/>/metrics, /health"]
        API --> Domain
        API -.-> Obs
    end

    Domain -->|"BEGIN IMMEDIATE ... COMMIT"| DB[("Relational DB<br/>SQLite (dev) / PostgreSQL (prod)<br/>+ overlap triggers / EXCLUDE constraint")]
    Prom["Prometheus / Grafana"] -.->|scrape| Obs
```

Target production deployment:

```mermaid
flowchart LR
    LB[Load balancer / API gateway] --> S1[Scheduler instance 1]
    LB --> S2[Scheduler instance N]
    S1 --> PG[(PostgreSQL primary)]
    S2 --> PG
    PG --> RR[(Read replica<br/>availability queries)]
    S1 -. events .-> Bus[[Event bus:<br/>AppointmentConfirmed / Cancelled]]
    Bus -.-> N[Notifications, DMS sync, analytics]
```

### Components

| Component | Role |
|---|---|
| **HTTP layer** (`src/app.ts`) | Fastify routes, JSON-schema validation of every input, maps domain errors to HTTP status + stable error codes, propagates `x-request-id`, records metrics. |
| **Scheduling domain** (`src/scheduler.ts`) | Pure business rules: validates the time window, finds free qualified technicians and bays, and performs the atomic booking. No HTTP knowledge, so it is unit-tested directly. |
| **Persistence** (`src/db.ts`) | Schema, indexes, overlap triggers and seed data. Uses Node's built-in SQLite driver: zero setup for reviewers. |
| **Server bootstrap** (`src/server.ts`) | Opens the DB, seeds reference data, starts the server, shuts down gracefully. |

### Data model

```mermaid
erDiagram
    DEALERSHIP ||--o{ SERVICE_BAY : has
    DEALERSHIP ||--o{ TECHNICIAN : employs
    TECHNICIAN ||--o{ TECHNICIAN_SKILL : holds
    CUSTOMER ||--o{ VEHICLE : owns
    APPOINTMENT }o--|| DEALERSHIP : at
    APPOINTMENT }o--|| CUSTOMER : for
    APPOINTMENT }o--|| VEHICLE : services
    APPOINTMENT }o--|| SERVICE_TYPE : of
    APPOINTMENT }o--|| TECHNICIAN : "assigned to"
    APPOINTMENT }o--|| SERVICE_BAY : "occupies"
```

`service_types.required_skill` must match a `technician_skills.skill` row for the technician to qualify. `appointments` stores `start_at` / `end_at` as UTC epoch ms and a `status` (`CONFIRMED`, `CANCELLED`). Partial indexes on `(bay_id, start_at)`, `(technician_id, start_at)` and `(vehicle_id, start_at)` for confirmed rows keep overlap lookups fast.

## 4. Data flow: booking an appointment

```mermaid
sequenceDiagram
    participant C as Client
    participant A as HTTP layer
    participant D as Scheduling domain
    participant DB as Database
    C->>A: POST /appointments {dealershipId, vehicleId, serviceTypeId, startAt} + Idempotency-Key
    A->>A: JSON-schema validation (400 on failure)
    A->>D: book(request, key)
    D->>D: resolve window: duration, 15-min grid, future, opening hours (400/422)
    D->>DB: any qualified technician at this dealership? (422 if none)
    D->>DB: BEGIN IMMEDIATE (take write lock)
    D->>DB: key already used? same request -> original appointment (200), different -> 422
    D->>DB: vehicle overlap? (409 VEHICLE_ALREADY_BOOKED)
    D->>DB: free technicians with skill AND free bays for [start, end)
    alt none free
        D->>DB: ROLLBACK
        D-->>A: 409 NO_TECHNICIAN_AVAILABLE / NO_BAY_AVAILABLE
    else both free
        D->>DB: INSERT appointment (triggers re-check overlap)
        D->>DB: COMMIT
        D-->>A: appointment
        A-->>C: 201 Created + Location
    end
```

`GET /dealerships/{id}/availability` runs the same validation (including the 422 rules) and resource query without writing, so a UI can show whether a slot is bookable before the user confirms. It reports workshop capacity only; a clash with the same vehicle's other bookings is detected at booking time.

### Correctness under concurrency

The critical race: two advisors book the last free bay at the same moment. Both read "free", both insert, and the bay is double-booked. Three layers prevent it:

1. **Serialised check-then-insert.** The availability query and the insert run inside `BEGIN IMMEDIATE`, which takes the database write lock *before* reading. A second writer waits (`busy_timeout`) and then sees the first booking.
2. **Database invariant.** `BEFORE INSERT` triggers reject any overlapping confirmed appointment for the same bay, technician or vehicle, even if a future code path forgets the check. In PostgreSQL this becomes `EXCLUDE USING gist (bay_id WITH =, tstzrange(start_at, end_at) WITH &&) WHERE (status = 'CONFIRMED')`, which also lets multiple app instances book in parallel without a global lock.
3. **Idempotency keys.** A client that times out and retries does not create a second booking. The key is checked inside the locked transaction, and a key reused with a different body is rejected rather than silently returning someone else's booking.

This is verified at two levels: three worker threads with **separate database connections** race for the last slot (exactly one wins), and two real server processes sharing one database file receive parallel HTTP requests, including the same Idempotency-Key on both instances (one 201, one 200, one appointment).

## 5. Technology choices

| Choice | Justification |
|---|---|
| **TypeScript on Node.js 22+/24** | Type safety for the domain model. Node's native type stripping runs `.ts` directly, so there is no build step. |
| **Fastify** | Built-in JSON-schema validation, structured logging (pino) and `inject()` for fast in-process API tests. |
| **SQLite (built-in `node:sqlite`)** for this submission | Real persistent SQL database with transactions, triggers and partial indexes, and **zero installation** for reviewers. |
| **PostgreSQL** for production | Multi-writer concurrency, `EXCLUDE` constraints on time ranges, read replicas, managed offerings (RDS/Aurora). The SQL and service boundaries are kept portable for this swap. |
| **node:test** | Built into Node: no test framework dependency. |
| **OpenAPI 3.1** | Contract for the stubbed frontend and other consumers. |

Runtime dependencies: **one** (`fastify`).

## 6. Non-functional design

- **Scalability.** The service is stateless, so it scales horizontally behind a load balancer once on PostgreSQL. Booking contention is per dealership, so a future option is to shard or partition by `dealership_id`. Availability reads can go to a replica, or be cached per dealership-day and invalidated on booking events.
- **Performance.** Overlap checks hit partial indexes. Booking is one short transaction.
- **Reliability.** Atomic transactions, DB-level invariants, idempotent `POST` and idempotent cancel. Graceful shutdown on SIGTERM. Stable machine-readable error codes let clients react (e.g. suggest another slot on `NO_BAY_AVAILABLE`).
- **Maintainability.** Domain logic is separate from HTTP. Each business rule has a named test. Assumptions are documented above.

## 7. Observability

| Signal | Implementation now | Production |
|---|---|---|
| **Logs** | Structured JSON (pino), one line per request with `reqId`, status and latency. Domain events are logged: `appointment confirmed` with `appointmentId`, and rejections with their error `code`. | Ship to ELK / CloudWatch / Loki. Alert on spikes of `INTERNAL_ERROR`. |
| **Metrics** | `GET /metrics` in Prometheus format: `http_requests_total` and `http_request_duration_ms_sum` by route and status, `appointments_booked_total`, `appointments_cancelled_total`, `booking_conflicts_total{code}`. | Replace hand-rolled counters with `prom-client` histograms. Dashboards for booking rate, conflict ratio (a capacity-shortage signal for the business) and p95 latency. |
| **Tracing** | `x-request-id` is accepted from callers (or generated), echoed in the response and attached to every log line. | OpenTelemetry auto-instrumentation (HTTP + DB spans), with `traceparent` propagation to downstream DMS / notification services. |
| **Health** | `GET /health` checks the DB connection. | Liveness/readiness probes in Kubernetes. |

A rising `booking_conflicts_total{code="NO_TECHNICIAN_AVAILABLE"}` is also a **business** signal: the dealership needs more technicians with that skill.

## 8. Production readiness

The core is production-grade: booking rules, double-booking protection (lock + triggers + idempotency), input validation, stable error codes, structured logs, metrics, health check, graceful shutdown, persistent storage and a container image. What it is **not** yet, in the order I would address it:

| Priority | Gap | Risk today | Plan |
|---|---|---|---|
| **Blocker** | No authentication or authorisation | Anyone can book, cancel any appointment, or read customer names | OAuth2/OIDC at the gateway; roles per dealership (customer, service advisor, admin); customers only see their own vehicles |
| **Blocker** | No rate limiting | A script can fill a week of slots in seconds | Per-client limits at the gateway, plus a per-customer cap on open bookings |
| **Blocker** | No schema migrations | `CREATE TABLE IF NOT EXISTS` does not alter existing tables, so the second schema change breaks deployed databases | Versioned migrations (e.g. node-pg-migrate) run before each release |
| **Blocker** | SQLite is single-host | No multi-host scaling, replicas or point-in-time recovery | PostgreSQL with `EXCLUDE USING gist` constraints (section 4), managed backups |
| High | One global write lock | All dealerships' bookings are serialised; fine for thousands per day, a bottleneck at hundreds of dealerships | Disappears with PostgreSQL row-level locking and exclusion constraints; partition by `dealership_id` if needed |
| High | No technician shifts, breaks or leave | Work can be assigned to someone who is off | `technician_availability` table joined into `freeResources` |
| High | No rescheduling | Cancel-and-rebook can lose the slot to someone else | Atomic `PATCH /appointments/{id}` in one transaction, guarded by `BEFORE UPDATE` triggers / the exclusion constraint |
| Medium | `GET /appointments` is not paginated | Large dealerships get every row at once | Cursor pagination on `(start_at, id)` |
| Medium | Idempotency keys never expire and are global | The table grows forever; two clients could collide on a key | Scope keys per client, expire after 24 h |
| Medium | First-fit allocation | The first technician by id always gets the work | Pick the least-loaded qualified technician for the day |
| Medium | Fixed UTC offsets | Correct for Vietnam, wrong for DST regions such as the UK | Store an IANA zone per dealership |
| Medium | Customer names appear in API responses and could reach logs | Personal-data compliance (GDPR, Vietnam Decree 13) | Field-level access by role, log redaction, retention policy |
| Low | Hand-rolled counters, no latency histograms or tracing | No p95 latency, counters reset on restart | `prom-client` histograms, OpenTelemetry tracing (section 7) |
| Low | `/health` is a single probe | Kubernetes needs separate liveness and readiness | `/health/live` and `/health/ready` (DB check) |
| Low | No load test | Throughput limits are estimated, not measured | k6 scenario against `POST /appointments` in CI |

## 9. Future work

Beyond the production gaps above, product features worth adding:

- Suggest the next available slots when a request conflicts.
- Bay types (EV lift, alignment bay) as a second required capability next to technician skill.
- Outbox pattern publishing `AppointmentConfirmed`/`Cancelled` events for notifications and DMS sync.

### Known testing limits

- Concurrency tests run real parallel requests, but the OS decides the exact interleaving, so they show the guarantees hold under load rather than enumerate every ordering. The guarantee itself rests on the write lock and the triggers, not on the tests.
- The `SLOT_TAKEN` path (a trigger rejecting an insert after the application check passed) cannot be forced without fault injection; the race tests accept it as a valid losing outcome.
- Overlap triggers guard `INSERT` only. No code path updates an appointment's time today; rescheduling must add matching `BEFORE UPDATE` triggers (or the PostgreSQL `EXCLUDE` constraint, which covers both).
- The demo UI and Docker image are verified manually, and there is no load test yet (next step: k6 against `POST /appointments`).

## 10. How GenAI was used in the design phase

> Draft. Edit this section in your own words before submitting; it must describe your real process.

- **Requirement clarification.** I asked the AI to list ambiguities in the three core requirements. That produced the assumptions table (duration per service type, one bay plus one technician, customer = vehicle owner, opening hours, half-open intervals). I then decided which ones to adopt.
- **Risk identification.** I prompted for "what breaks a scheduling system in production". The AI flagged the check-then-insert race condition. I chose a defence-in-depth answer (transaction lock + DB constraint + idempotency) rather than only an application-level check.
- **Technology trade-offs.** I compared PostgreSQL vs. SQLite with the AI. Because Docker was not available locally and reviewers should be able to run the project with one command, we chose SQLite for the submission. I kept the PostgreSQL `EXCLUDE` constraint as the documented production path.
- **Diagrams.** The AI drafted the Mermaid diagrams from the agreed component list. I reviewed them against the code.
