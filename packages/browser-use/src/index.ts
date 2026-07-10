/**
 * @pi-desktop/browser-use — a pi extension that gives the model a set of
 * `browser_*` tools to DRIVE the canvas browser (navigate/snapshot/click/type/
 * scroll/read/wait/back/forward/key), with a live virtual cursor the user
 * watches.
 *
 * The default export is the zero-config activation Pi Desktop loads via `-e`
 * (see apps/desktop/electron/pi/pi-main.ts). It builds the socket bridge from
 * the env the app injects before spawn (PI_BROWSER_AGENT_SOCK / _TOKEN) and
 * registers the tools. Loaded outside Pi Desktop (no env) the tools still
 * register but report a clear "bridge unavailable" error, so this extension is
 * always safe to load.
 *
 * Architecture / the extension→browser seam is documented in ./protocol.ts.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { BrowserAgentClient, type BrowserBridge } from './bridge-client.js';
import { type BrowserUseOptions, registerBrowserUseTools } from './tools.js';

export * from './bridge-client.js';
export * from './format.js';
export * from './perception.js';
export * from './protocol.js';
export * from './tools.js';

/** Register the browser tool set with an explicit bridge (test / app seam). */
export function registerBrowserUse(pi: ExtensionAPI, options: BrowserUseOptions): void {
  registerBrowserUseTools(pi, options);
}

/** pi extension factory (zero-config; reads the bridge socket from env). */
export default function activate(pi: ExtensionAPI): void {
  const bridge: BrowserBridge | null = BrowserAgentClient.fromEnv();
  registerBrowserUseTools(pi, { bridge });
}
