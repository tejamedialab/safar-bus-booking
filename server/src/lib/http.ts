import type { Request } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { AppError, forbidden, unauthorized } from './errors.js';

export type Role = 'ADMIN' | 'OPERATOR' | 'PASSENGER';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  operatorId: string | null;
}

/** Who is acting, and for which request. Passed from routes into services. */
export interface Actor extends AuthUser {
  requestId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId: string;
    }
  }
}

/** Validates untrusted input against a Zod schema; throws a 400 with per-field messages. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Some fields are invalid',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function actorOf(req: Request): Actor {
  if (!req.user) throw unauthorized();
  return { ...req.user, requestId: req.requestId };
}

/**
 * Data-level authorization for operator staff. Admins may touch any operator;
 * operator staff only their own; passengers never.
 */
export function assertOperatorAccess(actor: AuthUser, operatorId: string): void {
  if (actor.role === 'ADMIN') return;
  if (actor.role === 'OPERATOR' && actor.operatorId === operatorId) return;
  throw forbidden('This resource belongs to another operator');
}

/** NULL for admins (no restriction), the operator id for operator staff. */
export function operatorScope(actor: AuthUser): string | null {
  if (actor.role === 'ADMIN') return null;
  if (actor.role === 'OPERATOR') return actor.operatorId;
  throw forbidden();
}

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function pageMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export const uuidParam = z.string().uuid({ message: 'Must be a valid id' });
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
