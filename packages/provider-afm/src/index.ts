/**
 * @pi-desktop/provider-afm — a pi extension that registers a custom
 * `streamSimple` handler for the Apple Foundation Models (on-device) provider.
 *
 * The provider's model + dummy baseUrl come from `models.json` (written by the
 * desktop app when the user sets "Apple Intelligence" active); this extension
 * only attaches the raw stream handler that bridges pi's Context → the on-device
 * model via @pi-desktop/afm's `streamAfm`.
 *
 * ## Why `api: 'afm-stream'` (a distinct custom api)
 * pi requires an `api` whenever `streamSimple` is registered (otherwise
 * `registerProvider` throws `"api" is required when registering streamSimple`).
 * pi's api-registry is keyed by the `api` string and resolves the handler per
 * request via the model's `api` field, so registering under a DISTINCT custom
 * api (`afm-stream`, matching the models.json block) binds our handler to ONLY
 * the on-device model — never hijacking a built-in api, and pi's mismatch guard
 * hard-enforces that a model reaches us iff `model.api === 'afm-stream'`.
 * (Same rationale as provider-llamacpp's `llamacpp-stream`.)
 *
 * ## helperPath
 * The `-e` load mechanism passes no options, so the desktop app injects the
 * resolved `pi-afm` binary path via the `PI_AFM_HELPER_PATH` env var on the pi
 * child; `activate` reads it and threads it into the stream handler. With none,
 * streamAfm falls back to the dev build output (see @pi-desktop/afm helper-path).
 *
 * The default export is the extension factory pi loads via `-e`.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type AfmStreamDeps, createAfmStream } from './stream.js';

export const packageName = '@pi-desktop/provider-afm';

/**
 * The custom pi `api` identifier this provider registers `streamSimple` under.
 * Must match the `api` field of the `afm` provider block in `models.json`
 * (written by the desktop app), or pi cannot route the on-device model to us.
 */
export const AFM_API = 'afm-stream';

export interface AfmExtensionOptions {
  /** Provider name to attach to; matches the models.json key. Default "afm". */
  readonly providerName?: string;
  /**
   * The pi `api` this provider's streamSimple registers under. Default
   * {@link AFM_API}. Must match the models.json provider block's `api`.
   */
  readonly api?: string;
  /** Stream deps: injectable streamAfm + the resolved helper binary path. */
  readonly deps?: AfmStreamDeps;
}

/** Attach the Apple Foundation Models streamSimple handler to a pi provider. */
export function registerAfmProvider(pi: ExtensionAPI, opts: AfmExtensionOptions = {}): void {
  const providerName = opts.providerName ?? 'afm';
  pi.registerProvider(providerName, {
    api: opts.api ?? AFM_API,
    streamSimple: createAfmStream(opts.deps),
  });
}

/** pi extension factory. Resolves the injected helper path from the env the
 * desktop app sets on the pi child. */
export default function activate(pi: ExtensionAPI): void {
  const helperPath = process.env.PI_AFM_HELPER_PATH;
  registerAfmProvider(pi, {
    deps: helperPath !== undefined && helperPath.length > 0 ? { helperPath } : {},
  });
}

export * from './stream.js';
