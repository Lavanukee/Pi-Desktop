/**
 * Lazy vision-projector (mmproj) policy — the single source of truth for "never
 * load the mmproj until an image input actually needs it."
 *
 * ## Why lazy
 * A vision-capable GGUF ships a separate `mmproj` projector (~0.9 GiB for the
 * Gemma-4 family). Loading it costs download bandwidth, disk, and — at launch —
 * extra RAM/VRAM. Worse, llama.cpp:
 *   - CANNOT hot-load `--mmproj` into a running server (it is a launch-time flag),
 *     and
 *   - treats `--mmproj` as mutually exclusive with speculative decoding (MTP /
 *     EAGLE-3) and multi-slot `--parallel > 1` in one instance.
 * So a server that carries the projector is strictly slower for pure text.
 *
 * ## The policy
 * DEFAULT every launch to `fast-text` (MTP/spec-decode ON, `--parallel`, NO
 * `--mmproj`). Only when a turn genuinely carries an image do we transition to a
 * `multimodal` launch (restart WITH `--mmproj`, spec-decode dropped). A pure-text
 * session therefore NEVER downloads nor loads the projector.
 *
 * This module encodes that policy as pure, exhaustively-tested functions so the
 * guarantee lives in ONE place instead of scattered ternaries across the app:
 *   - {@link mmprojFileFor} is the chokepoint — it returns the projector file
 *     ONLY for a `multimodal` launch, so a `fast-text` path structurally cannot
 *     resolve an mmproj to load.
 *   - {@link planVisionLaunch} is the transition decision the chat/provider path
 *     consults: a text turn is always `stay-text` (no projector), an image turn
 *     only forces a restart when the running server isn't already multimodal.
 */
import type { CatalogFile, CatalogModel, LaunchMode } from './catalog.js';

/** The projector-relevant slice of a catalog model (so callers can pass a DTO). */
export type VisionModelInfo = Pick<CatalogModel, 'mmproj'>;

/**
 * Whether a model has a vision projector to lazily load at all. This is the
 * physical `mmproj` sibling — the thing there is anything to defer. The catalog
 * invariant (`catalog.test.ts`) keeps this in lockstep with `input: ['image']`.
 */
export function modelSupportsVision(model: VisionModelInfo): boolean {
  return model.mmproj !== undefined;
}

/**
 * The mmproj projector file to attach for a launch — the LAZY chokepoint.
 *
 * Returns `undefined` for every `fast-text` launch (the default), so a text
 * launch can never even name an mmproj file to download or pass to
 * `--mmproj`. Returns the model's projector ONLY for a `multimodal` launch, and
 * still `undefined` when the model ships none (a caller should treat that as
 * "this model has no vision" — see {@link modelSupportsVision}).
 */
export function mmprojFileFor(
  model: VisionModelInfo,
  launchMode: LaunchMode,
): CatalogFile | undefined {
  if (launchMode !== 'multimodal') return undefined;
  return model.mmproj;
}

/** The outcome of the lazy vision-launch decision. */
export type VisionTransition =
  /** Text-only turn: keep the current server; the projector is never loaded. */
  | { readonly kind: 'stay-text' }
  /** Image turn, and the running server is already multimodal (vision is sticky
   *  for the session): nothing to do. */
  | { readonly kind: 'already-vision' }
  /** Image turn on a text-only (or not-yet-running) server: a restart WITH
   *  `--mmproj` is required to load the projector on demand. */
  | { readonly kind: 'load-mmproj' };

export interface VisionLaunchInput {
  /** Launch mode of the server currently running (undefined ⇒ none up yet). */
  readonly runningMode: LaunchMode | undefined;
  /** Whether the incoming turn actually carries image input. */
  readonly turnHasImage: boolean;
}

/**
 * Decide whether a turn requires transitioning the running server into a
 * vision-capable (mmproj) launch — the canonical statement of the lazy policy.
 *
 * The critical guarantee, proven in tests: a turn with NO image is ALWAYS
 * `stay-text`, regardless of the running mode, so a pure-text session can never
 * trigger a projector load. An image turn only forces a restart when the server
 * is not already multimodal (vision is sticky once on).
 */
export function planVisionLaunch(input: VisionLaunchInput): VisionTransition {
  if (!input.turnHasImage) return { kind: 'stay-text' };
  if (input.runningMode === 'multimodal') return { kind: 'already-vision' };
  return { kind: 'load-mmproj' };
}
