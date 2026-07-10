import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The env-guarded live tests actually drive osascript against the real
    // Calendar/Reminders/Contacts apps, which can be slow on a first, cold,
    // permission-prompted access. Give them room; the unit tests are fast.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
