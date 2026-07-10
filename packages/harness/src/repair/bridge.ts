/**
 * Cross-extension repair bridge (harness side).
 *
 * The harness owns rungs 3–5, the rung-2 fixer, effort knobs, and telemetry, but
 * repair actually FIRES inside `@pi-desktop/provider-llamacpp`'s `streamSimple`.
 * The two extensions are loaded separately (`-e`) and must not import each other,
 * so they rendezvous over `pi.events`. This is the harness half of that
 * handshake — a structural mirror of the provider's `repair-bridge.ts` (channel
 * names + payload shape kept in sync deliberately, not imported).
 *
 * Handshake (order-independent): the harness subscribes to
 * {@link REPAIR_BRIDGE_READY} and emits {@link REPAIR_BRIDGE_HELLO}. If the
 * provider loaded first (the real order) it re-announces `ready` in response to
 * `hello`; if the harness loaded first, the provider's own initial announce is
 * caught. Either way the harness ends up with the provider's `setDeps` and pushes
 * its live deps — again on every effort/config change.
 */

import type { RepairRung, ToolCallFixer } from './types.js';

/** Live repair wiring the harness pushes to the provider. Mirrors the provider's. */
export interface LiveRepairDeps {
  readonly fixer?: ToolCallFixer;
  readonly extraRungs?: readonly RepairRung[];
  readonly onRepair?: (info: {
    readonly toolName: string;
    readonly rung: number | undefined;
    readonly ok: boolean;
  }) => void;
}

/** MUST equal the provider's `REPAIR_BRIDGE_READY`. */
export const REPAIR_BRIDGE_READY = 'pi-desktop/repair:provider-ready';
/** MUST equal the provider's `REPAIR_BRIDGE_HELLO`. */
export const REPAIR_BRIDGE_HELLO = 'pi-desktop/repair:harness-hello';

/** Payload the provider announces on {@link REPAIR_BRIDGE_READY}. */
export interface RepairBridgeReady {
  readonly setDeps: (deps: LiveRepairDeps | undefined) => void;
}

/** The minimal `pi.events` surface the handshake needs. */
export interface MinimalEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * Wire the harness side of the repair bridge. `buildDeps` is called to produce
 * the current {@link LiveRepairDeps} whenever a push is needed; the returned
 * `push` re-sends them (call it on effort/config change). No-op without a bus.
 */
export function connectRepairBridge(
  bus: MinimalEventBus | undefined,
  buildDeps: () => LiveRepairDeps,
): { push: () => void } {
  let setDeps: RepairBridgeReady['setDeps'] | undefined;
  const push = () => setDeps?.(buildDeps());
  if (bus === undefined) return { push };
  bus.on(REPAIR_BRIDGE_READY, (data) => {
    setDeps = (data as RepairBridgeReady).setDeps;
    push();
  });
  bus.emit(REPAIR_BRIDGE_HELLO, {});
  return { push };
}
