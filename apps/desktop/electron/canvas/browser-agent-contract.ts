/**
 * IPC contract for the browser-agent → renderer coordination (distinct from the
 * socket wire the pi child speaks, which is @pi-desktop/browser-use/protocol).
 *
 * The bridge (electron/canvas/browser-agent.ts) owns the WebContentsView it
 * drives, but only the RENDERER can create/focus a canvas browser tab (tabs are
 * CanvasController-owned). So when the model starts browsing the bridge asks the
 * renderer to open/focus a dedicated agent browser tab; the renderer opens it
 * and reports its tab id back over `browser:agent-register`. The bridge then
 * drives that tab. `browser:agent-driving` toggles the "Pi is browsing" chrome.
 *
 * Pure types + a runtime channel list, composed into ../ipc-contract.ts.
 */

export type BrowserAgentInvokeMap = {
  /** Renderer → main: report the agent browser tab id (after opening/focusing it). */
  'browser:agent-register': { request: { tabId: string }; response: { ok: boolean } };
  /** Renderer → main: the agent browser tab was closed. */
  'browser:agent-release': { request: { tabId: string }; response: { ok: boolean } };
};

export const BROWSER_AGENT_INVOKE_CHANNELS = [
  'browser:agent-register',
  'browser:agent-release',
] as const satisfies readonly (keyof BrowserAgentInvokeMap)[];

export type BrowserAgentEventMap = {
  /** Main → renderer: open/focus the agent browser tab, mark it driving. */
  'browser:agent-open-tab': Record<string, never>;
  /** Main → renderer: toggle the "model is driving" indicator on the agent tab. */
  'browser:agent-driving': { driving: boolean };
};
