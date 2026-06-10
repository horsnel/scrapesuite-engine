/**
 * Session Manager -- Redis-backed persistent sticky sessions with geo-consistency.
 *
 * Bright Data-level feature that ensures requests from the same session always
 * use the same proxy IP and geographic location.  State is persisted in Redis so
 * sessions survive worker restarts and are shared between API and worker
 * processes (unlike the in-memory sticky map in ProxyManager).
 *
 * Key features
 * ------------
 *  • Persistent sticky sessions stored in Redis with configurable TTL
 *  • Auto-extend session TTL on each access (refresh-on-use)
 *  • Geo-consistency: session stores and enforces country / city / ASN affinity
 *  • Automatic proxy reassignment in the same geo when a proxy becomes unhealthy
 *  • Browser fingerprint profile pinned to the session for identity continuity
 *  • Per-session metrics: request count, success/failure, avg response time,
 *    bandwidth, credits consumed
 *  • User-level session limits (max 1000 concurrent)
 *  • Periodic cleanup of expired sessions
 *
 * Redis layout
 * ------------
 *   cache:session:{sessionId}              -- JSON blob with full SessionState
 *   session:user:{userId}                  -- Redis Set of session IDs for a user
 *     (stored via direct redis commands, not cache helpers, because Sets need
 *      SADD / SMEMBERS which the cache helpers don't expose)
 *
 * Usage
 * -----
 *   import { sessionManager } from './session';
 *   const session = await sessionManager.createSession({
 *     userId: 'user-123',
 *     proxyCountry: 'US',
 *     proxyCity: 'New York',
 *     proxyTier: 'residential',
 *   });
 *   // … later, on each request …
 *   const state = await sessionManager.refreshSession(session.sessionId);
 *   await sessionManager.recordSessionRequest(session.sessionId, {
 *     success: true, responseMs: 340, bandwidthBytes: 50_000, creditsUsed: 1,
 *   });
 */

import { redis, cacheGet, cacheSet } from '../utils/redis';
import { db } from '../utils/db';
import { proxyManager } from '../proxy/manager';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('session-manager');

// --- Constants ------------------------------------------------------------------

/** Default session TTL in minutes. */
const DEFAULT_TTL_MINUTES = 10;

/** Maximum allowed session TTL in minutes. */
const MAX_TTL_MINUTES = 60;

/** Maximum concurrent sessions per user. */
const MAX_SESSIONS_PER_USER = 1000;

/** How often the periodic cleanup sweep runs (ms). */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Redis key prefix for session state blobs (used with cache helpers). */
const SESSION_KEY_PREFIX = 'session:';

/** Redis key prefix for user → session-id sets (direct redis commands). */
const USER_SESSIONS_KEY_PREFIX = 'session:user:';

/** Maximum number of reassignment attempts before giving up. */
const MAX_REASSIGN_ATTEMPTS = 5;

// --- Browser Fingerprint Profiles -----------------------------------------------
// Subset of the profiles from anti-bot/stealth.ts -- just the fields we need to
// pin to a session so subsequent requests look like the same browser.

const FINGERPRINT_PROFILES: Array<SessionState['fingerprintProfile']> = [
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'Win32',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezone: 'America/New_York',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    viewport: { width: 1680, height: 1050 },
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    platform: 'Win32',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezone: 'America/Chicago',
  },
  {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezone: 'America/Denver',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    platform: 'MacIntel',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezone: 'America/New_York',
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'Win32',
    viewport: { width: 1536, height: 864 },
    locale: 'en-GB',
    timezone: 'Europe/London',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    viewport: { width: 1440, height: 900 },
    locale: 'de-DE',
    timezone: 'Europe/Berlin',
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'Win32',
    viewport: { width: 1920, height: 1080 },
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
  },
];

// --- Locale / Timezone hints by country -----------------------------------------
// When a session specifies a country, we try to pick a matching fingerprint so
// the browser identity is geographically coherent.

