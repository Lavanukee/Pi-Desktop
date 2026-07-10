/**
 * Browser entry bundled by `scripts/build-harness.mjs` into
 * `harness/harness.js` (morphdom inlined). This file is the ONLY thing that
 * runs the harness against the real `window`; the logic lives in
 * `harness-runtime.ts` / `patcher.ts` so it can be unit-tested in jsdom.
 */
import { startHarness } from './harness-runtime.ts';

startHarness(window);
