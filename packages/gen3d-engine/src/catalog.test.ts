import { describe, expect, it } from 'vitest';
import {
  autoremesherCli,
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

  it('covers every contract model id exactly once', () => {
    expect(GEN3D_MODEL_SPECS.map((s) => s.id).sort()).toEqual([
      'autoremesher',
      'cube3d',
      'cubepart',
      'dasheng-sfx',
      'humanoid-rig',
      'mageflow',
      'mageflow-edit',
      'parakeet-asr',
      'qwen3-tts',
      'skintokens',
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

  it('cube3d is a TEXT-to-shape geometry model sharing the CubePart checkout', () => {
    // Two models in one repo: cube3d generates from text with no image hop,
    // cubepart decomposes an existing shape. They share the 'cubepart' env
    // because they share the checkout and its venv.
    const cube = GEN3D_MODEL_SPECS.find((s) => s.id === 'cube3d');
    expect(cube?.role).toBe('geometry');
    expect(cube?.env).toBe('cubepart');
    expect(cube?.repos[0]?.repo).toBe('Roblox/cube3d-v0.5');
  });

  it('ships NO separate texture model — TRELLIS re-bakes its own colours', () => {
    // Texturing used to pull Hunyuan Paint: the paintpbr subset (6.89 GB) plus
    // dinov2-giant (4.55 GB) = 11.4 GB of weights for something TRELLIS already
    // produces. The generation now saves its voxel colour field beside the mesh
    // and the Texture stage re-bakes from that, so nothing here backs 'texture'.
    expect(GEN3D_MODEL_SPECS.filter((s) => s.role === 'texture')).toEqual([]);
  });

  it('autoremesher has no weights — its size is the release dmg', () => {
    const remesher = GEN3D_MODEL_SPECS.find((s) => s.id === 'autoremesher');
    expect(remesher?.repos).toHaveLength(0);
    expect(specTotalBytes(remesher as NonNullable<typeof remesher>)).toBe(17_259_387);
  });

  it('detectInstalled reduces stamp-file existence per weight-backed model', () => {
    const cache = '/cache';
    const present = new Set([installStampPath(cache, 'trellis2'), autoremesherCli(cache)]);
    const installed = detectInstalled((p) => present.has(p), cache);
    expect(installed.trellis2).toBe(true);
    expect(installed.mageflow).toBe(false);
    expect(installed.cubepart).toBe(false);
    // Tools with nothing to download earn no stamp — probe what they need.
    expect(installed.autoremesher).toBe(true);
    expect(installed['humanoid-rig']).toBe(true);
  });

  it('a missing AutoRemesher binary reads as not installed, stamp or not', () => {
    const installed = detectInstalled(() => false, '/cache');
    expect(installed.autoremesher).toBe(false);
  });

  it('sidecar registry carries repos, mirrors and pipeline types', () => {
    const registry = toSidecarRegistry();
    expect(registry.models).toHaveLength(11);
    expect(registry.gatedMirrors['facebook/dinov3-vitl16-pretrain-lvd1689m']).toContain(
      'camenduru',
    );
    expect(registry.pipelineTypes.high).toBe('1536_cascade');
    const mageflow = registry.models.find((m) => m.id === 'mageflow');
    expect(mageflow?.totalBytes).toBe(17_463_920_534);
  });
});
