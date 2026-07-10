import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiffStat } from './activity.tsx';

/**
 * DiffStat zero-omission (jedd round-5 #12): render "+27", "−5", or "+27 −5",
 * but NEVER a zero side ("+0"/"−0"), and nothing at all when both are zero.
 */
describe('DiffStat zero-omission', () => {
  const render = (props: { added?: number; deleted?: number }) =>
    renderToStaticMarkup(<DiffStat {...props} />);

  it('shows only the added side when deleted is zero', () => {
    const html = render({ added: 27, deleted: 0 });
    expect(html).toContain('+27');
    expect(html).not.toContain('−'); // U+2212 minus never rendered
    expect(html).not.toContain('0');
  });

  it('shows only the deleted side when added is zero', () => {
    const html = render({ added: 0, deleted: 5 });
    expect(html).toContain('−5');
    expect(html).not.toContain('+');
  });

  it('shows both sides when both are nonzero', () => {
    const html = render({ added: 27, deleted: 3 });
    expect(html).toContain('+27');
    expect(html).toContain('−3');
  });

  it('renders nothing when both sides are zero', () => {
    expect(render({ added: 0, deleted: 0 })).toBe('');
  });

  it('renders nothing when both sides are absent', () => {
    expect(render({})).toBe('');
  });

  it('omits an undefined side but keeps the present nonzero one', () => {
    const html = render({ added: 27 });
    expect(html).toContain('+27');
    expect(html).not.toContain('−');
  });
});
