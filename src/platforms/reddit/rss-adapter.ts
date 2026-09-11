/**
 * Reddit RSS Adapter -- ScrapeSuite Engine
 *
 * Fallback fetch mode using Reddit's public Atom (.rss) feeds.
 *
 * Reddit's unauthenticated `.json` API is aggressively blocked for
 * datacenter IPs (403 at the edge, regardless of User-Agent), and the
 * OAuth endpoint requires app credentials. The Atom feeds served at
 * `<path>.rss`, however, are produced for feed readers and remain
 * reachable from the same IPs. This adapter provides:
 *
 *   - Conversion of any valid Reddit listing URL into its .rss equivalent
 *   - A dependency-free Atom parser tuned to Reddit's feed format
 *   - Structured extraction of posts and comments (title, author, body,
 *     permalinks, external URLs, timestamps, subreddit)
 *   - Feed-reader etiquette: honour the unauthenticated budget
 *     (10 req/min), self-report via the User-Agent, and surface
 *     x-ratelimit-* headers to the shared RateLimiterEvader
 *
 * What RSS does NOT provide: scores, upvote ratios, nested comment trees,
 * and `after`-anchored pagination beyond the feed's default window
 * (feeds accept `?limit=` up to 100).
 *
 * Usage:
 *   import { rssAdapter } from './rss-adapter';
 *   const result = await rssAdapter.fetchAndParse(
 *     'https://www.reddit.com/r/programming/hot'
 *   );
 */

import { createChildLogger } from '../../utils/logger';
import type {
  RedditRssEntry,
  RedditRssFetchResult,
  RedditRssAdapterStats,
} from './types';

const logger = createChildLogger('reddit-rss-adapter');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Canonical public host for feeds (old.reddit.com feeds normalize to www). */
const RSS_HOST = 'https://www.reddit.com';

/**
 * Feed-reader style User-Agent. Reddit's Atom feeds are intended for feed
 * readers; an honest, compatible-reader UA is both etiquette and the most
 * reliable identity for this endpoint (verified against the live edge).
 */
const DEFAULT_USER_AGENT =
  'ScrapeSuite/1.0 (compatible; feed reader; +https://github.com/horsnel/scrapesuite-engine)';

/** Default feed fetch timeout in ms. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Hard cap mirroring Reddit's feed `limit` parameter. */
const MAX_FEED_LIMIT = 100;

// ===============================================================================
// ENTITY DECODING
// ===============================================================================

/**
 * Decode XML/HTML entities in Atom payloads.
 *
 * Reddit double-escapes content: the Atom `type="html"` payload is
 * entity-escaped HTML (e.g. `&lt;div class=&quot;md&quot;&gt;`). One pass of
 * this decoder yields usable HTML; titles/ids are escaped once and are also
 * handled correctly.
 *
 * `&amp;` is decoded LAST so escaped entity references (`&amp;lt;`) are not
 * double-decoded.
 */
export function decodeXmlEntities(input: string): string {
  if (!input) return '';
  let out = input;

  // Numeric references first (decimal + hex)
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16))
  );
  out = out.replace(/&#(\d+);/g, (_, dec) =>
    String.fromCodePoint(parseInt(dec, 10))
  );

  // Named references (ampersand must remain escaped until the final step)
  const named: Record<string, string> = {
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    rsquo: '\u2019',
    lsquo: '\u2018',
    ldquo: '\u201C',
    rdquo: '\u201D',
  };
  out = out.replace(/&([a-z]+);/gi, (match, name: string) => {
    const mapped = named[name.toLowerCase()];
    return mapped !== undefined ? mapped : match; // leave unknown refs untouched
  });

  // Decode &amp; last
  return out.replace(/&amp;/g, '&');
}

