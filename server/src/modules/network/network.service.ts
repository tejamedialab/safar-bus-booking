import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { allowedTripTransitions, canTransitionTrip, type TripStatus } from '../../domain/state-machines.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import {
  type Actor,
  assertOperatorAccess,
  isoDate,
  operatorScope,
  pageMeta,
  PaginationQuery,
  uuidParam,
} from '../../lib/http.js';
import { audit } from '../audit/audit.service.js';
import { cancelAllBookingsForTrip } from '../bookings/bookings.service.js';

// ---------------------------------------------------------------- cities

export async function listCities() {
  return query(
    `SELECT c.id, c.name, c.state,
            EXISTS (SELECT 1 FROM route_stops rs JOIN routes r ON r.id = rs.route_id
                     WHERE rs.city_id = c.id AND r.is_active) AS served
       FROM cities c ORDER BY c.name`,
  );
}

// ---------------------------------------------------------------- routes

const StopInput = z.object({
  cityId: z.number().int().positive(),
  pointName: z.string().trim().min(2).max(80),
  arrivalOffsetMin: z.number().int().min(0).max(4320),
  departureOffsetMin: z.number().int().min(0).max(4320),
  distanceKm: z.number().int().min(0).max(5000),
  cumulativeFare: z.number().min(0).max(20000), // rupees from the origin
});

export const CreateRouteBody = z
  .object({
    operatorId: uuidParam.optional(),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, '3–20 letters, digits or dashes'),
    name: z.string().trim().min(3).max(120),
    stops: z.array(StopInput).min(2).max(20),
  })
  .superRefine((r, ctx) => {
    const issue = (i: number, message: string) => ctx.addIssue({ code: 'custom', path: ['stops', i], message });
    const first = r.stops[0];
    if (first.arrivalOffsetMin !== 0 || first.distanceKm !== 0 || first.cumulativeFare !== 0) {
      issue(0, 'The origin stop must have offset 0, distance 0 and fare 0');
    }
    for (let i = 0; i < r.stops.length; i++) {
      const s = r.stops[i];
      if (s.departureOffsetMin < s.arrivalOffsetMin) issue(i, 'Departure cannot be before arrival');
      if (i === 0) continue;
      const p = r.stops[i - 1];
      if (s.arrivalOffsetMin <= p.departureOffsetMin) issue(i, 'Each stop must be reached after the previous one departs');
      if (s.distanceKm <= p.distanceKm) issue(i, 'Distance must increase along the route');
      if (s.cumulativeFare <= p.cumulativeFare) issue(i, 'Fare must increase along the route');
    }
  });

export const RouteQuery = PaginationQuery.extend({
  q: z.string().trim().max(60).optional(),
  operatorId: uuidParam.optional(),
});

