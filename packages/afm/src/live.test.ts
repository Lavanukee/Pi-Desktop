/**
 * Live end-to-end test against the REAL compiled `pi-afm` binary + on-device
 * model. Gated behind PI_AFM_E2E=1 (and a prior `pnpm --filter @pi-desktop/afm
 * build:swift`) so the default test run needs neither the binary nor Apple
 * Intelligence. When the model is unavailable on this box, the streaming
 * assertion is skipped but the check still runs.
 */
import { describe, expect, it } from 'vitest';
import { checkAvailability } from './check.js';
import { streamAfm } from './stream.js';

const LIVE = process.env.PI_AFM_E2E === '1';

describe.skipIf(!LIVE)('AFM live (real binary)', () => {
  it('checkAvailability returns a clean result', async () => {
    const availability = await checkAvailability();
    expect(typeof availability.available).toBe('boolean');
    expect(availability.contextWindow).toBeGreaterThan(0);
    console.log('[live] availability:', JSON.stringify(availability));
  });

  it('streams real tokens when the model is available', async () => {
    const availability = await checkAvailability();
    if (!availability.available) {
      console.log(`[live] model unavailable (${availability.reason}); skipping stream`);
      return;
    }
    const deltas: string[] = [];
    const result = await streamAfm(
      { prompt: 'Say hello in one short sentence.' },
      { onDelta: (t) => deltas.push(t) },
    );
    expect(result.text.length).toBeGreaterThan(0);
    expect(deltas.length).toBeGreaterThan(0);
    console.log('[live] streamed text:', result.text);
  }, 60_000);
});
