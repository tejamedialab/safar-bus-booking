import { closePool, getPool } from './pool.js';
import { dropAll, migrate } from './migrate.js';
import { seed } from './seed.js';

const cmd = process.argv[2];

async function run() {
  const pool = getPool();
  if (cmd === 'migrate') {
    const applied = await migrate(pool, console.log);
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
  } else if (cmd === 'seed') {
    await migrate(pool);
    await seed();
  } else if (cmd === 'reset') {
    await dropAll(pool);
    await migrate(pool, console.log);
    await seed();
  } else {
    console.error('Usage: tsx src/db/cli.ts <migrate|seed|reset>');
    process.exitCode = 1;
  }
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
