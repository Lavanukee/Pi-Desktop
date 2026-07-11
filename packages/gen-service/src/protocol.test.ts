import { describe, expect, it } from 'vitest';
import {
  type AudioJobSpec,
  type Backend,
  type ComfyBackendConfig,
  type ComfyJobSpec,
  type GenEvent,
  type GenJob,
  isGenEvent,
  NdjsonParser,
  parseGenEventLine,
} from './protocol.ts';

describe('parseGenEventLine', () => {
  it('parses a progress event', () => {
    const event = parseGenEventLine(
      '{"event":"progress","jobId":"j1","candidate":0,"step":2,"total":6}',
    );
    expect(event).toEqual({
      event: 'progress',
      jobId: 'j1',
      candidate: 0,
      step: 2,
      total: 6,
    });
  });

  it('ignores blank lines and whitespace', () => {
    expect(parseGenEventLine('')).toBeNull();
    expect(parseGenEventLine('   \t ')).toBeNull();
  });

  it('ignores non-JSON keep-alives / stray output', () => {
    expect(parseGenEventLine('not json')).toBeNull();
    expect(parseGenEventLine('Fetching 4 files: 100%')).toBeNull();
  });

  it('rejects JSON that is not a recognised event', () => {
    expect(parseGenEventLine('{"foo":1}')).toBeNull();
    expect(parseGenEventLine('{"event":"bogus"}')).toBeNull();
    expect(parseGenEventLine('42')).toBeNull();
    expect(parseGenEventLine('null')).toBeNull();
  });
});

describe('isGenEvent', () => {
  it('accepts every event kind', () => {
    const kinds = ['start', 'download', 'progress', 'candidate', 'done', 'error', 'log'];
    for (const event of kinds) {
      expect(isGenEvent({ event })).toBe(true);
    }
  });
  it('rejects non-objects and unknown kinds', () => {
    expect(isGenEvent(null)).toBe(false);
    expect(isGenEvent('start')).toBe(false);
    expect(isGenEvent({ event: 'nope' })).toBe(false);
    expect(isGenEvent({})).toBe(false);
  });
});

describe('Backend union + ComfyUI job shape', () => {
  it('admits comfyui + the new torch-tts backend alongside the uv-worker backends', () => {
    const backends: Backend[] = [
      'mflux',
      'mlx-audio',
      'torch-tts',
      'triposr',
      'trellis',
      'hyperframes',
      'comfyui',
    ];
    // The comfyui persistent-server backend is a first-class member of the union.
    expect(backends).toContain('comfyui');
    // torch-tts (Chatterbox) is the new torch/MPS→CPU TTS path.
    expect(backends).toContain('torch-tts');
  });

  it('resolves a comfyui job through the `comfy` arm (image arm left empty)', () => {
    const spec: ComfyJobSpec = {
      prompt: 'a neon city at night, cinematic',
      modelId: 'ltx-2',
      workflowTemplate: 'ltx-2-distilled-gguf',
      inputs: { prompt: 'a neon city at night', width: 768, height: 512, length: 97, steps: 8 },
      seeds: [1, 2],
    };
    const job: GenJob = {
      id: 'v1',
      modality: 'video',
      backend: 'comfyui',
      outputDir: '/out',
      comfy: spec,
    };
    expect(job.comfy?.workflowTemplate).toBe('ltx-2-distilled-gguf');
    expect(job.comfy?.seeds).toEqual([1, 2]);
    expect(job.comfy?.inputs.width).toBe(768);
    // The image arm is untouched by the comfy arm.
    expect(job.image).toBeUndefined();
  });

  it('ComfyBackendConfig binds catalog params to node-input paths', () => {
    const cfg: ComfyBackendConfig = {
      kind: 'comfyui',
      workflowTemplate: 'ace-step-music',
      paramMap: { prompt: '14.inputs.tags', seconds: '17.inputs.seconds', seed: '3.inputs.seed' },
    };
    expect(cfg.kind).toBe('comfyui');
    expect(cfg.paramMap.prompt).toBe('14.inputs.tags');
  });

  it('leaves the GenEvent union unchanged (no comfy event kinds)', () => {
    // GenEvent is shared across both backends — the comfy adapter translates ws
    // messages INTO these same kinds, so the recognised set must not have grown.
    for (const kind of ['comfy', 'prompt', 'executing', 'ws']) {
      expect(isGenEvent({ event: kind })).toBe(false);
    }
    const kinds = ['start', 'download', 'progress', 'candidate', 'done', 'error', 'log'];
    for (const kind of kinds) expect(isGenEvent({ event: kind })).toBe(true);
  });
});

