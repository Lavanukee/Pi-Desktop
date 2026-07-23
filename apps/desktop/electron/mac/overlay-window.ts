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
  overlayShouldShow,
  rectsDiffer,
  toLocalPoint,
  typingPreview,
} from './overlay-geometry';

const log = createLogger('desktop:mac-overlay');

/** How long the phantom cursor takes to glide to an action point (matches the
 * CSS travel transition in overlay.html). */
export const CURSOR_TRAVEL_MS = 300;
/** Window-tracking poll cadence while the overlay is VISIBLE — tight enough
 * that the overlay rides a window drag live instead of snapping on release.
 * The tracker self-reschedules AFTER each bounds read resolves, so at most one
 * read is ever outstanding on the (single-threaded) helper pipe — a real tool
 * act waits behind at most one cheap bounds read, never a backlog. */
const FAST_TRACK_MS = 16;
/** Slower cadence while the overlay is hidden-but-still-tracking (app
 * backgrounded / model idle): we only need to notice a refocus, not animate. */
const SLOW_TRACK_MS = 250;
/** Bounds have read null (window minimized/closed/quit) continuously for this
 * long → tear the overlay all the way down rather than track a ghost. A brief
 * miss (space-switch animation, AX hiccup) just hides it visually and recovers. */
const MISSING_GRACE_MS = 1500;
/** The model counts as actively DRIVING for this long after its last action —
 * the overlay stays visible through it even while the app is backgrounded, so
 * the user can watch Pi work; once it lapses (and the app isn't frontmost) the
 * overlay tucks away. */
const DRIVING_WINDOW_MS = 4_000;
/** How long a transient bubble (key press / scroll) lingers before returning
 * to the resting 'thinking' state. */
const TRANSIENT_STATUS_MS = 1200;
/** With NO tool activity for this long the bubble fades out (the cursor stays
 * — always visible while an app is controlled). "Thinking…" must reflect a
 * turn actually in flight, not linger forever after the model finished. */
const BUBBLE_IDLE_MS = 15_000;

/** A live window-frame read, plus the visibility-rule inputs that ride along
 * with it (see overlayShouldShow): whether the controlled app is frontmost,
 * whether its window is on the CURRENT space, and whether it is meaningfully
 * OCCLUDED by other apps' windows above it in z (helper CGWindowList truth;
 * absent on older helpers). */
export type BoundsSample = OverlayRect & {
  readonly frontmost?: boolean;
  readonly onScreen?: boolean;
  readonly occluded?: boolean | null;
};

