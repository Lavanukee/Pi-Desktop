import { type Artifact, SurfaceRegistry } from '@pi-desktop/canvas';
import { describe, expect, it } from 'vitest';
import { GEN_IMAGE_KIND, genImageContent, registerGenImageSurface } from './register.tsx';

const MODEL = { id: 'flux2-klein-4b', label: 'FLUX.2 klein (4B)', license: 'apache-2.0' };

function genArtifact(): Artifact {
  return {
    id: 'a1',
    content: genImageContent({
      model: MODEL,
      status: 'done',
      candidates: [{ seed: 1, finalSrc: 'x.png', status: 'done' }],
    }),
  };
}

describe('registerGenImageSurface (additive)', () => {
  it('registers on an isolated registry and resolves gen-image artifacts', () => {
    const registry = new SurfaceRegistry();
    const unregister = registerGenImageSurface(registry);

    const resolved = registry.resolve(genArtifact());
    expect(resolved?.kind).toBe(GEN_IMAGE_KIND);
    expect(resolved?.canStream).toBe(true);
    expect(resolved?.opensInCanvas).toBe(true);

    unregister();
    expect(registry.resolve(genArtifact())).toBeUndefined();
  });

  it('outranks a generic image surface registered for the same artifact', () => {
    const registry = new SurfaceRegistry();
    // A lower-priority catch-all that would also match.
    registry.register({
      kind: 'image',
      canStream: false,
      priority: 0,
      match: () => true,
      component: () => null,
    });
    registerGenImageSurface(registry);
    expect(registry.resolve(genArtifact())?.kind).toBe(GEN_IMAGE_KIND);
  });

  it('does not match a plain image artifact', () => {
    const registry = new SurfaceRegistry();
    registerGenImageSurface(registry);
    const plain: Artifact = { id: 'i', content: { kind: 'image', text: 'p.png' } };
    expect(registry.resolve(plain)).toBeUndefined();
  });
});
