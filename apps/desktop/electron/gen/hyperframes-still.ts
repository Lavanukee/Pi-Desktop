/**
 * HYPERFRAMES — the still-frame motion-graphics renderer.
 *
 * jedd: "you can ignore video generation (not motion graphics, hyperframes has
 * to be in still renderer and all)."
 *
 * WHAT WAS HERE BEFORE. `hyperFramesRenderUnavailable` in ./video-dispatch.ts —
 * a stub that emits an error saying the toolchain "needs ffmpeg + headless
 * Chrome", and throws. Nothing ever replaced it, so the motion specialist's
 * charter described driving a renderer that did not exist, and every motion
 * commission ended in that message.
 *
 * BOTH DEPENDENCIES WERE ALWAYS WRONG. Headless Chrome is not missing — this is
 * Electron, Chromium is the process we are running inside, and an offscreen
 * BrowserWindow renders and captures without installing anything. And ffmpeg is
 * only needed to ENCODE, which is exactly the part jedd cut. Rendering frames as
 * stills removes the whole dependency story: no aux downloads, no codecs, no
 * network, and output a vision model can actually look at.
 *
 * DETERMINISM IS THE POINT, and real time is its enemy. A scene animated by
 * `requestAnimationFrame` renders whatever the machine's load allowed, so two
 * runs differ and neither is reproducible. Instead every frame is rendered by
 * SEEKING a virtual clock: all Web Animations are paused and their `currentTime`
 * set explicitly, and a scene may expose `window.hyperframesSeek(t)` for anything
 * it drives itself. Same scene in, same pixels out, every time — which is what
 * lets a seed mean something for a renderer with no model weights.
 *
 * The pure parts (frame timing, filenames, document assembly, the seek script)
 * are exported and unit-tested; the Electron window is injected so none of that
 * needs a display.
 */

import path from 'node:path';
import type { GenOutput } from '@pi-desktop/gen-service';
import type { HyperFramesRender } from './video-dispatch.js';

/** A scene the renderer can drive, and the window it draws into. */
export interface StillSceneOptions {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly fps: number;
}

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;
export const DEFAULT_FPS = 12;
export const DEFAULT_SECONDS = 3;
/** A ceiling so a mistyped duration cannot ask for ten thousand captures. */
export const MAX_FRAMES = 300;

/**
 * The instants to capture, in seconds.
 *
 * Inclusive of t=0 and of the final frame: a 1s clip at 2fps is [0, 0.5, 1.0],
 * three frames, not two. A motion-graphics still set is usually read as
 * start/middle/end, and dropping the last frame loses the thing the scene
 * settles to — which is the frame most worth checking.
 */
export function frameTimes(seconds: number, fps: number): number[] {
  const secs = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SECONDS;
  const rate = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  const count = Math.min(MAX_FRAMES, Math.max(1, Math.round(secs * rate) + 1));
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Number((i / rate).toFixed(6)));
  return out;
}

/** Zero-padded so the frames sort correctly in any file browser. */
export function frameFileName(index: number, total: number): string {
  const width = Math.max(3, String(Math.max(0, total - 1)).length);
  return `frame_${String(index).padStart(width, '0')}.png`;
}

/** Does this look like a scene the model authored, rather than a text prompt? */
export function looksLikeScene(prompt: string): boolean {
  return /<\s*(html|body|div|svg|canvas|style|section|main|h1)\b/i.test(prompt);
}

/**
 * Wrap whatever we were given into a full document at the right size.
 *
 * A prompt that is already a scene is used as-is inside a sized stage. A plain
 * text prompt is NOT silently turned into art — it becomes a legible title card
 * that says what it was asked to draw, which is honest output rather than a
 * blank frame the caller might mistake for a render.
 */
