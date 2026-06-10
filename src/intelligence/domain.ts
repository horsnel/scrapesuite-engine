import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import type { DomainProfile, StrategyRecommendation } from '../types';

const logger = createChildLogger('domain-intelligence');

// In-memory LRU cache (tier 1)
const memoryCache = new Map<string, { profile: DomainProfile; expires: number }>();
const MEMORY_TTL = 60_000; // 1 minute

// Constants
const EMA_ALPHA = 0.1;
const MIN_SAFE_RPS = 0.1;
const MAX_SAFE_RPS = 20;
const DEFAULT_SAFE_RPS = 5;
const DEFAULT_CACHE_TTL = 3600;
const BROWSER_CONFIDENCE_THRESHOLD = 0.7;

export class DomainIntelligence {
  /**
   * Get a domain profile, checking 3-tier cache: memory → Redis → PostgreSQL
   */
  async getProfile(domain: string): Promise<DomainProfile> {
    // Tier 1: Memory
    const memEntry = memoryCache.get(domain);
    if (memEntry && memEntry.expires > Date.now()) {
      return memEntry.profile;
    }

    // Tier 2: Redis
    const cached = await cacheGet<DomainProfile>(`domain:${domain}`);
    if (cached) {
      this.setMemory(domain, cached);
      return cached;
    }

    // Tier 3: PostgreSQL
    const dbProfile = await db.domainProfile.findUnique({ where: { domain } });
    if (dbProfile) {
      const profile = this.dbToProfile(dbProfile);
      await cacheSet(`domain:${domain}`, profile, 300);
      this.setMemory(domain, profile);
      return profile;
    }

    // Default profile for new domains
    return this.defaultProfile(domain);
  }

  /**
   * Get strategy recommendation for a domain.
   * Now supports stealth-browser strategy for heavily protected sites.
   */
  async recommendStrategy(domain: string): Promise<StrategyRecommendation> {
    const profile = await this.getProfile(domain);

    // If we detect heavy anti-bot, recommend stealth browser + residential proxy
    if (profile.hasCloudflare || profile.hasAkamai || profile.hasPerimeterX || profile.hasImperva) {
      return {
        strategy: 'stealth-browser',
        proxyTier: 'residential',
        cacheTtl: profile.cacheTtlSeconds,
        safeRps: Math.max(MIN_SAFE_RPS, profile.safeRps * 0.5),
        confidence: 0.9,
      };
    }

    // If we have high confidence that browser is needed (DataDome, JS requirement)
    if (profile.requiresBrowser && profile.browserConfidence >= BROWSER_CONFIDENCE_THRESHOLD) {
      const useStealth = profile.hasDatadome;
      return {
        strategy: useStealth ? 'stealth-browser' : 'browser',
        proxyTier: profile.optimalProxyTier as any || 'residential',
        cacheTtl: profile.cacheTtlSeconds,
        safeRps: profile.safeRps,
        confidence: profile.browserConfidence,
      };
    }

    // If we have high confidence that HTTP works
    if (profile.sampleCount >= 5 && profile.successRate >= 0.8 && !profile.requiresJs) {
      return {
        strategy: 'http',
        proxyTier: profile.optimalProxyTier as any || 'datacenter',
        cacheTtl: profile.cacheTtlSeconds,
        safeRps: profile.safeRps,
        confidence: profile.successRate,
      };
    }

    // Default: try HTTP first, will auto-escalate
    return {
      strategy: 'http',
      proxyTier: 'residential',
      cacheTtl: DEFAULT_CACHE_TTL,
      safeRps: DEFAULT_SAFE_RPS,
      confidence: 0.5,
    };
  }

