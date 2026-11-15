/**
 * Creates (if needed) and rebuilds the TEST database from scratch before the suite:
 * drop schema → run migrations → load the demo seed. Never touches the dev database.
 */
import pg from 'pg';

export default async function setup() {
  process.env.NODE_ENV = 'test';
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/safar_test');
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const { getPool, closePool } = await import('../src/db/pool.js');
  const { dropAll, migrate } = await import('../src/db/migrate.js');
  const { seed } = await import('../src/db/seed.js');
  await dropAll(getPool());
  await migrate(getPool());
  await seed(() => undefined);
  await closePool();
}
