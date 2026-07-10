/**
 * Transient state for the round-12 Auto model router (W3). The PERSISTED choice
 * (auto / a tier / a pinned model) lives in settings-store (`modelSelection`);
 * this store holds only the router's short-lived, per-session bookkeeping:
 *
 *   - `pendingDowngrade` — the lazy-down hysteresis counter (Auto upgrades
 *     immediately but only downgrades after N consecutive turns want a lower tier);
 *   - `lastSwitchAt` — a debounce stamp so rapid consecutive sends don't thrash
 *     the (expensive) llama-server restart;
 *   - `switching` — the live "switching to <tier>…" banner the footer / composer
 *     bar surface while a hard restart is in flight (honest about the latency);
 *   - `pendingDownload` — the friendly auto-download card shown when Auto (or an
 *     explicit tier pick) resolves to a model that isn't on disk yet.
 *
 * Kept out of settings-store deliberately: none of this should persist to
 * settings.json, and the router must be able to read/write it synchronously.
 */
import type { ModelTier } from '@pi-desktop/harness';
import { create } from 'zustand';
import type { LlmTierPick } from '../../electron/ipc-contract';

/** Lazy-down hysteresis bookkeeping the Auto router carries between turns. */
export interface DowngradeMemory {
  /** The lower tier the recent turns have been asking to drop to. */
  tier: ModelTier;
  /** Consecutive turns (including this one) that wanted this downgrade. */
  count: number;
}

/** Live "switching model…" banner state (footer + composer bar read this). */
export interface SwitchingState {
  toTier: ModelTier;
  /** The friendly grey model name being switched to (for the banner copy). */
  toName: string;
}

/** The pending friendly auto-download card (Auto resolved to an undownloaded tier). */
export interface PendingDownload {
  tier: ModelTier;
  pick: LlmTierPick;
}

interface ModelSelectionStoreState {
  pendingDowngrade: DowngradeMemory | null;
  lastSwitchAt: number;
  switching: SwitchingState | null;
  pendingDownload: PendingDownload | null;

  setPendingDowngrade: (m: DowngradeMemory | null) => void;
  /** Stamp a completed switch (advances the debounce clock, clears the lazy-down). */
  markSwitched: (at: number) => void;
  setSwitching: (s: SwitchingState | null) => void;
  setPendingDownload: (p: PendingDownload | null) => void;
  dismissDownload: () => void;
  /** Clear all transient router memory (e.g. a fresh session / a pinned model). */
  reset: () => void;
}

export const useModelSelectionStore = create<ModelSelectionStoreState>((set) => ({
  pendingDowngrade: null,
  lastSwitchAt: 0,
  switching: null,
  pendingDownload: null,

  setPendingDowngrade: (pendingDowngrade) => set({ pendingDowngrade }),
  markSwitched: (lastSwitchAt) => set({ lastSwitchAt, pendingDowngrade: null }),
  setSwitching: (switching) => set({ switching }),
  setPendingDownload: (pendingDownload) => set({ pendingDownload }),
  dismissDownload: () => set({ pendingDownload: null }),
  reset: () =>
    set({ pendingDowngrade: null, lastSwitchAt: 0, switching: null, pendingDownload: null }),
}));

/** Reactive hook: the live model-switch banner state, or null when idle. */
export function useModelSwitching(): SwitchingState | null {
  return useModelSelectionStore((s) => s.switching);
}

/** Reactive hook: the pending auto-download card, or null when none. */
export function useAutoDownloadPrompt(): PendingDownload | null {
  return useModelSelectionStore((s) => s.pendingDownload);
}
