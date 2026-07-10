/**
 * The browser_* tool set — the model's remote control for the canvas browser.
 *
 * Design goals (jedd's asks): EFFICIENT (never dump full DOM; the indexed
 * snapshot is the model's view), ROBUST (re-snapshot on a stale index, retry a
 * failed action once, structured errors — never throw), and VISIBLE (acting
 * routes through the app which animates the virtual cursor + live typing).
 *
 * Acting model: prefer index-based DOM actions (the app resolves `index →
 * element` via the `data-pi-idx` stamp and executeJavaScript-clicks/focuses —
 * reliable, no coordinate math). On a WebGL/`<canvas>`-heavy page, or when the
 * caller passes explicit `x,y`, fall back to coordinate clicks (sendInputEvent).
 */
import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { BrowserBridge } from './bridge-client.js';
import { formatSnapshot } from './format.js';
import { type PageSnapshot, perceptionScript, readScript, scrollScript } from './perception.js';
import type { TabState } from './protocol.js';
import {
  BROWSER_BACK_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_FORWARD_TOOL,
  BROWSER_KEY_TOOL,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_READ_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_SNAPSHOT_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_WAIT_TOOL,
} from './tool-names.js';

// Re-export the tool names (single source of truth: ./tool-names.ts) so existing
// importers of `@pi-desktop/browser-use` keep working unchanged.
export * from './tool-names.js';

const DEFAULT_ELEMENT_CAP = 60;
const READ_MAX_CHARS = 8000;
/** Let a click/type settle before the model's next snapshot. */
const SETTLE_MS = 350;

interface BrowserDetails {
  action: string;
  ok: boolean;
  url?: string;
  title?: string;
  elementCount?: number;
  canvasHeavy?: boolean;
  error?: string;
  [k: string]: unknown;
}

/** Options so W5/the app can inject a bridge and tune sizing. */
export interface BrowserUseOptions {
  /** The bridge to the app; when null every tool reports a clear unavailable
   * error (extension loaded outside Pi Desktop). */
  readonly bridge: BrowserBridge | null;
  readonly elementCap?: number;
}

function textResult(text: string, details: BrowserDetails): AgentToolResult<BrowserDetails> {
  return { content: [{ type: 'text', text }], details };
}

function errResult(action: string, message: string): AgentToolResult<BrowserDetails> {
  return textResult(`${action} failed: ${message}`, { action, ok: false, error: message });
}

