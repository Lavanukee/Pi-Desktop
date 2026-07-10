import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The wrapper is pure Node (spawn framing against a fake child); no DOM.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