/** Injected read of the controlled window's live frame (null = no window). */
export type BoundsReader = (pid: number) => Promise<BoundsSample | null>;

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
  #trackTimer: ReturnType<typeof setTimeout> | null = null;
  #missingSince: number | null = null;
  #lastCursor: { x: number; y: number } | null = null;
  #lastActivityAt: number | null = null;
  #lastOccluded: boolean | null = null;
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
    // Float ABOVE normal app windows, but NOT at screen-saver level — the
    // overlay must not sit over system UI / the user's other apps as if it
    // owned the screen. macOS window levels are global bands (not per-app), so
    // this can't be truly z-sandwiched between the controlled app and the rest;
    // the app-scoping is done by the show/hide visibility rule in #trackTick
    // (overlayShouldShow), and 'floating' keeps the level as low as still lets
    // the phantom read over the controlled window while the model is driving.
    win.setAlwaysOnTop(true, 'floating');
    // Ride along to whatever space the controlled window is on (incl. a
    // fullscreen app); the visibility rule keeps it from intruding elsewhere.
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
    this.#target = { pid, rect: { x: known.x, y: known.y, w: known.w, h: known.h } };
    this.#missingSince = null;
    this.#markActivity(); // control() means the model just acted → show
    win.setBounds(overlayBoundsFor(this.#target.rect));
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

  /** E2E seam: simulate ONE tracker reposition to `rect` synchronously (same
   * code path a live bounds change takes) so a probe can assert the overlay
   * follows the controlled window in the SAME tick — no snap-on-release lag. */
  async debugRetarget(rect: OverlayRect): Promise<void> {
    if (this.#target === null) return;
    await this.#reposition(rect);
  }

  async #readBounds(pid: number): Promise<BoundsSample | null> {
    const reader = this.#boundsReader;
    if (reader === null) return null;
    try {
      return await reader(pid);
    } catch {
      return null;
    }
  }

  /** True while the model is actively driving (recent action) — see
   * DRIVING_WINDOW_MS. */
  #isDriving(): boolean {
    return this.#lastActivityAt !== null && Date.now() - this.#lastActivityAt < DRIVING_WINDOW_MS;
  }

  #markActivity(): void {
    this.#lastActivityAt = Date.now();
    // If we're tracking but currently tucked away, re-evaluate visibility right
    // now so the overlay reappears the instant the model resumes — don't wait
    // out the slow hidden-cadence poll.
    const win = this.#win;
    if (this.#trackTimer !== null && win !== null && !win.isDestroyed() && !win.isVisible()) {
      this.#scheduleTrack(0);
    }
  }

  /** Move/resize the overlay window to follow the target rect. A pure MOVE just
   * repositions the window — the phantom cursor rides along at its fixed local
   * coordinate (it stays glued to the on-screen target, no spring re-fires). A
   * RESIZE that would push the cursor outside the padded window re-clamps it via
   * a 'reset'; otherwise no executeJavaScript round-trip runs, so tracking stays
   * lag-free at the fast cadence. */
  async #reposition(fresh: OverlayRect): Promise<void> {
    const target = this.#target;
    const win = this.#win;
    if (target === null || win === null || win.isDestroyed()) return;
    const resized =
      Math.abs(target.rect.w - fresh.w) >= 1 || Math.abs(target.rect.h - fresh.h) >= 1;
    target.rect = { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h };
    // Instant follow: no animate, no moveTop/focus — just the new frame.
    win.setBounds(overlayBoundsFor(target.rect));
    if (resized && this.#cursorOutsidePadded(target.rect)) await this.#push({ kind: 'reset' });
  }

  /** Would the last-placed cursor now fall outside the padded window (so the
   * DOM must re-clamp it)? Unknown cursor → assume yes, to be safe. */
  #cursorOutsidePadded(rect: OverlayRect): boolean {
    const c = this.#lastCursor;
    if (c === null) return false;
    const b = overlayBoundsFor(rect);
    return c.x < 4 || c.y < 4 || c.x > b.width - 4 || c.y > b.height - 4;
  }

  #applyVisibility(show: boolean): void {
    const win = this.#win;
    if (win === null || win.isDestroyed()) return;
    if (show) {
      if (!win.isVisible()) win.showInactive();
    } else if (win.isVisible()) {
      win.hide();
    }
  }

  #startTracking(): void {
    if (this.#trackTimer !== null) return;
    this.#scheduleTrack(0);
  }

  #scheduleTrack(delay: number): void {
    if (this.#trackTimer !== null) clearTimeout(this.#trackTimer);
    this.#trackTimer = setTimeout(() => {
      void this.#trackTick();
    }, delay);
    this.#trackTimer.unref?.();
  }

  #stopTracking(): void {
    if (this.#trackTimer !== null) {
      clearTimeout(this.#trackTimer);
      this.#trackTimer = null;
    }
  }

  /** One self-rescheduling tracking tick: read the live frame, follow moves,
   * and apply the app-scoped visibility rule. Re-schedules itself AFTER the
   * async read resolves (never on a fixed interval), so reads can't pile up on
   * the helper pipe. */
  async #trackTick(): Promise<void> {
    const target = this.#target;
    const win = this.#win;
    if (target === null || target.pid === null || win === null || win.isDestroyed()) {
      this.#trackTimer = null;
      return;
    }
    const sample = await this.#readBounds(target.pid);
    // Bail if control was dropped / re-targeted while the read was in flight.
    if (this.#target !== target || this.#win !== win || win.isDestroyed()) return;

    let visible = false;
    if (sample === null) {
      // Window not currently readable (minimized / space animation / quit).
      if (this.#missingSince === null) this.#missingSince = Date.now();
      this.#applyVisibility(false);
      if (Date.now() - this.#missingSince >= MISSING_GRACE_MS) {
        this.hide();
        return;
      }
    } else {
      this.#missingSince = null;
      if (rectsDiffer(target.rect, sample)) await this.#reposition(sample);
      this.#lastOccluded = typeof sample.occluded === 'boolean' ? sample.occluded : null;
      visible = overlayShouldShow({
        controlledFrontmost: sample.frontmost === true,
        // onScreen === false means the helper SAW the window off the current
        // space (or minimized) even though AX still reports a frame — the
        // phantom must not haunt the space the user switched to.
        appVisible: sample.onScreen !== false,
        driving: this.#isDriving(),
        occluded: this.#lastOccluded,
      });
      this.#applyVisibility(visible);
    }
    this.#scheduleTrack(visible ? FAST_TRACK_MS : SLOW_TRACK_MS);
  }

  // ── action-driven states (called by mac-agent dispatch) ────────────────

  #local(screenX: number, screenY: number): { x: number; y: number } | null {
    const target = this.#target;
    if (target === null) return null;
    const p = toLocalPoint(screenX, screenY, target.rect);
    this.#lastCursor = p; // remembered so a resize knows whether to re-clamp
    return p;
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
   * silence the bubble hides (the cursor rests in place, still visible). Also
   * marks the model as actively driving, which keeps the overlay visible (see
   * overlayShouldShow) even while the controlled app is backgrounded. */
  #armIdle(): void {
    this.#markActivity();
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
  info(): {
    visible: boolean;
    bounds: OverlayRect | null;
    trackingPid: number | null;
    occluded: boolean | null;
  } {
    const win = this.#win;
    const visible = win !== null && !win.isDestroyed() && win.isVisible();
    return {
      visible,
      bounds: this.#target?.rect ?? null,
      trackingPid: this.#target?.pid ?? null,
      occluded: this.#lastOccluded,
    };
  }

  hide(): void {
    this.#clearRevert();
    this.#clearIdle();
    this.#stopTracking();
    this.#target = null;
    this.#missingSince = null;
    this.#lastCursor = null;
    this.#lastActivityAt = null;
    this.#lastOccluded = null;
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
