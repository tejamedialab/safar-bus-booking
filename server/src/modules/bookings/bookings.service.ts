import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { type Db, getPool, query, queryOne, withTransaction } from '../../db/pool.js';
import { type CancellationRule, evaluateCancellation, refundAmountPaise } from '../../domain/cancellation.js';
import { generatePnr } from '../../domain/pnr.js';
import { canTransitionRefund, type RefundStatus } from '../../domain/state-machines.js';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  gone,
  notFound,
  PG,
  pgCode,
  pgConstraint,
  unprocessable,
} from '../../lib/errors.js';
import { type Actor, isoDate, operatorScope, pageMeta, PaginationQuery, uuidParam } from '../../lib/http.js';
import { audit } from '../audit/audit.service.js';
import { assertBookable, boardingTime, loadTripContext, seatFare } from '../inventory/inventory.service.js';

/* =====================================================================
 * Create booking (hold ➜ confirmed PNR)
 * ===================================================================== */

export const PassengerInput = z.object({
  seatLabel: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,5}$/),
  name: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[\p{L} .'-]+$/u, 'Letters, spaces, dots and hyphens only'),
  age: z.number().int().min(1).max(120),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
});

export const CreateBookingBody = z.object({
  holdToken: uuidParam,
  contactEmail: z.string().trim().toLowerCase().email(),
  contactPhone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number'),
  passengers: z
    .array(PassengerInput)
    .min(1)
    .max(10)
    .refine((p) => new Set(p.map((x) => x.seatLabel)).size === p.length, 'Each seat can have only one passenger'),
});

export const IdempotencyKey = z.string().trim().min(8).max(100);

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const hashRequest = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

/**
 * Converts a seat hold into a confirmed booking. Four independent safety nets:
 *
 *  1. Idempotency-Key  – the key row is inserted first in the transaction. A concurrent duplicate
 *                        blocks on that unique key until we commit, then replays our stored response.
 *  2. Hold row lock    – SELECT … FOR UPDATE on the hold; a hold can be converted once (unique
 *                        bookings.hold_token) and never after it expires.
 *  3. Trip FOR SHARE   – the trip cannot be cancelled/departed mid-booking.
 *  4. Exclusion constraint on tickets – even if every check above were bypassed, Postgres refuses
 *                        two CONFIRMED tickets for the same seat on overlapping segments.
 */
