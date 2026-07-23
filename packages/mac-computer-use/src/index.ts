/**
 * @pi-desktop/mac-computer-use — a pi extension that gives the model a set of
 * `mac_*` tools to DRIVE any Mac app (snapshot/click/type/key/scroll/launch) via
 * the pi-mac Accessibility + CGEvent helper hosted in Electron main.
 *
 * The default export is the zero-config activation Pi Desktop loads via `-e`
 * (see apps/desktop/electron/pi/pi-main.ts). It builds the socket bridge from
 * the env the app injects before spawn (PI_MAC_SOCK / PI_MAC_TOKEN) and
 * registers the tools. Loaded outside Pi Desktop (no env) the tools still
 * register but report a clear "bridge unavailable" error, so this extension is
 * always safe to load.
 *
 * Powerful capability, so it is gated: a per-session consent + an app denylist
 * (see ./permissions.ts), on top of the harness's permission mode. The
 * architecture / the extension→helper seam is documented in ./protocol.ts.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { MacAgentClient, type MacBridge } from './bridge-client.js';
import { createMacConsentGate } from './permissions.js';
import { type MacComputerUseOptions, registerMacComputerUseTools } from './tools.js';

export * from './bridge-client.js';
export * from './format.js';
export * from './permissions.js';
export * from './protocol.js';
export * from './session-state.js';
export * from './tools.js';

/** Register the mac tool set with an explicit bridge (test / app seam). */
export function registerMacComputerUse(pi: ExtensionAPI, options: MacComputerUseOptions): void {
  registerMacComputerUseTools(pi, options);
}

/** pi extension factory (zero-config; reads the bridge socket from env).
 *
 * PI_MAC_PRECONSENT=1 skips the one-time in-UI consent prompt — an E2E seam
 * ONLY: the headless probes (tests/e2e/mac-computeruse-probe.mjs) have no
 * human to click the dialog. The app never sets it for real sessions. */
export default function activate(pi: ExtensionAPI): void {
  const bridge: MacBridge | null = MacAgentClient.fromEnv();
  const preConsented = process.env.PI_MAC_PRECONSENT === '1';
  registerMacComputerUseTools(pi, { bridge, consent: createMacConsentGate({ preConsented }) });
}
