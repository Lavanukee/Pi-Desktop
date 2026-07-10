/**
 * The model's efficient view of a page.
 *
 * `collectSnapshot(win)` walks the DOM once and returns a COMPACT, INDEXED list
 * of interactive + salient elements plus a short page summary — NOT full HTML.
 * This is the perception strategy ported from RemotePi's `extractInteractives`
 * (subagents/browser/perception.js), hardened for real pages:
 *   - viewport-prioritised + hard-capped (default 60) so payloads stay nimble,
 *   - accessible-name approximation with sensible truncation,
 *   - each returned element is STAMPED with a `data-pi-idx` attribute so the
 *     app's action scripts resolve `index → element` with zero coordinate math
 *     and survive re-query (stale-index detection falls out of a missing stamp),
 *   - WebGL/`<canvas>`-heavy detection so the tool set can prefer coordinate
 *     clicks there.
 *
 * The same function is (a) unit-tested directly against a jsdom document and
 * (b) shipped to the live page by `String()`-ing it into an executeJavaScript
 * payload (see {@link PERCEPTION_SCRIPT}). To keep the string self-contained it
 * takes the window as a parameter, nests every helper, and avoids spreads /
 * async so a transpiler can never hoist a helper reference out of the body.
 *
 * Full `document.documentElement.outerHTML` (browser-manager `snapshotDom`)
 * stays the LAST-RESORT fallback — this structured view is the default.
 */

/** One indexed element as the model sees it. */
export interface SnapshotElement {
  /** 1-based, stable only within a single snapshot (re-stamped each call). */
  index: number;
  /** ARIA role or an implicit role derived from the tag. */
  role: string;
  /** Accessible-name approximation, whitespace-collapsed + truncated. */
  name: string;
  /** Viewport-relative CSS-pixel box (matches sendInputEvent coordinates). */
  bbox: { x: number; y: number; w: number; h: number };
  /** True for inputs/textareas/contenteditable/select. */
  editable?: boolean;
  /** Absolute href for links. */
  href?: string;
  /** Current value for form fields (truncated). */
  value?: string;
  /** Whether the element intersects the current viewport. */
  inViewport: boolean;
}

/** The page summary that rides alongside the element list. */
export interface SnapshotSummary {
  title: string;
  url: string;
  /** First few heading texts (h1–h3), truncated. */
  headings: string[];
  /** Present landmark roles (main/nav/header/footer/aside/form/search/dialog). */
  landmarks: string[];
  scrollY: number;
  maxScrollY: number;
  atBottom: boolean;
  /** Interactive elements found before the cap. */
  elementCount: number;
  /** True when the list was capped (more elements exist). */
  truncated: boolean;
  /** A large `<canvas>` dominates the viewport (WebGL app) → prefer coord clicks. */
  canvasHeavy: boolean;
}

export interface PageSnapshot {
  ok: true;
  elements: SnapshotElement[];
  summary: SnapshotSummary;
}

/** Default element cap — enough to act, small enough to stay cheap. */
export const DEFAULT_ELEMENT_CAP = 60;
/** Accessible-name truncation. */
export const NAME_MAX = 100;

// --- structural DOM slice (keeps this a Node package; no `dom` lib needed) ---

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}
interface PageEl {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): Rect;
  querySelectorAll(selector: string): ArrayLike<PageEl>;
  value?: string;
  type?: string;
  placeholder?: string;
  href?: string;
  disabled?: boolean;
  innerText?: string;
}
interface PageStyle {
  visibility: string;
  display: string;
  opacity: string;
}
interface PageDoc {
  title: string;
  documentElement: { scrollHeight: number; clientHeight: number };
  querySelectorAll(selector: string): ArrayLike<PageEl>;
}
interface PageWin {
  document: PageDoc;
  location: { href: string };
  innerWidth: number;
  innerHeight: number;
  scrollX: number;
  scrollY: number;
  getComputedStyle(el: PageEl): PageStyle;
}

/**
 * Walk `win`'s DOM and return the indexed element list + page summary. Runs in
 * the page (via executeJavaScript) and in tests (called directly). Self-
 * contained: nothing outside this function body is referenced.
 */