export async function createBooking(
  actor: Actor,
  idempotencyKey: string,
  body: z.infer<typeof CreateBookingBody>,
): Promise<IdempotentResult<any>> {
  const requestHash = hashRequest(body);
  return withTransaction(async (tx) => {
    const fresh = await queryOne(
      `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
      [actor.id, idempotencyKey, requestHash],
      tx,
    );
    if (!fresh) {
      const prior = await queryOne(
        `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
        [actor.id, idempotencyKey],
        tx,
      );
      if (prior.request_hash !== requestHash) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      }
      return { status: prior.response_status, body: prior.response_body, replayed: true };
    }

    const hold = await query(
      `SELECT trip_id, seat_label, from_stop, to_stop, user_id, expires_at, expires_at <= now() AS expired
         FROM seat_holds WHERE hold_token = $1 ORDER BY seat_label FOR UPDATE`,
      [body.holdToken],
      tx,
    );
    if (!hold.length) {
      const used = await queryOne('SELECT pnr FROM bookings WHERE hold_token = $1 AND user_id = $2', [body.holdToken, actor.id], tx);
      if (used) throw conflict('HOLD_ALREADY_USED', `These seats were already booked under PNR ${used.pnr}`, { pnr: used.pnr });
      throw gone('HOLD_EXPIRED', 'Your seat hold has expired or was released. Please select seats again.');
    }
    if (hold[0].user_id !== actor.id) throw forbidden('This seat hold belongs to another user');
    if (hold[0].expired) throw gone('HOLD_EXPIRED', 'Your seat hold has expired. Please select seats again.');

    const heldSeats = hold.map((h: any) => h.seat_label).sort();
    const requestedSeats = body.passengers.map((p) => p.seatLabel).sort();
    if (JSON.stringify(heldSeats) !== JSON.stringify(requestedSeats)) {
      throw badRequest('SEAT_MISMATCH', 'Passenger seats must match the held seats exactly', { heldSeats, requestedSeats });
    }

    const { trip_id: tripId, from_stop: fromStop, to_stop: toStop } = hold[0];
    const trip = await loadTripContext(tx, tripId, 'share');
    assertBookable(trip, fromStop);

    const factors = await query<{ label: string; fare_factor: number }>(
      'SELECT label, fare_factor FROM layout_seats WHERE layout_id = $1 AND label = ANY($2)',
      [trip.seatLayoutId, heldSeats],
      tx,
    );
    const factorOf = new Map(factors.map((f) => [f.label, f.fare_factor]));
    const priced = body.passengers.map((p) => ({ ...p, farePaise: seatFare(trip, fromStop, toStop, factorOf.get(p.seatLabel)!) }));
    const total = priced.reduce((a, p) => a + p.farePaise, 0);

    const policy = await queryOne(
      `SELECT p.rules FROM operators o JOIN cancellation_policies p ON p.id = o.cancellation_policy_id WHERE o.id = $1`,
      [trip.operatorId],
      tx,
    );

    const booking = await insertBookingWithUniquePnr(tx, {
      operatorCode: trip.operatorCode,
      userId: actor.id,
      tripId,
      fromStop,
      toStop,
      total,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone,
      holdToken: body.holdToken,
      policy: policy.rules,
    });

    try {
      await tx.query(
        `INSERT INTO tickets (booking_id, trip_id, layout_id, seat_label, from_stop, to_stop,
                              passenger_name, passenger_age, passenger_gender, fare_paise)
         SELECT $1, $2, $3, p.seat_label, $4, $5, p.name, p.age, p.gender::gender, p.fare
           FROM jsonb_to_recordset($6::jsonb) AS p(seat_label text, name text, age int, gender text, fare int)`,
        [
          booking.id,
          tripId,
          trip.seatLayoutId,
          fromStop,
          toStop,
          JSON.stringify(priced.map((p) => ({ seat_label: p.seatLabel, name: p.name, age: p.age, gender: p.gender, fare: p.farePaise }))),
        ],
      );
    } catch (e) {
      if (pgCode(e) === PG.EXCLUSION_VIOLATION) {
        throw conflict('SEAT_UNAVAILABLE', 'One or more seats were booked by someone else. Please choose again.', {
          constraint: pgConstraint(e),
        });
      }
      throw e;
    }

    await tx.query('DELETE FROM seat_holds WHERE hold_token = $1', [body.holdToken]);
    await audit(tx, actor, {
      action: 'BOOKING_CONFIRMED',
      entityType: 'booking',
      entityId: booking.pnr,
      operatorId: trip.operatorId,
      details: { tripId, seats: heldSeats, fromStop, toStop, totalFarePaise: total, idempotencyKey },
    });

    const responseBody = { data: await getBookingDetail(tx, booking.pnr) };
    await tx.query(
      `UPDATE idempotency_keys SET response_status = 201, response_body = $3 WHERE user_id = $1 AND key = $2`,
      [actor.id, idempotencyKey, JSON.stringify(responseBody)],
    );
    return { status: 201, body: responseBody, replayed: false };
  });
}

async function insertBookingWithUniquePnr(
  tx: pg.PoolClient,
  b: {
    operatorCode: string;
    userId: string;
    tripId: string;
    fromStop: number;
    toStop: number;
    total: number;
    contactEmail: string;
    contactPhone: string;
    holdToken: string;
    policy: unknown;
  },
): Promise<{ id: string; pnr: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pnr = generatePnr(b.operatorCode);
    await tx.query('SAVEPOINT pnr');
    try {
      const row = await queryOne(
        `INSERT INTO bookings (pnr, user_id, trip_id, from_stop, to_stop, total_fare_paise, contact_email, contact_phone,
                               hold_token, policy_snapshot, payment_reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, pnr`,
        [
          pnr,
          b.userId,
          b.tripId,
          b.fromStop,
          b.toStop,
          b.total,
          b.contactEmail,
          b.contactPhone,
          b.holdToken,
          JSON.stringify(b.policy),
          `SIMPAY-${randomUUID().slice(0, 8).toUpperCase()}`,
        ],
        tx,
      );
      await tx.query('RELEASE SAVEPOINT pnr');
      return row;
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT pnr');
      if (pgCode(e) === PG.UNIQUE_VIOLATION && pgConstraint(e) === 'bookings_pnr_uq') continue;
      if (pgCode(e) === PG.UNIQUE_VIOLATION && pgConstraint(e) === 'bookings_hold_token_uq') {
        throw conflict('HOLD_ALREADY_USED', 'These seats were already booked');
      }
      throw e;
    }
  }
  throw new AppError(500, 'PNR_GENERATION_FAILED', 'Could not allocate a PNR, please retry');
}