  /**
   * Record the outcome of a scrape job and update domain profile.
   * Now tracks Akamai, PerimeterX, and Imperva detections.
   */
  async recordOutcome(
    domain: string,
    outcome: {
      success: boolean;
      statusCode?: number;
      responseMs: number;
      strategy: 'http' | 'browser';
      usedBrowser: boolean;
      detectedCloudflare?: boolean;
      detectedDataDome?: boolean;
      detectedAkamai?: boolean;
      detectedPerimeterX?: boolean;
      detectedImperva?: boolean;
      pageSizeKb?: number;
      hadEmptyHtml?: boolean;
    },
  ): Promise<void> {
    try {
      const profile = await this.getProfile(domain);
      const alpha = EMA_ALPHA;

      // Update success rate with EMA
      const newSuccessRate = outcome.success
        ? profile.successRate * (1 - alpha) + 1 * alpha
        : profile.successRate * (1 - alpha);

      // Update response time with EMA
      const newAvgResponseMs = profile.avgResponseMs === 0
        ? outcome.responseMs
        : profile.avgResponseMs * (1 - alpha) + outcome.responseMs * alpha;

      // Update page size with EMA
      const newAvgPageSizeKb = outcome.pageSizeKb
        ? (profile.avgPageSizeKb === 0
          ? outcome.pageSizeKb
          : profile.avgPageSizeKb * (1 - alpha) + outcome.pageSizeKb * alpha)
        : profile.avgPageSizeKb;

      // Update safeRPS based on outcome
      let newSafeRps = profile.safeRps;
      if (outcome.statusCode === 429) {
        newSafeRps = Math.max(MIN_SAFE_RPS, profile.safeRps * 0.5);
      } else if (outcome.success && outcome.responseMs < profile.avgResponseMs * 1.5) {
        newSafeRps = Math.min(MAX_SAFE_RPS, profile.safeRps * 1.02);
      }

      // Update browser requirement
      let newRequiresBrowser = profile.requiresBrowser;
      let newBrowserConfidence = profile.browserConfidence;
      if (outcome.hadEmptyHtml && outcome.strategy === 'http') {
        newRequiresBrowser = true;
        newBrowserConfidence = Math.min(1, profile.browserConfidence + 0.15);
      } else if (outcome.success && outcome.strategy === 'http' && !outcome.hadEmptyHtml) {
        newBrowserConfidence = Math.max(0, profile.browserConfidence - 0.05);
        if (newBrowserConfidence < 0.3) newRequiresBrowser = false;
      }

      // Detect anti-bot services (sticky -- once detected, stays detected)
      const newHasCloudflare = outcome.detectedCloudflare ?? profile.hasCloudflare;
      const newHasDataDome = outcome.detectedDataDome ?? profile.hasDatadome;
      const newHasAkamai = outcome.detectedAkamai ?? profile.hasAkamai;
      const newHasPerimeterX = outcome.detectedPerimeterX ?? profile.hasPerimeterX;
      const newHasImperva = outcome.detectedImperva ?? profile.hasImperva;
      const newRequiresJs = newRequiresBrowser || newHasCloudflare || newHasDataDome || newHasAkamai || newHasPerimeterX || newHasImperva;

      // Adjust cache TTL based on success
      let newCacheTtl = profile.cacheTtlSeconds;
      if (outcome.statusCode === 429) {
        newCacheTtl = Math.min(86400, newCacheTtl * 2);
      } else if (outcome.success && profile.cacheTtlSeconds < DEFAULT_CACHE_TTL) {
        newCacheTtl = Math.min(DEFAULT_CACHE_TTL, newCacheTtl * 1.1);
      }

      // Determine optimal proxy tier
      let optimalProxyTier = profile.optimalProxyTier;
      if (newHasCloudflare || newHasDataDome || newHasAkamai || newHasPerimeterX || newHasImperva) {
        optimalProxyTier = 'residential';
      } else if (newSuccessRate > 0.9 && newAvgResponseMs < 2000) {
        optimalProxyTier = 'datacenter';
      }

      const updatedProfile: DomainProfile = {
        domain,
        requiresBrowser: newRequiresBrowser,
        browserConfidence: Math.round(newBrowserConfidence * 1000) / 1000,
        optimalProxyTier,
        safeRps: Math.round(newSafeRps * 100) / 100,
        avgResponseMs: Math.round(newAvgResponseMs),
        successRate: Math.round(newSuccessRate * 1000) / 1000,
        sampleCount: profile.sampleCount + 1,
        hasCloudflare: newHasCloudflare,
        hasDatadome: newHasDataDome,
        hasAkamai: newHasAkamai,
        hasPerimeterX: newHasPerimeterX,
        hasImperva: newHasImperva,
        requiresJs: newRequiresJs,
        requiresCaptcha: profile.requiresCaptcha || false,
        avgPageSizeKb: Math.round(newAvgPageSizeKb * 10) / 10,
        cacheTtlSeconds: newCacheTtl,
        robotsTxtAllowed: profile.robotsTxtAllowed,
        lastUpdated: new Date().toISOString(),
      };

      // Persist to PostgreSQL (upsert)
      await db.domainProfile.upsert({
        where: { domain },
        update: {
          requiresBrowser: updatedProfile.requiresBrowser,
          browserConfidence: updatedProfile.browserConfidence,
          optimalProxyTier: updatedProfile.optimalProxyTier,
          safeRps: updatedProfile.safeRps,
          avgResponseMs: updatedProfile.avgResponseMs,
          successRate: updatedProfile.successRate,
          sampleCount: updatedProfile.sampleCount,
          hasCloudflare: updatedProfile.hasCloudflare,
          hasDatadome: updatedProfile.hasDatadome,
          hasAkamai: updatedProfile.hasAkamai,
          hasPerimeterX: updatedProfile.hasPerimeterX,
          hasImperva: updatedProfile.hasImperva,
          requiresJs: updatedProfile.requiresJs,
          avgPageSizeKb: updatedProfile.avgPageSizeKb,
          cacheTtlSeconds: updatedProfile.cacheTtlSeconds,
          lastUpdated: new Date(),
        },
        create: {
          domain,
          requiresBrowser: updatedProfile.requiresBrowser,
          browserConfidence: updatedProfile.browserConfidence,
          optimalProxyTier: updatedProfile.optimalProxyTier,
          safeRps: updatedProfile.safeRps,
          avgResponseMs: updatedProfile.avgResponseMs,
          successRate: updatedProfile.successRate,
          sampleCount: updatedProfile.sampleCount,
          hasCloudflare: updatedProfile.hasCloudflare,
          hasDatadome: updatedProfile.hasDatadome,
          hasAkamai: updatedProfile.hasAkamai,
          hasPerimeterX: updatedProfile.hasPerimeterX,
          hasImperva: updatedProfile.hasImperva,
          requiresJs: updatedProfile.requiresJs,
          avgPageSizeKb: updatedProfile.avgPageSizeKb,
          cacheTtlSeconds: updatedProfile.cacheTtlSeconds,
        },
      });

      // Update caches
      await cacheSet(`domain:${domain}`, updatedProfile, 300);
      this.setMemory(domain, updatedProfile);

      logger.debug({ domain, successRate: newSuccessRate, safeRps: newSafeRps, strategy: outcome.strategy }, 'Domain profile updated');
    } catch (error) {
      logger.error({ domain, error }, 'Failed to record domain outcome');
    }
  }