export async function listRoutes(actor: Actor, q: z.infer<typeof RouteQuery>) {
  const scope = operatorScope(actor) ?? q.operatorId ?? null;
  const params = [scope, q.q ? `%${q.q}%` : null];
  const where = `WHERE ($1::uuid IS NULL OR r.operator_id = $1) AND ($2::text IS NULL OR r.name ILIKE $2 OR r.code ILIKE $2)`;
  const [{ total }] = await query(`SELECT count(*) AS total FROM routes r ${where}`, params);
  const rows = await query(
    `SELECT r.id, r.code, r.name, r.is_active AS "isActive", r.operator_id AS "operatorId", o.name AS "operatorName",
            (SELECT count(*) FROM route_stops s WHERE s.route_id = r.id) AS "stopCount",
            (SELECT max(distance_km) FROM route_stops s WHERE s.route_id = r.id) AS "distanceKm",
            (SELECT max(arrival_offset_min) FROM route_stops s WHERE s.route_id = r.id) AS "durationMin",
            (SELECT count(*) FROM schedules sc WHERE sc.route_id = r.id AND sc.is_active) AS "activeSchedules"
       FROM routes r JOIN operators o ON o.id = r.operator_id
     ${where} ORDER BY o.name, r.code LIMIT $3 OFFSET $4`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return { data: rows, meta: pageMeta(q.page, q.pageSize, total) };
}

export async function getRouteStops(routeId: string, db = undefined as any) {
  return query(
    `SELECT s.stop_order AS "stopOrder", s.city_id AS "cityId", c.name AS "cityName", s.point_name AS "pointName",
            s.arrival_offset_min AS "arrivalOffsetMin", s.departure_offset_min AS "departureOffsetMin",
            s.distance_km AS "distanceKm", s.cumulative_fare_paise AS "cumulativeFarePaise"
       FROM route_stops s JOIN cities c ON c.id = s.city_id
      WHERE s.route_id = $1 ORDER BY s.stop_order`,
    [routeId],
    db,
  );
}

export async function getRoute(actor: Actor, id: string) {
  const route = await queryOne(
    `SELECT r.id, r.code, r.name, r.is_active AS "isActive", r.operator_id AS "operatorId", o.name AS "operatorName"
       FROM routes r JOIN operators o ON o.id = r.operator_id WHERE r.id = $1`,
    [id],
  );
  if (!route) throw notFound('Route');
  assertOperatorAccess(actor, route.operatorId);
  route.stops = await getRouteStops(id);
  route.schedules = await listSchedulesForRoute(id);
  return route;
}

export async function createRoute(actor: Actor, body: z.infer<typeof CreateRouteBody>) {
  const operatorId = actor.role === 'OPERATOR' ? actor.operatorId! : body.operatorId;
  if (!operatorId) throw badRequest('OPERATOR_REQUIRED', 'operatorId is required for admins');
  assertOperatorAccess(actor, operatorId);
  return withTransaction(async (tx) => {
    const route = await queryOne(
      `INSERT INTO routes (operator_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
      [operatorId, body.code, body.name],
      tx,
    ).catch((e) => {
      if (e.code === '23505') throw conflict('ROUTE_CODE_TAKEN', 'You already have a route with this code');
      throw e;
    });
    for (const [i, s] of body.stops.entries()) {
      await tx.query(
        `INSERT INTO route_stops (route_id, stop_order, city_id, point_name, arrival_offset_min, departure_offset_min, distance_km, cumulative_fare_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [route.id, i, s.cityId, s.pointName, s.arrivalOffsetMin, s.departureOffsetMin, s.distanceKm, Math.round(s.cumulativeFare * 100)],
      );
    }
    await audit(tx, actor, {
      action: 'ROUTE_CREATED',
      entityType: 'route',
      entityId: route.id,
      operatorId,
      details: { code: body.code, name: body.name, stops: body.stops.length },
    });
    return { id: route.id, code: body.code, name: body.name };
  });
}

/** Stops are immutable once trips exist (they are referenced by bookings); only name/active can change. */
export const UpdateRouteBody = z.object({ name: z.string().trim().min(3).max(120).optional(), isActive: z.boolean().optional() });

export async function updateRoute(actor: Actor, id: string, body: z.infer<typeof UpdateRouteBody>) {
  const route = await queryOne('SELECT operator_id FROM routes WHERE id = $1', [id]);
  if (!route) throw notFound('Route');
  assertOperatorAccess(actor, route.operator_id);
  return withTransaction(async (tx) => {
    const row = await queryOne(
      `UPDATE routes SET name = COALESCE($2, name), is_active = COALESCE($3, is_active) WHERE id = $1
       RETURNING id, code, name, is_active AS "isActive"`,
      [id, body.name ?? null, body.isActive ?? null],
      tx,
    );
    await audit(tx, actor, { action: 'ROUTE_UPDATED', entityType: 'route', entityId: id, operatorId: route.operator_id, details: body });
    return row;
  });
}

// ---------------------------------------------------------------- schedules

export const CreateScheduleBody = z.object({
  routeId: uuidParam,
  busId: uuidParam,
  departureTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)'),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort()),
  fareMultiplier: z.number().min(0.5).max(3).default(1),
});
export const UpdateScheduleBody = z.object({
  isActive: z.boolean().optional(),
  fareMultiplier: z.number().min(0.5).max(3).optional(),
});
export const GenerateTripsBody = z
  .object({ fromDate: isoDate, toDate: isoDate })
  .refine((b) => b.toDate >= b.fromDate, { message: 'toDate must be on or after fromDate', path: ['toDate'] })
  .refine((b) => (Date.parse(b.toDate) - Date.parse(b.fromDate)) / 86_400_000 <= 62, {
    message: 'Generate at most 62 days at a time',
    path: ['toDate'],
  });

