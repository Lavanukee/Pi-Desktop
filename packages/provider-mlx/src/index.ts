/**
 * @pi-desktop/provider-mlx — a pi extension that registers a custom
 * `streamSimple` handler for an MLX `mlx_lm.server` provider.
 *
 * The provider's models + baseUrl come from `models.json` (written by
 * @pi-desktop/inference's `buildMlxProviderBlock`, api `mlx-stream`); this
 * extension only attaches the raw-SSE stream handler that owns tool-call repair
 * (rungs 1–2, plus the harness's rungs 3–5 via the repair bridge) and CLIENT-side
 * TPS.
 *
 * ## Why `api: 'mlx-stream'` (a distinct custom api)
 * pi requires an `api` whenever `streamSimple` is registered, and its api-registry
 * is keyed by that string. Registering under a DISTINCT custom api binds our
 * handler to ONLY MLX models (never hijacking a built-in api), and pi's mismatch
 * guard hard-enforces that a model reaches us iff `model.api === 'mlx-stream'`.
 * (Same rationale as provider-llamacpp's `llamacpp-stream` and provider-afm's
 * `afm-stream`.) Loaded off-platform, it registers a harmless handler that is
 * never invoked (no mlx-stream block in models.json unless an MLX model is live).
 *
 * ## Repair bridge
 * Like provider-llamacpp, this self-wires the harness's repair bridge over
 * `pi.events`: the harness pushes its live fixer + rungs 3–5 + telemetry, and the
 * registered `streamSimple` resolves them at call time. No app wiring required.
 *
 * The default export is the extension factory pi loads via `-e`.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { connectRepairBridge, createRepairBridge } from '@pi-desktop/provider-llamacpp';
import { createMlxStream, type MlxStreamDeps } from './stream.js';

export const packageName = '@pi-desktop/provider-mlx';

/**
 * The custom pi `api` identifier this provider registers `streamSimple` under.
 * Must match the `api` field of the `mlx` provider block in `models.json`
 * (written by @pi-desktop/inference's `buildMlxProviderBlock`).
 */
export const MLX_API = 'mlx-stream';

export interface MlxExtensionOptions {
  /** Provider name to attach to; matches the models.json key. Default "mlx". */
  readonly providerName?: string;
  /** The pi `api` to register under. Default {@link MLX_API}. */
  readonly api?: string;
  /** Stream deps: fixer (rung 2), extraRungs (rungs 3–5), onTps, onRepair. */
  readonly deps?: MlxStreamDeps;
}

/** Attach the MLX `mlx_lm.server` streamSimple handler to a pi provider. */
export function registerMlxProvider(pi: ExtensionAPI, opts: MlxExtensionOptions = {}): void {
  const providerName = opts.providerName ?? 'mlx';
  pi.registerProvider(providerName, {
    api: opts.api ?? MLX_API,
    streamSimple: createMlxStream(opts.deps),
  });
}

/**
 * pi extension factory.
 *
 * Self-wires the repair bridge (reusing provider-llamacpp's bridge helpers): the
 * harness pushes its live fixer + rungs 3–5 + telemetry over `pi.events`, and the
 * registered `streamSimple` resolves them at call time. If the harness is absent
 * the provider keeps its local rung 1–2 behavior.
 */
export default function activate(pi: ExtensionAPI): void {
  const bridge = createRepairBridge();
  registerMlxProvider(pi, { deps: { repairProvider: () => bridge.current } });
  connectRepairBridge(pi, bridge);
}

export * from './stream.js';