const COUNTRY_LOCALE_HINTS: Record<string, { locale: string; timezone: string }> = {
  US: { locale: 'en-US', timezone: 'America/New_York' },
  GB: { locale: 'en-GB', timezone: 'Europe/London' },
  DE: { locale: 'de-DE', timezone: 'Europe/Berlin' },
  FR: { locale: 'fr-FR', timezone: 'Europe/Paris' },
  JP: { locale: 'ja-JP', timezone: 'Asia/Tokyo' },
  AU: { locale: 'en-AU', timezone: 'Australia/Sydney' },
  CA: { locale: 'en-CA', timezone: 'America/Toronto' },
  BR: { locale: 'pt-BR', timezone: 'America/Sao_Paulo' },
  IN: { locale: 'hi-IN', timezone: 'Asia/Kolkata' },
  IT: { locale: 'it-IT', timezone: 'Europe/Rome' },
  ES: { locale: 'es-ES', timezone: 'Europe/Madrid' },
  NL: { locale: 'nl-NL', timezone: 'Europe/Amsterdam' },
  KR: { locale: 'ko-KR', timezone: 'Asia/Seoul' },
  MX: { locale: 'es-MX', timezone: 'America/Mexico_City' },
  SG: { locale: 'en-SG', timezone: 'Asia/Singapore' },
};

// --- Types ----------------------------------------------------------------------

export interface SessionState {
  sessionId: string;
  userId: string;
  proxyId: string;
  proxyUrl: string;
  proxyCountry: string;
  proxyCity?: string;
  proxyAsn?: string;
  proxyTier: string;
  fingerprintProfile: {
    userAgent: string;
    platform: string;
    viewport: { width: number; height: number };
    locale: string;
    timezone: string;
  };
  createdAt: number;
  lastAccessedAt: number;
  ttlMs: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalResponseMs: number;
  bandwidthBytes: number;
  creditsConsumed: number;
}

export interface CreateSessionOptions {
  userId: string;
  proxyTier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  proxyCountry?: string;
  proxyCity?: string;
  proxyAsn?: string;
  domain?: string;
  ttlMinutes?: number; // default 10, max 60
}

export interface SessionInfo {
  sessionId: string;
  proxyCountry: string;
  proxyCity?: string;
  proxyAsn?: string;
  proxyTier: string;
  requestCount: number;
  successRate: number;
  avgResponseMs: number;
  bandwidthBytes: number;
  creditsConsumed: number;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
  isActive: boolean;
}

// --- Helpers --------------------------------------------------------------------

/**
 * Pick a fingerprint profile that best matches the target country.
 * Falls back to a random profile when no country-specific hint exists.
 */
function pickFingerprint(country?: string): SessionState['fingerprintProfile'] {
  if (country) {
    const hint = COUNTRY_LOCALE_HINTS[country.toUpperCase()];
    if (hint) {
      // Try to find a profile whose locale/timezone matches
      const match = FINGERPRINT_PROFILES.find(
        (p) => p.locale === hint.locale && p.timezone === hint.timezone,
      );
      if (match) return match;

      // Build a locale-adjusted variant from the first profile
      const base = FINGERPRINT_PROFILES[0];
      return {
        ...base,
        locale: hint.locale,
        timezone: hint.timezone,
      };
    }
  }
  return FINGERPRINT_PROFILES[Math.floor(Math.random() * FINGERPRINT_PROFILES.length)];
}

/**
 * Compute the Redis TTL (in seconds) for a session's state blob.
 * We add a small buffer (60 s) so the Redis key doesn't expire right
 * before we need it during a cleanup sweep.
 */
function redisTtlSeconds(ttlMs: number): number {
  return Math.ceil(ttlMs / 1000) + 60;
}

/**
 * Check whether a proxy is still usable (not retired, healthy enough).
 */
async function isProxyHealthy(proxyId: string): Promise<boolean> {
  try {
    const proxy = await db.proxy.findUnique({ where: { id: proxyId } });
    if (!proxy) return false;
    if (proxy.retired) return false;
    if (proxy.consecutiveFailures >= 5) return false;
    if (proxy.successRate < 0.2) return false;
    return true;
  } catch {
    return false;
  }
}

// --- SessionManager -------------------------------------------------------------

