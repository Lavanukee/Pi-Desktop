import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { checkDenylist, createMacConsentGate } from './permissions.js';

/** Minimal ctx stub: only hasUI + ui.confirm are read by the gate. */
function ctxStub(hasUI: boolean, confirmResult: boolean): ExtensionContext {
  return {
    hasUI,
    ui: { confirm: vi.fn(async () => confirmResult) },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for the gate.
  } as any as ExtensionContext;
}

describe('checkDenylist', () => {
  it('refuses Pi Desktop, keychain, and system settings (case-insensitive)', () => {
    expect(checkDenylist('Pi Desktop')).toContain('denylist');
    expect(checkDenylist('Keychain Access')).toContain('denylist');
    expect(checkDenylist('System Settings')).toContain('denylist');
    expect(checkDenylist('app.pidesktop.desktop')).toContain('denylist');
  });

  it('allows ordinary apps and empty/undefined targets', () => {
    expect(checkDenylist('TextEdit')).toBeNull();
    expect(checkDenylist('Safari')).toBeNull();
    expect(checkDenylist(undefined)).toBeNull();
    expect(checkDenylist('')).toBeNull();
  });
});

describe('createMacConsentGate', () => {
  it('blocks a denylisted target regardless of consent', async () => {
    const gate = createMacConsentGate({ preConsented: true });
    const d = await gate.ensure(ctxStub(true, true), 'Pi Desktop');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain('denylist');
  });

  it('asks once, remembers the yes for the session', async () => {
    const gate = createMacConsentGate();
    const ctx = ctxStub(true, true);
    expect(gate.isConsented()).toBe(false);
    const first = await gate.ensure(ctx, 'TextEdit');
    expect(first.ok).toBe(true);
    expect(gate.isConsented()).toBe(true);
    const second = await gate.ensure(ctx, 'TextEdit');
    expect(second.ok).toBe(true);
    // confirm was called only once (first action) — remembered thereafter.
    expect((ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('blocks (fail-safe) when there is no UI to confirm', async () => {
    const gate = createMacConsentGate();
    const d = await gate.ensure(ctxStub(false, true), 'TextEdit');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain('no UI');
  });

  it('blocks when the user declines', async () => {
    const gate = createMacConsentGate();
    const d = await gate.ensure(ctxStub(true, false), 'TextEdit');
    expect(d.ok).toBe(false);
    expect(gate.isConsented()).toBe(false);
  });
});
