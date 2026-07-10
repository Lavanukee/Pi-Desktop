/**
 * Injected page scripts the browser-agent bridge runs (via the WebContentsView's
 * `executeJavaScript`) to ACT on and VISUALISE the model's browsing. These live
 * app-side because they are inseparable from the app-owned concerns they serve:
 * the virtual cursor overlay + live-typing indicator, and coordinate/DOM input.
 *
 * They pair with the extension's perception snapshot only through one shared
 * contract: the `data-pi-idx` attribute the snapshot stamps on each indexed
 * element (see @pi-desktop/browser-use `DATA_IDX_ATTR`). Resolving `index →
 * element` by that stamp means acting never trusts stale coordinates — a missing
 * stamp is exactly the stale-index signal the tools re-snapshot on.
 *
 * Each builder returns a self-contained IIFE string (no app globals) that is
 * cleared on navigation and idempotently re-created here, so injection survives
 * page changes. All are defensive: they never throw across executeJavaScript.
 */

/** The stamp shared with the perception snapshot. Keep in sync with
 * @pi-desktop/browser-use `DATA_IDX_ATTR`. */
export const DATA_IDX_ATTR = 'data-pi-idx';

const IDX = DATA_IDX_ATTR;

/** A cursor overlay command. */
export type CursorOp =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'typing'; active: boolean; text?: string }
  | { kind: 'hide' };

/**
 * Ensure the virtual cursor + typing pill exist and apply one command. The
 * overlay sits at the top of the page (pointer-events: none) so it never
 * intercepts real input; movement respects prefers-reduced-motion.
 */
export function cursorCommand(op: CursorOp): string {
  return `(function(){
  try {
    var op = ${JSON.stringify(op)};
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
    var CID = 'pi-agent-cursor', TID = 'pi-agent-typing', RID = 'pi-agent-ring';
    var cur = document.getElementById(CID);
    if (!cur) {
      cur = document.createElement('div');
      cur.id = CID;
      cur.setAttribute('aria-hidden', 'true');
      cur.style.cssText = 'position:fixed;left:-100px;top:-100px;width:22px;height:22px;z-index:2147483647;pointer-events:none;margin:0;padding:0;will-change:left,top;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45));';
      cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"><path d="M3 2 L3 17 L7.2 13.1 L10 19.5 L12.6 18.3 L9.8 12 L15.5 12 Z" fill="#fff" stroke="#1a73e8" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      (document.body || document.documentElement).appendChild(cur);
    }
    cur.style.transition = reduce ? 'none' : 'left 0.28s cubic-bezier(0.22,0.61,0.36,1), top 0.28s cubic-bezier(0.22,0.61,0.36,1)';
    cur.style.display = 'block';

    function pill() {
      var t = document.getElementById(TID);
      if (!t) {
        t = document.createElement('div');
        t.id = TID;
        t.setAttribute('aria-hidden', 'true');
        t.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:600 11px -apple-system,system-ui,sans-serif;color:#fff;background:#1a73e8;border-radius:10px;padding:3px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.3);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;display:none;';
        (document.body || document.documentElement).appendChild(t);
      }
      return t;
    }

    if (op.kind === 'hide') {
      cur.style.display = 'none';
      var th = document.getElementById(TID); if (th) th.style.display = 'none';
      return true;
    }
    if (op.kind === 'move' || op.kind === 'click') {
      cur.style.left = op.x + 'px';
      cur.style.top = op.y + 'px';
      var tp = document.getElementById(TID);
      if (tp && tp.style.display !== 'none') { tp.style.left = (op.x + 16) + 'px'; tp.style.top = (op.y + 18) + 'px'; }
    }
    if (op.kind === 'click') {
      var ring = document.createElement('div');
      ring.id = RID;
      ring.style.cssText = 'position:fixed;left:' + op.x + 'px;top:' + op.y + 'px;width:12px;height:12px;margin:-6px 0 0 -6px;border:2px solid #1a73e8;border-radius:50%;z-index:2147483646;pointer-events:none;opacity:0.9;';
      (document.body || document.documentElement).appendChild(ring);
      if (reduce) { setTimeout(function(){ ring.remove(); }, 220); }
      else {
        ring.style.transition = 'transform 0.4s ease-out, opacity 0.4s ease-out';
        requestAnimationFrame(function(){ ring.style.transform = 'scale(3)'; ring.style.opacity = '0'; });
        setTimeout(function(){ ring.remove(); }, 460);
      }
    }
    if (op.kind === 'typing') {
      var p = pill();
      if (op.active) {
        var label = op.text ? String(op.text).slice(0, 40) : '';
        p.textContent = label ? ('⌨ ' + label) : '⌨ typing…';
        var cl = parseFloat(cur.style.left) || 0, ct = parseFloat(cur.style.top) || 0;
        p.style.left = (cl + 16) + 'px'; p.style.top = (ct + 18) + 'px';
        p.style.display = 'block';
      } else {
        p.style.display = 'none';
      }
    }
    return true;
  } catch (e) { return false; }
})()`;
}

/** Resolve an index to its element, scroll it into view, and return the
 * viewport-centre coordinates (for cursor targeting). `found:false` = stale. */
export function resolveByIndex(index: number): string {
  return `(function(){
  try {
    var el = document.querySelector('[${IDX}="' + ${JSON.stringify(index)} + '"]');
    if (!el) return { found: false };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  } catch (e) { return { found: false }; }
})()`;
}

/** Click an element by index via real DOM events (reliable, no coord math). */
export function domClickByIndex(index: number): string {
  return `(function(){
  try {
    var el = document.querySelector('[${IDX}="' + ${JSON.stringify(index)} + '"]');
    if (!el) return { found: false };
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousemove', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
    try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
    try { el.click(); } catch (e) {}
    return { found: true };
  } catch (e) { return { found: false }; }
})()`;
}

/** Focus an editable element by index and return its centre coordinates. */
export function focusByIndex(index: number): string {
  return `(function(){
  try {
    var el = document.querySelector('[${IDX}="' + ${JSON.stringify(index)} + '"]');
    if (!el) return { found: false };
    var tag = (el.tagName || '').toLowerCase();
    var editable = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
    if (!editable) return { found: false };
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.focus(); } catch (e) {}
    var r = el.getBoundingClientRect();
    return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  } catch (e) { return { found: false }; }
})()`;
}

/**
 * Set an editable element's value to `text` and dispatch `input` (and `change`
 * on the final chunk) using the native value setter so React-controlled inputs
 * update. Called repeatedly with growing substrings for a live-typing effect.
 */
export function setValueByIndex(index: number, text: string, final: boolean): string {
  return `(function(){
  try {
    var el = document.querySelector('[${IDX}="' + ${JSON.stringify(index)} + '"]');
    if (!el) return { found: false };
    var v = ${JSON.stringify(text)};
    if (el.isContentEditable === true) {
      el.textContent = v;
    } else {
      var proto = (el.tagName || '').toLowerCase() === 'textarea'
        ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement && window.HTMLInputElement.prototype;
      var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    }
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    if (${final ? 'true' : 'false'}) {
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    }
    return { found: true };
  } catch (e) { return { found: false }; }
})()`;
}

/** Detect the page's reduced-motion preference (best-effort). */
export const REDUCED_MOTION_SCRIPT =
  "(function(){ try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } })()";
