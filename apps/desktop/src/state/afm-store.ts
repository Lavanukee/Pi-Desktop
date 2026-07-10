/**
 * Renderer state for the Apple Foundation Models (on-device) provider: a cached
 * availability gate fetched from the main process (`afm:check`). When the model
 * isn't available (off-platform, Apple Intelligence disabled, still downloading),
 * `availability.available` is false and the Model Manager simply hides the AFM
 * entry. Refreshed on Model Manager mount.
 */
import { create } from 'zustand';
import type { AfmAvailabilityInfo } from '../../electron/afm/afm-contract';

interface AfmStoreState {
  availability: AfmAvailabilityInfo | null;
  /** Fetch (once) the on-device capability gate from main; cheap + cached there. */
  refresh: () => Promise<void>;
}

export const useAfmStore = create<AfmStoreState>((set, get) => ({
  availability: null,
  refresh: async () => {
    if (get().availability !== null) return;
    const availability = await window.piDesktop.invoke('afm:check', undefined);
    set({ availability });
  },
}));

/** True iff the on-device Apple model can serve a completion right now. */
export function afmAvailable(availability: AfmAvailabilityInfo | null): boolean {
  return availability?.available === true;
}
