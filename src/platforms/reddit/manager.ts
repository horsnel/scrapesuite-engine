/**
 * Reddit Platform Manager -- ScrapeSuite Engine
 *
 * Orchestrates all Reddit anti-bot counter-measures:
 *   - Rate limit evasion with adaptive pacing
 *   - Realistic browsing simulation (scroll, vote, navigate)
 *   - OAuth2 API authentication and token management
 *   - Cloudflare + Reddit-specific detection handling
 *   - Session lifecycle management
 *   - Unified statistics and monitoring
 *
 * Usage:
 *   const manager = new RedditManager();
 *   await manager.initialize();
 *   const session = await manager.prepareSession();
 *   const data = await manager.scrapeListing('https://www.reddit.com/r/programming/hot');
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import { db } from '../../utils/db';
import { RateLimiterEvader, rateLimiterEvader } from './rate-limiter-evader';
import { ScrollVoter, scrollVoter } from './scroll-voter';
import { RedditApiAdapter, redditApiAdapter } from './api-adapter';
import { rssAdapter } from './rss-adapter';
import type {
  RedditManagerConfig,
  RedditManagerStats,
  RedditSessionProfile,
  RedditBrowsingSession,
  RedditListingParseResult,
  RedditScrapeTarget,
  RedditAuthResult,
  RedditRssEntry,
  RedditRssFetchResult,
} from './types';
import { DEFAULT_REDDIT_CONFIG, DEFAULT_REDDIT_STATS } from './types';

const logger = createChildLogger('reddit-manager');

// ===============================================================================
// REDDIT PLATFORM MANAGER
// ===============================================================================

export class RedditManager {
  private config: RedditManagerConfig;
  private rateLimiter: RateLimiterEvader;
  private scrollVoterEngine: ScrollVoter;
  private apiAdapter: RedditApiAdapter;
  private initialized = false;
  private stats: RedditManagerStats;
  private activeSessions = new Map<string, RedditBrowsingSession>();
  private requestTimestamps: number[] = [];
  private rssRequestTimestamps: number[] = [];
  private tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<RedditManagerConfig>) {
    this.config = { ...DEFAULT_REDDIT_CONFIG, ...config };
    this.rateLimiter = rateLimiterEvader;
    this.scrollVoterEngine = scrollVoter;
    this.apiAdapter = redditApiAdapter;
    this.stats = { ...DEFAULT_REDDIT_STATS };
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Initialize the Reddit Platform Manager.
   *
   * Sets up all sub-engines:
   *   1. Rate limiter evader — loads cached rate limit states
   *   2. API adapter — authenticates with Reddit OAuth2
   *   3. Scroll voter — ready for browsing simulation
   *   4. Token auto-refresh — starts background refresh timer
   *
   * Should be called once before any scraping operations.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Reddit Platform Manager...');

    try {
      // Initialize sub-engines
      await this.rateLimiter.initialize();
      await this.apiAdapter.initialize();

      // Load cached stats from Redis
      const cachedStats = await cacheGet<RedditManagerStats>('reddit:manager:stats');
      if (cachedStats) {
        this.stats = { ...cachedStats };
        logger.debug('Restored manager stats from cache');
      }

      // Start auto-refresh timer for OAuth tokens
      if (this.config.api.autoRefreshTokens) {
        this.startTokenAutoRefresh();
      }

      this.initialized = true;
      logger.info({
        rateLimiterReady: true,
        apiAdapterReady: this.apiAdapter.isTokenValid(),
        sessionPoolSize: this.config.sessionPoolSize,
        proxyTier: this.config.proxyTier,
      }, 'Reddit Platform Manager initialized');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to initialize Reddit Platform Manager');
      throw err;
    }
  }

  // ===========================================================================
  // SESSION PREPARATION
  // ===========================================================================

  /**
   * Prepare a complete Reddit scraping session with anti-detection measures.
   *
   * Creates a session profile with:
   *   - Consistent browser fingerprint
   *   - OAuth2 token (if available)
   *   - Rate limit state for the target domain
   *   - Pre-computed interaction patterns
   *   - Proper cookies and headers
   *
   * @param options - Session preparation options
   * @returns Session profile and configuration ready for scraping
   */
  async prepareSession(options?: {
    target?: RedditScrapeTarget;
    subreddit?: string;
    useOAuth?: boolean;
    redditVariant?: 'new' | 'old';
    proxyTier?: 'residential' | 'datacenter' | 'mobile';
  }): Promise<{
    profile: RedditSessionProfile;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    rateLimitState: {
      domain: string;
      remaining: number;
      isThrottled: boolean;
    };
    authValid: boolean;
  }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const target = options?.target || 'listing';
    const subreddit = options?.subreddit || this.config.api.defaultSubreddit;
    const useOAuth = options?.useOAuth ?? true;
    const redditVariant = options?.redditVariant || (this.config.api.preferOldReddit ? 'old' : 'new');

    logger.info({
      target,
      subreddit,
      useOAuth,
      redditVariant,
    }, 'Preparing Reddit scraping session');

    // Generate a browsing session with realistic behavior patterns
    const browsingSession = this.scrollVoterEngine.generateBrowsingSession();

    // Build session profile
    const profile: RedditSessionProfile = {
      ...browsingSession.profile,
      redditVariant,
      useJsonApi: this.config.api.useJsonApi,
      isLoggedIn: useOAuth && this.apiAdapter.isTokenValid(),
    };

    // Build request headers
    const headers = this.apiAdapter.buildOAuthHeaders();

    // Build cookies
    const cookies: Record<string, string> = {
      ...profile.cookies,
      'reddit_session': profile.sessionId,
      'theme': redditVariant === 'old' ? 'old' : 'new',
    };

    if (profile.isLoggedIn) {
      cookies['token_v2'] = this.apiAdapter.getAccessToken() || '';
    }

    // Get rate limit state for the target domain
    const domain = redditVariant === 'old' ? 'old.reddit.com' : 'www.reddit.com';
    const rateLimitState = this.rateLimiter.getState(domain);
    const rateLimitInfo = rateLimitState
      ? { domain: rateLimitState.domain, remaining: rateLimitState.remaining, isThrottled: rateLimitState.isThrottled }
      : { domain, remaining: this.config.rateLimit.oauthRequestsPerMinute, isThrottled: false };

    // Store the active session
    this.activeSessions.set(profile.sessionId, browsingSession);
    this.stats.activeSessions = this.activeSessions.size;

    logger.info({
      sessionId: profile.sessionId,
      isLoggedIn: profile.isLoggedIn,
      rateLimitRemaining: rateLimitInfo.remaining,
      isThrottled: rateLimitInfo.isThrottled,
    }, 'Reddit scraping session prepared');

    return {
      profile,
      headers,
      cookies,
      rateLimitState: rateLimitInfo,
      authValid: this.apiAdapter.isTokenValid(),
    };
  }

  // ===========================================================================
  // LISTING SCRAPING
  // ===========================================================================

  /**
   * Scrape a Reddit listing with full anti-detection measures.
   *
   * Performs:
   *   1. URL parsing and validation
   *   2. Rate limit check and delay computation
   *   3. Request building with proper authentication
   *   4. Rate limit header processing from response
   *   5. Statistics tracking
   *
   * @param url - Reddit listing URL to scrape
   * @param options - Scraping options
   * @returns Scraped data with metadata
   */
  async scrapeListing(
    url: string,
    options?: {
      useOAuth?: boolean;
      maxPages?: number;
      after?: string;
      /** Fetch mode: 'json' (default, needs OAuth or a non-blocked IP) or 'rss' (public Atom feeds). */
      mode?: 'json' | 'rss';
      /** RSS mode: entry limit passed to the feed (1-100). */
      rssLimit?: number;
      /** RSS mode: max retries on 429 / network errors. */
      rssMaxRetries?: number;
      /** RSS mode: base delay for the 429 exponential backoff (ms). */
      rssRetryBaseDelayMs?: number;
    }
  ): Promise<{
    success: boolean;
    data: any;
    parseResult: RedditListingParseResult;
    rateLimitRemaining: number;
    pagesScraped: number;
    errors: string[];
  }> {
    if (options?.mode === 'rss') {
      const rss = await this.scrapeListingRss(url, {
        limit: options.rssLimit,
        maxRetries: options.rssMaxRetries,
        retryBaseDelayMs: options.rssRetryBaseDelayMs,
      });
      return {
        success: rss.success,
        data: rss.success
          ? { feedUrl: rss.feedUrl, feedTitle: rss.feedTitle, entries: rss.entries }
          : null,
        parseResult: rss.parseResult,
        rateLimitRemaining: rss.rateLimitRemaining,
        pagesScraped: rss.success ? 1 : 0,
        errors: rss.errors,
      };
    }

    if (!this.initialized) {
      await this.initialize();
    }

    const errors: string[] = [];
    const maxPages = options?.maxPages || 1;

    // Step 1: Parse the URL
    const parseResult = this.apiAdapter.parseListingUrl(url);
    if (!parseResult.valid) {
      errors.push(`Invalid Reddit URL: ${url}`);
      return {
        success: false,
        data: null,
        parseResult,
        rateLimitRemaining: 0,
        pagesScraped: 0,
        errors,
      };
    }

    // Step 2: Determine the domain
    const domain = parseResult.isOldReddit ? 'old.reddit.com' : 'www.reddit.com';

    // Step 3: Check rate limits
    if (this.rateLimiter.isInCooldown(domain)) {
      errors.push(`Domain ${domain} is in rate limit cooldown`);
      logger.warn({ domain, url }, 'Cannot scrape: domain in cooldown');
      return {
        success: false,
        data: null,
        parseResult,
        rateLimitRemaining: 0,
        pagesScraped: 0,
        errors,
      };
    }

    // Step 4: Compute delay
    const recentRequests = this.requestTimestamps.map(t => ({
      timestamp: t,
      endpoint: url,
      method: 'GET',
    }));
    const delay = this.rateLimiter.computeDelay(domain, recentRequests);

    logger.info({
      url: url.substring(0, 100),
      domain,
      delayMs: delay,
      maxPages,
    }, 'Starting Reddit listing scrape');

    // Step 5: Wait for the computed delay
    await this.sleep(delay);

    // Step 6: Build the request
    const request = this.apiAdapter.buildRequest(
      parseResult.apiUrl,
      'GET',
      {
        useOAuth: options?.useOAuth ?? this.apiAdapter.isTokenValid(),
        useJsonApi: true,
        queryParams: options?.after ? { after: options.after } : undefined,
      }
    );

    // Step 7: Execute the request
    let data: any = null;
    let rateLimitRemaining = 0;
    let pagesScraped = 0;

    try {
      this.stats.totalRequests++;

      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
      });

      // Process rate limit headers from response
      const responseHeaders: Record<string, string | undefined> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const rlState = this.rateLimiter.handleRateLimitResponse(responseHeaders);
      rateLimitRemaining = rlState.remaining;

      // Record request timestamp
      this.requestTimestamps.push(Date.now());
      this.requestTimestamps = this.requestTimestamps.filter(t => Date.now() - t < 300000);

      if (response.status === 429) {
        // Rate limited
        this.stats.rateLimitEncounters++;
        this.rateLimiter.record429(domain);
        errors.push('Rate limited (429)');

        logger.warn({ domain, url, delay }, 'Rate limited during scrape');
        return {
          success: false,
          data: null,
          parseResult,
          rateLimitRemaining: 0,
          pagesScraped: 0,
          errors,
        };
      }

      if (response.status === 403) {
        // Cloudflare or Reddit-specific block
        this.stats.cloudflareEncounters++;
        this.stats.detectionEncounters++;
        this.stats.lastDetectionAt = Date.now();
        errors.push('Blocked (403) — Cloudflare or Reddit detection');

        logger.error({ domain, url }, 'Blocked during scrape (403)');
        return {
          success: false,
          data: null,
          parseResult,
          rateLimitRemaining,
          pagesScraped: 0,
          errors,
        };
      }

      if (!response.ok) {
        this.stats.failedRequests++;
        errors.push(`HTTP ${response.status}: ${response.statusText}`);

        return {
          success: false,
          data: null,
          parseResult,
          rateLimitRemaining,
          pagesScraped: 0,
          errors,
        };
      }

      data = await response.json();
      this.stats.successfulRequests++;
      pagesScraped = 1;

      // Track content type
      if (parseResult.subreddit) {
        this.stats.subredditsScraped++;
      }
      if (parseResult.postId) {
        this.stats.postsScraped++;
      }
      if (parseResult.searchQuery) {
        this.stats.searchesExecuted++;
      }

      logger.info({
        url: url.substring(0, 80),
        status: response.status,
        rateLimitRemaining,
        pagesScraped,
      }, 'Reddit listing scraped successfully');
    } catch (err: any) {
      this.stats.failedRequests++;
      errors.push(`Network error: ${err.message}`);

      logger.error({ err: err.message, url }, 'Error during Reddit listing scrape');
    }

    // Persist stats
    await this.persistStats();

    return {
      success: data !== null,
      data,
      parseResult,
      rateLimitRemaining,
      pagesScraped,
      errors,
    };
  }

  // ===========================================================================
  // RSS FETCH MODE
  // ===========================================================================

  /**
   * Scrape a Reddit listing via the public Atom (.rss) feed.
   *
   * Reddit's unauthenticated `.json` API is edge-blocked (403) for many
   * datacenter IPs, but the `.rss` feeds produced for feed readers remain
   * reachable from those same IPs. This path needs NO credentials and
   * yields titles, authors, permalinks, self-text HTML and comments —
   * but not scores or upvote ratios.
   *
   * Etiquette / pacing:
   *   - Honours the unauthenticated budget (default 10 req/min) with a
   *     sliding-window spacing of >= 6s between feed requests
   *   - Adds small human-like jitter on top of the deterministic spacing
   *   - On 429: records the hit in the shared RateLimiterEvader (backoff
   *     level + cooldown) and retries with exponential backoff
   *   - On 403: records a detection encounter and fails without retry
   *
   * @param url - Any Reddit listing / post / user / search URL
   * @param options - RSS fetch options
   */
  async scrapeListingRss(
    url: string,
    options?: {
      /** Entry limit passed to the feed (1-100, Reddit feed parameter). */
      limit?: number;
      /** Max retries on 429 / transient errors (default 2). */
      maxRetries?: number;
      /** Base delay for the 429 exponential backoff (default 30s). */
      retryBaseDelayMs?: number;
      /** Per-attempt fetch timeout (default 20s). */
      timeoutMs?: number;
      /** Enforce the 10 req/min sliding window (default true). */
      strictSpacing?: boolean;
    }
  ): Promise<{
    success: boolean;
    feedUrl: string | null;
    feedTitle: string | null;
    entries: RedditRssEntry[];
    entryCount: number;
    parseResult: RedditListingParseResult;
    rateLimitRemaining: number;
    attempts: number;
    errors: string[];
  }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const emptyResult = (
      errors: string[],
      parseResult: RedditListingParseResult,
      feedUrl: string | null = null,
      rateLimitRemaining = 0
    ) => ({
      success: false as const,
      feedUrl,
      feedTitle: null,
      entries: [] as RedditRssEntry[],
      entryCount: 0,
      parseResult,
      rateLimitRemaining,
      attempts: 0,
      errors,
    });

    // Step 1: Validate the URL through the shared parser
    const parseResult = this.apiAdapter.parseListingUrl(url);
    if (!parseResult.valid) {
      return emptyResult([`Invalid Reddit URL: ${url}`], parseResult);
    }

    // Step 2: Build the feed URL
    const feedUrl = rssAdapter.buildRssUrl(url, options?.limit);
    if (!feedUrl) {
      return emptyResult([`Cannot build RSS feed URL from: ${url}`], parseResult);
    }

    // Step 3: Cooldown check (shared IP-level state with the JSON path)
    const domain = 'www.reddit.com';
    if (this.rateLimiter.isInCooldown(domain)) {
      logger.warn({ domain, feedUrl }, 'RSS scrape refused: domain in cooldown');
      return emptyResult([`Domain ${domain} is in rate limit cooldown`], parseResult, feedUrl);
    }

    const maxRetries = options?.maxRetries ?? 2;
    const retryBaseDelayMs = options?.retryBaseDelayMs ?? 30_000;
    const errors: string[] = [];
    let rateLimitRemaining = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Pacing — feed-reader etiquette
      await this.enforceRssSpacing(options?.strictSpacing !== false);

      logger.info({
        feedUrl: feedUrl.substring(0, 100),
        attempt,
        maxRetries,
      }, 'Fetching Reddit RSS feed');

      const result = await rssAdapter.fetchAndParse(url, {
        limit: options?.limit,
        timeoutMs: options?.timeoutMs,
      });

      // A request is a request: record it for the sliding window
      this.rssRequestTimestamps.push(Date.now());
      this.rssRequestTimestamps = this.rssRequestTimestamps.filter(
        t => Date.now() - t < 60_000
      );
      this.stats.totalRequests++;

      // NOTE: RSS responses carry x-ratelimit-* headers describing the
      // UNAUTHENTICATED JSON pool, not the RSS path (from a blocked IP they
      // literally read remaining=0). Feeding them into the shared rate
      // limiter would poison the domain state and trigger phantom cooldowns,
      // so RSS pacing is handled exclusively by enforceRssSpacing() plus
      // record429() on real RSS 429 responses below.

      if (result.success) {
        this.stats.successfulRequests++;
        if (parseResult.subreddit) this.stats.subredditsScraped++;
        if (parseResult.postId) this.stats.postsScraped++;
        if (parseResult.searchQuery) this.stats.searchesExecuted++;

        logger.info({
          feedUrl: feedUrl.substring(0, 80),
          entries: result.entryCount,
          attempts: attempt + 1,
        }, 'Reddit RSS feed scraped successfully');

        await this.persistStats();

        return {
          success: true,
          feedUrl: result.feedUrl,
          feedTitle: result.feedTitle,
          entries: result.entries,
          entryCount: result.entryCount,
          parseResult,
          rateLimitRemaining,
          attempts: attempt + 1,
          errors: [...errors, ...result.errors],
        };
      }

      errors.push(...result.errors);
      const status = result.httpStatus;

      if (status === 429) {
        this.stats.rateLimitEncounters++;
        this.rateLimiter.record429(domain);

        if (attempt < maxRetries) {
          const backoff = retryBaseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 5_000);
          logger.warn({ feedUrl, attempt, backoffMs: backoff }, 'RSS rate limited (429) — backing off');
          await this.sleep(backoff);
          continue;
        }
        logger.error({ feedUrl }, 'RSS rate limited (429) — retries exhausted');
        break;
      }

      if (status === 403 || status === 401) {
        this.stats.cloudflareEncounters++;
        this.stats.detectionEncounters++;
        this.stats.lastDetectionAt = Date.now();
        logger.error({ feedUrl, status }, 'RSS feed blocked — not retrying');
        break;
      }

      // Network error / unexpected status — short backoff, then retry
      this.stats.failedRequests++;
      if (attempt < maxRetries) {
        const backoff = 5_000 * Math.pow(2, attempt) + Math.floor(Math.random() * 2_000);
        logger.warn({ feedUrl, status, attempt, backoffMs: backoff }, 'RSS transient failure — retrying');
        await this.sleep(backoff);
        continue;
      }
      break;
    }

    await this.persistStats();

    return {
      success: false,
      feedUrl,
      feedTitle: null,
      entries: [],
      entryCount: 0,
      parseResult,
      rateLimitRemaining,
      attempts: Math.min(maxRetries + 1, Math.max(1, this.rssRequestTimestamps.length)),
      errors,
    };
  }

  // ===========================================================================
  // RATE LIMIT EVASION
  // ===========================================================================

  /**
   * Handle a rate limit response by adapting the evader's state.
   *
   * Call this when a 429 response is received or when rate limit
   * headers indicate approaching limits. The evader will:
   *   - Increase backoff level
   *   - Enter cooldown period
   *   - Adjust future request timing
   *
   * @param response - The rate-limited response (with headers)
   * @returns Updated rate limit state
   */
  evadeRateLimit(response: {
    status: number;
    headers: Record<string, string | undefined>;
  }): {
    action: 'cooldown' | 'throttle' | 'backoff' | 'continue';
    delayMs: number;
    remaining: number;
    backoffLevel: number;
  } {
    const headers = response.headers;
    const domain = 'www.reddit.com'; // Default domain

    // Process rate limit headers
    const state = this.rateLimiter.handleRateLimitResponse(headers);

    this.stats.rateLimitEncounters++;

    if (response.status === 429) {
      // Hard rate limit — enter full cooldown
      this.rateLimiter.record429(domain);
      this.stats.rateLimitEvasions++;

      const cooldownMs = Math.max(
        this.config.rateLimit.cooldownMs,
        (state.resetAt * 1000) - Date.now() + 5000
      );

      logger.warn({
        domain,
        backoffLevel: state.backoffLevel,
        cooldownMs,
      }, 'Rate limit evasion: entering cooldown');

      return {
        action: 'cooldown',
        delayMs: cooldownMs,
        remaining: 0,
        backoffLevel: state.backoffLevel,
      };
    }

    if (state.remaining <= this.config.rateLimit.throttleThreshold) {
      // Approaching limit — proactively throttle
      const delayMs = this.rateLimiter.computeDelay(domain, []);

      logger.info({
        domain,
        remaining: state.remaining,
        delayMs,
      }, 'Rate limit evasion: proactive throttling');

      return {
        action: 'throttle',
        delayMs,
        remaining: state.remaining,
        backoffLevel: state.backoffLevel,
      };
    }

    if (state.backoffLevel > 0) {
      // In backoff state
      const delayMs = this.rateLimiter.computeDelay(domain, []);

      logger.debug({
        domain,
        backoffLevel: state.backoffLevel,
        delayMs,
      }, 'Rate limit evasion: backoff active');

      return {
        action: 'backoff',
        delayMs,
        remaining: state.remaining,
        backoffLevel: state.backoffLevel,
      };
    }

    // Healthy state — continue normally
    return {
      action: 'continue',
      delayMs: this.rateLimiter.computeDelay(domain, []),
      remaining: state.remaining,
      backoffLevel: 0,
    };
  }

  // ===========================================================================
  // BROWSING SIMULATION
  // ===========================================================================

  /**
   * Simulate realistic Reddit browsing behavior for a specified duration.
   *
   * This generates a complete browsing session with scroll patterns,
   * vote interactions, and navigation sequences. Can be used to:
   *   - Warm up a new session before scraping
   *   - Maintain session activity between scraping tasks
   *   - Generate cover traffic for anti-detection
   *
   * @param section - The Reddit section to simulate
   * @param duration - Target duration in milliseconds
   * @returns Generated browsing session with all interaction data
   */
  simulateBrowsing(
    section: RedditScrapeTarget,
    duration: number
  ): RedditBrowsingSession {
    logger.info({
      section,
      durationMs: duration,
    }, 'Starting Reddit browsing simulation');

    // Generate a session tailored to the target section and duration
    const session = this.scrollVoterEngine.generateBrowsingSession({
      sessionTiming: {
        minSessionDurationMs: duration,
        maxSessionDurationMs: duration,
        breakProbability: 0.1,
        breakDurationRange: { min: 5000, max: 30000 },
      },
      navigation: {
        ...this.config.interaction.navigation,
        clickIntoPostProbability: section === 'listing' ? 0.7 : section === 'comments' ? 0.9 : 0.3,
      },
    });

    // Track the session
    this.activeSessions.set(session.sessionId, session);
    this.stats.browsingSimulations++;
    this.stats.votesSimulated += session.votes.length;
    this.stats.scrollSequencesGenerated++;
    this.stats.activeSessions = this.activeSessions.size;

    logger.info({
      sessionId: session.sessionId,
      sectionsVisited: session.sectionsVisited.length,
      votesCount: session.votes.length,
      totalActions: session.sequence.actions.length,
      durationMs: session.totalDurationMs,
    }, 'Reddit browsing simulation completed');

    return session;
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get comprehensive statistics from the Reddit Platform Manager.
   *
   * Aggregates stats from all sub-engines:
   *   - Rate limiter evader
   *   - Scroll voter
   *   - API adapter
   *   - Session tracking
   */
  getStats(): RedditManagerStats {
    return {
      ...this.stats,
      activeSessions: this.activeSessions.size,
    };
  }

  /**
   * Get detailed stats from all sub-engines.
   */
  getDetailedStats(): {
    manager: RedditManagerStats;
    rateLimiter: Record<string, unknown>;
    scrollVoter: Record<string, unknown>;
    apiAdapter: Record<string, unknown>;
    rssAdapter: Record<string, unknown>;
  } {
    const rssStats = rssAdapter.getStats();
    return {
      manager: this.getStats(),
      rateLimiter: this.rateLimiter.getStats(),
      scrollVoter: this.scrollVoterEngine.getStats(),
      apiAdapter: this.apiAdapter.getStats(),
      rssAdapter: { ...rssStats },
    };
  }

  // ===========================================================================
  // SESSION MANAGEMENT
  // ===========================================================================

  /**
   * End an active scraping session.
   */
  endSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;

    session.isActive = false;
    session.endedAt = Date.now();
    this.activeSessions.delete(sessionId);
    this.stats.activeSessions = this.activeSessions.size;

    logger.info({
      sessionId,
      durationMs: session.endedAt - session.startedAt,
      votesCount: session.votes.length,
    }, 'Reddit scraping session ended');

    return true;
  }

  /**
   * Get an active session by ID.
   */
  getSession(sessionId: string): RedditBrowsingSession | null {
    return this.activeSessions.get(sessionId) || null;
  }

  /**
   * Get all active session IDs.
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  // ===========================================================================
  // AUTHENTICATION HELPERS
  // ===========================================================================

  /**
   * Authenticate with Reddit's OAuth2 API.
   *
   * @param clientId - Reddit app client ID
   * @param clientSecret - Reddit app client secret
   * @returns Authentication result
   */
  async authenticate(clientId: string, clientSecret: string): Promise<RedditAuthResult> {
    const result = await this.apiAdapter.authenticate(clientId, clientSecret);

    if (result.success) {
      this.stats.authSuccesses++;
    } else {
      this.stats.authFailures++;
      this.stats.detectionEncounters++;
      this.stats.lastDetectionAt = Date.now();
    }

    return result;
  }

  /**
   * Refresh the current OAuth2 token.
   */
  async refreshToken(): Promise<RedditAuthResult> {
    this.stats.tokenRefreshes++;
    return this.apiAdapter.refreshToken();
  }

  // ===========================================================================
  // CLEANUP
  // ===========================================================================

  /**
   * Shutdown the Reddit Platform Manager and clean up resources.
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Reddit Platform Manager...');

    // Stop token auto-refresh
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    // End all active sessions
    for (const sessionId of this.activeSessions.keys()) {
      this.endSession(sessionId);
    }

    // Persist final stats
    await this.persistStats();

    this.initialized = false;
    logger.info('Reddit Platform Manager shut down');
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Start the auto-refresh timer for OAuth tokens.
   */
  private startTokenAutoRefresh(): void {
    if (this.tokenRefreshTimer) return;

    const intervalMs = this.config.api.tokenRefreshIntervalSeconds * 1000;

    this.tokenRefreshTimer = setInterval(async () => {
      try {
        if (this.apiAdapter.isTokenValid()) {
          // Token is still valid, check if it will expire soon
          const auth = this.apiAdapter.getCurrentAuth();
          if (auth && auth.expiresAt - Date.now() < 600000) {
            // Less than 10 minutes until expiry — refresh
            logger.info('Auto-refreshing OAuth token (approaching expiry)');
            await this.refreshToken();
            this.stats.tokenRefreshes++;
          }
        } else if (this.config.api.refreshToken) {
          // Token is expired, try to refresh
          logger.info('Auto-refreshing expired OAuth token');
          await this.refreshToken();
          this.stats.tokenRefreshes++;
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Auto token refresh failed');
      }
    }, intervalMs);

    logger.debug({
      intervalSeconds: this.config.api.tokenRefreshIntervalSeconds,
    }, 'Token auto-refresh started');
  }

  /**
   * Persist manager statistics to Redis.
   */
  private async persistStats(): Promise<void> {
    try {
      await cacheSet('reddit:manager:stats', this.stats, 3600);
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Failed to persist manager stats');
    }
  }

  /**
   * Enforce feed-reader pacing for RSS fetches.
   *
   * Keeps a sliding 60s window of feed requests and ensures:
   *   - At least `60s / unauthenticatedRequestsPerMinute` (6s at the default
   *     budget of 10/min) between consecutive feed requests
   *   - At most `unauthenticatedRequestsPerMinute` requests inside the window
   *     (when strict), waiting out the oldest request otherwise
   *   - A small random jitter so request rhythm is not machine-regular
   */
  private async enforceRssSpacing(strict: boolean): Promise<void> {
    const now = Date.now();
    this.rssRequestTimestamps = this.rssRequestTimestamps.filter(t => now - t < 60_000);

    const perMinute = this.config.rateLimit.unauthenticatedRequestsPerMinute;
    const minGapMs = 60_000 / Math.max(1, perMinute);

    let waitMs = 0;
    if (this.rssRequestTimestamps.length > 0) {
      const last = this.rssRequestTimestamps[this.rssRequestTimestamps.length - 1];
      waitMs = Math.max(waitMs, last + minGapMs - now);
    }
    if (strict && this.rssRequestTimestamps.length >= perMinute) {
      const oldest = this.rssRequestTimestamps[0];
      waitMs = Math.max(waitMs, oldest + 60_000 - now + 250);
    }

    const jitter = Math.floor(Math.random() * 800);
    const totalMs = Math.max(0, waitMs) + jitter;
    if (totalMs > 0) {
      logger.debug({ waitMs: totalMs }, 'RSS pacing: waiting before feed fetch');
      await this.sleep(totalMs);
    }
  }

  /**
   * Sleep for a specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const redditManager = new RedditManager();
