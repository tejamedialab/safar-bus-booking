# Safar — Bus Booking Management System

Full-stack web application for an intercity bus business: operators set up fleet, routes, schedules and fares; passengers search, pick seats and book **for any stretch of a route**; staff run manifests, occupancy, refunds and reports — with seat integrity guaranteed by the database, not just the UI.

> **Live demo:** https://safar-bus-booking-c7n1.onrender.com · **API docs:** https://safar-bus-booking-c7n1.onrender.com/api/docs (free tier — first load after idle can take ~50 s)
>
> **Candidate:** Eslavath Kalyan · **Reg. no.:** 12302317 · **Role:** Full-Stack Web Development · **Project:** Bus Booking Management System

![Search](docs/screenshots/01-home.png)

---

## What makes this implementation different

| | |
|---|---|
| **Stop-to-stop seat inventory** | A seat sold Hyderabad → Vijayawada is still sellable Vijayawada → Visakhapatnam. Availability, pricing, manifests and occupancy are all segment-aware. |
| **Database-enforced seat integrity** | A PostgreSQL **exclusion constraint** (`tickets_no_double_booking`) makes two CONFIRMED tickets for the same seat on overlapping segments impossible — even if application code is bypassed. Proven by a test that does a raw `INSERT`. |
| **Three layers against races & retries** | 10-minute **seat holds** (stale availability) → **exclusion constraints** (simultaneous requests) → **Idempotency-Key** on booking (double-clicks, network retries). 20 parallel users on one seat → exactly 1 wins. |
| **Policy snapshot** | Each booking stores the cancellation tiers in force when it was made; an operator editing the policy later never changes existing tickets. |
| **Self-reconciling reports** | The trip reconciliation report re-derives manifest, occupancy, money and statuses from independent queries and shows ✓/✕ per check (acceptance test 5). |
| **Server-side, data-scoped RBAC** | ADMIN / OPERATOR / PASSENGER enforced in middleware *and* per row: an operator can never read another operator's manifest; a passenger gets 404 (not 403) for someone else's PNR. |
| **Append-only audit trail** | Written in the same transaction as each business change; a DB trigger rejects any `UPDATE`/`DELETE`. |

## Tech stack

- **Frontend:** React 18, TypeScript, Vite, TanStack Query, React Router — hand-written CSS design system (no UI kit)
- **Backend:** Node.js 20+, Express 5, TypeScript, Zod validation, `pg` (plain SQL, no ORM), pino logging, helmet, rate limiting
- **Database:** PostgreSQL 16 (`btree_gist` for exclusion constraints)
- **API docs:** OpenAPI 3 generated from the same Zod schemas used for validation → Swagger UI at `/api/docs`
- **Tests:** Vitest + Supertest against a real PostgreSQL test database (62 tests)
- **Ops:** Dockerfile, docker-compose, GitHub Actions CI, Render free-tier blueprint

## Architecture

Modular monolith with strict layering: **HTTP (routes.ts) → services (business rules, transactions) → PostgreSQL**, plus a `domain/` folder of pure functions (pricing, cancellation tiers, state machines, PNR, layout generator) that are unit-tested without a database.

![Architecture](docs/architecture.png)

```
server/src/
  routes.ts                 every endpoint + its role requirement, in one file
  middleware/               auth (session → user), RBAC, request id, error shape
  domain/                   pure business rules (no I/O)
  modules/
    inventory/              search, seat map, seat holds
    bookings/               confirm (idempotent), cancel, refunds
    network/                cities, routes, stops, schedules, trip generation, trip status
    fleet/                  operators, staff, seat layouts, buses, cancellation policy
    reports/                dashboard, manifest (+CSV), occupancy, reconciliation, summaries
    audit/                  audit writer + query
  db/migrations/            SQL migrations (schema, constraints, triggers)
  db/seed.ts                demo data created THROUGH the services
  openapi/                  OpenAPI generated from Zod
server/test/                unit + API/integration tests
client/src/                 React app (passenger pages + operations console)
docs/                       ER diagram, architecture, OpenAPI, report, test evidence, screenshots
```

ER diagram: [`docs/er-diagram.svg`](docs/er-diagram.svg) (source: `docs/er-diagram.mmd`).

## Run it locally

**Prerequisites:** Node.js 20+, PostgreSQL 14+ (or Docker).

### Option A — Docker (one command)
```bash
docker compose up --build
# open http://localhost:4000      (API docs: http://localhost:4000/api/docs)
```
The app migrates and seeds demo data automatically on first start.

### Option B — Node + local PostgreSQL
```bash
npm install                              # installs server + client (npm workspaces)
cp .env.example server/.env              # edit DATABASE_URL if your Postgres differs
createdb safar                           # or: psql -c "create database safar"
npm run db:reset                         # drop → migrate → seed demo data
npm run dev                              # API :4000 + UI :5173
# open http://localhost:5173
```

### Database commands
| Command | What it does |
|---|---|
| `npm run db:migrate` | Applies new SQL migrations (tracked in `schema_migrations`, advisory-locked) |
| `npm run db:seed` | Seeds demo data if the DB is empty |
| `npm run db:reset` | Drops everything, migrates, seeds (repeatable) |

### Tests
```bash
createdb safar_test                      # once; the suite rebuilds it on every run
npm test                                 # 62 tests: unit + API/integration + concurrency
npm run typecheck
```
Latest run: [`docs/test-evidence.txt`](docs/test-evidence.txt) — **62 passed, 0 failed**.

