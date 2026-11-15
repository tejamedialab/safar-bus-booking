/**
 * HTTP layer only: parse/validate input → call a service → shape the response.
 * Business rules live in the services; SQL lives in the services/repositories below them.
 * Every route declares its role requirement here, server-side.
 */
import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from './lib/errors.js';
import { actorOf, parse, uuidParam } from './lib/http.js';
import { requireAuth, requireRole, requireStaff } from './middleware/auth.js';
import { AuditQuery, listAuditLogs } from './modules/audit/audit.service.js';
import { authRouter } from './modules/auth/auth.js';
import * as bookings from './modules/bookings/bookings.service.js';
import * as fleet from './modules/fleet/fleet.service.js';
import * as inventory from './modules/inventory/inventory.service.js';
import * as network from './modules/network/network.service.js';
import * as reports from './modules/reports/reports.service.js';

export const api = Router();
const id = (v: unknown) => parse(uuidParam, v);

api.get('/health', (_req, res) => {
  res.json({ data: { status: 'ok', time: new Date().toISOString() } });
});

api.use('/auth', authRouter);

/* ------------------------------------------------ public: discovery */

api.get('/cities', async (_req, res) => {
  res.json({ data: await network.listCities() });
});

api.get('/search', async (req, res) => {
  res.json(await inventory.searchTrips(parse(inventory.SearchQuery, req.query)));
});

api.get('/trips/:tripId', async (req, res) => {
  res.json({ data: await network.getTrip(id(req.params.tripId)) });
});

api.get('/trips/:tripId/seats', async (req, res) => {
  const q = parse(inventory.SeatMapQuery, req.query);
  res.json({ data: await inventory.getSeatMap(id(req.params.tripId), q.from, q.to, req.user) });
});

/* ------------------------------------------------ passenger journey */

api.post('/trips/:tripId/holds', requireAuth, async (req, res) => {
  const hold = await inventory.createHold(actorOf(req), id(req.params.tripId), parse(inventory.CreateHoldBody, req.body));
  res.status(201).json({ data: hold });
});

api.get('/holds/:holdToken', requireAuth, async (req, res) => {
  res.json({ data: await inventory.getHold(actorOf(req), id(req.params.holdToken)) });
});

api.delete('/holds/:holdToken', requireAuth, async (req, res) => {
  res.json({ data: await inventory.releaseHold(actorOf(req), id(req.params.holdToken)) });
});

api.post('/bookings', requireAuth, async (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (any unique string per checkout)');
  const result = await bookings.createBooking(
    actorOf(req),
    parse(bookings.IdempotencyKey, key),
    parse(bookings.CreateBookingBody, req.body),
  );
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
});

api.get('/bookings', requireAuth, async (req, res) => {
  res.json(await bookings.listBookings(actorOf(req), parse(bookings.BookingQuery, req.query)));
});

api.get('/bookings/:pnr', requireAuth, async (req, res) => {
  res.json({ data: await bookings.getBookingForActor(actorOf(req), String(req.params.pnr)) });
});

api.get('/bookings/:pnr/cancellation-quote', requireAuth, async (req, res) => {
  const ticketIds =
    typeof req.query.ticketIds === 'string' && req.query.ticketIds
      ? parse(z.array(uuidParam), req.query.ticketIds.split(','))
      : undefined;
  res.json({ data: await bookings.getCancellationQuote(actorOf(req), String(req.params.pnr), ticketIds) });
});

api.post('/bookings/:pnr/cancel', requireAuth, async (req, res) => {
  res.json({ data: await bookings.cancelBooking(actorOf(req), String(req.params.pnr), parse(bookings.CancelBody, req.body ?? {})) });
});

/* ------------------------------------------------ staff: fleet & network */

api.get('/operators', requireStaff, async (req, res) => {
  res.json({ data: await fleet.listOperators(actorOf(req)) });
});
api.post('/operators', requireRole('ADMIN'), async (req, res) => {
  res.status(201).json({ data: await fleet.createOperator(actorOf(req), parse(fleet.CreateOperatorBody, req.body)) });
});
api.patch('/operators/:operatorId', requireRole('ADMIN'), async (req, res) => {
  res.json({ data: await fleet.updateOperator(actorOf(req), id(req.params.operatorId), parse(fleet.UpdateOperatorBody, req.body)) });
});
api.post('/operators/:operatorId/staff', requireStaff, async (req, res) => {
  res.status(201).json({
    data: await fleet.createOperatorStaff(actorOf(req), id(req.params.operatorId), parse(fleet.CreateStaffBody, req.body)),
  });
});
api.get('/operators/:operatorId/cancellation-policy', requireStaff, async (req, res) => {
  res.json({ data: await fleet.getCancellationPolicy(actorOf(req), id(req.params.operatorId)) });
});
api.put('/operators/:operatorId/cancellation-policy', requireStaff, async (req, res) => {
  res.json({
    data: await fleet.updateCancellationPolicy(actorOf(req), id(req.params.operatorId), parse(fleet.UpdatePolicyBody, req.body)),
  });
});

