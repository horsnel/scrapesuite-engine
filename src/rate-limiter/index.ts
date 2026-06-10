/**
 * Adaptive Rate Limiter -- Per-domain adaptive backoff with token-bucket burst support.
 *
 * Inspired by Bright Data's auto-throttle: the limiter learns from each HTTP
 * response and smoothly adjusts the safe requests-per-second for every domain
 * it encounters.  State is persisted in Redis so it survives worker restarts
 * and is shared across API + worker processes.
 *
 * Key features
 * ------------
 *  • Per-domain EMA-based rate adjustment (alpha = 0.15)
 *  • Token-bucket with burst (2× safeRps capacity, burst after 10 successes)
 *  • Cross-domain throttling on shared root domains
 *  • Smart escalating cooldowns (429 → 5 s / 30 s / 60 s, anti-bot 30 s, CAPTCHA 15 s)
 *  • Full Redis persistence + periodic stale-entry cleanup
 *  • Real-time status / metrics endpoints
 *
 * Usage
 * -----
 *   import { adaptiveRateLimiter } from './rate-limiter';
 *   const { allowed, waitMs, currentRps } = await adaptiveRateLimiter.acquireToken('api.example.com');
 *   if (!allowed) { await sleep(waitMs); }
 *   // … make the request …
 *   await adaptiveRateLimiter.recordResponse('api.example.com', { success: true, statusCode: 200, responseMs: 120 });
 */

import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('adaptive-rate-limiter');

// --- Constants ------------------------------------------------------------------

/** EMA smoothing factor -- lower = smoother / more conservative */
const EMA_ALPHA = 0.15;

/** Absolute floor for safeRps (requests per second) */
const MIN_RPS = 0.01;

/** Absolute ceiling for safeRps */
const MAX_RPS = 50;

/** Default safeRps for a domain we've never seen before */
const DEFAULT_RPS = 2;

/** Consecutive successes required before burst mode is unlocked */
const BURST_SUCCESS_THRESHOLD = 10;

/** Multiplier applied to safeRps to derive bucket capacity */
const BUCKET_CAPACITY_MULTIPLIER = 2;

/** Cooldown decay: after this many ms of clean requests, cooldown level resets */
const COOLDOWN_DECAY_MS = 5 * 60 * 1000; // 5 minutes

/** Redis TTL for domain state -- refreshed on every write */
const STATE_TTL_SECONDS = 3600 * 6; // 6 hours

/** How often the cleanup sweep runs (ms) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// --- Cooldown presets (ms) ------------------------------------------------------

const COOLDOWN_429: number[] = [5_000, 30_000, 60_000]; // 1st / 2nd / 3rd+
const COOLDOWN_ANTI_BOT = 30_000;
const COOLDOWN_CAPTCHA = 15_000;

// --- Types ----------------------------------------------------------------------

/** Shape of a single acquireToken result. */
export interface AcquireResult {
  /** Whether the request is allowed to proceed immediately. */
  allowed: boolean;
  /** Milliseconds to wait before retrying when `allowed` is false. */
  waitMs: number;
  /** Current safe RPS for the domain (after any adaptive adjustments). */
  currentRps: number;
}

/** Full status snapshot for a domain -- returned by `getDomainStatus`. */
export interface DomainRateStatus {
  domain: string;
  rootDomain: string;
  currentRps: number;
  safeRps: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  cooldownRemainingMs: number;
  isThrottled: boolean;
  /** Domain has been flagged for anti-bot detection. */
  isProtected: boolean;
  lastRequestAt: number;
  totalRequests: number;
  /** Rolling success rate (0–1). */
  successRate: number;
}

/** Internal state persisted in Redis under `ratelimit:state:{domain}`. */
interface DomainState {
  safeRps: number;
  emaRps: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  cooldownLevel429: number;           // 0-based index into COOLDOWN_429
  cooldownUntil: number;              // Unix-ms timestamp
  isProtected: boolean;
  lastSuccessAt: number;              // Unix-ms timestamp -- used for cooldown decay
  lastRequestAt: number;              // Unix-ms
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  avgResponseMs: number;              // Simple running average of response times
}

/** Token bucket state persisted in Redis under `ratelimit:bucket:{domain}`. */
interface BucketState {
  tokens: number;
  lastRefillAt: number; // Unix-ms
}

// --- Helpers --------------------------------------------------------------------

