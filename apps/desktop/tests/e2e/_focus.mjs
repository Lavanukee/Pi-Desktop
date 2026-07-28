/**
 * Keep a probe's window off the user's keyboard.
 *
 * `PI_E2E_BACKGROUND=1` makes the app an 'accessory' before macOS decides
 * whether to activate it, which is the real fix. This is the belt-and-braces
 * for the moments it cannot cover — a helper process, a permission sheet, or a
 * macOS version that activates anyway: remember who was frontmost before we
 * launched, and hand focus straight back.
 *
 * Best-effort by design. If System Events is unavailable or refuses (no
 * Automation permission), the run continues exactly as before — a probe must
 * never fail because it could not tidy up the desktop.
 */
import { execFileSync } from 'node:child_process';

/** The frontmost application's name, or null if it cannot be read. */
export function frontmostApp() {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync(
      'osascript',
      [
        '-e',
        'tell application "System Events" to get name of first process whose frontmost is true',
      ],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

/** Put `name` back in front. No-op when `name` is null/blank. */
export function restoreFocus(name) {
  if (process.platform !== 'darwin' || typeof name !== 'string' || name.length === 0) return;
  try {
    execFileSync(
      'osascript',
      ['-e', `tell application "System Events" to set frontmost of process "${name}" to true`],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
  } catch {
    /* nothing to do — the probe's own work matters more than the desktop */
  }
}

/**
 * Capture the frontmost app now and give back the env to launch with. Call
 * `restore()` once the window exists (and again after anything that might steal
 * focus back). `FOCUS=1` opts out of the whole thing.
 */
export function backgroundLaunch() {
  if (process.env.FOCUS === '1') return { env: {}, restore: () => {} };
  const was = frontmostApp();
  return {
    env: { PI_E2E_BACKGROUND: '1' },
    restore: () => restoreFocus(was),
  };
}
