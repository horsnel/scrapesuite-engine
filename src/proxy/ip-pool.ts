/**
 * Smart IP Pool Manager
 *
 * A unified "mega-pool" that aggregates ALL proxy sources -- database proxies,
 * residential provider APIs, and dynamically acquired IPs -- into a single
 * intelligent pool with:
 *
 *  - Unified selection: one API to get the best IP regardless of source
 *  - Reputation-aware selection: uses IPReputationTracker to avoid blacklisted IPs
 *  - Geographic optimization: smart allocation by country/city/ASN
 *  - IP cooling periods: recently used IPs get a cooldown to avoid detection
 *  - Demand-driven auto-scaling: pool grows when demand exceeds supply
 *  - Cost optimization: prefers cheaper providers when quality is similar
 *  - Pre-warming: proactively acquire IPs for known high-traffic domains
 *  - Pool health monitoring: continuous tracking of pool utilization
 *
 * This is the single entry point for all IP selection in the orchestrator,
 * replacing direct calls to proxyManager.getProxy() and
 * residentialProxyManager.getProxy().
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { ipReputationTracker } from './reputation';
import { residentialProxyManager, type ProxyProvider } from './residential-providers';
import { testProxy } from '../utils/proxy-fetch';

const logger = createChildLogger('ip-pool');

// --- Constants ----------------------------------------------------------------

/** How long an IP is "cooling" after use (ms). During cooling, it won't be
 *  returned for the same domain (but can be used for other domains). */
const IP_COOLDOWN_MS = 60_000; // 1 minute

/** Minimum pool utilization before auto-scaling kicks in (0-1). */
const AUTO_SCALE_THRESHOLD = 0.8;

/** Maximum concurrent proxy acquisitions from external providers. */
const MAX_CONCURRENT_ACQUISITIONS = 10;

/** How often the pool monitor runs (ms). */
const POOL_MONITOR_INTERVAL_MS = 60_000; // 1 minute

/** How many IPs to pre-warm for a high-traffic domain. */
const PREWARM_COUNT = 5;

/** TTL for cached pool stats (seconds). */
const POOL_STATS_CACHE_TTL = 30;

// --- Types --------------------------------------------------------------------

export type ProxySource = 'database' | 'brightdata' | 'oxylabs' | 'smartproxy' | 'iproyal' | 'webshare' | 'generic';

export interface IPPoolRequest {
  domain: string;
  tier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  country?: string;
  city?: string;
  asn?: string;
  sessionId?: string;
  /** If true, only return IPs with good reputation for this domain. */
  requireReputation?: boolean;
  /** Maximum cost per GB the user is willing to pay. */
  maxCostPerGb?: number;
}

export interface IPPoolResult {
  proxyUrl: string;
  proxyId: string;
  source: ProxySource;
  country: string;
  city?: string;
  asn?: string;
  tier: string;
  reputationScore: number;
  isWarmed: boolean;
  costPerGb: number;
  sessionId?: string;
}

export interface PoolStats {
  totalAvailable: number;
  totalInUse: number;
  totalCooling: number;
  totalBlacklisted: number;
  bySource: Record<ProxySource, { available: number; inUse: number; avgScore: number }>;
  byTier: Record<string, number>;
  byCountry: Record<string, number>;
  utilizationRate: number;
  autoScaleActive: boolean;
  demandQueueLength: number;
  lastUpdated: number;
}

export interface PoolDemandSignal {
  domain: string;
  tier: string;
  country?: string;
  requestedAt: number;
  fulfilled: boolean;
}

// --- SmartIPPoolManager ------------------------------------------------------

export class SmartIPPoolManager {
  /** IPs currently "in use" (active requests). proxyId → { domain, acquiredAt } */
  private inUseMap = new Map<string, { domain: string; acquiredAt: number }>();

  /** IPs in cooldown (recently used for a domain). proxyId+domain → cooldownUntil */
  private cooldownMap = new Map<string, number>();

