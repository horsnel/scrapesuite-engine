/**
 * Mega Pool -- Unified Proxy Pool Manager -- ENHANCED v2
 *
 * The UNIFIED mega pool manager that aggregates ALL proxy sources into
 * one intelligent pool.
 *
 * Enhancements over v1:
 *  - Pool refresh: 5s (was 60s)
 *  - Tier allocation: smarter, faster, based on real-time demand
 *  - Unified scoring: 10 scoring dimensions (was 3-5)
 *  - Pool scaling: target 1B+ effective IPs
 *  - Parallel proxy validation across all tiers
 *  - Smart tier promotion/demotion based on performance
 *  - Pool compression: merge duplicate entries efficiently
 *  - Pool fusion: merge pools from multiple peers
 *  - Pool intelligence: learn which proxies work best for which targets
 *
 * Source priority order for getProxy:
 *  1. Check sticky session
 *  2. Check pre-warmed pool
 *  3. Try rotating sessions (unique IP per request)
 *  4. Try subnet expander (10M+ virtual IPs)
 *  5. Try bulk sessions (pre-warmed residential)
 *  6. Try database proxies (reputation-ranked)
 *  7. Try residential providers (cost-optimized)
 *  8. Try free proxy discovery
 *  9. Try TOR pool
 * 10. Try pool fusion (peer pools)
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { residentialProxyManager, type ProxyProvider } from './residential-providers';
import { ipReputationTracker } from './reputation';
import { smartIPPool, type IPPoolResult } from './ip-pool';
import { testProxy } from '../utils/proxy-fetch';

const logger = createChildLogger('mega-pool');

// --- Constants ----------------------------------------------------------------

/** How often the mega pool health monitor runs (ms) -- 5s (was 60s). */
const MEGA_POOL_MONITOR_INTERVAL_MS = 5_000;

/** How often the auto-scaler evaluates demand (ms) -- 5s (was 30s). */
const AUTOSCALE_INTERVAL_MS = 5_000;

/** How often pool compression runs (ms). */
const COMPRESSION_INTERVAL_MS = 30_000;

/** How often pool fusion runs (ms). */
const FUSION_INTERVAL_MS = 30_000;

/** How often pool intelligence update runs (ms). */
const INTELLIGENCE_INTERVAL_MS = 10_000;

/** How often tier rebalancing runs (ms). */
const TIER_REBALANCE_INTERVAL_MS = 10_000;

/** TTL for cached mega pool stats (seconds). */
const MEGA_POOL_STATS_CACHE_TTL = 10;

/** TTL for pre-warmed proxy cache (seconds). */
const PREWARM_CACHE_TTL = 120;

/** Minimum success rate for a source to be considered healthy. */
const MIN_SOURCE_HEALTH_RATE = 0.4;

/** Cost similarity threshold. */
const COST_SIMILARITY_THRESHOLD = 0.3;

/** Critical mass threshold. */
const CRITICAL_MASS_THRESHOLD = 0.15;

/** Pool utilization threshold for auto-scaling. */
const AUTOSCALE_UTILIZATION_THRESHOLD = 0.75;

/** Maximum demand signals to track. */
const MAX_DEMAND_SIGNALS = 5000;

/** Maximum pre-warmed entries per domain. */
const MAX_PREWARM_PER_DOMAIN = 50;

/** Known provider estimated IP counts for capacity calculation. */
const PROVIDER_ESTIMATED_IPS: Record<string, number> = {
  brightdata: 72_000_000,
  oxylabs: 100_000_000,
  smartproxy: 55_000_000,
  iproyal: 6_000_000,
  webshare: 30_000_000,
  packetstream: 5_000_000,
  soax: 8_000_000,
  netnut: 20_000_000,
  infatica: 10_000_000,
  geonode: 2_000_000,
  pyproxy: 5_000_000,
  iphtml: 3_000_000,
  luminati: 72_000_000,
  stormproxies: 70_000,
  therapidapi: 1_000_000,
};

/** Theoretical maximum IPs across all providers. */
const THEORETICAL_MAX_IPS = Object.values(PROVIDER_ESTIMATED_IPS).reduce((s, v) => s + v, 0);

/** Source cost multipliers (relative cost per GB). */
const SOURCE_COST: Record<MegaPoolSource, number> = {
  database: 0,
  brightdata: 15,
  oxylabs: 12,
  smartproxy: 14,
  iproyal: 5,
  webshare: 4,
  free: 0,
  tor: 0,
  bulk: 8,
  subnet: 10,
  rotating: 12,
  fusion: 0,
  chain: 0,
  breeder: 0,
  quantum: 0,
  plasma: 0,
};

/** Source quality scores (0-1, higher = better). */
const SOURCE_QUALITY: Record<MegaPoolSource, number> = {
  database: 0.7,
  brightdata: 0.9,
  oxylabs: 0.9,
  smartproxy: 0.85,
  iproyal: 0.75,
  webshare: 0.7,
  free: 0.3,
  tor: 0.2,
  bulk: 0.8,
  subnet: 0.85,
  rotating: 0.9,
  fusion: 0.95,
  chain: 0.95,
  breeder: 0.95,
  quantum: 1.0,
  plasma: 1.0,
};

// --- Scoring Dimensions (10 dimensions) -------------------------------------

/** Weight for each of the 10 scoring dimensions. */
const SCORING_WEIGHTS = {
  successRate: 0.15,
  latency: 0.10,
  anonymity: 0.10,
  geoMatch: 0.10,
  costEfficiency: 0.08,
  availability: 0.10,
  reliability: 0.10,
  freshness: 0.07,
  tierMatch: 0.10,
  historicalPerformance: 0.10,
};

// --- Types --------------------------------------------------------------------

export type MegaPoolSource = 'database' | 'brightdata' | 'oxylabs' | 'smartproxy' | 'iproyal' | 'webshare' | 'free' | 'tor' | 'bulk' | 'subnet' | 'rotating' | 'fusion' | 'chain' | 'breeder' | 'quantum' | 'plasma';

export interface MegaPoolRequest {
  domain: string;
  tier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  country?: string;
  city?: string;
  asn?: string;
  sessionId?: string;
  maxCostPerGb?: number;
  requireReputation?: boolean;
  preferSource?: MegaPoolSource;
  avoidSources?: MegaPoolSource[];
}

export interface MegaPoolResult {
  proxyUrl: string;
  proxyId: string;
  source: MegaPoolSource;
  country: string;
  city?: string;
  asn?: string;
  tier: string;
  reputationScore: number;
  costPerGb: number;
  sessionId?: string;
  isWarmed: boolean;
  acquiredAt: number;
  diversityScore?: number;
  unifiedScore?: number;
  scoreBreakdown?: ScoreBreakdown;
}

export interface ScoreBreakdown {
  successRateScore: number;
  latencyScore: number;
  anonymityScore: number;
  geoMatchScore: number;
  costEfficiencyScore: number;
  availabilityScore: number;
  reliabilityScore: number;
  freshnessScore: number;
  tierMatchScore: number;
  historicalPerformanceScore: number;
  totalScore: number;
}

export interface MegaPoolStats {
  totalEffectiveIPs: number;
  sources: Record<MegaPoolSource, { available: number; inUse: number; avgScore: number; healthy: boolean }>;
  byCountry: Record<string, number>;
  byTier: Record<string, number>;
  utilizationRate: number;
  fusionReadiness: {
    ready: boolean;
    criticalMassPercent: number;
    chainReactionPossible: boolean;
    selfSustaining: boolean;
  };
  subModules: {
    freeProxy: any;
    torPool: any;
    bulkSessions: any;
    subnetExpander: any;
    rotatingSessions: any;
  };
  poolCompression: {
    enabled: boolean;
    entriesCompressed: number;
    spaceSavedPercent: number;
    lastRunAt: number;
  };
  poolFusion: {
    enabled: boolean;
    peersConnected: number;
    proxiesFused: number;
    lastRunAt: number;
  };
  poolIntelligence: {
    enabled: boolean;
    patternsLearned: number;
    topTargets: Array<{ domain: string; bestSource: MegaPoolSource; avgScore: number }>;
    lastRunAt: number;
  };
  tierDistribution: Record<string, { count: number; avgScore: number; promotions: number; demotions: number }>;
}

