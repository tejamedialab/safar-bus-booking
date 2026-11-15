/**
 * Acceptance 5: operator manifest and occupancy summaries reconcile with confirmed tickets.
 * Plus RBAC (server-side, data-scoped), audit trail and API error contract.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../../src/db/pool.js';
import {
  API,
  asAdmin,
  asDeccanOps,
  asPunjabOps,
  asRavi,
  bearer,
  holdAndBook,
  http,
  makeTrip,
  newPassenger,
} from '../helpers.js';

afterAll(() => closePool());

describe('Acceptance 5 — manifest & occupancy reconcile with confirmed tickets', () => {
  let tripId: string;
  let ops: string;
  beforeAll(async () => {
    tripId = await makeTrip(90);
    ops = await asDeccanOps();
    const p1 = await newPassenger();
    const p2 = await newPassenger();
    const p3 = await newPassenger();
    await holdAndBook(p1.token, tripId, 0, 6, ['L1', 'L2']); // full route, 2 seats
    await holdAndBook(p2.token, tripId, 1, 4, ['L3']); // Ameerpet → Vijayawada
    await holdAndBook(p3.token, tripId, 4, 6, ['L3']); // same seat, Vijayawada → Vizag
    const cancelMe = await holdAndBook(p3.token, tripId, 0, 3, ['U1', 'U2']);
    const u2 = cancelMe.booking.body.data.tickets.find((t: any) => t.seatLabel === 'U2');
    await http().post(`${API}/bookings/${cancelMe.booking.body.data.pnr}/cancel`).set(bearer(p3.token)).send({ ticketIds: [u2.id] });
  });

  it('manifest lists exactly the confirmed tickets, grouped by boarding point', async () => {
    const res = await http().get(`${API}/reports/trips/${tripId}/manifest`).set(bearer(ops));
    expect(res.status).toBe(200);
    const confirmed = await query(`SELECT seat_label, from_stop FROM tickets WHERE trip_id = $1 AND status = 'CONFIRMED'`, [tripId]);
    expect(res.body.data.totalPassengers).toBe(confirmed.length);
    expect(res.body.data.totalPassengers).toBe(5); // L1, L2, L3(1-4), L3(4-6), U1
    expect(res.body.data.passengers.map((p: any) => p.seatLabel).sort()).toEqual(['L1', 'L2', 'L3', 'L3', 'U1']);
    expect(res.body.data.passengers.some((p: any) => p.seatLabel === 'U2')).toBe(false);
    const orders = res.body.data.passengers.map((p: any) => p.fromStop);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('occupancy is computed per leg and matches the tickets', async () => {
    const res = await http().get(`${API}/reports/trips/${tripId}/occupancy`).set(bearer(ops));
    const legs = res.body.data.legs.map((l: any) => l.occupiedSeats);
    //            leg: 0  1  2  3  4  5
    // L1,L2 (0-6):    2  2  2  2  2  2
    // L3 (1-4):          1  1  1
    // L3 (4-6):                   1  1
    // U1 (0-3):       1  1  1
    expect(legs).toEqual([3, 4, 4, 3, 3, 3]);
    expect(res.body.data.peakOccupiedSeats).toBe(4);
    expect(res.body.data.confirmedTickets).toBe(5);
    expect(res.body.data.seatsWithAnyBooking).toBe(4);
  });

  it('reconciliation report passes every check', async () => {
    const res = await http().get(`${API}/reports/trips/${tripId}/reconciliation`).set(bearer(ops));
    expect(res.status).toBe(200);
    expect(res.body.data.reconciled).toBe(true);
    expect(res.body.data.checks.every((c: any) => c.pass)).toBe(true);
    const m = res.body.data.money;
    expect(m.netRevenuePaise).toBe(m.grossBookedPaise - m.refundedPaise);
    expect(m.grossBookedPaise).toBe(m.activeFarePaise + m.cancelledFarePaise);
  });

  it('every seeded trip reconciles too', async () => {
    const admin = await asAdmin();
    const trips = await query(`SELECT DISTINCT trip_id FROM bookings`);
    for (const t of trips) {
      const r = await http().get(`${API}/reports/trips/${t.trip_id}/reconciliation`).set(bearer(admin));
      expect(r.body.data.reconciled, JSON.stringify(r.body.data.checks)).toBe(true);
    }
  });

  it('exports the manifest as CSV with formula-injection protection', async () => {
    const p = await newPassenger();
    await holdAndBook(p.token, tripId, 0, 6, ['U9']);
    await query(`UPDATE tickets SET passenger_name = '=HYPERLINK(evil)' WHERE trip_id = $1 AND seat_label = 'U9'`, [tripId]);
    const res = await http().get(`${API}/reports/trips/${tripId}/manifest`).query({ format: 'csv' }).set(bearer(ops));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toContain('"Seat","Passenger"');
    expect(res.text).toContain(`"'=HYPERLINK(evil)"`);
  });

  it('booking summary totals add up (net = gross − refunds)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const res = await http().get(`${API}/reports/booking-summary`).query({ from: today, to: later, groupBy: 'route' }).set(bearer(ops));
    expect(res.status).toBe(200);
    const t = res.body.data.totals;
    expect(t.netPaise).toBe(t.grossPaise - t.refundPaise);
    expect(t.ticketsSold).toBe(t.ticketsActive + t.ticketsCancelled);
  });
});

describe('Authorization is enforced on the server (not just hidden in the UI)', () => {
  it('anonymous users cannot hold seats or list bookings (401)', async () => {
    const tripId = await makeTrip(48);
    expect((await http().post(`${API}/trips/${tripId}/holds`).send({ fromStop: 0, toStop: 1, seats: ['L1'] })).status).toBe(401);
    expect((await http().get(`${API}/bookings`)).status).toBe(401);
  });

  it('passengers cannot reach staff endpoints (403)', async () => {
    const ravi = await asRavi();
    for (const path of ['/reports/dashboard', '/buses', '/audit-logs', '/refunds', '/staff/trips']) {
      const res = await http().get(`${API}${path}`).set(bearer(ravi));
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('operators cannot create operators (admin only)', async () => {
    const ops = await asDeccanOps();
    const res = await http().post(`${API}/operators`).set(bearer(ops)).send({ name: 'Rogue', code: 'RG', contactEmail: 'x@example.com', contactPhone: '9000000000' });
    expect(res.status).toBe(403);
  });

  it("an operator cannot read another operator's manifest, routes or policy", async () => {
    const deccanTrip = await makeTrip(48);
    const punjab = await asPunjabOps();
    const res = await http().get(`${API}/reports/trips/${deccanTrip}/manifest`).set(bearer(punjab));
    expect(res.status).toBe(403);
    const deccanOps = await asDeccanOps();
    const me = await http().get(`${API}/auth/me`).set(bearer(deccanOps));
    const policy = await http().get(`${API}/operators/${me.body.data.user.operatorId}/cancellation-policy`).set(bearer(punjab));
    expect(policy.status).toBe(403);
    // list endpoints are silently scoped to the operator's own data
    const trips = await http().get(`${API}/staff/trips`).query({ pageSize: 100 }).set(bearer(punjab));
    expect(trips.body.data.every((t: any) => t.operatorName === 'Punjab Highway Coaches')).toBe(true);
  });

  it("a passenger cannot see or cancel another passenger's booking (404, no PNR probing)", async () => {
    const tripId = await makeTrip(48);
    const owner = await newPassenger();
    const { booking } = await holdAndBook(owner.token, tripId, 0, 6, ['L1']);
    const ravi = await asRavi();
    expect((await http().get(`${API}/bookings/${booking.body.data.pnr}`).set(bearer(ravi))).status).toBe(404);
    expect((await http().post(`${API}/bookings/${booking.body.data.pnr}/cancel`).set(bearer(ravi)).send({})).status).toBe(404);
    const mine = await http().get(`${API}/bookings`).set(bearer(ravi));
    expect(mine.body.data.some((b: any) => b.pnr === booking.body.data.pnr)).toBe(false);
  });

  it('a forged/expired token is treated as anonymous', async () => {
    const res = await http().get(`${API}/auth/me`).set(bearer('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad'));
    expect(res.status).toBe(401);
  });

  it('login does not reveal whether an email exists', async () => {
    const a = await http().post(`${API}/auth/login`).send({ email: 'nobody@example.com', password: 'whatever1' });
    const b = await http().post(`${API}/auth/login`).send({ email: 'ravi@example.com', password: 'wrong-pass1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('registration validates input and rejects duplicate emails', async () => {
    const bad = await http().post(`${API}/auth/register`).send({ fullName: 'X', email: 'not-an-email', phone: '123', password: 'short' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.length).toBeGreaterThanOrEqual(4);
    const dup = await http().post(`${API}/auth/register`).send({ fullName: 'Ravi Again', email: 'ravi@example.com', phone: '9876500001', password: 'Passw0rd!x' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  });
});

describe('Audit trail', () => {
  it('records material actions and cannot be edited or deleted', async () => {
    const admin = await asAdmin();
    const res = await http().get(`${API}/audit-logs`).query({ action: 'BOOKING_CONFIRMED', pageSize: 5 }).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.total).toBeGreaterThan(0);
    await expect(query(`UPDATE audit_logs SET action = 'TAMPERED'`)).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('operators only see their own audit entries', async () => {
    const punjab = await asPunjabOps();
    const me = await http().get(`${API}/auth/me`).set(bearer(punjab));
    const res = await http().get(`${API}/audit-logs`).query({ pageSize: 100 }).set(bearer(punjab));
    const opIds = await query(`SELECT DISTINCT operator_id FROM audit_logs WHERE id = ANY($1)`, [res.body.data.map((r: any) => r.id)]);
    expect(opIds.map((o: any) => o.operator_id)).toEqual([me.body.data.user.operatorId]);
  });
});

describe('API error contract', () => {
  it('malformed JSON → 400 MALFORMED_JSON with requestId', async () => {
    const ravi = await asRavi();
    const res = await http().post(`${API}/bookings`).set(bearer(ravi)).set('Content-Type', 'application/json').set('Idempotency-Key', 'abcdefgh123').send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'MALFORMED_JSON' });
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });
  it('unknown route → 404 ROUTE_NOT_FOUND; unknown id → 404 NOT_FOUND; bad uuid → 400', async () => {
    expect((await http().get(`${API}/nope`)).body.error.code).toBe('ROUTE_NOT_FOUND');
    expect((await http().get(`${API}/trips/00000000-0000-0000-0000-000000000000`)).body.error.code).toBe('NOT_FOUND');
    expect((await http().get(`${API}/trips/not-a-uuid`)).status).toBe(400);
  });
  it('serves an OpenAPI document generated from the validation schemas', async () => {
    const res = await http().get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(['/bookings', '/search', '/trips/{tripId}/holds']));
  });
});