api.get('/seat-layouts', requireStaff, async (req, res) => {
  res.json({ data: await fleet.listLayouts(actorOf(req)) });
});
api.get('/seat-layouts/:layoutId', requireStaff, async (req, res) => {
  res.json({ data: await fleet.getLayout(id(req.params.layoutId)) });
});
api.post('/seat-layouts', requireStaff, async (req, res) => {
  res.status(201).json({ data: await fleet.createLayout(actorOf(req), parse(fleet.CreateLayoutBody, req.body)) });
});

api.get('/buses', requireStaff, async (req, res) => {
  res.json(await fleet.listBuses(actorOf(req), parse(fleet.BusQuery, req.query)));
});
api.post('/buses', requireStaff, async (req, res) => {
  res.status(201).json({ data: await fleet.createBus(actorOf(req), parse(fleet.CreateBusBody, req.body)) });
});
api.patch('/buses/:busId', requireStaff, async (req, res) => {
  res.json({ data: await fleet.updateBus(actorOf(req), id(req.params.busId), parse(fleet.UpdateBusBody, req.body)) });
});

api.get('/routes', requireStaff, async (req, res) => {
  res.json(await network.listRoutes(actorOf(req), parse(network.RouteQuery, req.query)));
});
api.get('/routes/:routeId', requireStaff, async (req, res) => {
  res.json({ data: await network.getRoute(actorOf(req), id(req.params.routeId)) });
});
api.post('/routes', requireStaff, async (req, res) => {
  res.status(201).json({ data: await network.createRoute(actorOf(req), parse(network.CreateRouteBody, req.body)) });
});
api.patch('/routes/:routeId', requireStaff, async (req, res) => {
  res.json({ data: await network.updateRoute(actorOf(req), id(req.params.routeId), parse(network.UpdateRouteBody, req.body)) });
});

api.get('/schedules', requireStaff, async (req, res) => {
  res.json({ data: await network.listSchedules(actorOf(req)) });
});
api.post('/schedules', requireStaff, async (req, res) => {
  res.status(201).json({ data: await network.createSchedule(actorOf(req), parse(network.CreateScheduleBody, req.body)) });
});
api.patch('/schedules/:scheduleId', requireStaff, async (req, res) => {
  res.json({ data: await network.updateSchedule(actorOf(req), id(req.params.scheduleId), parse(network.UpdateScheduleBody, req.body)) });
});
api.post('/schedules/:scheduleId/generate-trips', requireStaff, async (req, res) => {
  res.status(201).json({
    data: await network.generateTrips(actorOf(req), id(req.params.scheduleId), parse(network.GenerateTripsBody, req.body)),
  });
});

api.get('/staff/trips', requireStaff, async (req, res) => {
  res.json(await network.listTrips(actorOf(req), parse(network.TripQuery, req.query)));
});
api.patch('/trips/:tripId/status', requireStaff, async (req, res) => {
  res.json({ data: await network.changeTripStatus(actorOf(req), id(req.params.tripId), parse(network.TripStatusBody, req.body)) });
});

/* ------------------------------------------------ staff: refunds, reports, audit */

api.get('/refunds', requireStaff, async (req, res) => {
  res.json(await bookings.listRefunds(actorOf(req), parse(bookings.RefundQuery, req.query)));
});
api.post('/refunds/:refundId/transition', requireStaff, async (req, res) => {
  res.json({
    data: await bookings.transitionRefund(actorOf(req), id(req.params.refundId), parse(bookings.RefundTransitionBody, req.body)),
  });
});

api.get('/reports/dashboard', requireStaff, async (req, res) => {
  res.json({ data: await reports.getDashboard(actorOf(req)) });
});
api.get('/reports/trips/:tripId/manifest', requireStaff, async (req, res) => {
  const manifest = await reports.getManifest(actorOf(req), id(req.params.tripId));
  if (req.query.format === 'csv') {
    res
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="manifest-${manifest.trip.routeCode}-${manifest.trip.serviceDate}.csv"`)
      .send(reports.manifestToCsv(manifest));
    return;
  }
  res.json({ data: manifest });
});
api.get('/reports/trips/:tripId/occupancy', requireStaff, async (req, res) => {
  res.json({ data: await reports.getOccupancy(actorOf(req), id(req.params.tripId)) });
});
api.get('/reports/trips/:tripId/reconciliation', requireStaff, async (req, res) => {
  res.json({ data: await reports.getReconciliation(actorOf(req), id(req.params.tripId)) });
});
api.get('/reports/booking-summary', requireStaff, async (req, res) => {
  res.json({ data: await reports.getBookingSummary(actorOf(req), parse(reports.SummaryQuery, req.query)) });
});
api.get('/reports/route-schedules', requireStaff, async (req, res) => {
  res.json({ data: await reports.getRouteSchedules(actorOf(req), parse(reports.RouteScheduleQuery, req.query)) });
});

api.get('/audit-logs', requireStaff, async (req, res) => {
  res.json(await listAuditLogs(actorOf(req), parse(AuditQuery, req.query)));
});