/**
 * Extract the root (registrable) domain from a hostname.
 *
 * Simple heuristic: take the last two dot-separated labels.
 *   api.www.example.com → example.com
 *   example.co.uk       → co.uk   (acceptable trade-off vs. a full PSL)
 */
function extractRootDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  if (parts.length <= 2) return hostname.toLowerCase();
  return parts.slice(-2).join('.');
}

/** Clamp a number between lo and hi inclusive. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Build a fresh DomainState with sensible defaults. */
function freshState(): DomainState {
  return {
    safeRps: DEFAULT_RPS,
    emaRps: DEFAULT_RPS,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    cooldownLevel429: 0,
    cooldownUntil: 0,
    isProtected: false,
    lastSuccessAt: 0,
    lastRequestAt: 0,
    totalRequests: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    avgResponseMs: 500,
  };
}

/** Build a fresh BucketState. */
function freshBucket(safeRps: number): BucketState {
  return {
    tokens: safeRps * BUCKET_CAPACITY_MULTIPLIER,
    lastRefillAt: Date.now(),
  };
}

// --- Redis helpers --------------------------------------------------------------

const STATE_PREFIX = 'ratelimit:state:';
const BUCKET_PREFIX = 'ratelimit:bucket:';

async function loadState(domain: string): Promise<DomainState | null> {
  try {
    return await cacheGet<DomainState>(`${STATE_PREFIX}${domain}`);
  } catch (err) {
    logger.warn({ domain, err: (err as Error).message }, 'Failed to load domain state from Redis');
    return null;
  }
}

async function saveState(domain: string, state: DomainState): Promise<void> {
  try {
    await cacheSet(`${STATE_PREFIX}${domain}`, state, STATE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ domain, err: (err as Error).message }, 'Failed to save domain state to Redis');
  }
}

async function loadBucket(domain: string): Promise<BucketState | null> {
  try {
    return await cacheGet<BucketState>(`${BUCKET_PREFIX}${domain}`);
  } catch (err) {
    logger.warn({ domain, err: (err as Error).message }, 'Failed to load bucket state from Redis');
    return null;
  }
}

async function saveBucket(domain: string, bucket: BucketState): Promise<void> {
  try {
    await cacheSet(`${BUCKET_PREFIX}${domain}`, bucket, STATE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ domain, err: (err as Error).message }, 'Failed to save bucket state to Redis');
  }
}

// --- AdaptiveRateLimiter --------------------------------------------------------

export class AdaptiveRateLimiter {
  /** Handle for the periodic cleanup timer. */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // --- acquireToken ----------------------------------------------------------

  /**
   * Attempt to acquire a rate-limit token for `domain`.
   *
   * Returns `{ allowed, waitMs, currentRps }`.
   * - If `allowed` is true the caller may proceed immediately.
   * - If false, `waitMs` tells the caller how long to wait before retrying.
   *
   * The method also respects cross-domain throttling: if the domain's root
   * domain is throttled, the sub-domain inherits that restriction.
   */
  async acquireToken(domain: string): Promise<AcquireResult> {
    const normalizedDomain = domain.toLowerCase();
    const rootDomain = extractRootDomain(normalizedDomain);
    const now = Date.now();

    // -- Load or initialise state -------------------------------------------
    let state = (await loadState(normalizedDomain)) ?? freshState();

    // Also check root-domain cooldown if the domain is a sub-domain
    if (normalizedDomain !== rootDomain) {
      const rootState = await loadState(rootDomain);
      if (rootState && rootState.cooldownUntil > now) {
        const rootRemaining = rootState.cooldownUntil - now;
        // Inherit the stricter cooldown
        if (rootRemaining > (state.cooldownUntil - now)) {
          state.cooldownUntil = rootState.cooldownUntil;
          state.isProtected = state.isProtected || rootState.isProtected;
          await saveState(normalizedDomain, state);
        }
      }
    }

    // -- Cooldown gate ------------------------------------------------------
    if (state.cooldownUntil > now) {
      const remaining = state.cooldownUntil - now;
      logger.debug({ domain: normalizedDomain, cooldownRemainingMs: remaining }, 'Domain in cooldown');
      return {
        allowed: false,
        waitMs: remaining,
        currentRps: state.safeRps,
      };
    }

    // -- Token bucket ------------------------------------------------------
    let bucket = (await loadBucket(normalizedDomain)) ?? freshBucket(state.safeRps);

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefillAt) / 1000; // seconds
    if (elapsed > 0) {
      bucket.tokens = Math.min(
        state.safeRps * BUCKET_CAPACITY_MULTIPLIER,
        bucket.tokens + elapsed * state.safeRps,
      );
      bucket.lastRefillAt = now;
    }

