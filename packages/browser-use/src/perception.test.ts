import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  collectSnapshot,
  DEFAULT_ELEMENT_CAP,
  perceptionScript,
  readScript,
  scrollScript,
} from './perception.js';

/**
 * jsdom has no layout engine, so getBoundingClientRect returns zeros. We
 * monkeypatch it to read a `data-rect="left,top,w,h"` attribute (default: an
 * off-screen zero box, i.e. invisible) so tests control geometry precisely.
 */
function makeWindow(body: string, opts?: { url?: string; title?: string }): Window {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${opts?.title ?? 'Test'}</title></head><body>${body}</body></html>`,
    { url: opts?.url ?? 'https://example.test/page' },
  );
  const win = dom.window as unknown as Window & { HTMLElement: typeof HTMLElement };
  win.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const raw = this.getAttribute('data-rect');
    const [l, t, w, h] = (raw ?? '0,0,0,0').split(',').map(Number) as [
      number,
      number,
      number,
      number,
    ];
    return {
      left: l,
      top: t,
      width: w,
      height: h,
      right: l + w,
      bottom: t + h,
      x: l,
      y: t,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return win as unknown as Window;
}

// Cast helper: collectSnapshot takes the structural PageWin; a real Window fits.
// biome-ignore lint/suspicious/noExplicitAny: bridging the structural DOM slice to jsdom's Window in tests.
const snap = (win: Window, cap = DEFAULT_ELEMENT_CAP) => collectSnapshot(win as any, cap);

describe('collectSnapshot', () => {
  it('returns an indexed list of visible interactive elements with the expected shape', () => {
    const win = makeWindow(`
      <a href="/about" data-rect="10,20,100,30">About us</a>
      <button data-rect="10,60,80,30">Submit</button>
      <input type="text" placeholder="Email" data-rect="10,100,200,30" value="hi@x.co" />
      <span data-rect="10,200,50,20">not interactive</span>
      <button data-rect="0,0,0,0">invisible</button>
    `);
    const result = snap(win);
    // The 3 visible interactives, not the span or the zero-size button.
    expect(result.elements).toHaveLength(3);

    const link = result.elements[0];
    expect(link).toMatchObject({ index: 1, role: 'link', name: 'About us' });
    expect(link?.href).toContain('/about');
    expect(link?.bbox).toEqual({ x: 60, y: 35, w: 100, h: 30 });

    const button = result.elements.find((e) => e.role === 'button');
    expect(button?.name).toBe('Submit');

    const input = result.elements.find((e) => e.editable);
    expect(input).toMatchObject({
      role: 'textbox',
      editable: true,
      name: 'Email',
      value: 'hi@x.co',
    });
  });

  it('stamps data-pi-idx on each returned element and clears stale stamps', () => {
    const win = makeWindow(`
      <button data-rect="10,10,80,30">One</button>
      <button data-rect="10,50,80,30">Two</button>
    `);
    const first = snap(win);
    const buttons = win.document.querySelectorAll('button');
    expect(buttons[0]?.getAttribute('data-pi-idx')).toBe(String(first.elements[0]?.index));

    // Remove the first button, re-snapshot: indices renumber and no stale stamp lingers.
    buttons[0]?.remove();
    const second = snap(win);
    expect(second.elements).toHaveLength(1);
    expect(second.elements[0]?.index).toBe(1);
    expect(win.document.querySelectorAll('[data-pi-idx]')).toHaveLength(1);
  });

  it('prioritises in-viewport elements and caps the list', () => {
    // innerHeight default 768; put one below the fold (but within the retained
    // band, ~2x viewport — elements parked much further off-screen are culled).
    const win = makeWindow(`
      <button data-rect="10,1000,80,30">below</button>
      <button data-rect="10,40,80,30">above</button>
    `);
    const result = snap(win, 60);
    expect(result.elements[0]?.name).toBe('above');
    expect(result.elements[0]?.inViewport).toBe(true);
    expect(result.elements[1]?.inViewport).toBe(false);

    const many = Array.from(
      { length: 10 },
      (_v, i) => `<button data-rect="10,${i * 5},80,4">b${i}</button>`,
    ).join('');
    const capped = snap(makeWindow(many), 3);
    expect(capped.elements).toHaveLength(3);
    expect(capped.summary.elementCount).toBe(10);
    expect(capped.summary.truncated).toBe(true);
  });

  it('summarises title, headings, landmarks', () => {
    const win = makeWindow(
      `<main><nav data-rect="0,0,10,10"></nav><h1 data-rect="0,0,10,10">Welcome</h1>
       <h2 data-rect="0,0,10,10">Section</h2><form data-rect="0,0,10,10"></form></main>`,
      { title: 'Home', url: 'https://site.test/home' },
    );
    const result = snap(win);
    expect(result.summary.title).toBe('Home');
    expect(result.summary.url).toBe('https://site.test/home');
    expect(result.summary.headings).toEqual(['Welcome', 'Section']);
    expect(result.summary.landmarks).toEqual(expect.arrayContaining(['main', 'nav', 'form']));
  });

  it('detects a canvas/WebGL-heavy page', () => {
    // A canvas covering most of the 1024x768 viewport.
    const heavy = snap(makeWindow('<canvas data-rect="0,0,1024,760"></canvas>'));
    expect(heavy.summary.canvasHeavy).toBe(true);

    const light = snap(makeWindow('<canvas data-rect="0,0,100,80"></canvas>'));
    expect(light.summary.canvasHeavy).toBe(false);
  });

  it('runs correctly when serialised into an executeJavaScript string', () => {
    const win = makeWindow('<button data-rect="10,10,80,30">Go</button>');
    const script = perceptionScript(60);
    // Emulate executeJavaScript(script): the string is `(fn)(window, cap)`.
    const runner = new Function('window', `return ${script};`) as (w: Window) => unknown;
    const result = runner(win) as ReturnType<typeof snap>;
    expect(result.ok).toBe(true);
    expect(result.elements[0]).toMatchObject({ index: 1, role: 'button', name: 'Go' });
  });
});

describe('scrollScript', () => {
  it('produces a runnable payload that scrolls and reports position', () => {
    const win = makeWindow('<div>content</div>');
    let scrolledBy = 0;
    (win as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy = (
      _x: number,
      y: number,
    ) => {
      scrolledBy += y;
    };
    const script = scrollScript('down');
    const runner = new Function('window', `return ${script};`) as (w: Window) => {
      scrollY: number;
    };
    const res = runner(win);
    expect(scrolledBy).toBeGreaterThan(0);
    expect(res).toHaveProperty('atBottom');
  });
});

describe('readScript', () => {
  it('extracts readable text, preferring main and capping length', () => {
    const win = makeWindow('<main>Hello world. This is the body.</main><footer>junk</footer>');
    const script = readScript(undefined, 8000);
    const runner = new Function('window', `return ${script};`) as (w: Window) => {
      ok: boolean;
      text: string;
    };
    const res = runner(win);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Hello world');
    expect(res.text).not.toContain('junk');
  });

  it('reports an error when a selector matches nothing', () => {
    const win = makeWindow('<div>x</div>');
    const script = readScript('.nope', 8000);
    const runner = new Function('window', `return ${script};`) as (w: Window) => { ok: boolean };
    expect(runner(win).ok).toBe(false);
  });
});
