/**
 * Reddit Rate Limiter Evader -- ScrapeSuite Engine
 *
 * Evades Reddit's rate limiting by implementing:
 *   - Adaptive pacing based on x-ratelimit-* response headers
 *   - Exponential backoff with jitter on 429 responses
 *   - Burst detection and proactive throttling
 *   - Request distribution across time windows
 *   - Per-domain rate limit state tracking
 *
 * Reddit rate limits (as of 2024):
 *   - OAuth endpoints: 60 requests/minute (authenticated)
 *   - Unauthenticated: 10 requests/minute
 *   - Search: ~3-5 requests/minute (more aggressive)
 *   - x-ratelimit-remaining: requests left in current window
 *   - x-ratelimit-reset: seconds until window resets
 *   - x-ratelimit-used: requests used in current window
 *
 * Strategy: Stay well below visible limits to avoid triggering
 * secondary detection heuristics that Reddit applies server-side.
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type { RedditRateLimitConfig, RedditRateLimitState } from './types';
import { DEFAULT_REDDIT_CONFIG } from './types';

const logger = createChildLogger('reddit-rate-limiter');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Safety margin: never use more than this fraction of the allowed rate */
const SAFETY_FACTOR = 0.75;

/** Minimum delay between requests regardless of config (ms) */
const MIN_ABSOLUTE_DELAY_MS = 500;

/** Backoff multiplier for exponential backoff */
const BACKOFF_MULTIPLIER = 2.0;

/** Maximum burst threshold before proactive throttle */
const BURST_DETECTION_THRESHOLD = 4;

/** Time window for burst detection (ms) */
const BURST_WINDOW_MS = 2000;

/** Cache key prefix for rate limit state persistence */
const CACHE_KEY_PREFIX = 'reddit:ratelimit:';

/** Cache TTL for rate limit state (seconds) */
const CACHE_TTL_SECONDS = 300;

// ===============================================================================
// RATE LIMITER EVADER
// ===============================================================================

export class RateLimiterEvader {
  private config: RedditRateLimitConfig;
  private domainStates = new Map<string, RedditRateLimitState>();
  private initialized = false;
  private stats = {
    totalDelaysComputed: 0,
    totalRateLimitHeaders: 0,
    totalBackoffs: 0,
    totalBurstDetections: 0,
    totalDistributions: 0,
    avgDelayMs: 0,
  };

