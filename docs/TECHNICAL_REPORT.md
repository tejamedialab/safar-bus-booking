# Safar — Technical Report

**Bus Booking Management System** · Eslavath Kalyan (12302317) · Full-Stack Web Development

This report explains the key design decisions, the reasoning behind them, and the trade-offs I accepted.

---

## 1. Problem framing

A bus booking business has two kinds of users with opposite needs:

- **Passengers** want to find a bus, choose a seat, and trust that the seat is really theirs.
- **Operators** want their fleet, routes and timetables in one place, and numbers (manifests, occupancy, revenue) they can trust.

The hard part is not CRUD — it is **correctness under concurrency** (two people clicking the same seat), **state transitions** (bookings, refunds and trips changing status legally), and **reports that agree with each other**. I spent most of the design effort there.

### The domain decision that shaped everything: stop-to-stop inventory

Real Indian intercity buses stop in several cities. A passenger boarding at Ameerpet (Hyderabad) and getting off at Benz Circle (Vijayawada) only uses part of the route, so the same berth can be resold from Vijayawada to Visakhapatnam. Modelling this correctly means a ticket occupies a **segment** `[fromStop, toStop)`, not the whole trip.

- Two tickets conflict only if they are for the **same trip, same seat, and overlapping segments**.
- Price = `cumulativeFare[to] − cumulativeFare[from]`, × trip multiplier, × seat factor (e.g. lower berths +10%).
- Availability, manifest and occupancy are all computed per segment.

This makes the system closer to how redBus/IRCTC actually work, and it is a much stronger test of the integrity design than "one seat = one booking".

---

## 2. Architecture

**Modular monolith** (as the brief recommends), with three layers:

| Layer | Where | Responsibility |
|---|---|---|
| HTTP | `server/src/routes.ts`, `middleware/` | Parse & validate input (Zod), authenticate, enforce role, shape responses/errors |
| Business logic | `server/src/modules/*/*.service.ts`, `server/src/domain/` | Rules, state transitions, transactions, authorization by ownership |
| Persistence | PostgreSQL via `pg`, `db/migrations/*.sql` | Schema, constraints, exclusion constraints, triggers |

Why these choices:

- **Plain SQL with `pg` instead of an ORM.** The core guarantees (exclusion constraints, `FOR UPDATE`/`FOR SHARE`, savepoints, `int4range`) are PostgreSQL features. Writing SQL directly keeps them visible and explainable; an ORM would hide exactly the parts that matter.
- **`domain/` is pure.** Pricing, cancellation tiers, state machines, PNR generation and the seat-layout generator have no I/O, so they are unit-tested exhaustively in milliseconds.
- **One `routes.ts`.** Every endpoint and its role requirement is visible in one file — easy for a reviewer to audit authorization.
- **OpenAPI generated from the same Zod schemas** used for validation, so documentation cannot drift from behaviour.
- **One deployable.** In production the Express server also serves the built React app — a single free-tier service with no CORS complexity.

---

## 3. Data model

ER diagram: `docs/er-diagram.svg`. Key tables and the rule each one enforces:

| Table | Notable constraints |
|---|---|
| `users` | `CHECK ((role = 'OPERATOR') = (operator_id IS NOT NULL))` — staff always belong to exactly one operator |
| `layout_seats` | PK `(layout_id, label)`; unique grid position per deck |
| `route_stops` | PK `(route_id, stop_order)`; cumulative distance/fare per stop; `departure ≥ arrival` |
| `trips` | `UNIQUE (schedule_id, service_date)` so trip generation is idempotent; **`EXCLUDE (bus_id =, tstzrange(departs_at, arrives_at) &&)`** — one bus can never run two overlapping trips |
| `seat_holds` | **`EXCLUDE (trip_id =, seat_label =, segment &&)`** |
| `bookings` | `UNIQUE pnr`; **`UNIQUE hold_token`** (a hold converts to a booking at most once); `policy_snapshot jsonb` |
| `tickets` | **`EXCLUDE (trip_id =, seat_label =, segment &&) WHERE status = 'CONFIRMED'`**; composite FKs guarantee the seat exists *in this trip's layout*; `CHECK (status='CANCELLED') = (cancelled_at IS NOT NULL)` |
| `idempotency_keys` | PK `(user_id, key)`; stores request hash + response |
| `audit_logs` | Trigger rejects `UPDATE`/`DELETE` (append-only) |

Other decisions:

