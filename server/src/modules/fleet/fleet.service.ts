import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { CancellationRulesSchema, DEFAULT_CANCELLATION_RULES } from '../../domain/cancellation.js';
import { generateLayout } from '../../domain/layout.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import {
  type Actor,
  assertOperatorAccess,
  operatorScope,
  pageMeta,
  PaginationQuery,
  uuidParam,
} from '../../lib/http.js';
import { hashPassword } from '../auth/auth.js';
import { audit } from '../audit/audit.service.js';

// ---------------------------------------------------------------- operators

export const CreateOperatorBody = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/, '2–5 letters'),
  contactEmail: z.string().trim().toLowerCase().email(),
  contactPhone: z.string().trim().regex(/^[6-9]\d{9}$/, '10-digit mobile number'),
});

export const UpdateOperatorBody = CreateOperatorBody.omit({ code: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });

export const CreateStaffBody = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(72),
});

const OPERATOR_COLS = `o.id, o.name, o.code, o.contact_email AS "contactEmail", o.contact_phone AS "contactPhone",
  o.is_active AS "isActive", o.created_at AS "createdAt"`;

export async function listOperators(actor: Actor) {
  const scope = operatorScope(actor);
  return query(
    `SELECT ${OPERATOR_COLS},
            (SELECT count(*) FROM buses b WHERE b.operator_id = o.id) AS "busCount",
            (SELECT count(*) FROM routes r WHERE r.operator_id = o.id) AS "routeCount"
       FROM operators o
      WHERE ($1::uuid IS NULL OR o.id = $1)
      ORDER BY o.name`,
    [scope],
  );
}

export async function createOperator(actor: Actor, body: z.infer<typeof CreateOperatorBody>) {
  return withTransaction(async (tx) => {
    const policy = await queryOne<{ id: string }>(
      `INSERT INTO cancellation_policies (name, rules) VALUES ($1, $2) RETURNING id`,
      [`${body.code} standard policy`, JSON.stringify(DEFAULT_CANCELLATION_RULES)],
      tx,
    );
    const op = await queryOne(
      `INSERT INTO operators (name, code, contact_email, contact_phone, cancellation_policy_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, code, contact_email AS "contactEmail", contact_phone AS "contactPhone", is_active AS "isActive"`,
      [body.name, body.code, body.contactEmail, body.contactPhone, policy!.id],
      tx,
    );
    await audit(tx, actor, { action: 'OPERATOR_CREATED', entityType: 'operator', entityId: op.id, operatorId: op.id, details: body });
    return op;
  });
}

export async function updateOperator(actor: Actor, id: string, body: z.infer<typeof UpdateOperatorBody>) {
  return withTransaction(async (tx) => {
    const op = await queryOne(
      `UPDATE operators SET
         name = COALESCE($2, name), contact_email = COALESCE($3, contact_email),
         contact_phone = COALESCE($4, contact_phone), is_active = COALESCE($5, is_active)
       WHERE id = $1
       RETURNING id, name, code, contact_email AS "contactEmail", contact_phone AS "contactPhone", is_active AS "isActive"`,
      [id, body.name ?? null, body.contactEmail ?? null, body.contactPhone ?? null, body.isActive ?? null],
      tx,
    );
    if (!op) throw notFound('Operator');
    await audit(tx, actor, { action: 'OPERATOR_UPDATED', entityType: 'operator', entityId: id, operatorId: id, details: body });
    return op;
  });
}

