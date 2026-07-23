/**
 * Which top-level MODALITY the app is showing. Chat is the default; other
 * modalities (the 3D Studio workspace, and later image/video/audio studios) are
 * full-window takeovers reached from the sidebar "Modalities" dropdown, each
 * with its own back-to-chat affordance. UI-only routing — no persistence.
 */
import { create } from 'zustand';

export type Modality = 'chat' | '3d';

interface ModalityState {
  view: Modality;
  setView(view: Modality): void;
}

export const useModalityStore = create<ModalityState>()((set) => ({
  view: 'chat',
  setView: (view) => set({ view }),
}));

/** Leave the current modality and return to chat (the studios' back button). */
export function exitModality(): void {
  useModalityStore.getState().setView('chat');
}
