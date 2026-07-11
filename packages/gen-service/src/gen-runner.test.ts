import { describe, expect, it, vi } from 'vitest';
import { type GenRunnerLike, makeGenRunner } from './gen-runner.ts';
import type { GenJob, GenOutput } from './protocol.ts';

function fakeRunner(tag: string): GenRunnerLike & { calls: GenJob[] } {
  const calls: GenJob[] = [];
  return {
    calls,
    run: vi.fn(async (job: GenJob): Promise<GenOutput[]> => {
      calls.push(job);
      return [{ outputPath: `/out/${tag}.bin`, modality: job.modality, model: tag }];
    }),
  };
}

const imageJob: GenJob = {
  id: 'j-img',
  modality: 'image',
  backend: 'mflux',
  outputDir: '/out',
  image: {
    prompt: 'x',
    modelId: 'z-image-turbo',
    mfluxCommand: 'mflux-generate-z-image-turbo',
    seeds: [1],
  },
};
const comfyJob: GenJob = {
  id: 'j-vid',
  modality: 'video',
  backend: 'comfyui',
  outputDir: '/out',
  comfy: {
    prompt: 'x',
    modelId: 'ltx-2',
    workflowTemplate: 'ltx-2-distilled-gguf',
    inputs: {},
    seeds: [1],
  },
};

describe('makeGenRunner', () => {
  it('routes comfyui jobs to the ComfyClient and everything else to the uv-worker client', async () => {
    const comfy = fakeRunner('comfy');
    const gen = fakeRunner('gen');
    const runner = makeGenRunner({ comfy, gen });

    const vid = await runner(comfyJob, {});
    const img = await runner(imageJob, {});

    expect(vid[0]?.model).toBe('comfy');
    expect(img[0]?.model).toBe('gen');
    expect(comfy.calls.map((j) => j.id)).toEqual(['j-vid']);
    expect(gen.calls.map((j) => j.id)).toEqual(['j-img']);
  });

  it('forwards onEvent / signal / extraWith through to the selected runner', async () => {
    const comfy = fakeRunner('comfy');
    const gen = fakeRunner('gen');
    const runner = makeGenRunner({ comfy, gen });
    const controller = new AbortController();
    const onEvent = vi.fn();

    await runner(comfyJob, { onEvent, signal: controller.signal, extraWith: ['x'] });
    expect(comfy.run).toHaveBeenCalledWith(
      comfyJob,
      expect.objectContaining({ onEvent, signal: controller.signal, extraWith: ['x'] }),
    );
  });

  it('defaults the non-comfy runner to a GenServiceClient when `gen` is omitted', async () => {
    const comfy = fakeRunner('comfy');
    // Only comfy provided; the default GenServiceClient is constructed but never
    // invoked here (we only route a comfyui job), so no uv/Python is touched.
    const runner = makeGenRunner({ comfy });
    const out = await runner(comfyJob, {});
    expect(out[0]?.model).toBe('comfy');
  });
});
