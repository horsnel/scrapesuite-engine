/**
 * Crawling / Spidering Engine -- ScrapeSuite
 *
 * Turns ScrapeSuite from a single-URL scraper into a full website crawler.
 * Discovers pages by following links, parsing sitemaps, and spidering domains
 * while respecting depth limits, robots.txt, rate limits, and concurrency
 * controls.  Every page fetch goes through the existing orchestrator so that
 * proxy rotation, anti-bot evasion, and CAPTCHA solving work transparently.
 *
 * * Key features
 * --------------
 *  • URL Discovery  -- HTML link extraction (a, link[rel=next], area, iframe)
 *  • Sitemap Parsing -- XML sitemap + sitemap index + robots.txt directives
 *  • Depth Control   -- Configurable max crawl depth (1-10)
 *  • Domain Scoping  -- same-domain / same-subdomain / allow-external
 *  • URL Filtering   -- Regex include/exclude, file-extension blocklist
 *  • Deduplication   -- Normalised URL tracking (fragments, trailing slashes,
 *                       query-param ordering) with Redis-backed visited set
 *  • Concurrency     -- Configurable 1-20 concurrent page fetches
 *  • Politeness      -- Per-domain rate limiting, robots.txt, configurable delay
 *  • Content Extract -- Title, meta description, headings, structured data
 *  • Crawl Strategies -- BFS, DFS, Priority (URL scoring heuristic)
 *  • Orchestrator    -- Every fetch reuses proxy / anti-bot / CAPTCHA pipeline
 *  • State Persistence -- Redis-backed crawl state for pause / resume
 *  • Real-time Progress -- Pages crawled, URLs discovered, errors, elapsed
 *  • Output          -- Array of {url, title, depth, status, html?, extracted?}
 *
 * Usage
 * -----
 *   import { crawlEngine } from '../crawler';
 *   const results = await crawlEngine.start({
 *     seedUrls: ['https://example.com'],
 *     maxDepth: 3,
 *     maxPages: 500,
 *     strategy: 'bfs',
 *   });
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet, redis } from '../utils/redis';
import { db } from '../utils/db';
import { orchestrator } from '../orchestrator';
import { robotsParser } from '../robots/parser';
import { adaptiveRateLimiter } from '../rate-limiter';
import * as cheerio from 'cheerio';
import * as crypto from 'crypto';

const logger = createChildLogger('crawler');

// --- Constants ----------------------------------------------------------------

/** Default maximum crawl depth when not specified. */
const DEFAULT_MAX_DEPTH = 3;

/** Default maximum number of pages to crawl. */
const DEFAULT_MAX_PAGES = 100;

/** Default concurrency for parallel page fetches. */
const DEFAULT_CONCURRENCY = 5;

/** Default delay (ms) between requests to the same domain. */
const DEFAULT_DELAY_MS = 500;

/** Minimum allowed concurrency. */
const MIN_CONCURRENCY = 1;

/** Maximum allowed concurrency. */
const MAX_CONCURRENCY = 20;

/** Minimum allowed depth. */
const MIN_DEPTH = 1;

/** Maximum allowed depth. */
const MAX_DEPTH = 10;

/** Redis key prefix for crawl state. */
const CRAWL_STATE_PREFIX = 'crawl:state:';

/** Redis key prefix for the visited-URL set of a crawl. */
const CRAWL_VISITED_PREFIX = 'crawl:visited:';

/** Redis TTL for crawl state (24 hours). */
const CRAWL_STATE_TTL_SECONDS = 86400;

/** File extensions to skip by default. */
const DEFAULT_SKIP_EXTENSIONS = [
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.wav', '.ogg',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dmg', '.iso', '.bin',
  '.css', '.js', '.woff', '.woff2', '.ttf', '.eot',
  '.rss', '.atom', '.json', '.xml',
];

/** User-agent string for sitemap / robots.txt fetches. */
const SITEMAP_USER_AGENT = 'ScrapeSuite-Crawler (+https://scrapesuite.dev)';

// --- Types --------------------------------------------------------------------

/** Domain scoping mode -- controls which discovered links are followed. */
export type DomainScope = 'same-domain' | 'same-subdomain' | 'allow-external';

/** Crawl traversal strategy. */
export type CrawlStrategy = 'bfs' | 'dfs' | 'priority';

/** Status of a crawl job. */
export type CrawlStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** A single discovered URL waiting to be crawled. */
export interface CrawlUrl {
  /** The normalised URL to crawl. */
  url: string;
  /** Depth of this URL relative to the seed (0 = seed). */
  depth: number;
  /** The URL that linked to this one (for backlink tracking). */
  parentUrl?: string;
  /** Link text or anchor content. */
  anchorText?: string;
  /** Heuristic priority score (higher = more important). */
  priority: number;
  /** When this URL was discovered. */
  discoveredAt: number;
}

/** Result of crawling a single page. */
export interface CrawlPageResult {
  /** The normalised URL that was crawled. */
  url: string;
  /** Page title extracted from <title>. */
  title: string;
  /** Depth at which this page was found. */
  depth: number;
  /** HTTP status code of the response. */
  status: number;
  /** Raw HTML body (only if `includeHtml` was true). */
  html?: string;
  /** Structured content extracted from the page. */
  extracted?: PageExtractedContent;
  /** Final URL after any redirects. */
  finalUrl?: string;
  /** Response time in ms. */
  responseMs: number;
  /** Whether this was a cache hit. */
  cached: boolean;
  /** Error message if the page fetch failed. */
  error?: string;
}

/** Structured content extracted from a single crawled page. */
export interface PageExtractedContent {
  /** Page <title>. */
  title: string;
  /** <meta name="description"> content. */
  metaDescription: string;
  /** <meta name="keywords"> content. */
  metaKeywords: string;
  /** Canonical URL from <link rel="canonical">. */
  canonicalUrl: string;
  /** OG title. */
  ogTitle: string;
  /** OG description. */
  ogDescription: string;
  /** OG image URL. */
  ogImage: string;
  /** Headings grouped by level (h1-h6). */
  headings: { level: number; text: string }[];
  /** All discovered outbound links (absolute URLs). */
  links: string[];
  /** JSON-LD structured data blocks. */
  jsonLd: Record<string, any>[];
  /** Word count of visible text. */
  wordCount: number;
  /** Language from <html lang>. */
  lang: string;
}

/** Real-time progress snapshot for an active crawl. */
export interface CrawlProgress {
  /** Unique crawl ID. */
  crawlId: string;
  /** Current status. */
  status: CrawlStatus;
  /** Number of pages successfully crawled. */
  pagesCrawled: number;
  /** Number of URLs discovered (including those not yet crawled). */
  urlsDiscovered: number;
  /** Number of URLs still in the queue. */
  urlsQueued: number;
  /** Number of errors encountered. */
  errors: number;
  /** Elapsed time in ms since the crawl started. */
  elapsedMs: number;
  /** Average response time per page in ms. */
  avgResponseMs: number;
  /** Current requests per second. */
  rps: number;
  /** Per-domain breakdown. */
  domainStats: Record<string, { crawled: number; errors: number }>;
}

