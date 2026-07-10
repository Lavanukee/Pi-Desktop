import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The mock-server suite spawns a real Node child; the env-guarded
    // filesystem integration test (PI_MCP_INTEGRATION=1) may download an npx
    // package on first run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
