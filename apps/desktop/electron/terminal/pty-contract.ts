/**
 * Terminal-tab PTY IPC contract. Pure types + a runtime channel list (no
 * electron/node imports) so the sandboxed preload and the renderer can consume
 * it (composed into ../ipc-contract.ts). One backend session per terminal
 * canvas tab lives in the main process (electron/terminal/pty-manager.ts); the
 * renderer mounts xterm.js into the TerminalSurface slot and wires I/O both
 * ways over these channels.
 */

/** Which backend actually backs a session — a real PTY, or the piped-shell
 * fallback used when node-pty's native binary isn't available for this
 * Electron ABI (see pty-manager.ts). Surfaced so the UI/tests can note it. */
export type PtyBackend = 'node-pty' | 'pipe';

export type PtyInvokeMap = {
  /** Spawn (idempotent per tab) the shell for a terminal tab. */
  'pty:spawn': {
    request: { tabId: string; shell?: string; cwd?: string; cols?: number; rows?: number };
    response: { ok: boolean; pid: number | null; backend: PtyBackend };
  };
  /** Forward keystrokes/paste from xterm to the shell. */
  'pty:write': { request: { tabId: string; data: string }; response: { ok: boolean } };
  /** Resize the PTY to match xterm's fitted grid. */
  'pty:resize': {
    request: { tabId: string; cols: number; rows: number };
    response: { ok: boolean };
  };
  /** Kill the shell and drop the session (tab closed). */
  'pty:kill': { request: { tabId: string }; response: { ok: boolean } };
};

export const PTY_INVOKE_CHANNELS = [
  'pty:spawn',
  'pty:write',
  'pty:resize',
  'pty:kill',
] as const satisfies readonly (keyof PtyInvokeMap)[];

export type PtyEventMap = {
  /** A chunk of shell output for a terminal tab (main → renderer → xterm). */
  'pty:data': { tabId: string; data: string };
  /** The shell exited; the renderer marks the terminal done. */
  'pty:exit': { tabId: string; exitCode: number | null };
};