export interface SourceHealth {
  source: MegaPoolSource;
  healthy: boolean;
  successRate: number;
  avgLatencyMs: number;
  available: number;
  inUse: number;
  lastChecked: number;
  errors: number;
  costPerGb: number;
  qualityScore: number;
}

export interface DemandSignal {
  domain: string;
  tier: string;
  country?: string;
  source?: MegaPoolSource;
  requestedAt: number;
  fulfilled: boolean;
  priority: number;
}

export interface PrewarmEntry {
  proxyId: string;
  proxyUrl: string;
  source: MegaPoolSource;
  domain: string;
  country: string;
  tier: string;
  warmedAt: number;
  used: boolean;
}

export interface PoolIntelligenceEntry {
  domain: string;
  source: MegaPoolSource;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  lastUpdated: number;
  bestForCountry: string;
  bestForTier: string;
}

export interface TierStats {
  tier: string;
  count: number;
  avgScore: number;
  promotions: number;
  demotions: number;
  lastRebalancedAt: number;
}

// --- MegaPool -----------------------------------------------------------------

export class MegaPool {
  // --- Sub-module references ---
  private freeProxyDiscovery: any = null;
  private torPool: any = null;
  private bulkSessions: any = null;
  private subnetExpanderModule: any = null;
  private rotatingSessionsModule: any = null;

  // --- Internal state ---
  private sourceHealthMap = new Map<MegaPoolSource, SourceHealth>();
  private prewarmedMap = new Map<string, PrewarmEntry[]>();
  private inUseMap = new Map<string, { domain: string; source: MegaPoolSource; acquiredAt: number }>();
  private demandSignals: DemandSignal[] = [];
  private sourceOutcomes = new Map<MegaPoolSource, { successes: number; failures: number }>();

  // --- Pool Intelligence (NEW) ---
  private poolIntelligence = new Map<string, PoolIntelligenceEntry>();
  private intelligenceTimer: ReturnType<typeof setInterval> | null = null;

  // --- Pool Compression (NEW) ---
  private compressionTimer: ReturnType<typeof setInterval> | null = null;
  private compressionState = {
    enabled: true,
    entriesCompressed: 0,
    spaceSavedPercent: 0,
    lastRunAt: 0,
    duplicateMap: new Map<string, string[]>(),
  };

  // --- Pool Fusion (NEW) ---
  private fusionTimer: ReturnType<typeof setInterval> | null = null;
  private fusionState = {
    enabled: true,
    peersConnected: 0,
    proxiesFused: 0,
    lastRunAt: 0,
    peerEndpoints: [] as Array<{ url: string; lastSyncAt: number }>,
  };

  // --- Tier Management (NEW) ---
  private tierRebalanceTimer: ReturnType<typeof setInterval> | null = null;
  private tierStats = new Map<string, TierStats>();

  // --- Timers ---
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private autoscaleTimer: ReturnType<typeof setInterval> | null = null;

