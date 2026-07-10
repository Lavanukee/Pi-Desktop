import { describe, expect, it } from 'vitest';
import { sanitizeHtmlStatic, sanitizeSvg } from './sanitize.ts';

describe('sanitizeSvg (inline-into-app trust boundary)', () => {
  it('strips <script> but keeps drawing elements', () => {
    const out = sanitizeSvg(
      '<svg><script>alert(1)</script><circle cx="5" cy="5" r="4"></circle></svg>',
    );
    expect(out).toContain('circle');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
  });

  it('strips event-handler attributes', () => {
    const out = sanitizeSvg('<svg onload="alert(1)"><path d="M0 0 L10 10"></path></svg>');
    expect(out.toLowerCase()).not.toContain('onload');
    expect(out).toContain('path');
  });

  it('strips foreignObject (HTML smuggling vector)', () => {
    const out = sanitizeSvg('<svg><foreignObject><script>x</script></foreignObject></svg>');
    expect(out.toLowerCase()).not.toContain('foreignobject');
    expect(out).not.toContain('script');
  });

  it('progressively sanitizes an incomplete SVG mid-stream without throwing', () => {
    const partial = '<svg viewBox="0 0 10 10"><path d="M0 0 L5 5"';
    const out = sanitizeSvg(partial);
    expect(typeof out).toBe('string');
    expect(out).not.toContain('script');
  });
});

describe('sanitizeHtmlStatic (non-sandboxed HTML trust boundary)', () => {
  it('strips <script> and inline handlers, keeps content', () => {
    const out = sanitizeHtmlStatic(
      '<div><img src="x" onerror="alert(1)"><script>alert(2)</script>hi</div>',
    );
    expect(out).toContain('hi');
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
  });

  it('drops javascript: URLs', () => {
    const out = sanitizeHtmlStatic('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
  });
});
