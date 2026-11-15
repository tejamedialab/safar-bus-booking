import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z, type ZodTypeAny } from 'zod';
import { AuditQuery } from '../modules/audit/audit.service.js';
import { LoginBody, RegisterBody } from '../modules/auth/auth.js';
import * as bookings from '../modules/bookings/bookings.service.js';
import * as fleet from '../modules/fleet/fleet.service.js';
import * as inventory from '../modules/inventory/inventory.service.js';
import * as network from '../modules/network/network.service.js';
import * as reports from '../modules/reports/reports.service.js';

extendZodWithOpenApi(z);

/**
 * The OpenAPI spec is generated from the SAME Zod schemas the API uses for validation,
 * so the documentation cannot drift from the implementation.
 */
type Access = 'public' | 'auth' | 'staff' | 'admin';
interface Op {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  access: Access;
  description?: string;
  query?: ZodTypeAny;
  body?: ZodTypeAny;
  idempotent?: boolean;
  errors?: number[];
}

const ACCESS_NOTE: Record<Access, string> = {
  public: 'Public.',
  auth: 'Requires login (any role). Passengers see only their own data.',
  staff: 'ADMIN or OPERATOR. Operator staff are restricted to their own operator’s data.',
  admin: 'ADMIN only.',
};

const unwrap = (s: ZodTypeAny): any => ((s as any)._def?.schema ? unwrap((s as any)._def.schema) : s);