export function collectSnapshot(win: PageWin, cap: number): PageSnapshot {
  const INTERACTIVE_SEL = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    'label',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[role="slider"]',
    '[onclick]',
    '[tabindex]',
  ].join(',');
  const IDX_ATTR = 'data-pi-idx';
  // Inlined (not the module-level NAME_MAX): this function is serialised to a
  // string and must not reference anything outside its own body.
  const NAME_MAX = 100;
  const doc = win.document;
  const vw = win.innerWidth || 1280;
  const vh = win.innerHeight || 800;

  function clean(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
  function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  function tag(el: PageEl): string {
    return (el.tagName || '').toLowerCase();
  }
  function attr(el: PageEl, name: string): string {
    const v = el.getAttribute(name);
    return v === null ? '' : v;
  }
  function implicitRole(el: PageEl): string {
    const explicit = attr(el, 'role');
    if (explicit !== '') return explicit;
    const t = tag(el);
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'label') return 'label';
    if (t === 'input') {
      const it = (el.type || 'text').toLowerCase();
      if (it === 'checkbox') return 'checkbox';
      if (it === 'radio') return 'radio';
      if (it === 'submit' || it === 'button' || it === 'reset') return 'button';
      if (it === 'search') return 'searchbox';
      if (it === 'range') return 'slider';
      return 'textbox';
    }
    return t;
  }
  function isEditable(el: PageEl): boolean {
    const t = tag(el);
    if (t === 'textarea' || t === 'select') return true;
    if (attr(el, 'contenteditable') === 'true') return true;
    if (t === 'input') {
      const it = (el.type || 'text').toLowerCase();
      return (
        it !== 'checkbox' && it !== 'radio' && it !== 'button' && it !== 'submit' && it !== 'reset'
      );
    }
    return false;
  }
  function accessibleName(el: PageEl): string {
    const aria = clean(attr(el, 'aria-label'));
    if (aria !== '') return aria;
    const alt = clean(attr(el, 'alt'));
    if (alt !== '') return alt;
    const title = clean(attr(el, 'title'));
    const ph = clean(attr(el, 'placeholder') || el.placeholder || '');
    const t = tag(el);
    if (t === 'input' || t === 'textarea' || t === 'select') {
      const val = clean(el.value || '');
      if (ph !== '') return ph;
      if (val !== '') return val;
      if (title !== '') return title;
      const nm = clean(attr(el, 'name'));
      return nm !== '' ? nm : el.type || t;
    }
    const text = clean(el.innerText || el.textContent || '');
    if (text !== '') return text;
    if (title !== '') return title;
    if (ph !== '') return ph;
    return '';
  }
  function visible(el: PageEl, r: Rect): boolean {
    if (r.width <= 1 || r.height <= 1) return false;
    if (el.disabled === true) return false;
    const style = win.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
    // Drop elements parked far off-screen (lazy carousels, hidden menus).
    if (r.bottom < -vh || r.top > vh * 2) return false;
    if (r.right < -vw || r.left > vw * 2) return false;
    return true;
  }

  // Clear stale stamps from a previous snapshot so indices never collide.
  const prior = doc.querySelectorAll(`[${IDX_ATTR}]`);
  for (let i = 0; i < prior.length; i++) {
    const el = prior[i];
    if (el) el.removeAttribute(IDX_ATTR);
  }

  interface Cand {
    el: PageEl;
    role: string;
    name: string;
    r: Rect;
    editable: boolean;
    href: string;
    value: string;
    inViewport: boolean;
  }
  const cands: Cand[] = [];
  const seen: PageEl[] = [];
  const nodes = doc.querySelectorAll(INTERACTIVE_SEL);
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (!el) continue;
    let dup = false;
    for (let j = 0; j < seen.length; j++) {
      if (seen[j] === el) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    seen.push(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const name = accessibleName(el);
    const role = implicitRole(el);
    // Drop nameless non-form controls (pure spacers/icons w/o labels) — a form
    // field with no name is still keepable (you can type into it).
    const editable = isEditable(el);
    if (name === '' && !editable) continue;
    const href = tag(el) === 'a' ? el.href || attr(el, 'href') : '';
    const value = editable ? clean(el.value || '') : '';
    const inViewport = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    cands.push({ el, role, name: truncate(name, NAME_MAX), r, editable, href, value, inViewport });
  }

  // Viewport-first, then document order (top→bottom, left→right).
  cands.sort((a, b) => {
    if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
    if (Math.abs(a.r.top - b.r.top) > 4) return a.r.top - b.r.top;
    return a.r.left - b.r.left;
  });

  const total = cands.length;
  const limit = cap > 0 ? cap : total;
  const elements: SnapshotElement[] = [];
  for (let i = 0; i < cands.length && i < limit; i++) {
    const c = cands[i];
    if (!c) continue;
    const index = i + 1;
    c.el.setAttribute(IDX_ATTR, String(index));
    const el: SnapshotElement = {
      index,
      role: c.role,
      name: c.name,
      bbox: {
        x: Math.round(c.r.left + c.r.width / 2),
        y: Math.round(c.r.top + c.r.height / 2),
        w: Math.round(c.r.width),
        h: Math.round(c.r.height),
      },
      inViewport: c.inViewport,
    };
    if (c.editable) el.editable = true;
    if (c.href !== '') el.href = c.href;
    if (c.value !== '') el.value = truncate(c.value, NAME_MAX);
    elements.push(el);
  }

  // --- summary -------------------------------------------------------------
  const headings: string[] = [];
  const hNodes = doc.querySelectorAll('h1,h2,h3');
  for (let i = 0; i < hNodes.length && headings.length < 8; i++) {
    const el = hNodes[i];
    if (!el) continue;
    const text = clean(el.innerText || el.textContent || '');
    if (text !== '') headings.push(truncate(text, 80));
  }
  const landmarks: string[] = [];
  const LM: Array<[string, string]> = [
    ['main,[role="main"]', 'main'],
    ['nav,[role="navigation"]', 'nav'],
    ['header,[role="banner"]', 'header'],
    ['footer,[role="contentinfo"]', 'footer'],
    ['aside,[role="complementary"]', 'aside'],
    ['form,[role="form"]', 'form'],
    ['[role="search"]', 'search'],
    ['[role="dialog"],dialog[open]', 'dialog'],
  ];
  for (let i = 0; i < LM.length; i++) {
    const pair = LM[i];
    if (!pair) continue;
    if (doc.querySelectorAll(pair[0]).length > 0) landmarks.push(pair[1]);
  }

  let canvasHeavy = false;
  const canvases = doc.querySelectorAll('canvas');
  const viewportArea = vw * vh;
  let canvasArea = 0;
  for (let i = 0; i < canvases.length; i++) {
    const el = canvases[i];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = w * h;
    canvasArea += area;
    if (viewportArea > 0 && area / viewportArea > 0.5) canvasHeavy = true;
  }
  if (viewportArea > 0 && canvasArea / viewportArea > 0.6) canvasHeavy = true;

  const scrollY = Math.round(win.scrollY || 0);
  const maxScrollY = Math.max(
    0,
    doc.documentElement.scrollHeight - doc.documentElement.clientHeight,
  );
  return {
    ok: true,
    elements,
    summary: {
      title: doc.title || '',
      url: win.location.href,
      headings,
      landmarks,
      scrollY,
      maxScrollY: Math.round(maxScrollY),
      atBottom: scrollY >= maxScrollY - 2,
      elementCount: total,
      truncated: total > elements.length,
      canvasHeavy,
    },
  };
}

