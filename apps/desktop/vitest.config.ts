import { defineConfig } from 'vitest/config';

// Standalone config: vitest must not load vite.config.ts, which would start
// the Electron plugin during unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    // electron/ tests cover electron-free seam modules only (structural
    // injection); nothing there may import the real `electron`.
    include: ['src/**/*.test.{ts,tsx}', 'electron/**/*.test.ts'],
  },
});
