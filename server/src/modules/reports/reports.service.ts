import { z } from 'zod';
import { getPool, query, queryOne } from '../../db/pool.js';
import { type Actor, assertOperatorAccess, isoDate, operatorScope, uuidParam } from '../../lib/http.js';
import { loadTripContext } from '../inventory/inventory.service.js';

async function tripForStaff(actor: Actor, tripId: string) {
  const trip = await loadTripContext(getPool(), tripId);
  assertOperatorAccess(actor, trip.operatorId);
  const meta = await queryOne(
    `SELECT t.service_date AS "serviceDate", t.departs_at AS "departsAt", t.arrives_at AS "arrivesAt", t.status,
            r.code AS "routeCode", r.name AS "routeName", o.name AS "operatorName", b.registration_no AS "registrationNo",
            b.bus_type AS "busType", (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = t.seat_layout_id) AS "seatCount"
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN operators o ON o.id = r.operator_id JOIN buses b ON b.id = t.bus_id
      WHERE t.id = $1`,
    [tripId],
  );
  return { ctx: trip, meta: { id: tripId, ...meta } };
}

/* ---------------------------------------------------------------- manifest */

export async function getManifest(actor: Actor, tripId: string) {
  const { ctx, meta } = await tripForStaff(actor, tripId);
  const rows = await query(
    `SELECT tk.seat_label AS "seatLabel", tk.passenger_name AS "passengerName", tk.passenger_age AS "passengerAge",
            tk.passenger_gender AS "passengerGender", bk.pnr, bk.contact_phone AS "contactPhone",
            tk.from_stop AS "fromStop", tk.to_stop AS "toStop", tk.fare_paise AS "farePaise"
       FROM tickets tk JOIN bookings bk ON bk.id = tk.booking_id
      WHERE tk.trip_id = $1 AND tk.status = 'CONFIRMED'
      ORDER BY tk.from_stop, tk.seat_label`,
    [tripId],
  );
  const dep = new Date(ctx.departsAt).getTime();
  const stop = (o: number) => ctx.stops.find((s) => s.stopOrder === o)!;
  const passengers = rows.map((r: any) => ({
    ...r,
    boardingPoint: `${stop(r.fromStop).cityName} · ${stop(r.fromStop).pointName}`,
    boardingTime: new Date(dep + stop(r.fromStop).departureOffsetMin * 60_000).toISOString(),
    dropPoint: `${stop(r.toStop).cityName} · ${stop(r.toStop).pointName}`,
  }));
  return { trip: meta, totalPassengers: passengers.length, passengers };
}