export class SessionManager {
  /** Handle for the periodic cleanup timer. */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // --- createSession ----------------------------------------------------------

  /**
   * Create a new persistent sticky session.
   *
   * Steps:
   *  1. Validate TTL (default 10 min, max 60 min).
   *  2. Enforce per-user session limit (max 1000).
   *  3. Select a proxy via ProxyManager that matches the requested geo/tier.
   *  4. Pick a browser fingerprint profile consistent with the target country.
   *  5. Persist the full SessionState to Redis with the appropriate TTL.
   *  6. Register the session ID in the user's session set.
   *
   * @throws Error if the user has exceeded the session limit or no proxy is available.
   */
  async createSession(options: CreateSessionOptions): Promise<SessionState> {
    const {
      userId,
      proxyTier = 'residential',
      proxyCountry,
      proxyCity,
      proxyAsn,
      domain = 'default',
      ttlMinutes = DEFAULT_TTL_MINUTES,
    } = options;

    // -- Validate TTL -------------------------------------------------------
    const clampedTtl = Math.max(1, Math.min(ttlMinutes, MAX_TTL_MINUTES));
    const ttlMs = clampedTtl * 60 * 1000;

    // -- Enforce per-user session limit -------------------------------------
    const userKey = `${USER_SESSIONS_KEY_PREFIX}${userId}`;
    let existingCount: number;
    try {
      existingCount = await redis.scard(userKey);
    } catch (err) {
      logger.warn({ userId, err: (err as Error).message }, 'Failed to count user sessions -- proceeding');
      existingCount = 0;
    }

    if (existingCount >= MAX_SESSIONS_PER_USER) {
      // Try pruning expired entries first
      await this.pruneExpiredUserSessions(userId);
      const recount = await redis.scard(userKey).catch(() => existingCount);
      if (recount >= MAX_SESSIONS_PER_USER) {
        throw new Error(
          `User ${userId} has reached the maximum of ${MAX_SESSIONS_PER_USER} concurrent sessions`,
        );
      }
    }

    // -- Select proxy -------------------------------------------------------
    const selection = await proxyManager.getProxy(
      domain,
      proxyTier,
      proxyCountry,
      'least-failures',
      { city: proxyCity, asn: proxyAsn },
    );

    if (!selection) {
      throw new Error(
        `No available proxy for tier=${proxyTier}, country=${proxyCountry}, city=${proxyCity}, asn=${proxyAsn}`,
      );
    }

    // -- Pick fingerprint ---------------------------------------------------
    const fingerprint = pickFingerprint(proxyCountry ?? selection.country);

    // -- Build session state ------------------------------------------------
    const now = Date.now();
    const sessionId = `sess-${now}-${Math.random().toString(36).substring(2, 10)}`;

    const state: SessionState = {
      sessionId,
      userId,
      proxyId: selection.proxyId,
      proxyUrl: selection.proxyUrl,
      proxyCountry: selection.country,
      proxyCity: selection.city ?? proxyCity,
      proxyAsn: selection.asn ?? proxyAsn,
      proxyTier: selection.tier,
      fingerprintProfile: fingerprint,
      createdAt: now,
      lastAccessedAt: now,
      ttlMs,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      totalResponseMs: 0,
      bandwidthBytes: 0,
      creditsConsumed: 0,
    };

    // -- Persist to Redis ---------------------------------------------------
    const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
    await cacheSet(sessionKey, state, redisTtlSeconds(ttlMs));

    // -- Register in user's session set -------------------------------------
    try {
      await redis.sadd(userKey, sessionId);
      // Set an expiry on the set itself so it doesn't leak if all sessions
      // expire naturally.  We use the max TTL + buffer as a safety net.
      await redis.expire(userKey, MAX_TTL_MINUTES * 60 + 120);
    } catch (err) {
      logger.warn({ userId, sessionId, err: (err as Error).message }, 'Failed to register session in user set');
    }

    logger.info(
      {
        sessionId,
        userId,
        proxyId: state.proxyId,
        proxyCountry: state.proxyCountry,
        proxyCity: state.proxyCity,
        proxyAsn: state.proxyAsn,
        ttlMinutes: clampedTtl,
      },
      'Session created',
    );

    return state;
  }