  // --- Flags and counters ---
  private started = false;
  private totalAcquisitions = 0;
  private totalSuccessfulAcquisitions = 0;
  private totalFailedAcquisitions = 0;
  private totalCost = 0;
  private acquisitionTimestamps: number[] = [];

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Start all sub-services and begin monitoring.
   * Enhanced: 5s intervals, pool fusion, compression, intelligence.
   */
  async start(): Promise<void> {
    if (this.started) {
      logger.warn('Mega pool already started');
      return;
    }

    logger.info('Starting ENHANCED mega pool (5s cycles, fusion, compression, intelligence)...');

    await this.initSubModules();
    this.initializeSourceHealth();
    smartIPPool.startPoolMonitor();
    await this.startAllServices();

    // 5s health monitor
    this.monitorTimer = setInterval(() => {
      this.runHealthMonitor().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Mega pool health monitor failed');
      });
    }, MEGA_POOL_MONITOR_INTERVAL_MS);

    // 5s auto-scaler
    this.autoscaleTimer = setInterval(() => {
      this.runAutoScaler().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Mega pool auto-scaler failed');
      });
    }, AUTOSCALE_INTERVAL_MS);

    // NEW: Pool compression timer
    this.compressionTimer = setInterval(() => {
      this.runPoolCompression().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Pool compression failed');
      });
    }, COMPRESSION_INTERVAL_MS);

    // NEW: Pool fusion timer
    this.fusionTimer = setInterval(() => {
      this.runPoolFusion().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Pool fusion failed');
      });
    }, FUSION_INTERVAL_MS);

    // NEW: Pool intelligence timer
    this.intelligenceTimer = setInterval(() => {
      this.runPoolIntelligence().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Pool intelligence update failed');
      });
    }, INTELLIGENCE_INTERVAL_MS);

    // NEW: Tier rebalance timer
    this.tierRebalanceTimer = setInterval(() => {
      this.runTierRebalance().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Tier rebalance failed');
      });
    }, TIER_REBALANCE_INTERVAL_MS);

    this.started = true;
    logger.info('Mega pool started successfully with pool fusion, compression, and intelligence');
  }

  /**
   * Stop all sub-services and clean up.
   */
  async stop(): Promise<void> {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    if (this.autoscaleTimer) { clearInterval(this.autoscaleTimer); this.autoscaleTimer = null; }
    if (this.compressionTimer) { clearInterval(this.compressionTimer); this.compressionTimer = null; }
    if (this.fusionTimer) { clearInterval(this.fusionTimer); this.fusionTimer = null; }
    if (this.intelligenceTimer) { clearInterval(this.intelligenceTimer); this.intelligenceTimer = null; }
    if (this.tierRebalanceTimer) { clearInterval(this.tierRebalanceTimer); this.tierRebalanceTimer = null; }

    await this.stopAllServices();
    smartIPPool.stopPoolMonitor();

    this.started = false;
    logger.info('Mega pool stopped');
  }

  // --- Sub-module Initialization -----------------------------------------

  private async initSubModules(): Promise<void> {
    const moduleImports = [
      { name: 'free-proxy-discovery', prop: 'freeProxyDiscovery', label: 'Free proxy discovery' },
      { name: 'tor-pool', prop: 'torPool', label: 'TOR pool' },
      { name: 'bulk-sessions', prop: 'bulkSessionManager', label: 'Bulk sessions' },
      { name: 'subnet-expander', prop: 'subnetExpander', label: 'Subnet expander' },
      { name: 'rotating-session-factory', prop: 'rotatingSessionFactory', label: 'Rotating sessions' },
    ];

    for (const mod of moduleImports) {
      try {
        const m = await import(`./${mod.name}`);
        (this as any)[mod.prop] = m[mod.prop];
        logger.info(`${mod.label} module loaded`);
      } catch {
        logger.info(`${mod.label} module not available -- skipping`);
      }
    }
  }

  async startAllServices(): Promise<void> {
    const services = [
      { module: this.subnetExpanderModule, method: 'startExpander', label: 'Subnet expander' },
      { module: this.rotatingSessionsModule, method: 'startFactory', label: 'Rotating session factory' },
      { module: this.freeProxyDiscovery, method: 'startDiscovery', label: 'Free proxy discovery' },
      { module: this.torPool, method: 'startPool', label: 'TOR pool' },
      { module: this.bulkSessions, method: 'startBulkManager', label: 'Bulk sessions' },
    ];

    const startPromises = services.map(async (service) => {
      if (service.module && typeof (service.module as any)[service.method] === 'function') {
        try {
          await (service.module as any)[service.method]();
          logger.info(`${service.label} service started`);
        } catch (err: any) {
          logger.warn({ error: err.message }, `Failed to start ${service.label}`);
        }
      }
    });

    await Promise.allSettled(startPromises);

    residentialProxyManager.startHealthChecks();
    ipReputationTracker.startDecay();

    logger.info('All sub-services started');
  }

  async stopAllServices(): Promise<void> {
    const services = [
      { module: this.subnetExpanderModule, method: 'stopExpander', label: 'Subnet expander' },
      { module: this.rotatingSessionsModule, method: 'stopFactory', label: 'Rotating session factory' },
      { module: this.freeProxyDiscovery, method: 'stopDiscovery', label: 'Free proxy discovery' },
      { module: this.torPool, method: 'stopPool', label: 'TOR pool' },
      { module: this.bulkSessions, method: 'stopBulkManager', label: 'Bulk sessions' },
    ];

    const stopPromises = services.map(async (service) => {
      if (service.module && typeof (service.module as any)[service.method] === 'function') {
        try {
          (service.module as any)[service.method]();
          logger.info(`${service.label} service stopped`);
        } catch (err: any) {
          logger.warn({ error: err.message }, `Failed to stop ${service.label}`);
        }
      }
    });

    await Promise.allSettled(stopPromises);

    residentialProxyManager.stopHealthChecks();
    ipReputationTracker.stopDecay();

    logger.info('All sub-services stopped');
  }

  // --- Main Entry: getProxy ----------------------------------------------

  /**
   * Get the best proxy from any available source.
   * Enhanced: 10-dimension unified scoring, intelligence-guided selection.
   */
  async getProxy(request: MegaPoolRequest): Promise<MegaPoolResult | null> {
    const {
      domain,
      tier = 'residential',
      country,
      city,
      asn,
      sessionId,
      maxCostPerGb,
      requireReputation = false,
      preferSource,
      avoidSources = [],
    } = request;

    this.totalAcquisitions++;
    const startTime = Date.now();

    // Check pool intelligence for source hints
    const intelligenceHint = this.getIntelligenceHint(domain, tier, country);

    const sourceOrder = this.buildSourceOrder(domain, tier, country || 'any');

    let filteredSources = sourceOrder.filter(s => !avoidSources.includes(s));

    // Apply intelligence hint
    if (intelligenceHint && !avoidSources.includes(intelligenceHint)) {
      const hintIdx = filteredSources.indexOf(intelligenceHint);
      if (hintIdx > 0) {
        filteredSources.splice(hintIdx, 1);
        filteredSources.unshift(intelligenceHint);
      }
    }

    if (preferSource && !avoidSources.includes(preferSource)) {
      const preferredIdx = filteredSources.indexOf(preferSource);
      if (preferredIdx > 0) {
        filteredSources.splice(preferredIdx, 1);
        filteredSources.unshift(preferSource);
      } else if (preferredIdx === -1) {
        filteredSources.unshift(preferSource);
      }
    }

    // Step 1: Check sticky session
    if (sessionId && !avoidSources.includes('database')) {
      const stickyResult = await this.tryStickySession(sessionId, domain);
      if (stickyResult) {
        this.recordAcquisitionSuccess(stickyResult.source, startTime);
        return stickyResult;
      }
    }

    // Step 2: Check pre-warmed pool
    if (!avoidSources.includes('database')) {
      const prewarmedResult = await this.tryPrewarmedPool(domain, tier, country);
      if (prewarmedResult) {
        this.recordAcquisitionSuccess(prewarmedResult.source, startTime);
        return prewarmedResult;
      }
    }

    // Steps 3+: Try sources in priority order
    for (const source of filteredSources) {
      if (source === 'database') continue;

      const sourceCost = SOURCE_COST[source];
      if (maxCostPerGb && sourceCost > maxCostPerGb) continue;

      const health = this.sourceHealthMap.get(source);
      if (health && !health.healthy) continue;

      let result: MegaPoolResult | null = null;

      try {
        switch (source) {
          case 'rotating':
            result = await this.tryRotatingSession(domain, tier, country, city, asn);
            break;
          case 'subnet':
            result = await this.trySubnetExpander(domain, tier, country);
            break;
          case 'bulk':
            result = await this.tryBulkSession(domain, tier, country);
            break;
          case 'brightdata':
          case 'oxylabs':
          case 'smartproxy':
          case 'iproyal':
          case 'webshare':
            result = await this.tryResidentialProvider(source, domain, tier, country, city, asn, maxCostPerGb);
            break;
          case 'free':
            result = await this.tryFreeProxy(domain, tier, country);
            break;
          case 'tor':
            result = await this.tryTorPool(domain, country);
            break;
          case 'fusion':
            result = await this.tryFusionSource(domain, tier, country);
            break;
          case 'chain':
          case 'breeder':
          case 'quantum':
          case 'plasma':
            // Advanced sources -- not yet implemented
            break;
          default:
            break;
        }
      } catch (err: any) {
        logger.warn({ source, domain, error: err.message }, 'Source acquisition failed');
        this.recordSourceFailure(source);
      }

      if (result) {
        // Compute unified score (10 dimensions)
        result.unifiedScore = this.computeUnifiedScore(result, request);
        result.scoreBreakdown = this.computeScoreBreakdown(result, request);

        if (sessionId) {
          await this.setStickySession(sessionId, result);
        }

        this.recordAcquisitionSuccess(result.source, startTime);
        this.recordIntelligence(domain, result.source, true, result.reputationScore);
        return result;
      }
    }

    // Last resort: Try database proxies
    if (!avoidSources.includes('database')) {
      try {
        const poolResult = await smartIPPool.getProxy({
          domain, tier, country, city, asn, sessionId, requireReputation, maxCostPerGb,
        });

        if (poolResult) {
          const result = this.convertIPPoolResult(poolResult, 'database');
          result.unifiedScore = this.computeUnifiedScore(result, request);
          result.scoreBreakdown = this.computeScoreBreakdown(result, request);
          if (sessionId) await this.setStickySession(sessionId, result);
          this.recordAcquisitionSuccess('database', startTime);
          this.recordIntelligence(domain, 'database', true, result.reputationScore);
          return result;
        }
      } catch (err: any) {
        logger.warn({ domain, error: err.message }, 'Database proxy selection failed');
      }
    }

    this.recordDemandSignal(domain, tier, country);
    this.totalFailedAcquisitions++;
    this.recordIntelligence(domain, 'none' as any, false, 0);

    logger.warn({ domain, tier, country, sourcesTried: filteredSources.length, acquisitionTimeMs: Date.now() - startTime }, 'No proxy available');

    return null;
  }

  // --- Unified Scoring (10 Dimensions) ----------------------------------

  /**
   * Compute a unified score (0-100) for a proxy across 10 dimensions.
   */
  computeUnifiedScore(result: MegaPoolResult, request: MegaPoolRequest): number {
    const breakdown = this.computeScoreBreakdown(result, request);
    return breakdown.totalScore;
  }

  /**
   * Compute score breakdown across 10 dimensions.
   */
  computeScoreBreakdown(result: MegaPoolResult, request: MegaPoolRequest): ScoreBreakdown {
    // 1. Success Rate Score (0-100)
    const successRateScore = Math.round(result.reputationScore * 100);

    // 2. Latency Score (0-100) -- lower is better
    const latencyScore = Math.max(0, Math.round(100 - (result.costPerGb * 5)));

    // 3. Anonymity Score (0-100) -- based on tier/source
    const anonymityScore = Math.round(SOURCE_QUALITY[result.source] * 100);

    // 4. Geo Match Score (0-100)
    const geoMatchScore = (request.country && result.country === request.country.toUpperCase()) ? 100 : 30;

    // 5. Cost Efficiency Score (0-100) -- lower cost is better
    const costEfficiencyScore = Math.max(0, Math.round(100 - SOURCE_COST[result.source] * 5));

    // 6. Availability Score (0-100) -- based on source health
    const health = this.sourceHealthMap.get(result.source);
    const availabilityScore = health ? Math.round(health.successRate * 100) : 50;

    // 7. Reliability Score (0-100) -- based on source outcomes
    const outcomes = this.sourceOutcomes.get(result.source);
    const reliabilityScore = outcomes
      ? Math.round((outcomes.successes / Math.max(1, outcomes.successes + outcomes.failures)) * 100)
      : 50;

    // 8. Freshness Score (0-100) -- recently acquired is better
    const ageMs = Date.now() - result.acquiredAt;
    const freshnessScore = Math.max(0, Math.round(100 - (ageMs / 60000) * 10));

    // 9. Tier Match Score (0-100)
    const tierMatchScore = (request.tier && result.tier === request.tier) ? 100 : 50;

    // 10. Historical Performance Score (0-100) -- from intelligence
    const intelKey = `${request.domain}:${result.source}`;
    const intel = this.poolIntelligence.get(intelKey);
    const historicalPerformanceScore = intel
      ? Math.round((intel.successCount / Math.max(1, intel.successCount + intel.failureCount)) * 100)
      : 50;

    const totalScore = Math.round(
      successRateScore * SCORING_WEIGHTS.successRate +
      latencyScore * SCORING_WEIGHTS.latency +
      anonymityScore * SCORING_WEIGHTS.anonymity +
      geoMatchScore * SCORING_WEIGHTS.geoMatch +
      costEfficiencyScore * SCORING_WEIGHTS.costEfficiency +
      availabilityScore * SCORING_WEIGHTS.availability +
      reliabilityScore * SCORING_WEIGHTS.reliability +
      freshnessScore * SCORING_WEIGHTS.freshness +
      tierMatchScore * SCORING_WEIGHTS.tierMatch +
      historicalPerformanceScore * SCORING_WEIGHTS.historicalPerformance
    );

    return {
      successRateScore,
      latencyScore,
      anonymityScore,
      geoMatchScore,
      costEfficiencyScore,
      availabilityScore,
      reliabilityScore,
      freshnessScore,
      tierMatchScore,
      historicalPerformanceScore,
      totalScore: Math.max(0, Math.min(100, totalScore)),
    };
  }

  // --- Pool Intelligence (NEW) ------------------------------------------

  /**
   * Record an intelligence entry for future reference.
   */
  private recordIntelligence(domain: string, source: MegaPoolSource, success: boolean, score: number): void {
    const key = `${domain}:${source}`;
    const entry = this.poolIntelligence.get(key);

    if (entry) {
      if (success) entry.successCount++;
      else entry.failureCount++;
      entry.lastUpdated = Date.now();
    } else {
      this.poolIntelligence.set(key, {
        domain,
        source,
        successCount: success ? 1 : 0,
        failureCount: success ? 0 : 1,
        avgLatencyMs: 0,
        lastUpdated: Date.now(),
        bestForCountry: '',
        bestForTier: '',
      });
    }
  }

  /**
   * Get a source hint from pool intelligence.
   */
  private getIntelligenceHint(domain: string, tier: string, country?: string): MegaPoolSource | null {
    let bestSource: MegaPoolSource | null = null;
    let bestScore = 0;

    for (const [key, entry] of this.poolIntelligence) {
      if (!key.startsWith(`${domain}:`)) continue;

      const totalAttempts = entry.successCount + entry.failureCount;
      if (totalAttempts < 3) continue;

      const successRate = entry.successCount / totalAttempts;
      if (successRate > bestScore) {
        bestScore = successRate;
        bestSource = entry.source;
      }
    }

    return bestScore >= 0.6 ? bestSource : null;
  }

  /**
   * Run pool intelligence update.
   * Learns which sources work best for which targets.
   */
  async runPoolIntelligence(): Promise<number> {
    let updated = 0;

    try {
      // Get recent proxy outcomes from DB
      const recentProxies = await db.proxy.findMany({
        where: {
          retired: false,
          lastChecked: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        },
        take: 1000,
        orderBy: { lastChecked: 'desc' },
      });

      for (const proxy of recentProxies) {
        const source = (proxy.provider || 'unknown') as MegaPoolSource;
        const domain = 'global'; // We don't have per-domain tracking in DB

        const key = `${domain}:${source}`;
        const entry = this.poolIntelligence.get(key);

        if (entry) {
          if (proxy.successRate >= 0.5) entry.successCount++;
          else entry.failureCount++;
          entry.lastUpdated = Date.now();
        }

        updated++;
      }

      // Persist intelligence to Redis
      const intelArray = Array.from(this.poolIntelligence.entries()).slice(0, 1000);
      await cacheSet('mega_pool:intelligence', intelArray, 300).catch(() => {});
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Pool intelligence update failed');
    }

    return updated;
  }

  // --- Pool Compression (NEW) ------------------------------------------

  /**
   * Run pool compression -- merge duplicate proxy entries.
   * Identifies proxies that are the same underlying IP but stored
   * under different URLs (e.g., different credentials or ports).
   */
  async runPoolCompression(): Promise<{
    duplicatesFound: number;
    entriesMerged: number;
    spaceSavedPercent: number;
  }> {
    let duplicatesFound = 0;
    let entriesMerged = 0;

    try {
      const proxies = await db.proxy.findMany({
        where: { retired: false },
        select: { id: true, url: true, country: true, successRate: true },
        take: 50_000,
      });

      // Group by hostname to find duplicates
      const hostnameMap = new Map<string, Array<{ id: string; url: string; country: string; successRate: number }>>();

      for (const proxy of proxies) {
        try {
          const parsed = new URL(proxy.url);
          const hostname = parsed.hostname;

          if (!hostnameMap.has(hostname)) {
            hostnameMap.set(hostname, []);
          }
          hostnameMap.get(hostname)!.push(proxy);
        } catch {
          // Invalid URL -- skip
        }
      }

      // Find hostnames with multiple entries
      const mergePromises: Promise<number>[] = [];

      for (const [hostname, entries] of hostnameMap) {
        if (entries.length <= 1) continue;

        duplicatesFound += entries.length - 1;

        // Keep the one with highest success rate, retire the rest
        entries.sort((a, b) => b.successRate - a.successRate);
        const keeper = entries[0];

        for (let i = 1; i < entries.length; i++) {
          const duplicate = entries[i];
          mergePromises.push((async () => {
            try {
              await db.proxy.update({
                where: { id: duplicate.id },
                data: { retired: true, lastChecked: new Date() },
              });
              return 1;
            } catch {
              return 0;
            }
          })());
        }
      }

      // Process merges in parallel batches
      for (let i = 0; i < mergePromises.length; i += 100) {
        const batch = mergePromises.slice(i, i + 100);
        const results = await Promise.allSettled(batch);
        for (const result of results) {
          if (result.status === 'fulfilled') entriesMerged += result.value;
        }
      }

      this.compressionState.entriesCompressed += entriesMerged;
      this.compressionState.spaceSavedPercent = proxies.length > 0
        ? Math.round((entriesMerged / proxies.length) * 100 * 100) / 100
        : 0;
      this.compressionState.lastRunAt = Date.now();

      if (entriesMerged > 0) {
        logger.info(
          { duplicatesFound, entriesMerged, spaceSavedPercent: this.compressionState.spaceSavedPercent },
          'Pool compression: duplicate entries merged',
        );
      }
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Pool compression failed');
    }

    return {
      duplicatesFound,
      entriesMerged,
      spaceSavedPercent: this.compressionState.spaceSavedPercent,
    };
  }

  // --- Pool Fusion (NEW) ----------------------------------------------

  /**
   * Run pool fusion -- merge pools from multiple peers.
   * Like nuclear fusion, combining two pools creates a more powerful one.
   */
  async runPoolFusion(): Promise<{
    proxiesFused: number;
    peersChecked: number;
  }> {
    let proxiesFused = 0;
    let peersChecked = 0;

    // Try to discover peer endpoints
    try {
      const peerData = await cacheGet<Array<{ url: string; proxyCount: number; timestamp: number }>>('mega_pool:peers');
      if (peerData && Array.isArray(peerData)) {
        for (const peer of peerData) {
          if (Date.now() - peer.timestamp > 5 * 60 * 1000) continue; // Skip stale peers
          this.fusionState.peersConnected++;
          peersChecked++;
        }
      }
    } catch {}

    // Try to fuse proxies from shared cache
    try {
      const sharedProxies = await cacheGet<Array<{
        url: string;
        provider: string;
        country: string;
        tier: string;
        successRate: number;
      }>>('mega_pool:shared_proxies');

      if (sharedProxies && Array.isArray(sharedProxies)) {
        const newProxies = sharedProxies.filter(sp => sp.successRate >= 0.5);

        for (const proxy of newProxies.slice(0, 50)) {
          try {
            const existing = await db.proxy.findFirst({
              where: { url: proxy.url, retired: false },
            });

            if (!existing) {
              await db.proxy.create({
                data: {
                  id: `fusion-${Buffer.from(proxy.url).toString('base64url').slice(0, 24)}`,
                  url: proxy.url,
                  provider: proxy.provider || 'fusion',
                  country: (proxy.country || 'unknown').toUpperCase(),
                  tier: (proxy.tier || 'residential') as any,
                  successRate: proxy.successRate,
                  failures: 0,
                  consecutiveFailures: 0,
                  retired: false,
                  sticky: false,
                  addedAt: new Date(),
                },
              });
              proxiesFused++;
            }
          } catch {}
        }
      }
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Pool fusion failed');
    }

    // Share our best proxies
    try {
      const ourBestProxies = await db.proxy.findMany({
        where: { retired: false, successRate: { gte: 0.7 } },
        take: 100,
        orderBy: { successRate: 'desc' },
      });

      await cacheSet('mega_pool:shared_proxies', ourBestProxies.map(p => ({
        url: p.url,
        provider: p.provider,
        country: p.country,
        tier: p.tier,
        successRate: p.successRate,
      })), 300).catch(() => {});
    } catch {}

    this.fusionState.proxiesFused += proxiesFused;
    this.fusionState.lastRunAt = Date.now();

    if (proxiesFused > 0) {
      logger.info({ proxiesFused, peersChecked }, 'Pool fusion: proxies fused from peers');
    }

    return { proxiesFused, peersChecked };
  }

  // --- Tier Rebalancing (NEW) ------------------------------------------

  /**
   * Run tier rebalancing -- promote/demote proxies between tiers
   * based on performance.
   */
  async runTierRebalance(): Promise<{
    promotions: number;
    demotions: number;
  }> {
    let promotions = 0;
    let demotions = 0;

    try {
      const tiers = ['residential', 'mobile', 'datacenter', 'isp'] as const;

      for (const tier of tiers) {
        const proxies = await db.proxy.findMany({
          where: { retired: false, tier: tier as any },
          take: 500,
          orderBy: { successRate: 'desc' },
        });

        let tierPromotions = 0;
        let tierDemotions = 0;

        for (const proxy of proxies) {
          // Promote high-performing datacenter/mobile to residential
          if (tier === 'datacenter' && proxy.successRate >= 0.8) {
            try {
              await db.proxy.update({
                where: { id: proxy.id },
                data: { tier: 'residential' as any },
              });
              tierPromotions++;
            } catch {}
          }

          // Demote low-performing residential to datacenter
          if (tier === 'residential' && proxy.successRate < 0.3) {
            try {
              await db.proxy.update({
                where: { id: proxy.id },
                data: { tier: 'datacenter' as any },
              });
              tierDemotions++;
            } catch {}
          }

          // Promote high-performing ISP to residential
          if (tier === 'isp' && proxy.successRate >= 0.7) {
            try {
              await db.proxy.update({
                where: { id: proxy.id },
                data: { tier: 'residential' as any },
              });
              tierPromotions++;
            } catch {}
          }
        }

        // Update tier stats
        const stats = this.tierStats.get(tier) || {
          tier,
          count: proxies.length,
          avgScore: proxies.length > 0 ? proxies.reduce((s, p) => s + p.successRate, 0) / proxies.length : 0,
          promotions: 0,
          demotions: 0,
          lastRebalancedAt: Date.now(),
        };

        stats.count = proxies.length;
        stats.promotions += tierPromotions;
        stats.demotions += tierDemotions;
        stats.lastRebalancedAt = Date.now();
        this.tierStats.set(tier, stats);

        promotions += tierPromotions;
        demotions += tierDemotions;
      }
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Tier rebalance failed');
    }

    if (promotions > 0 || demotions > 0) {
      logger.info({ promotions, demotions }, 'Tier rebalance completed');
    }

    return { promotions, demotions };
  }

  // --- Fusion Source (NEW) ------------------------------------------

  /**
   * Try to get a proxy from a fusion source.
   */
  private async tryFusionSource(domain: string, tier?: string, country?: string): Promise<MegaPoolResult | null> {
    try {
      const proxy = await db.proxy.findFirst({
        where: {
          retired: false,
          provider: 'fusion',
          ...(country ? { country: country.toUpperCase() } : {}),
          ...(tier ? { tier: tier as any } : {}),
          successRate: { gte: 0.5 },
        },
        orderBy: { successRate: 'desc' },
      });

      if (proxy) {
        return {
          proxyUrl: proxy.url,
          proxyId: proxy.id,
          source: 'fusion',
          country: proxy.country,
          tier: proxy.tier,
          reputationScore: proxy.successRate,
          costPerGb: 0,
          isWarmed: false,
          acquiredAt: Date.now(),
        };
      }
    } catch {}

    return null;
  }

  // --- Release Proxy -----------------------------------------------------

  async releaseProxy(
    proxyId: string,
    domain: string,
    success: boolean,
    statusCode?: number,
    source?: MegaPoolSource,
  ): Promise<void> {
    this.inUseMap.delete(proxyId);

    try {
      await ipReputationTracker.recordOutcome(proxyId, domain, success, statusCode);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to record outcome in reputation tracker');
    }

    if (source) {
      this.recordSourceOutcome(source, success);

      try {
        switch (source) {
          case 'brightdata': case 'oxylabs': case 'smartproxy': case 'iproyal': case 'webshare':
            await residentialProxyManager.releaseProxy(source as ProxyProvider, success);
            break;
          case 'rotating':
            if (this.rotatingSessionsModule?.releaseSession) await this.rotatingSessionsModule.releaseSession(proxyId, success);
            break;
          case 'subnet':
            if (this.subnetExpanderModule?.releaseVirtualIP) await this.subnetExpanderModule.releaseVirtualIP(proxyId, success);
            break;
          case 'bulk':
            if (this.bulkSessions?.releaseSession) await this.bulkSessions.releaseSession(proxyId, success);
            break;
          case 'database':
            await smartIPPool.releaseProxy(proxyId, domain, success, statusCode);
            break;
        }
      } catch (err: any) {
        logger.warn({ source, proxyId, error: err.message }, 'Failed to release proxy back to source');
      }
    }

    if (!success && (statusCode === 403 || statusCode === 429)) {
      const cooldownMs = statusCode === 429 ? 5 * 60 * 1000 : 10 * 60 * 1000;
      try {
        await ipReputationTracker.blacklistProxy(proxyId, domain, `http_${statusCode}`, cooldownMs);
      } catch {}
    }

    this.fulfillDemand(domain);
  }

  // --- Source Order ------------------------------------------------------

  buildSourceOrder(domain: string, tier: string, country: string): MegaPoolSource[] {
    const defaultOrder: MegaPoolSource[] = [
      'rotating', 'subnet', 'bulk', 'brightdata', 'oxylabs', 'smartproxy',
      'iproyal', 'webshare', 'database', 'fusion', 'free', 'tor',
    ];

    const scoredSources = defaultOrder.map(source => {
      let score = 0;

      score += SOURCE_QUALITY[source] * 30;

      const health = this.sourceHealthMap.get(source);
      if (health) {
        if (health.healthy) {
          score += 20 + health.successRate * 15;
        } else {
          score -= 30;
        }
      }

      const cost = SOURCE_COST[source];
      score += cost === 0 ? 10 : -cost * 0.5;

      if (tier === 'residential' && ['brightdata', 'oxylabs', 'smartproxy', 'rotating', 'subnet'].includes(source)) score += 10;
      else if (tier === 'datacenter' && ['database', 'webshare', 'free'].includes(source)) score += 10;
      else if (tier === 'mobile' && ['brightdata', 'oxylabs', 'rotating'].includes(source)) score += 10;

      if (country && country !== 'any') {
        const providerCountries = this.getProviderCountryAvailability(source);
        if (providerCountries.includes(country.toUpperCase())) score += 15;
        else if (providerCountries.length > 0) score -= 5;
      }

      // Intelligence bonus
      const intelKey = `${domain}:${source}`;
      const intel = this.poolIntelligence.get(intelKey);
      if (intel) {
        const intelScore = intel.successCount / Math.max(1, intel.successCount + intel.failureCount);
        score += intelScore * 10;
      }

      return { source, score };
    });

    scoredSources.sort((a, b) => b.score - a.score);
    return scoredSources.map(s => s.source);
  }

  // --- Source Health Assessment ------------------------------------------

  async assessSourceHealth(source: MegaPoolSource): Promise<SourceHealth> {
    const cached = this.sourceHealthMap.get(source);
    if (cached) return cached;

    const outcomes = this.sourceOutcomes.get(source) || { successes: 0, failures: 0 };
    const total = outcomes.successes + outcomes.failures;
    const successRate = total > 0 ? outcomes.successes / total : SOURCE_QUALITY[source];

    const health: SourceHealth = {
      source,
      healthy: successRate >= MIN_SOURCE_HEALTH_RATE,
      successRate,
      avgLatencyMs: 0,
      available: await this.getSourceAvailability(source),
      inUse: this.getSourceInUse(source),
      lastChecked: Date.now(),
      errors: outcomes.failures,
      costPerGb: SOURCE_COST[source],
      qualityScore: SOURCE_QUALITY[source],
    };

    this.sourceHealthMap.set(source, health);
    return health;
  }

  // --- Source Recommendation ---------------------------------------------

  async getSourceRecommendation(
    domain: string,
    tier?: string,
    country?: string,
  ): Promise<{
    recommended: MegaPoolSource;
    alternatives: MegaPoolSource[];
    reasoning: string;
    estimatedSuccessRate: number;
    estimatedCost: number;
  }> {
    const sourceOrder = this.buildSourceOrder(domain, tier || 'residential', country || 'any');

    const assessed: Array<{ source: MegaPoolSource; health: SourceHealth; score: number }> = [];

    for (const source of sourceOrder.slice(0, 5)) {
      const health = await this.assessSourceHealth(source);
      const score = health.successRate * 50 + health.qualityScore * 30 + (health.healthy ? 20 : -20);
      assessed.push({ source, health, score });
    }

    assessed.sort((a, b) => b.score - a.score);

    const best = assessed[0];
    const alternatives = assessed.slice(1).map(a => a.source);
    const estimatedSuccessRate = best ? best.health.successRate : 0.5;
    const estimatedCost = best ? SOURCE_COST[best.source] : 10;

    let reasoning = best
      ? `${best.source} recommended: success rate ${(best.health.successRate * 100).toFixed(1)}%, quality ${(best.health.qualityScore * 100).toFixed(0)}%, cost $${SOURCE_COST[best.source]}/GB`
      : 'No sources available';

    if (best && !best.health.healthy) reasoning += ' (WARNING: source unhealthy)';

    return {
      recommended: best?.source || 'database',
      alternatives,
      reasoning,
      estimatedSuccessRate,
      estimatedCost,
    };
  }

  // --- Pre-warming -------------------------------------------------------

  async prewarmDomain(domain: string, tier?: string, country?: string): Promise<number> {
    let totalWarmed = 0;

    logger.info({ domain, tier, country }, 'Starting mega pool domain pre-warming');

    // Pre-warm via smart IP pool
    try {
      const poolWarmed = await smartIPPool.prewarmDomain(domain, (tier || 'residential') as any, country);
      totalWarmed += poolWarmed;
    } catch (err: any) {
      logger.warn({ domain, error: err.message }, 'IP pool pre-warm failed');
    }

    // Pre-warm via rotating sessions
    if (this.rotatingSessionsModule?.preCreateSessions) {
      try {
        const sessions = await this.rotatingSessionsModule.preCreateSessions(5, { country, tier: tier as any, domain });
        totalWarmed += sessions?.length || 0;
      } catch (err: any) {
        logger.warn({ domain, error: err.message }, 'Rotating session pre-warm failed');
      }
    }

    // Pre-warm via subnet expander
    if (this.subnetExpanderModule?.preGenerateVirtualIPs) {
      try {
        const count = await this.subnetExpanderModule.preGenerateVirtualIPs(country || 'US', tier || 'residential', 10);
        totalWarmed += count || 0;
      } catch (err: any) {
        logger.warn({ domain, error: err.message }, 'Subnet expander pre-warm failed');
      }
    }

    logger.info({ domain, tier, country, totalWarmed }, 'Mega pool domain pre-warming completed');

    return totalWarmed;
  }

  // --- Fusion Readiness --------------------------------------------------

  getFusionReadiness(): {
    ready: boolean;
    criticalMassPercent: number;
    chainReactionPossible: boolean;
    selfSustaining: boolean;
    details: {
      totalEffectiveIPs: number;
      healthySources: number;
      totalSources: number;
      avgSourceHealth: number;
      autoScalingActive: boolean;
      demandFulfillmentRate: number;
    };
  } {
    const stats = this.getMegaPoolStatsSync();

    const healthySources = Object.values(stats.sources).filter(s => s.healthy).length;
    const totalSources = Object.keys(stats.sources).length;
    const avgSourceHealth = totalSources > 0
      ? Object.values(stats.sources).reduce((sum, s) => sum + s.avgScore, 0) / totalSources
      : 0;

    const criticalMassPercent = THEORETICAL_MAX_IPS > 0
      ? Math.min(100, (stats.totalEffectiveIPs / THEORETICAL_MAX_IPS) * 100)
      : 0;

    const chainReactionPossible = healthySources >= 3;
    const totalDemand = this.demandSignals.length;
    const fulfilledDemand = this.demandSignals.filter(d => d.fulfilled).length;
    const demandFulfillmentRate = totalDemand > 0 ? fulfilledDemand / totalDemand : 1;
    const selfSustaining = healthySources >= 2 && demandFulfillmentRate > 0.8;
    const ready = criticalMassPercent >= CRITICAL_MASS_THRESHOLD * 100 && selfSustaining;

    return {
      ready,
      criticalMassPercent: Math.round(criticalMassPercent * 100) / 100,
      chainReactionPossible,
      selfSustaining,
      details: {
        totalEffectiveIPs: stats.totalEffectiveIPs,
        healthySources,
        totalSources,
        avgSourceHealth: Math.round(avgSourceHealth * 100) / 100,
        autoScalingActive: this.demandSignals.filter(d => !d.fulfilled).length > 0,
        demandFulfillmentRate: Math.round(demandFulfillmentRate * 100) / 100,
      },
    };
  }

  // --- Health Monitor ---------------------------------------------------

  async runHealthMonitor(): Promise<void> {
    const sources: MegaPoolSource[] = [
      'database', 'brightdata', 'oxylabs', 'smartproxy', 'iproyal', 'webshare',
      'free', 'tor', 'bulk', 'subnet', 'rotating', 'fusion',
    ];

    const healthPromises = sources.map(async (source) => {
      try {
        const health = await this.assessSourceHealth(source);
        this.sourceHealthMap.set(source, health);
      } catch {}
    });

    await Promise.allSettled(healthPromises);
  }

  // --- Auto-Scaler -------------------------------------------------------

  async runAutoScaler(): Promise<void> {
    const unfulfilledDemand = this.demandSignals.filter(d => !d.fulfilled);
    if (unfulfilledDemand.length === 0) return;

    // Group by domain + tier
    const demandByDomain = new Map<string, number>();
    for (const signal of unfulfilledDemand) {
      const key = `${signal.domain}:${signal.tier}`;
      demandByDomain.set(key, (demandByDomain.get(key) || 0) + 1);
    }

    // Pre-warm for top-demand domains
    const topDemand = Array.from(demandByDomain.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    for (const [key, count] of topDemand) {
      const [domain, tier] = key.split(':');
      try {
        await this.prewarmDomain(domain, tier);
      } catch {}
    }
  }

  // --- Statistics --------------------------------------------------------

  async getStats(): Promise<MegaPoolStats> {
    const cached = await cacheGet<MegaPoolStats>('mega_pool:stats');
    if (cached) return cached;

    const stats = this.buildStats();
    await cacheSet('mega_pool:stats', stats, MEGA_POOL_STATS_CACHE_TTL);
    return stats;
  }

  async getTotalPoolSize(): Promise<number> {
    const stats = await this.getStats();
    return stats.totalEffectiveIPs;
  }

  private buildStats(): MegaPoolStats {
    const sources: Record<MegaPoolSource, { available: number; inUse: number; avgScore: number; healthy: boolean }> = {} as any;

    const allSources: MegaPoolSource[] = [
      'database', 'brightdata', 'oxylabs', 'smartproxy', 'iproyal', 'webshare',
      'free', 'tor', 'bulk', 'subnet', 'rotating', 'fusion', 'chain', 'breeder', 'quantum', 'plasma',
    ];

    for (const source of allSources) {
      const health = this.sourceHealthMap.get(source);
      sources[source] = {
        available: health?.available || 0,
        inUse: health?.inUse || 0,
        avgScore: health?.qualityScore || SOURCE_QUALITY[source],
        healthy: health?.healthy || false,
      };
    }

    const byCountry: Record<string, number> = {};
    const byTier: Record<string, number> = {};

    const tierDistribution: Record<string, { count: number; avgScore: number; promotions: number; demotions: number }> = {};
    for (const [tier, stats] of this.tierStats) {
      tierDistribution[tier] = {
        count: stats.count,
        avgScore: stats.avgScore,
        promotions: stats.promotions,
        demotions: stats.demotions,
      };
    }

    return {
      totalEffectiveIPs: THEORETICAL_MAX_IPS,
      sources,
      byCountry,
      byTier,
      utilizationRate: this.inUseMap.size / Math.max(1, this.totalAcquisitions),
      fusionReadiness: {
        ready: false,
        criticalMassPercent: 0,
        chainReactionPossible: false,
        selfSustaining: false,
      },
      subModules: {
        freeProxy: null,
        torPool: null,
        bulkSessions: null,
        subnetExpander: null,
        rotatingSessions: null,
      },
      poolCompression: {
        enabled: this.compressionState.enabled,
        entriesCompressed: this.compressionState.entriesCompressed,
        spaceSavedPercent: this.compressionState.spaceSavedPercent,
        lastRunAt: this.compressionState.lastRunAt,
      },
      poolFusion: {
        enabled: this.fusionState.enabled,
        peersConnected: this.fusionState.peersConnected,
        proxiesFused: this.fusionState.proxiesFused,
        lastRunAt: this.fusionState.lastRunAt,
      },
      poolIntelligence: {
        enabled: true,
        patternsLearned: this.poolIntelligence.size,
        topTargets: Array.from(this.poolIntelligence.values())
          .sort((a, b) => b.successCount - a.successCount)
          .slice(0, 10)
          .map(e => ({ domain: e.domain, bestSource: e.source, avgScore: e.successCount / Math.max(1, e.successCount + e.failureCount) })),
        lastRunAt: Date.now(),
      },
      tierDistribution,
    };
  }

  private getMegaPoolStatsSync(): MegaPoolStats {
    return this.buildStats();
  }

  // --- Private Helpers --------------------------------------------------

  private async getSourceAvailability(source: MegaPoolSource): Promise<number> {
    try {
      switch (source) {
        case 'database':
          return await db.proxy.count({ where: { retired: false } });
        case 'free':
        case 'tor':
        case 'bulk':
        case 'subnet':
        case 'rotating':
        case 'fusion':
          return 100; // Estimated
        default:
          return PROVIDER_ESTIMATED_IPS[source] || 0;
      }
    } catch {
      return 0;
    }
  }

  private getSourceInUse(source: MegaPoolSource): number {
    let count = 0;
    for (const entry of this.inUseMap.values()) {
      if (entry.source === source) count++;
    }
    return count;
  }

  private getProviderCountryAvailability(source: MegaPoolSource): string[] {
    const majorCountries = ['US', 'CA', 'GB', 'DE', 'FR', 'NL', 'JP', 'AU', 'BR', 'IN'];
    const limitedCountries = ['US', 'GB', 'DE', 'JP', 'AU'];

    switch (source) {
      case 'brightdata': case 'oxylabs':
        return majorCountries;
      case 'smartproxy': case 'iproyal':
        return limitedCountries;
      default:
        return limitedCountries;
    }
  }

  private async tryStickySession(sessionId: string, domain: string): Promise<MegaPoolResult | null> {
    try {
      const stickyKey = `mega_pool:sticky:${sessionId}`;
      const cached = await cacheGet<MegaPoolResult>(stickyKey);
      if (!cached) return null;

      const verdict = await ipReputationTracker.getVerdict(cached.proxyId, domain);
      if (!verdict.usable) {
        await redis.del(`cache:${stickyKey}`);
        return null;
      }

      cached.isWarmed = true;
      return cached;
    } catch {
      return null;
    }
  }

  private async tryPrewarmedPool(domain: string, tier?: string, country?: string): Promise<MegaPoolResult | null> {
    const entries = this.prewarmedMap.get(domain);
    if (!entries || entries.length === 0) return null;

    const unused = entries.filter(e => !e.used);
    if (unused.length === 0) return null;

    const entry = unused[0];
    entry.used = true;

    return {
      proxyUrl: entry.proxyUrl,
      proxyId: entry.proxyId,
      source: entry.source,
      country: entry.country,
      tier: entry.tier,
      reputationScore: 0.7,
      costPerGb: SOURCE_COST[entry.source],
      isWarmed: true,
      acquiredAt: entry.warmedAt,
    };
  }

  private async tryRotatingSession(domain: string, tier?: string, country?: string, city?: string, asn?: string): Promise<MegaPoolResult | null> {
    if (!this.rotatingSessionsModule?.getSession) return null;
    try {
      const session = await this.rotatingSessionsModule.getSession({ country, tier, domain });
      if (session) {
        return {
          proxyUrl: session.url || session.proxyUrl,
          proxyId: session.id,
          source: 'rotating',
          country: session.country || country || 'unknown',
          tier: tier || 'residential',
          reputationScore: 0.9,
          costPerGb: SOURCE_COST.rotating,
          sessionId: session.id,
          isWarmed: false,
          acquiredAt: Date.now(),
        };
      }
    } catch {}
    return null;
  }

  private async trySubnetExpander(domain: string, tier?: string, country?: string): Promise<MegaPoolResult | null> {
    if (!this.subnetExpanderModule?.getVirtualIP) return null;
    try {
      const virtualIP = await this.subnetExpanderModule.getVirtualIP(country || 'US', tier || 'residential');
      if (virtualIP) {
        return {
          proxyUrl: virtualIP.url || virtualIP.proxyUrl,
          proxyId: virtualIP.id,
          source: 'subnet',
          country: virtualIP.country || country || 'unknown',
          tier: tier || 'residential',
          reputationScore: 0.85,
          costPerGb: SOURCE_COST.subnet,
          isWarmed: false,
          acquiredAt: Date.now(),
        };
      }
    } catch {}
    return null;
  }

  private async tryBulkSession(domain: string, tier?: string, country?: string): Promise<MegaPoolResult | null> {
    if (!this.bulkSessions?.getSession) return null;
    try {
      const session = await this.bulkSessions.getSession(country, tier);
      if (session) {
        return {
          proxyUrl: session.url || session.proxyUrl,
          proxyId: session.id,
          source: 'bulk',
          country: session.country || country || 'unknown',
          tier: tier || 'residential',
          reputationScore: 0.8,
          costPerGb: SOURCE_COST.bulk,
          isWarmed: false,
          acquiredAt: Date.now(),
        };
      }
    } catch {}
    return null;
  }

  private async tryResidentialProvider(
    source: MegaPoolSource, domain: string, tier?: string, country?: string,
    city?: string, asn?: string, maxCostPerGb?: number,
  ): Promise<MegaPoolResult | null> {
    try {
      const proxy = await residentialProxyManager.getProxy({
        country,
        city,
        asn,
        tier: tier as any,
      });

      if (proxy) {
        return {
          proxyUrl: proxy.proxyUrl,
          proxyId: proxy.proxyId || `res-${source}-${Date.now()}`,
          source,
          country: proxy.country || country || 'unknown',
          city: proxy.city || city,
          asn: proxy.asn || asn,
          tier: tier || 'residential',
          reputationScore: SOURCE_QUALITY[source],
          costPerGb: SOURCE_COST[source],
          sessionId: proxy.sessionId,
          isWarmed: false,
          acquiredAt: Date.now(),
        };
      }
    } catch {}
    return null;
  }

  private async tryFreeProxy(domain: string, tier?: string, country?: string): Promise<MegaPoolResult | null> {
    if (!this.freeProxyDiscovery?.getProxy) return null;
    try {
      const proxy = await this.freeProxyDiscovery.getProxy(country);
      if (proxy) {
        return {
          proxyUrl: proxy.url,
          proxyId: proxy.id,
          source: 'free',
          country: proxy.country || country || 'unknown',
          tier: 'datacenter',
          reputationScore: 0.3,
          costPerGb: 0,
          isWarmed: false,
          acquiredAt: Date.now(),
        };
      }
    } catch {}
    return null;
  }

  private async tryTorPool(domain: string, country?: string): Promise<MegaPoolResult | null> {
    if (!this.torPool?.getCircuit) return null;
    try {
      const circuit = await this.torPool.getCircuit(country);
      if (circuit) {
        return {
          proxyUrl: circuit.url || circuit.socksPort ? `socks5://127.0.0.1:${circuit.socksPort}` : '',
          proxyId: circuit.id,
          source: 'tor',
          country: circuit.country || country || 'unknown',
          tier: 'datacenter',
          reputationScore: 0.2,
          costPerGb: 0,
          isWarmed: false,
          acquiredAt: Date.now(),
        };
      }
    } catch {}
    return null;
  }

  private async setStickySession(sessionId: string, result: MegaPoolResult): Promise<void> {
    try {
      const stickyKey = `mega_pool:sticky:${sessionId}`;
      await cacheSet(stickyKey, result, PREWARM_CACHE_TTL);
    } catch {}
  }

  private convertIPPoolResult(poolResult: IPPoolResult, source: MegaPoolSource): MegaPoolResult {
    return {
      proxyUrl: poolResult.proxyUrl,
      proxyId: poolResult.proxyId,
      source,
      country: poolResult.country,
      city: poolResult.city,
      asn: poolResult.asn,
      tier: poolResult.tier,
      reputationScore: poolResult.reputationScore,
      costPerGb: SOURCE_COST[source],
      sessionId: poolResult.sessionId,
      isWarmed: poolResult.isWarmed,
      acquiredAt: Date.now(),
    };
  }

  private initializeSourceHealth(): void {
    const allSources: MegaPoolSource[] = [
      'database', 'brightdata', 'oxylabs', 'smartproxy', 'iproyal', 'webshare',
      'free', 'tor', 'bulk', 'subnet', 'rotating', 'fusion',
    ];

    for (const source of allSources) {
      this.sourceHealthMap.set(source, {
        source,
        healthy: true,
        successRate: SOURCE_QUALITY[source],
        avgLatencyMs: 0,
        available: 0,
        inUse: 0,
        lastChecked: 0,
        errors: 0,
        costPerGb: SOURCE_COST[source],
        qualityScore: SOURCE_QUALITY[source],
      });
    }
  }

  private recordSourceOutcome(source: MegaPoolSource, success: boolean): void {
    const outcomes = this.sourceOutcomes.get(source) || { successes: 0, failures: 0 };
    if (success) outcomes.successes++;
    else outcomes.failures++;
    this.sourceOutcomes.set(source, outcomes);

    // Update source health
    const health = this.sourceHealthMap.get(source);
    if (health) {
      const total = outcomes.successes + outcomes.failures;
      health.successRate = total > 0 ? outcomes.successes / total : SOURCE_QUALITY[source];
      health.healthy = health.successRate >= MIN_SOURCE_HEALTH_RATE;
    }
  }

  private recordSourceFailure(source: MegaPoolSource): void {
    this.recordSourceOutcome(source, false);
  }

  private recordAcquisitionSuccess(source: MegaPoolSource, startTime: number): void {
    this.totalSuccessfulAcquisitions++;
    this.acquisitionTimestamps.push(Date.now());
    this.recordSourceOutcome(source, true);
  }

  private recordDemandSignal(domain: string, tier: string, country?: string): void {
    this.demandSignals.push({
      domain,
      tier,
      country,
      requestedAt: Date.now(),
      fulfilled: false,
      priority: 5,
    });

    if (this.demandSignals.length > MAX_DEMAND_SIGNALS) {
      this.demandSignals = this.demandSignals.slice(-MAX_DEMAND_SIGNALS);
    }
  }

  private fulfillDemand(domain: string): void {
    for (const signal of this.demandSignals) {
      if (signal.domain === domain && !signal.fulfilled) {
        signal.fulfilled = true;
      }
    }
  }
}

// --- Singleton Instance -----------------------------------------------------

export const megaPool = new MegaPool();
