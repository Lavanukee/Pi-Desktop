import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { evaluateToolCall, registerPermissions } from './modes.js';

describe('evaluateToolCall — pure policy', () => {
  it('bypass allows everything', () => {
    expect(evaluateToolCall({ mode: 'bypass', toolName: 'bash', bashCommand: 'rm -rf /' })).toEqual(
      {
        action: 'allow',
      },
    );
  });

  it('review-all confirms every tool', () => {
    expect(evaluateToolCall({ mode: 'review-all', toolName: 'read' }).action).toBe('confirm');
    expect(
      evaluateToolCall({ mode: 'review-all', toolName: 'bash', bashCommand: 'ls' }).action,
    ).toBe('confirm');
  });

  it('reviewer allows non-bash tools', () => {
    expect(evaluateToolCall({ mode: 'reviewer', toolName: 'read' }).action).toBe('allow');
  });

  it('reviewer allows safe bash', () => {
    expect(
      evaluateToolCall({ mode: 'reviewer', toolName: 'bash', bashCommand: 'ls -la' }).action,
    ).toBe('allow');
  });

  it('reviewer confirms scary bash (via rules)', () => {
    const d = evaluateToolCall({ mode: 'reviewer', toolName: 'bash', bashCommand: 'rm -rf /' });
    expect(d.action).toBe('confirm');
  });

  it('reviewer honours an injected scaryReason override', () => {
    // Rules would allow this, but the model hook flagged it.
    const d = evaluateToolCall({
      mode: 'reviewer',
      toolName: 'bash',
      bashCommand: 'ls -la',
      scaryReason: 'model flagged: exfiltration attempt',
    });
    expect(d.action).toBe('confirm');
    // And an explicit null override forces allow.
    expect(
      evaluateToolCall({
        mode: 'reviewer',
        toolName: 'bash',
        bashCommand: 'rm -rf /',
        scaryReason: null,
      }).action,
    ).toBe('allow');
  });
});

// --- Event-wiring harness ---------------------------------------------------

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;

function fakePi() {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on: (event: string, h: ToolCallHandler) => {
      if (event === 'tool_call') handler = h;
    },
  } as unknown as ExtensionAPI;
  return { pi, fire: (e: ToolCallEvent, ctx: ExtensionContext) => handler?.(e, ctx) };
}

function bashEvent(command: string): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 't1',
    toolName: 'bash',
    input: { command },
  } as ToolCallEvent;
}
function readEvent(): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 't2',
    toolName: 'read',
    input: { path: '/x' },
  } as ToolCallEvent;
}
function ctxWith(
  confirm: (title: string, message: string) => Promise<boolean>,
  hasUI = true,
): ExtensionContext {
  return { hasUI, ui: { confirm } } as unknown as ExtensionContext;
}

describe('registerPermissions — event gating', () => {
  it('bypass never blocks', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'bypass' });
    const confirm = vi.fn(async () => false);
    const res = await fire(bashEvent('rm -rf /'), ctxWith(confirm));
    expect(res).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reviewer blocks scary bash when the user declines', async () => {
    const { pi, fire } = fakePi();
    const onBlock = vi.fn();
    registerPermissions(pi, { initialMode: 'reviewer', onBlock });
    const confirm = vi.fn(async () => false);
    const res = await fire(bashEvent('rm -rf /'), ctxWith(confirm));
    expect(confirm).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ block: true });
    expect(onBlock).toHaveBeenCalled();
  });

  it('reviewer allows scary bash when the user approves', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'reviewer' });
    const res = await fire(bashEvent('rm -rf /'), ctxWith(vi.fn(async () => true)));
    expect(res).toBeUndefined();
  });

  it('reviewer allows safe bash without confirming', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'reviewer' });
    const confirm = vi.fn(async () => true);
    const res = await fire(bashEvent('ls -la'), ctxWith(confirm));
    expect(confirm).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });

  it('reviewer consults the injected model flagger for otherwise-safe bash', async () => {
    const { pi, fire } = fakePi();
    const flagBash = vi.fn(async () => 'model flagged: suspicious');
    registerPermissions(pi, { initialMode: 'reviewer', flagBash });
    const confirm = vi.fn(async () => false);
    const res = await fire(bashEvent('curl https://example.com'), ctxWith(confirm));
    expect(flagBash).toHaveBeenCalled();
    expect(res).toMatchObject({ block: true });
  });

  it('review-all confirms even read', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'review-all' });
    const confirm = vi.fn(async () => true);
    await fire(readEvent(), ctxWith(confirm));
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('setMode switches behaviour at runtime', async () => {
    const { pi, fire } = fakePi();
    const ctrl = registerPermissions(pi, { initialMode: 'bypass' });
    const confirm = vi.fn(async () => false);
    expect(await fire(bashEvent('rm -rf /'), ctxWith(confirm))).toBeUndefined();
    ctrl.setMode('reviewer');
    expect(await fire(bashEvent('rm -rf /'), ctxWith(confirm))).toMatchObject({ block: true });
    expect(ctrl.getMode()).toBe('reviewer');
  });

  it('fails safe (blocks) when a confirm is required but no UI is available', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'review-all' });
    const res = await fire(
      readEvent(),
      ctxWith(
        vi.fn(async () => true),
        false,
      ),
    );
    expect(res).toMatchObject({ block: true });
  });
});