export function manifestToCsv(m: Awaited<ReturnType<typeof getManifest>>): string {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    // neutralise spreadsheet formula injection and quote everything
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const header = ['Seat', 'Passenger', 'Age', 'Gender', 'PNR', 'Phone', 'Boarding point', 'Boarding time (IST)', 'Drop point', 'Fare (INR)'];
  const ist = (iso: string) =>
    new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const lines = m.passengers.map((p: any) =>
    [p.seatLabel, p.passengerName, p.passengerAge, p.passengerGender, p.pnr, p.contactPhone, p.boardingPoint, ist(p.boardingTime), p.dropPoint, (p.farePaise / 100).toFixed(2)]
      .map(esc)
      .join(','),
  );
  return [header.map(esc).join(','), ...lines].join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------------- occupancy */

/**
 * Segment-aware occupancy. For each leg (stop k → k+1) we count seats with a CONFIRMED ticket
 * covering that leg. Seat-km utilisation = Σ(ticket distance) / (seats × route distance).
 */
export async function getOccupancy(actor: Actor, tripId: string) {
  const { ctx, meta } = await tripForStaff(actor, tripId);
  const tickets = await query<{ seat_label: string; from_stop: number; to_stop: number }>(
    `SELECT seat_label, from_stop, to_stop FROM tickets WHERE trip_id = $1 AND status = 'CONFIRMED'`,
    [tripId],
  );
  const seatCount = Number(meta.seatCount);
  const legs = ctx.stops.slice(0, -1).map((s, k) => {
    const next = ctx.stops[k + 1];
    const seats = new Set(tickets.filter((t) => t.from_stop <= k && t.to_stop > k).map((t) => t.seat_label));
    return {
      leg: k,
      from: s.cityName,
      to: next.cityName,
      fromPoint: s.pointName,
      toPoint: next.pointName,
      distanceKm: next.distanceKm - s.distanceKm,
      occupiedSeats: seats.size,
      occupancyPercent: Math.round((seats.size / seatCount) * 1000) / 10,
    };
  });
  const routeKm = ctx.stops[ctx.stops.length - 1].distanceKm;
  const seatKmSold = tickets.reduce(
    (a, t) => a + (ctx.stops[t.to_stop].distanceKm - ctx.stops[t.from_stop].distanceKm),
    0,
  );
  const perSeat = new Map<string, { fromStop: number; toStop: number }[]>();
  for (const t of tickets) {
    perSeat.set(t.seat_label, [...(perSeat.get(t.seat_label) ?? []), { fromStop: t.from_stop, toStop: t.to_stop }]);
  }
  return {
    trip: meta,
    seatCount,
    confirmedTickets: tickets.length,
    seatsWithAnyBooking: perSeat.size,
    peakOccupiedSeats: Math.max(0, ...legs.map((l) => l.occupiedSeats)),
    seatKmUtilisationPercent: routeKm && seatCount ? Math.round((seatKmSold / (seatCount * routeKm)) * 1000) / 10 : 0,
    legs,
    seats: [...perSeat.entries()].map(([label, segments]) => ({ label, segments })),
  };
}

/* ---------------------------------------------------------------- reconciliation */

/**
 * Independently re-derives the trip's numbers from different tables/queries and checks they agree.
 * This is the evidence for acceptance test 5 ("manifest and occupancy reconcile with confirmed tickets").
 */
export async function getReconciliation(actor: Actor, tripId: string) {
  const manifest = await getManifest(actor, tripId);
  const occupancy = await getOccupancy(actor, tripId);
  const ledger = await queryOne(
    `SELECT
       (SELECT count(*) FROM tickets WHERE trip_id = $1 AND status = 'CONFIRMED') AS confirmed_tickets,
       (SELECT coalesce(sum(to_stop - from_stop), 0) FROM tickets WHERE trip_id = $1 AND status = 'CONFIRMED') AS confirmed_leg_seats,
       (SELECT coalesce(sum(total_fare_paise), 0) FROM bookings WHERE trip_id = $1) AS booked_total,
       (SELECT coalesce(sum(fare_paise), 0) FROM tickets WHERE trip_id = $1) AS ticket_total,
       (SELECT coalesce(sum(fare_paise), 0) FROM tickets WHERE trip_id = $1 AND status = 'CONFIRMED') AS active_fare,
       (SELECT coalesce(sum(fare_paise), 0) FROM tickets WHERE trip_id = $1 AND status = 'CANCELLED') AS cancelled_fare,
       (SELECT coalesce(sum(rf.amount_paise), 0) FROM refunds rf JOIN bookings b ON b.id = rf.booking_id WHERE b.trip_id = $1) AS refunded,
       (SELECT count(*) FROM bookings b WHERE b.trip_id = $1 AND b.status <> CASE
            WHEN NOT EXISTS (SELECT 1 FROM tickets t WHERE t.booking_id = b.id AND t.status = 'CONFIRMED') THEN 'CANCELLED'::booking_status
            WHEN EXISTS (SELECT 1 FROM tickets t WHERE t.booking_id = b.id AND t.status = 'CANCELLED') THEN 'PARTIALLY_CANCELLED'::booking_status
            ELSE 'CONFIRMED'::booking_status END) AS inconsistent_bookings,
       (SELECT count(*) FROM (
            SELECT 1 FROM tickets a JOIN tickets b ON a.trip_id = b.trip_id AND a.seat_label = b.seat_label AND a.id < b.id
             WHERE a.trip_id = $1 AND a.status = 'CONFIRMED' AND b.status = 'CONFIRMED' AND a.segment && b.segment) x) AS double_booked`,
    [tripId],
  );
  const legSeatsFromOccupancy = occupancy.legs.reduce((a, l) => a + l.occupiedSeats, 0);
  const checks = [
    {
      key: 'manifest_vs_tickets',
      label: 'Manifest passengers = confirmed tickets',
      expected: ledger.confirmed_tickets,
      actual: manifest.totalPassengers,
    },
    {
      key: 'occupancy_vs_tickets',
      label: 'Occupied seat-legs (occupancy) = seat-legs on confirmed tickets',
      expected: ledger.confirmed_leg_seats,
      actual: legSeatsFromOccupancy,
    },
    { key: 'no_double_booking', label: 'Seats confirmed twice on an overlapping segment', expected: 0, actual: ledger.double_booked },
    { key: 'booking_totals', label: 'Σ booking totals = Σ ticket fares (₹ paise)', expected: ledger.ticket_total, actual: ledger.booked_total },
    { key: 'booking_status', label: 'Bookings whose status disagrees with their tickets', expected: 0, actual: ledger.inconsistent_bookings },
    {
      key: 'refund_ceiling',
      label: 'Refunds never exceed cancelled fares (₹ paise)',
      expected: `≤ ${ledger.cancelled_fare}`,
      actual: ledger.refunded,
      pass: ledger.refunded <= ledger.cancelled_fare,
    },
  ].map((c: any) => ({ ...c, pass: c.pass ?? Number(c.expected) === Number(c.actual) }));

  return {
    trip: manifest.trip,
    reconciled: checks.every((c) => c.pass),
    checks,
    money: {
      grossBookedPaise: ledger.booked_total,
      activeFarePaise: ledger.active_fare,
      cancelledFarePaise: ledger.cancelled_fare,
      refundedPaise: ledger.refunded,
      netRevenuePaise: ledger.booked_total - ledger.refunded,
    },
  };
}

/* ---------------------------------------------------------------- dashboard & summaries */

export async function getDashboard(actor: Actor) {
  const scope = operatorScope(actor);
  const kpis = await queryOne(
    `WITH scoped_trips AS (
        SELECT t.* FROM trips t JOIN routes r ON r.id = t.route_id WHERE $1::uuid IS NULL OR r.operator_id = $1
     ), scoped_bookings AS (
        SELECT b.* FROM bookings b JOIN scoped_trips t ON t.id = b.trip_id
     ), today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d)
     SELECT
       (SELECT count(*) FROM scoped_bookings b, today WHERE (b.created_at AT TIME ZONE 'Asia/Kolkata')::date = today.d) AS "bookingsToday",
       (SELECT coalesce(sum(total_fare_paise), 0) FROM scoped_bookings b, today WHERE (b.created_at AT TIME ZONE 'Asia/Kolkata')::date = today.d) AS "grossToday",
       (SELECT count(*) FROM scoped_trips WHERE status = 'SCHEDULED' AND departs_at BETWEEN now() AND now() + interval '7 days') AS "upcomingTrips7d",
       (SELECT count(*) FROM tickets tk JOIN scoped_trips t ON t.id = tk.trip_id WHERE tk.status = 'CONFIRMED' AND t.status = 'SCHEDULED' AND t.departs_at > now()) AS "upcomingPassengers",
       (SELECT count(*) FROM refunds rf JOIN scoped_bookings b ON b.id = rf.booking_id WHERE rf.status = 'PENDING') AS "pendingRefunds",
       (SELECT coalesce(sum(rf.amount_paise), 0) FROM refunds rf JOIN scoped_bookings b ON b.id = rf.booking_id WHERE rf.status = 'PENDING') AS "pendingRefundPaise",
       (SELECT coalesce(round(100.0 * sum(sold) / nullif(sum(seats), 0), 1), 0) FROM (
          SELECT (SELECT count(DISTINCT seat_label) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status = 'CONFIRMED') AS sold,
                 (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = t.seat_layout_id) AS seats
            FROM scoped_trips t WHERE t.status = 'SCHEDULED' AND t.departs_at BETWEEN now() AND now() + interval '7 days') x) AS "loadFactor7d"`,
    [scope],
  );
  const trend = await query(
    `WITH days AS (SELECT generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 13, (now() AT TIME ZONE 'Asia/Kolkata')::date, '1 day')::date AS d),
          sb AS (SELECT b.* FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id WHERE $1::uuid IS NULL OR r.operator_id = $1)
     SELECT d.d::text AS date,
            (SELECT count(*) FROM sb WHERE (sb.created_at AT TIME ZONE 'Asia/Kolkata')::date = d.d) AS bookings,
            (SELECT coalesce(sum(total_fare_paise), 0) FROM sb WHERE (sb.created_at AT TIME ZONE 'Asia/Kolkata')::date = d.d) AS "grossPaise",
            (SELECT coalesce(sum(rf.amount_paise), 0) FROM refunds rf JOIN sb ON sb.id = rf.booking_id WHERE (rf.created_at AT TIME ZONE 'Asia/Kolkata')::date = d.d) AS "refundPaise"
       FROM days d ORDER BY d.d`,
    [scope],
  );
  const departures = await query(
    `SELECT t.id, t.departs_at AS "departsAt", t.status, r.code AS "routeCode", r.name AS "routeName", b.registration_no AS "registrationNo",
            (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = t.seat_layout_id) AS "seatCount",
            (SELECT count(DISTINCT seat_label) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status = 'CONFIRMED') AS "seatsSold",
            (SELECT count(*) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status = 'CONFIRMED') AS "passengers"
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
      WHERE ($1::uuid IS NULL OR r.operator_id = $1) AND t.status IN ('SCHEDULED', 'DEPARTED')
        AND t.departs_at BETWEEN now() - interval '6 hours' AND now() + interval '36 hours'
      ORDER BY t.departs_at LIMIT 12`,
    [scope],
  );
  const topRoutes = await query(
    `SELECT r.code AS "routeCode", r.name AS "routeName", count(DISTINCT b.id) AS bookings,
            coalesce(sum(b.total_fare_paise), 0) - coalesce((SELECT sum(rf.amount_paise) FROM refunds rf JOIN bookings b2 ON b2.id = rf.booking_id
                                                              JOIN trips t2 ON t2.id = b2.trip_id WHERE t2.route_id = r.id
                                                                AND b2.created_at > now() - interval '30 days'), 0) AS "netPaise"
       FROM routes r LEFT JOIN trips t ON t.route_id = r.id LEFT JOIN bookings b ON b.trip_id = t.id AND b.created_at > now() - interval '30 days'
      WHERE $1::uuid IS NULL OR r.operator_id = $1
      GROUP BY r.id ORDER BY "netPaise" DESC LIMIT 5`,
    [scope],
  );
  return { kpis, trend, departures, topRoutes };
}

export const SummaryQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    routeId: uuidParam.optional(),
    groupBy: z.enum(['day', 'route']).default('day'),
  })
  .refine((q) => q.to >= q.from, { message: 'to must be on or after from', path: ['to'] });

