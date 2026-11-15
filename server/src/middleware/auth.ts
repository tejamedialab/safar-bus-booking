import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { queryOne } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { AuthUser, Role } from '../lib/http.js';

export const AUTH_COOKIE = 'safar_session';

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: `${env.JWT_TTL_HOURS}h`, algorithm: 'HS256' });
}

function readToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return req.cookies?.[AUTH_COOKIE];
}

/**
 * Resolves the session (httpOnly cookie for the browser, Bearer token for API clients/tests).
 * The user is re-loaded from the database on every request, so a deactivated user or a
 * changed role takes effect immediately — the token only proves identity, never permissions.
 */
export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as { sub: string };
    const user = await queryOne<AuthUser & { isActive: boolean }>(
      `SELECT id, email, full_name AS "fullName", role, operator_id AS "operatorId", is_active AS "isActive"
         FROM users WHERE id = $1`,
      [payload.sub],
    );
    if (user?.isActive) {
      const { isActive: _ignored, ...rest } = user;
      req.user = rest;
    }
  } catch {
    // invalid/expired token → treated as anonymous; protected routes will return 401
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

/** Server-side role gate. The UI hides buttons too, but this is what actually protects the API. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

export const requireStaff = requireRole('ADMIN', 'OPERATOR');