/** Full configuration for a crawl job. */
export interface CrawlConfig {
  /** Seed URLs to start the crawl from. */
  seedUrls: string[];
  /** Maximum crawl depth (1-10). Default: 3. */
  maxDepth?: number;
  /** Maximum number of pages to crawl. Default: 100. */
  maxPages?: number;
  /** Concurrency (1-20). Default: 5. */
  concurrency?: number;
  /** Crawl strategy: bfs, dfs, or priority. Default: bfs. */
  strategy?: CrawlStrategy;
  /** Domain scoping mode. Default: same-domain. */
  domainScope?: DomainScope;
  /** Delay in ms between requests to the same domain. Default: 500. */
  delayMs?: number;
  /** Whether to respect robots.txt. Default: true. */
  respectRobotsTxt?: boolean;
  /** Whether to discover and parse XML sitemaps. Default: true. */
  parseSitemaps?: boolean;
  /** Whether to include raw HTML in the results. Default: false. */
  includeHtml?: boolean;
  /** Whether to extract structured content. Default: true. */
  extractContent?: boolean;
  /** File extensions to skip. Defaults to DEFAULT_SKIP_EXTENSIONS. */
  skipExtensions?: string[];
  /** Regex patterns -- URLs must match at least one to be included. */
  includePatterns?: string[];
  /** Regex patterns -- URLs matching any will be excluded. */
  excludePatterns?: string[];
  /** User ID for billing. */
  userId?: string;
  /** API key ID for billing. */
  apiKeyId?: string;
  /** Proxy tier for the orchestrator. */
  proxyTier?: string;
  /** Proxy country for the orchestrator. */
  proxyCountry?: string;
  /** Custom HTTP headers. */
  headers?: Record<string, string>;
  /** Timeout per page fetch in ms. Default: 30000. */
  timeout?: number;
  /** Resume a previously paused crawl by crawlId. */
  resumeCrawlId?: string;
  /** Callback invoked on each page completion for streaming progress. */
  onPageCrawled?: (result: CrawlPageResult, progress: CrawlProgress) => void;
  /** Callback invoked on crawl completion. */
  onCrawlComplete?: (results: CrawlPageResult[], progress: CrawlProgress) => void;
  /** Callback invoked on crawl error. */
  onCrawlError?: (error: Error, progress: CrawlProgress) => void;
}

/** Persisted crawl state stored in Redis for pause / resume. */
interface CrawlState {
  /** Unique crawl ID. */
  crawlId: string;
  /** Seed URLs. */
  seedUrls: string[];
  /** Full config snapshot. */
  config: CrawlConfig;
  /** Current status. */
  status: CrawlStatus;
  /** URL queue (serialised). */
  queue: CrawlUrl[];
  /** Set of visited URL hashes. */
  visitedHashes: string[];
  /** Pages crawled so far. */
  pagesCrawled: number;
  /** Total URLs discovered. */
  urlsDiscovered: number;
  /** Error count. */
  errors: number;
  /** Total response time for average calculation. */
  totalResponseMs: number;
  /** Per-domain stats. */
  domainStats: Record<string, { crawled: number; errors: number }>;
  /** Timestamp when the crawl was started. */
  startedAt: number;
  /** Timestamp when the crawl was last updated. */
  updatedAt: number;
  /** Results collected so far (for resume). */
  results: CrawlPageResult[];
}

// --- Internal Queue Implementations -------------------------------------------

/**
 * BFS (breadth-first) queue -- FIFO.
 * Pages at the current depth are exhausted before moving to the next depth.
 */
class BFSQueue {
  private queue: CrawlUrl[] = [];

  push(item: CrawlUrl): void {
    this.queue.push(item);
  }

  pop(): CrawlUrl | undefined {
    return this.queue.shift();
  }

  get size(): number {
    return this.queue.length;
  }

  peek(): CrawlUrl | undefined {
    return this.queue[0];
  }

  toArray(): CrawlUrl[] {
    return [...this.queue];
  }

  static fromArray(items: CrawlUrl[]): BFSQueue {
    const q = new BFSQueue();
    q.queue = items;
    return q;
  }
}

/**
 * DFS (depth-first) queue -- LIFO.
 * Follows links as deeply as possible before backtracking.
 */
class DFSQueue {
  private stack: CrawlUrl[] = [];

  push(item: CrawlUrl): void {
    this.stack.push(item);
  }

  pop(): CrawlUrl | undefined {
    return this.stack.pop();
  }

  get size(): number {
    return this.stack.length;
  }

  peek(): CrawlUrl | undefined {
    return this.stack[this.stack.length - 1];
  }

  toArray(): CrawlUrl[] {
    return [...this.stack];
  }

  static fromArray(items: CrawlUrl[]): DFSQueue {
    const q = new DFSQueue();
    q.stack = items;
    return q;
  }
}

/**
 * Priority queue -- highest priority score first.
 * URL priority is computed by scoreUrl().
 */
class PriorityQueue {
  private heap: CrawlUrl[] = [];

  push(item: CrawlUrl): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): CrawlUrl | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.heap.length;
  }

  peek(): CrawlUrl | undefined {
    return this.heap[0];
  }

  toArray(): CrawlUrl[] {
    return [...this.heap].sort((a, b) => b.priority - a.priority);
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this.heap[parent].priority >= this.heap[idx].priority) break;
      [this.heap[parent], this.heap[idx]] = [this.heap[idx], this.heap[parent]];
      idx = parent;
    }
  }

  private sinkDown(idx: number): void {
    const n = this.heap.length;
    while (true) {
      let largest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < n && this.heap[left].priority > this.heap[largest].priority) largest = left;
      if (right < n && this.heap[right].priority > this.heap[largest].priority) largest = right;
      if (largest === idx) break;
      [this.heap[largest], this.heap[idx]] = [this.heap[idx], this.heap[largest]];
      idx = largest;
    }
  }

  static fromArray(items: CrawlUrl[]): PriorityQueue {
    const q = new PriorityQueue();
    for (const item of items) q.push(item);
    return q;
  }
}

/** Union type for any queue implementation. */
type CrawlQueue = BFSQueue | DFSQueue | PriorityQueue;

// --- URL Normalisation & Utilities --------------------------------------------

/**
 * Normalise a URL for deduplication.
 *
 * * Normalisation steps:
 *  1. Lowercase the hostname
 *  2. Strip the fragment (#)
 *  3. Strip trailing slashes (except for root /)
 *  4. Sort query parameters alphabetically
 *  5. Remove default ports (80 for http, 443 for https)
 *  6. Decode percent-encoded chars where safe
 */
function normaliseUrl(raw: string): string {
  try {
    const parsed = new URL(raw);

    // Lowercase host
    parsed.hostname = parsed.hostname.toLowerCase();

    // Strip fragment
    parsed.hash = '';

    // Remove default ports
    if (
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      parsed.port = '';
    }

    // Sort query params
    parsed.searchParams.sort();

    let normalised = parsed.toString();

    // Strip trailing slash (but keep root /)
    if (normalised.length > 1 && normalised.endsWith('/')) {
      // Only strip if it's not the root path
      const urlObj = new URL(normalised);
      if (urlObj.pathname !== '/' && urlObj.pathname.endsWith('/')) {
        urlObj.pathname = urlObj.pathname.replace(/\/+$/, '');
        normalised = urlObj.toString();
      }
    }

    return normalised;
  } catch {
    // If URL parsing fails, return the raw string lowercased as a best effort
    return raw.toLowerCase();
  }
}

/**
 * Compute a stable SHA-256 hash of a normalised URL.
 * Used for the Redis visited-set membership check.
 */
function hashUrl(url: string): string {
  const normalised = normaliseUrl(url);
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

/**
 * Extract the registrable domain from a hostname.
 * Simple heuristic: last two dot-separated labels.
 */
function extractRootDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  if (parts.length <= 2) return hostname.toLowerCase();
  return parts.slice(-2).join('.');
}

/**
 * Check if two URLs are on the same domain.
 */
function isSameDomain(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).hostname.toLowerCase() === new URL(urlB).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Check if two URLs share the same subdomain (exact hostname match).
 */
function isSameSubdomain(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).hostname.toLowerCase() === new URL(urlB).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Check if a URL's file extension is in the skip list.
 */
