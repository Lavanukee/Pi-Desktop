/**
 * The Mac computer-use CURSOR OVERLAY window — the only thing the user
 * perceives while Pi drives an app in the background.
 *
 * A transparent, frameless, click-through, always-on-top ("screen-saver"
 * level, all workspaces) BrowserWindow positioned EXACTLY over the controlled
 * app's window and tracking its moves/resizes by polling the pi-mac helper's
 * `bounds` method (injected — this module never talks to the helper directly).
 * Inside it, a static overlay.html (plain JS/CSS, loadFile — zero vite
 * coupling) renders the phantom gradient cursor + status bubble; main pushes
 * state via executeJavaScript → window.__pdOverlay(msg), so the page needs no
 * preload and no nodeIntegration.
 *
 * Never steals focus: the window is non-focusable and shown with
 * showInactive(); setIgnoreMouseEvents(true, {forward:true}) forwards every
 * mouse event through to whatever is really underneath.
 *
 * Driven by REAL tool events from mac-agent.ts (launch/snapshot/click/type/…)
 * so the bubble always reflects what is actually happening.
 */
import path from 'node:path';
import { createLogger } from '@pi-desktop/shared';
import { app, BrowserWindow } from 'electron';
import {
  comboLabel,
  type OverlayRect,
  overlayBoundsFor,
  rectsDiffer,
  toLocalPoint,
  typingPreview,
} from './overlay-geometry';

const log = createLogger('desktop:mac-overlay');

/** How long the phantom cursor takes to glide to an action point (matches the
 * CSS travel transition in overlay.html). */
export const CURSOR_TRAVEL_MS = 300;
/** Window-tracking poll cadence while the overlay is visible. */
const TRACK_INTERVAL_MS = 500;
/** Consecutive failed bounds reads before we conclude the app/window is gone. */
const TRACK_FAILURE_LIMIT = 4;
/** How long a transient bubble (key press / scroll) lingers before returning
 * to the resting 'thinking' state. */
const TRANSIENT_STATUS_MS = 1200;
/** With NO tool activity for this long the bubble fades out (the cursor stays
 * — always visible while an app is controlled). "Thinking…" must reflect a
 * turn actually in flight, not linger forever after the model finished. */
const BUBBLE_IDLE_MS = 15_000;

/** Injected read of the controlled window's live frame (null = no window). */
export type BoundsReader = (pid: number) => Promise<OverlayRect | null>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/** Static overlay page, resolved relative to the app root (dev: the source
 * tree; packaged: inside app.asar — see the electron-builder note in the
 * repo docs; loadFile reads from the asar transparently). */
function overlayHtmlPath(): string {
  return path.join(app.getAppPath(), 'electron', 'mac', 'overlay.html');
}

class MacOverlayController {
  #win: BrowserWindow | null = null;
  #loaded: Promise<void> | null = null;
  #boundsReader: BoundsReader | null = null;
  #target: { pid: number | null; rect: OverlayRect } | null = null;
  #tracker: ReturnType<typeof setInterval> | null = null;
  #trackFailures = 0;
  #revertTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** mac-agent injects the helper-backed bounds reader once at registration. */
  setBoundsReader(reader: BoundsReader): void {
    this.#boundsReader = reader;
  }

  // ── window lifecycle ───────────────────────────────────────────────────

