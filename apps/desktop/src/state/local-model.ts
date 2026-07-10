/**
 * Brings a local model online end-to-end and makes pi use it:
 *   download (if needed) → start the engine server (supervisor writes models.json)
 *   → re-point pi at the matching provider.
 *
 * Model-switch strategy (hot-reload vs restart):
 * pi caches models.json at spawn, and the frozen provider-llamacpp extension
 * exposes no runtime "re-register with the new model" command, so a true
 * hot-reload isn't reachable from this workstream. We therefore do a GRACEFUL
 * restart that preserves the conversation: the pi child is respawned on the
 * SAME session file (the renderer keeps the rendered thread, and pi resumes the
 * session it was already writing), so switching models never dead-ends the
 * chat. If provider-llamacpp later gains a runtime re-register command, this is
 * the one seam to swap for a no-restart path.
 *
 * Two launch modes flow through here (round-12):
 *   - 'fast-text'  → the default speed launch (MTP / EAGLE-3 when available).
 *   - 'multimodal' → the on-demand VISION launch: the supervisor fetches the
 *     mmproj sibling and relaunches WITHOUT MTP (mmproj ⊥ MTP). Sticky for the
 *     session — {@link ensureVisionMode} no-ops once the server is multimodal.
 * And two engines: 'llamacpp' (GGUF, the default) and 'mlx' (Apple-Silicon
 * foundation) — the provider pi is re-pointed at is chosen by the model's engine.
 */

import type { LaunchMode } from '@pi-desktop/inference';
import { useLlmStore } from './llm-store';
import { getModels, restartPi, setModel } from './pi-connect';
import { usePiStore } from './pi-slice';
import { applySavedHarnessConfig } from './settings-store';

/** The models.json provider key a model's engine binds to. */
function providerForEngine(engine: 'llamacpp' | 'mlx' | undefined): string {
  return engine === 'mlx' ? 'mlx' : 'llamacpp';
}

/** The catalog entry's engine for a model id (defaults to llamacpp when unknown). */
function engineFor(modelId: string): 'llamacpp' | 'mlx' {
  return useLlmStore.getState().catalog.find((e) => e.id === modelId)?.engine ?? 'llamacpp';
}

export async function activateLocalModel(
  modelId: string,
  quant?: string,
  launchMode: LaunchMode = 'fast-text',
): Promise<{ success: boolean; error?: string }> {
  const store = useLlmStore.getState();
  if (!store.status.downloadedModelIds.includes(modelId)) {
    // MLX models are auto-downloaded by mlx_lm.server on first launch, so they
    // never register in our GGUF download tracking — don't gate them on it.
    if (engineFor(modelId) !== 'mlx') {
      await store.downloadModel(modelId, quant);
      if (!useLlmStore.getState().status.downloadedModelIds.includes(modelId)) {
        return { success: false, error: 'download did not complete' };
      }
    }
  }

  const started = await store.startServer(modelId, quant, launchMode);
  if (!started.success) return started;

  // Graceful restart preserving the current session so the chat is not
  // dead-ended (see file header). Respawn on the same session file when one
  // exists; the rendered thread in the store stays put.
  const sessionFile = usePiStore.getState().session?.sessionFile;
  await restartPi(sessionFile !== undefined ? { sessionPath: sessionFile } : undefined);

  // Re-point pi at the freshly-registered provider model, engine-aware: an MLX
  // model is served under the 'mlx' provider (provider-mlx / mlx-stream), a GGUF
  // under 'llamacpp'.
  const providerName = providerForEngine(engineFor(modelId));
  const models = await getModels();
  const target = models.models.find((m) => m.provider === providerName);
  if (target !== undefined) await setModel(target.provider, target.id);

  // A fresh session drops the harness runtime config — re-apply the saved one.
  applySavedHarnessConfig();
  return { success: true };
}

// ---------------------------------------------------------------------------
// On-demand vision (round-12 ask #3)
// ---------------------------------------------------------------------------

/** The live state the vision decision reads (subset of LlmStatus + catalog). */
export interface VisionState {
  /** The launch mode of the running server (multimodal ⇒ vision already on). */
  readonly launchMode?: 'fast-text' | 'multimodal';
  /** The running model, or null when none is up. */
  readonly model?: { readonly id: string; readonly quant?: string } | null;
  /** Catalog entries (only `id` + `vision` are read). */
  readonly catalog: ReadonlyArray<{ readonly id: string; readonly vision?: boolean }>;
  /** Resolved tier picks (for the text-only-model fallback), when loaded. */
  readonly tierModels?: Record<
    'fast' | 'balanced' | 'intelligent',
    {
      readonly modelId: string;
      readonly quant: string;
      readonly vision: boolean;
      readonly downloaded: boolean;
    }
  >;
}

export type VisionDecision =
  | { readonly action: 'already-on' }
  | { readonly action: 'relaunch'; readonly modelId: string; readonly quant?: string }
  | { readonly action: 'none'; readonly reason: string };

/**
 * Pure: decide how to get the running setup into a vision-capable state.
 *   - already multimodal → nothing to do (vision is sticky for the session),
 *   - current model supports vision → relaunch IT in multimodal,
 *   - else → the best downloaded vision-capable tier pick (intelligent → balanced
 *     → fast) so an image on a text-only model is still seen,
 *   - else → nothing available.
 */
export function resolveVisionTarget(s: VisionState): VisionDecision {
  if (s.launchMode === 'multimodal') return { action: 'already-on' };

  const currentId = s.model?.id ?? null;
  const currentVision =
    currentId !== null && s.catalog.find((e) => e.id === currentId)?.vision === true;
  if (currentVision && currentId !== null) {
    return { action: 'relaunch', modelId: currentId, quant: s.model?.quant };
  }

  const tiers = s.tierModels;
  const pick =
    tiers !== undefined
      ? [tiers.intelligent, tiers.balanced, tiers.fast].find((p) => p.vision && p.downloaded)
      : undefined;
  if (pick !== undefined) return { action: 'relaunch', modelId: pick.modelId, quant: pick.quant };

  return { action: 'none', reason: 'no vision-capable model available' };
}

/**
 * Ensure the running model can see images — the on-demand VISION trigger.
 *
 * Delegates the choice to {@link resolveVisionTarget} (pure), then acts:
 * a no-op when already multimodal (vision is sticky), otherwise a multimodal
 * RELAUNCH of the current vision model (or a vision-capable fallback pick).
 *
 * Restart-based + honest about the cost: a vision relaunch drops MTP/spec-decode
 * for the session (mmproj ⊥ MTP), so text generation is a bit slower afterwards.
 *
 * Exposed so the vision-input paths call it before dispatch:
 *   - image upload → wired in `pi-connect.sendPrompt`,
 *   - browser / computer-use screenshots → those paths can call this too (their
 *     full wiring is a follow-up).
 *
 * Never throws; returns whether vision mode is (now) active and whether a relaunch
 * happened.
 */
export async function ensureVisionMode(): Promise<{
  ok: boolean;
  changed: boolean;
  reason?: string;
}> {
  const llm = useLlmStore.getState();
  const decision = resolveVisionTarget({
    launchMode: llm.status.launchMode,
    model: llm.status.model,
    catalog: llm.catalog,
    tierModels: llm.recommendation?.tierModels,
  });

  if (decision.action === 'already-on') return { ok: true, changed: false };
  if (decision.action === 'none') return { ok: false, changed: false, reason: decision.reason };

  const res = await activateLocalModel(decision.modelId, decision.quant, 'multimodal');
  return { ok: res.success, changed: res.success, reason: res.error };
}
