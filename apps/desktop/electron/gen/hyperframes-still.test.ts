import { describe, expect, it, vi } from 'vitest';
import {
  buildSceneDocument,
  createStillRenderer,
  DEFAULT_FPS,
  frameFileName,
  frameTimes,
  looksLikeScene,
  MAX_FRAMES,
  type StillWindow,
  seekScript,
} from './hyperframes-still.js';

describe('frameTimes', () => {
  it('is inclusive of both ends', () => {
    // A 1s clip at 2fps settles at t=1.0; dropping it loses the frame most worth
    // checking, so three frames is right, not two.
    expect(frameTimes(1, 2)).toEqual([0, 0.5, 1]);
  });

  it('falls back on nonsense input rather than emitting NaN', () => {
    expect(frameTimes(Number.NaN, 2)).toEqual(frameTimes(3, 2));
    expect(frameTimes(1, 0)).toEqual(frameTimes(1, DEFAULT_FPS));
    expect(frameTimes(-4, 2)).toEqual(frameTimes(3, 2));
  });

  it('caps a mistyped duration', () => {
    expect(frameTimes(10_000, 60)).toHaveLength(MAX_FRAMES);
  });

  it('never emits floating-point dust', () => {
    for (const t of frameTimes(2, 3)) expect(String(t)).not.toMatch(/\d{10}/);
  });
});

describe('frameFileName', () => {
  it('pads so frames sort correctly', () => {
    expect(frameFileName(7, 200)).toBe('frame_007.png');
    expect(frameFileName(7, 2000)).toBe('frame_0007.png');
  });

  it('sorts lexically in render order', () => {
    const names = Array.from({ length: 12 }, (_, i) => frameFileName(i, 12));
    expect([...names].sort()).toEqual(names);
  });
});

describe('looksLikeScene', () => {
  it('recognises an authored scene', () => {
    expect(looksLikeScene('<div class="a">hi</div>')).toBe(true);
    expect(looksLikeScene('<svg viewBox="0 0 10 10"></svg>')).toBe(true);
  });

  it('treats plain English as a prompt', () => {
    expect(looksLikeScene('a logo that resolves from three bars')).toBe(false);
  });
});

describe('buildSceneDocument', () => {
  const opts = { width: 800, height: 600, seconds: 2, fps: 10 };

  it('uses an authored scene as-is', () => {
    const doc = buildSceneDocument('<div id="stage">x</div>', opts);
    expect(doc).toContain('<div id="stage">x</div>');
    // The card RULE always ships in the stylesheet; what must not appear is the
    // card markup, which would mean the authored scene had been replaced.
    expect(doc).not.toContain('<div class="hf-card">');
  });

  it('turns a text prompt into a legible card, not a blank frame', () => {
    const doc = buildSceneDocument('Rising bars', opts);
    expect(doc).toContain('hf-card');
    expect(doc).toContain('Rising bars');
  });

  it('escapes a text prompt so it cannot inject markup', () => {
    const doc = buildSceneDocument('a <script>alert(1)</script> title', opts);
    expect(doc).not.toContain('<script>alert(1)</script>');
    expect(doc).toContain('&lt;script&gt;');
  });

  it('sizes the stage to the requested frame', () => {
    expect(buildSceneDocument('x', opts)).toContain('width: 800px; height: 600px');
  });
});

describe('seekScript', () => {
  it('pins animations to the requested instant, in ms', () => {
    const s = seekScript(1.5);
    expect(s).toContain('a.pause()');
    expect(s).toContain('a.currentTime = t * 1000');
    expect(s).toContain('const t = 1.5');
  });

  it('drives a scene that animates itself', () => {
    expect(seekScript(0)).toContain('window.hyperframesSeek');
  });

  it('forces layout so the capture cannot race the seek', () => {
    expect(seekScript(0)).toContain('document.body.offsetHeight');
  });
});