export function buildSceneDocument(prompt: string, opts: StillSceneOptions): string {
  const body = looksLikeScene(prompt)
    ? prompt
    : `<div class="hf-card"><h1>${escapeHtml(prompt.trim() || 'Untitled scene')}</h1></div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: ${opts.width}px; height: ${opts.height}px;
    overflow: hidden; background: #0b0b0f; color: #f5f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .hf-card { width: 100%; height: 100%; display: flex; align-items: center;
    justify-content: center; text-align: center; padding: 8%; }
  .hf-card h1 { font-size: clamp(28px, 6vw, 88px); font-weight: 650; letter-spacing: -0.02em;
    line-height: 1.08; margin: 0; }
</style></head><body>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The script evaluated in the page before each capture.
 *
 * Pauses every animation and pins it to `t`, so the frame is a function of the
 * time we asked for and nothing else. A scene that animates itself can expose
 * `window.hyperframesSeek(t)` and will be driven through that too. Returns the
 * number of animations it found, which is how the caller can tell a genuinely
 * static scene from one whose animations never started.
 */
export function seekScript(t: number): string {
  return `(() => {
    const t = ${t};
    let n = 0;
    try {
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; n++; }
    } catch {}
    try { if (typeof window.hyperframesSeek === 'function') { window.hyperframesSeek(t); } } catch {}
    // Force style + layout so the capture cannot race the seek we just did.
    void document.body.offsetHeight;
    return n;
  })()`;
}

/** The Electron surface this needs — injected so the logic tests without a display. */
export interface StillWindow {
  /** Load a full HTML document and resolve once it has settled. */
  load(html: string, width: number, height: number): Promise<void>;
  /** Run a script in the page. */
  evaluate(script: string): Promise<unknown>;
  /** Capture the current frame as PNG bytes. */
  capture(): Promise<Buffer>;
  /** Tear the window down. */
  dispose(): Promise<void>;
}

export interface StillRendererDeps {
  readonly openWindow: (width: number, height: number) => Promise<StillWindow>;
  readonly writeFile: (filePath: string, data: Buffer) => Promise<void>;
}

/**
 * Build the renderer that replaces {@link hyperFramesRenderUnavailable}.
 *
 * Emits progress per frame, honours an abort between frames (a capture itself is
 * short, so mid-capture cancellation would buy nothing and risks a half-written
 * file), and returns one {@link GenOutput} per frame — modality `image`, because
 * that is genuinely what these are.
 */
export function createStillRenderer(deps: StillRendererDeps): HyperFramesRender {
  return async (spec, outputDir, onEvent, signal) => {
    const width = spec.width ?? DEFAULT_WIDTH;
    const height = spec.height ?? DEFAULT_HEIGHT;
    const times = frameTimes(spec.seconds ?? DEFAULT_SECONDS, spec.fps ?? DEFAULT_FPS);
    const seed = spec.seeds[0];
    const html = buildSceneDocument(spec.prompt, {
      width,
      height,
      seconds: spec.seconds ?? DEFAULT_SECONDS,
      fps: spec.fps ?? DEFAULT_FPS,
    });

    const win = await deps.openWindow(width, height);
    const outputs: GenOutput[] = [];
    try {
      await win.load(html, width, height);
      for (let i = 0; i < times.length; i++) {
        if (signal?.aborted === true) break;
        const t = times[i] ?? 0;
        await win.evaluate(seekScript(t));
        const png = await win.capture();
        const file = path.join(outputDir, frameFileName(i, times.length));
        await deps.writeFile(file, png);
        outputs.push({
          outputPath: file,
          modality: 'image',
          model: spec.modelId,
          width,
          height,
          ...(seed !== undefined ? { seed } : {}),
        });
        /*
         * SHOW THE FRAME AS IT LANDS. jedd: "ensure we can see hyperframes stuff
         * being generated and iterating in the canvas."
         *
         * The canvas renders `previewPath` off a progress event (see
         * ./gen-manager.ts `onEvent`), so pointing it at the frame just written
         * makes the render visibly build up rather than sitting on a spinner and
         * arriving all at once. `step`/`total` drive the same progress readout
         * every other backend uses.
         */
        onEvent({
          event: 'progress',
          jobId: spec.modelId,
          candidate: 0,
          step: i + 1,
          total: times.length,
          previewPath: file,
        });
      }
    } finally {
      // A leaked offscreen window keeps a renderer process alive for the life of
      // the app, so this is not optional and not conditional on success.
      await win.dispose().catch(() => {});
    }
    if (outputs.length === 0) {
      throw new Error('hyperframes rendered no frames');
    }
    return outputs;
  };
}