  private setMemory(domain: string, profile: DomainProfile): void {
    memoryCache.set(domain, { profile, expires: Date.now() + MEMORY_TTL });
    if (memoryCache.size > 1000) {
      const now = Date.now();
      for (const [key, entry] of memoryCache) {
        if (entry.expires <= now) memoryCache.delete(key);
      }
    }
  }

  private defaultProfile(domain: string): DomainProfile {
    return {
      domain,
      requiresBrowser: false,
      browserConfidence: 0,
      optimalProxyTier: 'residential',
      safeRps: DEFAULT_SAFE_RPS,
      avgResponseMs: 0,
      successRate: 1.0,
      sampleCount: 0,
      hasCloudflare: false,
      hasDatadome: false,
      hasAkamai: false,
      hasPerimeterX: false,
      hasImperva: false,
      requiresJs: false,
      requiresCaptcha: false,
      avgPageSizeKb: 0,
      cacheTtlSeconds: DEFAULT_CACHE_TTL,
      robotsTxtAllowed: true,
      lastUpdated: new Date().toISOString(),
    };
  }

  private dbToProfile(row: any): DomainProfile {
    return {
      domain: row.domain,
      requiresBrowser: row.requiresBrowser,
      browserConfidence: row.browserConfidence,
      optimalProxyTier: row.optimalProxyTier,
      safeRps: row.safeRps,
      avgResponseMs: row.avgResponseMs,
      successRate: row.successRate,
      sampleCount: row.sampleCount,
      hasCloudflare: row.hasCloudflare,
      hasDatadome: row.hasDatadome,
      hasAkamai: row.hasAkamai ?? false,
      hasPerimeterX: row.hasPerimeterX ?? false,
      hasImperva: row.hasImperva ?? false,
      requiresJs: row.requiresJs,
      requiresCaptcha: row.requiresCaptcha ?? false,
      avgPageSizeKb: row.avgPageSizeKb,
      cacheTtlSeconds: row.cacheTtlSeconds,
      robotsTxtAllowed: row.robotsTxtAllowed ?? true,
      lastUpdated: row.lastUpdated.toISOString(),
    };
  }
}

// Singleton
export const domainIntelligence = new DomainIntelligence();
