/**
 * IP Reputation Tracker
 *
 * Tracks per-IP reputation scores against specific domains, enabling
 * intelligent IP selection that avoids blacklisted IPs and favors IPs
 * with proven success on a given target.
 *
 * Features:
 *  - Per-domain reputation: an IP can be great for amazon.com but blocked on target.com
 *  - Automatic blacklist detection with cooldown periods
 *  - Success rate tracking per IP+domain pair (exponential moving average)
 *  - IP "warming" -- new IPs start with neutral reputation and build trust
 *  - Persistent storage in Redis for fast lookups
 *  - Periodic decay to prevent stale reputation from persisting forever
 *
 * Redis layout:
 *   iprep:{proxyId}:{domain}  → JSON { score, totalReq, successReq, lastSuccess, lastFailure, blacklisted, blacklistReason, cooldownUntil }
 *   iprep:global:{proxyId}    → JSON { score, totalReq, successReq, lastUsed }
 *   iprep:blacklist:{domain}  → Set of proxyIds currently blacklisted for this domain
 */

import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('ip-reputation');

// --- Constants ----------------------------------------------------------------

/** Starting reputation score for a new IP (neutral). */
const NEUTRAL_SCORE = 0.5;

/** EMA alpha for score updates (lower = slower adaptation). */
const SCORE_ALPHA = 0.15;

/** How many consecutive failures before an IP is blacklisted for a domain. */
const BLACKLIST_CONSECUTIVE_FAILURES = 3;

/** Default cooldown in ms after blacklisting (10 minutes). */
const DEFAULT_BLACKLIST_COOLDOWN_MS = 10 * 60 * 1000;

/** How often the decay sweep runs (ms). */
const DECAY_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** How much reputation decays per sweep (toward neutral). */
const DECAY_FACTOR = 0.05;

/** Maximum age in ms for reputation data before it's pruned (24 hours). */
const MAX_REPUTATION_AGE_MS = 24 * 60 * 60 * 1000;

// --- Types --------------------------------------------------------------------

export interface DomainReputation {
  proxyId: string;
  domain: string;
  score: number;           // 0.0 = always fails, 1.0 = always succeeds
  totalRequests: number;
  successRequests: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  blacklisted: boolean;
  blacklistReason?: string;
  cooldownUntil: number | null;
  lastUpdated: number;
}

export interface GlobalReputation {
  proxyId: string;
  score: number;
  totalRequests: number;
  successRequests: number;
  lastUsed: number;
}

export interface ReputationVerdict {
  /** Whether this IP is usable for the domain right now. */
  usable: boolean;
  /** Reputation score (0-1). Higher = better. */
  score: number;
  /** Why the IP is not usable, if applicable. */
  reason?: string;
  /** When the blacklist cooldown expires (ms epoch), if blacklisted. */
  cooldownUntil?: number;
  /** Whether this IP has a "warm" reputation (many successful requests). */
  warm: boolean;
}

// --- IPReputationTracker -----------------------------------------------------

export class IPReputationTracker {
  private decayTimer: ReturnType<typeof setInterval> | null = null;

  // --- Record outcome -----------------------------------------------------

