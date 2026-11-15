/**
 * Acceptance 2: two users cannot confirm the same seat on one trip — including simultaneous requests.
 * Also covers duplicate requests (idempotency), stale/expired holds and the database last line of defence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from '../../src/db/pool.js';
import { API, asRavi, bearer, confirmedTicketsFor, holdAndBook, http, makeTrip, newPassenger, randomUUID } from '../helpers.js';

afterAll(() => closePool());

describe('Acceptance 2 — seat integrity under concurrency', () => {
  let tripId: string;
  beforeAll(async () => {
    tripId = await makeTrip(72);
  });

  it('20 users racing to HOLD the same seat: exactly one wins, 19 get 409', async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => newPassenger()));
    const results = await Promise.all(
      users.map((u) => http().post(`${API}/trips/${tripId}/holds`).set(bearer(u.token)).send({ fromStop: 0, toStop: 6, seats: ['L5'] })),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('SEAT_UNAVAILABLE');
    const holds = await query(`SELECT * FROM seat_holds WHERE trip_id = $1 AND seat_label = 'L5' AND expires_at > now()`, [tripId]);
    expect(holds).toHaveLength(1);
  });

  it('10 users racing the FULL hold → confirm flow: exactly one confirmed ticket exists', async () => {
    const users = await Promise.all(Array.from({ length: 10 }, () => newPassenger()));
    const results = await Promise.all(users.map((u) => holdAndBook(u.token, tripId, 1, 5, ['U7'])));
    const confirmed = results.filter((r) => r.booking?.status === 201);
    expect(confirmed).toHaveLength(1);
    expect(await confirmedTicketsFor(tripId, 'U7')).toHaveLength(1);
  });

  it('the database itself refuses a double booking even if the application checks are bypassed', async () => {
    // Simulate a stale hold: user B somehow holds a seat that user A has already CONFIRMED
    // (e.g. a bug, or a hold created before a code path skipped the ticket check).
    const a = await newPassenger();
    const b = await newPassenger();
    const first = await holdAndBook(a.token, tripId, 0, 6, ['L9']);
    expect(first.booking.status).toBe(201);

    const trip = await queryOne('SELECT seat_layout_id FROM trips WHERE id = $1', [tripId]);
    const bUser = await queryOne('SELECT id FROM users WHERE email = $1', [b.email]);
    const staleToken = randomUUID();
    await query(
      `INSERT INTO seat_holds (hold_token, trip_id, layout_id, seat_label, from_stop, to_stop, user_id, expires_at)
       VALUES ($1, $2, $3, 'L9', 2, 4, $4, now() + interval '5 minutes')`,
      [staleToken, tripId, trip.seat_layout_id, bUser.id],
    );
    const res = await http()
      .post(`${API}/bookings`)
      .set(bearer(b.token))
      .set('Idempotency-Key', randomUUID())
      .send({
        holdToken: staleToken,
        contactEmail: b.email,
        contactPhone: '9123456789',
        passengers: [{ seatLabel: 'L9', name: 'Stale Hold', age: 40, gender: 'MALE' }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEAT_UNAVAILABLE');
    expect(await confirmedTicketsFor(tripId, 'L9')).toHaveLength(1);

    // and a raw INSERT is rejected by the exclusion constraint
    const booking = await queryOne(`SELECT id FROM bookings WHERE trip_id = $1 LIMIT 1`, [tripId]);
    await expect(
      query(
        `INSERT INTO tickets (booking_id, trip_id, layout_id, seat_label, from_stop, to_stop, passenger_name, passenger_age, passenger_gender, fare_paise)
         VALUES ($1, $2, $3, 'L9', 3, 5, 'Raw Insert', 30, 'MALE', 100)`,
        [booking.id, tripId, trip.seat_layout_id],
      ),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'tickets_no_double_booking' });
  });
});

describe('Duplicate requests and stale holds', () => {
  let tripId: string;
  let ravi: string;
  beforeAll(async () => {
    tripId = await makeTrip(80);
    ravi = await asRavi();
  });

  const bookingBody = (holdToken: string, seat: string) => ({
    holdToken,
    contactEmail: 'ravi@example.com',
    contactPhone: '9876500001',
    passengers: [{ seatLabel: seat, name: 'Ravi Teja', age: 27, gender: 'MALE' }],
  });

  it('10 simultaneous retries with the same Idempotency-Key create ONE booking and all get the same PNR', async () => {
    const hold = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(ravi)).send({ fromStop: 0, toStop: 6, seats: ['L12'] });
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        http().post(`${API}/bookings`).set(bearer(ravi)).set('Idempotency-Key', key).send(bookingBody(hold.body.data.holdToken, 'L12')),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const pnrs = new Set(results.map((r) => r.body.data.pnr));
    expect(pnrs.size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
    const count = await queryOne(`SELECT count(*)::int AS n FROM bookings WHERE pnr = $1`, [[...pnrs][0]]);
    expect(count.n).toBe(1);
  });

  it('reusing an Idempotency-Key with a different body is rejected (422)', async () => {
    const hold = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(ravi)).send({ fromStop: 0, toStop: 6, seats: ['L13'] });
    const key = randomUUID();
    const ok = await http().post(`${API}/bookings`).set(bearer(ravi)).set('Idempotency-Key', key).send(bookingBody(hold.body.data.holdToken, 'L13'));
    expect(ok.status).toBe(201);
    const changed = { ...bookingBody(hold.body.data.holdToken, 'L13'), contactPhone: '9000000009' };
    const res = await http().post(`${API}/bookings`).set(bearer(ravi)).set('Idempotency-Key', key).send(changed);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a hold cannot be converted twice (new key, same hold) → 409 with the original PNR', async () => {
    const hold = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(ravi)).send({ fromStop: 0, toStop: 6, seats: ['L14'] });
    const first = await http().post(`${API}/bookings`).set(bearer(ravi)).set('Idempotency-Key', randomUUID()).send(bookingBody(hold.body.data.holdToken, 'L14'));
    expect(first.status).toBe(201);
    const second = await http().post(`${API}/bookings`).set(bearer(ravi)).set('Idempotency-Key', randomUUID()).send(bookingBody(hold.body.data.holdToken, 'L14'));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('HOLD_ALREADY_USED');
    expect(second.body.error.details.pnr).toBe(first.body.data.pnr);
  });

  it('an expired hold cannot be confirmed (410) and its seat is free for others', async () => {
    const hold = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(ravi)).send({ fromStop: 0, toStop: 6, seats: ['L15'] });
    await query(`UPDATE seat_holds SET expires_at = now() - interval '1 second' WHERE hold_token = $1`, [hold.body.data.holdToken]);
    const late = await http().post(`${API}/bookings`).set(bearer(ravi)).set('Idempotency-Key', randomUUID()).send(bookingBody(hold.body.data.holdToken, 'L15'));
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('HOLD_EXPIRED');
    const other = await newPassenger();
    const res = await holdAndBook(other.token, tripId, 0, 6, ['L15']);
    expect(res.booking.status).toBe(201);
  });

  it("a user cannot confirm someone else's hold", async () => {
    const other = await newPassenger();
    const hold = await http().post(`${API}/trips/${tripId}/holds`).set(bearer(other.token)).send({ fromStop: 0, toStop: 6, seats: ['U14'] });
    const res = await http().post(`${API}/bookings`).set(bearer(ravi)).set('Idempotency-Key', randomUUID()).send(bookingBody(hold.body.data.holdToken, 'U14'));
    expect(res.status).toBe(403);
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await http().post(`${API}/bookings`).set(bearer(ravi)).send(bookingBody(randomUUID(), 'L1'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
