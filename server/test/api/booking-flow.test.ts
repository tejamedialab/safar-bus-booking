/**
 * Acceptance 1: a passenger can search a valid trip and book an available seat.
 * Acceptance 3: the PNR carries the correct passenger, route, date and seat details.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../../src/db/pool.js';
import { API, asRavi, bearer, http, randomUUID } from '../helpers.js';

const istDate = (days: number) => new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

let ravi: string;
let cities: Record<string, number>;

beforeAll(async () => {
  ravi = await asRavi();
  const res = await http().get(`${API}/cities`);
  cities = Object.fromEntries(res.body.data.map((c: any) => [c.name, c.id]));
});
afterAll(() => closePool());

describe('Acceptance 1 & 3 — search, hold, book, ticket', () => {
  it('runs the complete passenger journey and the PNR shows the right details', async () => {
    // 1. search Hyderabad → Vijayawada, four days out (no seeded bookings on that date)
    const date = istDate(4);
    const search = await http().get(`${API}/search`).query({ from: cities.Hyderabad, to: cities.Vijayawada, date });
    expect(search.status).toBe(200);
    expect(search.body.data.length).toBeGreaterThan(0);
    const result = search.body.data[0];
    expect(result).toMatchObject({ operatorName: 'Deccan Starliner', totalSeats: 30, availableSeats: 30 });
    expect(result.boardingPoints.map((b: any) => b.pointName)).toEqual(['Miyapur X Roads', 'Ameerpet Metro', 'LB Nagar Ring Road']);
    expect(result.durationMin).toBe(390);

    // 2. choose Ameerpet (stop 1) → Benz Circle (stop 4) and open the seat map
    const seats = await http().get(`${API}/trips/${result.tripId}/seats`).query({ from: 1, to: 4 });
    expect(seats.status).toBe(200);
    const l3 = seats.body.data.seats.find((s: any) => s.label === 'L3');
    expect(l3.status).toBe('AVAILABLE');
    expect(l3.farePaise).toBe(69_300); // (650-20) × 1.0 trip × 1.1 lower berth = ₹693

    // 3. hold → seat shows as HELD_BY_YOU for me and HELD for everyone else
    const hold = await http().post(`${API}/trips/${result.tripId}/holds`).set(bearer(ravi)).send({ fromStop: 1, toStop: 4, seats: ['L3'] });
    expect(hold.status).toBe(201);
    expect(new Date(hold.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const mine = await http().get(`${API}/trips/${result.tripId}/seats`).query({ from: 1, to: 4 }).set(bearer(ravi));
    expect(mine.body.data.seats.find((s: any) => s.label === 'L3').status).toBe('HELD_BY_YOU');
    const anon = await http().get(`${API}/trips/${result.tripId}/seats`).query({ from: 1, to: 4 });
    expect(anon.body.data.seats.find((s: any) => s.label === 'L3').status).toBe('HELD');

    // 4. confirm
    const booking = await http()
      .post(`${API}/bookings`)
      .set(bearer(ravi))
      .set('Idempotency-Key', randomUUID())
      .send({
        holdToken: hold.body.data.holdToken,
        contactEmail: 'ravi@example.com',
        contactPhone: '9876500001',
        passengers: [{ seatLabel: 'L3', name: 'Ravi Teja', age: 27, gender: 'MALE' }],
      });
    expect(booking.status).toBe(201);
    const b = booking.body.data;

    // Acceptance 3: PNR carries passenger, route, date and seat
    expect(b.pnr).toMatch(/^DS[A-Z0-9]{8}$/);
    expect(b.status).toBe('CONFIRMED');
    expect(b.routeName).toBe('Hyderabad → Visakhapatnam (via Vijayawada)');
    expect(b.serviceDate).toBe(date);
    expect(b.boarding).toMatchObject({ city: 'Hyderabad', pointName: 'Ameerpet Metro', stopOrder: 1 });
    expect(b.drop).toMatchObject({ city: 'Vijayawada', pointName: 'Benz Circle', stopOrder: 4 });
    expect(b.tickets).toHaveLength(1);
    expect(b.tickets[0]).toMatchObject({ seatLabel: 'L3', passengerName: 'Ravi Teja', passengerAge: 27, status: 'CONFIRMED', farePaise: 69_300 });
    expect(b.totalFarePaise).toBe(69_300);

    // ticket can be fetched by PNR, seat is now BOOKED, hold is consumed, audit trail written
    const ticket = await http().get(`${API}/bookings/${b.pnr}`).set(bearer(ravi));
    expect(ticket.status).toBe(200);
    expect(ticket.body.data.tickets[0].seatLabel).toBe('L3');
    const after = await http().get(`${API}/trips/${result.tripId}/seats`).query({ from: 1, to: 4 });
    expect(after.body.data.seats.find((s: any) => s.label === 'L3').status).toBe('BOOKED');
    const holds = await query('SELECT * FROM seat_holds WHERE hold_token = $1', [hold.body.data.holdToken]);
    expect(holds).toHaveLength(0);
    const auditRows = await query(`SELECT * FROM audit_logs WHERE action = 'BOOKING_CONFIRMED' AND entity_id = $1`, [b.pnr]);
    expect(auditRows).toHaveLength(1);

    // availability in search dropped by exactly one
    const again = await http().get(`${API}/search`).query({ from: cities.Hyderabad, to: cities.Vijayawada, date });
    expect(again.body.data[0].availableSeats).toBe(29);
  });

  it('re-sells the same seat for a NON-overlapping segment (stop-to-stop inventory)', async () => {
    const date = istDate(5);
    const s = await http().get(`${API}/search`).query({ from: cities.Hyderabad, to: cities.Vijayawada, date });
    const tripId = s.body.data[0].tripId;
    const first = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(ravi)).send({ fromStop: 0, toStop: 4, seats: ['U9'] });
    expect(first.status).toBe(201);
    // Vijayawada → Vizag on the same seat does not overlap [0,4)
    const priya = await (await import('../helpers.js')).asPriya();
    const second = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(priya)).send({ fromStop: 4, toStop: 6, seats: ['U9'] });
    expect(second.status).toBe(201);
    // …but Suryapet → Rajahmundry overlaps both
    const third = await http().post(`${API}/trips/${tripId}/holds`).set(bearer((await (await import('../helpers.js')).newPassenger()).token)).send({ fromStop: 3, toStop: 5, seats: ['U9'] });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('SEAT_UNAVAILABLE');
  });

  it('validates search input and returns predictable errors', async () => {
    const bad = await http().get(`${API}/search`).query({ from: cities.Hyderabad, to: cities.Hyderabad, date: '15-11-2026' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.requestId).toBeTruthy();
    expect(bad.body.error.details.map((d: any) => d.path)).toEqual(expect.arrayContaining(['date']));

    const none = await http().get(`${API}/search`).query({ from: cities.Chennai, to: cities.Amritsar, date: istDate(2) });
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
  });

  it('rejects a reversed boarding/drop segment and unknown seats', async () => {
    const s = await http().get(`${API}/search`).query({ from: cities.Hyderabad, to: cities.Visakhapatnam, date: istDate(6) });
    const tripId = s.body.data[0].tripId;
    const rev = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(ravi)).send({ fromStop: 4, toStop: 1, seats: ['L1'] });
    expect(rev.status).toBe(400);
    expect(rev.body.error.code).toBe('INVALID_SEGMENT');
    const unknown = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(ravi)).send({ fromStop: 0, toStop: 6, seats: ['Z99'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('UNKNOWN_SEAT');
  });

  it('requires passenger seats to match the hold exactly', async () => {
    const s = await http().get(`${API}/search`).query({ from: cities.Hyderabad, to: cities.Visakhapatnam, date: istDate(7) });
    const tripId = s.body.data[0].tripId;
    const hold = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(ravi)).send({ fromStop: 0, toStop: 6, seats: ['L10'] });
    const res = await http()
      .post(`${API}/bookings`)
      .set(bearer(ravi))
      .set('Idempotency-Key', randomUUID())
      .send({
        holdToken: hold.body.data.holdToken,
        contactEmail: 'ravi@example.com',
        contactPhone: '9876500001',
        passengers: [{ seatLabel: 'L11', name: 'Ravi Teja', age: 27, gender: 'MALE' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SEAT_MISMATCH');
  });
});
