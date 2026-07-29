/**
 * Site icons for the web-search results card, fetched in MAIN and handed to the
 * renderer as a `data:` URI.
 *
 * jedd, looking at a results list of grey letter chips: "I would like real
 * website icons/logos instead of the single letters."
 *
 * Why main and not an `<img src="https://…">`: the renderer's CSP is
 * `img-src 'self' data: blob: pd-file:` — deliberately, so nothing rendered in
 * the app can quietly reach the network. Loosening it to `https:` for decoration
 * would let every future surface fetch from anywhere, and would have the
 * renderer announce itself to each site in a results list. Fetching here keeps
 * the CSP as it is, keeps the requests auditable in one place, and lets the
 * results be cached across every chat.
 *
 * FIRST-PARTY ONLY: each icon comes from the site it belongs to, never from a
 * favicon aggregator — those turn "show me an icon" into "tell a third party
 * every domain this person searched".
 *
 * Never throws. A site with no icon (or no network) resolves to `null`, and the
 * card falls back to the letter chip it already draws.
 */

/** Icon paths to try, in order. Nearly every site answers one of these. */
const CANDIDATE_PATHS = ['/favicon.ico', '/favicon.png', '/apple-touch-icon.png'] as const;

/** Anything larger is not a favicon; refuse rather than pass megabytes around. */
const MAX_BYTES = 100 * 1024;
const TIMEOUT_MS = 4000;

/** Image types worth rendering. An HTML error page served as `/favicon.ico`
 * (very common) is rejected here rather than shown as a broken image. */
const IMAGE_TYPES = /^image\/(x-icon|vnd\.microsoft\.icon|png|jpeg|gif|webp|svg\+xml)$/i;

/** Resolved icons, by host. `null` records a miss so a dead host is asked once. */
const cache = new Map<string, string | null>();
/** In-flight lookups, so eight results on one domain make one request. */
const inFlight = new Map<string, Promise<string | null>>();

/** The bare host for an input that may be a host, a URL, or junk. Undefined when
 * it is not a plain http(s) host — no IPs-with-credentials, no `file:`, no path. */
export function faviconHost(input: string): string | undefined {
  const raw = input.trim();
  if (raw === '') return undefined;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username !== '' || url.password !== '') return undefined;
    const host = url.hostname.toLowerCase();
    // A host with no dot is not a public site (localhost, an intranet name).
    return host.includes('.') ? host : undefined;
  } catch {
    return undefined;
  }
}

async function tryPath(host: string, path: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://${host}${path}`, {
      signal: controller.signal,
      redirect: 'follow',
      // No cookies, no referrer: this is a decoration, not a visit.
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!IMAGE_TYPES.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The site's icon as a `data:` URI, or null if it has none we can use. Cached
 * per host for the life of the process, including misses.
 */
export async function siteFavicon(input: string): Promise<string | null> {
  const host = faviconHost(input);
  if (host === undefined) return null;
  const cached = cache.get(host);
  if (cached !== undefined) return cached;
  const existing = inFlight.get(host);
  if (existing !== undefined) return await existing;

  const lookup = (async (): Promise<string | null> => {
    for (const path of CANDIDATE_PATHS) {
      const found = await tryPath(host, path);
      if (found !== null) return found;
    }
    return null;
  })();
  inFlight.set(host, lookup);
  try {
    const result = await lookup;
    cache.set(host, result);
    return result;
  } finally {
    inFlight.delete(host);
  }
}

/** Test seam: drop everything remembered so far. */
export function clearFaviconCache(): void {
  cache.clear();
  inFlight.clear();
}