/**
 * The executeJavaScript payload: `collectSnapshot` serialised and invoked with
 * the live `window`. Built once at module load; the cap is baked in.
 */
export function perceptionScript(cap: number = DEFAULT_ELEMENT_CAP): string {
  return `(${collectSnapshot.toString()})(window, ${JSON.stringify(cap)})`;
}

/** A scroll payload: scroll the page and report the new position. Directions
 * map to a viewport-fraction step; `to` jumps to an edge. */
export function scrollScript(
  direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom',
  amount?: number,
): string {
  const dir = JSON.stringify(direction);
  const amt = JSON.stringify(amount ?? null);
  function scrollImpl(win: PageWin, d: string, a: number | null): unknown {
    const doc = win.document;
    const stepY = a === null ? Math.round(win.innerHeight * 0.85) : a;
    const stepX = a === null ? Math.round(win.innerWidth * 0.85) : a;
    const w = win as unknown as {
      scrollBy(x: number, y: number): void;
      scrollTo(x: number, y: number): void;
    };
    if (d === 'down') w.scrollBy(0, stepY);
    else if (d === 'up') w.scrollBy(0, -stepY);
    else if (d === 'right') w.scrollBy(stepX, 0);
    else if (d === 'left') w.scrollBy(-stepX, 0);
    else if (d === 'top') w.scrollTo(0, 0);
    else if (d === 'bottom') w.scrollTo(0, doc.documentElement.scrollHeight);
    const scrollY = Math.round(win.scrollY || 0);
    const maxScrollY = Math.max(
      0,
      doc.documentElement.scrollHeight - doc.documentElement.clientHeight,
    );
    return { scrollY, maxScrollY: Math.round(maxScrollY), atBottom: scrollY >= maxScrollY - 2 };
  }
  return `(${scrollImpl.toString()})(window, ${dir}, ${amt})`;
}

/** A readable-text payload: readability-lite. Prefers `main`/`article`, falls
 * back to `body`, collapses whitespace, and caps length. */
export function readScript(selector: string | undefined, maxChars: number): string {
  const sel = JSON.stringify(selector ?? null);
  const max = JSON.stringify(maxChars);
  function readImpl(win: PageWin, s: string | null, limit: number): unknown {
    const doc = win.document as unknown as {
      querySelector(q: string): PageEl | null;
      title: string;
    };
    function pick(): PageEl | null {
      if (s !== null) return doc.querySelector(s);
      const main = doc.querySelector('main') || doc.querySelector('[role="main"]');
      if (main) return main;
      const article = doc.querySelector('article');
      if (article) return article;
      return doc.querySelector('body');
    }
    const el = pick();
    if (!el) return { ok: false, error: s !== null ? `no element matches ${s}` : 'no body' };
    const raw = el.innerText || el.textContent || '';
    const text = raw
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const truncated = text.length > limit;
    return {
      ok: true,
      title: doc.title || '',
      text: truncated ? text.slice(0, limit) : text,
      truncated,
    };
  }
  return `(${readImpl.toString()})(window, ${sel}, ${max})`;
}