- **Money in integer paise** — no floating-point rounding in totals or refunds. Refunds round *down* per ticket so we never refund more than the rule allows.
- **Trips snapshot** the bus's seat layout and the schedule's fare multiplier, so later fleet/fare edits do not alter sold trips.
- **Schedules vs trips.** A schedule is the recurring timetable ("21:00 daily"); trips are concrete dated runs generated from it. Bookings attach to trips.
- **Migrations** are plain SQL files applied in order by a ~50-line runner that records them in `schema_migrations` and takes a Postgres advisory lock so two instances cannot migrate at once. `npm run db:reset` makes the whole database reproducible.

---

## 4. Seat integrity — the core of the system

The brief asks to protect against **stale availability, duplicate requests, and simultaneous requests**. Each is handled by a different mechanism, and they are layered so that any single failure is still caught by the next.

```
Passenger picks seats ──► POST /trips/:id/holds ──► POST /bookings (Idempotency-Key)
                             │                          │
                             ├ trip locked FOR SHARE    ├ idempotency row inserted first
                             ├ purge expired holds      ├ hold rows locked FOR UPDATE
                             ├ reject confirmed seats   ├ hold must be mine and unexpired
                             └ INSERT holds ◄─ EXCLUDE  ├ trip FOR SHARE, still bookable
                                                        ├ INSERT tickets ◄─ EXCLUDE (final guard)
                                                        └ delete holds, audit, store response
```

1. **Stale availability → seat holds.** Selecting seats creates a 10-minute hold. Other users see the seat as "on hold"; the seat map refreshes every 15 s; expired holds are ignored by every query and purged on the next hold.
2. **Simultaneous requests → exclusion constraints.** Two users racing for the same seat both pass the application checks, but only one `INSERT` can succeed; Postgres raises `23P01` for the other, which we map to `409 SEAT_UNAVAILABLE`. This is atomic inside the database — no application lock, no race window.
3. **Duplicate requests → Idempotency-Key.** The client generates one key per checkout (kept in `sessionStorage`, so even a page refresh reuses it). The server inserts `(user, key)` *first* in the transaction. A concurrent duplicate blocks on that unique key until the first transaction commits, then replays the stored `201` response (`Idempotent-Replayed: true`). Same key with a different body → `422`.
4. **The final guard is the database.** `concurrency.test.ts` deliberately creates a *stale hold* for a seat that is already confirmed (simulating a bug in the hold logic) and shows the booking is still rejected, then does a raw SQL `INSERT` and shows Postgres rejects it.

**Trip status vs bookings.** Booking takes `FOR SHARE` on the trip; changing trip status takes `FOR UPDATE`. So a booking can never slip in while an operator is cancelling the trip, and many bookings can still proceed in parallel.

---

## 5. State machines & business rules

```
Trip:     SCHEDULED ──► DEPARTED ──► COMPLETED          Refund:  PENDING ──► PROCESSED
              └───────► CANCELLED                                   └──────► FAILED ──► PENDING (retry)
Booking:  CONFIRMED ──► PARTIALLY_CANCELLED ──► CANCELLED      (derived from its tickets)
```

Transitions live in `domain/state-machines.ts`; anything else returns `409 INVALID_TRANSITION`. Extra guards: a trip can be marked departed at most 60 minutes before departure; cancelling a trip requires a reason and refunds every active ticket 100%; booking closes 30 minutes before boarding.

**Cancellation rule (configurable per operator).** Tiers like *≥48 h → 90%, ≥24 h → 75%, ≥12 h → 50%, ≥3 h → 25%, below that not cancellable*. Validated so thresholds are unique and refunds never *increase* as departure approaches. Measured from the passenger's **boarding time**, not the trip origin. The rules are **snapshotted into the booking**, so editing the policy later is fair to existing customers (tested). Partial cancellation is supported; two simultaneous cancel clicks produce exactly one refund (booking row `FOR UPDATE`).

**PNR.** Operator prefix + 8 characters from a 31-symbol alphabet without ambiguous characters (no 0/O/1/I/L) — random, so PNRs cannot be guessed sequentially; unique index + retry on collision.

---

## 6. Security

