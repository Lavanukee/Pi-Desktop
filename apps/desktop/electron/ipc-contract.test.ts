import { describe, expect, it } from 'vitest';
import { APP_INVOKE_CHANNELS } from './ipc-contract';

// Exhaustiveness (every AppInvokeMap channel is listed) is a compile-time
// assertion in ipc-contract.ts; these guard the runtime shape the preload
// allowlist is built from.
describe('APP_INVOKE_CHANNELS', () => {
  it('contains no duplicates', () => {
    expect(new Set(APP_INVOKE_CHANNELS).size).toBe(APP_INVOKE_CHANNELS.length);
  });

  it('uses domain:action kebab-case names only', () => {
    for (const channel of APP_INVOKE_CHANNELS) {
      expect(channel).toMatch(/^[a-z]+:[a-z]+(-[a-z]+)*$/);
    }
  });
});
