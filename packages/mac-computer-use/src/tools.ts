/**
 * The mac_* tool set — the model's remote control for ANY Mac app.
 *
 * Design goals mirror browser-use's: EFFICIENT (never dump the whole AX tree;
 * the indexed snapshot is the model's view), ROBUST (re-snapshot on a stale
 * index, retry a failed action once, structured errors — never throw), and
 * GATED (every tool routes through the per-session consent + app denylist before
 * it acts — see ./permissions.ts).
 *
 * Acting model: prefer index-based AX actions (the helper resolves `index →
 * AXUIElement` from the last snapshot and prefers the element's AXPress action —
 * reliable, no coordinate math). Pass explicit x,y for a raw coordinate click on
 * an AX-opaque surface (games / some Electron apps), the analogue of browser-
 * use's canvasHeavy coordinate fallback.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { MacBridge } from './bridge-client.js';
import {
  CHROME_SNAPSHOT_JS,
  chromeActionJs,
  chromeEval,
  chromeJsAllowed,
  enableChromeJs,
} from './chrome.js';
import { formatMacSnapshot, isAxOpaque } from './format.js';
import type { MacConsentGate } from './permissions.js';
import { createMacConsentGate } from './permissions.js';
import type { MacActAck, MacLaunchAck, MacSnapshot, MacTccStatus } from './protocol.js';
import { scrollDelta } from './scroll.js';
import { createMacSessionState, type MacSessionState } from './session-state.js';

// Tool-name constants live in the dependency-free ./tool-names.ts (single source
// of truth, cheaply importable by the harness); re-exported here for existing
// call sites.
export {
  CHROME_CLICK_TOOL,
  CHROME_GO_TOOL,
  CHROME_SNAPSHOT_TOOL,
  CHROME_TYPE_TOOL,
  MAC_CLICK_TOOL,
  MAC_COMPUTER_USE_TOOL_NAMES,
  MAC_KEY_TOOL,
  MAC_LAUNCH_TOOL,
  MAC_SCROLL_TOOL,
  MAC_SNAPSHOT_TOOL,
  MAC_TYPE_TOOL,
} from './tool-names.js';

import {
  CHROME_CLICK_TOOL,
  CHROME_GO_TOOL,
  CHROME_SNAPSHOT_TOOL,
  CHROME_TYPE_TOOL,
  MAC_CLICK_TOOL,
  MAC_KEY_TOOL,
  MAC_LAUNCH_TOOL,
  MAC_SCROLL_TOOL,
  MAC_SNAPSHOT_TOOL,
  MAC_TYPE_TOOL,
} from './tool-names.js';

const DEFAULT_ELEMENT_CAP = 60;
/** Let a click/type settle before the model's next snapshot. */
const SETTLE_MS = 350;

interface MacDetails {
  action: string;
  ok: boolean;
  app?: string;
  window?: string;
  elementCount?: number;
  /** True when the act ran via Accessibility with no focus steal; false when it
   * fell back to the foreground CGEvent path. Absent for read-only actions. */
  background?: boolean;
  /** Concrete helper path taken (AXPress / setValue / setValue+confirm / coord …). */
  mode?: string;
  error?: string;
  [k: string]: unknown;
}

/** How the model reads a background vs foreground act, appended to tool text so
 * the trace shows focus-free vs focus-stealing steps. */
function backgroundNote(ack: MacActAck): string {
  if (ack.background === true)
    return ` (background via ${ack.mode ?? 'Accessibility'}, no focus change)`;
  if (ack.background === false) return ` (foreground ${ack.mode ?? 'CGEvent'} — took focus)`;
  return '';
}

export interface MacComputerUseOptions {
  /** The bridge to the app; when null every tool reports a clear unavailable
   * error (extension loaded outside Pi Desktop). */
  readonly bridge: MacBridge | null;
  /** The consent/denylist gate; defaults to a fresh session gate. */
  readonly consent?: MacConsentGate;
  /** The controlled-app state machine; defaults to a fresh one (test seam). */
  readonly session?: MacSessionState;
  readonly elementCap?: number;
}

