/**
 * Proxy Aggregator -- Unifies Multiple Providers into a Single Mega-Pool
 *
 * This module creates a unified view across all proxy sources:
 *  - Database proxies (self-hosted or static)
 *  - Bright Data (400M+ IPs)
 *  - Oxylabs (100M+ IPs)
 *  - SmartProxy (55M+ IPs)
 *  - IPRoyal (6M+ IPs)
 *  - Webshare (30M+ IPs)
 *  - Generic proxy URLs
 *
 * Features:
 *  - Cost-based selection: prefers cheapest provider that meets requirements
 *  - Automatic failover: if a provider fails, tries the next one
 *  - Pool composition: tracks which providers contribute what to the pool
 *  - Bandwidth tracking per provider for cost allocation
 *  - Provider health aggregation: knows which providers are up
 *  - Dynamic priority: adjusts provider priority based on recent success rates
 *  - Multi-provider session: can use different providers for different requests
 *    in the same session (geo-failover)
 */

import { residentialProxyManager, type ProxyProvider, type ProxyRequestOptions, type ProxyResult } from './residential-providers';
import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';

const logger = createChildLogger('proxy-aggregator');

// --- Constants ----------------------------------------------------------------

/** Cache TTL for aggregated pool composition (seconds). */
const COMPOSITION_CACHE_TTL = 60;

/** How often the aggregator rebalances provider priorities (ms). */
const REBALANCE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Minimum success rate to keep a provider at its base priority. */
const MIN_PROVIDER_SUCCESS_RATE = 0.3;

// --- Types --------------------------------------------------------------------

export interface AggregatedPoolComposition {
  totalProviders: number;
  healthyProviders: number;
  providers: Array<{
    provider: ProxyProvider;
    healthy: boolean;
    priority: number;
    effectivePriority: number;
    successRate: number;
    totalRequests: number;
    totalSuccesses: number;
    totalFailures: number;
    costPerGb: number;
    estimatedIPs: string; // "400M+", "100M+", etc.
  }>;
  databaseProxies: {
    total: number;
    active: number;
    byTier: Record<string, number>;
    byCountry: Record<string, number>;
  };
  lastRebalanced: number;
}

export interface AggregatedProxyRequest {
  domain: string;
  tier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  country?: string;
  city?: string;
  asn?: string;
  sessionId?: string;
  /** Maximum cost per GB the requester is willing to pay. */
  maxCostPerGb?: number;
  /** Preferred provider (if any). */
  preferredProvider?: ProxyProvider;
  /** If true, avoid database proxies (prefer provider IPs). */
  preferProvider?: boolean;
}

export interface AggregatedProxyResult {
  proxyUrl: string;
  proxyId: string;
  provider: ProxyProvider | 'database';
  country: string;
  city?: string;
  asn?: string;
  tier: string;
  costPerGb: number;
  sessionId?: string;
}

// --- Provider Estimated IP Counts --------------------------------------------

const PROVIDER_IP_ESTIMATES: Record<ProxyProvider, string> = {
  brightdata: '400M+',
  oxylabs: '100M+',
  smartproxy: '55M+',
  iproyal: '6M+',
  webshare: '30M+',
  generic: '1K+',
};

// --- ProxyAggregator ---------------------------------------------------------

export class ProxyAggregator {
  private rebalanceTimer: ReturnType<typeof setInterval> | null = null;

  /** Dynamic priority adjustments based on recent performance. */
  private priorityAdjustments = new Map<ProxyProvider, number>();

  // --- Get Proxy (Cost-Optimized Multi-Provider Selection) ----------------

