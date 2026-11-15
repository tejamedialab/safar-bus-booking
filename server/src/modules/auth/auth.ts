import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isTest } from '../../config/env.js';
import { queryOne, withTransaction } from '../../db/pool.js';
import { AppError, conflict } from '../../lib/errors.js';
import { parse, type AuthUser } from '../../lib/http.js';
import { AUTH_COOKIE, requireAuth, signSession } from '../../middleware/auth.js';
import { audit } from '../audit/audit.service.js';

export const RegisterBody = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number'),
  password: z
    .string()
    .min(8, 'At least 8 characters')
    .max(72)
    .regex(/[A-Za-z]/, 'Include a letter')
    .regex(/\d/, 'Include a number'),
});

export const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(72),
});

const USER_COLUMNS = `id, email, full_name AS "fullName", role, operator_id AS "operatorId"`;

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, isTest ? 4 : 10);
}

export async function registerPassenger(body: z.infer<typeof RegisterBody>, requestId: string): Promise<AuthUser> {
  return withTransaction(async (tx) => {
    const exists = await queryOne('SELECT 1 FROM users WHERE email = $1', [body.email], tx);
    if (exists) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    const user = (await queryOne<AuthUser>(
      `INSERT INTO users (email, password_hash, full_name, phone, role)
       VALUES ($1, $2, $3, $4, 'PASSENGER') RETURNING ${USER_COLUMNS}`,
      [body.email, await hashPassword(body.password), body.fullName, body.phone],
      tx,
    ))!;
    await audit(tx, { ...user, requestId }, { action: 'USER_REGISTERED', entityType: 'user', entityId: user.id });
    return user;
  });
}

// A real bcrypt hash of a random string: comparing against it keeps login timing constant
// whether or not the email exists (no user enumeration through response time).
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', isTest ? 4 : 10);

export async function verifyLogin(body: z.infer<typeof LoginBody>): Promise<AuthUser> {
  const row = await queryOne<AuthUser & { passwordHash: string; isActive: boolean }>(
    `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash", is_active AS "isActive" FROM users WHERE email = $1`,
    [body.email],
  );
  const ok = await bcrypt.compare(body.password, row?.passwordHash ?? DUMMY_HASH);
  if (!row || !ok || !row.isActive) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  const { passwordHash: _p, isActive: _a, ...user } = row;
  return user;
}

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  maxAge: env.JWT_TTL_HOURS * 3600 * 1000,
  path: '/',
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 10_000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many login attempts. Try again in a few minutes.')),
});

export const authRouter = Router();

authRouter.post('/register', loginLimiter, async (req, res) => {
  const user = await registerPassenger(parse(RegisterBody, req.body), req.requestId);
  const token = signSession(user.id);
  res.cookie(AUTH_COOKIE, token, cookieOptions).status(201).json({ data: { user, token } });
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const user = await verifyLogin(parse(LoginBody, req.body));
  const token = signSession(user.id);
  res.cookie(AUTH_COOKIE, token, cookieOptions).json({ data: { user, token } });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE, { path: '/' }).status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const operator = req.user!.operatorId
    ? await queryOne('SELECT id, name, code FROM operators WHERE id = $1', [req.user!.operatorId])
    : null;
  res.json({ data: { user: req.user, operator } });
});
