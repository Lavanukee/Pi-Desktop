import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The env-guarded integration test hits the live web and bootstraps uv +
    // a managed Python interpreter (first run downloads both), so give it room.
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
  },
});
