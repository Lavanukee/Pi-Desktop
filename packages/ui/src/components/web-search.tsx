import { clsx } from 'clsx';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import { forwardRef, useState } from 'react';
import { IconGlobe } from './icons.tsx';

/*
 * Web-search result list (THEME 3, match img13/14). Header = globe + query +
 * "N results" (right); body = a bordered, rounded, scrollable list of result
 * cards — favicon + title, source host, and a two-line snippet — each linking to
 * its URL. Favicons that fail / are absent fall back to a letter chip built from
 * the domain initial, so the list renders identically offline (and in the
 * screenshot harness). An empty result set renders a labelled empty state (never
 * a blank dead-end): the caller's `emptyHint` explains why (e.g. rate-limited).
 */

export interface WebSearchResultData {
  title: string;
  url?: string;
  /** Displayed on the right, muted (e.g. "developer.mozilla.org"). */
  domain?: string;
  /** One-to-two line description under the title. */
  snippet?: string;
  /** Optional favicon; on load error the row falls back to a letter chip. */
  faviconUrl?: string;
}

function domainInitial(row: WebSearchResultData): string {
  const src = (row.domain ?? row.url ?? row.title ?? '').replace(/^https?:\/\//, '');
  const ch = src
    .replace(/^www\./, '')
    .trim()
    .charAt(0);
  return ch ? ch.toUpperCase() : '#';
}

export interface WebSearchResultItemProps extends Omit<HTMLAttributes<HTMLElement>, 'onSelect'> {
  result: WebSearchResultData;
  onSelect?: (result: WebSearchResultData) => void;
}

/** One favicon + title + domain + snippet row. Renders as a link if `url` is present. */
export const WebSearchResultItem = forwardRef<HTMLElement, WebSearchResultItemProps>(
  function WebSearchResultItem({ result, onSelect, className, ...rest }, ref) {
    const [broken, setBroken] = useState(false);
    const showImg = result.faviconUrl !== undefined && !broken;
    const favicon = showImg ? (
      <img
        className="pd-websearch-favicon-img"
        src={result.faviconUrl}
        alt=""
        onError={() => setBroken(true)}
      />
    ) : (
      <span className="pd-websearch-favicon-chip">{domainInitial(result)}</span>
    );
    const inner = (
      <>
        <span className="pd-websearch-favicon">{favicon}</span>
        <span className="pd-websearch-main">
          <span className="pd-websearch-headline">
            <span className="pd-websearch-title">{result.title}</span>
            {result.domain !== undefined ? (
              <span className="pd-websearch-domain">{result.domain}</span>
            ) : null}
          </span>
          {result.snippet ? <span className="pd-websearch-snippet">{result.snippet}</span> : null}
        </span>
      </>
    );
    const shared = clsx('pd-websearch-row pd-focusable', className);
    if (result.url !== undefined) {
      return (
        <a
          ref={ref as Ref<HTMLAnchorElement>}
          className={shared}
          href={result.url}
          target="_blank"
          rel="noreferrer"
          title={result.url}
          onClick={() => onSelect?.(result)}
          {...(rest as HTMLAttributes<HTMLAnchorElement>)}
        >
          {inner}
        </a>
      );
    }
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        className={shared}
        onClick={() => onSelect?.(result)}
        {...(rest as HTMLAttributes<HTMLButtonElement>)}
      >
        {inner}
      </button>
    );
  },
);

export interface WebSearchResultsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect' | 'results'> {
  query: ReactNode;
  results: WebSearchResultData[];
  /** Header count; defaults to results.length. */
  count?: number;
  /** Rows shown before the list scrolls (drives max-height). */
  maxVisible?: number;
  /** Secondary line shown in the empty state (e.g. a backend note). */
  emptyHint?: ReactNode;
  onSelect?: (result: WebSearchResultData) => void;
}

/** Web-search step body: header row + bordered scrollable result list, or an empty state. */
export const WebSearchResults = forwardRef<HTMLDivElement, WebSearchResultsProps>(
  function WebSearchResults(
    { query, results, count, maxVisible = 4, emptyHint, onSelect, className, style, ...rest },
    ref,
  ) {
    const total = count ?? results.length;
    const isEmpty = results.length === 0;
    return (
      <div
        ref={ref}
        className={clsx('pd-websearch', className)}
        style={{ '--pd-websearch-visible': maxVisible, ...style } as CSSProperties}
        {...rest}
      >
        <div className="pd-websearch-header">
          <span className="pd-websearch-header-icon">
            <IconGlobe size={15} />
          </span>
          <span className="pd-websearch-query">{query}</span>
          <span className="pd-websearch-count">
            {total} {total === 1 ? 'result' : 'results'}
          </span>
        </div>
        {isEmpty ? (
          <div className="pd-websearch-empty" role="status">
            <span className="pd-websearch-empty-icon">
              <IconGlobe size={18} />
            </span>
            <span className="pd-websearch-empty-title">No results found</span>
            <span className="pd-websearch-empty-hint">
              {emptyHint ?? 'Try rephrasing the search or checking your connection.'}
            </span>
          </div>
        ) : (
          <div className="pd-websearch-list pd-scroll">
            {results.map((result) => (
              <WebSearchResultItem
                key={result.url ?? result.title}
                result={result}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);
