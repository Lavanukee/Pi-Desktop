import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node: the tools run against a fake bridge, and the bridge client is tested
    // against a real Unix-socket server harness.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