  /** Pending demand signals (requests waiting for IPs). */
  private demandQueue: PoolDemandSignal[] = [];

  /** Pool monitor timer. */
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  /** Auto-scaling state. */
  private autoScaleActive = false;

  /** Number of external IPs acquired via auto-scaling. */
  private autoScaledCount = 0;

  /** Pre-warmed IPs per domain. domain → Set of proxyIds. */
  private prewarmedMap = new Map<string, Set<string>>();

  // --- Get Proxy (Main Entry Point) ---------------------------------------

  /**
   * Get the best available IP for a given request.
   *
   * Selection algorithm:
   *  1. Check sticky session → return session IP if valid
   *  2. Check pre-warmed pool for this domain → return pre-warmed IP
   *  3. Check database proxies → rank by reputation, filter blacklisted
   *  4. Check residential providers → acquire from best provider
   *  5. If all sources exhausted → record demand signal for auto-scaling
   */
  async getProxy(request: IPPoolRequest): Promise<IPPoolResult | null> {
    const {
      domain,
      tier = 'residential',
      country,
      city,
      asn,
      sessionId,
      requireReputation = false,
      maxCostPerGb,
    } = request;

    // -- Step 1: Check sticky session in Redis -----------------------------
    if (sessionId) {
      const stickyKey = `pool:sticky:${sessionId}`;
      const sticky = await cacheGet<{ proxyId: string; proxyUrl: string; source: ProxySource; country: string; tier: string; city?: string; asn?: string; costPerGb: number }>(stickyKey);
      if (sticky) {
        // Check if the sticky IP is still usable
        const verdict = await ipReputationTracker.getVerdict(sticky.proxyId, domain);
        if (verdict.usable) {
          this.markInUse(sticky.proxyId, domain);
          return {
            proxyUrl: sticky.proxyUrl,
            proxyId: sticky.proxyId,
            source: sticky.source,
            country: sticky.country,
            city: sticky.city,
            asn: sticky.asn,
            tier: sticky.tier,
            reputationScore: verdict.score,
            isWarmed: verdict.warm,
            costPerGb: sticky.costPerGb,
            sessionId,
          };
        }
        // Sticky IP is blacklisted -- clear and find a new one
        await redis.del(`cache:${stickyKey}`);
      }
    }

    // -- Step 2: Check pre-warmed pool -------------------------------------
    const prewarmed = this.prewarmedMap.get(domain);
    if (prewarmed && prewarmed.size > 0) {
      for (const proxyId of prewarmed) {
        const verdict = await ipReputationTracker.getVerdict(proxyId, domain);
        if (verdict.usable && !this.isInUse(proxyId) && !this.isCooling(proxyId, domain)) {
          const proxy = await this.getProxyDetails(proxyId);
          if (proxy) {
            prewarmed.delete(proxyId);
            this.markInUse(proxyId, domain);

            if (sessionId) {
              await this.setStickySession(sessionId, proxyId, proxy.url, proxy.source, proxy.country, proxy.tier, proxy.city, proxy.asn, 0);
            }

            return {
              proxyUrl: proxy.url,
              proxyId,
              source: proxy.source,
              country: proxy.country,
              city: proxy.city,
              asn: proxy.asn,
              tier: proxy.tier,
              reputationScore: verdict.score,
              isWarmed: verdict.warm,
              costPerGb: 0,
              sessionId,
            };
          }
        }
      }
    }

    // -- Step 3: Try database proxies --------------------------------------
    const dbResult = await this.tryDatabaseProxies(domain, tier, country, city, asn, requireReputation, maxCostPerGb);
    if (dbResult) {
      this.markInUse(dbResult.proxyId, domain);
      this.setCooldown(dbResult.proxyId, domain);

      if (sessionId) {
        await this.setStickySession(sessionId, dbResult.proxyId, dbResult.proxyUrl, dbResult.source, dbResult.country, dbResult.tier, dbResult.city, dbResult.asn, dbResult.costPerGb);
      }

      return dbResult;
    }

    // -- Step 4: Try residential providers ---------------------------------
    const providerResult = await this.tryResidentialProviders(domain, tier, country, city, asn, maxCostPerGb);
    if (providerResult) {
      this.markInUse(providerResult.proxyId, domain);

      if (sessionId) {
        await this.setStickySession(sessionId, providerResult.proxyId, providerResult.proxyUrl, providerResult.source, providerResult.country, providerResult.tier, providerResult.city, providerResult.asn, providerResult.costPerGb);
      }

      return providerResult;
    }

    // -- Step 5: Record demand signal for auto-scaling ---------------------
    this.demandQueue.push({
      domain,
      tier,
      country,
      requestedAt: Date.now(),
      fulfilled: false,
    });

    logger.warn(
      { domain, tier, country, city, asn, demandQueueLength: this.demandQueue.length },
      'No IP available -- recorded demand signal for auto-scaling',
    );

    return null;
  }