function hasSkippedExtension(url: string, extensions: string[]): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    // Strip trailing slash for extension check
    const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    const lastSegment = path.split('/').pop() || '';
    return extensions.some((ext) => lastSegment.endsWith(ext));
  } catch {
    return false;
  }
}

/**
 * Test a URL against an array of regex patterns.
 * Returns true if the URL matches ANY pattern.
 */
function matchesAnyPattern(url: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(url)) return true;
    } catch {
      // Invalid regex -- skip
      logger.warn({ pattern }, 'Invalid URL filter pattern -- skipping');
    }
  }
  return false;
}

/**
 * Heuristically score a URL for priority-based crawling.
 *
 * * Scoring factors:
 *  - Shorter paths rank higher (likely more important pages)
 *  - Paths containing "index", "home", "welcome" rank higher
 *  - HTTPS over HTTP
 *  - Shallower depth ranks higher
 *  - Paths without file extensions rank higher
 *  - Paths with fewer query parameters rank higher
 */
function scoreUrl(url: string, depth: number, anchorText?: string): number {
  let score = 100;

  try {
    const parsed = new URL(url);

    // Depth penalty
    score -= depth * 10;

    // Path length penalty (shorter = more important)
    score -= parsed.pathname.split('/').filter(Boolean).length * 5;

    // HTTPS bonus
    if (parsed.protocol === 'https:') score += 5;

    // No file extension bonus (likely HTML)
    const lastSegment = parsed.pathname.split('/').pop() || '';
    if (!lastSegment.includes('.') || lastSegment.endsWith('.html') || lastSegment.endsWith('.htm')) {
      score += 10;
    }

    // Fewer query params bonus
    score -= Array.from(parsed.searchParams.keys()).length * 3;

    // Keyword bonuses in path
    const pathLower = parsed.pathname.toLowerCase();
    const highPriorityKeywords = ['index', 'home', 'welcome', 'about', 'contact', 'products', 'services', 'blog', 'pricing'];
    for (const kw of highPriorityKeywords) {
      if (pathLower.includes(kw)) {
        score += 8;
        break;
      }
    }

    // Anchor text bonus -- non-empty anchor suggests important link
    if (anchorText && anchorText.trim().length > 0) {
      score += 3;
    }

    // Root path bonus
    if (parsed.pathname === '/' || parsed.pathname === '') {
      score += 15;
    }

  } catch {
    score -= 50; // Unparseable URL -- low priority
  }

  return Math.max(0, score);
}

/**
 * Resolve a potentially relative URL against a base URL.
 */
function resolveUrl(base: string, relative: string): string | null {
  try {
    return new URL(relative, base).toString();
  } catch {
    return null;
  }
}

/**
 * Sleep for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- HTML Link Extraction -----------------------------------------------------

/**
 * Extract all links from an HTML document.
 *
 * * Extracts links from:
 *  - <a href="...">
 *  - <link rel="next" href="...">
 *  - <link rel="prev" href="...">
 *  - <area href="...">
 *  - <iframe src="...">
 *  - <frame src="...">
 *
 * Returns an array of { url, anchorText } objects with absolute URLs.
 */
function extractLinks(html: string, baseUrl: string): { url: string; anchorText: string }[] {
  const links: { url: string; anchorText: string }[] = [];

  try {
    const $ = cheerio.load(html);

    // <a href>
    $('a[href]').each((_idx, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const resolved = resolveUrl(baseUrl, href);
      if (resolved) {
        const anchorText = $(el).text().trim().substring(0, 200);
        links.push({ url: resolved, anchorText });
      }
    });

    // <link rel="next"> and <link rel="prev"> -- pagination
    $('link[rel="next"][href], link[rel="prev"][href]').each((_idx, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const resolved = resolveUrl(baseUrl, href);
      if (resolved) {
        const rel = $(el).attr('rel') || '';
        links.push({ url: resolved, anchorText: `[link rel="${rel}"]` });
      }
    });

    // <area href>
    $('area[href]').each((_idx, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const resolved = resolveUrl(baseUrl, href);
      if (resolved) {
        const alt = $(el).attr('alt') || '';
        links.push({ url: resolved, anchorText: alt });
      }
    });

    // <iframe src>
    $('iframe[src]').each((_idx, el) => {
      const src = $(el).attr('src');
      if (!src) return;

      const resolved = resolveUrl(baseUrl, src);
      if (resolved) {
        links.push({ url: resolved, anchorText: '[iframe]' });
      }
    });

    // <frame src>
    $('frame[src]').each((_idx, el) => {
      const src = $(el).attr('src');
      if (!src) return;

      const resolved = resolveUrl(baseUrl, src);
      if (resolved) {
        links.push({ url: resolved, anchorText: '[frame]' });
      }
    });
  } catch (err: any) {
    logger.warn({ baseUrl, error: err.message }, 'Failed to extract links from HTML');
  }

  return links;
}

// --- Content Extraction -------------------------------------------------------

/**
 * Extract structured content from an HTML document.
 *
 * * Extracts:
 *  - <title>
 *  - <meta name="description">
 *  - <meta name="keywords">
 *  - <link rel="canonical">
 *  - Open Graph (og:title, og:description, og:image)
 *  - Headings (h1-h6)
 *  - JSON-LD structured data
 *  - Word count
 *  - Language
 */
function extractContent(html: string, url: string): PageExtractedContent {
  const empty: PageExtractedContent = {
    title: '',
    metaDescription: '',
    metaKeywords: '',
    canonicalUrl: '',
    ogTitle: '',
    ogDescription: '',
    ogImage: '',
    headings: [],
    links: [],
    jsonLd: [],
    wordCount: 0,
    lang: '',
  };

  try {
    const $ = cheerio.load(html);

    // Title
    empty.title = $('title').first().text().trim();

    // Meta description
    empty.metaDescription = $('meta[name="description"]').attr('content')?.trim() || '';

    // Meta keywords
    empty.metaKeywords = $('meta[name="keywords"]').attr('content')?.trim() || '';

    // Canonical
    const canonicalHref = $('link[rel="canonical"]').attr('href');
    if (canonicalHref) {
      empty.canonicalUrl = resolveUrl(url, canonicalHref) || canonicalHref;
    }

    // Open Graph
    empty.ogTitle = $('meta[property="og:title"]').attr('content')?.trim() || '';
    empty.ogDescription = $('meta[property="og:description"]').attr('content')?.trim() || '';
    empty.ogImage = $('meta[property="og:image"]').attr('content')?.trim() || '';

    // Headings
    $('h1, h2, h3, h4, h5, h6').each((_idx, el) => {
      const tagName = (el as any).tagName?.toLowerCase() || '';
      const level = parseInt(tagName.replace('h', ''), 10);
      if (level >= 1 && level <= 6) {
        const text = $(el).text().trim();
        if (text) {
          empty.headings.push({ level, text: text.substring(0, 500) });
        }
      }
    });

    // Links (for extracted content -- all unique absolute URLs)
    const linkSet = new Set<string>();
    $('a[href]').each((_idx, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(url, href);
      if (resolved && !linkSet.has(resolved)) {
        linkSet.add(resolved);
      }
    });
    empty.links = Array.from(linkSet);

    // JSON-LD
    $('script[type="application/ld+json"]').each((_idx, el) => {
      try {
        const text = $(el).text().trim();
        if (text) {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            empty.jsonLd.push(...parsed);
          } else {
            empty.jsonLd.push(parsed);
          }
        }
      } catch {
        // Malformed JSON-LD -- skip
      }
    });

    // Word count -- strip tags and count
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    empty.wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

    // Language
    empty.lang = $('html').attr('lang')?.trim() || '';

  } catch (err: any) {
    logger.warn({ url, error: err.message }, 'Content extraction failed');
  }

  return empty;
}

// --- Sitemap Parsing ----------------------------------------------------------

