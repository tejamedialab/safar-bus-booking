import 'dotenv/config';
import { z } from 'zod';

/**
 * All configuration comes from environment variables and is validated once at startup,
 * so a misconfigured deployment fails fast instead of misbehaving later.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url().default('postgres://postgres:postgres@localhost:5432/safar'),
  TEST_DATABASE_URL: z.string().url().default('postgres://postgres:postgres@localhost:5432/safar_test'),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  JWT_TTL_HOURS: z.coerce.number().int().positive().default(12),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  HOLD_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  BOOKING_CUTOFF_MINUTES: z.coerce.number().int().min(0).default(30),
  MAX_SEATS_PER_BOOKING: z.coerce.number().int().min(1).max(10).default(6),
  BUSINESS_TIMEZONE: z.string().default('Asia/Kolkata'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  SEED_ON_EMPTY: z.enum(['true', 'false']).default('false'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

if (env.NODE_ENV === 'production' && env.JWT_SECRET === 'dev-only-secret-change-me-please') {
  // eslint-disable-next-line no-console
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}

export const isTest = env.NODE_ENV === 'test';