  // --- getSession -------------------------------------------------------------

  /**
   * Retrieve the current state of a session.
   *
   * Returns `null` if the session does not exist or has expired.
   * This is a read-only operation -- it does **not** refresh the TTL.
   * Use `refreshSession` to extend the session on access.
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
    try {
      const state = await cacheGet<SessionState>(sessionKey);
      if (!state) return null;

      // Check if the session has logically expired (Redis TTL with buffer may
      // still be alive but the logical TTL has passed)
      if (Date.now() - state.lastAccessedAt > state.ttlMs) {
        return null;
      }

      return state;
    } catch (err) {
      logger.warn({ sessionId, err: (err as Error).message }, 'Failed to get session');
      return null;
    }
  }

  // --- refreshSession ---------------------------------------------------------

  /**
   * Refresh a session's TTL on access.
   *
   * Called every time a request uses this session.  Extends the session's
   * remaining lifetime back to its original TTL from the current moment,
   * mimicking a "sliding window" expiration.  Also updates `lastAccessedAt`.
   *
   * Returns the updated state, or `null` if the session no longer exists.
   */
  async refreshSession(sessionId: string): Promise<SessionState | null> {
    const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
    try {
      const state = await cacheGet<SessionState>(sessionKey);
      if (!state) return null;

      // Check logical expiry
      if (Date.now() - state.lastAccessedAt > state.ttlMs) {
        await this.removeSession(sessionId, state.userId);
        return null;
      }

      // Refresh: slide the window forward
      const now = Date.now();
      state.lastAccessedAt = now;

      await cacheSet(sessionKey, state, redisTtlSeconds(state.ttlMs));

      logger.debug(
        { sessionId, userId: state.userId, ttlMs: state.ttlMs },
        'Session TTL refreshed',
      );

      return state;
    } catch (err) {
      logger.warn({ sessionId, err: (err as Error).message }, 'Failed to refresh session');
      return null;
    }
  }

  // --- terminateSession -------------------------------------------------------

  /**
   * Explicitly terminate a session.
   *
   * Removes the session state from Redis and unregisters it from the user's
   * session set.  Safe to call on already-expired or non-existent sessions.
   */
  async terminateSession(sessionId: string): Promise<void> {
    try {
      const state = await cacheGet<SessionState>(`${SESSION_KEY_PREFIX}${sessionId}`);

      if (state) {
        await this.removeSession(sessionId, state.userId);
        logger.info({ sessionId, userId: state.userId }, 'Session terminated');
      } else {
        // Session may have already expired -- try cleaning up from user set
        // We don't know the userId, so just delete the key (best-effort)
        await cacheSet(`${SESSION_KEY_PREFIX}${sessionId}`, null as any, 0).catch(() => {});
        await redis.del(`cache:${SESSION_KEY_PREFIX}${sessionId}`).catch(() => {});
        logger.debug({ sessionId }, 'Session already expired or missing on terminate');
      }
    } catch (err) {
      logger.warn({ sessionId, err: (err as Error).message }, 'Failed to terminate session');
    }
  }

  // --- recordSessionRequest ---------------------------------------------------