function unavailable(action: string): AgentToolResult<BrowserDetails> {
  return errResult(
    action,
    'browser bridge unavailable (the browser-use extension must run inside Pi Desktop)',
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Register every browser_* tool onto `pi`. */
export function registerBrowserUseTools(pi: ExtensionAPI, options: BrowserUseOptions): void {
  const bridge = options.bridge;
  const cap = options.elementCap ?? DEFAULT_ELEMENT_CAP;
  // Remembered from the last snapshot so click can prefer coordinates on a
  // canvas/WebGL page without an extra round trip.
  const pageState = { canvasHeavy: false };

  async function snapshot(): Promise<PageSnapshot> {
    if (bridge === null) throw new Error('bridge unavailable');
    const snap = await bridge.request<PageSnapshot>('evaluate', { script: perceptionScript(cap) });
    if (snap !== null && typeof snap === 'object' && 'summary' in snap) {
      pageState.canvasHeavy = snap.summary.canvasHeavy === true;
    }
    return snap;
  }

  // --- browser_navigate ----------------------------------------------------
  pi.registerTool({
    name: BROWSER_NAVIGATE_TOOL,
    label: 'Browse: Navigate',
    description:
      'Open a URL in the canvas browser (opening/focusing the browser tab if needed) and wait ' +
      'for it to load. Follow with browser_snapshot to see the page. The user watches a live ' +
      'cursor as you browse.',
    promptSnippet: 'Navigate the canvas browser to a URL',
    parameters: Type.Object({
      url: Type.String({ description: 'URL to open (a bare host gets https://).' }),
    }),
    async execute(_id, params): Promise<AgentToolResult<BrowserDetails>> {
      if (bridge === null) return unavailable('browser_navigate');
      try {
        const state = await bridge.request<TabState>('navigate', { url: params.url });
        return textResult(
          `Navigated to ${state.url}\nTitle: ${state.title || '(untitled)'}\n` +
            'Call browser_snapshot to see interactive elements.',
          { action: 'navigate', ok: true, url: state.url, title: state.title },
        );
      } catch (err) {
        return errResult('browser_navigate', messageOf(err));
      }
    },
  });

  // --- browser_snapshot ----------------------------------------------------
  pi.registerTool({
    name: BROWSER_SNAPSHOT_TOOL,
    label: 'Browse: Snapshot',
    description:
      "Return a COMPACT, indexed list of the page's interactive + salient elements plus a short " +
      'summary (title, url, headings, landmarks, scroll). This is your view of the page — act on ' +
      'elements by their [index]. Optionally attach a screenshot. Prefer this over dumping HTML.',
    promptSnippet: 'See the current page as an indexed element list',
    parameters: Type.Object({
      screenshot: Type.Optional(
        Type.Boolean({ description: 'Also attach a screenshot image (heavier). Default false.' }),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<BrowserDetails>> {
      if (bridge === null) return unavailable('browser_snapshot');
      try {
        const snap = await snapshot();
        const text = formatSnapshot(snap);
        const content: AgentToolResult<BrowserDetails>['content'] = [{ type: 'text', text }];
        if (params.screenshot === true) {
          try {
            const shot = await bridge.request<{ dataUrl: string | null }>('screenshot');
            const dataUrl = shot?.dataUrl ?? null;
            const comma = dataUrl?.indexOf(',') ?? -1;
            if (dataUrl !== null && comma !== -1) {
              content.push({
                type: 'image',
                data: dataUrl.slice(comma + 1),
                mimeType: 'image/png',
              });
            }
          } catch {
            // Screenshot is best-effort; the indexed list is the primary payload.
          }
        }
        return {
          content,
          details: {
            action: 'snapshot',
            ok: true,
            url: snap.summary.url,
            title: snap.summary.title,
            elementCount: snap.summary.elementCount,
            canvasHeavy: snap.summary.canvasHeavy,
          },
        };
      } catch (err) {
        return errResult('browser_snapshot', messageOf(err));
      }
    },
  });

  // --- browser_click -------------------------------------------------------
  pi.registerTool({
    name: BROWSER_CLICK_TOOL,
    label: 'Browse: Click',
    description:
      'Click an element by its [index] from the latest browser_snapshot. On a canvas/WebGL page ' +
      'the click automatically falls back to coordinates. You may instead pass explicit x,y ' +
      '(viewport CSS pixels) to click an arbitrary point. Stale indices trigger an auto re-snapshot.',
    promptSnippet: 'Click an element by index (or x,y)',
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: 'Element index from browser_snapshot.' })),
      x: Type.Optional(Type.Number({ description: 'Viewport x (px) for a raw coordinate click.' })),
      y: Type.Optional(Type.Number({ description: 'Viewport y (px) for a raw coordinate click.' })),
    }),
    async execute(_id, params): Promise<AgentToolResult<BrowserDetails>> {
      if (bridge === null) return unavailable('browser_click');
      try {
        if (typeof params.x === 'number' && typeof params.y === 'number') {
          await bridge.request('click', { x: params.x, y: params.y });
          await sleep(SETTLE_MS);
          return textResult(`Clicked at (${params.x}, ${params.y}).`, {
            action: 'click',
            ok: true,
          });
        }
        if (typeof params.index !== 'number') {
          return errResult('browser_click', 'provide an element index, or x and y');
        }
        const index = params.index;
        const mode = pageState.canvasHeavy ? 'coord' : 'dom';
        let res = await bridge.request<{ found: boolean }>('clickElement', { index, mode });
        if (!res.found) {
          // Stale index — refresh the stamps and retry once with the fresh view.
          await snapshot();
          const retryMode = pageState.canvasHeavy ? 'coord' : 'dom';
          res = await bridge.request<{ found: boolean }>('clickElement', {
            index,
            mode: retryMode,
          });
          if (!res.found) {
            return errResult(
              'browser_click',
              `index ${index} not found — call browser_snapshot for current indices`,
            );
          }
        }
        await sleep(SETTLE_MS);
        return textResult(`Clicked element [${index}]. Re-snapshot to see the result.`, {
          action: 'click',
          ok: true,
        });
      } catch (err) {
        return errResult('browser_click', messageOf(err));
      }
    },
  });

  // --- browser_type --------------------------------------------------------
  pi.registerTool({
    name: BROWSER_TYPE_TOOL,
    label: 'Browse: Type',
    description:
      'Type text into a field by its [index] from the latest browser_snapshot. Focuses the field, ' +
      'shows a live typing indicator, and (with submit=true) presses Enter. Stale indices trigger ' +
      'an auto re-snapshot.',
    promptSnippet: 'Type into a field by index',
    parameters: Type.Object({
      index: Type.Number({ description: 'Field index from browser_snapshot.' }),
      text: Type.String({ description: 'Text to type.' }),
      submit: Type.Optional(
        Type.Boolean({ description: 'Press Enter after typing. Default false.' }),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<BrowserDetails>> {
      if (bridge === null) return unavailable('browser_type');
      try {
        const { index, text } = params;
        const submit = params.submit === true;
        let res = await bridge.request<{ found: boolean }>('type', { index, text, submit });
        if (!res.found) {
          await snapshot();
          res = await bridge.request<{ found: boolean }>('type', { index, text, submit });
          if (!res.found) {
            return errResult(
              'browser_type',
              `index ${index} is not an editable field — call browser_snapshot`,
            );
          }
        }
        await sleep(SETTLE_MS);
        const suffix = submit ? ' and pressed Enter' : '';
        return textResult(`Typed into [${index}]${suffix}. Re-snapshot to see the result.`, {
          action: 'type',
          ok: true,
        });
      } catch (err) {
        return errResult('browser_type', messageOf(err));
      }
    },
  });

  // --- browser_scroll ------------------------------------------------------
  pi.registerTool({
    name: BROWSER_SCROLL_TOOL,
    label: 'Browse: Scroll',
    description: 'Scroll the page. Use to reveal below-the-fold elements, then re-snapshot.',
    promptSnippet: 'Scroll the page',
    parameters: Type.Object({
      direction: Type.Union(
        [
          Type.Literal('up'),
          Type.Literal('down'),
          Type.Literal('left'),
          Type.Literal('right'),
          Type.Literal('top'),
          Type.Literal('bottom'),
        ],
        { description: 'Scroll direction (top/bottom jump to an edge).' },
      ),
      amount: Type.Optional(
        Type.Number({ description: 'Pixels to scroll (default ~85% viewport).' }),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<BrowserDetails>> {
      if (bridge === null) return unavailable('browser_scroll');
      try {
        const res = await bridge.request<{
          scrollY: number;
          maxScrollY: number;
          atBottom: boolean;
        }>('evaluate', { script: scrollScript(params.direction, params.amount) });
        return textResult(
          `Scrolled ${params.direction}. Now at ${res.scrollY}/${res.maxScrollY}px` +
            `${res.atBottom ? ' (bottom)' : ''}. Re-snapshot to see new elements.`,
          { action: 'scroll', ok: true },
        );
      } catch (err) {
        return errResult('browser_scroll', messageOf(err));
      }
    },
  });

  // --- browser_read --------------------------------------------------------
  pi.registerTool({
    name: BROWSER_READ_TOOL,
    label: 'Browse: Read',
    description:
      'Extract the readable text of the page (or a CSS selector) — readability-lite, ' +
      'whitespace-collapsed, length-capped. Use to actually read article/content text.',
    promptSnippet: 'Read the page text',
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({ description: 'CSS selector to read (default: main/article/body).' }),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<BrowserDetails>> {
      if (bridge === null) return unavailable('browser_read');
      try {
        const res = await bridge.request<{
          ok: boolean;
          title?: string;
          text?: string;
          truncated?: boolean;
          error?: string;
        }>('evaluate', { script: readScript(params.selector, READ_MAX_CHARS) });
        if (!res.ok) return errResult('browser_read', res.error ?? 'no readable content');
        const head = res.title ? `# ${res.title}\n\n` : '';
        const trunc = res.truncated ? '\n\n(content truncated)' : '';
        return textResult(`${head}${res.text ?? ''}${trunc}`.trim(), {
          action: 'read',
          ok: true,
          truncated: res.truncated,
        });
      } catch (err) {
        return errResult('browser_read', messageOf(err));
      }
    },
  });

  // --- browser_wait --------------------------------------------------------
  pi.registerTool({
    name: BROWSER_WAIT_TOOL,
    label: 'Browse: Wait',
    description:
      'Wait for the page to finish loading (forNavigation) or a fixed number of milliseconds. Use ' +
      'after an action that triggers navigation or async content.',
    promptSnippet: 'Wait for navigation or a delay',
    parameters: Type.Object({
      forNavigation: Type.Optional(
        Type.Boolean({ description: 'Wait until loading settles (default if ms omitted).' }),
      ),
      ms: Type.Optional(Type.Number({ description: 'Fixed delay in ms (max 15000).' })),
    }),
    async execute(_id, params): Promise<AgentToolResult<BrowserDetails>> {
      if (bridge === null) return unavailable('browser_wait');
      try {
        if (typeof params.ms === 'number' && params.forNavigation !== true) {
          await sleep(Math.max(0, Math.min(15_000, params.ms)));
          return textResult(`Waited ${params.ms}ms.`, { action: 'wait', ok: true });
        }
        const state = await bridge.request<TabState>('waitForLoad');
        return textResult(`Load settled at ${state.url} (${state.title || 'untitled'}).`, {
          action: 'wait',
          ok: true,
          url: state.url,
          title: state.title,
        });
      } catch (err) {
        return errResult('browser_wait', messageOf(err));
      }
    },
  });

  // --- browser_back / browser_forward --------------------------------------
  const history = (name: string, method: 'back' | 'forward', label: string): void => {
    pi.registerTool({
      name,
      label,
      description: `Go ${method} in the browser history, then re-snapshot.`,
      promptSnippet: `Go ${method} in browser history`,
      parameters: Type.Object({}),
      async execute(): Promise<AgentToolResult<BrowserDetails>> {
        if (bridge === null) return unavailable(name);
        try {
          const state = await bridge.request<TabState>(method);
          return textResult(`Went ${method} to ${state.url}.`, {
            action: method,
            ok: true,
            url: state.url,
            title: state.title,
          });
        } catch (err) {
          return errResult(name, messageOf(err));
        }
      },
    });
  };
  history(BROWSER_BACK_TOOL, 'back', 'Browse: Back');
  history(BROWSER_FORWARD_TOOL, 'forward', 'Browse: Forward');

  // --- browser_key ---------------------------------------------------------
  pi.registerTool({
    name: BROWSER_KEY_TOOL,
    label: 'Browse: Key',
    description:
      'Press a single key in the page (Enter, Tab, Escape, ArrowDown, ArrowUp, ArrowLeft, ' +
      'ArrowRight, Backspace, PageDown, PageUp, Home, End). Useful for menus and forms.',
    promptSnippet: 'Press a keyboard key',
    parameters: Type.Object({
      key: Type.String({ description: 'Key name, e.g. Enter, Tab, Escape, ArrowDown.' }),
    }),
    async execute(_id, params): Promise<AgentToolResult<BrowserDetails>> {
      if (bridge === null) return unavailable('browser_key');
      try {
        await bridge.request('key', { key: params.key });
        return textResult(`Pressed ${params.key}.`, { action: 'key', ok: true });
      } catch (err) {
        return errResult('browser_key', messageOf(err));
      }
    },
  });
}
