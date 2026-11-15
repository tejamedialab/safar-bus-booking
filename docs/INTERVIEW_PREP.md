# Interview prep — 15-min walkthrough + 10-min live change

Read this the day before. The goal: you can explain **why** every important line exists, and change it live without panic.

## 1. Your 60-second pitch

> "Safar is a bus booking system built as a modular monolith: React frontend, Express + TypeScript API, PostgreSQL. The interesting part is that tickets are booked **stop to stop** — a seat sold Hyderabad to Vijayawada can be resold Vijayawada to Vizag. So a ticket covers a *segment*, and I let PostgreSQL enforce that no two confirmed tickets for the same seat have overlapping segments, using an **exclusion constraint**. On top of that I have seat holds for stale availability and an idempotency key for duplicate requests. The operator side has manifests, segment-wise occupancy, and a reconciliation report that cross-checks everything. There are 62 tests including real concurrency races."

## 2. Questions you WILL be asked — and your answers

**Q: How do you stop two users booking the same seat?**
Three layers. (1) Hold: 10-minute hold, exclusion constraint on `seat_holds`. (2) The real guarantee: `tickets_no_double_booking` — `EXCLUDE USING gist (trip_id WITH =, seat_label WITH =, segment WITH &&) WHERE (status = 'CONFIRMED')`. Postgres checks it atomically, so even two transactions at the same microsecond can't both insert. The loser gets error `23P01`, mapped to `409 SEAT_UNAVAILABLE`. (3) Idempotency key for the *same* user retrying. Show `concurrency.test.ts` — 20 users, 1 winner.

**Q: Why not just `SELECT` to check then `INSERT`?**
Check-then-insert has a race window: both requests read "free", both insert. A unique/exclusion constraint closes that window inside the database.

**Q: Why an exclusion constraint and not a unique index?**
Unique works for "same seat, same trip". But with segments, `L1 [1,4)` and `L1 [4,6)` must both be allowed while `L1 [3,5)` must be rejected. "Overlaps" (`&&`) isn't equality, so a unique index can't express it. `btree_gist` lets GiST combine `=` on uuid/text with `&&` on ranges.

**Q: What's `int4range(from, to)`?** A half-open range `[from, to)`. `[1,4)` and `[4,6)` touch but don't overlap — exactly right because you get off at stop 4 and someone else boards there.

**Q: How does idempotency work?**
Client sends `Idempotency-Key` (one per checkout, saved in sessionStorage). First thing in the transaction: `INSERT INTO idempotency_keys … ON CONFLICT DO NOTHING`. A concurrent duplicate *waits* on that unique key until the first transaction commits, then reads the stored response and returns it. If the body differs → 422. If the first request failed, its transaction rolled back, so the key row disappears and a retry runs normally.

**Q: What happens when the hold expires?** `POST /bookings` locks the hold rows `FOR UPDATE`, sees `expires_at <= now()` → `410 HOLD_EXPIRED`. Another user's hold request deletes expired holds first, so the seat is free for them.

**Q: Why FOR SHARE on the trip?** Many bookings can share-lock the trip in parallel; an operator cancelling the trip needs `FOR UPDATE`, which waits for them (and they wait for it). So nobody books a trip mid-cancellation.

**Q: How is RBAC enforced on the server?** Two levels. Route level: `requireStaff` / `requireRole('ADMIN')` in `routes.ts`. Data level: `assertOperatorAccess(actor, operatorId)` and `operatorScope(actor)` in services — operator staff only see their own operator's rows. Passengers get 404 for others' PNRs. The user is reloaded from DB on every request.

**Q: Why store the policy on the booking?** Fairness and auditability: a customer who booked under "75% refund at 24 h" keeps it even if the operator tightens the policy tomorrow. Test: `uses the policy snapshot…`.

**Q: Why paise integers?** Floats can't represent 0.1 exactly; money must add up. Refunds use `Math.floor` so we never over-refund.

**Q: How do you know reports are correct?** Reconciliation computes each number from a different query (manifest vs raw tickets vs per-leg occupancy vs booking totals vs refunds) and checks they agree. The test runs it on every seeded trip.