/** Strip HTML tags and collapse whitespace to a plain-text excerpt. */
export function htmlToText(html: string, maxChars = 500): string {
  if (!html) return '';
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')                                  // comments (SC_OFF/SC_ON)
    .replace(/<\/?(p|div|br|li|ul|ol|blockquote|table|tr|h[1-6]|pre)\b[^>]*>/gi, ' ') // block tags → space
    .replace(/<[^>]+>/g, '')                                           // inline tags → nothing
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// ===============================================================================
// ATOM PARSING
// ===============================================================================

/** Extract the inner text of the first `<tag>...</tag>` occurrence. */
function firstTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

/** Extract an attribute value from the first `<tag ... attr="..." ...>` occurrence. */
function firstAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']*)["'][^>]*>`, 'i');
  const m = re.exec(xml);
  return m ? m[1] : null;
}

/** Parse an RFC 3339 timestamp into epoch ms (null on failure). */
function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Normalize "/u/username" or "u/username" to "username" (strips any embedded markup). */
function normalizeAuthor(raw: string | null): string | null {
  if (!raw) return null;
  const text = htmlToText(raw, 200);
  const m = /^\/?u\/(.+)$/i.exec(text);
  return m ? m[1] : text || null;
}

/** Extract the post fullname (t3_xxx) from a comments permalink. */
function postIdFromLink(link: string): string | null {
  const m = /\/comments\/([a-z0-9]+)/i.exec(link);
  return m ? `t3_${m[1]}` : null;
}

/**
 * Parse a Reddit Atom feed into structured entries.
 *
 * Reddit's feed format is stable and entity-escaped (no raw markup inside
 * entries), which makes a regex parser reliable here while keeping the
 * engine dependency-free. Splitting on `</entry>` boundaries is safe for
 * the same reason.
 */
export function parseAtomFeed(xml: string): {
  feedTitle: string | null;
  feedUpdatedAt: number | null;
  entries: RedditRssEntry[];
} {
  const feedTitleRaw = firstTag(xml, 'title');
  const feedUpdatedAt = parseTimestamp(firstTag(xml, 'updated'));

  // Feed-level subreddit fallback: Reddit entry categories are link flairs
  // (often non-r/), so derive the default from the feed's own URL
  // (<id> / <link> contain e.g. reddit.com/r/programming/hot.rss).
  const feedSelfUrl = firstTag(xml, 'id') ?? firstAttr(xml, 'link', 'href') ?? '';
  const feedSubreddit = /\/r\/([^/?#.]+)/i.exec(feedSelfUrl)?.[1] ?? null;

  const entryBodies = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];

  const entries: RedditRssEntry[] = entryBodies.map((body) => {
    // Identity — prefer the Atom <id> fullname (t3_/t1_), fall back to link
    const atomId = firstTag(body, 'id');
    const link =
      firstAttr(body, 'link', 'href') ??
      firstTag(body, 'link'); // rare text-form fallback

    const isComment = !!atomId && /^t1_/.test(atomId);
    const parentPostId = isComment && link
      ? postIdFromLink(link)
      : null;

    // Content — type="html" payload, entity-escaped HTML
    const contentRaw = firstTag(body, 'content');
    const htmlContent = contentRaw ? decodeXmlEntities(contentRaw) : null;

    // External URL — first non-Reddit anchor in the content (link posts)
    let externalUrl: string | null = null;
    if (htmlContent) {
      const hrefs = htmlContent.match(/<a\b[^>]*href="(https?:\/\/[^"]+)"/gi) ?? [];
      for (const anchor of hrefs) {
        const href = /href="(https?:\/\/[^"]+)"/i.exec(anchor)?.[1];
        if (!href) continue;
        try {
          if (!/(^|\.)reddit\.com$/i.test(new URL(href).hostname)) {
            externalUrl = href;
            break;
          }
        } catch {
          // Malformed href — skip
        }
      }
    }

    const categories: string[] = [];
    const categoryRe = /<category\b[^>]*term=["']([^"']+)["']/gi;
    let categoryMatch: RegExpExecArray | null;
    while ((categoryMatch = categoryRe.exec(body)) !== null) {
      categories.push(categoryMatch[1]);
    }

    const title = firstTag(body, 'title');

    // Subreddit resolution: entry r/ category (flair feeds) → entry permalink
    // (/r/<sub>/...) → feed-level subreddit
    const subreddit =
      categories.find(c => /^r\//i.test(c))?.slice(2) ??
      /\/r\/([^/?#.]+)/i.exec(link ?? '')?.[1] ??
      feedSubreddit;

    return {
      kind: isComment ? 'comment' : /^t3_/.test(atomId ?? '') ? 'post' : 'entry',
      id: atomId ?? postIdFromLink(link ?? ''),
      title: title ? decodeXmlEntities(title) : null,
      author: normalizeAuthor(firstTag(body, 'name') ?? firstTag(body, 'author')),
      subreddit: subreddit ?? null,
      permalink: link ?? null,
      externalUrl,
      commentId: isComment ? atomId : null,
      parentPostId,
      publishedAt: parseTimestamp(firstTag(body, 'published') ?? firstTag(body, 'updated')),
      updatedAt: parseTimestamp(firstTag(body, 'updated')),
      htmlContent,
      textExcerpt: htmlContent ? htmlToText(htmlContent) : (title ? decodeXmlEntities(title) : null),
      categories,
    } satisfies RedditRssEntry;
  });

  return {
    feedTitle: feedTitleRaw ? decodeXmlEntities(feedTitleRaw) : null,
    feedUpdatedAt,
    entries,
  };
}

// ===============================================================================
// REDDIT RSS ADAPTER
// ===============================================================================

export class RedditRssAdapter {
  private stats: RedditRssAdapterStats = {
    totalFeedRequests: 0,
    successfulFetches: 0,
    rateLimitEncounters: 0,
    blockedEncounters: 0,
    networkErrors: 0,
    entriesParsed: 0,
    lastFetchAt: null,
    lastFeedUrl: null,
  };

  private userAgent: string;

  constructor(userAgent?: string) {
    this.userAgent = userAgent ?? DEFAULT_USER_AGENT;
  }

  // ===========================================================================
  // URL BUILDING
  // ===========================================================================

  /**
   * Convert any valid Reddit listing URL into its Atom feed URL.
   *
   * Handles: front page, /r/<sub>[/sort], /r/<sub>/comments/<id>[/slug],
   * /user/<name>[/section], /search?q=..., with `.json`/`.rss` suffixes or
   * without. Query params (t, limit, q, sort) are preserved; `limit` is
   * clamped to 100. old.reddit.com URLs are normalized to www.
   *
   * @returns The .rss feed URL, or null if the URL is not a Reddit path.
   */
  buildRssUrl(url: string, limit?: number): string | null {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (!/(^|\.)reddit\.com$/.test(host)) return null;

      // Normalize host; strip .json / .rss suffix from the path
      let path = parsed.pathname.replace(/\.(json|rss)$/i, '');
      if (path.length > 1) {
        path = path.replace(/\/+$/, '');
        path = path.replace(/\.(json|rss)$/i, ''); // suffix before trailing slash
      }
      if (path === '' || path === '/') path = ''; // front page

      const params = new URLSearchParams(parsed.searchParams);
      if (limit !== undefined) {
        params.set('limit', String(Math.min(Math.max(1, limit), MAX_FEED_LIMIT)));
      } else if (params.has('limit')) {
        const existing = Number(params.get('limit'));
        if (!Number.isNaN(existing)) {
          params.set('limit', String(Math.min(Math.max(1, existing), MAX_FEED_LIMIT)));
        }
      }
      const qs = params.toString();

      return `${RSS_HOST}${path}.rss${qs ? `?${qs}` : ''}`;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // FETCH + PARSE
  // ===========================================================================

  /**
   * Fetch a Reddit Atom feed and parse it into structured entries.
   *
   * The caller (RedditManager.scrapeListingRss) is responsible for pacing,
   * cooldown enforcement, and 429 retry/backoff policy — this method performs
   * a single timed fetch and reports what the edge returned.
   *
   * @param url - Any Reddit listing/post/user/search URL (or a direct .rss URL)
   * @param options - Fetch options
   */
  async fetchAndParse(
    url: string,
    options?: {
      limit?: number;
      timeoutMs?: number;
      headers?: Record<string, string>;
    }
  ): Promise<RedditRssFetchResult & { responseHeaders: Record<string, string | undefined> }> {
    const feedUrl = this.buildRssUrl(url, options?.limit);
    const startedAt = Date.now();
    const base: RedditRssFetchResult = {
      success: false,
      feedUrl: feedUrl ?? url,
      feedTitle: null,
      feedUpdatedAt: null,
      entries: [],
      entryCount: 0,
      httpStatus: 0,
      fetchedAt: startedAt,
      errors: [],
    };

    if (!feedUrl) {
      base.errors.push(`Not a Reddit URL: ${url}`);
      return { ...base, responseHeaders: {} };
    }

    this.stats.totalFeedRequests++;
    this.stats.lastFeedUrl = feedUrl;

    let response: Response;
    try {
      response = await fetch(feedUrl, {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'application/atom+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          ...options?.headers,
        },
        signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err: any) {
      this.stats.networkErrors++;
      const isTimeout =
        err?.name === 'TimeoutError' || err?.name === 'AbortError';
      base.errors.push(
        isTimeout
          ? `Feed fetch timed out after ${options?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : `Network error: ${err?.message ?? String(err)}`
      );
      base.fetchedAt = Date.now();
      logger.warn({ feedUrl, err: err?.message }, 'RSS feed fetch failed');
      return { ...base, responseHeaders: {} };
    }

    base.httpStatus = response.status;
    base.fetchedAt = Date.now();

    const responseHeaders: Record<string, string | undefined> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    if (response.status === 429) {
      this.stats.rateLimitEncounters++;
      base.errors.push('Rate limited (429) on RSS feed');
      return { ...base, responseHeaders };
    }

    if (response.status === 403 || response.status === 401) {
      this.stats.blockedEncounters++;
      base.errors.push(`Blocked (${response.status}) on RSS feed`);
      return { ...base, responseHeaders };
    }

    if (!response.ok) {
      base.errors.push(`HTTP ${response.status}: ${response.statusText}`);
      return { ...base, responseHeaders };
    }

    let xml: string;
    try {
      xml = await response.text();
    } catch (err: any) {
      this.stats.networkErrors++;
      base.errors.push(`Failed to read feed body: ${err?.message}`);
      return { ...base, responseHeaders };
    }

    if (!/<feed[\s>]/i.test(xml)) {
      base.errors.push('Response is not an Atom feed (unexpected payload)');
      return { ...base, responseHeaders };
    }

    const parsed = parseAtomFeed(xml);
    this.stats.successfulFetches++;
    this.stats.entriesParsed += parsed.entries.length;
    this.stats.lastFetchAt = Date.now();

    logger.info({
      feedUrl: feedUrl.substring(0, 100),
      status: response.status,
      entries: parsed.entries.length,
      durationMs: Date.now() - startedAt,
    }, 'RSS feed fetched and parsed');

    return {
      success: true,
      feedUrl,
      feedTitle: parsed.feedTitle,
      feedUpdatedAt: parsed.feedUpdatedAt,
      entries: parsed.entries,
      entryCount: parsed.entries.length,
      httpStatus: response.status,
      fetchedAt: base.fetchedAt,
      errors: base.errors,
      responseHeaders,
    };
  }

  // ===========================================================================
  // STATS
  // ===========================================================================

  getStats(): RedditRssAdapterStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalFeedRequests: 0,
      successfulFetches: 0,
      rateLimitEncounters: 0,
      blockedEncounters: 0,
      networkErrors: 0,
      entriesParsed: 0,
      lastFetchAt: null,
      lastFeedUrl: null,
    };
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const rssAdapter = new RedditRssAdapter();