  /**
   * Record the outcome of a request through a proxy for a specific domain.
   * Updates both the domain-specific and global reputation scores.
   */
  async recordOutcome(
    proxyId: string,
    domain: string,
    success: boolean,
    statusCode?: number,
  ): Promise<void> {
    try {
      const now = Date.now();

      // Update domain-specific reputation
      const domainRep = await this.getDomainReputation(proxyId, domain);
      if (domainRep) {
        domainRep.totalRequests++;
        domainRep.lastUpdated = now;

        if (success) {
          domainRep.successRequests++;
          domainRep.lastSuccessAt = now;
          domainRep.consecutiveFailures = 0;
          domainRep.blacklisted = false;
          domainRep.cooldownUntil = null;
          domainRep.blacklistReason = undefined;
        } else {
          domainRep.lastFailureAt = now;
          domainRep.consecutiveFailures++;

          // Check for blacklisting
          if (domainRep.consecutiveFailures >= BLACKLIST_CONSECUTIVE_FAILURES) {
            domainRep.blacklisted = true;
            domainRep.blacklistReason = this.inferBlacklistReason(statusCode);
            domainRep.cooldownUntil = now + DEFAULT_BLACKLIST_COOLDOWN_MS;

            // Add to domain blacklist set
            const blKey = `iprep:blacklist:${domain}`;
            await redis.sadd(blKey, proxyId);
            await redis.expire(blKey, 3600); // 1 hour TTL on the set itself

            logger.info(
              { proxyId, domain, consecutiveFailures: domainRep.consecutiveFailures, reason: domainRep.blacklistReason, cooldownMs: DEFAULT_BLACKLIST_COOLDOWN_MS },
              'IP blacklisted for domain',
            );
          }
        }

        // Update score using EMA
        domainRep.score = domainRep.score * (1 - SCORE_ALPHA) + (success ? 1 : 0) * SCORE_ALPHA;

        await this.saveDomainReputation(proxyId, domain, domainRep);
      } else {
        // Create new domain reputation entry
        const newRep: DomainReputation = {
          proxyId,
          domain,
          score: success ? NEUTRAL_SCORE + SCORE_ALPHA : NEUTRAL_SCORE - SCORE_ALPHA,
          totalRequests: 1,
          successRequests: success ? 1 : 0,
          lastSuccessAt: success ? now : null,
          lastFailureAt: success ? null : now,
          consecutiveFailures: success ? 0 : 1,
          blacklisted: false,
          cooldownUntil: null,
          lastUpdated: now,
        };
        await this.saveDomainReputation(proxyId, domain, newRep);
      }

      // Update global reputation
      const globalRep = await this.getGlobalReputation(proxyId);
      if (globalRep) {
        globalRep.totalRequests++;
        globalRep.lastUsed = now;
        if (success) globalRep.successRequests++;
        globalRep.score = globalRep.score * (1 - SCORE_ALPHA) + (success ? 1 : 0) * SCORE_ALPHA;
        await this.saveGlobalReputation(proxyId, globalRep);
      } else {
        const newGlobal: GlobalReputation = {
          proxyId,
          score: success ? NEUTRAL_SCORE + SCORE_ALPHA : NEUTRAL_SCORE - SCORE_ALPHA,
          totalRequests: 1,
          successRequests: success ? 1 : 0,
          lastUsed: now,
        };
        await this.saveGlobalReputation(proxyId, newGlobal);
      }
    } catch (err: any) {
      logger.warn({ proxyId, domain, error: err.message }, 'Failed to record reputation outcome');
    }
  }

  // --- Get verdict --------------------------------------------------------

  /**
   * Get a verdict on whether a proxy is usable for a domain right now.
   * Checks blacklists, cooldowns, and returns the reputation score.
   */
  async getVerdict(proxyId: string, domain: string): Promise<ReputationVerdict> {
    try {
      const domainRep = await this.getDomainReputation(proxyId, domain);
      const now = Date.now();

      if (!domainRep) {
        // No reputation data -- this is a "cold" IP
        return {
          usable: true,
          score: NEUTRAL_SCORE,
          warm: false,
        };
      }

      // Check if blacklisted and still in cooldown
      if (domainRep.blacklisted && domainRep.cooldownUntil && now < domainRep.cooldownUntil) {
        return {
          usable: false,
          score: domainRep.score,
          reason: `Blacklisted: ${domainRep.blacklistReason || 'too many failures'}`,
          cooldownUntil: domainRep.cooldownUntil,
          warm: domainRep.totalRequests >= 5 && domainRep.score > 0.6,
        };
      }

      // Cooldown has expired -- auto-unblacklist
      if (domainRep.blacklisted && domainRep.cooldownUntil && now >= domainRep.cooldownUntil) {
        domainRep.blacklisted = false;
        domainRep.cooldownUntil = null;
        domainRep.blacklistReason = undefined;
        domainRep.consecutiveFailures = 0;
        domainRep.score = NEUTRAL_SCORE; // Reset to neutral after cooldown
        await this.saveDomainReputation(proxyId, domain, domainRep);

        // Remove from blacklist set
        await redis.srem(`iprep:blacklist:${domain}`, proxyId).catch(() => {});

        logger.info({ proxyId, domain }, 'IP unblacklisted after cooldown');
      }

      return {
        usable: !domainRep.blacklisted,
        score: domainRep.score,
        warm: domainRep.totalRequests >= 5 && domainRep.score > 0.6,
      };
    } catch (err: any) {
      logger.warn({ proxyId, domain, error: err.message }, 'Failed to get reputation verdict');
      return { usable: true, score: NEUTRAL_SCORE, warm: false };
    }
  }

