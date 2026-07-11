import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure Node: protocol parsing, catalog shape, argv builders, and the client
    // / queue with injected fake workers. No uv / Python is spawned in unit tests
    // (the real mflux smoke is exercised out-of-band).
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