function textResult(text: string, details: MacDetails): AgentToolResult<MacDetails> {
  return { content: [{ type: 'text', text }], details };
}

function errResult(action: string, message: string): AgentToolResult<MacDetails> {
  return textResult(`${action} failed: ${message}`, { action, ok: false, error: message });
}

function unavailable(action: string): AgentToolResult<MacDetails> {
  return errResult(
    action,
    'mac bridge unavailable (the mac-computer-use extension must run inside Pi Desktop)',
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Register every mac_* tool onto `pi`. */
export function registerMacComputerUseTools(
  pi: ExtensionAPI,
  options: MacComputerUseOptions,
): void {
  const bridge = options.bridge;
  const cap = options.elementCap ?? DEFAULT_ELEMENT_CAP;
  const consent = options.consent ?? createMacConsentGate();

  /**
   * Per-session CONTROLLED-APP state (see ./session-state.ts). Each pi session
   * (main agent or a spawned subagent) has its own extension instance → its own
   * controlled app, whose pid it stamps onto EVERY act. The helper namespaces
   * its index→element map by pid (concurrent sessions driving different apps
   * never resolve each other's indices) and delivers fallback events to that
   * pid only (postToPid — background, no focus steal).
   */
  const session = options.session ?? createMacSessionState();

  /** Gate helper: consent + denylist, returns null when allowed. */
  async function gate(
    action: string,
    ctx: ExtensionContext,
    targetApp?: string,
  ): Promise<AgentToolResult<MacDetails> | null> {
    const decision = await consent.ensure(ctx, targetApp);
    if (decision.ok) return null;
    return errResult(action, decision.reason);
  }

  async function snapshot(app?: string, screenshot?: boolean): Promise<MacSnapshot> {
    if (bridge === null) throw new Error('bridge unavailable');
    const params: Record<string, unknown> = {};
    // Explicit app wins; otherwise target the CONTROLLED app (the one the model
    // launched / last snapshotted), falling back to frontmost only before any
    // control exists. The resolved snapshot then takes/refreshes control.
    if (app !== undefined && app !== '') params.app = app;
    else Object.assign(params, session.targetParams());
    if (screenshot === true) params.screenshot = true;
    params.cap = cap;
    const snap = await bridge.request<MacSnapshot>('snapshot', params);
    session.noteSnapshot(snap);
    return snap;
  }

  /** Stamp the controlled app's pid onto an act so the helper resolves the
   * index in the right namespace AND delivers fallback events to that app only
   * (background). */
  function withTarget(params: Record<string, unknown>): Record<string, unknown> {
    return Object.assign(params, session.targetParams());
  }

  // --- mac_snapshot --------------------------------------------------------
  pi.registerTool({
    name: MAC_SNAPSHOT_TOOL,
    label: 'Mac: Snapshot',
    description:
      "Return a COMPACT, indexed list of the target app's actionable Accessibility elements " +
      '(buttons, fields, menus, …) plus a short summary. This is your view of the app — act on ' +
      'elements by their [index]. Defaults to the app you are CONTROLLING (the one you launched ' +
      'or last snapshotted); pass an app name to switch control to another running app. Before ' +
      'any app is controlled it reads the frontmost app. If the app exposes nothing to ' +
      'Accessibility you get a SCREENSHOT of its window automatically, with its bounds — act by ' +
      'x,y coordinates in that case; you never need to ask for the image. Prefer acting by ' +
      'index when indexes exist. The first call asks the user to allow Mac control.',
    promptSnippet: 'See a Mac app as an indexed Accessibility element list',
    parameters: Type.Object({
      app: Type.Optional(
        Type.String({
          description: 'App to snapshot (name or bundle id). Default: the controlled app.',
        }),
      ),
      screenshot: Type.Optional(
        Type.Boolean({
          description:
            'Force a screenshot even when Accessibility answers (heavier). Default false — an ' +
            'app with no AX elements attaches one on its own.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_snapshot');
      const blocked = await gate('mac_snapshot', ctx, params.app);
      if (blocked !== null) return blocked;
      try {
        /*
         * AN EMPTY AX TREE MUST STILL COME BACK WITH SOMETHING TO ACT ON.
         *
         * Screenshots were opt-in, so an app that exposes nothing to Accessibility
         * answered with a sentence saying so and an instruction to call this same
         * tool again with a flag — jedd: it "returns something that just isn't able
         * to do anything ... some useless information about it being AX opaque".
         * A whole turn spent learning the tool could not help.
         *
         * So the first attempt is cheap (no capture), and if AX yields nothing we
         * immediately re-take it WITH the image and hand that back. The floor jedd
         * asked for: whatever else fails, a snapshot returns a picture of the
         * window and tells the model to work in coordinates.
         */
        let snap = await snapshot(params.app, params.screenshot === true);
        if (params.screenshot !== true && isAxOpaque(snap)) {
          snap = await snapshot(params.app, true);
        }
        const content: AgentToolResult<MacDetails>['content'] = [
          { type: 'text', text: formatMacSnapshot(snap) },
        ];
        const shot = snap.screenshot;
        const wantImage = params.screenshot === true || isAxOpaque(snap);
        if (wantImage && shot?.base64 !== undefined && shot.base64 !== '') {
          content.push({
            type: 'image',
            data: shot.base64,
            mimeType: shot.mimeType ?? 'image/png',
          });
        }
        return {
          content,
          details: {
            action: 'snapshot',
            ok: true,
            app: snap.app,
            pid: snap.pid,
            window: snap.window,
            elementCount: snap.summary.elementCount,
          },
        };
      } catch (err) {
        return errResult('mac_snapshot', messageOf(err));
      }
    },
  });

  // --- mac_click -----------------------------------------------------------
  pi.registerTool({
    name: MAC_CLICK_TOOL,
    label: 'Mac: Click',
    description:
      'Click an element by its [index] from the latest mac_snapshot. This runs in the ' +
      'BACKGROUND via the element’s own Accessibility action (AXPress/AXConfirm/AXPick) — it ' +
      'does NOT move the mouse or bring the app to the front, so the user can keep working and ' +
      'a non-frontmost app can be driven. Elements with no usable AX action get a synthetic ' +
      'click DELIVERED to the controlled app only (still background). Or pass explicit x,y ' +
      '(screen points) to click an AX-opaque surface — also delivered in the background while ' +
      'an app is controlled. A stale index triggers an auto re-snapshot + one retry.',
    promptSnippet: 'Click a Mac element by index (or x,y)',
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: 'Element index from mac_snapshot.' })),
      x: Type.Optional(
        Type.Number({ description: 'Screen x (points) for a raw coordinate click.' }),
      ),
      y: Type.Optional(
        Type.Number({ description: 'Screen y (points) for a raw coordinate click.' }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_click');
      const blocked = await gate('mac_click', ctx);
      if (blocked !== null) return blocked;
      try {
        if (typeof params.x === 'number' && typeof params.y === 'number') {
          const ack = await bridge.request<MacActAck>(
            'click',
            withTarget({ x: params.x, y: params.y }),
          );
          await sleep(SETTLE_MS);
          return textResult(`Clicked at (${params.x}, ${params.y}).${backgroundNote(ack)}`, {
            action: 'click',
            ok: true,
            background: ack.background,
            mode: ack.mode,
          });
        }
        if (typeof params.index !== 'number') {
          return errResult('mac_click', 'provide an element index, or x and y');
        }
        const index = params.index;
        let res = await bridge.request<MacActAck>('click', withTarget({ index }));
        if (!res.found) {
          await snapshot();
          res = await bridge.request<MacActAck>('click', withTarget({ index }));
          if (!res.found) {
            return errResult(
              'mac_click',
              `index ${index} not found — call mac_snapshot for current indices`,
            );
          }
        }
        await sleep(SETTLE_MS);
        return textResult(
          `Clicked element [${index}].${backgroundNote(res)} Re-snapshot to see the result.`,
          { action: 'click', ok: true, background: res.background, mode: res.mode },
        );
      } catch (err) {
        return errResult('mac_click', messageOf(err));
      }
    },
  });

  // --- mac_type ------------------------------------------------------------
  pi.registerTool({
    name: MAC_TYPE_TOOL,
    label: 'Mac: Type',
    description:
      'Set text into a field by its [index] from the latest mac_snapshot. This runs in the ' +
      'BACKGROUND: the field’s Accessibility value is set directly (no focus change, no ' +
      'keystrokes), so a non-frontmost app can be filled without disturbing the user. Fields ' +
      'that reject a value set get keystrokes DELIVERED to the controlled app only (still ' +
      'background). Set submit:true to commit a search/URL field (background AX confirm, or a ' +
      'Return delivered to the app). Set append:true to add to existing content via keystrokes ' +
      'instead of replacing it. Omit the index to type into whatever is focused (foreground ' +
      'keystrokes). A stale index triggers an auto re-snapshot + one retry.',
    promptSnippet: 'Set text into a Mac field (background) + optional submit',
    parameters: Type.Object({
      text: Type.String({ description: 'Text to set/type.' }),
      index: Type.Optional(Type.Number({ description: 'Field index from mac_snapshot.' })),
      submit: Type.Optional(
        Type.Boolean({ description: 'Commit the field after typing (search/URL). Default false.' }),
      ),
      append: Type.Optional(
        Type.Boolean({
          description: 'Append via keystrokes instead of replacing the value. Default false.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_type');
      const blocked = await gate('mac_type', ctx);
      if (blocked !== null) return blocked;
      try {
        const text = params.text;
        const submit = params.submit === true;
        const append = params.append === true;
        if (typeof params.index !== 'number') {
          // SAFETY: index-less typing is FOREGROUND keystrokes into whatever holds
          // the SYSTEM focus — if we're driving a specific (likely non-frontmost)
          // app, that lands in the USER's active app, not the target. Once an app
          // is controlled, refuse and steer the model to the background
          // AX-by-index path. (Focused typing is only allowed before any control
          // exists, i.e. genuine "type into the frontmost field" use.)
          if (session.controlled() !== null) {
            return errResult(
              'mac_type',
              'refusing to type without an index after snapshotting an app: index-less typing ' +
                'sends keystrokes to the FRONTMOST app (which may be the user’s), not your ' +
                'target. Call mac_snapshot and pass the field’s [index] so the text is set via ' +
                'Accessibility in the background.',
            );
          }
          const ack = await bridge.request<MacActAck>('type', { text, submit });
          await sleep(SETTLE_MS);
          return textResult(`Typed into the focused field.${backgroundNote(ack)}`, {
            action: 'type',
            ok: true,
            background: ack.background,
            mode: ack.mode,
          });
        }
        const index = params.index;
        const body = (): Record<string, unknown> => withTarget({ index, text, submit, append });
        let res = await bridge.request<MacActAck>('type', body());
        if (!res.found) {
          await snapshot();
          res = await bridge.request<MacActAck>('type', body());
          if (!res.found) {
            return errResult(
              'mac_type',
              `index ${index} is not a settable/focusable field — call mac_snapshot`,
            );
          }
        }
        await sleep(SETTLE_MS);
        const submitted = res.submitted === true ? ' Submitted.' : '';
        return textResult(
          `Set text into [${index}].${backgroundNote(res)}${submitted} Re-snapshot to see the result.`,
          { action: 'type', ok: true, background: res.background, mode: res.mode },
        );
      } catch (err) {
        return errResult('mac_type', messageOf(err));
      }
    },
  });

  // --- mac_key -------------------------------------------------------------
  pi.registerTool({
    name: MAC_KEY_TOOL,
    label: 'Mac: Key',
    description:
      'Press a key combo, e.g. "cmd+s", "cmd+shift+z", "return", "tab", "escape", "down". ' +
      'While you are controlling an app the chord is DELIVERED to that app in the background ' +
      '(the user’s focus is untouched). Use for menu shortcuts, saving, dialogs, and navigation.',
    promptSnippet: 'Press a Mac key combo (e.g. cmd+s)',
    parameters: Type.Object({
      combo: Type.String({
        description: 'Key combo, e.g. cmd+s, cmd+shift+z, return, tab, escape.',
      }),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_key');
      const blocked = await gate('mac_key', ctx);
      if (blocked !== null) return blocked;
      try {
        const ack = await bridge.request<{ ok: boolean; background?: boolean }>(
          'key',
          withTarget({ combo: params.combo }),
        );
        await sleep(SETTLE_MS);
        const note =
          ack.background === true ? ' (delivered to the controlled app, no focus change)' : '';
        return textResult(`Pressed ${params.combo}.${note}`, {
          action: 'key',
          ok: true,
          background: ack.background,
        });
      } catch (err) {
        return errResult('mac_key', messageOf(err));
      }
    },
  });

  // --- mac_scroll ----------------------------------------------------------
  pi.registerTool({
    name: MAC_SCROLL_TOOL,
    label: 'Mac: Scroll',
    description:
      'Scroll the controlled app’s window (delivered in the background — the window scrolls ' +
      'without coming to the front), then re-snapshot to reveal off-screen elements.',
    promptSnippet: 'Scroll a Mac app',
    parameters: Type.Object({
      direction: Type.Union(
        [Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')],
        { description: 'Scroll direction.' },
      ),
      amount: Type.Optional(Type.Number({ description: 'Pixels to scroll (default ~300).' })),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_scroll');
      const blocked = await gate('mac_scroll', ctx);
      if (blocked !== null) return blocked;
      try {
        // Resolve the signed pixel delta here (pure + unit-tested) and hand the
        // helper explicit dx/dy — a meaningful magnitude the stepped background
        // scroll can't swallow. direction/amount ride along for logging + as the
        // helper's legacy fallback.
        const { dx, dy } = scrollDelta(params.direction, params.amount);
        const ack = await bridge.request<{
          ok: boolean;
          background?: boolean;
          mode?: string;
          moved?: boolean;
          coveredByOtherWindows?: boolean;
        }>('scroll', withTarget({ direction: params.direction, amount: params.amount, dx, dy }));
        // The helper VERIFIES movement against the scroll area's AX scroll bar
        // when one exists (climbing a pixel-burst→gesture→line→AX ladder) —
        // surface an honest "nothing moved" so the model reacts instead of
        // assuming (jedd's field report was exactly a silent no-op).
        if (ack.moved === false) {
          return textResult(
            `Scroll ${params.direction} had NO effect (content did not move${
              ack.coveredByOtherWindows === true
                ? '; the window is fully covered by other windows'
                : ''
            }). The view may already be at its end, or this area is not scrollable — ` +
              'mac_snapshot to re-check.',
            {
              action: 'scroll',
              ok: true,
              background: ack.background,
              mode: ack.mode,
              moved: false,
            },
          );
        }
        return textResult(`Scrolled ${params.direction}. Re-snapshot to see new elements.`, {
          action: 'scroll',
          ok: true,
          background: ack.background,
          mode: ack.mode,
          moved: ack.moved,
        });
      } catch (err) {
        return errResult('mac_scroll', messageOf(err));
      }
    },
  });

  // --- mac_launch ----------------------------------------------------------
  pi.registerTool({
    name: MAC_LAUNCH_TOOL,
    label: 'Mac: Launch',
    description:
      'Open a Mac app IN THE BACKGROUND and take control of it. The app never steals focus — ' +
      'the user keeps whatever they are doing. The result IMMEDIATELY includes a fresh indexed ' +
      'element snapshot AND a screenshot of the app’s window, so you can see exactly what it ' +
      'looks like and act in the same turn (no separate mac_snapshot needed). The launched app ' +
      'becomes your CONTROLLED target: every mac_click/mac_type/mac_key/mac_scroll routes to it ' +
      'until you launch or snapshot a different app. Set foreground:true only if the user ' +
      'explicitly asked to bring it to the front.',
    promptSnippet: 'Open a Mac app in the background + see it immediately',
    parameters: Type.Object({
      app: Type.String({ description: 'App name to launch/focus, e.g. "TextEdit".' }),
      foreground: Type.Optional(
        Type.Boolean({ description: 'Bring the app to the front (steals focus). Default false.' }),
      ),
    }),
    async execute(_id, params, _signal, _upd, ctx): Promise<AgentToolResult<MacDetails>> {
      if (bridge === null) return unavailable('mac_launch');
      const blocked = await gate('mac_launch', ctx, params.app);
      if (blocked !== null) return blocked;
      try {
        const background = params.foreground !== true;
        const ack = await bridge.request<MacLaunchAck>('launch', {
          app: params.app,
          background,
        });
        if (!ack.ok) {
          return errResult('mac_launch', ack.error ?? `could not launch "${params.app}"`);
        }
        // The bridge has already waited for the app's window to exist and
        // resolved its pid — record CONTROL so every subsequent act routes to
        // this app unambiguously.
        if (typeof ack.pid === 'number') {
          session.noteLaunched(ack.app ?? params.app, ack.pid, ack.bounds?.windowId);
        }
        await sleep(SETTLE_MS);

        // SNAPSHOT-AFTER-OPEN CONTRACT: the model must immediately SEE the app
        // it now controls — indexed elements + a window screenshot in THIS tool
        // result, not a separate call it may forget to make.
        let snapText: string;
        let shot: MacSnapshot['screenshot'];
        try {
          const snap =
            typeof ack.pid === 'number'
              ? await snapshot(undefined, true) // targets the controlled pid
              : await snapshot(params.app, true);
          snapText = formatMacSnapshot(snap);
          shot = snap.screenshot;
        } catch (err) {
          snapText = `(snapshot after launch failed: ${messageOf(err)} — call mac_snapshot)`;
        }

        const where = background
          ? 'in the background — it did NOT take focus; the user keeps their current app'
          : 'to the front';
        const control = session.describe();
        const hasImage = shot?.base64 !== undefined && shot.base64 !== '';
        const shotNote = hasImage
          ? 'Its window screenshot is attached below.'
          : '(window screenshot unavailable — Screen Recording may not be granted; act via the element list.)';
        const content: AgentToolResult<MacDetails>['content'] = [
          {
            type: 'text',
            text:
              `Launched ${ack.app ?? params.app} ${where}. ${control} All mac_* actions now ` +
              `target it automatically. ${shotNote}\n\n${snapText}`,
          },
        ];
        if (hasImage && shot !== undefined) {
          content.push({
            type: 'image',
            data: shot.base64 ?? '',
            mimeType: shot.mimeType ?? 'image/png',
          });
        }
        return {
          content,
          details: {
            action: 'launch',
            ok: true,
            app: ack.app ?? params.app,
            pid: ack.pid,
            background,
            controlled: session.controlled() !== null,
            snapshot: true,
            screenshot: hasImage,
          },
        };
      } catch (err) {
        return errResult('mac_launch', messageOf(err));
      }
    },
  });
}

/** Probe the TCC grant status through the bridge (drives the capabilities UI). */
export async function checkMacTcc(bridge: MacBridge): Promise<MacTccStatus> {
  return bridge.request<MacTccStatus>('check');
}

/**
 * Register the Chrome DOM tools.
 *
 * Separate from the mac_* registration because they are a different KIND of
 * control: real elements instead of coordinates, in the user's own Chrome with
 * their sessions and logins. Computer use sees Chrome as one opaque rectangle;
 * this sees the page.
 *
 * The `defaults write` that unlocks it is a change to ANOTHER app's preferences,
 * so it is never made silently — the same confirm the Mac-control gate uses asks
 * first, and a refusal is reported honestly rather than retried.
 */
export function registerChromeTools(pi: ExtensionAPI): void {
  let askedThisSession = false;

  /** Make sure Chrome will run our JavaScript, asking the user once if not. */
  async function ensureChromeJs(ctx: ExtensionContext): Promise<string | null> {
    if (await chromeJsAllowed()) return null;
    if (ctx.hasUI !== true) {
      return (
        'Chrome will not run JavaScript from Apple Events yet, and there is no UI here to ' +
        'ask for permission to enable it.'
      );
    }
    if (askedThisSession) {
      return 'Chrome scripting was not enabled — the user declined earlier this session.';
    }
    askedThisSession = true;
    const ok = await ctx.ui.confirm(
      'Let Pi control Google Chrome?',
      'To read and click pages in YOUR Chrome (with your logins), Chrome has to allow ' +
        'JavaScript from Apple Events. This changes one Chrome setting — the same one under ' +
        'View → Developer → Allow JavaScript from Apple Events — and Chrome must be restarted ' +
        'for it to take effect. Nothing else about Chrome is changed.',
    );
    if (!ok) return 'The user declined to enable Chrome scripting.';
    const res = await enableChromeJs();
    if (!res.ok) return `Could not change the Chrome setting: ${res.stderr}`;
    return (
      'ENABLED — but Chrome must be RESTARTED before it takes effect. Tell the user to quit ' +
      'and reopen Chrome, then try again.'
    );
  }

  /** Shared: gate, evaluate, and turn a failure into something actionable. */
  async function evalInChrome(
    ctx: ExtensionContext,
    js: string,
  ): Promise<{ text: string; ok: boolean }> {
    const blocked = await ensureChromeJs(ctx);
    if (blocked !== null) return { text: blocked, ok: false };
    const res = await chromeEval(js);
    if (!res.ok) return { text: res.error ?? 'Chrome did not respond.', ok: false };
    return { text: res.value, ok: true };
  }

  pi.registerTool({
    name: CHROME_SNAPSHOT_TOOL,
    label: 'Chrome: Snapshot',
    description:
      "Read the page in the user's own Google Chrome — its URL, title, and an INDEXED list of " +
      'the interactive elements actually visible on it. This reads the real DOM, so prefer it ' +
      'over computer-use screenshots whenever the work is in Chrome. Act on what it lists with ' +
      'chrome_click / chrome_type by [index].',
    promptSnippet: "See the page in the user's Chrome as an indexed element list",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _upd, ctx) {
      const out = await evalInChrome(ctx, CHROME_SNAPSHOT_JS);
      return { content: [{ type: 'text', text: out.text }], details: undefined };
    },
  });

  pi.registerTool({
    name: CHROME_CLICK_TOOL,
    label: 'Chrome: Click',
    description:
      'Click an element in the user’s Chrome by its [index] from the latest chrome_snapshot. ' +
      'Indexes come from the same visible-element ordering, so they always agree.',
    promptSnippet: 'Click an element in the user’s Chrome by index',
    parameters: Type.Object({
      index: Type.Number({ description: 'The [index] from chrome_snapshot.' }),
    }),
    async execute(_id, params, _signal, _upd, ctx) {
      const out = await evalInChrome(ctx, chromeActionJs(params.index, 'click'));
      return { content: [{ type: 'text', text: out.text }], details: undefined };
    },
  });

  pi.registerTool({
    name: CHROME_TYPE_TOOL,
    label: 'Chrome: Type',
    description:
      'Type text into an editable element in the user’s Chrome, by its [index] from the latest ' +
      'chrome_snapshot. Sets the value and fires the input/change events a page listens for.',
    promptSnippet: 'Type into a field in the user’s Chrome',
    parameters: Type.Object({
      index: Type.Number({ description: 'The [index] from chrome_snapshot.' }),
      text: Type.String({ description: 'The text to enter.' }),
    }),
    async execute(_id, params, _signal, _upd, ctx) {
      const out = await evalInChrome(ctx, chromeActionJs(params.index, 'focus', params.text));
      return { content: [{ type: 'text', text: out.text }], details: undefined };
    },
  });

  pi.registerTool({
    name: CHROME_GO_TOOL,
    label: 'Chrome: Navigate',
    description: "Navigate the active tab of the user's Chrome to a URL.",
    promptSnippet: 'Send the user’s Chrome to a URL',
    parameters: Type.Object({ url: Type.String({ description: 'The URL to open.' }) }),
    async execute(_id, params, _signal, _upd, ctx) {
      const url = params.url.trim();
      if (!/^https?:\/\//i.test(url)) {
        return {
          content: [{ type: 'text', text: 'Only http(s) URLs can be opened this way.' }],
          details: undefined,
        };
      }
      const out = await evalInChrome(ctx, `location.href = ${JSON.stringify(url)}; location.href`);
      return { content: [{ type: 'text', text: out.text }], details: undefined };
    },
  });
}
