import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { type Db, getPool, query, queryOne, withTransaction } from '../../db/pool.js';
import { baseSegmentFarePaise, seatFarePaise } from '../../domain/pricing.js';
import { badRequest, conflict, gone, notFound, PG, pgCode } from '../../lib/errors.js';
import { type Actor, type AuthUser, isoDate, pageMeta } from '../../lib/http.js';
import { audit } from '../audit/audit.service.js';

/* =====================================================================
 * Shared trip context (used by holds, bookings and cancellations)
 * ===================================================================== */

export interface TripContext {
  id: string;
  status: string;
  departsAt: Date;
  seatLayoutId: string;
  fareMultiplier: number;
  operatorId: string;
  operatorCode: string;
  stops: {
    stopOrder: number;
    cityName: string;
    pointName: string;
    arrivalOffsetMin: number;
    departureOffsetMin: number;
    distanceKm: number;
    cumulativeFarePaise: number;
  }[];
}

/**
 * Loads a trip with its stops. `lock = 'share'` takes FOR SHARE on the trip row: many bookings
 * can proceed in parallel, but an operator changing the trip status (FOR UPDATE) waits for them,
 * and they wait for it — so nobody books a trip in the instant it is being cancelled.
 */
export async function loadTripContext(db: Db, tripId: string, lock: 'none' | 'share' = 'none'): Promise<TripContext> {
  const trip = await queryOne(
    `SELECT t.id, t.status, t.departs_at AS "departsAt", t.seat_layout_id AS "seatLayoutId",
            t.fare_multiplier AS "fareMultiplier", r.operator_id AS "operatorId", o.code AS "operatorCode", t.route_id
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN operators o ON o.id = r.operator_id
      WHERE t.id = $1 ${lock === 'share' ? 'FOR SHARE OF t' : ''}`,
    [tripId],
    db,
  );
  if (!trip) throw notFound('Trip');
  trip.stops = await query(
    `SELECT s.stop_order AS "stopOrder", c.name AS "cityName", s.point_name AS "pointName",
            s.arrival_offset_min AS "arrivalOffsetMin", s.departure_offset_min AS "departureOffsetMin",
            s.distance_km AS "distanceKm", s.cumulative_fare_paise AS "cumulativeFarePaise"
       FROM route_stops s JOIN cities c ON c.id = s.city_id WHERE s.route_id = $1 ORDER BY s.stop_order`,
    [trip.route_id],
    db,
  );
  delete trip.route_id;
  return trip as TripContext;
}

export function boardingTime(trip: TripContext, fromStop: number): Date {
  const stop = trip.stops.find((s) => s.stopOrder === fromStop)!;
  return new Date(new Date(trip.departsAt).getTime() + stop.departureOffsetMin * 60_000);
}

export function assertSegment(trip: TripContext, fromStop: number, toStop: number) {
  const orders = trip.stops.map((s) => s.stopOrder);
  if (!orders.includes(fromStop) || !orders.includes(toStop) || toStop <= fromStop) {
    throw badRequest('INVALID_SEGMENT', 'Boarding point must come before the drop point on this route');
  }
}

/** Booking is open only for SCHEDULED trips until BOOKING_CUTOFF_MINUTES before boarding. */
export function assertBookable(trip: TripContext, fromStop: number) {
  if (trip.status !== 'SCHEDULED') throw conflict('TRIP_NOT_BOOKABLE', `This trip is ${trip.status.toLowerCase()}`);
  const cutoff = boardingTime(trip, fromStop).getTime() - env.BOOKING_CUTOFF_MINUTES * 60_000;
  if (Date.now() >= cutoff) throw conflict('BOOKING_CLOSED', 'Booking has closed for this boarding point');
}

export function seatFare(trip: TripContext, fromStop: number, toStop: number, fareFactor: number) {
  return seatFarePaise(baseSegmentFarePaise(trip.stops, fromStop, toStop), Number(trip.fareMultiplier), Number(fareFactor));
}

/* =====================================================================
 * Search
 * ===================================================================== */

export const SearchQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  date: isoDate,
  busType: z.enum(['AC_SLEEPER', 'NON_AC_SLEEPER', 'AC_SEATER', 'NON_AC_SEATER', 'VOLVO_MULTI_AXLE']).optional(),
  departureWindow: z.enum(['NIGHT', 'MORNING', 'AFTERNOON', 'EVENING']).optional(),
  sort: z.enum(['departure', 'price', 'duration', 'seats']).default('departure'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).refine((q) => q.from !== q.to, { message: 'Origin and destination must differ', path: ['to'] });

