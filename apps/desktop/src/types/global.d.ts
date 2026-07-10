import type { CanvasController } from '@pi-desktop/canvas';
import type { PiDesktopBridge } from '../../electron/ipc-contract';
import type { useHfStore } from '../state/hf-store';
import type { useLlmStore } from '../state/llm-store';
import type { usePiStore } from '../state/pi-slice';
import type { useProjectStore } from '../state/project-store';
import type { useSettingsStore } from '../state/settings-store';

declare global {
  interface Window {
    /** Typed IPC surface exposed by electron/preload.ts via contextBridge. */
    piDesktop: PiDesktopBridge;
    /** E2E hook: accessor for the pi Zustand store. Present only when the
     * app was loaded with ?piE2E=1 (see state/pi-connect.ts). */
    __pi_store?: () => typeof usePiStore;
    /** E2E hook: accessor for the canvas controller (open browser/terminal
     * tabs). Present only when loaded with ?piE2E=1 (see CanvasTabsPanel.tsx). */
    __pi_canvas?: () => CanvasController;
    /** E2E hook: recorded canvas shell-out invokes (open-with / reveal /
     * open-external). Populated (and the real shell-out suppressed) only under
     * ?piE2E=1 so probes can assert the wiring without launching Finder/Terminal
     * (see chat/canvas/native-surfaces.ts). */
    __pi_canvas_ipc?: Array<{ channel: string; req: unknown }>;
    /** E2E hook: accessor for the desktop-settings store. Present only when
     * loaded with ?piE2E=1 (see state/settings-store.ts). */
    __settings_store?: () => typeof useSettingsStore;
    /** E2E hook: accessor for the inference/llm store (drive download +
     * status). Present only when loaded with ?piE2E=1 (see state/llm-store.ts). */
    __llm_store?: () => typeof useLlmStore;
    /** E2E hook: accessor for the Browse-HF store (inject search results / files
     * without live network). Present only with ?piE2E=1 (see state/hf-store.ts). */
    __hf_store?: () => typeof useHfStore;
    /** E2E hook: accessor for the project (working-folder) store — set/clear the
     * working folder without a native dialog. Present only with ?piE2E=1 (see
     * state/project-store.ts). */
    __pi_project?: () => typeof useProjectStore;
  }
}
