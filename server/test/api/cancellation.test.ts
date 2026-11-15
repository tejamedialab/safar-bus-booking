/**
 * Acceptance 4: cancellation changes seat availability and refund status according to the rule.
 * Plus: partial cancellation, closed window, policy snapshot, refund state machine, trip cancellation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../../src/db/pool.js';
import { API, asAdmin, asDeccanOps, bearer, holdAndBook, http, makeTrip, newPassenger } from '../helpers.js';

afterAll(() => closePool());

const seatStatus = async (tripId: string, from: number, to: number, label: string) =>
  (await http().get(`${API}/trips/${tripId}/seats`).query({ from, to })).body.data.seats.find((s: any) => s.label === label).status;

describe('Acceptance 4 — cancellation, refund rule and seat release', () => {
  it('30h before departure → 75% tier: refund PENDING for 75%, seat becomes AVAILABLE again', async () => {
    const tripId = await makeTrip(30);
    const p = await newPassenger();
    const { booking } = await holdAndBook(p.token, tripId, 0, 6, ['L1', 'L2']);
    expect(booking.status).toBe(201);
    const pnr = booking.body.data.pnr;
    const total = booking.body.data.totalFarePaise;
    expect(await seatStatus(tripId, 0, 6, 'L1')).toBe('BOOKED');

    const quote = await http().get(`${API}/bookings/${pnr}/cancellation-quote`).set(bearer(p.token));
    expect(quote.body.data).toMatchObject({ allowed: true, refundPercent: 75, totalRefundPaise: Math.floor(total * 0.75) });

    const res = await http().post(`${API}/bookings/${pnr}/cancel`).set(bearer(p.token)).send({ reason: 'Plans changed' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(res.body.data.tickets.every((t: any) => t.status === 'CANCELLED')).toBe(true);
    expect(res.body.data.refunds).toHaveLength(1);
    expect(res.body.data.refunds[0]).toMatchObject({ status: 'PENDING', percent: 75, reason: 'PASSENGER_CANCELLATION' });
    // per-ticket floor rounding
    const expected = booking.body.data.tickets.reduce((a: number, t: any) => a + Math.floor((t.farePaise * 75) / 100), 0);
    expect(res.body.data.refunds[0].amountPaise).toBe(expected);

    expect(await seatStatus(tripId, 0, 6, 'L1')).toBe('AVAILABLE');
    const someoneElse = await newPassenger();
    const rebook = await holdAndBook(someoneElse.token, tripId, 0, 6, ['L1']);
    expect(rebook.booking.status).toBe(201);
  });

  it('60h before departure → 90% tier', async () => {
    const tripId = await makeTrip(60);
    const p = await newPassenger();
    const { booking } = await holdAndBook(p.token, tripId, 0, 6, ['U1']);
    const res = await http().post(`${API}/bookings/${booking.body.data.pnr}/cancel`).set(bearer(p.token)).send({});
    expect(res.body.data.refunds[0].percent).toBe(90);
  });

  it('partial cancellation cancels only the chosen ticket and marks the booking PARTIALLY_CANCELLED', async () => {
    const tripId = await makeTrip(50);
    const p = await newPassenger();
    const { booking } = await holdAndBook(p.token, tripId, 0, 6, ['L4', 'L5', 'L6']);
    const target = booking.body.data.tickets.find((t: any) => t.seatLabel === 'L5');
    const res = await http().post(`${API}/bookings/${booking.body.data.pnr}/cancel`).set(bearer(p.token)).send({ ticketIds: [target.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PARTIALLY_CANCELLED');
    const byLabel = Object.fromEntries(res.body.data.tickets.map((t: any) => [t.seatLabel, t.status]));
    expect(byLabel).toEqual({ L4: 'CONFIRMED', L5: 'CANCELLED', L6: 'CONFIRMED' });
    expect(await seatStatus(tripId, 0, 6, 'L5')).toBe('AVAILABLE');
    expect(await seatStatus(tripId, 0, 6, 'L4')).toBe('BOOKED');

    // cancelling the same ticket again is a conflict, not a second refund
    const again = await http().post(`${API}/bookings/${booking.body.data.pnr}/cancel`).set(bearer(p.token)).send({ ticketIds: [target.id] });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_CANCELLED');
  });

  it('two simultaneous cancel requests produce exactly one refund', async () => {
    const tripId = await makeTrip(70);
    const p = await newPassenger();
    const { booking } = await holdAndBook(p.token, tripId, 0, 6, ['U10']);
    const pnr = booking.body.data.pnr;
    const results = await Promise.all([1, 2, 3].map(() => http().post(`${API}/bookings/${pnr}/cancel`).set(bearer(p.token)).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    const refunds = await query(`SELECT r.* FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE b.pnr = $1`, [pnr]);
    expect(refunds).toHaveLength(1);
  });

  it('inside the closed window (< 3h) cancellation is refused and the seat stays booked', async () => {
    const tripId = await makeTrip(2);
    const p = await newPassenger();
    const { booking } = await holdAndBook(p.token, tripId, 0, 6, ['L8']);
    expect(booking.status).toBe(201);
    const res = await http().post(`${API}/bookings/${booking.body.data.pnr}/cancel`).set(bearer(p.token)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCELLATION_WINDOW_CLOSED');
    expect(await seatStatus(tripId, 0, 6, 'L8')).toBe('BOOKED');
  });

  it('uses the policy snapshot taken at booking time, not the policy edited later', async () => {
    const tripId = await makeTrip(30);
    const p = await newPassenger();
    const { booking } = await holdAndBook(p.token, tripId, 0, 6, ['U2']);
    const ops = await asDeccanOps();
    const me = await http().get(`${API}/auth/me`).set(bearer(ops));
    const opId = me.body.data.user.operatorId;
    const before = await http().get(`${API}/operators/${opId}/cancellation-policy`).set(bearer(ops));
    // operator makes the policy much stricter AFTER the booking
    const upd = await http()
      .put(`${API}/operators/${opId}/cancellation-policy`)
      .set(bearer(ops))
      .send({ rules: [{ minHoursBeforeDeparture: 72, refundPercent: 50 }] });
    expect(upd.status).toBe(200);
    try {
      const res = await http().post(`${API}/bookings/${booking.body.data.pnr}/cancel`).set(bearer(p.token)).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.refunds[0].percent).toBe(75); // old rule still applies
    } finally {
      await http().put(`${API}/operators/${opId}/cancellation-policy`).set(bearer(ops)).send({ rules: before.body.data.rules });
    }
  });

  it('rejects an invalid policy (refund rising as departure approaches)', async () => {
    const ops = await asDeccanOps();
    const me = await http().get(`${API}/auth/me`).set(bearer(ops));
    const res = await http()
      .put(`${API}/operators/${me.body.data.user.operatorId}/cancellation-policy`)
      .set(bearer(ops))
      .send({ rules: [{ minHoursBeforeDeparture: 48, refundPercent: 10 }, { minHoursBeforeDeparture: 2, refundPercent: 90 }] });
    expect(res.status).toBe(400);
  });
});

describe('Refund state machine (simulated gateway)', () => {
  it('PENDING → PROCESSED is allowed; PROCESSED → FAILED is rejected; FAILED needs a note', async () => {
    const tripId = await makeTrip(40);
    const p = await newPassenger();
    const { booking } = await holdAndBook(p.token, tripId, 0, 6, ['U11']);
    const cancelled = await http().post(`${API}/bookings/${booking.body.data.pnr}/cancel`).set(bearer(p.token)).send({});
    const refundId = cancelled.body.data.refunds[0].id;
    const ops = await asDeccanOps();

    const noNote = await http().post(`${API}/refunds/${refundId}/transition`).set(bearer(ops)).send({ status: 'FAILED' });
    expect(noNote.status).toBe(400);
    const passengerTry = await http().post(`${API}/refunds/${refundId}/transition`).set(bearer(p.token)).send({ status: 'PROCESSED' });
    expect(passengerTry.status).toBe(403);
    const ok = await http().post(`${API}/refunds/${refundId}/transition`).set(bearer(ops)).send({ status: 'PROCESSED' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.reference).toMatch(/^SIMREF-/);
    const bad = await http().post(`${API}/refunds/${refundId}/transition`).set(bearer(ops)).send({ status: 'FAILED', note: 'x' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('INVALID_TRANSITION');

    const ticket = await http().get(`${API}/bookings/${booking.body.data.pnr}`).set(bearer(p.token));
    expect(ticket.body.data.refunds[0].status).toBe('PROCESSED');
  });
});

describe('Trip lifecycle', () => {
  it('operator cancelling a trip cancels every ticket with a 100% refund and blocks new bookings', async () => {
    const tripId = await makeTrip(20);
    const a = await newPassenger();
    const b = await newPassenger();
    const ba = await holdAndBook(a.token, tripId, 0, 6, ['L1', 'L2']);
    const bb = await holdAndBook(b.token, tripId, 2, 4, ['U5']);
    const ops = await asDeccanOps();

    const noReason = await http().patch(`${API}/trips/${tripId}/status`).set(bearer(ops)).send({ status: 'CANCELLED' });
    expect(noReason.status).toBe(400);
    const res = await http().patch(`${API}/trips/${tripId}/status`).set(bearer(ops)).send({ status: 'CANCELLED', reason: 'Bus breakdown' });
    expect(res.status).toBe(200);
    expect(res.body.data.affected).toMatchObject({ bookings: 2, tickets: 3 });

    for (const [tok, pnr, total] of [
      [a.token, ba.booking.body.data.pnr, ba.booking.body.data.totalFarePaise],
      [b.token, bb.booking.body.data.pnr, bb.booking.body.data.totalFarePaise],
    ]) {
      const t = await http().get(`${API}/bookings/${pnr}`).set(bearer(tok));
      expect(t.body.data.status).toBe('CANCELLED');
      expect(t.body.data.refunds[0]).toMatchObject({ percent: 100, amountPaise: total, reason: 'TRIP_CANCELLED' });
    }
    const c = await newPassenger();
    const late = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(c.token)).send({ fromStop: 0, toStop: 6, seats: ['L3'] });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('TRIP_NOT_BOOKABLE');

    const revive = await http().patch(`${API}/trips/${tripId}/status`).set(bearer(ops)).send({ status: 'DEPARTED' });
    expect(revive.status).toBe(409);
    expect(revive.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('cannot jump SCHEDULED → COMPLETED, cannot mark DEPARTED hours early', async () => {
    const tripId = await makeTrip(10);
    const admin = await asAdmin();
    const jump = await http().patch(`${API}/trips/${tripId}/status`).set(bearer(admin)).send({ status: 'COMPLETED' });
    expect(jump.status).toBe(409);
    const early = await http().patch(`${API}/trips/${tripId}/status`).set(bearer(admin)).send({ status: 'DEPARTED' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('TOO_EARLY');
  });

  it('booking closes 30 minutes before boarding', async () => {
    const tripId = await makeTrip(0.25);
    const p = await newPassenger();
    const res = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(p.token)).send({ fromStop: 0, toStop: 6, seats: ['L1'] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BOOKING_CLOSED');
  });
});
