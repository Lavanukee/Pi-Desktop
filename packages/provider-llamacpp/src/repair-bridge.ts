/**
 * Cross-extension repair bridge (provider side).
 *
 * The tool-call repair ladder is split across two independently-loaded pi
 * extensions: THIS provider owns rungs 1–2 + where repair actually fires
 * (inside `streamSimple`), and `@pi-desktop/harness` owns rungs 3–5, the
 * fixer-model call, effort knobs, and telemetry. They must NOT import each other
 * (layering + no build cycle), and the app loads both via `-e` with no way to
 * hand-wire them. So they rendezvous over `pi.events` — pi's sanctioned
 * cross-extension bus — with zero app involvement.
 *
 * This module is the provider's half: a mutable {@link RepairBridge} the
 * `streamSimple` reads at call time, plus {@link connectRepairBridge}, an
 * order-independent handshake that lets the harness push live
 * {@link LiveRepairDeps} in whenever effort/config changes.
 *
 * The channel names + payload shape are a structural contract mirrored (not
 * imported) by the harness — the same decoupling used by `./repair.ts`'s rung
 * types. Keep the two in sync.
 */

import type { RepairRung, ToolCallFixer } from './repair.js';

/**
 * The live repair wiring the harness pushes to the provider at runtime:
 * a fixer-model call (rung 2), the escalation rungs 3–5, and outcome telemetry.
 * All optional — absent pieces degrade to the provider's local behavior.
 */
export interface LiveRepairDeps {
  readonly fixer?: ToolCallFixer;
  readonly extraRungs?: readonly RepairRung[];
  readonly onRepair?: (info: {
    readonly toolName: string;
    readonly rung: number | undefined;
    readonly ok: boolean;
  }) => void;
  /**
   * Prefill progress (0..1) forwarded from the provider's `prompt_progress`
   * frames. The harness wires this to `ctx.ui.setStatus('harness-prefill', …)`
   * (it owns the per-turn ExtensionContext the provider can't reach), which the
   * desktop "N% processing" ring reads.
   */
  readonly onPromptProgress?: (fraction: number) => void;
}

/** Mutable holder the streamSimple resolves at call time (see `repairProvider`). */
export interface RepairBridge {
  current: LiveRepairDeps | undefined;
}

/** Create an empty bridge (no live deps until the harness connects). */
export function createRepairBridge(): RepairBridge {
  return { current: undefined };
}

/**
 * `pi.events` channel: provider → harness, announcing a {@link RepairBridgeReady}
 * so the harness can push its deps. Emitted once on connect and re-emitted each
 * time the harness says hello.
 */
export const REPAIR_BRIDGE_READY = 'pi-desktop/repair:provider-ready';

/**
 * `pi.events` channel: harness → provider, a bare ping that makes the provider
 * re-announce {@link REPAIR_BRIDGE_READY} (covers the provider-loaded-first case,
 * where the harness missed the first announce).
 */
export const REPAIR_BRIDGE_HELLO = 'pi-desktop/repair:harness-hello';

/** Payload carried on {@link REPAIR_BRIDGE_READY}. */
export interface RepairBridgeReady {
  readonly setDeps: (deps: LiveRepairDeps | undefined) => void;
}

/** The minimal `pi.events` surface this handshake needs. */
interface MinimalEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}
interface PiWithEvents {
  readonly events?: MinimalEventBus;
}

/**
 * Wire the provider side of the repair bridge over `pi.events`.
 *
 * Order-independent handshake: announce {@link REPAIR_BRIDGE_READY} now (covers
 * "harness loaded first"), and re-announce whenever the harness emits
 * {@link REPAIR_BRIDGE_HELLO} (covers "provider loaded first" — the real order,
 * where the harness only subscribes after us). Only the provider re-emits, so
 * there is no ping-pong. When `pi.events` is absent (e.g. unit tests), this is a
 * no-op and the provider keeps its static/local repair behavior.
 */
export function connectRepairBridge(pi: PiWithEvents, bridge: RepairBridge): void {
  const bus = pi.events;
  if (bus === undefined) return;
  const ready: RepairBridgeReady = {
    setDeps: (deps) => {
      bridge.current = deps;
    },
  };
  bus.on(REPAIR_BRIDGE_HELLO, () => bus.emit(REPAIR_BRIDGE_READY, ready));
  bus.emit(REPAIR_BRIDGE_READY, ready);
}
