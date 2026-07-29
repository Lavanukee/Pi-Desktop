/**
 * Site icons for search-result rows, resolved once per host and shared by every
 * card in the app.
 *
 * The bytes are fetched in MAIN (electron/canvas/favicons.ts) and arrive as a
 * `data:` URI, so nothing here touches the network and the renderer's CSP goes
 * on refusing remote images. This module is only the cache + the subscription
 * that re-renders a row when its icon lands.
 *
 * A host that has no usable icon resolves to `null` and is never asked again —
 * the row keeps the letter chip it already draws, which is why this can fail
 * quietly and why nothing here needs an error path.
 */
import { useEffect, useState } from 'react';

/** host → data URI, or null for "asked, hasn't got one". */
const icons = new Map<string, string | null>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** The bare host of a URL or domain string, lowercased. */
export function iconHost(input: string | undefined): string | undefined {
  if (input === undefined || input.trim() === '') return undefined;
  const raw = input.trim();
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    return host.includes('.') ? host : undefined;
  } catch {
    return undefined;
  }
}

function request(host: string): void {
  if (icons.has(host) || pending.has(host)) return;
  const p = (async () => {
    try {
      const res = await window.piDesktop.invoke('canvas:site-icon', { site: host });
      icons.set(host, res?.dataUri ?? null);
    } catch {
      icons.set(host, null); // no main process (a test/story mount) — letter chip
    }
    pending.delete(host);
    notify();
  })();
  pending.set(host, p);
}

/**
 * The icon for a result row's site, or undefined while it is still coming (and
 * for anything without a usable host). Safe to call for every row in a list —
 * eight results on one domain make one request.
 */
export function useSiteIcon(site: string | undefined): string | undefined {
  const host = iconHost(site);
  const [, bump] = useState(0);
  useEffect(() => {
    if (host === undefined) return;
    const listener = (): void => bump((n) => n + 1);
    listeners.add(listener);
    request(host);
    return () => {
      listeners.delete(listener);
    };
  }, [host]);
  if (host === undefined) return undefined;
  return icons.get(host) ?? undefined;
}

/** Test seam. */
export function clearSiteIcons(): void {
  icons.clear();
  pending.clear();
}