const ops: Op[] = [
  { method: 'post', path: '/auth/register', tag: 'Auth', summary: 'Register a passenger account', access: 'public', body: RegisterBody, errors: [400, 409] },
  { method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Log in (sets httpOnly session cookie and returns a bearer token)', access: 'public', body: LoginBody, errors: [400, 401, 429] },
  { method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'Log out', access: 'public' },
  { method: 'get', path: '/auth/me', tag: 'Auth', summary: 'Current user', access: 'auth', errors: [401] },

  { method: 'get', path: '/cities', tag: 'Search', summary: 'List cities', access: 'public' },
  { method: 'get', path: '/search', tag: 'Search', summary: 'Search trips by origin, destination and travel date', access: 'public', query: unwrap(inventory.SearchQuery), errors: [400] },
  { method: 'get', path: '/trips/{tripId}', tag: 'Search', summary: 'Trip details with stop timings', access: 'public', errors: [404] },
  { method: 'get', path: '/trips/{tripId}/seats', tag: 'Search', summary: 'Seat map and per-seat fare for a stop segment', access: 'public', query: inventory.SeatMapQuery, errors: [400, 404] },

  {
    method: 'post', path: '/trips/{tripId}/holds', tag: 'Booking', summary: 'Hold seats for a segment (10 min by default)', access: 'auth', body: inventory.CreateHoldBody, errors: [400, 401, 404, 409],
    description: 'Replaces any previous hold by the same user on this trip. 409 SEAT_UNAVAILABLE if a seat is booked or held by someone else for an overlapping segment.',
  },
  { method: 'get', path: '/holds/{holdToken}', tag: 'Booking', summary: 'Read an active hold', access: 'auth', errors: [410] },
  { method: 'delete', path: '/holds/{holdToken}', tag: 'Booking', summary: 'Release a hold', access: 'auth' },
  {
    method: 'post', path: '/bookings', tag: 'Booking', summary: 'Confirm a booking from a hold → PNR', access: 'auth', body: bookings.CreateBookingBody, idempotent: true, errors: [400, 401, 403, 409, 410, 422],
    description: 'Requires an `Idempotency-Key` header. Retrying with the same key and body returns the original 201 response with `Idempotent-Replayed: true`; the same key with a different body returns 422.',
  },
  { method: 'get', path: '/bookings', tag: 'Booking', summary: 'List bookings (own for passengers; operator-scoped for staff)', access: 'auth', query: bookings.BookingQuery },
  { method: 'get', path: '/bookings/{pnr}', tag: 'Booking', summary: 'Ticket details by PNR', access: 'auth', errors: [404] },
  { method: 'get', path: '/bookings/{pnr}/cancellation-quote', tag: 'Booking', summary: 'Preview refund for cancelling (query: ticketIds=comma,separated)', access: 'auth', errors: [404, 409] },
  { method: 'post', path: '/bookings/{pnr}/cancel', tag: 'Booking', summary: 'Cancel all or selected tickets under the booking’s policy snapshot', access: 'auth', body: bookings.CancelBody, errors: [404, 409] },

  { method: 'get', path: '/operators', tag: 'Fleet', summary: 'List operators', access: 'staff' },
  { method: 'post', path: '/operators', tag: 'Fleet', summary: 'Create operator (with default cancellation policy)', access: 'admin', body: fleet.CreateOperatorBody, errors: [400, 409] },
  { method: 'patch', path: '/operators/{operatorId}', tag: 'Fleet', summary: 'Update operator', access: 'admin', body: fleet.UpdateOperatorBody },
  { method: 'post', path: '/operators/{operatorId}/staff', tag: 'Fleet', summary: 'Create operator staff login', access: 'staff', body: fleet.CreateStaffBody, errors: [403, 409] },
  { method: 'get', path: '/operators/{operatorId}/cancellation-policy', tag: 'Fleet', summary: 'Read cancellation policy', access: 'staff' },
  { method: 'put', path: '/operators/{operatorId}/cancellation-policy', tag: 'Fleet', summary: 'Replace cancellation tiers (applies to new bookings)', access: 'staff', body: fleet.UpdatePolicyBody, errors: [400, 403] },
  { method: 'get', path: '/seat-layouts', tag: 'Fleet', summary: 'List seat layouts', access: 'staff' },
  { method: 'get', path: '/seat-layouts/{layoutId}', tag: 'Fleet', summary: 'Seat layout with seats', access: 'staff' },
  { method: 'post', path: '/seat-layouts', tag: 'Fleet', summary: 'Generate a seat layout (e.g. 2+1 sleeper, 2 decks)', access: 'staff', body: fleet.CreateLayoutBody },
  { method: 'get', path: '/buses', tag: 'Fleet', summary: 'List buses', access: 'staff', query: fleet.BusQuery },
  { method: 'post', path: '/buses', tag: 'Fleet', summary: 'Add bus', access: 'staff', body: fleet.CreateBusBody, errors: [400, 403, 409] },
  { method: 'patch', path: '/buses/{busId}', tag: 'Fleet', summary: 'Update bus', access: 'staff', body: fleet.UpdateBusBody },

  { method: 'get', path: '/routes', tag: 'Network', summary: 'List routes', access: 'staff', query: network.RouteQuery },
  { method: 'get', path: '/routes/{routeId}', tag: 'Network', summary: 'Route with stops and schedules', access: 'staff' },
  { method: 'post', path: '/routes', tag: 'Network', summary: 'Create route with ordered stops and cumulative fares', access: 'staff', body: network.CreateRouteBody, errors: [400, 409] },
  { method: 'patch', path: '/routes/{routeId}', tag: 'Network', summary: 'Rename / activate / deactivate route', access: 'staff', body: network.UpdateRouteBody },
  { method: 'get', path: '/schedules', tag: 'Network', summary: 'List schedules', access: 'staff' },
  { method: 'post', path: '/schedules', tag: 'Network', summary: 'Create recurring schedule', access: 'staff', body: network.CreateScheduleBody, errors: [400, 409] },
  { method: 'patch', path: '/schedules/{scheduleId}', tag: 'Network', summary: 'Update schedule', access: 'staff', body: network.UpdateScheduleBody },
  { method: 'post', path: '/schedules/{scheduleId}/generate-trips', tag: 'Network', summary: 'Generate dated trips (skips existing dates and bus conflicts)', access: 'staff', body: unwrap(network.GenerateTripsBody) },
  { method: 'get', path: '/staff/trips', tag: 'Network', summary: 'List trips with sales', access: 'staff', query: network.TripQuery },
  {
    method: 'patch', path: '/trips/{tripId}/status', tag: 'Network', summary: 'Change trip status', access: 'staff', body: network.TripStatusBody, errors: [400, 403, 409],
    description: 'SCHEDULED→DEPARTED→COMPLETED, SCHEDULED→CANCELLED. Cancelling refunds every active ticket 100%.',
  },

  { method: 'get', path: '/refunds', tag: 'Refunds', summary: 'List refunds', access: 'staff', query: bookings.RefundQuery },
  { method: 'post', path: '/refunds/{refundId}/transition', tag: 'Refunds', summary: 'Simulate gateway outcome: PENDING→PROCESSED|FAILED, FAILED→PENDING', access: 'staff', body: bookings.RefundTransitionBody, errors: [409] },

  { method: 'get', path: '/reports/dashboard', tag: 'Reports', summary: 'KPIs, 14-day trend, upcoming departures, top routes', access: 'staff' },
  { method: 'get', path: '/reports/trips/{tripId}/manifest', tag: 'Reports', summary: 'Passenger manifest (add ?format=csv for CSV)', access: 'staff' },
  { method: 'get', path: '/reports/trips/{tripId}/occupancy', tag: 'Reports', summary: 'Segment-wise seat occupancy', access: 'staff' },
  { method: 'get', path: '/reports/trips/{tripId}/reconciliation', tag: 'Reports', summary: 'Cross-checks manifest, occupancy, tickets and money', access: 'staff' },
  { method: 'get', path: '/reports/booking-summary', tag: 'Reports', summary: 'Booking summary by day or route', access: 'staff', query: unwrap(reports.SummaryQuery) },
  { method: 'get', path: '/reports/route-schedules', tag: 'Reports', summary: 'Route timetable report', access: 'staff', query: reports.RouteScheduleQuery },
  { method: 'get', path: '/audit-logs', tag: 'Audit', summary: 'Audit trail (append-only)', access: 'staff', query: AuditQuery },
];

const ERROR_TEXT: Record<number, string> = {
  400: 'Validation error',
  401: 'Not logged in',
  403: 'Role or ownership forbids this',
  404: 'Not found',
  409: 'Conflict (seat taken, invalid state transition, duplicate)',
  410: 'Hold expired',
  422: 'Idempotency key reused with a different payload',
  429: 'Rate limited',
};

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  const ErrorBody = registry.register(
    'Error',
    z.object({
      error: z.object({
        code: z.string().openapi({ example: 'SEAT_UNAVAILABLE' }),
        message: z.string(),
        details: z.any().optional(),
        requestId: z.string(),
      }),
    }),
  );
  const Data = z.object({ data: z.any() });
  registry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  registry.registerComponent('securitySchemes', 'cookie', { type: 'apiKey', in: 'cookie', name: 'safar_session' });

  for (const op of ops) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const errors = Object.fromEntries(
      (op.errors ?? []).map((code) => [code, { description: ERROR_TEXT[code], content: { 'application/json': { schema: ErrorBody } } }]),
    );
    registry.registerPath({
      method: op.method,
      path: op.path,
      tags: [op.tag],
      summary: op.summary,
      description: [ACCESS_NOTE[op.access], op.description].filter(Boolean).join('\n\n'),
      security: op.access === 'public' ? [] : [{ bearer: [] }, { cookie: [] }],
      request: {
        params: params.length ? z.object(Object.fromEntries(params.map((p) => [p, z.string()]))) : undefined,
        query: op.query as any,
        headers: op.idempotent ? z.object({ 'Idempotency-Key': z.string().min(8).max(100) }) : undefined,
        body: op.body ? { content: { 'application/json': { schema: op.body } } } : undefined,
      },
      responses: {
        [op.method === 'post' && !op.path.includes('cancel') && !op.path.includes('transition') && !op.path.startsWith('/auth/log') ? 201 : 200]: {
          description: 'Success',
          content: { 'application/json': { schema: Data } },
        },
        ...errors,
      },
    });
  }

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Safar · Bus Booking Management System API',
      version: '1.0.0',
      description:
        'All endpoints are under `/api/v1`. Errors always look like `{ "error": { "code", "message", "details?", "requestId" } }`. ' +
        'Money is in integer paise. Times are ISO-8601 UTC; the business timezone is Asia/Kolkata.',
    },
    servers: [{ url: '/api/v1' }],
  });
}
