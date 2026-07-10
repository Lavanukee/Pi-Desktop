import { describe, expect, it } from 'vitest';
import type { Artifact } from './model.ts';
import { matchKind, type SurfaceProps, SurfaceRegistry } from './registry.ts';

const Dummy = (_props: SurfaceProps) => null;

function artifact(kind: string): Artifact {
  return { id: 'a', content: { kind, text: '' } };
}

describe('SurfaceRegistry', () => {
  it('resolves the surface whose match() passes', () => {
    const registry = new SurfaceRegistry();
    registry.register({
      kind: 'code',
      canStream: true,
      match: matchKind('code'),
      component: Dummy,
    });
    expect(registry.resolve(artifact('code'))?.kind).toBe('code');
    expect(registry.resolve(artifact('svg'))).toBeUndefined();
  });

  it('picks the highest priority among matches', () => {
    const registry = new SurfaceRegistry();
    const Low = (_p: SurfaceProps) => null;
    const High = (_p: SurfaceProps) => null;
    registry.register({
      kind: 'html',
      canStream: true,
      priority: 0,
      match: () => true,
      component: Low,
    });
    registry.register({
      kind: 'html',
      canStream: true,
      priority: 10,
      match: () => true,
      component: High,
    });
    expect(registry.resolve(artifact('html'))?.component).toBe(High);
  });

  it('prefers the most recently registered on equal priority (app overrides win)', () => {
    const registry = new SurfaceRegistry();
    const First = (_p: SurfaceProps) => null;
    const Second = (_p: SurfaceProps) => null;
    registry.register({ kind: 'code', canStream: true, match: () => true, component: First });
    registry.register({ kind: 'code', canStream: true, match: () => true, component: Second });
    expect(registry.resolve(artifact('code'))?.component).toBe(Second);
  });

  it('unregister() removes the surface', () => {
    const registry = new SurfaceRegistry();
    const off = registry.register({
      kind: 'svg',
      canStream: true,
      match: matchKind('svg'),
      component: Dummy,
    });
    expect(registry.resolve(artifact('svg'))).toBeDefined();
    off();
    expect(registry.resolve(artifact('svg'))).toBeUndefined();
  });

  it('is open to future kinds (enum + registry stay open)', () => {
    const registry = new SurfaceRegistry();
    registry.register({
      kind: 'video',
      canStream: false,
      match: matchKind('video'),
      component: Dummy,
    });
    expect(registry.resolve(artifact('video'))?.kind).toBe('video');
  });
});
