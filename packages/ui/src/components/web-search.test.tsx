import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type WebSearchResultData, WebSearchResults } from './web-search.tsx';

/**
 * The search step body must render a real result list — title + url + snippet —
 * and a labelled EMPTY STATE (never a blank dead-end) when there are no results.
 */

const rows: WebSearchResultData[] = [
  {
    title: 'Example Domain',
    url: 'https://www.example.com/',
    domain: 'example.com',
    snippet: 'This domain is for use in illustrative examples in documents.',
  },
  {
    title: 'example.com - Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Example.com',
    domain: 'en.wikipedia.org',
    snippet: 'The domain names example.com, example.net and example.org are reserved.',
  },
];

describe('WebSearchResults', () => {
  it('renders each row with its title, url (href), domain, and snippet', () => {
    const html = renderToStaticMarkup(<WebSearchResults query="example" results={rows} />);
    expect(html).toContain('Example Domain');
    expect(html).toContain('example.com - Wikipedia');
    // url is the anchor href (and title attr) so the row links to the result
    expect(html).toContain('href="https://www.example.com/"');
    expect(html).toContain('example.com'); // domain label
    expect(html).toContain('This domain is for use in illustrative examples'); // snippet
    expect(html).toContain('pd-websearch-snippet');
    // header count reflects the number of results
    expect(html).toContain('2 results');
  });

  it('singularises the header count for one result', () => {
    const html = renderToStaticMarkup(<WebSearchResults query="q" results={rows.slice(0, 1)} />);
    expect(html).toContain('1 result');
    expect(html).not.toContain('1 results');
  });

  it('shows a clear empty state (not a blank list) when there are no results', () => {
    const html = renderToStaticMarkup(<WebSearchResults query="nothing" results={[]} />);
    expect(html).toContain('pd-websearch-empty');
    expect(html).toContain('No results found');
    expect(html).toContain('Try rephrasing'); // default hint
    expect(html).not.toContain('pd-websearch-list'); // the scrollable list is not rendered
    expect(html).toContain('0 results');
  });

  it('surfaces a backend note as the empty-state hint (e.g. rate-limited)', () => {
    const html = renderToStaticMarkup(
      <WebSearchResults
        query="q"
        results={[]}
        emptyHint="DuckDuckGo may be rate-limiting requests."
      />,
    );
    expect(html).toContain('DuckDuckGo may be rate-limiting requests.');
    expect(html).not.toContain('Try rephrasing');
  });

  it('falls back to a domain-initial chip when a favicon is absent', () => {
    const html = renderToStaticMarkup(<WebSearchResults query="q" results={rows.slice(0, 1)} />);
    expect(html).toContain('pd-websearch-favicon-chip');
    expect(html).toContain('E'); // initial of example.com
  });
});