const WINDOWS = { NIGHT: [0, 6], MORNING: [6, 12], AFTERNOON: [12, 18], EVENING: [18, 24] } as const;

/**
 * Finds SCHEDULED trips whose route visits `from` before `to`, where the passenger boards on `date`
 * (local time). For each trip we pick the first boarding point in the origin city and the first drop
 * point in the destination city; the seat page lets the passenger choose other points.
 * Availability is segment-aware: a seat sold for Hyderabad→Vijayawada is still free Vijayawada→Vizag.
 */
export async function searchTrips(q: z.infer<typeof SearchQuery>) {
  const window = q.departureWindow ? WINDOWS[q.departureWindow] : null;
  const rows = await query(
    `WITH pairs AS (
       SELECT t.id AS trip_id, b.stop_order AS from_stop, d.stop_order AS to_stop,
              t.departs_at + make_interval(mins => b.departure_offset_min) AS board_at,
              t.departs_at + make_interval(mins => d.arrival_offset_min) AS drop_at,
              d.cumulative_fare_paise - b.cumulative_fare_paise AS base_fare,
              row_number() OVER (PARTITION BY t.id ORDER BY b.stop_order, d.stop_order) AS rn
         FROM trips t
         JOIN routes r ON r.id = t.route_id AND r.is_active
         JOIN route_stops b ON b.route_id = t.route_id AND b.city_id = $1
         JOIN route_stops d ON d.route_id = t.route_id AND d.city_id = $2 AND d.stop_order > b.stop_order
        WHERE t.status = 'SCHEDULED'
          AND t.departs_at >= ($3::date AT TIME ZONE 'Asia/Kolkata') - interval '3 days'
          AND t.departs_at <  (($3::date + 1) AT TIME ZONE 'Asia/Kolkata')
          AND ((t.departs_at + make_interval(mins => b.departure_offset_min)) AT TIME ZONE 'Asia/Kolkata')::date = $3::date
          AND t.departs_at + make_interval(mins => b.departure_offset_min) > now() + make_interval(mins => $4)
     ), chosen AS (SELECT * FROM pairs WHERE rn = 1)
     SELECT c.trip_id AS "tripId", c.from_stop AS "fromStop", c.to_stop AS "toStop",
            c.board_at AS "boardAt", c.drop_at AS "dropAt", c.base_fare AS "baseFarePaise",
            extract(epoch FROM (c.drop_at - c.board_at))::int / 60 AS "durationMin",
            t.fare_multiplier AS "fareMultiplier", t.service_date AS "serviceDate",
            o.name AS "operatorName", o.code AS "operatorCode", r.name AS "routeName",
            bu.bus_type AS "busType", bu.amenities,
            (SELECT min(fare_factor) FROM layout_seats ls WHERE ls.layout_id = t.seat_layout_id) AS "minFareFactor",
            (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = t.seat_layout_id) AS "totalSeats",
            (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = t.seat_layout_id)
              - (SELECT count(DISTINCT x.seat_label) FROM (
                   SELECT seat_label FROM tickets tk
                    WHERE tk.trip_id = t.id AND tk.status = 'CONFIRMED' AND tk.segment && int4range(c.from_stop, c.to_stop)
                   UNION ALL
                   SELECT seat_label FROM seat_holds h
                    WHERE h.trip_id = t.id AND h.expires_at > now() AND h.segment && int4range(c.from_stop, c.to_stop)
                 ) x) AS "availableSeats",
            (SELECT json_agg(json_build_object('stopOrder', s.stop_order, 'pointName', s.point_name,
                     'time', t.departs_at + make_interval(mins => s.departure_offset_min)) ORDER BY s.stop_order)
               FROM route_stops s WHERE s.route_id = t.route_id AND s.city_id = $1 AND s.stop_order < c.to_stop) AS "boardingPoints",
            (SELECT json_agg(json_build_object('stopOrder', s.stop_order, 'pointName', s.point_name,
                     'time', t.departs_at + make_interval(mins => s.arrival_offset_min)) ORDER BY s.stop_order)
               FROM route_stops s WHERE s.route_id = t.route_id AND s.city_id = $2 AND s.stop_order > c.from_stop) AS "dropPoints"
       FROM chosen c
       JOIN trips t ON t.id = c.trip_id
       JOIN routes r ON r.id = t.route_id
       JOIN operators o ON o.id = r.operator_id AND o.is_active
       JOIN buses bu ON bu.id = t.bus_id
      WHERE ($5::bus_type IS NULL OR bu.bus_type = $5)
        AND ($6::int IS NULL OR extract(hour FROM c.board_at AT TIME ZONE 'Asia/Kolkata') >= $6)
        AND ($7::int IS NULL OR extract(hour FROM c.board_at AT TIME ZONE 'Asia/Kolkata') < $7)`,
    [q.from, q.to, q.date, env.BOOKING_CUTOFF_MINUTES, q.busType ?? null, window?.[0] ?? null, window?.[1] ?? null],
  );

  const results = rows.map((r: any) => ({
    ...r,
    fareFromPaise: seatFarePaise(r.baseFarePaise, Number(r.fareMultiplier), Number(r.minFareFactor)),
  }));
  const sorters: Record<string, (a: any, b: any) => number> = {
    departure: (a, b) => +new Date(a.boardAt) - +new Date(b.boardAt),
    price: (a, b) => a.fareFromPaise - b.fareFromPaise,
    duration: (a, b) => a.durationMin - b.durationMin,
    seats: (a, b) => b.availableSeats - a.availableSeats,
  };
  results.sort(sorters[q.sort]);
  const start = (q.page - 1) * q.pageSize;
  return { data: results.slice(start, start + q.pageSize), meta: pageMeta(q.page, q.pageSize, results.length) };
}

