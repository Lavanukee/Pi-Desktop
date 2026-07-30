/**
 * The Electron half of the HyperFrames still renderer: an offscreen window that
 * loads a scene and hands back PNG frames.
 *
 * Kept apart from ./hyperframes-still.ts on purpose — that module holds the
 * timing, naming and document assembly and is unit-tested in a plain `node`
 * environment with NO electron import (see apps/desktop/vitest.config.ts, which
 * is why video-dispatch.ts is careful about the same thing). This file is the
 * only part that needs a real Chromium, and it is injected.
 *
 * WHY THIS COSTS NOTHING TO SHIP. The old stub refused with "needs ffmpeg +
 * headless Chrome". We are running inside Chromium already, so the browser was
 * never missing; and ffmpeg was only ever for encoding, which is the part jedd
 * cut when he asked for stills. So: no aux downloads, no codecs, no network.
 */

import { BrowserWindow } from 'electron';
import type { StillWindow } from './hyperframes-still.js';

/** How long to wait for a scene's own assets before capturing anyway. */
const LOAD_SETTLE_MS = 150;

/**
 * Open an offscreen window sized to the frame.
 *
 * `offscreen` keeps it off the user's display entirely — a motion render must
 * not steal focus or flash a window in front of whatever they are doing. The
 * deliberate `nodeIntegration: false` + `sandbox: true` matters more than usual
 * here: the scene HTML is authored by a MODEL, so it is untrusted content and is
 * given no way out of the page.
 */
export async function openStillWindow(width: number, height: number): Promise<StillWindow> {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A scene is a still; there is nothing to hear.
      backgroundThrottling: false,
    },
  });
  // Match the drawing surface exactly, so CSS pixels are output pixels and a
  // 1280x720 request is not silently captured at the host's device ratio.
  win.webContents.setZoomFactor(1);

  return {
    async load(html) {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      // Fonts and images resolve after `did-finish-load`; a short settle keeps
      // frame 0 from being the unstyled flash rather than the scene.
      await new Promise((r) => setTimeout(r, LOAD_SETTLE_MS));
    },
    async evaluate(script) {
      return win.webContents.executeJavaScript(script, true);
    },
    async capture() {
      const image = await win.webContents.capturePage();
      return image.toPNG();
    },
    async dispose() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
