import pg from 'pg';
import { env } from '../config/env.js';

// Return Postgres DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);
// bigint counts (e.g. COUNT(*)) fit comfortably in a JS number for this domain.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric -> number (fare multipliers, percentages)
pg.types.setTypeParser(1700, (v) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = env.NODE_ENV === 'test' ? env.TEST_DATABASE_URL : env.DATABASE_URL;
    pool = new pg.Pool({
      connectionString,
      max: 20,
      ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Anything that can run a query: the pool or a client inside a transaction. */
export type Db = Pick<pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Db = getPool(),
): Promise<T[]> {
  const res = await db.query<T>(text, params as any[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Db = getPool(),
): Promise<T | undefined> {
  const rows = await query<T>(text, params, db);
  return rows[0];
}

/**
 * Runs `fn` inside a single database transaction. Commits on success, rolls back on any error.
 * Every multi-step business action (hold, book, cancel, generate trips) goes through here.
 */
export async function withTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
