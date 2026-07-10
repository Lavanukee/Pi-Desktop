/**
 * Bridge for the fullscreen drop-anywhere overlay (round-3 #A8b). The overlay
 * lives at the window level (so a file dropped ANYWHERE attaches, not just over
 * the composer), while the attachment state lives inside the composer — this
 * tiny store hands the dropped files across. The composer drains `files` into
 * its own attachment list and calls `clear()`, mirroring the `composerText`
 * hand-off pattern.
 */
import { create } from 'zustand';

interface DropState {
  files: File[];
  push: (files: File[]) => void;
  clear: () => void;
}

export const useDropStore = create<DropState>((set) => ({
  files: [],
  push: (files) => set((s) => ({ files: [...s.files, ...files] })),
  clear: () => set({ files: [] }),
}));
