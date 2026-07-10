/**
 * IPC contract for the Apple Foundation Models (on-device) provider. Composed
 * into the app-wide maps in ../ipc-contract.ts. Kept as its own module so the
 * afm channels sit beside their main-process handler (afm-main.ts).
 */

/** Renderer-facing mirror of @pi-desktop/afm's `AfmAvailability` — whether the
 * on-device model can serve a completion right now, and its shared limits. */
export interface AfmAvailabilityInfo {
  available: boolean;
  /** 'available' | 'deviceNotEligible' | 'appleIntelligenceNotEnabled' |
   * 'modelNotReady' | 'unsupportedOS'. */
  reason: string;
  /** Shared per-session token ceiling (input + instructions + history + output). */
  contextWindow: number;
  /** Best-effort model identifier the helper exposes ('apple-on-device'). */
  model: string;
}

export type AfmInvokeMap = {
  /** Capability gate: is the on-device model usable on this machine? Cached in
   * main (the helper `--check` is spawned at most once). Non-darwin/arm64 or an
   * unavailable model resolves `available:false` so the UI simply hides AFM. */
  'afm:check': { request: undefined; response: AfmAvailabilityInfo };
  /** Write the `afm` provider block into pi's models.json (preserving other
   * providers) so a subsequent pi restart + set-model routes to the on-device
   * model. Idempotent. */
  'afm:set-active': { request: undefined; response: { success: boolean; error?: string } };
};

export const AFM_INVOKE_CHANNELS = [
  'afm:check',
  'afm:set-active',
] as const satisfies readonly (keyof AfmInvokeMap)[];
