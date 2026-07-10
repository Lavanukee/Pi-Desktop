import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The downloader/supervisor suites spin up local fixture servers and fake
    // children; the guarded integration test downloads a 3GB model.
    testTimeout: 30_000,
  },
});
