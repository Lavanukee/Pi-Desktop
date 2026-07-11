import { describe, expect, it, vi } from 'vitest';
import {
  type ClassifyResult,
  classify,
  classifyWithEscalation,
  type TaskClass,
} from './classify.js';

/** Representative prompt corpus → expected class. */
const CORPUS: readonly [string, TaskClass][] = [
  // simple-QA — knowledge questions, no tools.
  ['What is the capital of France?', 'simple-QA'],
  ['Explain how closures work in JavaScript.', 'simple-QA'],
  ['Who wrote Pride and Prejudice?', 'simple-QA'],
  ["What's the difference between TCP and UDP?", 'simple-QA'],
  ['How do I center a div in CSS?', 'simple-QA'],

  // basic-tools — lookup / fetch / compute.
  ['Search the web for the latest Node.js LTS version.', 'basic-tools'],
  ["What's the weather in Tokyo right now?", 'basic-tools'],
  ['Look up the current exchange rate for USD to EUR.', 'basic-tools'],
  ['Fetch this page and give me the headline.', 'basic-tools'],
  ['Calculate the compound interest on $1000 at 5% over 10 years.', 'basic-tools'],

  // coding
  ['Refactor the authentication module to use async/await.', 'coding'],
  ['Debug this stack trace from the crash.', 'coding'],
  ['Fix the bug in src/parser.ts.', 'coding'],
  ['Implement a binary search function in TypeScript.', 'coding'],
  ['Run the unit tests and fix any failing ones in the repo.', 'coding'],

  // file-ops
  ['Rename all the files in my Downloads folder to snake_case.', 'file-ops'],
  ['Organize these photos into folders by date.', 'file-ops'],
  ['Batch rename my screenshots.', 'file-ops'],

  // browser-use
  ['Open the browser and scrape the top posts from Hacker News.', 'browser-use'],
  ['Navigate to github.com and log in to my account.', 'browser-use'],
  ['Fill out the signup form on this website.', 'browser-use'],

  // motion-graphics
  ['Create a motion graphics intro with animated text.', 'motion-graphics'],
  ['Animate this logo with a smooth keyframe transition.', 'motion-graphics'],

  // advanced-video (GENERATION: text→video)
  ['Edit this footage and export a highlight video.', 'advanced-video'],
  ['Render a video of a rocket launching into space.', 'advanced-video'],

  // video-edit (the ffmpeg façade: trim/concat/subtitles/…)
  ['Add subtitles to my movie.mp4 file.', 'video-edit'],
  ['Trim the first 10 seconds off my clip.', 'video-edit'],
  ['Splice these two clips together and remove silence.', 'video-edit'],
  ['Add a watermark to the corner of this video.', 'video-edit'],

  // perception (analysis: segment/detect/track/OCR)
  ['Segment the people in this photo.', 'perception'],
  ['Detect all the cars in the video and track them.', 'perception'],
  ['Find the red car in this image and draw a bounding box.', 'perception'],

  // 3d
  ['Model a low-poly character in Blender and export to .glb.', '3d'],
  ['Generate a 3D mesh from this reference.', '3d'],

  // 2d-art
  ['Draw an illustration of a fox in a forest.', '2d-art'],
  ['Generate an image of a sunset over mountains.', '2d-art'],
  ['Design a logo for my coffee shop.', '2d-art'],

  // other → tool-search-only
  ['Connect my Notion workspace as a connector.', 'other'],
  ['Set up a Slack integration for notifications.', 'other'],
  ['Sync my Google Calendar events.', 'other'],

  // Fallback — complex, multi-step, no dominant modality. The `full-shebang`
  // everything-tier was removed (round-10 #7): agentic build verbs fall back to
  // `basic-tools` (python + web; tool_search pulls in the rest on demand), and a
  // no-tool-signal prompt falls back to tool-search-only `other`.
  ['Build a full-stack todo app with authentication and deploy it.', 'basic-tools'],
  ['Set up a new project, write the code, and run everything.', 'basic-tools'],
  ['Plan and execute a marketing campaign end to end.', 'other'],
];

describe('classify — tier-1 heuristics corpus', () => {
  for (const [prompt, expected] of CORPUS) {
    it(`classifies "${prompt.slice(0, 48)}" → ${expected}`, () => {
      expect(classify({ prompt }).class).toBe(expected);
    });
  }
});

