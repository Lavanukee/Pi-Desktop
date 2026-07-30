/**
 * `use` is what makes a capability free.
 *
 * The advertised tool list never changes, so the prompt prefix is never rewritten
 * and no turn pays a re-prefill; a capability just appends a result naming what
 * the model may now call, and `use` carries the call. jedd, insisting on exactly
 * this: "there's no way we *need* to pay a prefill of whole context when a new
 * capability is activated."
 *
 * The registry it dispatches through captures each tool's real `execute` at
 * registration, because pi's own getAllTools() omits it.
 */
import { describe, expect, it, vi } from 'vitest';
import { captureRegisteredTools } from './tool-registry';
import { registerUseTool, USE_TOOL_NAME } from './use-tool';

/** A minimal pi stand-in: records definitions, exposes the registered `use`. */
function fakePi() {
  const defs = new Map<string, { name: string; execute: (...a: unknown[]) => Promise<unknown> }>();
  const pi = {
    registerTool: (def: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => {
      defs.set(def.name, def);
    },
  };
  return { pi, defs };
}

describe('capturing what other extensions register', () => {
  it('remembers a tool’s EXECUTE, which pi otherwise never hands out', async () => {
    const { pi, defs } = fakePi();
    const registry = captureRegisteredTools(pi);
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ran' }] }));
    pi.registerTool({ name: 'mac_snapshot', execute });
    expect(registry.get('mac_snapshot')).toBeDefined();
    // …and it still reached the real registrar: the wrapper is transparent.
    expect(defs.has('mac_snapshot')).toBe(true);
  });

  it('ignores anything that is not a runnable tool', () => {
    const { pi } = fakePi();
    const registry = captureRegisteredTools(pi);
    pi.registerTool({ name: 'no_exec' } as never);
    expect(registry.get('no_exec')).toBeUndefined();
  });
});

describe('dispatching', () => {
  const setup = () => {
    const { pi } = fakePi();
    const registry = captureRegisteredTools(pi);
    const execute = vi.fn(async (..._a: unknown[]) => ({
      content: [{ type: 'text', text: 'snapshot!' }],
    }));
    pi.registerTool({ name: 'mac_snapshot', execute });
    registerUseTool(pi as never, { registry, active: () => ['read', 'bash'] });
    const use = registry.get(USE_TOOL_NAME);
    if (use === undefined) throw new Error('use was not registered');
    return { use, execute };
  };

  it('calls the named tool, passing its arguments through', async () => {
    const { use, execute } = setup();
    const out = (await use.execute('id-1', { tool: 'mac_snapshot', args: { app: 'Safari' } })) as {
      content: { text: string }[];
    };
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual({ app: 'Safari' });
    expect(out.content[0]?.text).toBe('snapshot!');
  });

  it('defaults missing args to an empty object rather than undefined', async () => {
    const { use, execute } = setup();
    await use.execute('id-1', { tool: 'mac_snapshot' });
    expect(execute.mock.calls[0]?.[1]).toEqual({});
  });

  it('will not call itself', async () => {
    const { use, execute } = setup();
    await use.execute('id-1', { tool: USE_TOOL_NAME, args: {} });
    expect(execute).not.toHaveBeenCalled();
  });

  it('names what IS reachable when the tool is unknown', async () => {
    // A bare "unknown tool" just invites another guess.
    const { use } = setup();
    const out = (await use.execute('id-1', { tool: 'nope' })) as { content: { text: string }[] };
    expect(out.content[0]?.text).toContain('no tool called "nope"');
    expect(out.content[0]?.text).toContain('mac_snapshot');
  });

  it('asks for a name when given none', async () => {
    const { use, execute } = setup();
    const out = (await use.execute('id-1', {})) as { content: { text: string }[] };
    expect(out.content[0]?.text).toContain('name of the tool');
    expect(execute).not.toHaveBeenCalled();
  });
});