**Q: Why no ORM?** The guarantees are Postgres features (exclusion constraints, row locks, savepoints, ranges). Plain SQL keeps them visible; I can explain every query.

**Q: What would you change for production?** Real payment gateway (Razorpay test mode, confirm on webhook — the idempotency key fits naturally), Redis rate limiting, background job for hold cleanup, SSE for live seat map, versioned routes.

**Q: Where did you use AI?** Be honest and specific: scaffolding, boilerplate, tests and docs drafts; I reviewed, ran and debugged it (e.g. the refund SQL type bug, the test fixture isolation, the auth cache bug in the UI). *Only say what is true.*

## 3. Map of the code (memorise this)

| I want to show… | Open |
|---|---|
| All endpoints + roles | `server/src/routes.ts` |
| Schema & constraints | `server/src/db/migrations/001_init.sql` |
| Booking transaction | `server/src/modules/bookings/bookings.service.ts → createBooking` |
| Hold logic | `server/src/modules/inventory/inventory.service.ts → createHold` |
| Search SQL | `inventory.service.ts → searchTrips` |
| Cancellation rule | `server/src/domain/cancellation.ts` + `cancelBooking` |
| Trip status | `server/src/domain/state-machines.ts` + `network.service.ts → changeTripStatus` |
| Reconciliation | `server/src/modules/reports/reports.service.ts → getReconciliation` |
| Error format | `server/src/middleware/errors.ts` |
| Seat map UI | `client/src/pages/Booking.tsx → SeatDeck` |
| Concurrency tests | `server/test/api/concurrency.test.ts` |

## 4. Practise these live changes (likely "10-minute task" types)

Do each once before the interview, run `npm test`, then `git checkout .`.

1. **Change hold time to 5 minutes** → `.env`: `HOLD_TTL_SECONDS=300` (no code change — explain config validation in `config/env.ts`).
2. **Add a rule: max 4 seats per booking** → `MAX_SEATS_PER_BOOKING=4`; show the 400 when holding 5.
3. **Add a field "emergency contact" to booking** → new migration `002_emergency_contact.sql` (`ALTER TABLE bookings ADD COLUMN emergency_phone text`), add to `CreateBookingBody` Zod schema, insert in `insertBookingWithUniquePnr`, return in `getBookingDetail`, add input in `CheckoutPage`. Never edit `001_init.sql` — always a new migration.
4. **New cancellation tier** → Operations → Cancellation policy (UI) or `PUT /operators/:id/cancellation-policy`. Explain the snapshot.
5. **Add a filter "only AC buses" to search** → `SearchQuery` add `ac: z.enum(['true','false']).optional()`, SQL `AND ($8::boolean IS NULL OR bu.bus_type IN ('AC_SLEEPER','AC_SEATER','VOLVO_MULTI_AXLE') = $8)`, add a chip in `SearchPage`.
6. **Bug hunt** — if they break something, read the error `code` and `requestId`, then the server log. Run one test file: `npx vitest run test/api/cancellation.test.ts -t "75%"`.
7. **New report column** (e.g. average fare) → add `round(avg(tk.fare_paise))` in `getBookingSummary` and a `<td>` in `ReportsPage`.

## 5. Demo order for the walkthrough (15 min)

1. (1 min) Pitch + architecture diagram.
2. (4 min) Passenger: search Hyderabad → Vijayawada, change boarding point, pick 2 berths, show hold timer, try confirm with empty form (validation), confirm, ticket with QR.
3. (2 min) Concurrency: second browser (incognito) as Priya — the held seat shows "on hold"; mention the test numbers. Run `npm test` live if allowed (≈6 s).
4. (2 min) Cancel one ticket → refund quote → seat free again.
5. (4 min) Operator: dashboard → trip → manifest (CSV) → occupancy by leg (show segment re-sale) → reconciliation ✓ → refunds mark paid → audit trail.
6. (2 min) Swagger `/api/docs`, migration file, honest limitations.