/* =====================================================================
 * Read bookings
 * ===================================================================== */

/** Full ticket view: PNR + passenger + route + date + seat + fare + refunds. */
export async function getBookingDetail(db: Db, pnr: string) {
  const b = await queryOne(
    `SELECT bk.id, bk.pnr, bk.status, bk.user_id AS "userId", bk.total_fare_paise AS "totalFarePaise",
            bk.contact_email AS "contactEmail", bk.contact_phone AS "contactPhone",
            bk.payment_reference AS "paymentReference", bk.policy_snapshot AS "policySnapshot",
            bk.created_at AS "createdAt", bk.from_stop AS "fromStop", bk.to_stop AS "toStop",
            t.id AS "tripId", t.service_date AS "serviceDate", t.status AS "tripStatus", t.departs_at AS "tripDepartsAt",
            r.code AS "routeCode", r.name AS "routeName", o.id AS "operatorId", o.name AS "operatorName",
            o.contact_phone AS "operatorPhone", bu.registration_no AS "registrationNo", bu.bus_type AS "busType",
            json_build_object('stopOrder', fs.stop_order, 'city', fc.name, 'pointName', fs.point_name,
                              'time', t.departs_at + make_interval(mins => fs.departure_offset_min)) AS boarding,
            json_build_object('stopOrder', ts.stop_order, 'city', tc.name, 'pointName', ts.point_name,
                              'time', t.departs_at + make_interval(mins => ts.arrival_offset_min)) AS drop,
            ts.distance_km - fs.distance_km AS "distanceKm"
       FROM bookings bk
       JOIN trips t ON t.id = bk.trip_id
       JOIN routes r ON r.id = t.route_id
       JOIN operators o ON o.id = r.operator_id
       JOIN buses bu ON bu.id = t.bus_id
       JOIN route_stops fs ON fs.route_id = t.route_id AND fs.stop_order = bk.from_stop
       JOIN cities fc ON fc.id = fs.city_id
       JOIN route_stops ts ON ts.route_id = t.route_id AND ts.stop_order = bk.to_stop
       JOIN cities tc ON tc.id = ts.city_id
      WHERE bk.pnr = $1`,
    [pnr],
    db,
  );
  if (!b) throw notFound('Booking');
  b.tickets = await query(
    `SELECT tk.id, tk.seat_label AS "seatLabel", tk.passenger_name AS "passengerName", tk.passenger_age AS "passengerAge",
            tk.passenger_gender AS "passengerGender", tk.fare_paise AS "farePaise", tk.status,
            tk.cancelled_at AS "cancelledAt", tk.refund_id AS "refundId", ls.seat_type AS "seatType", ls.deck
       FROM tickets tk JOIN layout_seats ls ON ls.layout_id = tk.layout_id AND ls.label = tk.seat_label
      WHERE tk.booking_id = $1 ORDER BY tk.seat_label`,
    [b.id],
    db,
  );
  b.refunds = await query(
    `SELECT id, amount_paise AS "amountPaise", percent, reason, status, reference, failure_note AS "failureNote",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM refunds WHERE booking_id = $1 ORDER BY created_at`,
    [b.id],
    db,
  );
  return b;
}

async function assertCanViewBooking(actor: Actor, b: { userId: string; operatorId: string }) {
  if (actor.role === 'ADMIN') return;
  if (actor.role === 'OPERATOR' && actor.operatorId === b.operatorId) return;
  if (actor.role === 'PASSENGER' && actor.id === b.userId) return;
  // 404 rather than 403 so PNRs cannot be probed for existence.
  throw notFound('Booking');
}

export async function getBookingForActor(actor: Actor, pnr: string) {
  const b = await getBookingDetail(getPool(), pnr.toUpperCase());
  await assertCanViewBooking(actor, b);
  return b;
}

export const BookingQuery = PaginationQuery.extend({
  q: z.string().trim().max(80).optional(),
  status: z.enum(['CONFIRMED', 'PARTIALLY_CANCELLED', 'CANCELLED']).optional(),
  tripId: uuidParam.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  upcoming: z.enum(['true', 'false']).optional(),
});