/* =====================================================================
 * Seat map
 * ===================================================================== */

export const SeatMapQuery = z.object({
  from: z.coerce.number().int().min(0),
  to: z.coerce.number().int().min(1),
});

export async function getSeatMap(tripId: string, fromStop: number, toStop: number, viewer?: AuthUser) {
  const trip = await loadTripContext(getPool(), tripId);
  assertSegment(trip, fromStop, toStop);
  const layout = await queryOne(
    `SELECT id, name, decks, grid_rows AS "gridRows", grid_cols AS "gridCols" FROM seat_layouts WHERE id = $1`,
    [trip.seatLayoutId],
  );
  const seats = await query(
    `SELECT ls.label, ls.deck, ls.grid_row AS "gridRow", ls.grid_col AS "gridCol", ls.seat_type AS "seatType",
            ls.is_window AS "isWindow", ls.fare_factor AS "fareFactor",
            EXISTS (SELECT 1 FROM tickets tk WHERE tk.trip_id = $1 AND tk.seat_label = ls.label
                       AND tk.status = 'CONFIRMED' AND tk.segment && int4range($3, $4)) AS booked,
            (SELECT h.user_id FROM seat_holds h WHERE h.trip_id = $1 AND h.seat_label = ls.label
                       AND h.expires_at > now() AND h.segment && int4range($3, $4) LIMIT 1) AS "heldBy"
       FROM layout_seats ls WHERE ls.layout_id = $2
      ORDER BY ls.deck, ls.grid_row, ls.grid_col`,
    [tripId, trip.seatLayoutId, fromStop, toStop],
  );
  const bookable = trip.status === 'SCHEDULED';
  return {
    trip: { id: trip.id, status: trip.status, departsAt: trip.departsAt, boardAt: boardingTime(trip, fromStop) },
    segment: { fromStop, toStop, from: trip.stops[fromStop], to: trip.stops.find((s) => s.stopOrder === toStop) },
    layout,
    maxSeatsPerBooking: env.MAX_SEATS_PER_BOOKING,
    seats: seats.map((s: any) => ({
      label: s.label,
      deck: s.deck,
      gridRow: s.gridRow,
      gridCol: s.gridCol,
      seatType: s.seatType,
      isWindow: s.isWindow,
      farePaise: seatFare(trip, fromStop, toStop, s.fareFactor),
      status: !bookable
        ? 'UNAVAILABLE'
        : s.booked
          ? 'BOOKED'
          : s.heldBy
            ? viewer && s.heldBy === viewer.id
              ? 'HELD_BY_YOU'
              : 'HELD'
            : 'AVAILABLE',
    })),
  };
}

/* =====================================================================
 * Seat holds
 * ===================================================================== */

export const CreateHoldBody = z.object({
  fromStop: z.number().int().min(0),
  toStop: z.number().int().min(1),
  seats: z
    .array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,5}$/))
    .min(1)
    .max(env.MAX_SEATS_PER_BOOKING)
    .refine((s) => new Set(s).size === s.length, 'Duplicate seats in request'),
});

/**
 * Places a short-lived hold on seats for a stop segment. Steps (one transaction):
 *  1. lock the trip FOR SHARE and check it is still bookable
 *  2. drop this user's previous hold on the trip and any expired holds
 *  3. reject seats already confirmed for an overlapping segment
 *  4. insert holds — the exclusion constraint rejects a concurrent overlapping hold
 */
