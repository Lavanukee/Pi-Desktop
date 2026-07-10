import { beforeEach, describe, expect, it } from 'vitest';
import { applyHtmlPatch } from './patcher.ts';

function makeRoot(): HTMLElement {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  if (!root) throw new Error('root missing');
  return root;
}

describe('applyHtmlPatch — no-reload interactivity', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it("preserves a focused input's value, focus, and caret across a patch that rewrites surrounding markup", () => {
    const root = makeRoot();
    applyHtmlPatch(root, '<h1>Title A</h1><input id="name" type="text"><p>a</p>');

    const input = root.querySelector<HTMLInputElement>('#name');
    if (!input) throw new Error('input missing');
    input.focus();
    input.value = 'hello';
    input.setSelectionRange(2, 2);
    expect(document.activeElement).toBe(input);

    // A streaming delta rewrites the heading and paragraph but not the input.
    applyHtmlPatch(root, '<h1>Title B (changed)</h1><input id="name" type="text"><p>b c d</p>');

    const after = root.querySelector<HTMLInputElement>('#name');
    // Same DOM node — morphed in place, never replaced (the substrate of no-reload).
    expect(after).toBe(input);
    expect(root.querySelector('h1')?.textContent).toBe('Title B (changed)');
    expect(root.querySelector('p')?.textContent).toBe('b c d');
    // User's in-progress state survived the patch.
    expect(after?.value).toBe('hello');
    expect(document.activeElement).toBe(after);
    expect(after?.selectionStart).toBe(2);
  });

  it('preserves live JS state held on a morphed node (running-script substrate)', () => {
    const root = makeRoot();
    applyHtmlPatch(root, '<div id="live">start</div><span>x</span>');

    // Simulate state a running script attached to a live node (e.g. a game loop
    // storing data on the element) — this must survive a DOM patch, no reload.
    const live = root.querySelector('#live') as HTMLElement & { __state?: number };
    live.__state = 42;

    applyHtmlPatch(root, '<div id="live">changed</div><span>y</span><b>new</b>');

    const after = root.querySelector('#live') as HTMLElement & { __state?: number };
    expect(after).toBe(live); // identity preserved
    expect(after.__state).toBe(42); // live JS state preserved
    expect(after.textContent).toBe('changed'); // content still patched
    expect(root.querySelector('b')?.textContent).toBe('new');
  });

  it('flattens a full HTML document into the mount (keeps head styles + body)', () => {
    const root = makeRoot();
    applyHtmlPatch(
      root,
      '<!doctype html><html><head><style>.x{color:red}</style></head><body><h1 id="t">hi</h1></body></html>',
    );
    expect(root.querySelector('#t')?.textContent).toBe('hi');
    expect(root.querySelector('style')?.textContent).toContain('.x');
  });

  it('preserves a checked checkbox the user toggled', () => {
    const root = makeRoot();
    applyHtmlPatch(root, '<label>ok</label><input id="c" type="checkbox">');
    const box = root.querySelector<HTMLInputElement>('#c');
    if (!box) throw new Error('checkbox missing');
    box.focus();
    box.checked = true;

    applyHtmlPatch(root, '<label>ok now</label><input id="c" type="checkbox">');
    expect(root.querySelector<HTMLInputElement>('#c')?.checked).toBe(true);
  });
});