describe('classify — attachments steer the class', () => {
  it('a .glb attachment forces 3d', () => {
    expect(
      classify({ prompt: 'take a look at this', attachments: [{ name: 'model.glb' }] }).class,
    ).toBe('3d');
  });

  it('a bare video attachment (no verb) defaults to video-edit', () => {
    expect(
      classify({ prompt: 'here you go', attachments: [{ name: 'clip', mimeType: 'video/mp4' }] })
        .class,
    ).toBe('video-edit');
  });

  it('a video attachment + an edit verb → video-edit', () => {
    expect(
      classify({ prompt: 'trim the first 5 seconds', attachments: [{ name: 'clip.mp4' }] }).class,
    ).toBe('video-edit');
  });

  it('a video attachment + an analysis verb → perception', () => {
    expect(
      classify({ prompt: 'detect the people in this', attachments: [{ name: 'clip.mp4' }] }).class,
    ).toBe('perception');
  });

  it('a source file forces coding', () => {
    expect(classify({ prompt: 'have a look', attachments: [{ name: 'server.ts' }] }).class).toBe(
      'coding',
    );
  });

  it('inline images with no file → 2d-art', () => {
    expect(classify({ prompt: 'improve this', hasImages: true }).class).toBe('2d-art');
  });
});

describe('classify — conversation continuity', () => {
  it('a terse follow-up inherits the prior class', () => {
    const r = classify({ prompt: 'continue', priorClass: 'coding', turnIndex: 2 });
    expect(r.class).toBe('coding');
    expect(r.signals).toContain('continuation');
  });

  it('does not inherit on the first turn', () => {
    const r = classify({ prompt: 'continue', priorClass: 'coding', turnIndex: 0 });
    expect(r.class).not.toBe('coding');
  });
});

describe('classify — forcedClass short-circuit (composer "+" force actions)', () => {
  it('pins the forced class regardless of the prompt text or attachments', () => {
    // The prompt reads like a plain question, but the "+ → Generate video"
    // force action must still deterministically load advanced-video.
    const r = classify({
      prompt: 'what should I make?',
      forcedClass: 'advanced-video',
      attachments: [{ name: 'notes.txt' }],
    });
    expect(r.class).toBe('advanced-video');
    expect(r.confidence).toBe(1);
    expect(r.ambiguous).toBe(false);
    expect(r.signals).toContain('forced');
  });

  it('pins perception for "+ → Find / segment"', () => {
    expect(classify({ prompt: 'go', forcedClass: 'perception' }).class).toBe('perception');
  });

  it('wins over an otherwise-clear heuristic class', () => {
    // "Refactor the auth module" would classify as coding; the force wins.
    expect(classify({ prompt: 'Refactor the auth module.', forcedClass: 'video-edit' }).class).toBe(
      'video-edit',
    );
  });
});

describe('classify — result shape', () => {
  it('returns confidence in [0,1] and signals for every corpus prompt', () => {
    for (const [prompt] of CORPUS) {
      const r = classify({ prompt });
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(r.signals.length).toBeGreaterThan(0);
    }
  });

  it('flags a genuinely ambiguous prompt (two close categories)', () => {
    // advanced-video (footage+video=3) vs motion-graphics (motion graphics=2): within 1.
    const r = classify({ prompt: 'edit this video footage into an animated motion graphics reel' });
    expect(r.class).toBe('advanced-video');
    expect(r.ambiguous).toBe(true);
  });
});

const AMBIGUOUS_PROMPT = 'edit this video footage into an animated motion graphics reel';

describe('classifyWithEscalation — tier-2 seam', () => {
  it('returns tier-1 when no async classifier is injected', async () => {
    const r = await classifyWithEscalation({ prompt: 'What is 2 + 2?' });
    expect(r.class).toBe('simple-QA');
  });

  it('escalates only when tier-1 is ambiguous, and the tier-2 answer wins', async () => {
    const async = vi.fn(
      async (): Promise<ClassifyResult> => ({
        class: 'motion-graphics',
        confidence: 0.95,
        signals: ['tier2'],
        ambiguous: false,
      }),
    );
    // Unambiguous prompt → tier 2 not consulted.
    await classifyWithEscalation(
      { prompt: 'Refactor the auth module.' },
      { asyncClassifier: async },
    );
    expect(async).not.toHaveBeenCalled();

    // Ambiguous prompt → tier 2 consulted and its answer replaces tier 1.
    const r = await classifyWithEscalation(
      { prompt: AMBIGUOUS_PROMPT },
      { asyncClassifier: async },
    );
    expect(async).toHaveBeenCalledOnce();
    expect(r.class).toBe('motion-graphics');
  });

  it('falls back to tier-1 when the async classifier throws', async () => {
    const boom = vi.fn(async (): Promise<ClassifyResult> => {
      throw new Error('model offline');
    });
    const r = await classifyWithEscalation({ prompt: AMBIGUOUS_PROMPT }, { asyncClassifier: boom });
    expect(boom).toHaveBeenCalled();
    expect(r.class).toBe('advanced-video');
  });
});