describe('createStillRenderer', () => {
  const makeWin = () => {
    const win: StillWindow & {
      seeks: string[];
      disposed: boolean;
    } = {
      seeks: [],
      disposed: false,
      load: vi.fn(async () => {}),
      evaluate: vi.fn(async (s: string) => {
        win.seeks.push(s);
        return 1;
      }),
      // Distinct bytes per capture by default — a real animation. Tests that
      // need a STATIC render override this.
      capture: vi.fn(async () => Buffer.from(`PNG-${win.seeks.length}`)),
      dispose: vi.fn(async () => {
        win.disposed = true;
      }),
    };
    return win;
  };

  const spec = {
    prompt: '<div>scene</div>',
    modelId: 'hyperframes',
    width: 640,
    height: 360,
    seconds: 1,
    fps: 2,
    seeds: [42],
  };

  it('renders one still per frame instant', async () => {
    const win = makeWin();
    const written: string[] = [];
    const render = createStillRenderer({
      openWindow: async () => win,
      writeFile: async (p) => {
        written.push(p);
      },
    });
    const out = await render(spec, '/out', () => {});
    expect(out).toHaveLength(3);
    expect(written).toEqual(['/out/frame_000.png', '/out/frame_001.png', '/out/frame_002.png']);
    expect(out[0]).toMatchObject({ modality: 'image', model: 'hyperframes', seed: 42 });
    expect(out[0]?.width).toBe(640);
  });

  it('seeks a different instant for every frame', async () => {
    const win = makeWin();
    const render = createStillRenderer({ openWindow: async () => win, writeFile: async () => {} });
    await render(spec, '/out', () => {});
    expect(win.seeks).toHaveLength(3);
    expect(win.seeks[0]).toContain('const t = 0');
    expect(win.seeks[1]).toContain('const t = 0.5');
    expect(win.seeks[2]).toContain('const t = 1');
  });

  it('reports progress per frame', async () => {
    const steps: Array<[number, number]> = [];
    const render = createStillRenderer({
      openWindow: async () => makeWin(),
      writeFile: async () => {},
    });
    await render(spec, '/out', (e) => {
      if (e.event === 'progress') steps.push([e.step, e.total]);
    });
    expect(steps).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  /* jedd: "ensure we can see hyperframes stuff being generated and iterating in
   * the canvas." The canvas renders `previewPath` off a progress event, so
   * without it a render is a spinner that resolves all at once at the end. */
  it('previews each frame as it lands, so the canvas fills in live', async () => {
    const previews: string[] = [];
    const render = createStillRenderer({
      openWindow: async () => makeWin(),
      writeFile: async () => {},
    });
    await render(spec, '/out', (e) => {
      if (e.event === 'progress' && e.previewPath !== undefined) previews.push(e.previewPath);
    });
    expect(previews).toEqual(['/out/frame_000.png', '/out/frame_001.png', '/out/frame_002.png']);
  });

  /* An offscreen window that outlives the job keeps a renderer process alive for
   * the life of the app, so it must go back even when the render throws. */
  it('disposes the window even when a capture fails', async () => {
    const win = makeWin();
    win.capture = vi.fn(async () => {
      throw new Error('capture blew up');
    });
    const render = createStillRenderer({ openWindow: async () => win, writeFile: async () => {} });
    await expect(render(spec, '/out', () => {})).rejects.toThrow('capture blew up');
    expect(win.disposed).toBe(true);
  });

  it('stops between frames when aborted', async () => {
    const win = makeWin();
    const ac = new AbortController();
    let n = 0;
    const render = createStillRenderer({
      openWindow: async () => win,
      writeFile: async () => {
        if (++n === 1) ac.abort();
      },
    });
    const out = await render(spec, '/out', () => {}, ac.signal);
    expect(out).toHaveLength(1);
    expect(win.disposed).toBe(true);
  });

  it('fails loudly rather than reporting an empty success', async () => {
    const ac = new AbortController();
    ac.abort();
    const render = createStillRenderer({
      openWindow: async () => makeWin(),
      writeFile: async () => {},
    });
    await expect(render(spec, '/out', () => {}, ac.signal)).rejects.toThrow('no frames');
  });
});

/*
 * A RENDER THAT DID NOT MOVE IS NOT A SUCCESS.
 *
 * Measured live: a real motion request produced 61 frames, ONE distinct, and the
 * job reported success — a directory of duplicates that looks like a finished
 * animation. The seek script already reported how many animations it pinned and
 * that number was being discarded.
 */
describe('a static render is reported, not passed off', () => {
  const spec = {
    prompt: '<div>scene</div>',
    modelId: 'hyperframes',
    width: 640,
    height: 360,
    seconds: 1,
    fps: 2,
    seeds: [42],
  };

  const staticWin = (animations: number) => {
    const win: StillWindow & { seeks: string[]; disposed: boolean } = {
      seeks: [],
      disposed: false,
      load: vi.fn(async () => {}),
      evaluate: vi.fn(async (s: string) => {
        win.seeks.push(s);
        return animations;
      }),
      capture: vi.fn(async () => Buffer.from('IDENTICAL')),
      dispose: vi.fn(async () => {
        win.disposed = true;
      }),
    };
    return win;
  };

  it('fails when every frame is byte-identical', async () => {
    const render = createStillRenderer({
      openWindow: async () => staticWin(3),
      writeFile: async () => {},
    });
    await expect(render(spec, '/out', () => {})).rejects.toThrow(/IDENTICAL frames/);
  });

  it('names the cause when nothing seekable was found', async () => {
    const render = createStillRenderer({
      openWindow: async () => staticWin(0),
      writeFile: async () => {},
    });
    await expect(render(spec, '/out', () => {})).rejects.toThrow(
      /No CSS\/Web animations were found to seek/,
    );
  });

  it('tells the author what CAN be seeked', async () => {
    const render = createStillRenderer({
      openWindow: async () => staticWin(0),
      writeFile: async () => {},
    });
    await expect(render(spec, '/out', () => {})).rejects.toThrow(/hyperframesSeek/);
  });

  it('still passes a genuinely animated render', async () => {
    const out = await createStillRenderer({
      openWindow: async () => {
        const w = staticWin(2);
        let n = 0;
        w.capture = vi.fn(async () => Buffer.from(`frame-${n++}`));
        return w;
      },
      writeFile: async () => {},
    })(spec, '/out', () => {});
    expect(out).toHaveLength(3);
  });
});