  // --- Release Proxy ------------------------------------------------------

  /**
   * Release a proxy back to the pool after use.
   * Records the outcome in the reputation tracker and puts the IP on cooldown.
   */
  async releaseProxy(
    proxyId: string,
    domain: string,
    success: boolean,
    statusCode?: number,
    source?: ProxySource,
  ): Promise<void> {
    // Remove from in-use map
    this.inUseMap.delete(proxyId);

    // Record in reputation tracker
    await ipReputationTracker.recordOutcome(proxyId, domain, success, statusCode);

    // If the request failed, put the IP on cooldown for this domain
    if (!success) {
      this.setCooldown(proxyId, domain);

      // If it was a hard block (403/429), blacklist the IP for this domain
      if (statusCode === 403 || statusCode === 429) {
        const cooldownMs = statusCode === 429 ? 5 * 60 * 1000 : 10 * 60 * 1000;
        await ipReputationTracker.blacklistProxy(proxyId, domain, `http_${statusCode}`, cooldownMs);
      }
    } else {
      // If it was a residential provider, release back to provider
      if (source) {
        await residentialProxyManager.releaseProxy(source as ProxyProvider, success);
      }
    }

    // Fulfill any pending demand signals
    this.fulfillDemand(domain);
  }

  // --- Pool Stats ---------------------------------------------------------

  /**
   * Get current pool statistics.
   */
  async getPoolStats(): Promise<PoolStats> {
    // Try cache first
    const cached = await cacheGet<PoolStats>('pool:stats');
    if (cached) return cached;

    const [totalActive, totalRetired] = await Promise.all([
      db.proxy.count({ where: { retired: false } }),
      db.proxy.count({ where: { retired: true } }),
    ]);

    const tierGroups = await db.proxy.groupBy({
      by: ['tier'],
      _count: { tier: true },
      where: { retired: false },
    });

    const countryGroups = await db.proxy.groupBy({
      by: ['country'],
      _count: { country: true },
      where: { retired: false },
    });

    const providerGroups = await db.proxy.groupBy({
      by: ['provider'],
      _count: { provider: true },
      where: { retired: false },
    });

    const totalAvailable = totalActive;
    const totalInUse = this.inUseMap.size;
    const totalCooling = this.cooldownMap.size;
    const utilizationRate = totalAvailable > 0 ? totalInUse / totalAvailable : 0;

    const bySource: Record<string, { available: number; inUse: number; avgScore: number }> = {};
    for (const g of providerGroups) {
      const source = g.provider as ProxySource;
      bySource[source] = { available: g._count.provider, inUse: 0, avgScore: 0.5 };
    }
    // Add residential provider stats
    const providerStats = residentialProxyManager.getProviderStats();
    for (const ps of providerStats) {
      if (!bySource[ps.provider]) {
        bySource[ps.provider] = { available: 0, inUse: ps.currentConcurrent, avgScore: ps.totalRequests > 0 ? ps.successRate : 0.5 };
      }
    }

    const stats: PoolStats = {
      totalAvailable,
      totalInUse,
      totalCooling,
      totalBlacklisted: totalRetired,
      bySource: bySource as any,
      byTier: Object.fromEntries(tierGroups.map((g) => [g.tier, g._count.tier])),
      byCountry: Object.fromEntries(countryGroups.map((g) => [g.country, g._count.country])),
      utilizationRate: Math.round(utilizationRate * 1000) / 1000,
      autoScaleActive: this.autoScaleActive,
      demandQueueLength: this.demandQueue.filter((d) => !d.fulfilled).length,
      lastUpdated: Date.now(),
    };

    await cacheSet('pool:stats', stats, POOL_STATS_CACHE_TTL);
    return stats;
  }

