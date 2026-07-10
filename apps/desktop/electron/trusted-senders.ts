/**
 * Trusted-sender registry for IPC validation (Electron security checklist:
 * validate the sender of every IPC message). main.ts registers each
 * app-created window's WebContents; every invoke handler refuses events from
 * anything else, so future embedded webContents (W7 canvas, W8 gallery) can
 * never mint themselves a pi bridge or reach app channels.
 *
 * Binding W7 constraint recorded here because sender checks cannot close it:
 * a same-origin child frame's `window.top.piDesktop.invoke(...)` executes in
 * the top frame's preload and arrives as the trusted main frame. Canvas
 * iframes must therefore be sandboxed WITHOUT allow-same-origin, and the app
 * preload must never be attached to webContents hosting untrusted content.
 *
 * Structural slices keep this module electron-free and unit-testable in plain
 * Node (quit-hold.ts precedent).
 */

/** Structural slice of WebContents used for validation. */
export interface TrustedSenderCandidate {
  /** Top frame of the WebContents (`WebFrameMain`); identity-compared only. */
  readonly mainFrame: object | null;
}

/** Structural slice of IpcMainInvokeEvent used for validation. */
export interface ValidatableIpcEvent {
  readonly sender: TrustedSenderCandidate;
  /** Frame that sent the invoke; null when it was destroyed mid-flight. */
  readonly senderFrame: object | null;
}

const trustedSenders = new WeakSet<TrustedSenderCandidate>();

/** Called once per app-created window, at creation time. */
export function registerTrustedSender(sender: TrustedSenderCandidate): void {
  trustedSenders.add(sender);
}

/**
 * True only for invokes from the main frame of a registered WebContents.
 * Child frames are rejected outright — nothing in the app hosts frames that
 * legitimately talk to main.
 */
export function isTrustedIpcEvent(event: ValidatableIpcEvent): boolean {
  return (
    trustedSenders.has(event.sender) &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame
  );
}