async function listSchedulesForRoute(routeId: string) {
  return query(
    `SELECT sc.id, to_char(sc.departure_time, 'HH24:MI') AS "departureTime", sc.days_of_week AS "daysOfWeek",
            sc.fare_multiplier AS "fareMultiplier", sc.is_active AS "isActive",
            b.id AS "busId", b.registration_no AS "registrationNo", b.bus_type AS "busType",
            (SELECT max(service_date) FROM trips t WHERE t.schedule_id = sc.id) AS "generatedUntil"
       FROM schedules sc JOIN buses b ON b.id = sc.bus_id
      WHERE sc.route_id = $1 ORDER BY sc.departure_time`,
    [routeId],
  );
}

export async function listSchedules(actor: Actor) {
  const scope = operatorScope(actor);
  return query(
    `SELECT sc.id, to_char(sc.departure_time, 'HH24:MI') AS "departureTime", sc.days_of_week AS "daysOfWeek",
            sc.fare_multiplier AS "fareMultiplier", sc.is_active AS "isActive",
            r.id AS "routeId", r.code AS "routeCode", r.name AS "routeName", o.name AS "operatorName",
            b.id AS "busId", b.registration_no AS "registrationNo", b.bus_type AS "busType",
            (SELECT max(service_date) FROM trips t WHERE t.schedule_id = sc.id) AS "generatedUntil",
            (SELECT count(*) FROM trips t WHERE t.schedule_id = sc.id AND t.status = 'SCHEDULED' AND t.departs_at > now()) AS "upcomingTrips"
       FROM schedules sc JOIN routes r ON r.id = sc.route_id JOIN buses b ON b.id = sc.bus_id JOIN operators o ON o.id = r.operator_id
      WHERE $1::uuid IS NULL OR r.operator_id = $1
      ORDER BY r.code, sc.departure_time`,
    [scope],
  );
}