  /**
   * Get a proxy from the aggregated pool.
   *
   * Selection algorithm:
   *  1. If preferredProvider is set, try that provider first
   *  2. If preferProvider, skip database proxies and go straight to providers
   *  3. Otherwise, try database proxies first (free), then providers in
   *     cost-ascending order
   *  4. Apply dynamic priority adjustments based on recent success rates
   *  5. Failover to next provider on failure
   */
  async getProxy(request: AggregatedProxyRequest): Promise<AggregatedProxyResult | null> {
    const {
      domain,
      tier = 'residential',
      country,
      city,
      asn,
      sessionId,
      maxCostPerGb,
      preferredProvider,
      preferProvider = false,
    } = request;

    // -- Step 1: Try preferred provider ------------------------------------
    if (preferredProvider) {
      const result = await this.tryProvider(preferredProvider, tier, country, city, asn, sessionId);
      if (result) {
        if (maxCostPerGb && result.costPerGb > maxCostPerGb) {
          await residentialProxyManager.releaseProxy(preferredProvider, false);
        } else {
          return { ...result, provider: preferredProvider };
        }
      }
    }

    // -- Step 2: Try database proxies (free) -------------------------------
    if (!preferProvider) {
      const dbResult = await this.tryDatabaseProxies(domain, tier, country, city, asn);
      if (dbResult) {
        return dbResult;
      }
    }

    // -- Step 3: Try providers in cost-ascending order with dynamic priority -
    const providers = this.getSortedProviders(maxCostPerGb);

    for (const provider of providers) {
      const result = await this.tryProvider(provider, tier, country, city, asn, sessionId);
      if (result) {
        return { ...result, provider };
      }
    }

    logger.warn(
      { domain, tier, country, preferredProvider },
      'All proxy sources exhausted in aggregated pool',
    );

    return null;
  }

  // --- Get Pool Composition -----------------------------------------------

  /**
   * Get the current composition of the aggregated pool.
   * Useful for dashboards and monitoring.
   */
  async getComposition(): Promise<AggregatedPoolComposition> {
    const cached = await cacheGet<AggregatedPoolComposition>('aggregator:composition');
    if (cached) return cached;

    const providerStats = residentialProxyManager.getProviderStats();
    const providers = providerStats.map((ps) => {
      const basePriority = this.getBasePriority(ps.provider);
      const adjustment = this.priorityAdjustments.get(ps.provider) || 0;
      const effectivePriority = basePriority + adjustment;

      return {
        provider: ps.provider,
        healthy: ps.isHealthy,
        priority: basePriority,
        effectivePriority,
        successRate: ps.successRate,
        totalRequests: ps.totalRequests,
        totalSuccesses: ps.totalSuccesses,
        totalFailures: ps.totalFailures,
        costPerGb: ps.costPerGb,
        estimatedIPs: PROVIDER_IP_ESTIMATES[ps.provider] || 'unknown',
      };
    });

    const [totalActive, tierGroups, countryGroups] = await Promise.all([
      db.proxy.count({ where: { retired: false } }),
      db.proxy.groupBy({ by: ['tier'], _count: { tier: true }, where: { retired: false } }),
      db.proxy.groupBy({ by: ['country'], _count: { country: true }, where: { retired: false } }),
    ]);

    const composition: AggregatedPoolComposition = {
      totalProviders: providers.length,
      healthyProviders: providers.filter((p) => p.healthy).length,
      providers,
      databaseProxies: {
        total: totalActive,
        active: totalActive,
        byTier: Object.fromEntries(tierGroups.map((g) => [g.tier, g._count.tier])),
        byCountry: Object.fromEntries(countryGroups.map((g) => [g.country, g._count.country])),
      },
      lastRebalanced: Date.now(),
    };

    await cacheSet('aggregator:composition', composition, COMPOSITION_CACHE_TTL);
    return composition;
  }

  // --- Rebalance Provider Priorities --------------------------------------

  /**
   * Start periodic rebalancing of provider priorities based on recent
   * performance. Providers with low success rates get deprioritized.
   */
  startRebalancing(): void {
    if (this.rebalanceTimer) return;

    this.rebalanceTimer = setInterval(async () => {
      await this.rebalance();
    }, REBALANCE_INTERVAL_MS);

    logger.info({ intervalMs: REBALANCE_INTERVAL_MS }, 'Provider priority rebalancing started');
  }

  stopRebalancing(): void {
    if (this.rebalanceTimer) {
      clearInterval(this.rebalanceTimer);
      this.rebalanceTimer = null;
    }
  }

