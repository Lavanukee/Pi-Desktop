/**
 * @pi-desktop/provider-llamacpp — a pi extension that registers a custom
 * `streamSimple` handler for a llama-server provider.
 *
 * The provider's models + baseUrl come from `models.json` (written by
 * @pi-desktop/inference's models-json module); this extension only attaches the
 * raw-SSE stream handler that owns tool-call repair (rungs 1–2) and TPS
 * extraction.
 *
 * ## Why `api: 'llamacpp-stream'` (and not `'openai-completions'`)
 * pi requires an `api` whenever `streamSimple` is registered (otherwise
 * `registerProvider` throws `"api" is required when registering streamSimple`,
 * the streamSimple never enters pi's api-registry, and llama-server models fall
 * back to pi's BUILT-IN openai-completions handler — killing repair + TPS).
 *
 * pi's api-registry is a `Map` keyed by the `api` string, and the stream handler
 * is resolved per request via `getApiProvider(model.api)`. So the `api` value we
 * register under is the ONLY thing that binds our handler to a model:
 *   - Registering under a KNOWN api (`openai-completions`) would GLOBALLY
 *     override the built-in handler for *every* openai-completions model in pi
 *     (last-write-wins on the shared key) — a surprising, cross-provider hijack.
 *   - Registering under a distinct custom api (`llamacpp-stream`) binds our
 *     handler to *only* our models. pi's `wrapStreamSimple` guard
 *     (`if (model.api !== api) throw`) then hard-enforces the binding, which
 *     also proves the non-bypass property: a model resolves to our handler iff
 *     its `model.api === 'llamacpp-stream'`.
 *
 * REQUIRES: `models.json` must declare `api: 'llamacpp-stream'` for the
 * llamacpp provider block (see provider-fix-handoff.md — owned by
 * @pi-desktop/inference). A mismatch silently routes models to the built-in
 * handler, bypassing repair + TPS.
 *
 * The default export is the extension factory pi loads via `-e`.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { registerAdvancedParamsHook } from './advanced-hook.js';
import { connectRepairBridge, createRepairBridge } from './repair-bridge.js';
import { createLlamaCppStream, type LlamaCppStreamDeps } from './stream.js';

export const packageName = '@pi-desktop/provider-llamacpp';

/**
 * The custom pi `api` identifier this provider registers `streamSimple` under.
 * Must match the `api` field of the llamacpp provider block in `models.json`
 * (written by @pi-desktop/inference), or pi routes models to its built-in
 * openai-completions handler and our repair/TPS path is bypassed.
 */
export const LLAMACPP_API = 'llamacpp-stream';

export interface LlamaCppExtensionOptions {
  /** Provider name to attach to; matches the models.json key. Default "llamacpp". */
  readonly providerName?: string;
  /**
   * The pi `api` this provider's streamSimple registers under. Default
   * {@link LLAMACPP_API}. Must match the models.json provider block's `api`.
   */
  readonly api?: string;
  /** Stream deps: fixer (rung 2), extraRungs (W5 rungs 3–5), onTimings, onRepair. */
  readonly deps?: LlamaCppStreamDeps;
}

/** Attach the llama-server streamSimple handler to a pi provider. */
export function registerLlamaCppProvider(
  pi: ExtensionAPI,
  opts: LlamaCppExtensionOptions = {},
): void {
  const providerName = opts.providerName ?? 'llamacpp';
  pi.registerProvider(providerName, {
    api: opts.api ?? LLAMACPP_API,
    streamSimple: createLlamaCppStream(opts.deps),
  });
}

/**
 * pi extension factory.
 *
 * Self-wires the repair bridge: the harness (`@pi-desktop/harness`, a separate
 * `-e` extension in the same process) pushes its live fixer + rungs 3–5 +
 * telemetry over `pi.events`, and the registered `streamSimple` resolves them at
 * call time via `repairProvider`. No app wiring is required; if the harness is
 * absent the provider keeps its local rung 1–2 behavior.
 */
export default function activate(pi: ExtensionAPI): void {
  const bridge = createRepairBridge();
  registerLlamaCppProvider(pi, { deps: { repairProvider: () => bridge.current } });
  connectRepairBridge(pi, bridge);
  // Power-user advanced params: stamp the user's sampling overrides onto each
  // outgoing body + push the ground-truth prompt/tools/messages to the panel.
  // The override file path is published by the desktop main via env; absent
  // (bare pi / tests) → sampling untouched, ground truth still captured.
  registerAdvancedParamsHook(pi, { samplingFilePath: process.env.PI_ADV_SAMPLING_FILE });
}

export * from './advanced-hook.js';
export * from './repair.js';
export * from './repair-bridge.js';
export * from './sse.js';
export * from './stream.js';
