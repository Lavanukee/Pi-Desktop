import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure Node: tool arg-parsing against a fake bridge + socket framing.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