    // Determine if burst is allowed
    const burstAllowed = state.consecutiveSuccesses >= BURST_SUCCESS_THRESHOLD;
    const maxTokens = burstAllowed
      ? state.safeRps * BUCKET_CAPACITY_MULTIPLIER
      : state.safeRps; // Non-burst: bucket behaves like a simple rate limiter

    const effectiveTokens = Math.min(bucket.tokens, maxTokens);

    if (effectiveTokens >= 1) {
      // Consume one token
      bucket.tokens = Math.max(0, bucket.tokens - 1);
      state.lastRequestAt = now;
      state.totalRequests += 1;
      await saveState(normalizedDomain, state);
      await saveBucket(normalizedDomain, bucket);
      return { allowed: true, waitMs: 0, currentRps: state.safeRps };
    }

    // Not enough tokens -- compute wait time
    const deficit = 1 - effectiveTokens;
    const waitMs = Math.ceil((deficit / state.safeRps) * 1000);

    state.lastRequestAt = now;
    state.totalRequests += 1;
    await saveState(normalizedDomain, state);
    await saveBucket(normalizedDomain, bucket);

    return { allowed: false, waitMs, currentRps: state.safeRps };
  }

  // --- recordResponse ------------------------------------------------------

  /**
   * Record a response so the limiter can adapt.
   *
   * Response patterns:
   *   429 → halve safeRps, escalate cooldown
   *   403 / 503 / anti-bot → reduce by 30 %, flag protected, 30 s cooldown
   *   CAPTCHA → reduce by 30 %, 15 s cooldown
   *   Timeout (responseMs >= 30 000) → reduce by 20 %
   *   Success with fast response (< 2× avg) → increase by 2 %
   */
  async recordResponse(
    domain: string,
    result: {
      success: boolean;
      statusCode?: number;
      responseMs: number;
      hadCaptcha?: boolean;
      hadAntiBot?: boolean;
    },
  ): Promise<void> {
    const normalizedDomain = domain.toLowerCase();
    const rootDomain = extractRootDomain(normalizedDomain);
    const now = Date.now();

    let state = (await loadState(normalizedDomain)) ?? freshState();

    // -- Update running average response time ------------------------------
    state.avgResponseMs =
      state.avgResponseMs === 0
        ? result.responseMs
        : state.avgResponseMs * 0.8 + result.responseMs * 0.2;

    // -- Apply adaptive rules ----------------------------------------------

    if (result.statusCode === 429) {
      // -- Rate-limited: halve RPS, escalate cooldown ----------------------
      state.safeRps = clamp(state.safeRps * 0.5, MIN_RPS, MAX_RPS);
      state.emaRps = state.safeRps; // Reset EMA to avoid slow convergence
      state.consecutiveFailures += 1;
      state.consecutiveSuccesses = 0;
      state.totalFailures += 1;

      const cooldownIdx = clamp(state.cooldownLevel429, 0, COOLDOWN_429.length - 1);
      state.cooldownUntil = now + COOLDOWN_429[cooldownIdx];
      state.cooldownLevel429 = Math.min(state.cooldownLevel429 + 1, COOLDOWN_429.length - 1);

      logger.warn(
        {
          domain: normalizedDomain,
          safeRps: state.safeRps,
          cooldownMs: COOLDOWN_429[cooldownIdx],
          consecutiveFailures: state.consecutiveFailures,
        },
        '429 rate-limited -- halving RPS, entering cooldown',
      );
    } else if (result.hadAntiBot || result.statusCode === 403 || result.statusCode === 503) {
      // -- Anti-bot / 403 / 503: reduce by 30 %, flag protected -----------
      state.safeRps = clamp(state.safeRps * 0.7, MIN_RPS, MAX_RPS);
      state.emaRps = state.safeRps;
      state.consecutiveFailures += 1;
      state.consecutiveSuccesses = 0;
      state.totalFailures += 1;
      state.isProtected = true;
      state.cooldownUntil = now + COOLDOWN_ANTI_BOT;

      logger.warn(
        {
          domain: normalizedDomain,
          safeRps: state.safeRps,
          statusCode: result.statusCode,
          hadAntiBot: result.hadAntiBot,
        },
        'Anti-bot / 403 / 503 detected -- reducing RPS by 30 %, flagging protected',
      );
    } else if (result.hadCaptcha) {
      // -- CAPTCHA: reduce by 30 %, short cooldown -------------------------
      state.safeRps = clamp(state.safeRps * 0.7, MIN_RPS, MAX_RPS);
      state.emaRps = state.safeRps;
      state.consecutiveFailures += 1;
      state.consecutiveSuccesses = 0;
      state.totalFailures += 1;
      state.isProtected = true;
      state.cooldownUntil = now + COOLDOWN_CAPTCHA;

      logger.warn(
        { domain: normalizedDomain, safeRps: state.safeRps },
        'CAPTCHA detected -- reducing RPS by 30 %, entering 15 s cooldown',
      );
    } else if (!result.success || result.responseMs >= 30_000) {
      // -- Timeout or generic failure: reduce by 20 % ----------------------
      state.safeRps = clamp(state.safeRps * 0.8, MIN_RPS, MAX_RPS);
      state.emaRps = state.safeRps;
      state.consecutiveFailures += 1;
      state.consecutiveSuccesses = 0;
      state.totalFailures += 1;

      logger.info(
        { domain: normalizedDomain, safeRps: state.safeRps, responseMs: result.responseMs },
        'Timeout or failure -- reducing RPS by 20 %',
      );
    } else {
      // -- Success ---------------------------------------------------------
      state.consecutiveSuccesses += 1;
      state.consecutiveFailures = 0;
      state.totalSuccesses += 1;
      state.lastSuccessAt = now;

      // Fast response (< 2× average): gently increase rate
      if (result.responseMs < state.avgResponseMs * 2) {
        const newSafeRps = state.safeRps * 1.02;
        state.safeRps = clamp(
          EMA_ALPHA * newSafeRps + (1 - EMA_ALPHA) * state.emaRps,
          MIN_RPS,
          MAX_RPS,
        );
        state.emaRps = state.safeRps;
      }

      // -- Cooldown decay --------------------------------------------------
      if (
        state.cooldownLevel429 > 0 &&
        now - state.lastSuccessAt < COOLDOWN_DECAY_MS
      ) {
        // Only decay if we've had sustained success
        if (state.consecutiveSuccesses >= 5 && state.cooldownLevel429 > 0) {
          state.cooldownLevel429 = Math.max(0, state.cooldownLevel429 - 1);
          logger.debug(
            { domain: normalizedDomain, cooldownLevel429: state.cooldownLevel429 },
            'Cooldown level decayed after sustained successes',
          );
        }
      } else if (now - state.lastSuccessAt >= COOLDOWN_DECAY_MS && state.cooldownLevel429 > 0) {
        // 5 minutes of overall successful activity -- reset fully
        state.cooldownLevel429 = 0;
        logger.debug({ domain: normalizedDomain }, 'Cooldown level fully decayed after 5 min of success');
      }

      // Clear protection flag after sustained success
      if (state.isProtected && state.consecutiveSuccesses >= 20) {
        state.isProtected = false;
        logger.info({ domain: normalizedDomain }, 'Protection flag cleared after sustained success');
      }
    }

    await saveState(normalizedDomain, state);

    // -- Cross-domain: propagate throttle to root domain -------------------
    if (normalizedDomain !== rootDomain) {
      await this.propagateToRootDomain(rootDomain, state, now);
    }
  }

  // --- getDomainStatus -----------------------------------------------------

  /**
   * Return a full status snapshot for a domain.
   *
   * Includes the current RPS, cooldown status, protection flag, and success
   * rate -- useful for dashboards and debugging.
   */
  async getDomainStatus(domain: string): Promise<DomainRateStatus> {
    const normalizedDomain = domain.toLowerCase();
    const rootDomain = extractRootDomain(normalizedDomain);
    const now = Date.now();

    const state = (await loadState(normalizedDomain)) ?? freshState();

    const cooldownRemainingMs = state.cooldownUntil > now ? state.cooldownUntil - now : 0;
    const total = state.totalSuccesses + state.totalFailures;
    const successRate = total > 0 ? state.totalSuccesses / total : 1;

    return {
      domain: normalizedDomain,
      rootDomain,
      currentRps: state.safeRps,
      safeRps: state.safeRps,
      consecutiveSuccesses: state.consecutiveSuccesses,
      consecutiveFailures: state.consecutiveFailures,
      cooldownRemainingMs,
      isThrottled: cooldownRemainingMs > 0 || state.safeRps <= MIN_RPS * 2,
      isProtected: state.isProtected,
      lastRequestAt: state.lastRequestAt,
      totalRequests: state.totalRequests,
      successRate,
    };
  }

  // --- getAllThrottledDomains -----------------------------------------------

  /**
   * Scan Redis for all domains currently in a throttled state.
   *
   * Returns a list of `DomainRateStatus` objects for every domain whose
   * cooldown has not yet expired or whose safeRps is near the minimum.
   */
  async getAllThrottledDomains(): Promise<DomainRateStatus[]> {
    const throttled: DomainRateStatus[] = [];

    try {
      const r = redis;
      const keys = await r.keys(`${STATE_PREFIX}*`);
      if (keys.length === 0) return throttled;

      for (const key of keys) {
        const domain = key.replace(STATE_PREFIX, '');
        const status = await this.getDomainStatus(domain);
        if (status.isThrottled || status.isProtected) {
          throttled.push(status);
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Failed to scan throttled domains');
    }

    return throttled;
  }

  // --- Cleanup -------------------------------------------------------------

  /**
   * Start a periodic sweep that removes stale domain entries from Redis.
   *
   * Stale = no request in the last 30 minutes.
   */
  startCleanup(): void {
    if (this.cleanupTimer) {
      logger.warn('Cleanup timer already running -- skipping duplicate start');
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((err) => {
        logger.warn({ err: (err as Error).message }, 'Cleanup sweep failed');
      });
    }, CLEANUP_INTERVAL_MS);

    logger.info({ intervalMs: CLEANUP_INTERVAL_MS }, 'Rate-limiter cleanup timer started');
  }

  /** Stop the periodic cleanup sweep. */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('Rate-limiter cleanup timer stopped');
    }
  }

  // --- Internal helpers ----------------------------------------------------

  /**
   * When a sub-domain hits a rate limit / anti-bot, propagate a shared
   * throttle to the root domain so that sibling sub-domains are also
   * constrained.
   */
  private async propagateToRootDomain(
    rootDomain: string,
    childState: DomainState,
    now: number,
  ): Promise<void> {
    let rootState = (await loadState(rootDomain)) ?? freshState();

    // Only propagate if the child's cooldown is stricter
    if (childState.cooldownUntil > rootState.cooldownUntil) {
      rootState.cooldownUntil = childState.cooldownUntil;
    }

    // Lower the root's safeRps to the minimum of current root and child
    if (childState.safeRps < rootState.safeRps) {
      rootState.safeRps = childState.safeRps;
      rootState.emaRps = childState.emaRps;
    }

    // Propagate protection flag
    if (childState.isProtected) {
      rootState.isProtected = true;
    }

    // Propagate cooldown level
    if (childState.cooldownLevel429 > rootState.cooldownLevel429) {
      rootState.cooldownLevel429 = childState.cooldownLevel429;
    }

    rootState.lastRequestAt = now;
    await saveState(rootDomain, rootState);
  }

  /**
   * Remove domain entries that haven't seen a request in the last 30 minutes.
   */
  private async cleanup(): Promise<void> {
    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    let removed = 0;

    try {
      const r = redis;
      const stateKeys = await r.keys(`${STATE_PREFIX}*`);
      const bucketKeys = await r.keys(`${BUCKET_PREFIX}*`);

      for (const key of stateKeys) {
        try {
          const raw = await r.get(key);
          if (!raw) continue;
          const state: DomainState = JSON.parse(raw);
          if (now - state.lastRequestAt > STALE_THRESHOLD_MS) {
            await r.del(key);
            removed += 1;
          }
        } catch {
          // Malformed entry -- just skip
        }
      }

      for (const key of bucketKeys) {
        try {
          const raw = await r.get(key);
          if (!raw) continue;
          const bucket: BucketState = JSON.parse(raw);
          if (now - bucket.lastRefillAt > STALE_THRESHOLD_MS) {
            await r.del(key);
          }
        } catch {
          // Malformed entry -- skip
        }
      }

      if (removed > 0) {
        logger.info({ removed }, 'Rate-limiter cleanup: removed stale domain entries');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Rate-limiter cleanup failed');
    }
  }
}

// --- Singleton ------------------------------------------------------------------

/** Shared singleton instance -- safe to import from any module. */
export const adaptiveRateLimiter = new AdaptiveRateLimiter();
