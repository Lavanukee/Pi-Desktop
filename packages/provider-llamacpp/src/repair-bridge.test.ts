/**
 * The cross-extension repair bridge handshake, driven over pi's REAL EventBus.
 *
 * Proves the order-independent rendezvous: the harness (simulated here as a bare
 * subscriber + emitter on the same bus) ends up with the provider's `setDeps` and
 * can push LiveRepairDeps that the bridge holder then exposes — regardless of
 * which side connected first.
 */
import { createEventBus, type EventBus } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  connectRepairBridge,
  createRepairBridge,
  type LiveRepairDeps,
  REPAIR_BRIDGE_HELLO,
  REPAIR_BRIDGE_READY,
  type RepairBridgeReady,
} from './repair-bridge.js';

/** Minimal harness side: subscribe to READY, say HELLO, push deps when wired. */
function fakeHarness(bus: EventBus, deps: LiveRepairDeps): void {
  bus.on(REPAIR_BRIDGE_READY, (data) => {
    (data as RepairBridgeReady).setDeps(deps);
  });
  bus.emit(REPAIR_BRIDGE_HELLO, {});
}

describe('connectRepairBridge — handshake', () => {
  const deps: LiveRepairDeps = { onRepair: vi.fn() };

  it('provider-loaded-first: harness catches the re-announced ready and pushes deps', () => {
    const bus = createEventBus();
    const bridge = createRepairBridge();
    connectRepairBridge({ events: bus }, bridge); // provider first
    expect(bridge.current).toBeUndefined();
    fakeHarness(bus, deps); // harness joins later
    expect(bridge.current).toBe(deps);
  });

  it('harness-loaded-first: provider announce reaches the waiting harness', () => {
    const bus = createEventBus();
    const bridge = createRepairBridge();
    // Harness subscribes + says hello before the provider exists.
    let pushed: LiveRepairDeps | undefined;
    bus.on(REPAIR_BRIDGE_READY, (data) => {
      (data as RepairBridgeReady).setDeps(deps);
      pushed = deps;
    });
    bus.emit(REPAIR_BRIDGE_HELLO, {});
    expect(pushed).toBeUndefined();
    connectRepairBridge({ events: bus }, bridge); // provider joins later
    expect(bridge.current).toBe(deps);
  });

  it('is a no-op without an event bus (static/local behavior)', () => {
    const bridge = createRepairBridge();
    expect(() => connectRepairBridge({}, bridge)).not.toThrow();
    expect(bridge.current).toBeUndefined();
  });
});