  // --- Pre-warm -----------------------------------------------------------

  /**
   * Pre-warm IPs for a high-traffic domain.
   * Acquires IPs from the pool and keeps them ready for immediate use.
   */
  async prewarmDomain(domain: string, tier: 'residential' | 'mobile' | 'datacenter' | 'isp' = 'residential', country?: string): Promise<number> {
    let warmed = 0;

    logger.info({ domain, tier, country, target: PREWARM_COUNT }, 'Starting domain pre-warming');

    for (let i = 0; i < PREWARM_COUNT; i++) {
      try {
        // Try database first
        const dbProxies = await db.proxy.findMany({
          where: {
            tier: tier as any,
            retired: false,
            ...(country ? { country: country.toUpperCase() } : {}),
            successRate: { gt: 0.5 },
          },
          orderBy: [{ successRate: 'desc' }, { p95Latency: 'asc' }],
          take: PREWARM_COUNT * 3, // Get more than needed for reputation filtering
        });

        for (const proxy of dbProxies) {
          const verdict = await ipReputationTracker.getVerdict(proxy.id, domain);
          if (verdict.usable && verdict.score > 0.4 && !this.isInUse(proxy.id)) {
            if (!this.prewarmedMap.has(domain)) {
              this.prewarmedMap.set(domain, new Set());
            }
            this.prewarmedMap.get(domain)!.add(proxy.id);
            warmed++;
            break;
          }
        }

        // If not enough from DB, try residential providers
        if (warmed <= i) {
          const providerResult = await residentialProxyManager.getProxy({
            country,
            tier,
          });

          if (providerResult) {
            // Store the provider proxy in DB for future reuse
            await db.proxy.upsert({
              where: { id: providerResult.proxyId },
              update: { url: providerResult.proxyUrl, retired: false, lastUsed: new Date() },
              create: {
                id: providerResult.proxyId,
                url: providerResult.proxyUrl,
                tier: (providerResult.tier || tier) as any,
                country: providerResult.country,
                city: providerResult.city,
                asn: providerResult.asn,
                provider: providerResult.provider,
                successRate: 0.5,
              },
            });

            if (!this.prewarmedMap.has(domain)) {
              this.prewarmedMap.set(domain, new Set());
            }
            this.prewarmedMap.get(domain)!.add(providerResult.proxyId);
            warmed++;
          }
        }
      } catch (err: any) {
        logger.warn({ domain, error: err.message }, 'Pre-warm acquisition failed');
      }
    }

    logger.info({ domain, warmed, target: PREWARM_COUNT }, 'Domain pre-warming completed');
    return warmed;
  }

  // --- Auto-Scaling -------------------------------------------------------

  /**
   * Start the pool monitor that handles auto-scaling and maintenance.
   */
  startPoolMonitor(): void {
    if (this.monitorTimer) return;

    this.monitorTimer = setInterval(async () => {
      await this.runPoolMonitor();
    }, POOL_MONITOR_INTERVAL_MS);

    logger.info({ intervalMs: POOL_MONITOR_INTERVAL_MS }, 'IP pool monitor started');
  }

  stopPoolMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  private async runPoolMonitor(): Promise<void> {
    try {
      const stats = await this.getPoolStats();

      // -- Check utilization and auto-scale if needed ------------------------
      if (stats.utilizationRate > AUTO_SCALE_THRESHOLD && !this.autoScaleActive) {
        this.autoScaleActive = true;
        logger.info(
          { utilizationRate: stats.utilizationRate, threshold: AUTO_SCALE_THRESHOLD },
          'Pool utilization high -- activating auto-scaling',
        );
        await this.autoScale();
      } else if (stats.utilizationRate < AUTO_SCALE_THRESHOLD * 0.7) {
        this.autoScaleActive = false;
      }

      // -- Process demand queue ----------------------------------------------
      await this.processDemandQueue();

      // -- Clean up expired cooldowns ----------------------------------------
      this.cleanupExpiredCooldowns();

      // -- Clean up fulfilled/old demand signals -----------------------------
      this.cleanupDemandQueue();
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Pool monitor run failed');
    }
  }

  private async autoScale(): Promise<void> {
    // Group demand signals by domain to find the most needy targets
    const domainDemand = new Map<string, { count: number; tier: string; country?: string }>();
    for (const signal of this.demandQueue.filter((d) => !d.fulfilled)) {
      const key = signal.domain;
      const existing = domainDemand.get(key);
      if (existing) {
        existing.count++;
      } else {
        domainDemand.set(key, { count: 1, tier: signal.tier, country: signal.country });
      }
    }

    // Sort by demand count (highest first)
    const sortedDemand = Array.from(domainDemand.entries())
      .sort((a, b) => b[1].count - a[1].count);

    // Acquire IPs for the top 3 most demanding domains
    const toAcquire = Math.min(sortedDemand.length, 3);
    for (let i = 0; i < toAcquire; i++) {
      const [domain, demand] = sortedDemand[i];

      try {
        const providerResult = await residentialProxyManager.getProxy({
          country: demand.country,
          tier: demand.tier as any,
        });

        if (providerResult) {
          // Store in DB for reuse
          await db.proxy.upsert({
            where: { id: providerResult.proxyId },
            update: { url: providerResult.proxyUrl, retired: false, lastUsed: new Date() },
            create: {
              id: providerResult.proxyId,
              url: providerResult.proxyUrl,
              tier: (providerResult.tier || demand.tier) as any,
              country: providerResult.country,
              city: providerResult.city,
              asn: providerResult.asn,
              provider: providerResult.provider,
              successRate: 0.5,
            },
          });

          this.autoScaledCount++;

          // Add to pre-warmed pool for this domain
          if (!this.prewarmedMap.has(domain)) {
            this.prewarmedMap.set(domain, new Set());
          }
          this.prewarmedMap.get(domain)!.add(providerResult.proxyId);

          logger.info(
            { domain, proxyId: providerResult.proxyId, provider: providerResult.provider, totalAutoScaled: this.autoScaledCount },
            'Auto-scaled: acquired new IP for high-demand domain',
          );
        }
      } catch (err: any) {
        logger.warn({ domain, error: err.message }, 'Auto-scale acquisition failed');
      }
    }
  }

  private async processDemandQueue(): Promise<void> {
    const pending = this.demandQueue.filter((d) => !d.fulfilled);
    if (pending.length === 0) return;

    for (const signal of pending.slice(0, 10)) {
      const result = await this.tryDatabaseProxies(signal.domain, signal.tier as any, signal.country);
      if (result) {
        signal.fulfilled = true;
        if (!this.prewarmedMap.has(signal.domain)) {
          this.prewarmedMap.set(signal.domain, new Set());
        }
        this.prewarmedMap.get(signal.domain)!.add(result.proxyId);
      }
    }
  }