  // --- Get best proxies for domain ----------------------------------------

  /**
   * Given a list of proxy IDs, rank them by reputation for a domain.
   * Filters out blacklisted/cooldowned IPs. Returns ranked list.
   */
  async rankProxiesForDomain(
    proxyIds: string[],
    domain: string,
    limit: number = 20,
  ): Promise<Array<{ proxyId: string; score: number; warm: boolean }>> {
    const results: Array<{ proxyId: string; score: number; warm: boolean }> = [];

    // Batch fetch verdicts
    const verdicts = await Promise.all(
      proxyIds.map(async (proxyId) => {
        const verdict = await this.getVerdict(proxyId, domain);
        return { proxyId, ...verdict };
      }),
    );

    // Filter out unusable and sort by score descending
    for (const v of verdicts) {
      if (!v.usable) continue;
      results.push({ proxyId: v.proxyId, score: v.score, warm: v.warm });
    }

    // Sort: warm IPs first, then by score descending
    results.sort((a, b) => {
      if (a.warm !== b.warm) return a.warm ? -1 : 1;
      return b.score - a.score;
    });

    return results.slice(0, limit);
  }

  // --- Get blacklisted IPs for domain -------------------------------------

  /**
   * Get the set of proxy IDs currently blacklisted for a domain.
   */
  async getBlacklistedForDomain(domain: string): Promise<string[]> {
    try {
      const key = `iprep:blacklist:${domain}`;
      return await redis.smembers(key);
    } catch {
      return [];
    }
  }

  // --- Get domain reputation ----------------------------------------------

  async getDomainReputation(proxyId: string, domain: string): Promise<DomainReputation | null> {
    try {
      const key = `iprep:${proxyId}:${domain}`;
      return await cacheGet<DomainReputation>(key);
    } catch {
      return null;
    }
  }

  // --- Get global reputation ----------------------------------------------

  async getGlobalReputation(proxyId: string): Promise<GlobalReputation | null> {
    try {
      const key = `iprep:global:${proxyId}`;
      return await cacheGet<GlobalReputation>(key);
    } catch {
      return null;
    }
  }

  // --- Manual blacklist/unblacklist ---------------------------------------

  /**
   * Manually blacklist a proxy for a domain (e.g., after detecting a CAPTCHA or block).
   */
  async blacklistProxy(proxyId: string, domain: string, reason: string, cooldownMs: number = DEFAULT_BLACKLIST_COOLDOWN_MS): Promise<void> {
    const now = Date.now();
    const domainRep = await this.getDomainReputation(proxyId, domain);

    if (domainRep) {
      domainRep.blacklisted = true;
      domainRep.blacklistReason = reason;
      domainRep.cooldownUntil = now + cooldownMs;
      domainRep.consecutiveFailures = BLACKLIST_CONSECUTIVE_FAILURES;
      domainRep.lastUpdated = now;
      await this.saveDomainReputation(proxyId, domain, domainRep);
    } else {
      const newRep: DomainReputation = {
        proxyId,
        domain,
        score: 0.1,
        totalRequests: 1,
        successRequests: 0,
        lastSuccessAt: null,
        lastFailureAt: now,
        consecutiveFailures: BLACKLIST_CONSECUTIVE_FAILURES,
        blacklisted: true,
        blacklistReason: reason,
        cooldownUntil: now + cooldownMs,
        lastUpdated: now,
      };
      await this.saveDomainReputation(proxyId, domain, newRep);
    }

    await redis.sadd(`iprep:blacklist:${domain}`, proxyId).catch(() => {});

    logger.info({ proxyId, domain, reason, cooldownMs }, 'IP manually blacklisted for domain');
  }

  /**
   * Manually unblacklist a proxy for a domain.
   */
  async unblacklistProxy(proxyId: string, domain: string): Promise<void> {
    const domainRep = await this.getDomainReputation(proxyId, domain);
    if (domainRep) {
      domainRep.blacklisted = false;
      domainRep.cooldownUntil = null;
      domainRep.blacklistReason = undefined;
      domainRep.consecutiveFailures = 0;
      domainRep.score = NEUTRAL_SCORE;
      domainRep.lastUpdated = Date.now();
      await this.saveDomainReputation(proxyId, domain, domainRep);
    }

    await redis.srem(`iprep:blacklist:${domain}`, proxyId).catch(() => {});

    logger.info({ proxyId, domain }, 'IP manually unblacklisted for domain');
  }