export async function createHold(actor: Actor, tripId: string, body: z.infer<typeof CreateHoldBody>) {
  return withTransaction(async (tx) => {
    const trip = await loadTripContext(tx, tripId, 'share');
    assertSegment(trip, body.fromStop, body.toStop);
    assertBookable(trip, body.fromStop);

    const layoutSeats = await query<{ label: string; fare_factor: number }>(
      `SELECT label, fare_factor FROM layout_seats WHERE layout_id = $1 AND label = ANY($2)`,
      [trip.seatLayoutId, body.seats],
      tx,
    );
    if (layoutSeats.length !== body.seats.length) {
      const known = new Set(layoutSeats.map((s) => s.label));
      throw badRequest('UNKNOWN_SEAT', 'Some seats do not exist on this bus', body.seats.filter((s) => !known.has(s)));
    }

    await tx.query('DELETE FROM seat_holds WHERE trip_id = $1 AND (user_id = $2 OR expires_at <= now())', [tripId, actor.id]);

    const taken = await query<{ seat_label: string }>(
      `SELECT DISTINCT seat_label FROM tickets
        WHERE trip_id = $1 AND status = 'CONFIRMED' AND seat_label = ANY($2) AND segment && int4range($3, $4)`,
      [tripId, body.seats, body.fromStop, body.toStop],
      tx,
    );
    if (taken.length) {
      throw conflict('SEAT_UNAVAILABLE', 'Some seats are already booked', { seats: taken.map((t) => t.seat_label) });
    }

    const holdToken = randomUUID();
    const expiresAt = new Date(Date.now() + env.HOLD_TTL_SECONDS * 1000);
    try {
      await tx.query(
        `INSERT INTO seat_holds (hold_token, trip_id, layout_id, seat_label, from_stop, to_stop, user_id, expires_at)
         SELECT $1, $2, $3, unnest($4::text[]), $5, $6, $7, $8`,
        [holdToken, tripId, trip.seatLayoutId, body.seats, body.fromStop, body.toStop, actor.id, expiresAt],
      );
    } catch (e) {
      if (pgCode(e) === PG.EXCLUSION_VIOLATION) {
        throw conflict('SEAT_UNAVAILABLE', 'Someone else is booking one of these seats right now. Please pick another.');
      }
      throw e;
    }

    const seats = layoutSeats.map((s) => ({ label: s.label, farePaise: seatFare(trip, body.fromStop, body.toStop, s.fare_factor) }));
    await audit(tx, actor, {
      action: 'SEATS_HELD',
      entityType: 'trip',
      entityId: tripId,
      operatorId: trip.operatorId,
      details: { holdToken, seats: body.seats, fromStop: body.fromStop, toStop: body.toStop },
    });
    return {
      holdToken,
      tripId,
      fromStop: body.fromStop,
      toStop: body.toStop,
      expiresAt,
      seats,
      totalFarePaise: seats.reduce((a, s) => a + s.farePaise, 0),
    };
  });
}

export async function getHold(actor: Actor, holdToken: string) {
  const rows = await query(
    `SELECT h.trip_id AS "tripId", h.seat_label AS label, h.from_stop AS "fromStop", h.to_stop AS "toStop",
            h.expires_at AS "expiresAt", ls.fare_factor AS "fareFactor"
       FROM seat_holds h JOIN layout_seats ls ON ls.layout_id = h.layout_id AND ls.label = h.seat_label
      WHERE h.hold_token = $1 AND h.user_id = $2 AND h.expires_at > now()
      ORDER BY h.seat_label`,
    [holdToken, actor.id],
  );
  if (!rows.length) throw gone('HOLD_EXPIRED', 'Your seat hold has expired. Please select seats again.');
  const trip = await loadTripContext(getPool(), rows[0].tripId);
  const seats = rows.map((r: any) => ({ label: r.label, farePaise: seatFare(trip, r.fromStop, r.toStop, r.fareFactor) }));
  return {
    holdToken,
    tripId: rows[0].tripId,
    fromStop: rows[0].fromStop,
    toStop: rows[0].toStop,
    expiresAt: rows[0].expiresAt,
    seats,
    totalFarePaise: seats.reduce((a: number, s: any) => a + s.farePaise, 0),
  };
}

export async function releaseHold(actor: Actor, holdToken: string) {
  const res = await query('DELETE FROM seat_holds WHERE hold_token = $1 AND user_id = $2 RETURNING trip_id', [holdToken, actor.id]);
  return { released: res.length };
}