  #ensureWindow(): BrowserWindow {
    if (this.#win !== null && !this.#win.isDestroyed()) return this.#win;
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The tracker + animations must run while the overlay never has focus.
        backgroundThrottling: false,
      },
    });
    // Float above EVERYTHING (incl. fullscreen spaces), on every workspace —
    // the user must see the phantom cursor wherever the controlled window is.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Click-through: the overlay must never eat a real mouse event.
    win.setIgnoreMouseEvents(true, { forward: true });
    this.#loaded = win.loadFile(overlayHtmlPath()).catch((err) => {
      log.error('overlay.html failed to load', { error: String(err) });
    });
    win.on('closed', () => {
      if (this.#win === win) {
        this.#win = null;
        this.#stopTracking();
      }
    });
    this.#win = win;
    return win;
  }

  async #push(msg: Record<string, unknown>): Promise<void> {
    const win = this.#win;
    if (win === null || win.isDestroyed()) return;
    await this.#loaded;
    if (win.isDestroyed()) return;
    try {
      await win.webContents.executeJavaScript(
        `window.__pdOverlay && window.__pdOverlay(${JSON.stringify(msg)})`,
        true,
      );
    } catch {
      /* the overlay is cosmetic — a push must never break a tool call */
    }
  }

  // ── control / tracking ─────────────────────────────────────────────────

  /** Show the overlay over `rect` and track `pid`'s window (moves/resizes).
   * Idempotent per pid; a new pid re-targets the overlay. */
  async control(pid: number, rect: OverlayRect | null | undefined): Promise<void> {
    if (process.platform !== 'darwin') return;
    const known = rect ?? (await this.#readBounds(pid));
    if (known === null) return; // no window yet — a later snapshot will retry
    const win = this.#ensureWindow();
    this.#target = { pid, rect: known };
    this.#trackFailures = 0;
    win.setBounds(overlayBoundsFor(known));
    if (!win.isVisible()) win.showInactive();
    await this.#push({ kind: 'reset' });
    this.#startTracking();
  }

  /** E2E seam: show the overlay over an arbitrary rect with NO pid tracking
   * (mac-overlay-probe.mjs drives states deterministically). */
  async debugShow(rect: OverlayRect): Promise<void> {
    const win = this.#ensureWindow();
    this.#target = { pid: null, rect };
    win.setBounds(overlayBoundsFor(rect));
    if (!win.isVisible()) win.showInactive();
    await this.#push({ kind: 'reset' });
  }

  async #readBounds(pid: number): Promise<OverlayRect | null> {
    const reader = this.#boundsReader;
    if (reader === null) return null;
    try {
      return await reader(pid);
    } catch {
      return null;
    }
  }

  #startTracking(): void {
    if (this.#tracker !== null) return;
    this.#tracker = setInterval(() => {
      void this.#trackOnce();
    }, TRACK_INTERVAL_MS);
    this.#tracker.unref?.();
  }

  #stopTracking(): void {
    if (this.#tracker !== null) {
      clearInterval(this.#tracker);
      this.#tracker = null;
    }
  }

  async #trackOnce(): Promise<void> {
    const target = this.#target;
    const win = this.#win;
    if (target === null || target.pid === null || win === null || win.isDestroyed()) return;
    const fresh = await this.#readBounds(target.pid);
    if (fresh === null) {
      // App quit / window closed: give it a few beats (spaces animations,
      // transient AX hiccups), then hide rather than float over nothing.
      this.#trackFailures += 1;
      if (this.#trackFailures >= TRACK_FAILURE_LIMIT) this.hide();
      return;
    }
    this.#trackFailures = 0;
    if (rectsDiffer(target.rect, fresh)) {
      target.rect = fresh;
      win.setBounds(overlayBoundsFor(fresh));
      await this.#push({ kind: 'reset' });
    }
  }

  // ── action-driven states (called by mac-agent dispatch) ────────────────

  #local(screenX: number, screenY: number): { x: number; y: number } | null {
    const target = this.#target;
    if (target === null) return null;
    return toLocalPoint(screenX, screenY, target.rect);
  }

  /** Glide the cursor to a screen point and wait out the travel. */
  async moveCursor(screenX: number, screenY: number): Promise<void> {
    const p = this.#local(screenX, screenY);
    if (p === null) return;
    this.#armIdle();
    await this.#push({ kind: 'cursor', x: p.x, y: p.y, ms: CURSOR_TRAVEL_MS });
    await sleep(CURSOR_TRAVEL_MS);
  }

  /** Click feedback at a screen point: press dip + expanding ripples. */
  async clickAt(screenX: number, screenY: number): Promise<void> {
    const p = this.#local(screenX, screenY);
    if (p === null) return;
    this.#armIdle();
    await this.#push({ kind: 'click', x: p.x, y: p.y });
    this.#revertSoon();
  }

  /** Live-typing bubble (optionally previewing the text) at the cursor. */
  async typing(text: string): Promise<void> {
    this.#armIdle();
    await this.#push({ kind: 'status', status: 'typing', text: typingPreview(text) });
  }

  async keyPress(combo: string): Promise<void> {
    this.#armIdle();
    await this.#push({ kind: 'status', status: 'pressing', text: comboLabel(combo) });
    this.#revertSoon();
  }

  async scrolling(): Promise<void> {
    this.#armIdle();
    await this.#push({ kind: 'status', status: 'scrolling' });
    this.#revertSoon();
  }

  async opening(appName: string): Promise<void> {
    this.#armIdle();
    await this.#push({ kind: 'status', status: 'opening', text: `Opening ${appName}` });
  }

  /** The resting state between actions: the model is deciding what to do. */
  async thinking(): Promise<void> {
    this.#clearRevert();
    this.#armIdle();
    await this.#push({ kind: 'status', status: 'thinking' });
  }

  #revertSoon(): void {
    this.#clearRevert();
    this.#revertTimer = setTimeout(() => {
      void this.#push({ kind: 'status', status: 'thinking' });
    }, TRANSIENT_STATUS_MS);
    this.#revertTimer.unref?.();
  }

  #clearRevert(): void {
    if (this.#revertTimer !== null) {
      clearTimeout(this.#revertTimer);
      this.#revertTimer = null;
    }
  }

  /** Every real activity push re-arms the idle fade: after BUBBLE_IDLE_MS of
   * silence the bubble hides (the cursor rests in place, still visible). */
  #armIdle(): void {
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      void this.#push({ kind: 'hide-bubble' });
    }, BUBBLE_IDLE_MS);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  /** Info for probes/assertions. */
  info(): { visible: boolean; bounds: OverlayRect | null; trackingPid: number | null } {
    const win = this.#win;
    const visible = win !== null && !win.isDestroyed() && win.isVisible();
    return {
      visible,
      bounds: this.#target?.rect ?? null,
      trackingPid: this.#target?.pid ?? null,
    };
  }

  hide(): void {
    this.#clearRevert();
    this.#clearIdle();
    this.#stopTracking();
    this.#target = null;
    const win = this.#win;
    if (win !== null && !win.isDestroyed() && win.isVisible()) win.hide();
  }

  dispose(): void {
    this.hide();
    const win = this.#win;
    this.#win = null;
    if (win !== null && !win.isDestroyed()) win.destroy();
  }
}

/** The app-wide overlay singleton (one controlled app at a time — matches the
 * single long-lived pi-mac helper). */
export const macOverlay = new MacOverlayController();
