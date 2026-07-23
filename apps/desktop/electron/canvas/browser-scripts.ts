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
import {
  AGENT_CURSOR_FILTER,
  AGENT_CURSOR_TIP_X_FRACTION,
  AGENT_CURSOR_TIP_Y_FRACTION,
  AGENT_CURSOR_VIEWBOX_H,
  AGENT_CURSOR_VIEWBOX_W,
  agentCursorSvg,
} from './agent-cursor';

/** The stamp shared with the perception snapshot. Keep in sync with
 * @pi-desktop/browser-use `DATA_IDX_ATTR`. */
export const DATA_IDX_ATTR = 'data-pi-idx';

const IDX = DATA_IDX_ATTR;

/** Browser cursor render width (px). Height keeps the shared glyph aspect. */
const CURSOR_W = 28;
const CURSOR_H = Math.round((CURSOR_W * AGENT_CURSOR_VIEWBOX_H) / AGENT_CURSOR_VIEWBOX_W);
/** The pointing nose within the rendered glyph (px). A negative margin shifts
 * the element so its nose sits at the div's (left, top) — then positioning at
 * (op.x, op.y) lands the nose on the target while pill math stays target-relative. */
const NOSE_X = +(AGENT_CURSOR_TIP_X_FRACTION * CURSOR_W).toFixed(1);
const NOSE_Y = +(AGENT_CURSOR_TIP_Y_FRACTION * CURSOR_H).toFixed(1);
const NOSE_ORIGIN = `${Math.round(AGENT_CURSOR_TIP_X_FRACTION * 100)}% ${Math.round(AGENT_CURSOR_TIP_Y_FRACTION * 100)}%`;

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
      cur.style.cssText = 'position:fixed;left:-100px;top:-100px;width:${CURSOR_W}px;height:${CURSOR_H}px;z-index:2147483647;pointer-events:none;margin:${-NOSE_Y}px 0 0 ${-NOSE_X}px;padding:0;opacity:0;transform-origin:${NOSE_ORIGIN};will-change:left,top,transform,opacity;filter:${AGENT_CURSOR_FILTER};';
      cur.innerHTML = ${JSON.stringify(agentCursorSvg(CURSOR_W))};
      (document.body || document.documentElement).appendChild(cur);
    }
    // Ease to the target position (both axes), and lightly spring the press +
    // fade-in so the persistent overlay reads as a real, moving pointer.
    cur.style.transition = reduce ? 'none' : 'left 0.32s cubic-bezier(0.22,0.61,0.36,1), top 0.32s cubic-bezier(0.22,0.61,0.36,1), transform 0.16s ease-out, opacity 0.2s ease-out';
    cur.style.display = 'block';
    cur.style.opacity = '1';

    function pill() {
      var t = document.getElementById(TID);
      if (!t) {
        t = document.createElement('div');
        t.id = TID;
        t.setAttribute('aria-hidden', 'true');
        t.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:600 11px -apple-system,system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,rgba(63,82,172,0.95),rgba(96,58,186,0.95));border:1px solid rgba(255,255,255,0.28);border-radius:999px;padding:4px 10px;box-shadow:0 3px 12px rgba(18,22,76,0.4),0 0 18px rgba(99,88,255,0.3),inset 0 1px 0 rgba(255,255,255,0.2);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;display:none;';
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
      if (tp && tp.style.display !== 'none') { tp.style.left = (op.x + 20) + 'px'; tp.style.top = (op.y + 28) + 'px'; }
    }
    if (op.kind === 'click') {
      // Tactile press: dip the cursor toward its tip, then spring back.
      if (!reduce) {
        cur.style.transform = 'scale(0.82)';
        setTimeout(function(){ cur.style.transform = 'scale(1)'; }, 140);
      }
      // Expanding pulse ring centred on the click point.
      var ring = document.createElement('div');
      ring.id = RID;
      ring.style.cssText = 'position:fixed;left:' + op.x + 'px;top:' + op.y + 'px;width:16px;height:16px;margin:-8px 0 0 -8px;border:2.5px solid rgba(122,108,255,0.95);border-radius:50%;z-index:2147483646;pointer-events:none;opacity:0.95;box-shadow:0 0 12px rgba(79,125,255,0.6),inset 0 0 6px rgba(123,63,242,0.35);';
      (document.body || document.documentElement).appendChild(ring);
      if (reduce) { setTimeout(function(){ ring.remove(); }, 220); }
      else {
        ring.style.transition = 'transform 0.45s cubic-bezier(0.16,0.84,0.44,1), opacity 0.45s ease-out';
        requestAnimationFrame(function(){ ring.style.transform = 'scale(3.4)'; ring.style.opacity = '0'; });
        setTimeout(function(){ ring.remove(); }, 500);
      }
    }
    if (op.kind === 'typing') {
      var p = pill();
      if (op.active) {
        var label = op.text ? String(op.text).slice(0, 40) : '';
        p.textContent = label ? ('⌨ ' + label) : '⌨ typing…';
        var cl = parseFloat(cur.style.left) || 0, ct = parseFloat(cur.style.top) || 0;
        p.style.left = (cl + 20) + 'px'; p.style.top = (ct + 28) + 'px';
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