export async function listBookings(actor: Actor, q: z.infer<typeof BookingQuery>) {
  const scopeUser = actor.role === 'PASSENGER' ? actor.id : null;
  const scopeOperator = actor.role === 'OPERATOR' ? actor.operatorId : null;
  const like = q.q ? `%${q.q}%` : null;
  const params = [
    scopeUser,
    scopeOperator,
    like,
    q.status ?? null,
    q.tripId ?? null,
    q.from ?? null,
    q.to ?? null,
    q.upcoming ? q.upcoming === 'true' : null,
  ];
  const where = `WHERE ($1::uuid IS NULL OR bk.user_id = $1)
      AND ($2::uuid IS NULL OR r.operator_id = $2)
      AND ($3::text IS NULL OR bk.pnr ILIKE $3 OR bk.contact_phone ILIKE $3 OR bk.contact_email ILIKE $3
           OR EXISTS (SELECT 1 FROM tickets x WHERE x.booking_id = bk.id AND x.passenger_name ILIKE $3))
      AND ($4::booking_status IS NULL OR bk.status = $4)
      AND ($5::uuid IS NULL OR bk.trip_id = $5)
      AND ($6::date IS NULL OR t.service_date >= $6)
      AND ($7::date IS NULL OR t.service_date <= $7)
      AND ($8::boolean IS NULL OR (t.departs_at > now()) = $8)`;
  const base = `FROM bookings bk JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id`;
  const [{ total }] = await query(`SELECT count(*) AS total ${base} ${where}`, params);
  const rows = await query(
    `SELECT bk.pnr, bk.status, bk.total_fare_paise AS "totalFarePaise", bk.created_at AS "createdAt",
            bk.contact_phone AS "contactPhone", t.id AS "tripId", t.service_date AS "serviceDate", t.status AS "tripStatus",
            t.departs_at + make_interval(mins => fs.departure_offset_min) AS "boardAt",
            r.name AS "routeName", o.name AS "operatorName", fc.name AS "fromCity", tc.name AS "toCity",
            (SELECT string_agg(seat_label, ', ' ORDER BY seat_label) FROM tickets x WHERE x.booking_id = bk.id) AS seats,
            (SELECT min(passenger_name) FROM tickets x WHERE x.booking_id = bk.id) AS "leadPassenger",
            (SELECT count(*) FROM tickets x WHERE x.booking_id = bk.id AND x.status = 'CONFIRMED') AS "activeTickets"
       ${base}
       JOIN operators o ON o.id = r.operator_id
       JOIN route_stops fs ON fs.route_id = t.route_id AND fs.stop_order = bk.from_stop JOIN cities fc ON fc.id = fs.city_id
       JOIN route_stops ts ON ts.route_id = t.route_id AND ts.stop_order = bk.to_stop JOIN cities tc ON tc.id = ts.city_id
     ${where}
     ORDER BY bk.created_at DESC LIMIT $9 OFFSET $10`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return { data: rows, meta: pageMeta(q.page, q.pageSize, total) };
}

/* =====================================================================
 * Cancellation
 * ===================================================================== */

export const CancelBody = z.object({
  ticketIds: z.array(uuidParam).min(1).max(10).optional(), // omitted = cancel every active ticket
  reason: z.string().trim().max(300).optional(),
});

function computeQuote(booking: any, trip: Awaited<ReturnType<typeof loadTripContext>>, ticketIds?: string[]) {
  const active = booking.tickets.filter((t: any) => t.status === 'CONFIRMED');
  const target = ticketIds ? booking.tickets.filter((t: any) => ticketIds.includes(t.id)) : active;
  if (ticketIds && target.length !== ticketIds.length) throw badRequest('UNKNOWN_TICKET', 'Some tickets are not part of this booking');
  if (!target.length) throw conflict('ALREADY_CANCELLED', 'There are no active tickets to cancel');
  const already = target.filter((t: any) => t.status !== 'CONFIRMED');
  if (already.length) {
    throw conflict('ALREADY_CANCELLED', 'Some tickets are already cancelled', { seats: already.map((t: any) => t.seatLabel) });
  }
  const decision = evaluateCancellation(booking.policySnapshot as CancellationRule[], boardingTime(trip, booking.fromStop), new Date());
  const tickets = target.map((t: any) => ({
    id: t.id,
    seatLabel: t.seatLabel,
    passengerName: t.passengerName,
    farePaise: t.farePaise,
    refundPaise: decision.allowed ? refundAmountPaise(t.farePaise, decision.refundPercent) : 0,
  }));
  return {
    ...decision,
    tripStatus: trip.status,
    rules: booking.policySnapshot,
    tickets,
    willCancelWholeBooking: target.length === active.length,
    totalFarePaise: tickets.reduce((a: number, t: any) => a + t.farePaise, 0),
    totalRefundPaise: tickets.reduce((a: number, t: any) => a + t.refundPaise, 0),
  };
}

export async function getCancellationQuote(actor: Actor, pnr: string, ticketIds?: string[]) {
  const booking = await getBookingForActor(actor, pnr);
  const trip = await loadTripContext(getPool(), booking.tripId);
  return computeQuote(booking, trip, ticketIds);
}

/**
 * Cancels some or all tickets of a booking under the cancellation policy SNAPSHOTTED at booking
 * time. The booking row is locked FOR UPDATE so two simultaneous cancel clicks cannot both refund.
 * Cancelled tickets immediately stop counting against the seat (the exclusion constraint only
 * applies to CONFIRMED tickets), so the seat becomes bookable again in the same transaction.
 */
export async function cancelBooking(actor: Actor, pnr: string, body: z.infer<typeof CancelBody>) {
  return withTransaction(async (tx) => {
    const locked = await queryOne('SELECT id FROM bookings WHERE pnr = $1 FOR UPDATE', [pnr.toUpperCase()], tx);
    if (!locked) throw notFound('Booking');
    const booking = await getBookingDetail(tx, pnr.toUpperCase());
    await assertCanViewBooking(actor, booking);
    const trip = await loadTripContext(tx, booking.tripId, 'share');
    if (trip.status !== 'SCHEDULED') {
      throw conflict('TRIP_NOT_CANCELLABLE', `Tickets cannot be cancelled once the trip is ${trip.status.toLowerCase()}`);
    }
    const quote = computeQuote(booking, trip, body.ticketIds);
    if (!quote.allowed) {
      throw conflict('CANCELLATION_WINDOW_CLOSED', 'The cancellation window for this journey has closed', {
        hoursBeforeDeparture: quote.hoursBeforeDeparture,
        rules: quote.rules,
      });
    }

    const refund = await queryOne(
      `INSERT INTO refunds (booking_id, amount_paise, percent, reason, status, reference)
       VALUES ($1, $2, $3, 'PASSENGER_CANCELLATION', $4, $5) RETURNING id, status`,
      [
        booking.id,
        quote.totalRefundPaise,
        quote.refundPercent,
        quote.totalRefundPaise === 0 ? 'PROCESSED' : 'PENDING',
        quote.totalRefundPaise === 0 ? 'NO_REFUND_DUE' : null,
      ],
      tx,
    );
    await tx.query(
      `UPDATE tickets SET status = 'CANCELLED', cancelled_at = now(), refund_id = $2 WHERE id = ANY($1)`,
      [quote.tickets.map((t: any) => t.id), refund.id],
    );
    const newStatus = quote.willCancelWholeBooking ? 'CANCELLED' : 'PARTIALLY_CANCELLED';
    await tx.query('UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1', [booking.id, newStatus]);
    await audit(tx, actor, {
      action: 'BOOKING_CANCELLED',
      entityType: 'booking',
      entityId: booking.pnr,
      operatorId: booking.operatorId,
      details: {
        seats: quote.tickets.map((t: any) => t.seatLabel),
        refundPercent: quote.refundPercent,
        refundPaise: quote.totalRefundPaise,
        hoursBeforeDeparture: quote.hoursBeforeDeparture,
        newStatus,
        reason: body.reason,
      },
    });
    return getBookingDetail(tx, booking.pnr);
  });
}

/** Operator cancelled the whole trip: every active ticket is cancelled with a 100% refund. */
export async function cancelAllBookingsForTrip(tx: pg.PoolClient, actor: Actor, tripId: string, operatorId: string) {
  const bookings = await lockThenAggregate(tx, tripId);
  let tickets = 0;
  let refundPaise = 0;
  for (const b of bookings) {
    if (!b.active_tickets) continue;
    const refund = await queryOne(
      `INSERT INTO refunds (booking_id, amount_paise, percent, reason) VALUES ($1, $2, 100, 'TRIP_CANCELLED') RETURNING id`,
      [b.id, b.active_fare],
      tx,
    );
    await tx.query(
      `UPDATE tickets SET status = 'CANCELLED', cancelled_at = now(), refund_id = $2 WHERE booking_id = $1 AND status = 'CONFIRMED'`,
      [b.id, refund.id],
    );
    await tx.query(`UPDATE bookings SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [b.id]);
    await audit(tx, actor, {
      action: 'BOOKING_CANCELLED_BY_OPERATOR',
      entityType: 'booking',
      entityId: b.pnr,
      operatorId,
      details: { tripId, refundPaise: b.active_fare, tickets: b.active_tickets },
    });
    tickets += b.active_tickets;
    refundPaise += b.active_fare;
  }
  return { bookings: bookings.filter((b: any) => b.active_tickets > 0).length, tickets, refundPaise };
}

/** Locks the trip's live bookings, then aggregates (FOR UPDATE cannot be combined with GROUP BY). */
async function lockThenAggregate(tx: pg.PoolClient, tripId: string) {
  await tx.query(`SELECT id FROM bookings WHERE trip_id = $1 AND status <> 'CANCELLED' FOR UPDATE`, [tripId]);
  return query(
    `SELECT bk.id, bk.pnr,
            coalesce(sum(tk.fare_paise) FILTER (WHERE tk.status = 'CONFIRMED'), 0)::int AS active_fare,
            count(*) FILTER (WHERE tk.status = 'CONFIRMED')::int AS active_tickets
       FROM bookings bk JOIN tickets tk ON tk.booking_id = bk.id
      WHERE bk.trip_id = $1 AND bk.status <> 'CANCELLED'
      GROUP BY bk.id`,
    [tripId],
    tx,
  );
}

/* =====================================================================
 * Refunds (simulated gateway)
 * ===================================================================== */

export const RefundQuery = PaginationQuery.extend({
  status: z.enum(['PENDING', 'PROCESSED', 'FAILED']).optional(),
});
export const RefundTransitionBody = z.object({
  status: z.enum(['PENDING', 'PROCESSED', 'FAILED']),
  note: z.string().trim().max(300).optional(),
});

export async function listRefunds(actor: Actor, q: z.infer<typeof RefundQuery>) {
  const scope = operatorScope(actor);
  const params = [scope, q.status ?? null];
  const base = `FROM refunds rf JOIN bookings bk ON bk.id = rf.booking_id JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
    WHERE ($1::uuid IS NULL OR r.operator_id = $1) AND ($2::refund_status IS NULL OR rf.status = $2)`;
  const [{ total }] = await query(`SELECT count(*) AS total ${base}`, params);
  const rows = await query(
    `SELECT rf.id, rf.amount_paise AS "amountPaise", rf.percent, rf.reason, rf.status, rf.reference,
            rf.failure_note AS "failureNote", rf.created_at AS "createdAt", rf.updated_at AS "updatedAt",
            bk.pnr, bk.contact_email AS "contactEmail", r.name AS "routeName", t.service_date AS "serviceDate"
     ${base} ORDER BY rf.created_at DESC LIMIT $3 OFFSET $4`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return { data: rows, meta: pageMeta(q.page, q.pageSize, total) };
}

export async function transitionRefund(actor: Actor, refundId: string, body: z.infer<typeof RefundTransitionBody>) {
  return withTransaction(async (tx) => {
    const rf = await queryOne(
      `SELECT rf.id, rf.status, r.operator_id, bk.pnr FROM refunds rf
         JOIN bookings bk ON bk.id = rf.booking_id JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
        WHERE rf.id = $1 FOR UPDATE OF rf`,
      [refundId],
      tx,
    );
    if (!rf) throw notFound('Refund');
    const scope = operatorScope(actor);
    if (scope && scope !== rf.operator_id) throw notFound('Refund');
    if (!canTransitionRefund(rf.status as RefundStatus, body.status)) {
      throw conflict('INVALID_TRANSITION', `A ${rf.status} refund cannot become ${body.status}`);
    }
    if (body.status === 'FAILED' && !body.note) throw badRequest('NOTE_REQUIRED', 'Add a note explaining the failure');
    const row = await queryOne(
      `UPDATE refunds SET status = $2::refund_status, updated_at = now(),
              reference = CASE WHEN $2::refund_status = 'PROCESSED' THEN $3 ELSE reference END,
              failure_note = CASE WHEN $2::refund_status = 'FAILED' THEN $4 ELSE failure_note END
        WHERE id = $1 RETURNING id, status, reference, failure_note AS "failureNote", amount_paise AS "amountPaise"`,
      [refundId, body.status, `SIMREF-${randomUUID().slice(0, 8).toUpperCase()}`, body.note ?? null],
      tx,
    );
    await audit(tx, actor, {
      action: `REFUND_${body.status}`,
      entityType: 'refund',
      entityId: refundId,
      operatorId: rf.operator_id,
      details: { pnr: rf.pnr, from: rf.status, to: body.status, note: body.note },
    });
    return row;
  });
}
