import { type GenJob, type GenOutput, getModel } from '@pi-desktop/gen-service';
import { describe, expect, it, vi } from 'vitest';
import {
  buildVideoJob,
  HyperFramesRunner,
  hyperFramesRenderUnavailable,
  makeVideoAwareRunner,
  type VideoJobParams,
} from './video-dispatch';

/** A runner that records the jobs it received and returns a canned output. */
function fakeRunner(tag: string) {
  const calls: GenJob[] = [];
  return {
    calls,
    run: vi.fn(async (job: GenJob): Promise<GenOutput[]> => {
      calls.push(job);
      return [{ outputPath: `/out/${tag}.mp4`, modality: job.modality, model: tag }];
    }),
  };
}

const PARAMS: VideoJobParams = {
  prompt: 'a spinning logo',
  width: 768,
  height: 512,
  seconds: 4,
  fps: 24,
  seed: 7,
};

function jobOf(backend: GenJob['backend']): GenJob {
  return { id: 'j1', modality: 'video', backend, outputDir: '/out' };
}

describe('makeVideoAwareRunner', () => {
  it('routes comfyui → comfy, hyperframes → hyperframes, else → fallback', async () => {
    const comfy = fakeRunner('comfy');
    const hyperframes = fakeRunner('hf');
    const fallback = fakeRunner('uv');
    const runner = makeVideoAwareRunner({ comfy, hyperframes, fallback });

    await runner(jobOf('comfyui'), {});
    await runner(jobOf('hyperframes'), {});
    await runner(jobOf('mflux'), {});

    expect(comfy.run).toHaveBeenCalledTimes(1);
    expect(hyperframes.run).toHaveBeenCalledTimes(1);
    expect(fallback.run).toHaveBeenCalledTimes(1);
    // The image (mflux) path is unchanged — it still reaches the uv fallback.
    expect(fallback.calls[0]?.backend).toBe('mflux');
  });

  it('forwards onEvent/signal opts to the chosen runner', async () => {
    const comfy = fakeRunner('comfy');
    const runner = makeVideoAwareRunner({
      comfy,
      hyperframes: fakeRunner('hf'),
      fallback: fakeRunner('uv'),
    });
    const onEvent = vi.fn();
    await runner(jobOf('comfyui'), { onEvent });
    expect(comfy.run).toHaveBeenCalledWith(expect.objectContaining({ backend: 'comfyui' }), {
      onEvent,
    });
  });
});

describe('buildVideoJob', () => {
  it('builds a ComfyUI job for a comfyui-backed video model (frames = seconds × fps)', () => {
    const model = getModel('wan2.1-t2v-1.3b');
    if (model === undefined) throw new Error('missing wan2.1-t2v-1.3b in catalog');
    const job = buildVideoJob(model, PARAMS, 'job-c', '/out/dir');

    expect(job.backend).toBe('comfyui');
    expect(job.modality).toBe('video');
    expect(job.video).toBeUndefined();
    expect(job.comfy?.workflowTemplate).toBe(model.comfy?.workflowTemplate);
    expect(job.comfy?.modelId).toBe('wan2.1-t2v-1.3b');
    expect(job.comfy?.seeds).toEqual([7]);
    // 4s × 24fps = 96 frames; only template-bound keys are present (no fps/seconds).
    expect(job.comfy?.inputs).toMatchObject({
      prompt: 'a spinning logo',
      width: 768,
      height: 512,
      length: 96,
    });
    expect(job.comfy?.inputs.fps).toBeUndefined();
    expect(job.comfy?.inputs.seconds).toBeUndefined();
  });

  it('builds a HyperFrames video job for the hyperframes-backed model', () => {
    const model = getModel('hyperframes');
    if (model === undefined) throw new Error('missing hyperframes in catalog');
    const job = buildVideoJob(model, PARAMS, 'job-h', '/out/dir');

    expect(job.backend).toBe('hyperframes');
    expect(job.comfy).toBeUndefined();
    expect(job.video).toMatchObject({
      prompt: 'a spinning logo',
      modelId: 'hyperframes',
      width: 768,
      height: 512,
      seconds: 4,
      fps: 24,
      seeds: [7],
    });
  });

  it('rejects a non-video model', () => {
    const image = getModel('flux2-klein-4b');
    if (image === undefined) throw new Error('missing flux2-klein-4b');
    expect(() => buildVideoJob(image, PARAMS, 'x', '/out')).toThrow(/not a video model/);
  });
});

describe('HyperFramesRunner', () => {
  it("delegates to the injected renderer with the job's video spec", async () => {
    const render = vi.fn(async () => [
      { outputPath: '/out/hf.mp4', modality: 'video' as const, model: 'hyperframes' },
    ]);
    const runner = new HyperFramesRunner(render);
    const model = getModel('hyperframes');
    if (model === undefined) throw new Error('missing hyperframes');
    const job = buildVideoJob(model, PARAMS, 'job-h', '/out/dir');

    const onEvent = vi.fn();
    const outputs = await runner.run(job, { onEvent });

    expect(outputs).toHaveLength(1);
    expect(render).toHaveBeenCalledWith(job.video, '/out/dir', expect.any(Function), undefined);
  });

  it('throws when the job is missing its `video` spec', async () => {
    const runner = new HyperFramesRunner(async () => []);
    await expect(runner.run(jobOf('hyperframes'), {})).rejects.toThrow(/missing its `video` spec/);
  });

  it('the default (not-installed) renderer emits an error event and rejects', async () => {
    const model = getModel('hyperframes');
    if (model === undefined) throw new Error('missing hyperframes');
    const job = buildVideoJob(model, PARAMS, 'job-h', '/out/dir');
    const onEvent = vi.fn();
    const runner = new HyperFramesRunner(hyperFramesRenderUnavailable);

    await expect(runner.run(job, { onEvent })).rejects.toThrow(/not installed/);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'error' }));
  });
});
