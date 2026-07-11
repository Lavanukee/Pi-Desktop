/**
 * @pi-desktop/gen-tools — a pi extension that gives the model a `generate_image`
 * tool. It generates on-device (Apple-Silicon MLX via mflux) by enqueuing a job
 * over a token-authed socket bridge to the app's JobQueue; progress streams to
 * the canvas and the produced image(s) return to the model.
 *
 * The default export is the zero-config activation Pi Desktop loads via `-e`
 * (add `'gen-tools'` to EXTENSION_PACKAGE_DIRS in apps/desktop/electron/pi/
 * pi-main.ts). It builds the bridge from the env the app injects before spawn
 * (PI_GEN_SOCK / PI_GEN_TOKEN). Loaded outside Pi Desktop (no env) the tool still
 * registers but reports "bridge unavailable", so it is always safe to load.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { GenBridgeClient } from './gen-bridge-client.js';
import { type GenToolsOptions, registerGenTools } from './tools.js';

export * from './gen-bridge-client.js';
export * from './gen-contract.js';
export * from './tools.js';

/** Register the gen tools with an explicit bridge (test / app seam). */
export function registerGenUse(pi: ExtensionAPI, options: GenToolsOptions): void {
  registerGenTools(pi, options);
}

/** pi extension factory (zero-config; reads the bridge socket from env). */
export default function activate(pi: ExtensionAPI): void {
  const bridge = GenBridgeClient.fromEnv();
  registerGenTools(pi, { bridge });
}
