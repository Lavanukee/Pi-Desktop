import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom gives us a DOM for morphdom patching, DOMPurify, CodeMirror state,
    // and React component render assertions. The playwright-core harness spec
    // spawns a real Chromium process and is agnostic to this environment.
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    // The harness Chromium proof (tests/harness.e2e.test.ts) launches a browser.
    testTimeout: 20000,
  },
});
