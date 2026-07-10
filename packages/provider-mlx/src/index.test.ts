import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import activate, { MLX_API, registerMlxProvider } from './index.js';

interface Registered {
  name: string;
  config: { api?: string; streamSimple?: unknown };
}

function fakePi(): { pi: ExtensionAPI; registered: Registered[] } {
  const registered: Registered[] = [];
  const pi = {
    registerProvider: (name: string, config: Registered['config']) => {
      registered.push({ name, config });
    },
    // Repair bridge handshake over pi.events — a no-op event bus here.
    events: { on: vi.fn(), emit: vi.fn() },
  } as unknown as ExtensionAPI;
  return { pi, registered };
}

describe('provider-mlx registration', () => {
  it('registers a streamSimple handler under the distinct mlx-stream api', () => {
    const { pi, registered } = fakePi();
    registerMlxProvider(pi);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe('mlx');
    expect(registered[0]?.config.api).toBe(MLX_API);
    expect(registered[0]?.config.api).toBe('mlx-stream');
    expect(typeof registered[0]?.config.streamSimple).toBe('function');
  });

  it('the default activate factory wires the provider (repair bridge self-connects)', () => {
    const { pi, registered } = fakePi();
    // Must not throw even though the harness bridge peer is absent.
    expect(() => activate(pi)).not.toThrow();
    expect(registered[0]?.config.api).toBe('mlx-stream');
  });
});