  constructor(config?: Partial<RedditRateLimitConfig>) {
    this.config = { ...DEFAULT_REDDIT_CONFIG.rateLimit, ...config };
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Initialize the rate limiter evader.
   * Loads cached rate limit states from Redis for known domains.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Reddit rate limiter evader...');

    try {
      // Pre-populate known Reddit domains
      const knownDomains = [
        'www.reddit.com',
        'old.reddit.com',
        'api.reddit.com',
        'oauth.reddit.com',
        'ssl.reddit.com',
        ' gql.reddit.com',
      ];

      for (const domain of knownDomains) {
        const cached = await cacheGet<RedditRateLimitState>(`${CACHE_KEY_PREFIX}${domain}`);
        if (cached) {
          this.domainStates.set(domain, cached);
          logger.debug({ domain, remaining: cached.remaining }, 'Restored rate limit state from cache');
        } else {
          this.domainStates.set(domain, this.createDefaultState(domain.trim()));
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to load cached rate limit states, using defaults');
      // Create default states for core domains
      this.domainStates.set('www.reddit.com', this.createDefaultState('www.reddit.com'));
      this.domainStates.set('old.reddit.com', this.createDefaultState('old.reddit.com'));
      this.domainStates.set('api.reddit.com', this.createDefaultState('api.reddit.com'));
      this.domainStates.set('oauth.reddit.com', this.createDefaultState('oauth.reddit.com'));
    }

    this.initialized = true;
    logger.info({ domainCount: this.domainStates.size }, 'Reddit rate limiter evader initialized');
  }

  // ===========================================================================
  // DELAY COMPUTATION
  // ===========================================================================

  /**
   * Compute a human-like delay between requests for a given domain.
   *
   * The delay is calculated based on:
   *   1. Base delay from configuration
   *   2. Adaptive adjustment from x-ratelimit-* headers
   *   3. Burst detection penalty
   *   4. Exponential backoff if in cooldown
   *   5. Random jitter for humanization
   *
   * @param domain - The Reddit domain being requested
   * @param recentRequests - Array of recent request timestamps for burst detection
   * @returns Delay in milliseconds before the next request
   */
  computeDelay(domain: string, recentRequests: Array<{ timestamp: number; endpoint: string }>): number {
    const state = this.getOrCreateState(domain);
    let delay = this.config.baseDelayMs;

    // --- Factor 1: Rate limit header awareness ---
    if (this.config.adaptiveMode && state.remaining <= this.config.throttleThreshold) {
      // Approaching the limit: increase delay proportionally
      const throttleFactor = Math.max(
        1.0,
        (this.config.throttleThreshold / Math.max(state.remaining, 1)) * 1.5
      );
      delay = delay * throttleFactor;
      logger.debug({
        domain,
        remaining: state.remaining,
        throttleFactor: throttleFactor.toFixed(2),
        adjustedDelay: Math.round(delay),
      }, 'Throttling due to low remaining quota');
    }

    // --- Factor 2: Time until window reset ---
    const now = Date.now();
    const resetIn = (state.resetAt * 1000) - now;
    if (resetIn > 0 && state.remaining <= this.config.throttleThreshold) {
      // Spread remaining requests across the rest of the window
      const msPerRequest = resetIn / Math.max(state.remaining, 1);
      delay = Math.max(delay, msPerRequest * SAFETY_FACTOR);
    }

    // --- Factor 3: Burst detection ---
    const recentInWindow = recentRequests.filter(
      r => (now - r.timestamp) < BURST_WINDOW_MS
    );
    if (recentInWindow.length >= BURST_DETECTION_THRESHOLD) {
      delay *= BACKOFF_MULTIPLIER;
      state.burstCounter++;
      state.lastBurstAt = now;
      this.stats.totalBurstDetections++;
      logger.debug({
        domain,
        recentCount: recentInWindow.length,
        burstCounter: state.burstCounter,
      }, 'Burst detected, increasing delay');
    }

    // --- Factor 4: Exponential backoff (if in cooldown) ---
    if (state.backoffLevel > 0) {
      const backoffDelay = Math.min(
        this.config.baseDelayMs * Math.pow(BACKOFF_MULTIPLIER, state.backoffLevel),
        this.config.maxBackoffMs
      );
      delay = Math.max(delay, backoffDelay);
      logger.debug({
        domain,
        backoffLevel: state.backoffLevel,
        backoffDelay: Math.round(backoffDelay),
      }, 'Applying exponential backoff');
    }

    // --- Factor 5: Search endpoint multiplier ---
    const isSearchEndpoint = recentRequests.some(
      r => r.endpoint.includes('/search') || r.endpoint.includes('/search.json')
    );
    if (isSearchEndpoint) {
      delay *= this.config.searchDelayMultiplier;
    }

    // --- Factor 6: Jitter for humanization ---
    const jitter = Math.random() * this.config.jitterRangeMs;
    delay += jitter;

    // --- Enforce minimum ---
    delay = Math.max(delay, MIN_ABSOLUTE_DELAY_MS);

    // --- Record in state ---
    state.recentRequests.push({
      timestamp: now,
      endpoint: isSearchEndpoint ? '/search' : '/generic',
      method: 'GET',
    });

    // Prune old entries from recent requests (keep last 5 minutes)
    const cutoff = now - 300000;
    state.recentRequests = state.recentRequests.filter(r => r.timestamp > cutoff);

    // Update stats
    this.stats.totalDelaysComputed++;
    this.stats.avgDelayMs = this.stats.totalDelaysComputed > 0
      ? (this.stats.avgDelayMs * (this.stats.totalDelaysComputed - 1) + delay) / this.stats.totalDelaysComputed
      : delay;

    // Persist state
    this.persistState(domain).catch(() => {});

    logger.debug({
      domain,
      computedDelay: Math.round(delay),
      remaining: state.remaining,
      backoffLevel: state.backoffLevel,
      burstCounter: state.burstCounter,
    }, 'Computed request delay');

    return Math.round(delay);
  }

  // ===========================================================================
  // RATE LIMIT HEADER HANDLING
  // ===========================================================================

  /**
   * Parse Reddit's rate limit headers from a response and adapt the evader state.
   *
   * Reddit returns these headers on every API response:
   *   - x-ratelimit-remaining: Number of requests remaining in the current window
   *   - x-ratelimit-reset: Seconds until the rate limit window resets
   *   - x-ratelimit-used: Number of requests used in the current window
   *
   * @param headers - Response headers from a Reddit API call
   * @returns Updated rate limit state for the domain
   */
  handleRateLimitResponse(headers: Record<string, string | undefined>): RedditRateLimitState {
    this.stats.totalRateLimitHeaders++;

    const remaining = this.parseHeaderNumber(headers['x-ratelimit-remaining']);
    const resetSeconds = this.parseHeaderNumber(headers['x-ratelimit-reset']);
    const used = this.parseHeaderNumber(headers['x-ratelimit-used']);

    // Determine domain from the headers context — default to www.reddit.com
    const domain = this.inferDomainFromHeaders(headers) || 'www.reddit.com';
    const state = this.getOrCreateState(domain);

    // Update state from headers
    if (!isNaN(remaining)) {
      state.remaining = remaining;
    }
    if (!isNaN(resetSeconds)) {
      state.resetAt = Math.floor(Date.now() / 1000) + resetSeconds;
    }
    if (!isNaN(used)) {
      state.used = used;
    }

    // Detect if we're approaching limits
    if (state.remaining <= 0) {
      // Hard limit hit — enter cooldown
      state.isThrottled = true;
      state.cooldownUntil = Date.now() + (resetSeconds * 1000) + 5000; // Extra 5s safety
      state.backoffLevel = Math.min(state.backoffLevel + 1, 6);
      this.stats.totalBackoffs++;

      logger.warn({
        domain,
        remaining: state.remaining,
        resetIn: resetSeconds,
        backoffLevel: state.backoffLevel,
      }, 'Rate limit exhausted, entering cooldown');
    } else if (state.remaining <= this.config.throttleThreshold) {
      // Approaching limit — proactively throttle
      state.isThrottled = true;
      logger.info({
        domain,
        remaining: state.remaining,
        resetIn: resetSeconds,
      }, 'Approaching rate limit, proactively throttling');
    } else {
      // Healthy rate limit — reduce backoff if previously throttled
      if (state.backoffLevel > 0 && state.remaining > this.config.throttleThreshold * 2) {
        state.backoffLevel = Math.max(0, state.backoffLevel - 1);
        logger.debug({
          domain,
          backoffLevel: state.backoffLevel,
          remaining: state.remaining,
        }, 'Reducing backoff level');
      }
      state.isThrottled = false;
    }

    // Persist updated state
    this.persistState(domain).catch(() => {});

    logger.debug({
      domain,
      remaining: state.remaining,
      used: state.used,
      resetIn: resetSeconds,
      isThrottled: state.isThrottled,
      backoffLevel: state.backoffLevel,
    }, 'Rate limit headers processed');

    return { ...state };
  }

  // ===========================================================================
  // REQUEST DISTRIBUTION
  // ===========================================================================

  /**
   * Distribute a batch of requests evenly across a time window to avoid
   * burst patterns that trigger Reddit's behavioral detection.
   *
   * Uses a jittered uniform distribution with minimum spacing guarantees.
   *
   * @param requests - Array of request descriptors to schedule
   * @param windowMs - Time window in milliseconds to distribute across
   * @returns Array of requests with computed delays
   */
  distributeRequests<T extends { endpoint: string; method: string }>(
    requests: T[],
    windowMs: number
  ): Array<T & { scheduledDelayMs: number; scheduledAt: number }> {
    this.stats.totalDistributions++;
    const result: Array<T & { scheduledDelayMs: number; scheduledAt: number }> = [];

    if (requests.length === 0) return result;

    const now = Date.now();

    // Calculate the minimum spacing between requests
    const minSpacing = Math.max(
      this.config.baseDelayMs,
      windowMs / (requests.length * 2) // Ensure we don't exceed half the window with spacing alone
    );

    // Calculate available time for scheduling (accounting for minimum spacing)
    const totalSpacingNeeded = minSpacing * (requests.length - 1);
    const remainingTime = Math.max(0, windowMs - totalSpacingNeeded);

    // Generate evenly-spaced anchor points with jitter
    const anchors: number[] = [];
    if (requests.length === 1) {
      anchors.push(now + this.randomBetween(1000, Math.min(5000, windowMs)));
    } else {
      for (let i = 0; i < requests.length; i++) {
        const baseOffset = totalSpacingNeeded > 0
          ? (i / (requests.length - 1)) * totalSpacingNeeded
          : 0;
        // Add proportional jitter
        const jitterMax = remainingTime / requests.length;
        const jitter = Math.random() * jitterMax;
        anchors.push(now + baseOffset + jitter);
      }
    }

    // Sort anchors to ensure chronological order
    anchors.sort((a, b) => a - b);

    // Build scheduled requests
    let previousScheduled = now;
    for (let i = 0; i < requests.length; i++) {
      const scheduledAt = Math.max(anchors[i], previousScheduled + minSpacing);
      const delay = Math.max(0, scheduledAt - previousScheduled);

      // Search endpoints get extra delay
      const isSearch = requests[i].endpoint.includes('/search');
      const finalDelay = isSearch ? delay * this.config.searchDelayMultiplier : delay;

      result.push({
        ...requests[i],
        scheduledDelayMs: Math.round(Math.max(MIN_ABSOLUTE_DELAY_MS, finalDelay)),
        scheduledAt: Math.round(scheduledAt),
      });

      previousScheduled = scheduledAt;
    }

    logger.debug({
      requestCount: requests.length,
      windowMs,
      totalScheduledMs: result.length > 0
        ? Math.round(result[result.length - 1].scheduledAt - now)
        : 0,
      avgDelayMs: result.length > 0
        ? Math.round(result.reduce((sum, r) => sum + r.scheduledDelayMs, 0) / result.length)
        : 0,
    }, 'Requests distributed across window');

    return result;
  }

  // ===========================================================================
  // CONCURRENCY OPTIMIZATION
  // ===========================================================================

  /**
   * Determine the optimal number of concurrent requests for a given domain.
   *
   * Based on:
   *   - Current rate limit remaining
   *   - Backoff level
   *   - Burst history
   *   - Domain-specific behavior patterns
   *
   * @param domain - The Reddit domain to query
   * @returns Optimal number of concurrent requests (1-based)
   */
  getOptimalConcurrency(domain: string): number {
    const state = this.getOrCreateState(domain);

    // If throttled or in cooldown, reduce to 1
    if (state.isThrottled || Date.now() < state.cooldownUntil) {
      logger.debug({ domain }, 'Rate limited, concurrency reduced to 1');
      return 1;
    }

    // If backoff is active, reduce concurrency
    if (state.backoffLevel > 0) {
      const reduced = Math.max(1, this.config.maxConcurrentRequests - state.backoffLevel);
      logger.debug({ domain, backoffLevel: state.backoffLevel, concurrency: reduced }, 'Backoff active, reducing concurrency');
      return reduced;
    }

    // If approaching rate limit, reduce concurrency
    if (state.remaining <= this.config.throttleThreshold * 2) {
      const reduced = Math.max(1, Math.floor(this.config.maxConcurrentRequests / 2));
      logger.debug({ domain, remaining: state.remaining, concurrency: reduced }, 'Approaching limit, reducing concurrency');
      return reduced;
    }

    // If burst history is concerning, reduce
    if (state.burstCounter >= 3) {
      const reduced = Math.max(1, this.config.maxConcurrentRequests - 1);
      logger.debug({ domain, burstCounter: state.burstCounter, concurrency: reduced }, 'Burst history, reducing concurrency');
      return reduced;
    }

    // Search endpoints: always lower concurrency
    const recentSearches = state.recentRequests.filter(
      r => r.endpoint.includes('/search')
    ).length;
    if (recentSearches > 2) {
      logger.debug({ domain, recentSearches }, 'Recent search-heavy, capping concurrency at 2');
      return Math.min(2, this.config.maxConcurrentRequests);
    }

    return this.config.maxConcurrentRequests;
  }

  // ===========================================================================
  // STATE MANAGEMENT
  // ===========================================================================

  /**
   * Get the current rate limit state for a domain.
   */
  getState(domain: string): RedditRateLimitState | null {
    const state = this.domainStates.get(domain);
    return state ? { ...state } : null;
  }

  /**
   * Check if a domain is currently in rate-limit cooldown.
   */
  isInCooldown(domain: string): boolean {
    const state = this.domainStates.get(domain);
    if (!state) return false;
    return Date.now() < state.cooldownUntil || state.isThrottled;
  }

  /**
   * Reset the rate limit state for a domain (e.g. after a successful window reset).
   */
  resetState(domain: string): void {
    const state = this.getOrCreateState(domain);
    state.backoffLevel = 0;
    state.isThrottled = false;
    state.cooldownUntil = 0;
    state.burstCounter = 0;
    state.recentRequests = [];
    logger.info({ domain }, 'Rate limit state reset');
    this.persistState(domain).catch(() => {});
  }

  /**
   * Record that a 429 response was received, escalating the backoff.
   */
  record429(domain: string): void {
    const state = this.getOrCreateState(domain);
    state.backoffLevel = Math.min(state.backoffLevel + 1, 6);
    state.isThrottled = true;
    state.cooldownUntil = Date.now() + this.config.cooldownMs * Math.pow(BACKOFF_MULTIPLIER, state.backoffLevel - 1);
    state.remaining = 0;
    this.stats.totalBackoffs++;

    logger.warn({
      domain,
      backoffLevel: state.backoffLevel,
      cooldownMs: state.cooldownUntil - Date.now(),
    }, '429 received, escalating backoff');

    this.persistState(domain).catch(() => {});
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get rate limiter statistics.
   */
  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      domainStates: Array.from(this.domainStates.entries()).map(([domain, state]) => ({
        domain,
        remaining: state.remaining,
        backoffLevel: state.backoffLevel,
        isThrottled: state.isThrottled,
        recentRequestCount: state.recentRequests.length,
      })),
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Get or create a rate limit state for a domain.
   */
  private getOrCreateState(domain: string): RedditRateLimitState {
    let state = this.domainStates.get(domain);
    if (!state) {
      state = this.createDefaultState(domain);
      this.domainStates.set(domain, state);
    }
    return state;
  }

  /**
   * Create a default rate limit state for a new domain.
   * Starts with generous limits and adapts based on actual headers.
   */
  private createDefaultState(domain: string): RedditRateLimitState {
    const isOAuth = domain.includes('oauth');
    const defaultRemaining = isOAuth
      ? this.config.oauthRequestsPerMinute
      : this.config.unauthenticatedRequestsPerMinute;

    return {
      domain,
      remaining: defaultRemaining,
      used: 0,
      resetAt: Math.floor(Date.now() / 1000) + 60,
      recentRequests: [],
      backoffLevel: 0,
      cooldownUntil: 0,
      burstCounter: 0,
      lastBurstAt: 0,
      isThrottled: false,
    };
  }

  /**
   * Parse a numeric value from a rate limit header.
   * Handles float values (Reddit sometimes returns "59.0").
   */
  private parseHeaderNumber(value: string | undefined): number {
    if (!value) return NaN;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? NaN : Math.round(parsed);
  }

  /**
   * Attempt to infer the Reddit domain from response headers.
   * Falls back to www.reddit.com if indeterminable.
   */
  private inferDomainFromHeaders(headers: Record<string, string | undefined>): string | null {
    // Check for explicit domain hints
    const serverHeader = headers['server'] || headers['Server'];
    if (serverHeader?.includes('reddit')) {
      // Check for origin or referer headers
      const origin = headers['origin'] || headers['Origin'];
      if (origin) {
        try {
          return new URL(origin).hostname;
        } catch { /* fall through */ }
      }
    }
    return null;
  }

  /**
   * Persist rate limit state to Redis for cross-session awareness.
   */
  private async persistState(domain: string): Promise<void> {
    const state = this.domainStates.get(domain);
    if (!state) return;

    try {
      await cacheSet(`${CACHE_KEY_PREFIX}${domain}`, state, CACHE_TTL_SECONDS);
    } catch (err: any) {
      logger.debug({ domain, err: err.message }, 'Failed to persist rate limit state');
    }
  }

  /**
   * Generate a random integer between min and max (inclusive).
   */
  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const rateLimiterEvader = new RateLimiterEvader();
