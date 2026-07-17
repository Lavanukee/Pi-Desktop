/**
 * Download-then-continue asset gate — the seam the gen bridge runs a generation
 * job through when the model/pack it needs may not be on disk yet.
 *
 * THE FLOW THE OWNER SPECIFIED (mirrors the harness "model isn't available →
 * download in Settings" case, but SEAMLESS instead of a dead-end):
 *   1. PROBE  — is the required asset already present? If so, continue at once.
 *   2. PROMPT — otherwise ask the user (a consent event the renderer surfaces),
 *               awaiting their accept/decline.
 *   3. DOWNLOAD — on accept, run the install (reusing the gen install-manager).
 *   4. CONTINUE — the gate resolves, and the caller proceeds with the SAME job:
 *               the generation is never a dead-end. On decline it throws
 *               {@link GenAssetDeclinedError} so the tool returns an honest,
 *               re-tryable message rather than silently doing nothing.
 *
 * DESIGN — pure + injected, like comfy-install.ts: every side effect (probe,
 * prompt, install) is a port passed in, so the whole coordinator unit-tests in
 * plain Node with fakes — NO multi-GB download ever runs in a test. The Electron
 * gen manager injects a real gate; a test injects a mock that PROVES
 * continue-after-accept.
 */
import type { ComfyPackLicense } from './comfy-install';

/** What a job needs before it can run. `id` matches a gen-service catalog id /
 * a comfy-install pack id (they are kept in sync deliberately). */
export interface GenAssetNeed {
  /** `model` = an mflux/MLX weight the worker fetches; `pack` = a ComfyUI
   * runtime/weights pack the install-manager downloads. */
  readonly kind: 'model' | 'pack';
  readonly id: string;
  /** Human label for the consent prompt. */
  readonly label: string;
  /** GPL/EULA license, when the asset is gated (drives the accept-license gate). */
  readonly license?: ComfyPackLicense;
  /** Rough download footprint (GB) for the prompt copy. */
  readonly approxSizeGB?: number;
}

/** The user's answer to a download prompt. */
export interface AssetConsent {
  readonly accepted: boolean;
  /** Licenses the user accepted (empty for un-gated assets). */
  readonly acceptedLicenses: readonly ComfyPackLicense[];
}

/** The injected side effects the gate drives. */
export interface AssetGatePorts {
  /** True when the asset is already on disk (skip prompt + download). */
  readonly probe: (need: GenAssetNeed) => Promise<boolean>;
  /** Ask the user to download; resolves with their accept/decline. */
  readonly prompt: (need: GenAssetNeed) => Promise<AssetConsent>;
  /** Perform the download/install (only ever called after an accept). */
  readonly install: (need: GenAssetNeed, consent: AssetConsent) => Promise<void>;
}

/** The user declined the download — the job cannot continue. Carries the need so
 * the tool can name what was declined. */
export class GenAssetDeclinedError extends Error {
  constructor(readonly need: GenAssetNeed) {
    super(`Download declined for "${need.label}" (${need.id}); generation cannot continue.`);
    this.name = 'GenAssetDeclinedError';
  }
}

/**
 * Ensure the asset is present, prompting + downloading if not. Resolves when the
 * caller may CONTINUE (asset present or just installed). Throws
 * {@link GenAssetDeclinedError} on decline, or the install error on a failed
 * download. Idempotent + side-effect-only via the injected ports.
 */
export async function ensureAsset(need: GenAssetNeed, ports: AssetGatePorts): Promise<void> {
  if (await ports.probe(need)) return;
  const consent = await ports.prompt(need);
  if (!consent.accepted) throw new GenAssetDeclinedError(need);
  await ports.install(need, consent);
}

/**
 * The download-then-CONTINUE form: ensure the asset, then run the continuation
 * and return its result. This is the shape the proof exercises — the SAME job
 * resumes after an accepted download and yields its output. Any generation job
 * can be wrapped: `ensureAssetThenContinue(need, ports, () => enqueue(job))`.
 */
export async function ensureAssetThenContinue<T>(
  need: GenAssetNeed,
  ports: AssetGatePorts,
  run: () => Promise<T>,
): Promise<T> {
  await ensureAsset(need, ports);
  return run();
}

/** The `ensureAsset` callback registerGenIpc awaits before enqueuing a job. */
export type EnsureAssetFn = (need: GenAssetNeed) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// makeComfyAssetGate — adapt the gen install-manager (comfy-install.ts) into the
// gate's ports, so a ComfyUI-backed generation downloads-then-continues.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal structural slice of {@link import('./comfy-install').ComfyInstallManager}
 * the gate needs — kept structural so this module has NO Electron/manager import
 * cycle and stays unit-testable against a fake. */
export interface ComfyInstallLike {
  status(acceptedLicenses?: readonly ComfyPackLicense[]): Promise<{
    readonly runtime: 'consent-required' | 'runtime-missing' | 'runtime-ready';
    readonly packs: readonly { readonly id: string; readonly installed: boolean }[];
  }>;
  recordConsent(): Promise<void>;
  run(
    requestedPackIds?: readonly string[],
    acceptedLicenses?: readonly ComfyPackLicense[],
  ): Promise<unknown>;
}

/** The renderer round-trip the gate uses to ask the user to download. Emits a
 * prompt (main→renderer) and awaits the accept/decline (renderer→main). */
export interface ComfyGateIo {
  /** Ask the user; resolves with their answer (the renderer's consent invoke). */
  readonly awaitConsent: (need: GenAssetNeed) => Promise<AssetConsent>;
}

/**
 * Build the `ensureAsset` gate for ComfyUI-backed jobs from a
 * {@link ComfyInstallLike} + the consent round-trip. The pack is "present" when
 * the runtime is ready AND the pack is installed; otherwise the user is
 * prompted, and on accept the one-time GPL consent is recorded and the pack is
 * downloaded via the install-manager before the job continues.
 */
export function makeComfyAssetGate(comfy: ComfyInstallLike, io: ComfyGateIo): EnsureAssetFn {
  const ports: AssetGatePorts = {
    probe: async (need) => {
      const state = await comfy.status();
      if (state.runtime !== 'runtime-ready') return false;
      return state.packs.some((p) => p.id === need.id && p.installed);
    },
    prompt: (need) => io.awaitConsent(need),
    install: async (need, consent) => {
      // The manager refuses to run without recorded GPL consent; an accepted
      // prompt IS that consent.
      await comfy.recordConsent();
      await comfy.run([need.id], consent.acceptedLicenses);
    },
  };
  return (need) => ensureAsset(need, ports);
}