/** Booking summary by travel date (service date) or by route, for a date range. */
export async function getBookingSummary(actor: Actor, q: z.infer<typeof SummaryQuery>) {
  const scope = operatorScope(actor);
  const key = q.groupBy === 'day' ? `t.service_date::text` : `r.code || ' · ' || r.name`;
  const rows = await query(
    `SELECT ${key} AS "group",
            count(DISTINCT b.id) AS bookings,
            count(tk.id) AS "ticketsSold",
            count(tk.id) FILTER (WHERE tk.status = 'CONFIRMED') AS "ticketsActive",
            count(tk.id) FILTER (WHERE tk.status = 'CANCELLED') AS "ticketsCancelled",
            coalesce(sum(tk.fare_paise), 0) AS "grossPaise",
            coalesce((SELECT sum(rf.amount_paise) FROM refunds rf WHERE rf.booking_id = ANY(array_agg(DISTINCT b.id))), 0) AS "refundPaise"
       FROM bookings b
       JOIN tickets tk ON tk.booking_id = b.id
       JOIN trips t ON t.id = b.trip_id
       JOIN routes r ON r.id = t.route_id
      WHERE ($1::uuid IS NULL OR r.operator_id = $1) AND t.service_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR r.id = $4)
      GROUP BY 1 ORDER BY 1`,
    [scope, q.from, q.to, q.routeId ?? null],
  );
  const data = rows.map((r: any) => ({ ...r, netPaise: r.grossPaise - r.refundPaise }));
  const totals = data.reduce(
    (a: any, r: any) => {
      for (const k of ['bookings', 'ticketsSold', 'ticketsActive', 'ticketsCancelled', 'grossPaise', 'refundPaise', 'netPaise']) {
        a[k] = (a[k] ?? 0) + Number(r[k]);
      }
      return a;
    },
    {} as Record<string, number>,
  );
  return { data, totals };
}