describe('AudioJobSpec (TTS arm + zero-shot clone wiring)', () => {
  it('resolves a TTS job through the `audio` arm with the resolved mlx-audio model', () => {
    const spec: AudioJobSpec = {
      prompt: 'hello from pi',
      modelId: 'kokoro-82m',
      mlxAudioModel: 'prince-canuma/Kokoro-82M',
      voice: 'af_heart',
      seeds: [0],
    };
    const job: GenJob = {
      id: 'a1',
      modality: 'audio',
      backend: 'mlx-audio',
      outputDir: '/out',
      audio: spec,
    };
    expect(job.audio?.mlxAudioModel).toBe('prince-canuma/Kokoro-82M');
    expect(job.audio?.seeds).toEqual([0]);
    // The image / comfy arms are untouched by the audio arm.
    expect(job.image).toBeUndefined();
    expect(job.comfy).toBeUndefined();
  });

  it('carries optional refAudio/refText for zero-shot voice clone', () => {
    const spec: AudioJobSpec = {
      prompt: 'clone this voice',
      modelId: 'qwen3-tts-1.7b',
      mlxAudioModel: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
      refAudio: '/refs/sample.wav',
      refText: 'the quick brown fox',
      seeds: [1, 2],
    };
    expect(spec.refAudio).toBe('/refs/sample.wav');
    expect(spec.refText).toBe('the quick brown fox');
    // Preset-voice jobs simply omit both fields (they are optional).
    const preset: AudioJobSpec = {
      prompt: 'preset only',
      modelId: 'kokoro-82m',
      mlxAudioModel: 'prince-canuma/Kokoro-82M',
      seeds: [0],
    };
    expect(preset.refAudio).toBeUndefined();
    expect(preset.refText).toBeUndefined();
  });
});

describe('NdjsonParser', () => {
  it('emits events split across chunk boundaries', () => {
    const parser = new NdjsonParser();
    // A line split mid-way across two pushes.
    const first = parser.push('{"event":"start","jobId":"j","tot');
    expect(first).toEqual([]);
    const second = parser.push('al":6,"candidates":1}\n{"event":"log","jobId":"j","text":"hi"}\n');
    expect(second.map((e) => e.event)).toEqual(['start', 'log']);
  });

  it('buffers a partial trailing line until flushed', () => {
    const parser = new NdjsonParser();
    parser.push('{"event":"done","jobId":"j","outputs":[]}');
    // No newline yet → nothing emitted.
    expect(parser.push('')).toEqual([]);
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.event).toBe('done');
  });

  it('drops interleaved noise lines but keeps the events', () => {
    const parser = new NdjsonParser();
    const events = parser.push(
      'garbage line\n{"event":"progress","jobId":"j","candidate":0,"step":1,"total":4}\n\n{"event":"candidate","jobId":"j","index":0,"output":{"outputPath":"/a.png","modality":"image","model":"z-image-turbo"}}\n',
    );
    expect(events.map((e) => e.event)).toEqual(['progress', 'candidate']);
  });

  it('flush is a no-op when the buffer is empty or non-event', () => {
    const parser = new NdjsonParser();
    expect(parser.flush()).toEqual([]);
    parser.push('trailing noise with no newline');
    expect(parser.flush()).toEqual([]);
  });

  it('parses a full realistic job stream in order', () => {
    const parser = new NdjsonParser();
    const stream = [
      '{"event":"start","jobId":"j","total":4,"candidates":1}',
      '{"event":"download","jobId":"j","ratio":0.5,"detail":"Fetching"}',
      '{"event":"progress","jobId":"j","candidate":0,"step":1,"total":4,"previewPath":"/s.png"}',
      '{"event":"candidate","jobId":"j","index":0,"output":{"outputPath":"/o.png","modality":"image","model":"z-image-turbo","seed":42}}',
      '{"event":"done","jobId":"j","outputs":[{"outputPath":"/o.png","modality":"image","model":"z-image-turbo","seed":42}]}',
    ].join('\n');
    const events: GenEvent[] = parser.push(`${stream}\n`);
    expect(events.map((e) => e.event)).toEqual([
      'start',
      'download',
      'progress',
      'candidate',
      'done',
    ]);
    const done = events.at(-1);
    if (done?.event !== 'done') throw new Error('expected done');
    expect(done.outputs[0]?.model).toBe('z-image-turbo');
  });
});