export async function createSchedule(actor: Actor, body: z.infer<typeof CreateScheduleBody>) {
  const route = await queryOne('SELECT operator_id, is_active FROM routes WHERE id = $1', [body.routeId]);
  const bus = await queryOne('SELECT operator_id, is_active FROM buses WHERE id = $1', [body.busId]);
  if (!route) throw notFound('Route');
  if (!bus) throw notFound('Bus');
  assertOperatorAccess(actor, route.operator_id);
  if (bus.operator_id !== route.operator_id) throw badRequest('BUS_OPERATOR_MISMATCH', 'Bus and route must belong to the same operator');
  if (!route.is_active || !bus.is_active) throw conflict('INACTIVE_RESOURCE', 'Route and bus must both be active');
  return withTransaction(async (tx) => {
    const sc = await queryOne(
      `INSERT INTO schedules (route_id, bus_id, departure_time, days_of_week, fare_multiplier)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [body.routeId, body.busId, body.departureTime, body.daysOfWeek, body.fareMultiplier],
      tx,
    );
    await audit(tx, actor, { action: 'SCHEDULE_CREATED', entityType: 'schedule', entityId: sc.id, operatorId: route.operator_id, details: body });
    return { id: sc.id, ...body };
  });
}

export async function updateSchedule(actor: Actor, id: string, body: z.infer<typeof UpdateScheduleBody>) {
  const sc = await queryOne(`SELECT r.operator_id FROM schedules s JOIN routes r ON r.id = s.route_id WHERE s.id = $1`, [id]);
  if (!sc) throw notFound('Schedule');
  assertOperatorAccess(actor, sc.operator_id);
  return withTransaction(async (tx) => {
    const row = await queryOne(
      `UPDATE schedules SET is_active = COALESCE($2, is_active), fare_multiplier = COALESCE($3, fare_multiplier)
        WHERE id = $1 RETURNING id, is_active AS "isActive", fare_multiplier AS "fareMultiplier"`,
      [id, body.isActive ?? null, body.fareMultiplier ?? null],
      tx,
    );
    await audit(tx, actor, { action: 'SCHEDULE_UPDATED', entityType: 'schedule', entityId: id, operatorId: sc.operator_id, details: body });
    return row;
  });
}

/**
 * Materialises dated trips for a schedule. Each date is inserted under its own SAVEPOINT so one
 * conflict (trip already exists, or the bus is busy on an overlapping trip) skips only that date.
 * Fare multiplier and seat layout are snapshotted onto the trip.
 */
export async function generateTrips(actor: Actor, scheduleId: string, body: z.infer<typeof GenerateTripsBody>) {
  const sc = await queryOne(
    `SELECT s.*, r.operator_id, r.is_active AS route_active, b.seat_layout_id, b.is_active AS bus_active,
            (SELECT max(arrival_offset_min) FROM route_stops rs WHERE rs.route_id = s.route_id) AS duration_min
       FROM schedules s JOIN routes r ON r.id = s.route_id JOIN buses b ON b.id = s.bus_id WHERE s.id = $1`,
    [scheduleId],
  );
  if (!sc) throw notFound('Schedule');
  assertOperatorAccess(actor, sc.operator_id);
  if (!sc.is_active || !sc.route_active || !sc.bus_active) {
    throw conflict('INACTIVE_RESOURCE', 'Schedule, route and bus must all be active to generate trips');
  }
  return withTransaction(async (tx) => {
    const dates = await query<{ d: string }>(
      `SELECT d::date::text AS d FROM generate_series($1::date, $2::date, interval '1 day') d
        WHERE extract(dow FROM d)::smallint = ANY($3::smallint[])`,
      [body.fromDate, body.toDate, sc.days_of_week],
      tx,
    );
    const created: string[] = [];
    const skipped: { date: string; reason: string }[] = [];
    for (const { d } of dates) {
      await tx.query('SAVEPOINT gen');
      try {
        const row = await queryOne(
          `INSERT INTO trips (schedule_id, route_id, bus_id, seat_layout_id, service_date, departs_at, arrives_at, fare_multiplier)
           SELECT $1, $2, $3, $4, $5::date, dep, dep + make_interval(mins => $7), $8
             FROM (SELECT (($5::date + $6::time) AT TIME ZONE 'Asia/Kolkata') AS dep) x
            WHERE dep > now()
           RETURNING id`,
          [scheduleId, sc.route_id, sc.bus_id, sc.seat_layout_id, d, sc.departure_time, sc.duration_min, sc.fare_multiplier],
          tx,
        );
        await tx.query('RELEASE SAVEPOINT gen');
        if (row) created.push(d);
        else skipped.push({ date: d, reason: 'IN_THE_PAST' });
      } catch (e: any) {
        await tx.query('ROLLBACK TO SAVEPOINT gen');
        if (e.code === '23505') skipped.push({ date: d, reason: 'ALREADY_EXISTS' });
        else if (e.code === '23P01') skipped.push({ date: d, reason: 'BUS_ALREADY_ASSIGNED' });
        else throw e;
      }
    }
    await audit(tx, actor, {
      action: 'TRIPS_GENERATED',
      entityType: 'schedule',
      entityId: scheduleId,
      operatorId: sc.operator_id,
      details: { ...body, created: created.length, skipped: skipped.length },
    });
    return { created: created.length, createdDates: created, skipped };
  });
}

// ---------------------------------------------------------------- trips

export const TripQuery = PaginationQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  routeId: uuidParam.optional(),
  status: z.enum(['SCHEDULED', 'DEPARTED', 'COMPLETED', 'CANCELLED']).optional(),
});

export async function listTrips(actor: Actor, q: z.infer<typeof TripQuery>) {
  const scope = operatorScope(actor);
  const params = [scope, q.from ?? null, q.to ?? null, q.routeId ?? null, q.status ?? null];
  const where = `WHERE ($1::uuid IS NULL OR r.operator_id = $1)
      AND ($2::date IS NULL OR t.service_date >= $2) AND ($3::date IS NULL OR t.service_date <= $3)
      AND ($4::uuid IS NULL OR t.route_id = $4) AND ($5::trip_status IS NULL OR t.status = $5)`;
  const [{ total }] = await query(`SELECT count(*) AS total FROM trips t JOIN routes r ON r.id = t.route_id ${where}`, params);
  const rows = await query(
    `SELECT t.id, t.service_date AS "serviceDate", t.departs_at AS "departsAt", t.arrives_at AS "arrivesAt", t.status,
            r.code AS "routeCode", r.name AS "routeName", o.name AS "operatorName", b.registration_no AS "registrationNo",
            (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = t.seat_layout_id) AS "seatCount",
            (SELECT count(*) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status = 'CONFIRMED') AS "confirmedTickets",
            (SELECT count(DISTINCT tk.seat_label) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status = 'CONFIRMED') AS "seatsSold"
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN operators o ON o.id = r.operator_id JOIN buses b ON b.id = t.bus_id
     ${where} ORDER BY t.departs_at, r.code LIMIT $6 OFFSET $7`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return { data: rows, meta: pageMeta(q.page, q.pageSize, total) };
}

/** Public trip details: stops with absolute times, bus and operator info. */
export async function getTrip(tripId: string) {
  const trip = await queryOne(
    `SELECT t.id, t.service_date AS "serviceDate", t.departs_at AS "departsAt", t.arrives_at AS "arrivesAt", t.status,
            t.fare_multiplier AS "fareMultiplier", t.seat_layout_id AS "seatLayoutId", t.route_id AS "routeId",
            r.code AS "routeCode", r.name AS "routeName",
            o.id AS "operatorId", o.name AS "operatorName", o.code AS "operatorCode",
            b.registration_no AS "registrationNo", b.bus_type AS "busType", b.amenities
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN operators o ON o.id = r.operator_id JOIN buses b ON b.id = t.bus_id
      WHERE t.id = $1`,
    [tripId],
  );
  if (!trip) throw notFound('Trip');
  const stops = await getRouteStops(trip.routeId);
  const dep = new Date(trip.departsAt).getTime();
  trip.stops = stops.map((s: any) => ({
    ...s,
    arrivesAt: new Date(dep + s.arrivalOffsetMin * 60_000).toISOString(),
    departsAt: new Date(dep + s.departureOffsetMin * 60_000).toISOString(),
  }));
  return trip;
}

export const TripStatusBody = z.object({
  status: z.enum(['DEPARTED', 'COMPLETED', 'CANCELLED']),
  reason: z.string().trim().max(300).optional(),
});

export async function changeTripStatus(actor: Actor, tripId: string, body: z.infer<typeof TripStatusBody>) {
  return withTransaction(async (tx) => {
    // Lock the trip row: concurrent bookings on this trip wait until the status change commits.
    const trip = await queryOne(
      `SELECT t.id, t.status, t.departs_at, r.operator_id FROM trips t JOIN routes r ON r.id = t.route_id
        WHERE t.id = $1 FOR UPDATE OF t`,
      [tripId],
      tx,
    );
    if (!trip) throw notFound('Trip');
    assertOperatorAccess(actor, trip.operator_id);
    const from = trip.status as TripStatus;
    if (!canTransitionTrip(from, body.status)) {
      throw conflict('INVALID_TRANSITION', `A ${from} trip cannot become ${body.status}`, {
        allowed: allowedTripTransitions(from),
      });
    }
    if (body.status === 'DEPARTED' && new Date(trip.departs_at).getTime() - Date.now() > 60 * 60_000) {
      throw conflict('TOO_EARLY', 'A trip can be marked departed at most 60 minutes before its departure time');
    }
    if (body.status === 'CANCELLED' && !body.reason) {
      throw badRequest('REASON_REQUIRED', 'Please give a reason for cancelling the trip');
    }
    await tx.query(`UPDATE trips SET status = $2, status_changed_at = now() WHERE id = $1`, [tripId, body.status]);
    let affected = { bookings: 0, tickets: 0, refundPaise: 0 };
    if (body.status === 'CANCELLED') {
      await tx.query('DELETE FROM seat_holds WHERE trip_id = $1', [tripId]);
      affected = await cancelAllBookingsForTrip(tx, actor, tripId, trip.operator_id);
    }
    await audit(tx, actor, {
      action: `TRIP_${body.status}`,
      entityType: 'trip',
      entityId: tripId,
      operatorId: trip.operator_id,
      details: { from, to: body.status, reason: body.reason, ...affected },
    });
    return { id: tripId, status: body.status, affected };
  });
}
