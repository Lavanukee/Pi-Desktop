/**
 * Renderer state for the GENERATION modality catalog — the twin of
 * {@link useLlmStore} for the model browser's Image / Video / Audio / Music / 3D
 * category tabs. Loads the vetted `MODALITY_CATALOG` as plain
 * {@link ModalityCatalogEntry} DTOs over the `gen:modality-catalog` IPC channel
 * (answered by the main-process gen-manager). The renderer NEVER value-imports
 * the `@pi-desktop/gen-service` barrel — only this DTO type crosses the boundary.
 */
import { create } from 'zustand';
import type { ModalityCatalogEntry } from '../../electron/gen/gen-ipc-contract';

interface GenStoreState {
  catalog: ModalityCatalogEntry[];
  /** True once the first catalog fetch has resolved (drives the loading state). */
  loaded: boolean;
  refreshCatalog: () => Promise<void>;
}

export const useGenStore = create<GenStoreState>((set) => ({
  catalog: [],
  loaded: false,
  refreshCatalog: async () => {
    const res = await window.piDesktop.invoke('gen:modality-catalog', undefined);
    set({ catalog: res.models, loaded: true });
  },
}));

let connected = false;

/** E2E hook: expose the gen store under the same `?piE2E` opt-in as the other
 * stores, so the model-manager probe can read/inject the modality catalog
 * without the live IPC round-trip. Call once at renderer boot. */
export function connectGen(): void {
  if (connected) return;
  connected = true;
  if (new URLSearchParams(window.location.search).has('piE2E')) {
    window.__gen_store = () => useGenStore;
  }
}