  // --- Get stats ----------------------------------------------------------

  /**
   * Get reputation statistics for a specific proxy.
   */
  async getProxyStats(proxyId: string): Promise<{
    global: GlobalReputation | null;
    domains: Array<{ domain: string; reputation: DomainReputation }>;
  }> {
    const global = await this.getGlobalReputation(proxyId);

    // Scan for domain-specific reputation keys
    const pattern = `iprep:${proxyId}:*`;
    let domains: Array<{ domain: string; reputation: DomainReputation }> = [];

    try {
      const keys = await redis.keys(`cache:${pattern}`);
      const domainReps: Array<{ domain: string; reputation: DomainReputation }> = [];

      for (const key of keys) {
        try {
          const raw = await redis.get(key);
          if (raw) {
            const rep: DomainReputation = JSON.parse(raw);
            domainReps.push({ domain: rep.domain, reputation: rep });
          }
        } catch {}
      }

      domains = domainReps;
    } catch {}

    return { global, domains };
  }

  // --- Periodic decay -----------------------------------------------------

  /**
   * Start periodic reputation decay.
   * Decays all reputation scores toward neutral over time, preventing
   * stale reputation from permanently affecting IP selection.
   */
  startDecay(): void {
    if (this.decayTimer) return;

    this.decayTimer = setInterval(() => {
      this.runDecay().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Reputation decay sweep failed');
      });
    }, DECAY_INTERVAL_MS);

    logger.info({ intervalMs: DECAY_INTERVAL_MS }, 'Reputation decay timer started');
  }

  stopDecay(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
  }

  private async runDecay(): Promise<void> {
    try {
      const now = Date.now();
      const pattern = 'cache:iprep:*';
      const keys = await redis.keys(pattern);
      let decayed = 0;
      let pruned = 0;

      for (const key of keys) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;

          // Skip global reputation keys and blacklist sets
          if (key.includes(':global:') || key.includes(':blacklist:')) continue;

          const rep: DomainReputation = JSON.parse(raw);

          // Prune stale entries older than MAX_REPUTATION_AGE_MS
          if (now - rep.lastUpdated > MAX_REPUTATION_AGE_MS) {
            await redis.del(key);
            pruned++;
            continue;
          }

          // Decay score toward neutral
          if (rep.score > NEUTRAL_SCORE) {
            rep.score = Math.max(NEUTRAL_SCORE, rep.score - DECAY_FACTOR);
          } else if (rep.score < NEUTRAL_SCORE) {
            rep.score = Math.min(NEUTRAL_SCORE, rep.score + DECAY_FACTOR);
          }

          rep.lastUpdated = now;
          await redis.set(key, JSON.stringify(rep));
          decayed++;
        } catch {}
      }

      if (decayed > 0 || pruned > 0) {
        logger.info({ decayed, pruned, scanned: keys.length }, 'Reputation decay sweep completed');
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Reputation decay sweep failed');
    }
  }

  // --- Private helpers ----------------------------------------------------

  private async saveDomainReputation(proxyId: string, domain: string, rep: DomainReputation): Promise<void> {
    const key = `iprep:${proxyId}:${domain}`;
    // TTL: 2 hours for domain-specific reputation (enough to be useful, not too long)
    await cacheSet(key, rep, 7200);
  }

  private async saveGlobalReputation(proxyId: string, rep: GlobalReputation): Promise<void> {
    const key = `iprep:global:${proxyId}`;
    // TTL: 24 hours for global reputation
    await cacheSet(key, rep, 86400);
  }

  private inferBlacklistReason(statusCode?: number): string {
    if (!statusCode) return 'consecutive_failures';
    switch (statusCode) {
      case 403: return 'access_denied_403';
      case 429: return 'rate_limited_429';
      case 503: return 'service_unavailable_503';
      default: return `http_${statusCode}`;
    }
  }
}

// --- Singleton ----------------------------------------------------------------

export const ipReputationTracker = new IPReputationTracker();