### Production build
```bash
npm run build && npm start               # one Node process serves API + built UI on :4000
```

## Demo credentials (dummy data only)

| Role | Email | Password |
|---|---|---|
| Admin | `admin@safar.dev` | `Admin@12345` |
| Operator (Deccan Starliner) | `ops.deccan@safar.dev` | `Operator@12345` |
| Operator (Punjab Highway Coaches) | `ops.punjab@safar.dev` | `Operator@12345` |
| Operator (Coromandel Coachways) | `ops.coromandel@safar.dev` | `Operator@12345` |
| Passenger | `ravi@example.com` (also `priya@`, `arjun@`, `meera@`, `harpreet@`) | `Passenger@12345` |

The login page has one-click buttons for these. Operators, phone numbers and passengers are fictional.

## Environment variables

See [`.env.example`](.env.example). All are validated at startup (the app refuses to boot with a bad config, and refuses the default JWT secret in production).

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/safar` | App database |
| `TEST_DATABASE_URL` | `…/safar_test` | Test database (rebuilt by the suite) |
| `DATABASE_SSL` | `false` | `true` for hosted Postgres (Neon) |
| `JWT_SECRET` | dev value | Session signing key — **required in production** |
| `JWT_TTL_HOURS` | `12` | Session length |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed browser origin(s) |
| `HOLD_TTL_SECONDS` | `600` | Seat hold duration |
| `BOOKING_CUTOFF_MINUTES` | `30` | Booking closes this long before boarding |
| `MAX_SEATS_PER_BOOKING` | `6` | Seats per booking |
| `SEED_ON_EMPTY` | `false` | Seed demo data on boot if DB is empty (demo deploys) |

## Acceptance tests → where they are proven

| # | Acceptance criterion | Automated test | Manual demo |
|---|---|---|---|
| 1 | Search a valid trip and book an available seat | `booking-flow.test.ts › runs the complete passenger journey` | Home → Find buses → Choose seats → Hold → Confirm |
| 2 | Two users cannot confirm the same seat | `concurrency.test.ts` (20-user hold race, 10-user full-flow race, raw-INSERT DB guard, idempotency) | Hold a seat as Ravi, try it as Priya in another browser |
| 3 | PNR has correct passenger, route, date, seat | `booking-flow.test.ts` (asserts every field on the PNR) | Ticket page |
| 4 | Cancellation changes availability + refund per rule | `cancellation.test.ts` (75%/90% tiers, partial, closed window, snapshot, trip cancel) | Ticket → Cancel tickets → refund quote → seat free again |
| 5 | Manifest & occupancy reconcile with confirmed tickets | `reports-and-security.test.ts › Acceptance 5` (+ every seeded trip) | Operations → Trips → Reconciliation tab |

## API

- Interactive docs: **`/api/docs`** · raw spec: `/api/openapi.json` · committed copy: [`docs/openapi.json`](docs/openapi.json)
- Base path `/api/v1`. Errors are always `{ "error": { "code", "message", "details?", "requestId" } }`.
- Money is integer **paise**; times are ISO-8601 UTC; the business timezone is Asia/Kolkata.

## Deploying for free

`render.yaml` deploys the single service on Render's free plan; pair it with a free **Neon** Postgres (`DATABASE_URL` = Neon string, `DATABASE_SSL=true`). `SEED_ON_EMPTY=true` loads demo data on first boot. No paid services are used. (Free instances sleep when idle; the first request can take ~30 s.)

## Known limitations & assumptions (honest list)

- **Payments and refund payouts are simulated.** Booking confirms immediately with a `SIMPAY-…` reference; staff mark refunds paid/failed to simulate the gateway.
- **No email/SMS.** The e-ticket is the ticket page (printable, with QR code).
- **Single business timezone (IST).** Service dates and search dates are interpreted in Asia/Kolkata.
- **Expired seat holds are cleaned lazily** (ignored by every availability query, purged on the next hold for that trip) rather than by a background job.
- **Route stops are immutable after creation** (bookings refer to stop numbers); to change a route, create a new one and deactivate the old.
- **Seed data creates trips for the next 21 days** from the seeding date; generate more under *Routes & schedules → Generate trips*. The 14-day dashboard trend starts on the seeding date.
- **Rate limiting is in-memory** (per instance) — fine for one instance, would need Redis for several.
- **No password reset / email verification**; staff accounts are created by an admin or operator.
- **Browser e2e** was run with Playwright locally (screenshots in `docs/screenshots`) but is not part of CI; CI runs typecheck, all API/unit tests and the build.
- Fares are per stop-to-stop distance with trip multiplier and per-seat factor; no dynamic pricing, coupons, or ladies-seat adjacency rules.

## AI usage & attribution

AI assistance (Claude by Anthropic) was used for scaffolding, code generation, test writing and documentation drafts. Design decisions are documented in [`docs/TECHNICAL_REPORT.md`](docs/TECHNICAL_REPORT.md) and I can explain and modify every part of the code.
Open-source libraries: React, Vite, TanStack Query, React Router, Express, Zod, zod-to-openapi, swagger-ui-express, node-postgres, bcryptjs, jsonwebtoken, helmet, pino, qrcode, Vitest, Supertest (all MIT/ISC/Apache-2.0). Font: Overpass (SIL Open Font License). No external datasets; all data is fictional.
