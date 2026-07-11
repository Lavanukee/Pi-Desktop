import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom for React component render assertions (mirrors @pi-desktop/canvas).
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