  /**
   * Record a request's outcome against the session.
   *
   * Updates the session's metrics (request count, success/failure, response
   * time, bandwidth, credits) and also refreshes the session TTL.  If the
   * session's proxy has become unhealthy (retired, consecutive failures ≥ 5),
   * automatically triggers a proxy reassignment in the same geo.
   *
   * Returns the updated state, or `null` if the session no longer exists.
   */
  async recordSessionRequest(
    sessionId: string,
    result: {
      success: boolean;
      responseMs: number;
      bandwidthBytes: number;
      creditsUsed: number;
    },
  ): Promise<SessionState | null> {
    const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
    try {
      const state = await cacheGet<SessionState>(sessionKey);
      if (!state) return null;

      // Check logical expiry
      if (Date.now() - state.lastAccessedAt > state.ttlMs) {
        await this.removeSession(sessionId, state.userId);
        return null;
      }

      // -- Update metrics -------------------------------------------------
      state.requestCount += 1;
      state.totalResponseMs += result.responseMs;
      state.bandwidthBytes += result.bandwidthBytes;
      state.creditsConsumed += result.creditsUsed;

      if (result.success) {
        state.successCount += 1;
      } else {
        state.failureCount += 1;
      }

      // -- Refresh TTL (sliding window) -----------------------------------
      state.lastAccessedAt = Date.now();

      // -- Persist updated state ------------------------------------------
      await cacheSet(sessionKey, state, redisTtlSeconds(state.ttlMs));

      // -- Check if proxy is still healthy --------------------------------
      const healthy = await isProxyHealthy(state.proxyId);
      if (!healthy) {
        logger.info(
          {
            sessionId,
            proxyId: state.proxyId,
            successRate: state.successCount > 0
              ? state.successCount / state.requestCount
              : 0,
          },
          'Session proxy unhealthy -- triggering reassignment',
        );
        const reassigned = await this.reassignProxy(sessionId);
        return reassigned;
      }

      return state;
    } catch (err) {
      logger.warn({ sessionId, err: (err as Error).message }, 'Failed to record session request');
      return null;
    }
  }

  // --- reassignProxy ----------------------------------------------------------

  /**
   * Reassign a session to a new proxy in the **same geographic location**.
   *
   * Geo-consistency is the top priority -- we search for a replacement proxy
   * matching the original country, then city, then ASN, with progressively
   * relaxed constraints if an exact match isn't available.
   *
   * Returns the updated state, or `null` if the session no longer exists or
   * no suitable replacement proxy can be found.
   */
  async reassignProxy(sessionId: string): Promise<SessionState | null> {
    const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
    try {
      const state = await cacheGet<SessionState>(sessionKey);
      if (!state) return null;

      // Check logical expiry
      if (Date.now() - state.lastAccessedAt > state.ttlMs) {
        await this.removeSession(sessionId, state.userId);
        return null;
      }

      const originalCountry = state.proxyCountry;
      const originalCity = state.proxyCity;
      const originalAsn = state.proxyAsn;
      const originalTier = state.proxyTier as 'residential' | 'mobile' | 'datacenter' | 'isp';

      logger.info(
        {
          sessionId,
          oldProxyId: state.proxyId,
          country: originalCountry,
          city: originalCity,
          asn: originalAsn,
          tier: originalTier,
        },
        'Reassigning session proxy with geo-consistency',
      );

      // -- Try multiple levels of geo-specificity --------------------------
      const geoAttempts: Array<{
        country?: string;
        city?: string;
        asn?: string;
        label: string;
      }> = [
        // 1. Exact match: same country + city + ASN
        { country: originalCountry, city: originalCity, asn: originalAsn, label: 'country+city+asn' },
        // 2. Same country + city, any ASN
        { country: originalCountry, city: originalCity, label: 'country+city' },
        // 3. Same country, any city/ASN
        { country: originalCountry, label: 'country' },
        // 4. Any proxy in the same tier (last resort)
        { label: 'tier-only' },
      ];

      for (const attempt of geoAttempts) {
        for (let i = 0; i < MAX_REASSIGN_ATTEMPTS; i++) {
          const selection = await proxyManager.getProxy(
            'session-reassign',
            originalTier,
            attempt.country,
            'least-failures',
            { city: attempt.city, asn: attempt.asn },
          );

          if (selection && selection.proxyId !== state.proxyId) {
            // Found a different proxy in the target geo -- update state
            state.proxyId = selection.proxyId;
            state.proxyUrl = selection.proxyUrl;
            state.proxyCountry = selection.country;
            state.proxyCity = selection.city ?? state.proxyCity;
            state.proxyAsn = selection.asn ?? state.proxyAsn;
            state.proxyTier = selection.tier;
            state.lastAccessedAt = Date.now();

            await cacheSet(sessionKey, state, redisTtlSeconds(state.ttlMs));

            logger.info(
              {
                sessionId,
                newProxyId: state.proxyId,
                newCountry: state.proxyCountry,
                newCity: state.proxyCity,
                newAsn: state.proxyAsn,
                matchLevel: attempt.label,
              },
              'Session proxy reassigned with geo-consistency',
            );

            return state;
          }
        }
      }

      // No suitable replacement found -- session continues with the old proxy
      // (it might still work intermittently)
      logger.warn(
        {
          sessionId,
          oldProxyId: state.proxyId,
          country: originalCountry,
          city: originalCity,
        },
        'No geo-consistent replacement proxy found -- session retains old proxy',
      );

      return state;
    } catch (err) {
      logger.warn({ sessionId, err: (err as Error).message }, 'Failed to reassign session proxy');
      return null;
    }
  }