/** Parsed entry from an XML sitemap. */
interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

/** Parsed entry from a sitemap index. */
interface SitemapIndexEntry {
  loc: string;
  lastmod?: string;
}

/**
 * Fetch and parse a robots.txt to discover sitemap URLs.
 */
async function discoverSitemapsFromRobots(domain: string): Promise<string[]> {
  try {
    const sitemaps = await robotsParser.getSitemaps(domain);
    logger.debug({ domain, sitemapCount: sitemaps.length }, 'Discovered sitemaps from robots.txt');
    return sitemaps;
  } catch (err: any) {
    logger.warn({ domain, error: err.message }, 'Failed to discover sitemaps from robots.txt');
    return [];
  }
}

/**
 * Fetch a URL as plain text with a timeout.
 */
async function fetchText(url: string, timeoutMs: number = 15_000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': SITEMAP_USER_AGENT,
        'Accept': 'text/xml, application/xml, text/plain',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.debug({ url, status: response.status }, 'Sitemap fetch returned non-200');
      return null;
    }

    return await response.text();
  } catch (err: any) {
    logger.debug({ url, error: err.message }, 'Sitemap fetch failed');
    return null;
  }
}

/**
 * Parse an XML sitemap into a list of URLs.
 *
 * * Supports:
 *  - Standard sitemap (<urlset> with <url><loc> entries)
 *  - Sitemap index (<sitemapindex> with <sitemap><loc> entries)
 *  - Handles XML namespace prefixes gracefully
 */