  // --- Private: Database Proxy Selection ----------------------------------

  private async tryDatabaseProxies(
    domain: string,
    tier: string,
    country?: string,
    city?: string,
    asn?: string,
    requireReputation?: boolean,
    maxCostPerGb?: number,
  ): Promise<IPPoolResult | null> {
    try {
      const where: any = { tier: tier as any, retired: false };
      if (country) where.country = country.toUpperCase();
      if (city) where.city = city;
      if (asn) where.asn = asn;

      // Get candidates from DB
      const candidates = await db.proxy.findMany({
        where,
        orderBy: [
          { successRate: 'desc' },
          { p95Latency: 'asc' },
        ],
        take: 30, // Get top 30 candidates for reputation ranking
      });

      if (candidates.length === 0) return null;

      // Filter out in-use and cooling IPs
      const available = candidates.filter(
        (p) => !this.isInUse(p.id) && !this.isCooling(p.id, domain),
      );

      if (available.length === 0) return null;

      // Get proxy IDs for reputation ranking
      const proxyIds = available.map((p) => p.id);
      const ranked = await ipReputationTracker.rankProxiesForDomain(proxyIds, domain, 10);

      if (ranked.length === 0) return null;

      // If reputation is required, only use warm IPs
      const eligible = requireReputation
        ? ranked.filter((r) => r.warm && r.score > 0.6)
        : ranked;

      if (eligible.length === 0 && requireReputation) return null;

      // Pick the best ranked proxy
      const best = eligible[0] || ranked[0];
      const proxy = available.find((p) => p.id === best.proxyId);
      if (!proxy) return null;

      // Determine source
      const source = this.inferSource(proxy.provider);

      return {
        proxyUrl: proxy.url,
        proxyId: proxy.id,
        source,
        country: proxy.country,
        city: proxy.city || undefined,
        asn: proxy.asn || undefined,
        tier: proxy.tier,
        reputationScore: best.score,
        isWarmed: best.warm,
        costPerGb: 0, // Database proxies have no per-GB cost
      };
    } catch (err: any) {
      logger.warn({ domain, tier, error: err.message }, 'Database proxy selection failed');
      return null;
    }
  }

  // --- Private: Residential Provider Selection ----------------------------

  private async tryResidentialProviders(
    domain: string,
    tier: string,
    country?: string,
    city?: string,
    asn?: string,
    maxCostPerGb?: number,
  ): Promise<IPPoolResult | null> {
    try {
      const result = await residentialProxyManager.getProxy({
        country,
        city,
        asn,
        tier: tier as any,
      });

      if (!result) return null;

      // Check cost constraint
      if (maxCostPerGb && result.costPerGb > maxCostPerGb) {
        // This provider is too expensive -- try to find a cheaper one
        await residentialProxyManager.releaseProxy(result.provider, false);
        return null;
      }

      // Store the acquired proxy in DB for reuse and tracking
      await db.proxy.upsert({
        where: { id: result.proxyId },
        update: {
          url: result.proxyUrl,
          retired: false,
          lastUsed: new Date(),
          ...(result.city ? { city: result.city } : {}),
          ...(result.asn ? { asn: result.asn } : {}),
        },
        create: {
          id: result.proxyId,
          url: result.proxyUrl,
          tier: (result.tier || tier) as any,
          country: result.country,
          city: result.city,
          asn: result.asn,
          provider: result.provider,
          successRate: 0.5,
        },
      });

      return {
        proxyUrl: result.proxyUrl,
        proxyId: result.proxyId,
        source: result.provider as ProxySource,
        country: result.country,
        city: result.city,
        asn: result.asn,
        tier: result.tier,
        reputationScore: 0.5, // New IP from provider -- neutral reputation
        isWarmed: false,
        costPerGb: result.costPerGb,
        sessionId: result.sessionId,
      };
    } catch (err: any) {
      logger.warn({ domain, tier, error: err.message }, 'Residential provider selection failed');
      return null;
    }
  }

