/**
 * Renderer↔main IPC contract for generation — its OWN file, mirroring
 * canvas/browser-agent-contract.ts. Self-contained so it does NOT edit the
 * round-12 ipc-contract.ts; the app composes these maps into the global
 * AppEventMap / AppInvokeMap with a one-line spread (see gen-manager.ts header
 * for the exact wire-up).
 *
 * Two directions:
 *   - main→renderer EVENTS (`gen:open` / `gen:update`): stream a generation job's
 *     live surface data so the renderer upserts + updates a `gen-image` canvas
 *     tab (candidate grid + progress + footnote).
 *   - renderer→main INVOKE (`gen:register` / `gen:cancel`): the renderer confirms
 *     it mounted the tab, and the user can cancel a running job.
 */

/** Structural mirror of @pi-desktop/gen-canvas `GenImageSurfaceData` — kept as a
 * plain payload so Electron MAIN never imports the React surface package. The
 * renderer feeds it straight into `genImageContent(payload)`. */
export interface GenSurfacePayload {
  readonly model: { readonly id: string; readonly label: string; readonly license: string };
  readonly prompt?: string;
  readonly candidates: ReadonlyArray<{
    readonly seed?: number;
    readonly previewSrc?: string;
    readonly finalSrc?: string;
    readonly status: 'pending' | 'generating' | 'done' | 'error';
  }>;
  readonly progress?: { readonly candidate: number; readonly step: number; readonly total: number };
  readonly status: 'generating' | 'done' | 'error';
  readonly error?: string;
}

/** main→renderer events. Compose into AppEventMap. */
export type GenEventMap = {
  /** Open (or focus) the gen-image canvas tab for a job with initial data. */
  'gen:open': { tabId: string; payload: GenSurfacePayload };
  /** Push updated surface data (step preview / candidate done / finished). */
  'gen:update': { tabId: string; payload: GenSurfacePayload };
};

/** renderer→main invoke channels. Compose into AppInvokeMap. */
export type GenInvokeMap = {
  'gen:register': { request: { tabId: string }; response: { ok: boolean } };
  'gen:cancel': { request: { jobId: string }; response: { canceled: boolean } };
};

export const GEN_EVENT_CHANNELS = [
  'gen:open',
  'gen:update',
] as const satisfies readonly (keyof GenEventMap)[];
export const GEN_INVOKE_CHANNELS = [
  'gen:register',
  'gen:cancel',
] as const satisfies readonly (keyof GenInvokeMap)[];
