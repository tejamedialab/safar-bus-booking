import { z } from 'zod';
import { query, type Db } from '../../db/pool.js';
import { type Actor, isoDate, operatorScope, pageMeta, PaginationQuery } from '../../lib/http.js';

export interface AuditEntry {
  action: string; // e.g. BOOKING_CONFIRMED, TRIP_CANCELLED
  entityType: string; // e.g. booking, trip
  entityId: string;
  operatorId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Writes an audit record using the SAME transaction as the business change,
 * so an action and its audit entry are committed (or rolled back) together.
 */
export async function audit(db: Db, actor: Actor | null, entry: AuditEntry): Promise<void> {
  await query(
    `INSERT INTO audit_logs (actor_id, actor_role, operator_id, action, entity_type, entity_id, details, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actor?.id ?? null,
      actor?.role ?? null,
      entry.operatorId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId,
      JSON.stringify(entry.details ?? {}),
      actor?.requestId ?? null,
    ],
    db,
  );
}

export const AuditQuery = PaginationQuery.extend({
  action: z.string().max(60).optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(80).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export async function listAuditLogs(actor: Actor, q: z.infer<typeof AuditQuery>) {
  const scope = operatorScope(actor);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (scope) add('a.operator_id = ?', scope);
  if (q.action) add('a.action = ?', q.action);
  if (q.entityType) add('a.entity_type = ?', q.entityType);
  if (q.entityId) add('a.entity_id = ?', q.entityId);
  if (q.from) add(`a.created_at >= (?::date AT TIME ZONE 'Asia/Kolkata')`, q.from);
  if (q.to) add(`a.created_at < ((?::date + 1) AT TIME ZONE 'Asia/Kolkata')`, q.to);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [{ total }] = await query<{ total: number }>(`SELECT count(*) AS total FROM audit_logs a ${whereSql}`, params);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await query(
    `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.details,
            a.actor_role AS "actorRole", u.full_name AS "actorName", u.email AS "actorEmail",
            a.request_id AS "requestId", a.created_at AS "createdAt"
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ${whereSql}
      ORDER BY a.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { data: rows, meta: pageMeta(q.page, q.pageSize, total) };
}
