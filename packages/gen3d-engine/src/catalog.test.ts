import { describe, expect, it } from 'vitest';
import {
  detectInstalled,
  GEN3D_MODEL_SPECS,
  installStampPath,
  specTotalBytes,
  TRELLIS_PIPELINE_TYPES,
  TRELLIS_RESOLUTIONS,
  toSidecarRegistry,
} from './catalog';

describe('catalog', () => {
  it('carries the verified TRELLIS resolution presets (512/1024/1536, not 768)', () => {
    expect(TRELLIS_RESOLUTIONS).toEqual({ low: 512, medium: 1024, high: 1536 });
    expect(TRELLIS_PIPELINE_TYPES.low).toBe('512');
    expect(TRELLIS_PIPELINE_TYPES.medium).toBe('1024_cascade');
    expect(TRELLIS_PIPELINE_TYPES.high).toBe('1536_cascade');
  });

  it('covers all five contract model ids exactly once', () => {
    expect(GEN3D_MODEL_SPECS.map((s) => s.id).sort()).toEqual([
      'autoremesher',
      'cubepart',
      'hunyuan-paint',
      'mageflow',
      'trellis2',
    ]);
  });

  it('trellis2 totals its four repos (core + ss-decoder + the two gated substitutes)', () => {
    const trellis = GEN3D_MODEL_SPECS.find((s) => s.id === 'trellis2');
    expect(trellis).toBeDefined();
    if (trellis === undefined) return;
    expect(trellis.repos).toHaveLength(4);
    expect(specTotalBytes(trellis)).toBe(
      16_237_485_044 + 147_592_217 + 1_212_584_680 + 444_566_195,
    );
  });

  it('hunyuan-paint downloads the paint subset + dinov2 conditioner (11.4 GB, not 14.9 GB repo)', () => {
    const paint = GEN3D_MODEL_SPECS.find((s) => s.id === 'hunyuan-paint');
    expect(paint?.repos[0]?.allowPatterns).toEqual(['hunyuan3d-paintpbr-v2-1/*', 'hy3dpaint/*']);
    expect(paint?.repos[1]?.repo).toBe('facebook/dinov2-giant');
    expect(specTotalBytes(paint as NonNullable<typeof paint>)).toBe(6_887_601_302 + 4_546_006_416);
  });

  it('autoremesher has no weights — its size is the release dmg', () => {
    const remesher = GEN3D_MODEL_SPECS.find((s) => s.id === 'autoremesher');
    expect(remesher?.repos).toHaveLength(0);
    expect(specTotalBytes(remesher as NonNullable<typeof remesher>)).toBe(17_259_387);
  });

  it('detectInstalled reduces stamp-file existence per model', () => {
    const cache = '/cache';
    const present = new Set([
      installStampPath(cache, 'trellis2'),
      installStampPath(cache, 'autoremesher'),
    ]);
    const installed = detectInstalled((p) => present.has(p), cache);
    expect(installed.trellis2).toBe(true);
    expect(installed.autoremesher).toBe(true);
    expect(installed.mageflow).toBe(false);
    expect(installed.cubepart).toBe(false);
  });

  it('sidecar registry carries repos, mirrors and pipeline types', () => {
    const registry = toSidecarRegistry();
    expect(registry.models).toHaveLength(5);
    expect(registry.gatedMirrors['facebook/dinov3-vitl16-pretrain-lvd1689m']).toContain(
      'camenduru',
    );
    expect(registry.pipelineTypes.high).toBe('1536_cascade');
    const mageflow = registry.models.find((m) => m.id === 'mageflow');
    expect(mageflow?.totalBytes).toBe(17_463_920_534);
  });
});