- **Authentication:** bcrypt password hashes; JWT in an **httpOnly, SameSite=Lax** cookie (Bearer also accepted for API clients). The user is re-loaded from the DB on every request, so deactivation or role changes apply immediately — the token proves identity, never permissions.
- **Authorization:** role gates in `routes.ts` (`requireAuth`, `requireStaff`, `requireRole('ADMIN')`) **plus** data scoping in services (`assertOperatorAccess`, `operatorScope`). List endpoints silently filter to the operator's own data. Passengers get **404** for others' bookings so PNRs cannot be probed.
- **Input:** every body/query/param is validated with Zod; errors return per-field messages. JSON body size capped at 100 kB.
- **Login hardening:** rate limiting; identical error and constant-time comparison whether or not the email exists (no user enumeration).
- **Headers:** helmet with a CSP; `x-powered-by` disabled.
- **CSV export** neutralises spreadsheet formula injection (`=`, `+`, `-`, `@`).
- **Secrets:** only `.env.example` is committed; config is validated at boot and production refuses the default JWT secret. All demo data is fictional.

---

## 7. Reporting

- **Dashboard:** bookings & value today, trips and load factor for the next 7 days, refunds waiting, 14-day trend, top routes, next departures.
- **Manifest** (confirmed tickets only, grouped by boarding point, CSV/print).
- **Occupancy by leg** (segment-aware) and **seat-km utilisation**.
- **Reconciliation:** six independent checks — manifest = confirmed tickets; Σ occupied seat-legs = Σ ticket legs; zero double-bookings; Σ booking totals = Σ ticket fares; booking statuses agree with tickets; refunds ≤ cancelled fares — plus a money summary (gross, refunds, net).
- **Booking summary** by travel date or route; **route timetable** report.
- **Audit trail** with filters; every material action (holds, bookings, cancellations, refunds, trip status, policy changes, fleet/network changes) is written in the same transaction as the change.

---

## 8. Testing strategy

62 automated tests, run against a real PostgreSQL database rebuilt from migrations + seed on every run (`docs/test-evidence.txt`):

| File | Focus |
|---|---|
| `unit/domain.test.ts` | pricing, every cancellation tier boundary, policy validation, state machines, PNR format/uniqueness, layout generator |
| `api/booking-flow.test.ts` | Acceptance 1 & 3; segment re-sale; validation errors; seat mismatch |
| `api/concurrency.test.ts` | Acceptance 2: 20-user hold race, 10-user full-flow race, stale-hold + raw INSERT guard, idempotent replay ×10, key reuse 422, hold reuse, expired hold 410, someone else's hold 403 |
| `api/cancellation.test.ts` | Acceptance 4: 75%/90% tiers, partial cancel, concurrent cancel, closed window, policy snapshot, refund state machine, trip cancellation, illegal transitions, booking cutoff |
| `api/reports-and-security.test.ts` | Acceptance 5 (incl. every seeded trip), CSV injection, summary totals, RBAC (401/403/404 cases), forged token, user enumeration, audit immutability & scoping, error contract, OpenAPI |

Tests that need precise times (e.g. "30 hours before departure") create fixture trips on a private copy of a route, so they never interfere with search tests. The suite was run three times in a row to check for flakiness. A Playwright click-through of the full passenger and operator journeys (desktop, mobile 390 px, dark mode) produced the screenshots in `docs/screenshots`.

---

## 9. UI/UX

- Visual identity taken from **Indian national-highway signage**: NH-green signboard search panel, white reflective border, amber for "in progress" (selected/held seats, hold timer), Overpass typeface (derived from Highway Gothic). The ticket is designed as a printed stub with a perforated edge and QR code.
- Every data view has loading (skeleton), empty, error (with error code and request reference) and success states.
- Accessible: semantic forms with labels, inline field errors from server validation, `aria-pressed` seat buttons with full spoken descriptions, visible focus ring, keyboard-usable dialogs, reduced-motion respected, light/dark themes, responsive down to 390 px.
- Honest UX for concurrency: hold countdown, automatic deselection of seats taken by others, clear recovery links on `409/410`.

---

## 10. Trade-offs and what I would do next

| Decision | Trade-off | Next step |
|---|---|---|
| Lazy hold cleanup | Expired rows linger until next hold (harmless — every query filters `expires_at > now()`) | Small scheduled job, or `pg_cron` |
| In-memory rate limiter | Per-instance only | Redis store when scaling horizontally |
| Simulated payments | No real gateway flow | Razorpay test mode: create order on hold, confirm booking on verified webhook (idempotency key already in place) |
| Route stops immutable | Changing a route means a new route | Versioned routes |
| IST only | Not multi-timezone | Store timezone per route |
| Polling seat map (15 s) | Slight staleness (protected by holds anyway) | Server-sent events for live seat updates |
