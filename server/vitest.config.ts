import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    globalSetup: ['./test/global-setup.ts'],
    // All API tests share one Postgres test database, so files run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
});
