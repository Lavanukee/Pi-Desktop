import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The bridge lifecycle suite spawns the real mock-pi child process.
    testTimeout: 15000,
  },
});