  // --- Private: Helper Methods --------------------------------------------

  private markInUse(proxyId: string, domain: string): void {
    this.inUseMap.set(proxyId, { domain, acquiredAt: Date.now() });
  }

  private isInUse(proxyId: string): boolean {
    return this.inUseMap.has(proxyId);
  }

  private setCooldown(proxyId: string, domain: string): void {
    this.cooldownMap.set(`${proxyId}:${domain}`, Date.now() + IP_COOLDOWN_MS);
  }

  private isCooling(proxyId: string, domain: string): boolean {
    const key = `${proxyId}:${domain}`;
    const cooldownUntil = this.cooldownMap.get(key);
    if (!cooldownUntil) return false;
    if (Date.now() >= cooldownUntil) {
      this.cooldownMap.delete(key);
      return false;
    }
    return true;
  }

  private cleanupExpiredCooldowns(): void {
    const now = Date.now();
    for (const [key, until] of this.cooldownMap) {
      if (now >= until) {
        this.cooldownMap.delete(key);
      }
    }
  }

  private cleanupDemandQueue(): void {
    const now = Date.now();
    this.demandQueue = this.demandQueue.filter((d) => {
      // Remove fulfilled or older than 5 minutes
      return !d.fulfilled && (now - d.requestedAt < 5 * 60 * 1000);
    });
  }

  private fulfillDemand(domain: string): void {
    for (const signal of this.demandQueue) {
      if (!signal.fulfilled && signal.domain === domain) {
        signal.fulfilled = true;
      }
    }
  }

  private async setStickySession(
    sessionId: string,
    proxyId: string,
    proxyUrl: string,
    source: ProxySource,
    country: string,
    tier: string,
    city?: string,
    asn?: string,
    costPerGb: number = 0,
  ): Promise<void> {
    const key = `pool:sticky:${sessionId}`;
    await cacheSet(key, {
      proxyId,
      proxyUrl,
      source,
      country,
      tier,
      city,
      asn,
      costPerGb,
    }, 600); // 10 min TTL
  }

  private async getProxyDetails(proxyId: string): Promise<{
    url: string;
    source: ProxySource;
    country: string;
    tier: string;
    city?: string;
    asn?: string;
  } | null> {
    try {
      const proxy = await db.proxy.findUnique({ where: { id: proxyId } });
      if (!proxy) return null;
      return {
        url: proxy.url,
        source: this.inferSource(proxy.provider),
        country: proxy.country,
        tier: proxy.tier,
        city: proxy.city || undefined,
        asn: proxy.asn || undefined,
      };
    } catch {
      return null;
    }
  }

  private inferSource(provider: string): ProxySource {
    const knownProviders: Record<string, ProxySource> = {
      brightdata: 'brightdata',
      oxylabs: 'oxylabs',
      smartproxy: 'smartproxy',
      iproyal: 'iproyal',
      webshare: 'webshare',
    };
    return knownProviders[provider] || 'database';
  }

  /**
   * Get a summary of the current pool state for monitoring dashboards.
   */
  getPoolState(): {
    inUseCount: number;
    coolingCount: number;
    prewarmedDomains: number;
    demandQueueLength: number;
    autoScaledCount: number;
    autoScaleActive: boolean;
  } {
    return {
      inUseCount: this.inUseMap.size,
      coolingCount: this.cooldownMap.size,
      prewarmedDomains: this.prewarmedMap.size,
      demandQueueLength: this.demandQueue.filter((d) => !d.fulfilled).length,
      autoScaledCount: this.autoScaledCount,
      autoScaleActive: this.autoScaleActive,
    };
  }
}

// --- Singleton ----------------------------------------------------------------

export const smartIPPool = new SmartIPPoolManager();