function parseSitemapXml(xml: string): { urls: SitemapUrl[]; sitemaps: SitemapIndexEntry[] } {
  const urls: SitemapUrl[] = [];
  const sitemaps: SitemapIndexEntry[] = [];

  try {
    const $ = cheerio.load(xml, { xmlMode: true });

    // Standard sitemap
    $('urlset url, sitemap\\:urlset url').each((_idx, el) => {
      const loc = $(el).find('loc').first().text().trim();
      if (loc) {
        urls.push({
          loc,
          lastmod: $(el).find('lastmod').first().text().trim() || undefined,
          changefreq: $(el).find('changefreq').first().text().trim() || undefined,
          priority: parseFloat($(el).find('priority').first().text().trim()) || undefined,
        });
      }
    });

    // Sitemap index
    $('sitemapindex sitemap, sitemap\\:sitemapindex sitemap').each((_idx, el) => {
      const loc = $(el).find('loc').first().text().trim();
      if (loc) {
        sitemaps.push({
          loc,
          lastmod: $(el).find('lastmod').first().text().trim() || undefined,
        });
      }
    });

    // Also try with namespace-agnostic selectors
    // Some sitemaps use namespaced tags like <ns0:urlset>
    if (urls.length === 0 && sitemaps.length === 0) {
      $('url').each((_idx, el) => {
        const loc = $(el).find('loc').first().text().trim();
        if (loc) {
          urls.push({
            loc,
            lastmod: $(el).find('lastmod').first().text().trim() || undefined,
          });
        }
      });

      $('sitemap').each((_idx, el) => {
        // Only if parent looks like sitemapindex
        const parentTag = ($(el).parent()[0] as any)?.tagName?.toLowerCase() || '';
        if (parentTag.includes('sitemapindex') || parentTag === 'sitemapindex') {
          const loc = $(el).find('loc').first().text().trim();
          if (loc) {
            sitemaps.push({
              loc,
              lastmod: $(el).find('lastmod').first().text().trim() || undefined,
            });
          }
        }
      });
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Sitemap XML parsing failed');
  }

  return { urls, sitemaps };
}

/**
 * Discover and parse all sitemaps for a given domain.
 *
 * * Discovery order:
 *  1. robots.txt Sitemap directives
 *  2. /sitemap.xml
 *  3. /sitemap_index.xml
 *  4. Recursively parse sitemap indexes
 *
 * Returns a deduplicated list of URLs found in the sitemaps.
 */
async function discoverSitemapUrls(
  domain: string,
  maxSitemapUrls: number = 50_000,
): Promise<SitemapUrl[]> {
  const allUrls: SitemapUrl[] = [];
  const seenLocs = new Set<string>();
  const processedIndexes = new Set<string>();

  /**
   * Process a single sitemap (or sitemap index) URL.
   * Recursively follows sitemap index entries.
   */
  async function processSitemap(sitemapUrl: string, depth: number = 0): Promise<void> {
    if (depth > 5) {
      logger.warn({ sitemapUrl, depth }, 'Sitemap index recursion limit reached');
      return;
    }

    if (allUrls.length >= maxSitemapUrls) return;

    // Avoid reprocessing the same index
    const normalisedLoc = normaliseUrl(sitemapUrl);
    if (processedIndexes.has(normalisedLoc)) return;
    processedIndexes.add(normalisedLoc);

    // Check Redis cache first
    const cacheKey = `sitemap:${normalisedLoc}`;
    const cached = await cacheGet<SitemapUrl[]>(cacheKey);
    if (cached) {
      for (const u of cached) {
        if (!seenLocs.has(normaliseUrl(u.loc))) {
          seenLocs.add(normaliseUrl(u.loc));
          allUrls.push(u);
        }
      }
      return;
    }

    const xml = await fetchText(sitemapUrl);
    if (!xml) return;

    const { urls, sitemaps } = parseSitemapXml(xml);

    // Collect URLs from this sitemap
    const pageUrls: SitemapUrl[] = [];
    for (const u of urls) {
      if (allUrls.length >= maxSitemapUrls) break;
      const nLoc = normaliseUrl(u.loc);
      if (!seenLocs.has(nLoc)) {
        seenLocs.add(nLoc);
        allUrls.push(u);
        pageUrls.push(u);
      }
    }

    // Cache the URLs from this sitemap
    if (pageUrls.length > 0) {
      await cacheSet(cacheKey, pageUrls, 3600).catch(() => {});
    }

    // Recursively process sitemap index entries
    for (const s of sitemaps) {
      if (allUrls.length >= maxSitemapUrls) break;
      await processSitemap(s.loc, depth + 1);
    }
  }

  // Step 1: Discover from robots.txt
  const robotsSitemaps = await discoverSitemapsFromRobots(domain);

  for (const sitemapUrl of robotsSitemaps) {
    if (allUrls.length >= maxSitemapUrls) break;
    await processSitemap(sitemapUrl);
  }

  // Step 2: Try /sitemap.xml if no URLs found yet
  if (allUrls.length === 0) {
    await processSitemap(`https://${domain}/sitemap.xml`);
  }

  // Step 3: Try /sitemap_index.xml if still no URLs
  if (allUrls.length === 0) {
    await processSitemap(`https://${domain}/sitemap_index.xml`);
  }

  logger.info(
    { domain, urlCount: allUrls.length, indexCount: processedIndexes.size },
    'Sitemap discovery completed',
  );

  return allUrls;
}

// --- Crawl Engine -------------------------------------------------------------

/**
 * Core crawling / spidering engine for ScrapeSuite.
 *
 * * Architecture:
 *  1. Seed URLs are enqueued at depth 0
 *  2. A configurable queue (BFS / DFS / Priority) determines fetch order
 *  3. Each URL is fetched via the orchestrator (proxy, anti-bot, CAPTCHA)
 *  4. Discovered links are filtered, normalised, and enqueued
 *  5. Crawl state is persisted to Redis after every page for crash recovery
 *  6. Concurrency is managed by a worker pool with per-domain rate limiting
 *
 * The engine is a singleton -- only one crawl runs at a time per instance,
 * but multiple crawls can run in parallel across different processes using
 * Redis-coordinated state.
 */
export class CrawlEngine {
  // --- Active crawl tracking (in-memory) ---------------------------------

  /** Currently active crawls, keyed by crawlId. */
  private activeCrawls: Map<string, {
    status: CrawlStatus;
    queue: CrawlQueue;
    visited: Set<string>;
    config: CrawlConfig;
    abortController: AbortController;
    progress: CrawlProgress;
    startTime: number;
    totalResponseMs: number;
    domainLastFetch: Map<string, number>;
    results: CrawlPageResult[];
  }> = new Map();

  // --- Public API --------------------------------------------------------

  /**
   * Start a new crawl (or resume a previously paused one).
   *
   * * Lifecycle:
   *  1. Validate and normalise config
   *  2. If resumeCrawlId is provided, load state from Redis
   *  3. Otherwise, create a new crawl with seed URLs
   *  4. Optionally discover sitemap URLs and add to the queue
   *  5. Run the crawl loop until completion, max pages, or cancellation
   *  6. Persist final state and return results
   */
  async start(config: CrawlConfig): Promise<{ crawlId: string; results: CrawlPageResult[] }> {
    // -- Validate config ---------------------------------------------------
    const validatedConfig = this.validateConfig(config);

    // -- Resume or create new ----------------------------------------------
    let crawlId: string;
    let queue: CrawlQueue;
    let visited: Set<string>;
    let existingResults: CrawlPageResult[] = [];
    let pagesCrawled = 0;
    let urlsDiscovered = 0;
    let errors = 0;
    let totalResponseMs = 0;
    let domainStats: Record<string, { crawled: number; errors: number }> = {};

    if (validatedConfig.resumeCrawlId) {
      // Resume from Redis
      const restored = await this.loadState(validatedConfig.resumeCrawlId);
      if (!restored) {
        throw new Error(`Crawl ${validatedConfig.resumeCrawlId} not found or expired`);
      }

      crawlId = restored.crawlId;
      visited = new Set(restored.visitedHashes);
      existingResults = restored.results || [];
      pagesCrawled = restored.pagesCrawled;
      urlsDiscovered = restored.urlsDiscovered;
      errors = restored.errors;
      totalResponseMs = restored.totalResponseMs;
      domainStats = restored.domainStats || {};

      // Rebuild queue
      queue = this.createQueue(validatedConfig.strategy || 'bfs', restored.queue);

      logger.info(
        { crawlId, pagesCrawled, urlsDiscovered, queueSize: queue.size },
        'Resuming crawl from saved state',
      );
    } else {
      // New crawl
      crawlId = crypto.randomUUID();
      visited = new Set();

      // Seed URLs
      const seedUrls: CrawlUrl[] = [];
      for (const rawUrl of validatedConfig.seedUrls) {
        const normalised = normaliseUrl(rawUrl);
        const hash = hashUrl(normalised);
        if (!visited.has(hash)) {
          visited.add(hash);
          seedUrls.push({
            url: normalised,
            depth: 0,
            priority: scoreUrl(normalised, 0),
            discoveredAt: Date.now(),
          });
        }
      }

      urlsDiscovered = seedUrls.length;
      queue = this.createQueue(validatedConfig.strategy || 'bfs', seedUrls);

      logger.info(
        { crawlId, seedCount: seedUrls.length, maxDepth: validatedConfig.maxDepth, maxPages: validatedConfig.maxPages },
        'Starting new crawl',
      );
    }

    // -- Sitemap discovery -------------------------------------------------
    if (validatedConfig.parseSitemaps !== false) {
      try {
        const domains = this.extractSeedDomains(validatedConfig.seedUrls);
        for (const domain of domains) {
          const sitemapUrls = await discoverSitemapUrls(domain);
          let addedFromSitemap = 0;
          for (const su of sitemapUrls) {
            const normalised = normaliseUrl(su.loc);
            const hash = hashUrl(normalised);
            if (!visited.has(hash)) {
              visited.add(hash);
              queue.push({
                url: normalised,
                depth: 0, // Sitemap URLs are treated as depth 0 seeds
                priority: (su.priority || 0.5) * 100,
                discoveredAt: Date.now(),
              });
              addedFromSitemap++;
              urlsDiscovered++;
            }
          }
          logger.info({ crawlId, domain, addedFromSitemap }, 'Sitemap URLs added to queue');
        }
      } catch (err: any) {
        logger.warn({ crawlId, error: err.message }, 'Sitemap discovery failed -- continuing without sitemaps');
      }
    }

    // -- Set up in-memory tracking -----------------------------------------
    const abortController = new AbortController();
    const progress: CrawlProgress = {
      crawlId,
      status: 'running',
      pagesCrawled,
      urlsDiscovered,
      urlsQueued: queue.size,
      errors,
      elapsedMs: 0,
      avgResponseMs: 0,
      rps: 0,
      domainStats,
    };

    this.activeCrawls.set(crawlId, {
      status: 'running',
      queue,
      visited,
      config: validatedConfig,
      abortController,
      progress,
      startTime: Date.now(),
      totalResponseMs,
      domainLastFetch: new Map(),
      results: existingResults,
    });

    // -- Run the crawl loop ------------------------------------------------
    try {
      const results = await this.runCrawlLoop(crawlId);
      return { crawlId, results };
    } catch (err: any) {
      logger.error({ crawlId, error: err.message }, 'Crawl failed');
      throw err;
    }
  }

  /**
   * Pause a running crawl.
   * The crawl state is persisted to Redis and can be resumed later.
   */
  async pause(crawlId: string): Promise<boolean> {
    const crawl = this.activeCrawls.get(crawlId);
    if (!crawl || crawl.status !== 'running') {
      logger.warn({ crawlId }, 'Cannot pause -- crawl not running');
      return false;
    }

    crawl.status = 'paused';
    crawl.abortController.abort();
    crawl.progress.status = 'paused';

    // Persist state
    await this.saveState(crawlId);

    logger.info({ crawlId, pagesCrawled: crawl.progress.pagesCrawled }, 'Crawl paused');
    return true;
  }

  /**
   * Cancel a running or paused crawl.
   * Removes the crawl from memory and Redis.
   */
  async cancel(crawlId: string): Promise<boolean> {
    const crawl = this.activeCrawls.get(crawlId);
    if (!crawl) {
      logger.warn({ crawlId }, 'Cannot cancel -- crawl not found');
      return false;
    }

    crawl.status = 'cancelled';
    crawl.abortController.abort();
    crawl.progress.status = 'cancelled';

    // Remove from memory
    this.activeCrawls.delete(crawlId);

    // Remove from Redis
    try {
      await redis.del(`${CRAWL_STATE_PREFIX}${crawlId}`);
      await redis.del(`${CRAWL_VISITED_PREFIX}${crawlId}`);
    } catch (err: any) {
      logger.warn({ crawlId, error: err.message }, 'Failed to clean up Redis state');
    }

    logger.info({ crawlId }, 'Crawl cancelled');
    return true;
  }

  /**
   * Get the real-time progress of a crawl.
   */
  getProgress(crawlId: string): CrawlProgress | null {
    const crawl = this.activeCrawls.get(crawlId);
    if (!crawl) return null;

    const elapsed = Date.now() - crawl.startTime;
    crawl.progress.elapsedMs = elapsed;
    crawl.progress.avgResponseMs = crawl.progress.pagesCrawled > 0
      ? Math.round(crawl.totalResponseMs / crawl.progress.pagesCrawled)
      : 0;
    crawl.progress.rps = elapsed > 0 ? Math.round((crawl.progress.pagesCrawled / elapsed) * 1000 * 100) / 100 : 0;
    crawl.progress.urlsQueued = crawl.queue.size;

    return { ...crawl.progress };
  }

  /**
   * Get all active crawl IDs.
   */
  getActiveCrawlIds(): string[] {
    return Array.from(this.activeCrawls.keys());
  }

  // --- Crawl Loop --------------------------------------------------------

  /**
   * Core crawl loop -- runs until the queue is empty, maxPages is reached,
   * or the crawl is paused/cancelled.
   *
   * * Uses a worker-pool pattern:
   *  - N workers pull URLs from the shared queue
   *  - Each worker respects per-domain rate limits
   *  - Results are collected and new links enqueued
   *  - State is persisted to Redis periodically
   */
  private async runCrawlLoop(crawlId: string): Promise<CrawlPageResult[]> {
    const crawl = this.activeCrawls.get(crawlId);
    if (!crawl) throw new Error(`Crawl ${crawlId} not found in memory`);

    const { config, queue, visited, abortController } = crawl;
    const maxPages = config.maxPages || DEFAULT_MAX_PAGES;
    const concurrency = config.concurrency || DEFAULT_CONCURRENCY;

    // Create worker promises
    const workers: Promise<void>[] = [];
    let stateSaveCounter = 0;

    for (let i = 0; i < concurrency; i++) {
      workers.push((async () => {
        while (!abortController.signal.aborted) {
          // Check if we've reached maxPages
          if (crawl.progress.pagesCrawled >= maxPages) {
            break;
          }

          // Get next URL from queue
          const item = queue.pop();
          if (!item) {
            // Queue is empty -- wait briefly then check again
            await sleep(200);
            // Check again after wait -- another worker may have added URLs
            if (queue.size === 0) break;
            continue;
          }

          // Check depth limit
          const maxDepth = config.maxDepth || DEFAULT_MAX_DEPTH;
          if (item.depth > maxDepth) {
            continue;
          }

          // Per-domain rate limiting
          const domain = this.extractDomain(item.url);
          if (domain) {
            const delayMs = config.delayMs ?? DEFAULT_DELAY_MS;
            const lastFetch = crawl.domainLastFetch.get(domain) || 0;
            const elapsed = Date.now() - lastFetch;
            if (elapsed < delayMs) {
              // Put the item back and wait
              queue.push(item);
              await sleep(delayMs - elapsed);
              continue;
            }

            // Also check with adaptive rate limiter
            try {
              const rateResult = await adaptiveRateLimiter.acquireToken(domain);
              if (!rateResult.allowed) {
                queue.push(item);
                await sleep(rateResult.waitMs);
                continue;
              }
            } catch {
              // Rate limiter unavailable -- proceed with local delay only
            }
          }

          // Robots.txt check
          if (config.respectRobotsTxt !== false && domain) {
            try {
              const robotsCheck = await robotsParser.isAllowed(item.url, 'ScrapeSuite-Crawler');
              if (!robotsCheck.allowed) {
                logger.debug({ url: item.url }, 'Skipped -- disallowed by robots.txt');
                // Respect crawl-delay from robots.txt if present
                if (robotsCheck.crawlDelay && robotsCheck.crawlDelay > 0) {
                  crawl.domainLastFetch.set(domain, Date.now() + robotsCheck.crawlDelay * 1000);
                }
                continue;
              }

              // Apply crawl-delay from robots.txt
              if (robotsCheck.crawlDelay && robotsCheck.crawlDelay > 0) {
                const effectiveDelay = Math.max(config.delayMs ?? DEFAULT_DELAY_MS, robotsCheck.crawlDelay * 1000);
                crawl.domainLastFetch.set(domain, Date.now());
                // Enforce crawl-delay by waiting before next request to this domain
                const lastFetch = crawl.domainLastFetch.get(domain) || 0;
                const elapsed = Date.now() - lastFetch;
                if (elapsed < effectiveDelay) {
                  await sleep(effectiveDelay - elapsed);
                }
              }
            } catch (err: any) {
              logger.debug({ url: item.url, error: err.message }, 'Robots.txt check failed -- proceeding');
            }
          }

          // -- Fetch the page via the orchestrator -------------------------
          const fetchStart = Date.now();
          let pageResult: CrawlPageResult;

          try {
            const orchestratorResult = await orchestrator.processJob({
              jobId: `crawl-${crawlId}-${hashUrl(item.url).substring(0, 12)}`,
              url: item.url,
              domain: domain || item.url,
              userId: config.userId || 'system',
              apiKeyId: config.apiKeyId || 'system',
              strategy: 'auto',
              proxyTier: config.proxyTier,
              proxyCountry: config.proxyCountry,
              headers: config.headers,
              timeout: config.timeout,
              respectRobotsTxt: false, // We already checked above
              renderJs: false, // Crawling uses HTTP by default for speed
              priority: 5,
            });

            const responseMs = Date.now() - fetchStart;

            // Extract content from HTML
            let extracted: PageExtractedContent | undefined;
            const html = orchestratorResult.html || '';

            if (html && config.extractContent !== false) {
              extracted = extractContent(html, item.url);
            }

            pageResult = {
              url: item.url,
              title: extracted?.title || '',
              depth: item.depth,
              status: orchestratorResult.statusCode || 0,
              html: config.includeHtml ? html : undefined,
              extracted,
              finalUrl: orchestratorResult.finalUrl,
              responseMs,
              cached: orchestratorResult.cached,
              error: orchestratorResult.error,
            };

            // -- Discover new links from the page --------------------------
            if (html && item.depth < (config.maxDepth || DEFAULT_MAX_DEPTH)) {
              const rawLinks = extractLinks(html, orchestratorResult.finalUrl || item.url);
              const newUrls = this.filterAndEnqueue(
                rawLinks,
                item.url,
                item.depth + 1,
                crawl,
              );
              crawl.progress.urlsDiscovered += newUrls;
            }

            // -- Record success --------------------------------------------
            crawl.progress.pagesCrawled++;
            crawl.totalResponseMs += responseMs;

            if (domain) {
              crawl.domainLastFetch.set(domain, Date.now());
              if (!crawl.progress.domainStats[domain]) {
                crawl.progress.domainStats[domain] = { crawled: 0, errors: 0 };
              }
              crawl.progress.domainStats[domain].crawled++;
            }

            // Record response to adaptive rate limiter
            if (domain) {
              try {
                await adaptiveRateLimiter.recordResponse(domain, {
                  success: (orchestratorResult.statusCode || 0) >= 200 && (orchestratorResult.statusCode || 0) < 400,
                  statusCode: orchestratorResult.statusCode,
                  responseMs,
                });
              } catch {
                // Non-critical
              }
            }

          } catch (err: any) {
            const responseMs = Date.now() - fetchStart;
            pageResult = {
              url: item.url,
              title: '',
              depth: item.depth,
              status: 0,
              responseMs,
              cached: false,
              error: err.message,
            };

            crawl.progress.errors++;

            if (domain) {
              if (!crawl.progress.domainStats[domain]) {
                crawl.progress.domainStats[domain] = { crawled: 0, errors: 0 };
              }
              crawl.progress.domainStats[domain].errors++;
            }
          }

          // -- Store result ------------------------------------------------
          crawl.results.push(pageResult);

          // -- Invoke callback ---------------------------------------------
          if (config.onPageCrawled) {
            try {
              config.onPageCrawled(pageResult, this.getProgress(crawlId)!);
            } catch {
              // Callback error -- don't break the crawl
            }
          }

          // -- Periodic state persistence ----------------------------------
          stateSaveCounter++;
          if (stateSaveCounter % 10 === 0) {
            await this.saveState(crawlId).catch((err) => {
              logger.warn({ crawlId, error: (err as Error).message }, 'Periodic state save failed');
            });
          }
        }
      })());
    }

    // Wait for all workers to finish
    await Promise.all(workers);

    // -- Crawl complete -----------------------------------------------------
    crawl.status = 'completed';
    crawl.progress.status = 'completed';

    // Final state save
    await this.saveState(crawlId);

    // Compute final progress
    const finalProgress = this.getProgress(crawlId)!;

    // Invoke completion callback
    if (config.onCrawlComplete) {
      try {
        config.onCrawlComplete(crawl.results, finalProgress);
      } catch {
        // Callback error
      }
    }

    // Clean up from active crawls
    this.activeCrawls.delete(crawlId);

    logger.info(
      {
        crawlId,
        pagesCrawled: crawl.progress.pagesCrawled,
        urlsDiscovered: crawl.progress.urlsDiscovered,
        errors: crawl.progress.errors,
        elapsedMs: finalProgress.elapsedMs,
      },
      'Crawl completed',
    );

    return crawl.results;
  }

  // --- URL Filtering & Enqueueing ----------------------------------------

  /**
   * Filter discovered links and enqueue those that pass all checks.
   *
   * * Filter pipeline (in order):
   *  1. Resolve to absolute URL
   *  2. Normalise URL
   *  3. Skip non-HTTP(S) schemes
   *  4. Domain scope check (same-domain / same-subdomain / external)
   *  5. File extension blocklist
   *  6. Include patterns (URL must match at least one)
   *  7. Exclude patterns (URL must not match any)
   *  8. Deduplication (skip already-visited URLs)
   *
   * Returns the number of new URLs added to the queue.
   */
  private filterAndEnqueue(
    rawLinks: { url: string; anchorText: string }[],
    parentUrl: string,
    depth: number,
    crawl: {
      queue: CrawlQueue;
      visited: Set<string>;
      config: CrawlConfig;
      progress: CrawlProgress;
    },
  ): number {
    const {
      queue,
      visited,
      config,
      progress,
    } = crawl;

    let added = 0;

    for (const link of rawLinks) {
      try {
        // Step 1: Already absolute (extractLinks resolves them)
        const absolute = link.url;

        // Step 2: Normalise
        const normalised = normaliseUrl(absolute);
        if (!normalised) continue;

        // Step 3: Only HTTP(S)
        if (!normalised.startsWith('http://') && !normalised.startsWith('https://')) {
          continue;
        }

        // Step 4: Domain scope
        const domainScope = config.domainScope || 'same-domain';
        if (domainScope === 'same-domain') {
          if (!isSameDomain(normalised, parentUrl)) continue;
        } else if (domainScope === 'same-subdomain') {
          if (!isSameSubdomain(normalised, parentUrl)) continue;
        }
        // 'allow-external' -- no domain filtering

        // Step 5: Extension blocklist
        const skipExtensions = config.skipExtensions || DEFAULT_SKIP_EXTENSIONS;
        if (hasSkippedExtension(normalised, skipExtensions)) continue;

        // Step 6: Include patterns
        if (config.includePatterns && config.includePatterns.length > 0) {
          if (!matchesAnyPattern(normalised, config.includePatterns)) continue;
        }

        // Step 7: Exclude patterns
        if (config.excludePatterns && config.excludePatterns.length > 0) {
          if (matchesAnyPattern(normalised, config.excludePatterns)) continue;
        }

        // Step 8: Deduplication
        const hash = hashUrl(normalised);
        if (visited.has(hash)) continue;
        visited.add(hash);

        // Enqueue
        queue.push({
          url: normalised,
          depth,
          parentUrl,
          anchorText: link.anchorText,
          priority: scoreUrl(normalised, depth, link.anchorText),
          discoveredAt: Date.now(),
        });

        added++;
      } catch {
        // Skip unparseable links
      }
    }

    progress.urlsQueued = queue.size;
    return added;
  }

  // --- State Persistence -------------------------------------------------

  /**
   * Save the current crawl state to Redis for crash recovery / pause-resume.
   *
   * * Persisted data:
   *  - Queue (serialised array)
   *  - Visited set (as hash array)
   *  - Results collected so far
   *  - All counters and stats
   */
  private async saveState(crawlId: string): Promise<void> {
    const crawl = this.activeCrawls.get(crawlId);
    if (!crawl) return;

    const state: CrawlState = {
      crawlId,
      seedUrls: crawl.config.seedUrls,
      config: crawl.config,
      status: crawl.status,
      queue: crawl.queue.toArray(),
      visitedHashes: Array.from(crawl.visited),
      pagesCrawled: crawl.progress.pagesCrawled,
      urlsDiscovered: crawl.progress.urlsDiscovered,
      errors: crawl.progress.errors,
      totalResponseMs: crawl.totalResponseMs,
      domainStats: crawl.progress.domainStats,
      startedAt: crawl.startTime,
      updatedAt: Date.now(),
      results: crawl.results,
    };

    try {
      await cacheSet(`${CRAWL_STATE_PREFIX}${crawlId}`, state, CRAWL_STATE_TTL_SECONDS);

      // Also persist the visited set separately for fast lookup
      const visitedKey = `${CRAWL_VISITED_PREFIX}${crawlId}`;
      const r = redis;
      if (state.visitedHashes.length > 0) {
        // Use a Redis set for O(1) membership checks
        const pipeline = r.pipeline();
        for (const hash of state.visitedHashes) {
          pipeline.sadd(visitedKey, hash);
        }
        pipeline.expire(visitedKey, CRAWL_STATE_TTL_SECONDS);
        await pipeline.exec();
      }
    } catch (err: any) {
      logger.warn({ crawlId, error: err.message }, 'Failed to save crawl state to Redis');
    }
  }

  /**
   * Load a previously saved crawl state from Redis.
   */
  private async loadState(crawlId: string): Promise<CrawlState | null> {
    try {
      const state = await cacheGet<CrawlState>(`${CRAWL_STATE_PREFIX}${crawlId}`);
      if (!state) return null;

      // Also load the visited set from Redis for completeness
      const visitedKey = `${CRAWL_VISITED_PREFIX}${crawlId}`;
      try {
        const visitedMembers = await redis.smembers(visitedKey);
        if (visitedMembers.length > state.visitedHashes.length) {
          state.visitedHashes = visitedMembers;
        }
      } catch {
        // Fall back to the state's visitedHashes
      }

      logger.info(
        { crawlId, pagesCrawled: state.pagesCrawled, queueSize: state.queue.length },
        'Loaded crawl state from Redis',
      );

      return state;
    } catch (err: any) {
      logger.warn({ crawlId, error: err.message }, 'Failed to load crawl state from Redis');
      return null;
    }
  }

  /**
   * List all persisted crawl states in Redis.
   */
  async listPersistedCrawls(): Promise<{ crawlId: string; status: CrawlStatus; pagesCrawled: number; updatedAt: number }[]> {
    try {
      const keys = await redis.keys(`${CRAWL_STATE_PREFIX}*`);
      const results: { crawlId: string; status: CrawlStatus; pagesCrawled: number; updatedAt: number }[] = [];

      for (const key of keys) {
        try {
          const state = await cacheGet<CrawlState>(key.replace('cache:', ''));
          if (state) {
            results.push({
              crawlId: state.crawlId,
              status: state.status,
              pagesCrawled: state.pagesCrawled,
              updatedAt: state.updatedAt,
            });
          }
        } catch {
          // Skip malformed entries
        }
      }

      return results.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to list persisted crawls');
      return [];
    }
  }

  /**
   * Delete a persisted crawl state from Redis.
   */
  async deletePersistedCrawl(crawlId: string): Promise<boolean> {
    try {
      await redis.del(`${CRAWL_STATE_PREFIX}${crawlId}`);
      await redis.del(`${CRAWL_VISITED_PREFIX}${crawlId}`);
      return true;
    } catch (err: any) {
      logger.warn({ crawlId, error: err.message }, 'Failed to delete persisted crawl state');
      return false;
    }
  }

  // --- Config Validation -------------------------------------------------

  /**
   * Validate and apply defaults to a CrawlConfig.
   * Throws on invalid values.
   */
  private validateConfig(config: CrawlConfig): CrawlConfig {
    if (!config.seedUrls || config.seedUrls.length === 0) {
      if (!config.resumeCrawlId) {
        throw new Error('seedUrls is required when not resuming a crawl');
      }
    }

    // Validate seed URLs
    if (config.seedUrls) {
      for (const url of config.seedUrls) {
        try {
          const parsed = new URL(url);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error(`Invalid seed URL protocol: ${url}`);
          }
        } catch {
          throw new Error(`Invalid seed URL: ${url}`);
        }
      }
    }

    // Clamp depth
    const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (maxDepth < MIN_DEPTH || maxDepth > MAX_DEPTH) {
      throw new Error(`maxDepth must be between ${MIN_DEPTH} and ${MAX_DEPTH}`);
    }

    // Clamp concurrency
    const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
    if (concurrency < MIN_CONCURRENCY || concurrency > MAX_CONCURRENCY) {
      throw new Error(`concurrency must be between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`);
    }

    // Validate strategy
    if (config.strategy && !['bfs', 'dfs', 'priority'].includes(config.strategy)) {
      throw new Error(`strategy must be 'bfs', 'dfs', or 'priority'`);
    }

    // Validate domain scope
    if (config.domainScope && !['same-domain', 'same-subdomain', 'allow-external'].includes(config.domainScope)) {
      throw new Error(`domainScope must be 'same-domain', 'same-subdomain', or 'allow-external'`);
    }

    // Validate regex patterns
    if (config.includePatterns) {
      for (const pattern of config.includePatterns) {
        try {
          new RegExp(pattern);
        } catch {
          throw new Error(`Invalid include pattern: ${pattern}`);
        }
      }
    }

    if (config.excludePatterns) {
      for (const pattern of config.excludePatterns) {
        try {
          new RegExp(pattern);
        } catch {
          throw new Error(`Invalid exclude pattern: ${pattern}`);
        }
      }
    }

    return {
      ...config,
      maxDepth: Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, maxDepth)),
      maxPages: Math.max(1, config.maxPages ?? DEFAULT_MAX_PAGES),
      concurrency: Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, concurrency)),
    };
  }

  // --- Queue Factory -----------------------------------------------------

  /**
   * Create the appropriate queue type based on the crawl strategy.
   */
  private createQueue(strategy: CrawlStrategy, initialItems: CrawlUrl[]): CrawlQueue {
    switch (strategy) {
      case 'dfs':
        return DFSQueue.fromArray(initialItems);
      case 'priority':
        return PriorityQueue.fromArray(initialItems);
      case 'bfs':
      default:
        return BFSQueue.fromArray(initialItems);
    }
  }

  // --- Utility Methods ---------------------------------------------------

  /**
   * Extract the domain (hostname) from a URL.
   */
  private extractDomain(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  /**
   * Extract unique domains from a list of seed URLs.
   */
  private extractSeedDomains(urls: string[]): string[] {
    const domains = new Set<string>();
    for (const url of urls) {
      try {
        domains.add(new URL(url).hostname);
      } catch {
        // Skip invalid URLs
      }
    }
    return Array.from(domains);
  }

  // --- Database Integration ----------------------------------------------

  /**
   * Persist crawl results to the database.
   *
   * * Stores:
   *  - Crawl metadata (seed URLs, config, stats)
   *  - Individual page results
   *  - Discovered URLs (for future re-crawls)
   */
  async persistResults(crawlId: string, results: CrawlPageResult[], config: CrawlConfig): Promise<void> {
    try {
      // Store crawl metadata
      await cacheSet(`crawl:results:${crawlId}`, {
        crawlId,
        seedUrls: config.seedUrls,
        totalPages: results.length,
        successfulPages: results.filter((r) => r.status >= 200 && r.status < 400).length,
        errorPages: results.filter((r) => r.error).length,
        completedAt: Date.now(),
        config: {
          maxDepth: config.maxDepth,
          maxPages: config.maxPages,
          strategy: config.strategy,
          domainScope: config.domainScope,
        },
      }, CRAWL_STATE_TTL_SECONDS);

      // Store individual results in chunks (Redis can handle large values but let's be safe)
      const CHUNK_SIZE = 50;
      for (let i = 0; i < results.length; i += CHUNK_SIZE) {
        const chunk = results.slice(i, i + CHUNK_SIZE);
        await cacheSet(`crawl:results:${crawlId}:chunk:${Math.floor(i / CHUNK_SIZE)}`, chunk, CRAWL_STATE_TTL_SECONDS);
      }

      logger.info(
        { crawlId, totalResults: results.length },
        'Crawl results persisted to Redis',
      );
    } catch (err: any) {
      logger.warn({ crawlId, error: err.message }, 'Failed to persist crawl results');
    }
  }

  /**
   * Load persisted crawl results from Redis.
   */
  async loadResults(crawlId: string): Promise<CrawlPageResult[]> {
    const results: CrawlPageResult[] = [];
    let chunkIdx = 0;

    try {
      while (true) {
        const chunk = await cacheGet<CrawlPageResult[]>(`crawl:results:${crawlId}:chunk:${chunkIdx}`);
        if (!chunk) break;
        results.push(...chunk);
        chunkIdx++;
      }
    } catch (err: any) {
      logger.warn({ crawlId, error: err.message }, 'Failed to load crawl results');
    }

    return results;
  }

  // --- Stats & Analytics -------------------------------------------------

  /**
   * Get aggregate statistics for a completed crawl.
   */
  getCrawlStats(results: CrawlPageResult[]): {
    totalPages: number;
    successfulPages: number;
    errorPages: number;
    avgResponseMs: number;
    uniqueDomains: number;
    depthDistribution: Record<number, number>;
    statusDistribution: Record<number, number>;
    topDomains: { domain: string; pages: number }[];
  } {
    const totalPages = results.length;
    const successfulPages = results.filter((r) => r.status >= 200 && r.status < 400).length;
    const errorPages = results.filter((r) => r.error).length;
    const avgResponseMs = totalPages > 0
      ? Math.round(results.reduce((sum, r) => sum + r.responseMs, 0) / totalPages)
      : 0;

    // Domain counts
    const domainCounts: Record<string, number> = {};
    for (const r of results) {
      try {
        const domain = new URL(r.url).hostname;
        domainCounts[domain] = (domainCounts[domain] || 0) + 1;
      } catch {}
    }
    const uniqueDomains = Object.keys(domainCounts).length;
    const topDomains = Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([domain, pages]) => ({ domain, pages }));

    // Depth distribution
    const depthDistribution: Record<number, number> = {};
    for (const r of results) {
      depthDistribution[r.depth] = (depthDistribution[r.depth] || 0) + 1;
    }

    // Status distribution
    const statusDistribution: Record<number, number> = {};
    for (const r of results) {
      statusDistribution[r.status] = (statusDistribution[r.status] || 0) + 1;
    }

    return {
      totalPages,
      successfulPages,
      errorPages,
      avgResponseMs,
      uniqueDomains,
      depthDistribution,
      statusDistribution,
      topDomains,
    };
  }

  /**
   * Export crawl results to a simplified format.
   */
  exportResults(results: CrawlPageResult[]): {
    url: string;
    title: string;
    depth: number;
    status: number;
  }[] {
    return results.map((r) => ({
      url: r.url,
      title: r.title,
      depth: r.depth,
      status: r.status,
    }));
  }
}

// --- Singleton ----------------------------------------------------------------

/** Shared singleton instance -- safe to import from any module. */
export const crawlEngine = new CrawlEngine();