export const RouteScheduleQuery = z.object({ from: isoDate, to: isoDate, routeId: uuidParam.optional() });

/** Timetable report: every trip in the range per route, with departure/arrival and seats sold. */
export async function getRouteSchedules(actor: Actor, q: z.infer<typeof RouteScheduleQuery>) {
  const scope = operatorScope(actor);
  const rows = await query(
    `SELECT r.id AS "routeId", r.code AS "routeCode", r.name AS "routeName",
            t.id AS "tripId", t.service_date AS "serviceDate", t.departs_at AS "departsAt", t.arrives_at AS "arrivesAt",
            t.status, b.registration_no AS "registrationNo", b.bus_type AS "busType",
            (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = t.seat_layout_id) AS "seatCount",
            (SELECT count(DISTINCT seat_label) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status = 'CONFIRMED') AS "seatsSold"
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
      WHERE ($1::uuid IS NULL OR r.operator_id = $1) AND t.service_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR r.id = $4)
      ORDER BY r.code, t.departs_at`,
    [scope, q.from, q.to, q.routeId ?? null],
  );
  const byRoute = new Map<string, any>();
  for (const row of rows) {
    if (!byRoute.has(row.routeId)) {
      byRoute.set(row.routeId, { routeId: row.routeId, routeCode: row.routeCode, routeName: row.routeName, trips: [] });
    }
    const { routeId: _r, routeCode: _c, routeName: _n, ...trip } = row;
    byRoute.get(row.routeId).trips.push(trip);
  }
  return [...byRoute.values()];
}

