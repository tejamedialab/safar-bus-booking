import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool, getPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';

async function main() {
  // Migrations are idempotent and lock-protected, so running them on boot is safe.
  await migrate(getPool(), (m) => logger.info(m));
  if (env.SEED_ON_EMPTY === 'true') {
    // Demo deployments start with data; seed() is a no-op once any user exists.
    const { seed } = await import('./db/seed.js');
    await seed((m) => logger.info(m));
  }
  const server = createApp().listen(env.PORT, () => {
    logger.info(`Safar API listening on http://localhost:${env.PORT} (docs: /api/docs)`);
  });
  const shutdown = () => {
    logger.info('Shutting down');
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