  private async rebalance(): Promise<void> {
    try {
      const providerStats = residentialProxyManager.getProviderStats();

      for (const ps of providerStats) {
        if (ps.totalRequests < 10) continue; // Not enough data

        let adjustment = 0;

        // If success rate is very low, increase priority number (lower priority)
        if (ps.successRate < MIN_PROVIDER_SUCCESS_RATE) {
          adjustment = 5; // Significant deprioritization
        } else if (ps.successRate < 0.5) {
          adjustment = 2; // Mild deprioritization
        } else if (ps.successRate > 0.8) {
          adjustment = -1; // Slight boost for high-performing providers
        }

        const oldAdjustment = this.priorityAdjustments.get(ps.provider) || 0;
        if (adjustment !== oldAdjustment) {
          this.priorityAdjustments.set(ps.provider, adjustment);
          logger.info(
            { provider: ps.provider, oldAdjustment, newAdjustment: adjustment, successRate: ps.successRate },
            'Provider priority adjustment updated',
          );
        }
      }

      // Invalidate composition cache
      await redis.del('cache:aggregator:composition');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Provider rebalancing failed');
    }
  }

  // --- Private Methods ----------------------------------------------------

  private async tryProvider(
    provider: ProxyProvider,
    tier: string,
    country?: string,
    city?: string,
    asn?: string,
    sessionId?: string,
  ): Promise<Omit<AggregatedProxyResult, 'provider'> | null> {
    try {
      const result = await residentialProxyManager.getProxy({
        country,
        city,
        asn,
        tier: tier as any,
        sessionId,
      });

      if (result && result.provider === provider) {
        return {
          proxyUrl: result.proxyUrl,
          proxyId: result.proxyId,
          country: result.country,
          city: result.city,
          asn: result.asn,
          tier: result.tier,
          costPerGb: result.costPerGb,
          sessionId: result.sessionId,
        };
      }

      // Got a proxy from a different provider -- release it
      if (result) {
        await residentialProxyManager.releaseProxy(result.provider, false);
      }

      return null;
    } catch {
      return null;
    }
  }

  private async tryDatabaseProxies(
    domain: string,
    tier: string,
    country?: string,
    city?: string,
    asn?: string,
  ): Promise<AggregatedProxyResult | null> {
    try {
      const where: any = { tier: tier as any, retired: false, successRate: { gt: 0.3 } };
      if (country) where.country = country.toUpperCase();
      if (city) where.city = city;
      if (asn) where.asn = asn;

      const proxies = await db.proxy.findMany({
        where,
        orderBy: [{ successRate: 'desc' }, { p95Latency: 'asc' }],
        take: 5,
      });

      if (proxies.length === 0) return null;

      // Pick the best one
      const proxy = proxies[0];

      // Update last used
      await db.proxy.update({
        where: { id: proxy.id },
        data: { lastUsed: new Date() },
      }).catch(() => {});

      return {
        proxyUrl: proxy.url,
        proxyId: proxy.id,
        provider: 'database',
        country: proxy.country,
        city: proxy.city || undefined,
        asn: proxy.asn || undefined,
        tier: proxy.tier,
        costPerGb: 0, // Database proxies are free
      };
    } catch {
      return null;
    }
  }

  /**
   * Get providers sorted by effective priority (cost-ascending with adjustments).
   * Cheapest healthy provider comes first, but dynamic adjustments can reorder.
   */
  private getSortedProviders(maxCostPerGb?: number): ProxyProvider[] {
    const stats = residentialProxyManager.getProviderStats();

    const eligible = stats
      .filter((ps) => {
        if (!ps.isHealthy || !ps.enabled) return false;
        if (maxCostPerGb && ps.costPerGb > maxCostPerGb) return false;
        return true;
      })
      .map((ps) => {
        const basePriority = this.getBasePriority(ps.provider);
        const adjustment = this.priorityAdjustments.get(ps.provider) || 0;
        return {
          provider: ps.provider,
          effectivePriority: basePriority + adjustment,
          costPerGb: ps.costPerGb,
        };
      })
      .sort((a, b) => {
        // Primary sort: effective priority (lower = better)
        if (a.effectivePriority !== b.effectivePriority) {
          return a.effectivePriority - b.effectivePriority;
        }
        // Secondary sort: cost (cheaper = better)
        return a.costPerGb - b.costPerGb;
      });

    return eligible.map((e) => e.provider);
  }

  private getBasePriority(provider: ProxyProvider): number {
    const priorities: Record<ProxyProvider, number> = {
      brightdata: 1,
      oxylabs: 2,
      smartproxy: 3,
      iproyal: 4,
      webshare: 5,
      generic: 10,
    };
    return priorities[provider] || 10;
  }
}

// --- Singleton ----------------------------------------------------------------

export const proxyAggregator = new ProxyAggregator();
