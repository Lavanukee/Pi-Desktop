import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CollapsibleSearch } from './input.tsx';

/**
 * CollapsibleSearch (jedd round-8 #2): a compact glass+label button that expands
 * into a live search input in place. Expansion is driven by the `expanded` /
 * `defaultExpanded` props, so both ends of the collapse/expand swap are asserted
 * through static markup (the repo's jsdom-free rendering convention).
 */
describe('CollapsibleSearch expand/collapse', () => {
  const noop = () => {};

  it('collapsed: renders the compact glass+label button and no live input', () => {
    const html = renderToStaticMarkup(<CollapsibleSearch value="" onChange={noop} />);
    expect(html).toContain('pd-collapsible-search--collapsed');
    expect(html).toContain('<button');
    // The magnifying glass stays visible while collapsed.
    expect(html).toContain('pd-collapsible-search-icon');
    // Default "Search chats" label; the input is NOT rendered yet.
    expect(html).toContain('Search chats');
    expect(html).not.toContain('<input');
  });

  it('collapsed: uses a custom placeholder as the label', () => {
    const html = renderToStaticMarkup(
      <CollapsibleSearch value="" placeholder="Find projects" onChange={noop} />,
    );
    expect(html).toContain('Find projects');
    expect(html).not.toContain('Search chats');
  });

  it('expanded (controlled): renders the live search input with placeholder + value', () => {
    const html = renderToStaticMarkup(
      <CollapsibleSearch value="hello" expanded onChange={noop} placeholder="Search chats" />,
    );
    expect(html).toContain('pd-collapsible-search--expanded');
    expect(html).toContain('<input');
    expect(html).toContain('type="search"');
    expect(html).toContain('value="hello"');
    expect(html).toContain('placeholder="Search chats"');
    // Leading glass persists in the expanded field too.
    expect(html).toContain('pd-search-field-icon');
    // The collapsed button is gone once expanded.
    expect(html).not.toContain('<button');
  });

  it('defaultExpanded opens the field for the uncontrolled case', () => {
    const html = renderToStaticMarkup(
      <CollapsibleSearch value="" defaultExpanded onChange={noop} />,
    );
    expect(html).toContain('pd-collapsible-search--expanded');
    expect(html).toContain('<input');
  });
});