  // --- listUserSessions -------------------------------------------------------

  /**
   * List all active sessions for a user.
   *
   * Returns an array of `SessionInfo` objects with status and metrics.
   * Expired sessions are automatically pruned from the user's set.
   */
  async listUserSessions(userId: string): Promise<SessionInfo[]> {
    const userKey = `${USER_SESSIONS_KEY_PREFIX}${userId}`;
    const results: SessionInfo[] = [];

    try {
      const sessionIds = await redis.smembers(userKey);
      const now = Date.now();
      const expiredIds: string[] = [];

      for (const sessionId of sessionIds) {
        const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
        const state = await cacheGet<SessionState>(sessionKey);

        if (!state) {
          // Key has expired from Redis -- mark for removal from user set
          expiredIds.push(sessionId);
          continue;
        }

        // Check logical expiry
        const isActive = now - state.lastAccessedAt <= state.ttlMs;

        if (!isActive) {
          expiredIds.push(sessionId);
          continue;
        }

        const totalRequests = state.requestCount;
        const successRate = totalRequests > 0 ? state.successCount / totalRequests : 0;
        const avgResponseMs = totalRequests > 0 ? Math.round(state.totalResponseMs / totalRequests) : 0;
        const expiresAt = new Date(state.lastAccessedAt + state.ttlMs);

        results.push({
          sessionId: state.sessionId,
          proxyCountry: state.proxyCountry,
          proxyCity: state.proxyCity,
          proxyAsn: state.proxyAsn,
          proxyTier: state.proxyTier,
          requestCount: state.requestCount,
          successRate: Math.round(successRate * 1000) / 1000,
          avgResponseMs,
          bandwidthBytes: state.bandwidthBytes,
          creditsConsumed: state.creditsConsumed,
          createdAt: new Date(state.createdAt).toISOString(),
          lastAccessedAt: new Date(state.lastAccessedAt).toISOString(),
          expiresAt: expiresAt.toISOString(),
          isActive: true,
        });
      }

      // -- Prune expired entries from the user's session set ----------------
      if (expiredIds.length > 0) {
        await redis.srem(userKey, ...expiredIds).catch(() => {});
        logger.debug(
          { userId, pruned: expiredIds.length },
          'Pruned expired session IDs from user set',
        );
      }
    } catch (err) {
      logger.warn({ userId, err: (err as Error).message }, 'Failed to list user sessions');
    }

    return results;
  }

  // --- cleanup ----------------------------------------------------------------

