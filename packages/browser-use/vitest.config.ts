import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The DOM-extraction script is exercised against a jsdom document that the
    // test constructs explicitly (JSDOM import), so a Node environment is fine
    // and keeps the tool/bridge unit tests free of DOM globals.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
