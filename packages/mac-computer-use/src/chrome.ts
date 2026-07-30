/**
 * Google Chrome, driven through its DOM instead of its pixels.
 *
 * Computer use sees Chrome the way it sees a game: one big AX-opaque rectangle.
 * Clicking a link means reading a screenshot and guessing coordinates, which is
 * slow, brittle, and the thing jedd has been hitting — "mac computer use
 * consistently failing across most apps and areas".
 *
 * Chrome can do better. It exposes `execute javascript` over Apple Events, so we
 * can read the real DOM and act on real elements — the same quality of control
 * the app's built-in browser has, in the user's OWN Chrome, with their sessions
 * and logins. No extension to install, which jedd rightly called "a very odd
 * process for a lot of users".
 *
 * TWO GATES, AND WE ASK BEFORE EITHER:
 *  1. Chrome ships with `AllowJavaScriptAppleEvents` off. Turning it on is a
 *     `defaults write` against ANOTHER application's preferences plus a Chrome
 *     restart — we ask first, exactly like the Mac-control consent prompt, and
 *     never write it silently.
 *  2. macOS then asks for Automation permission the first time we script Chrome.
 *     That one is the system's own prompt; we just surface what it means.
 *
 * Everything here shells out; nothing is Electron-aware, so it unit-tests.
 */
import { execFile } from 'node:child_process';

/** Chrome's preference domain and the key that unlocks `execute javascript`. */
export const CHROME_DOMAIN = 'com.google.Chrome';
export const CHROME_JS_KEY = 'AllowJavaScriptAppleEvents';

/** How long any single osascript/defaults call may take. */
const EXEC_TIMEOUT_MS = 15_000;

export interface ExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command, never throwing — a failure is a result, not an exception. */
export async function run(file: string, args: readonly string[]): Promise<ExecResult> {
  return await new Promise((resolve) => {
    execFile(file, [...args], { timeout: EXEC_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
      });
    });
  });
}

/** `defaults read` yields "1"/"0"/"true"/"false", or fails when the key is unset. */
export function parseDefaultsBool(res: ExecResult): boolean {
  if (!res.ok) return false; // key absent ⇒ Chrome's default, which is OFF
  const v = res.stdout.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Is Chrome willing to run JavaScript sent over Apple Events? */
export async function chromeJsAllowed(): Promise<boolean> {
  return parseDefaultsBool(await run('defaults', ['read', CHROME_DOMAIN, CHROME_JS_KEY]));
}

/** Turn it on. The caller MUST have consent before calling this. */
export async function enableChromeJs(): Promise<ExecResult> {
  return await run('defaults', ['write', CHROME_DOMAIN, CHROME_JS_KEY, '-bool', 'true']);
}

/**
 * The AppleScript that runs one JS expression in Chrome's active tab.
 *
 * Built as a string rather than a template so the JS is escaped exactly once, in
 * a place that is tested — an unescaped quote here would silently truncate the
 * script and "work" while doing something else.
 */
export function chromeEvalScript(js: string): string {
  const escaped = js.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "Google Chrome" to execute front window's active tab javascript "${escaped}"`;
}

/** What a failed Chrome script means, in words the model can act on. */
export function explainChromeFailure(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('not allowed') || s.includes('-1743') || s.includes('not authorized')) {
    return (
      'macOS has not granted permission to control Chrome. Approve the "Automation" prompt, ' +
      'or enable it in System Settings → Privacy & Security → Automation.'
    );
  }
  if (s.includes('javascript') || s.includes('-2700') || s.includes('executing javascript')) {
    return (
      'Chrome is refusing JavaScript from Apple Events. It must be enabled AND Chrome ' +
      'restarted for the setting to take effect.'
    );
  }
  if (s.includes("can't get") || s.includes('front window')) {
    return 'Chrome has no open window to act on. Open a tab first.';
  }
  return stderr.length > 0 ? stderr : 'Chrome did not respond to the script.';
}

/** Run JS in Chrome's active tab and return whatever it evaluated to. */
export async function chromeEval(
  js: string,
): Promise<{ ok: boolean; value: string; error?: string }> {
  const res = await run('osascript', ['-e', chromeEvalScript(js)]);
  if (!res.ok) return { ok: false, value: '', error: explainChromeFailure(res.stderr) };
  return { ok: true, value: res.stdout };
}

/**
 * The in-page script that produces the snapshot.
 *
 * Deliberately the same SHAPE as the built-in browser's: an indexed list of the
 * things you can actually act on, so the model's habits transfer between the two
 * browsers instead of being per-tool trivia. Elements are numbered in document
 * order and that ordering is what `chrome_click` / `chrome_type` address, so a
 * snapshot and the action that follows agree.
 */
export const CHROME_SNAPSHOT_JS = `(function(){
  var sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[onclick],[contenteditable=true]';
  var out = [];
  var nodes = document.querySelectorAll(sel);
  for (var i = 0; i < nodes.length && out.length < 200; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    var label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || '').trim().replace(/\\s+/g,' ').slice(0,80);
    var role = el.getAttribute('role') || el.tagName.toLowerCase();
    var extra = '';
    if (el.tagName === 'A' && el.href) extra = ' -> ' + el.href.slice(0,120);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) extra += ' (editable)';
    out.push('[' + out.length + '] ' + role + (label ? ' "' + label + '"' : '') + extra);
  }
  return 'URL: ' + location.href + '\\nTITLE: ' + document.title + '\\n\\n' + (out.length ? out.join('\\n') : '(no interactive elements found)');
})()`;

/** Address the Nth element the snapshot listed — same selector, same order. */
export function chromeActionJs(index: number, action: 'click' | 'focus', text?: string): string {
  const sel =
    "'a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[onclick],[contenteditable=true]'";
  const body =
    action === 'click'
      ? 'el.click(); return "clicked " + (el.innerText||el.value||el.tagName).slice(0,60);'
      : `el.focus(); el.value = ${JSON.stringify(text ?? '')}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return "typed into " + el.tagName;`;
  return `(function(){
  var nodes = document.querySelectorAll(${sel});
  var vis = [];
  for (var i=0;i<nodes.length;i++){ var r=nodes[i].getBoundingClientRect(); var s=window.getComputedStyle(nodes[i]); if(r.width&&r.height&&s.visibility!=='hidden'&&s.display!=='none') vis.push(nodes[i]); }
  var el = vis[${Math.max(0, Math.floor(index))}];
  if (!el) return "ERROR: no element [${Math.max(0, Math.floor(index))}] — re-snapshot, the page may have changed";
  ${body}
})()`;
}