  /**
   * Scan all session keys and remove expired entries.
   *
   * Also prunes stale session IDs from user sets.  This is called
   * periodically by the cleanup timer, but can also be invoked manually.
   */
  async cleanup(): Promise<void> {
    const now = Date.now();
    let removed = 0;
    let scanned = 0;

    try {
      // Scan all session keys
      const pattern = `cache:${SESSION_KEY_PREFIX}*`;
      const keys = await redis.keys(pattern);

      for (const key of keys) {
        scanned++;
        try {
          const raw = await redis.get(key);
          if (!raw) {
            // Key vanished between KEYS and GET -- skip
            continue;
          }

          const state: SessionState = JSON.parse(raw);
          const expired = now - state.lastAccessedAt > state.ttlMs;

          if (expired) {
            await this.removeSession(state.sessionId, state.userId);
            removed++;
          } else {
            // Still alive -- refresh the Redis TTL to keep it in sync
            const remainingMs = state.ttlMs - (now - state.lastAccessedAt);
            const ttlSeconds = Math.max(1, Math.ceil(remainingMs / 1000) + 60);
            await redis.expire(key, ttlSeconds).catch(() => {});
          }
        } catch {
          // Malformed entry -- skip
        }
      }

      // -- Also clean up user sets that may reference expired sessions ------
      await this.cleanupUserSets();

      if (removed > 0 || scanned > 0) {
        logger.info({ scanned, removed }, 'Session cleanup sweep completed');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Session cleanup failed');
    }
  }

  // --- startCleanup -----------------------------------------------------------

  /**
   * Start a periodic sweep that removes expired sessions from Redis.
   *
   * Safe to call multiple times -- a duplicate start is a no-op.
   */
  startCleanup(): void {
    if (this.cleanupTimer) {
      logger.warn('Session cleanup timer already running -- skipping duplicate start');
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((err) => {
        logger.warn({ err: (err as Error).message }, 'Session cleanup sweep failed');
      });
    }, CLEANUP_INTERVAL_MS);

    logger.info({ intervalMs: CLEANUP_INTERVAL_MS }, 'Session cleanup timer started');
  }

  // --- stopCleanup ------------------------------------------------------------

  /**
   * Stop the periodic cleanup sweep.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('Session cleanup timer stopped');
    }
  }

  // --- Private Helpers --------------------------------------------------------

  /**
   * Remove a session from Redis and the user's session set.
   */
  private async removeSession(sessionId: string, userId: string): Promise<void> {
    const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
    const userKey = `${USER_SESSIONS_KEY_PREFIX}${userId}`;

    await Promise.allSettled([
      redis.del(`cache:${sessionKey}`),
      redis.srem(userKey, sessionId),
    ]);
  }

  /**
   * Prune expired session IDs from a specific user's session set.
   *
   * Called when a user hits the session limit -- gives them a second chance
   * after stale entries are cleaned up.
   */
  private async pruneExpiredUserSessions(userId: string): Promise<number> {
    const userKey = `${USER_SESSIONS_KEY_PREFIX}${userId}`;
    const now = Date.now();
    let pruned = 0;

    try {
      const sessionIds = await redis.smembers(userKey);
      const expiredIds: string[] = [];

      for (const sessionId of sessionIds) {
        const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
        const state = await cacheGet<SessionState>(sessionKey);
        if (!state || now - state.lastAccessedAt > state.ttlMs) {
          expiredIds.push(sessionId);
        }
      }

      if (expiredIds.length > 0) {
        await redis.srem(userKey, ...expiredIds);
        pruned = expiredIds.length;
        logger.debug({ userId, pruned }, 'Pruned expired sessions for user');
      }
    } catch (err) {
      logger.warn({ userId, err: (err as Error).message }, 'Failed to prune expired user sessions');
    }

    return pruned;
  }

  /**
   * Scan all user-session sets and remove references to sessions that no
   * longer exist in Redis.  This is a safety net to prevent user sets from
   * growing unboundedly.
   */
  private async cleanupUserSets(): Promise<void> {
    try {
      const pattern = `${USER_SESSIONS_KEY_PREFIX}*`;
      const userKeys = await redis.keys(pattern);

      for (const userKey of userKeys) {
        try {
          const sessionIds = await redis.smembers(userKey);
          const staleIds: string[] = [];

          for (const sessionId of sessionIds) {
            const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
            const exists = await redis.exists(`cache:${sessionKey}`);
            if (!exists) {
              staleIds.push(sessionId);
            }
          }

          if (staleIds.length > 0) {
            await redis.srem(userKey, ...staleIds);
          }

          // If the set is now empty, remove it entirely
          const remaining = await redis.scard(userKey);
          if (remaining === 0) {
            await redis.del(userKey);
          }
        } catch {
          // Skip this user set on error
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Failed to cleanup user session sets');
    }
  }
}

// --- Singleton -----------------------------------------------------------------

/** Shared singleton instance -- safe to import from any module. */
export const sessionManager = new SessionManager();
