import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The guarded end-to-end test downloads the llama.cpp binary + a 3GB GGUF
    // and spawns a real server, so give it generous headroom.
    testTimeout: 20 * 60_000,
    hookTimeout: 20 * 60_000,
  },
});