export async function createOperatorStaff(actor: Actor, operatorId: string, body: z.infer<typeof CreateStaffBody>) {
  assertOperatorAccess(actor, operatorId);
  return withTransaction(async (tx) => {
    if (await queryOne('SELECT 1 FROM users WHERE email = $1', [body.email], tx)) {
      throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    const user = await queryOne(
      `INSERT INTO users (email, password_hash, full_name, role, operator_id)
       VALUES ($1, $2, $3, 'OPERATOR', $4)
       RETURNING id, email, full_name AS "fullName", role, operator_id AS "operatorId"`,
      [body.email, await hashPassword(body.password), body.fullName, operatorId],
      tx,
    );
    await audit(tx, actor, { action: 'STAFF_CREATED', entityType: 'user', entityId: user.id, operatorId, details: { email: body.email } });
    return user;
  });
}

// ---------------------------------------------------------------- cancellation policy

export const UpdatePolicyBody = z.object({ rules: CancellationRulesSchema });

export async function getCancellationPolicy(actor: Actor, operatorId: string) {
  assertOperatorAccess(actor, operatorId);
  const row = await queryOne(
    `SELECT p.id, p.name, p.rules, p.updated_at AS "updatedAt"
       FROM operators o JOIN cancellation_policies p ON p.id = o.cancellation_policy_id
      WHERE o.id = $1`,
    [operatorId],
  );
  if (!row) throw notFound('Operator');
  return row;
}

/** Changing the policy affects NEW bookings only; existing bookings keep their snapshot. */
export async function updateCancellationPolicy(actor: Actor, operatorId: string, body: z.infer<typeof UpdatePolicyBody>) {
  assertOperatorAccess(actor, operatorId);
  const rules = [...body.rules].sort((a, b) => b.minHoursBeforeDeparture - a.minHoursBeforeDeparture);
  return withTransaction(async (tx) => {
    const before = await queryOne(
      `SELECT p.id, p.rules FROM operators o JOIN cancellation_policies p ON p.id = o.cancellation_policy_id
        WHERE o.id = $1 FOR UPDATE OF p`,
      [operatorId],
      tx,
    );
    if (!before) throw notFound('Operator');
    const row = await queryOne(
      `UPDATE cancellation_policies SET rules = $2, updated_at = now() WHERE id = $1
       RETURNING id, name, rules, updated_at AS "updatedAt"`,
      [before.id, JSON.stringify(rules)],
      tx,
    );
    await audit(tx, actor, {
      action: 'CANCELLATION_POLICY_UPDATED',
      entityType: 'operator',
      entityId: operatorId,
      operatorId,
      details: { before: before.rules, after: rules },
    });
    return row;
  });
}

// ---------------------------------------------------------------- seat layouts

export const CreateLayoutBody = z.object({
  name: z.string().trim().min(3).max(80),
  seatType: z.enum(['SEATER', 'SLEEPER']),
  configuration: z.enum(['1+1', '2+1', '2+2']),
  rows: z.number().int().min(2).max(15),
  decks: z.union([z.literal(1), z.literal(2)]),
  lowerDeckFareFactor: z.number().min(0.5).max(3).optional(),
  operatorId: uuidParam.optional(),
});

export async function listLayouts(actor: Actor) {
  const scope = operatorScope(actor);
  return query(
    `SELECT l.id, l.name, l.decks, l.grid_rows AS "gridRows", l.grid_cols AS "gridCols", l.operator_id AS "operatorId",
            count(s.*) AS "seatCount",
            count(s.*) FILTER (WHERE s.seat_type = 'SLEEPER') AS "sleeperCount"
       FROM seat_layouts l LEFT JOIN layout_seats s ON s.layout_id = l.id
      WHERE $1::uuid IS NULL OR l.operator_id IS NULL OR l.operator_id = $1
      GROUP BY l.id ORDER BY l.name`,
    [scope],
  );
}

export async function getLayout(layoutId: string) {
  const layout = await queryOne(
    `SELECT id, name, decks, grid_rows AS "gridRows", grid_cols AS "gridCols", operator_id AS "operatorId"
       FROM seat_layouts WHERE id = $1`,
    [layoutId],
  );
  if (!layout) throw notFound('Seat layout');
  layout.seats = await query(
    `SELECT label, deck, grid_row AS "gridRow", grid_col AS "gridCol", seat_type AS "seatType",
            is_window AS "isWindow", fare_factor AS "fareFactor"
       FROM layout_seats WHERE layout_id = $1 ORDER BY deck, grid_row, grid_col`,
    [layoutId],
  );
  return layout;
}

export async function createLayout(actor: Actor, body: z.infer<typeof CreateLayoutBody>) {
  if (body.seatType === 'SEATER' && body.decks === 2) {
    throw badRequest('INVALID_LAYOUT', 'Double-deck layouts are supported for sleepers only');
  }
  const operatorId = actor.role === 'OPERATOR' ? actor.operatorId : body.operatorId ?? null;
  const { gridCols, seats } = generateLayout(body);
  return withTransaction(async (tx) => {
    const layout = await queryOne<{ id: string }>(
      `INSERT INTO seat_layouts (operator_id, name, decks, grid_rows, grid_cols) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [operatorId, body.name, body.decks, body.rows, gridCols],
      tx,
    );
    await tx.query(
      `INSERT INTO layout_seats (layout_id, label, deck, grid_row, grid_col, seat_type, is_window, fare_factor)
       SELECT $1, s.label, s.deck, s.grid_row, s.grid_col, s.seat_type::seat_type, s.is_window, s.fare_factor
         FROM jsonb_to_recordset($2::jsonb) AS s(label text, deck int, grid_row int, grid_col int, seat_type text, is_window boolean, fare_factor numeric)`,
      [
        layout!.id,
        JSON.stringify(
          seats.map((s) => ({
            label: s.label,
            deck: s.deck,
            grid_row: s.gridRow,
            grid_col: s.gridCol,
            seat_type: s.seatType,
            is_window: s.isWindow,
            fare_factor: s.fareFactor,
          })),
        ),
      ],
    );
    await audit(tx, actor, {
      action: 'SEAT_LAYOUT_CREATED',
      entityType: 'seat_layout',
      entityId: layout!.id,
      operatorId,
      details: { ...body, seatCount: seats.length },
    });
    return { id: layout!.id, name: body.name, seatCount: seats.length, gridCols, decks: body.decks };
  });
}

// ---------------------------------------------------------------- buses

const BUS_TYPES = ['AC_SLEEPER', 'NON_AC_SLEEPER', 'AC_SEATER', 'NON_AC_SEATER', 'VOLVO_MULTI_AXLE'] as const;

export const CreateBusBody = z.object({
  operatorId: uuidParam.optional(),
  registrationNo: z
    .string()
    .trim()
    .toUpperCase()
    .transform((s) => s.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/, 'Format like TS09AB1234')),
  busType: z.enum(BUS_TYPES),
  seatLayoutId: uuidParam,
  amenities: z.array(z.string().trim().min(2).max(30)).max(12).default([]),
});
export const UpdateBusBody = z.object({
  busType: z.enum(BUS_TYPES).optional(),
  amenities: z.array(z.string().trim().min(2).max(30)).max(12).optional(),
  isActive: z.boolean().optional(),
});
export const BusQuery = PaginationQuery.extend({
  q: z.string().trim().max(40).optional(),
  operatorId: uuidParam.optional(),
  active: z.enum(['true', 'false']).optional(),
});

const BUS_COLS = `b.id, b.registration_no AS "registrationNo", b.bus_type AS "busType", b.amenities, b.is_active AS "isActive",
  b.operator_id AS "operatorId", o.name AS "operatorName", b.seat_layout_id AS "seatLayoutId", l.name AS "layoutName",
  (SELECT count(*) FROM layout_seats s WHERE s.layout_id = b.seat_layout_id) AS "seatCount"`;

export async function listBuses(actor: Actor, q: z.infer<typeof BusQuery>) {
  const scope = operatorScope(actor) ?? q.operatorId ?? null;
  const params = [scope, q.q ? `%${q.q.toUpperCase()}%` : null, q.active ? q.active === 'true' : null];
  const where = `WHERE ($1::uuid IS NULL OR b.operator_id = $1) AND ($2::text IS NULL OR b.registration_no LIKE $2)
                   AND ($3::boolean IS NULL OR b.is_active = $3)`;
  const [{ total }] = await query(`SELECT count(*) AS total FROM buses b ${where}`, params);
  const rows = await query(
    `SELECT ${BUS_COLS} FROM buses b JOIN operators o ON o.id = b.operator_id JOIN seat_layouts l ON l.id = b.seat_layout_id
     ${where} ORDER BY o.name, b.registration_no LIMIT $4 OFFSET $5`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return { data: rows, meta: pageMeta(q.page, q.pageSize, total) };
}

export async function createBus(actor: Actor, body: z.infer<typeof CreateBusBody>) {
  const operatorId = actor.role === 'OPERATOR' ? actor.operatorId! : body.operatorId;
  if (!operatorId) throw badRequest('OPERATOR_REQUIRED', 'operatorId is required for admins');
  assertOperatorAccess(actor, operatorId);
  const layout = await queryOne('SELECT operator_id FROM seat_layouts WHERE id = $1', [body.seatLayoutId]);
  if (!layout) throw notFound('Seat layout');
  if (layout.operator_id && layout.operator_id !== operatorId) throw forbidden('That layout belongs to another operator');
  return withTransaction(async (tx) => {
    const bus = await queryOne(
      `INSERT INTO buses (operator_id, registration_no, bus_type, seat_layout_id, amenities)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [operatorId, body.registrationNo, body.busType, body.seatLayoutId, body.amenities],
      tx,
    ).catch((e) => {
      if (e.code === '23505') throw conflict('REGISTRATION_TAKEN', 'A bus with this registration number already exists');
      throw e;
    });
    await audit(tx, actor, { action: 'BUS_CREATED', entityType: 'bus', entityId: bus.id, operatorId, details: body });
    return queryOne(
      `SELECT ${BUS_COLS} FROM buses b JOIN operators o ON o.id = b.operator_id JOIN seat_layouts l ON l.id = b.seat_layout_id WHERE b.id = $1`,
      [bus.id],
      tx,
    );
  });
}

export async function updateBus(actor: Actor, id: string, body: z.infer<typeof UpdateBusBody>) {
  const bus = await queryOne('SELECT operator_id FROM buses WHERE id = $1', [id]);
  if (!bus) throw notFound('Bus');
  assertOperatorAccess(actor, bus.operator_id);
  return withTransaction(async (tx) => {
    await tx.query(
      `UPDATE buses SET bus_type = COALESCE($2, bus_type), amenities = COALESCE($3, amenities), is_active = COALESCE($4, is_active)
        WHERE id = $1`,
      [id, body.busType ?? null, body.amenities ?? null, body.isActive ?? null],
    );
    await audit(tx, actor, { action: 'BUS_UPDATED', entityType: 'bus', entityId: id, operatorId: bus.operator_id, details: body });
    return queryOne(
      `SELECT ${BUS_COLS} FROM buses b JOIN operators o ON o.id = b.operator_id JOIN seat_layouts l ON l.id = b.seat_layout_id WHERE b.id = $1`,
      [id],
      tx,
    );
  });
}
