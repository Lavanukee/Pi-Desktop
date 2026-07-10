import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The real-fixture + live tests spawn child processes; keep generous
    // headroom (the live path can invoke the on-device model).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
