/**
 * @pi-desktop/afm — Apple Foundation Models on-device bridge.
 *
 * A Swift `pi-afm` CLI helper (packages/afm/swift) invokes the on-device
 * Foundation Models framework and speaks NDJSON over stdio; this module is the
 * electron-free Node wrapper around it:
 *   - `checkAvailability()` — capability-gate before offering the provider.
 *   - `streamAfm()`         — stream a completion, delta by delta.
 *
 * The desktop app wires this as a pi provider (see the llama-server provider for
 * the pattern): gate on `checkAvailability().available`, then back a custom
 * `streamSimple` with `streamAfm`, resolving the binary via the app's
 * bundle-relative path helper and passing it in as `helperPath`.
 */
export { type CheckOptions, checkAvailability } from './check.js';
export { AfmAbortError, AfmError } from './errors.js';
export { buildHelper, devHelperPath, helperPath, swiftDir } from './helper-path.js';
export type { AfmChildProcess, AfmSpawnFn } from './spawn.js';
export { type StreamAfmOptions, streamAfm } from './stream.js';
export type {
  AfmAvailability,
  AfmDelta,
  AfmMessage,
  AfmReason,
  AfmRequest,
  AfmStreamResult,
  AfmUnavailableReason,
  AfmUsage,
} from './types.js';
