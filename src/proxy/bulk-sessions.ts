/**
 * Bulk Proxy Session Pre-Creation Manager -- HYPERSCALE TITAN EDITION v2
 *
 * Pre-creates residential proxy sessions across all providers, maintaining
 * a pool of "warm" sessions ready for immediate use. Supports auto-scaling,
 * predictive warming, session lifecycle management, cost tracking, circuit
 * breakers, adaptive batching, demand-based prioritization, and real-time
 * monitoring dashboards.
 *
 *  -------------------------------------------------------------------------
 *  * Bulk creation: 5000+ sessions (was 500)
 *  * Creation speed: 1000 sessions/minute via parallel Promise.allSettled
 *  * Smart batching: create sessions in optimal batch sizes of 100+
 *  * Session pre-warming: validate sessions before adding to pool
 *  * Multi-provider bulk: create sessions across ALL providers simultaneously
 *  * Session distribution: even distribution across countries and tiers
 *  * Auto-replenishment: 5s check interval (was 30-60s)
 *  * Session quality scoring: rank sessions by expected performance
 *  * Replace 30-60s intervals with 5-10s for faster reaction
 *  * Real-time metrics and monitoring with dashboard
 *  * Error recovery and auto-retry with exponential backoff
 *  * Circuit breaker per provider (5 failures → open, 30s → half-open)
 *  * Session prioritization: prioritize countries/tiers with highest demand
 *  * Parallel validation of created sessions
 *  * Adaptive batch sizing based on provider success rates
 *  * Demand-based country/tier prioritization
 *  * Session recycling -- reuse returned sessions efficiently
 *  * Cost optimization -- prefer cheaper providers when quality allows
 *  * Graceful degradation when providers fail
 *  * Comprehensive logging with structured error context
 *  -------------------------------------------------------------------------
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';

const logger = createChildLogger('bulk-sessions');

// --- Constants ----------------------------------------------------------------

const DEFAULT_WARM_POOL_SIZE = 5000; // 5000 (was 500)
const DEFAULT_MANAGEMENT_INTERVAL = 5 * 1000; // 5s (was 60s, then 10s)
const SESSION_HEALTH_CHECK_INTERVAL = 5 * 1000; // 5s (was 5 min)
const SESSION_EXPIRY_BUFFER_MS = 3 * 60 * 1000; // 3 min before expiry
const MAX_SESSION_AGE_MS = 15 * 60 * 1000; // 15 min (was 30)
const MIN_WARM_POOL_SIZE = 500; // 500 (was 50)
const MAX_WARM_POOL_SIZE = 10_000; // 10K (was 2K)
const DEMAND_SCALE_UP_THRESHOLD = 0.6; // 60% utilization triggers scale-up
const DEMAND_SCALE_DOWN_THRESHOLD = 0.2; // 20% utilization triggers scale-down
const SCALE_UP_INCREMENT = 500;
const SCALE_DOWN_INCREMENT = 100;
const MAX_CONCURRENT_CREATIONS = 200; // 200 (was 100, originally 10)
const PARALLEL_CREATE_BATCH = 100; // 100 (was 50) -- optimal batch size
const PREDICTION_WINDOW_MS = 15 * 60 * 1000;
const AUTO_REPLENISH_INTERVAL = 5_000; // 5s (was 10s)
const SESSION_PREWARM_VALIDATE_TIMEOUT = 8_000;
const SESSION_CREATE_RETRIES = 3;
const QUALITY_SCORE_THRESHOLD = 0.3; // Below this, session is low quality
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5; // 5 failures opens circuit
const CIRCUIT_BREAKER_OPEN_DURATION_MS = 30_000; // 30s open → half-open
const CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS = 3; // Allow 3 probes in half-open
const EXPONENTIAL_BACKOFF_BASE_MS = 500; // Base delay for exponential backoff
const EXPONENTIAL_BACKOFF_MAX_MS = 30_000; // Max backoff delay
const DEMAND_PRIORITY_BOOST_FACTOR = 0.15; // Quality boost for high-demand targets
const COST_OPTIMIZATION_THRESHOLD = 0.7; // Use cheaper provider if quality above this
const SESSION_RECYCLE_MAX_USES = 10; // Max times a recycled session can be reused
const ADAPTIVE_BATCH_MIN = 20; // Minimum adaptive batch size
const ADAPTIVE_BATCH_MAX = 200; // Maximum adaptive batch size
const METRICS_RETENTION_MS = 60 * 60 * 1000; // 1 hour of metrics retention
const METRICS_SNAPSHOT_INTERVAL_MS = 10_000; // Snapshot every 10s
const PARALLEL_VALIDATION_CONCURRENCY = 50; // Max concurrent validations
const SESSION_AFFINITY_TTL_MS = 5 * 60 * 1000; // 5 min domain affinity
const PROVIDER_HEALTH_CHECK_INTERVAL_MS = 15_000; // 15s provider health check
const EMERGENCY_POOL_MULTIPLIER = 3; // Emergency replenish multiplier
const MIN_PROVIDER_SUCCESS_RATE = 0.3; // Below 30% success, reduce batch size

// --- Provider Configurations -------------------------------------------------

interface ProviderConfig {
  name: string;
  costPerGb: number;
  sessionEndpoint: string;
  supportsCountry: boolean;
  supportsCity: boolean;
  supportsSticky: boolean;
  maxConcurrentSessions: number;
  defaultPort: number;
  protocol: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  brightdata: {
    name: 'Bright Data',
    costPerGb: 8.0,
    sessionEndpoint: 'brd.superproxy.io',
    supportsCountry: true,
    supportsCity: true,
    supportsSticky: true,
    maxConcurrentSessions: 500,
    defaultPort: 22225,
    protocol: 'http',
  },
  oxylabs: {
    name: 'Oxylabs',
    costPerGb: 10.0,
    sessionEndpoint: 'pr.oxylabs.io',
    supportsCountry: true,
    supportsCity: true,
    supportsSticky: true,
    maxConcurrentSessions: 500,
    defaultPort: 7777,
    protocol: 'http',
  },
  smartproxy: {
    name: 'SmartProxy',
    costPerGb: 7.0,
    sessionEndpoint: 'gate.smartproxy.com',
    supportsCountry: true,
    supportsCity: false,
    supportsSticky: true,
    maxConcurrentSessions: 300,
    defaultPort: 7000,
    protocol: 'http',
  },
  iproyal: {
    name: 'IPRoyal',
    costPerGb: 5.0,
    sessionEndpoint: 'geo.iproyal.com',
    supportsCountry: true,
    supportsCity: false,
    supportsSticky: true,
    maxConcurrentSessions: 200,
    defaultPort: 12321,
    protocol: 'http',
  },
  webshare: {
    name: 'Webshare',
    costPerGb: 4.0,
    sessionEndpoint: 'proxy.webshare.io',
    supportsCountry: true,
    supportsCity: false,
    supportsSticky: false,
    maxConcurrentSessions: 200,
    defaultPort: 80,
    protocol: 'http',
  },
};

/** Target country distribution for even geographic coverage */
const TARGET_COUNTRY_DISTRIBUTION: Record<string, number> = {
  US: 0.25,
  DE: 0.12,
  GB: 0.10,
  FR: 0.08,
  NL: 0.06,
  JP: 0.06,
  BR: 0.05,
  IN: 0.05,
  CA: 0.05,
  AU: 0.04,
  SG: 0.03,
  KR: 0.03,
  IT: 0.03,
  ES: 0.03,
  MX: 0.02,
};

/** Target tier distribution */
const TARGET_TIER_DISTRIBUTION: Record<string, number> = {
  residential: 0.60,
  mobile: 0.20,
  datacenter: 0.15,
  isp: 0.05,
};

// --- Types --------------------------------------------------------------------

export interface WarmSession {
  id: string;
  proxyUrl: string;
  provider: string;
  tier: string;
  country: string;
  city?: string;
  costPerGb: number;
  createdAt: number;
  lastUsed: number;
  useCount: number;
  successCount: number;
  failureCount: number;
  isHealthy: boolean;
  expiresAt: number;
  domain?: string;
  /** Quality score: 0-1, predicts likelihood of working */
  qualityScore: number;
  /** Whether this session has been pre-warmed (validated) */
  prewarmed: boolean;
  /** Validation latency in ms */
  latencyMs?: number;
  /** Creation attempt number (for retry tracking) */
  creationAttempt: number;
  /** Last error message if session had issues */
  lastError?: string;
  /** Number of times this session has been recycled back to pool */
  recycleCount: number;
  /** Domain affinity -- preferred domain for this session */
  affinityDomain?: string;
  /** Affinity expires at this timestamp */
  affinityExpiresAt: number;
  /** Whether this session was created via adaptive batching */
  adaptiveBatch: boolean;
  /** Circuit breaker state at time of creation */
  providerCircuitState: CircuitState;
}

export interface SessionStats {
  warmPoolSize: number;
  targetPoolSize: number;
  activeSessions: number;
  totalCreated: number;
  totalExpired: number;
  totalUsed: number;
  avgSessionLifeMs: number;
  byProvider: Record<string, number>;
  byCountry: Record<string, number>;
  byTier: Record<string, number>;
  costPerHour: number;
  /** Pool utilization rate */
  poolUtilization: number;
  /** Average quality score */
  avgQualityScore: number;
  /** Pre-warmed session count */
  prewarmedCount: number;
  /** Session creation rate */
  creationRate: number;
  /** Country distribution skew */
  countryDistributionSkew: number;
  /** Real-time metrics */
  metrics: BulkSessionMetrics;
}

export interface BulkSessionMetrics {
  totalCreationAttempts: number;
  totalCreationSuccesses: number;
  totalCreationFailures: number;
  totalRetries: number;
  avgCreationTimeMs: number;
  peakCreationRate: number;
  totalPrewarmAttempts: number;
  totalPrewarmSuccesses: number;
  totalAutoReplenishments: number;
  totalQualityRejections: number;
  lastManagementCycleAt: number;
  lastReplenishmentAt: number;
  creationTimestamps: number[];
  /** Total sessions recycled back to pool */
  totalRecycled: number;
  /** Total circuit breaker trips */
  totalCircuitBreakerTrips: number;
  /** Total exponential backoff delays applied */
  totalBackoffDelays: number;
  /** Current adaptive batch size */
  currentAdaptiveBatchSize: number;
  /** Sessions created via cost optimization */
  totalCostOptimizedCreations: number;
  /** Sessions created for demand prioritization */
  totalDemandPrioritizedCreations: number;
  /** Time-series snapshot data for dashboard */
  timeSeriesSnapshots: MetricsSnapshot[];
  /** Total emergency replenishments */
  totalEmergencyReplenishments: number;
  /** Total parallel validations run */
  totalParallelValidations: number;
  /** Average validation latency across all prewarms */
  avgValidationLatencyMs: number;
}

/** Snapshot of metrics at a point in time for dashboard rendering */
export interface MetricsSnapshot {
  timestamp: number;
  poolSize: number;
  healthyCount: number;
  prewarmedCount: number;
  creationRate: number;
  avgQualityScore: number;
  circuitBreakerStates: Record<string, CircuitState>;
  providerSuccessRates: Record<string, number>;
}

interface DemandSignal {
  domain: string;
  requestCount: number;
  timestamp: number;
  tier?: string;
  country?: string;
}

interface PredictionResult {
  domain: string;
  predictedDemand: number;
  suggestedSessions: number;
  confidence: number;
  tier?: string;
  country?: string;
}

/** Circuit breaker states */
enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/** Per-provider circuit breaker */
interface CircuitBreaker {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureAt: number;
  openedAt: number;
  halfOpenRequests: number;
  totalTrips: number;
  consecutiveSuccesses: number;
  lastStateChangeAt: number;
}

/** Per-provider health and performance tracking */
interface ProviderHealth {
  provider: string;
  successRate: number;         // 0-1 rolling success rate
  avgLatencyMs: number;       // Average latency
  activeSessions: number;     // Currently in pool
  creationAttempts: number;   // Total creation attempts
  creationSuccesses: number;  // Total successful creations
  lastError?: string;         // Last error message
  lastSuccessAt: number;      // Timestamp of last success
  adaptiveBatchSize: number;  // Current adaptive batch size for this provider
  recentOutcomes: boolean[];  // Last N outcomes for rolling success rate
  costEfficiencyScore: number; // Computed cost-efficiency metric
}

/** Demand priority for a country/tier combination */
interface DemandPriority {
  country: string;
  tier: string;
  priority: number;      // 0-1, higher = more priority
  demandCount: number;   // Raw demand signal count
  lastDemandAt: number;  // Timestamp of last demand
  currentSupply: number; // Current sessions matching
  deficit: number;       // demandCount - currentSupply
}

/** Session affinity tracking */
interface SessionAffinity {
  domain: string;
  sessionId: string;
  expiresAt: number;
  hitCount: number;
}

// --- Utility: Exponential Backoff ---------------------------------------------

/**
 * Compute exponential backoff delay with jitter.
 * Formula: min(base * 2^attempt + random_jitter, maxDelay)
 */
function computeExponentialBackoff(
  attempt: number,
  baseMs: number = EXPONENTIAL_BACKOFF_BASE_MS,
  maxMs: number = EXPONENTIAL_BACKOFF_MAX_MS,
): number {
  const exponentialDelay = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs * 0.5; // 0-50% jitter
  return Math.min(exponentialDelay + jitter, maxMs);
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Bulk Session Manager Class ----------------------------------------------

export class BulkSessionManager {
  private warmPool: Map<string, WarmSession> = new Map();
  private targetPoolSize: number = DEFAULT_WARM_POOL_SIZE;
  private managementTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private replenishTimer: ReturnType<typeof setInterval> | null = null;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private providerHealthTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private totalCreated = 0;
  private totalExpired = 0;
  private totalUsed = 0;
  private totalSessionLifeMs = 0;
  private demandSignals: DemandSignal[] = [];
  private creationInProgress = false;

  /** Circuit breakers per provider */
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();

  /** Provider health tracking */
  private providerHealthMap: Map<string, ProviderHealth> = new Map();

  /** Demand priority tracking */
  private demandPriorities: Map<string, DemandPriority> = new Map();

  /** Session affinity tracking */
  private sessionAffinities: Map<string, SessionAffinity> = new Map();

  /** Metrics tracking */
  private metrics: BulkSessionMetrics = {
    totalCreationAttempts: 0,
    totalCreationSuccesses: 0,
    totalCreationFailures: 0,
    totalRetries: 0,
    avgCreationTimeMs: 0,
    peakCreationRate: 0,
    totalPrewarmAttempts: 0,
    totalPrewarmSuccesses: 0,
    totalAutoReplenishments: 0,
    totalQualityRejections: 0,
    lastManagementCycleAt: 0,
    lastReplenishmentAt: 0,
    creationTimestamps: [],
    totalRecycled: 0,
    totalCircuitBreakerTrips: 0,
    totalBackoffDelays: 0,
    currentAdaptiveBatchSize: PARALLEL_CREATE_BATCH,
    totalCostOptimizedCreations: 0,
    totalDemandPrioritizedCreations: 0,
    timeSeriesSnapshots: [],
    totalEmergencyReplenishments: 0,
    totalParallelValidations: 0,
    avgValidationLatencyMs: 0,
  };

  private providerCredentials: Record<string, { username: string; password: string }> = {};

  /** Running total of validation latencies for avg calculation */
  private validationLatencySum = 0;
  private validationLatencyCount = 0;

  constructor() {
    this.loadProviderCredentials();
    this.initializeCircuitBreakers();
    this.initializeProviderHealth();
  }

  // --- Public API ------------------------------------------------------------

  /**
   * Start the bulk session manager.
   * Spawns all management intervals with aggressive 5-10s timing.
   */
  startManager(intervalMs: number = DEFAULT_MANAGEMENT_INTERVAL): void {
    if (this.isRunning) {
      logger.warn('Bulk session manager already running');
      return;
    }

    this.isRunning = true;

    // Load persisted state first
    this.loadState().then((loaded) => {
      if (!loaded) {
        // Initial warm-up -- create initial pool
        this.preCreateSessions(Math.min(this.targetPoolSize, 2500)).catch((err) => {
          logger.error({ error: (err as Error).message }, 'Initial session pre-creation failed');
        });
      } else {
        logger.info({ loadedSessions: this.warmPool.size }, 'Resumed from persisted state');
        // Top off pool if below target
        if (this.warmPool.size < this.targetPoolSize * 0.8) {
          const deficit = this.targetPoolSize - this.warmPool.size;
          this.preCreateSessions(Math.min(deficit, MAX_CONCURRENT_CREATIONS * 2)).catch((err) => {
            logger.error({ error: (err as Error).message }, 'Post-resume replenishment failed');
          });
        }
      }
    }).catch((err) => {
      logger.warn({ error: (err as Error).message }, 'State load failed, creating fresh pool');
      this.preCreateSessions(Math.min(this.targetPoolSize, 2500)).catch((innerErr) => {
        logger.error({ error: (innerErr as Error).message }, 'Initial session pre-creation failed');
      });
    });

    // Management cycle -- 5s (was 60s, then 10s)
    this.managementTimer = setInterval(async () => {
      try {
        await this.runManagementCycle();
      } catch (err: any) {
        logger.error({ error: err.message }, 'Session management cycle failed');
      }
    }, intervalMs);

    // Health checks -- 5s
    this.healthTimer = setInterval(async () => {
      try {
        await this.healthCheckSessions();
      } catch (err: any) {
        logger.error({ error: err.message }, 'Session health check failed');
      }
    }, SESSION_HEALTH_CHECK_INTERVAL);

    // Auto-replenishment -- 5s (was 10s)
    this.replenishTimer = setInterval(async () => {
      try {
        await this.autoReplenish();
      } catch (err: any) {
        logger.warn({ error: err.message }, 'Auto-replenishment failed');
      }
    }, AUTO_REPLENISH_INTERVAL);

    // Metrics snapshot collection -- 10s
    this.metricsTimer = setInterval(() => {
      try {
        this.collectMetricsSnapshot();
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Metrics snapshot collection failed');
      }
    }, METRICS_SNAPSHOT_INTERVAL_MS);

    // Provider health monitoring -- 15s
    this.providerHealthTimer = setInterval(() => {
      try {
        this.updateProviderHealthTracking();
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Provider health update failed');
      }
    }, PROVIDER_HEALTH_CHECK_INTERVAL_MS);

    logger.info(
      { intervalMs, targetPoolSize: this.targetPoolSize, batchSize: PARALLEL_CREATE_BATCH },
      'Bulk session manager HYPERSCALE TITAN EDITION v2 started',
    );
  }

  /**
   * Stop the bulk session manager.
   */
  stopManager(): void {
    if (this.managementTimer) { clearInterval(this.managementTimer); this.managementTimer = null; }
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    if (this.replenishTimer) { clearInterval(this.replenishTimer); this.replenishTimer = null; }
    if (this.metricsTimer) { clearInterval(this.metricsTimer); this.metricsTimer = null; }
    if (this.providerHealthTimer) { clearInterval(this.providerHealthTimer); this.providerHealthTimer = null; }
    this.isRunning = false;

    // Persist state on shutdown
    this.persistState().catch((err) => {
      logger.warn({ error: (err as Error).message }, 'Failed to persist state on shutdown');
    });

    logger.info('Bulk session manager stopped');
  }

  /**
   * Pre-create N sessions across all configured providers.
   * Uses parallel creation with Promise.allSettled for speed.
   * Implements smart batching (100+), session pre-warming, circuit breakers,
   * exponential backoff retries, and cost-optimized provider selection.
   */
  async preCreateSessions(
    count: number,
    options?: {
      tier?: string;
      country?: string;
      provider?: string;
      domain?: string;
      prewarm?: boolean;
    },
  ): Promise<{ created: number; failed: number }> {
    if (this.creationInProgress) {
      logger.warn('Session creation already in progress -- skipping');
      return { created: 0, failed: 0 };
    }

    this.creationInProgress = true;
    let created = 0;
    let failed = 0;
    const startTime = Date.now();
    const creationTimes: number[] = [];

    try {
      // Get providers, filtering out ones with open circuit breakers
      const availableProviders = this.getAvailableProvidersWithCircuitCheck(options?.provider);
      if (availableProviders.length === 0) {
        logger.warn('No providers available (all circuits open or no credentials)');
        return { created: 0, failed: count };
      }

      // Compute optimal batch distribution across providers
      // This uses cost optimization and demand prioritization
      const distribution = this.computeSmartProviderDistribution(
        availableProviders,
        count,
        options?.tier,
        options?.country,
      );

      // Create sessions across ALL providers simultaneously (not sequentially!)
      // Each provider gets its own parallel batch pipeline
      const providerPromises = Object.entries(distribution).map(
        async ([providerName, providerCount]) => {
          const providerConfig = PROVIDER_CONFIGS[providerName];
          if (!providerConfig) return { created: 0, failed: 0 };

          const credentials = this.providerCredentials[providerName];
          if (!credentials) return { created: 0, failed: 0 };

          // Check circuit breaker before starting
          if (!this.canAttemptProvider(providerName)) {
            logger.debug({ provider: providerName }, 'Circuit breaker blocking provider');
            return { created: 0, failed: providerCount };
          }

          // Determine adaptive batch size for this provider
          const batchSize = this.getAdaptiveBatchSize(providerName);
          const batches = Math.ceil(providerCount / batchSize);

          let providerCreated = 0;
          let providerFailed = 0;

          for (let batch = 0; batch < batches; batch++) {
            const currentBatchSize = Math.min(batchSize, providerCount - batch * batchSize);
            if (currentBatchSize <= 0) break;

            // Check circuit breaker before each batch
            if (!this.canAttemptProvider(providerName)) {
              providerFailed += currentBatchSize;
              break;
            }

            const batchStartTime = Date.now();

            // Create sessions in parallel within the batch
            const results = await Promise.allSettled(
              Array.from({ length: currentBatchSize }, (_, i) => {
                // Determine country/tier -- use demand prioritization if no override
                const sessionCountry = options?.country || this.selectCountryWithDemandPriority();
                const sessionTier = options?.tier || this.selectTierWithDemandPriority();

                return this.createSessionWithRetry(providerName, providerConfig, credentials, {
                  tier: sessionTier,
                  country: sessionCountry,
                  domain: options?.domain,
                  sessionIndex: providerCreated + batch * batchSize + i,
                  prewarm: options?.prewarm ?? true,
                  maxRetries: SESSION_CREATE_RETRIES,
                });
              }),
            );

            const batchElapsed = Date.now() - batchStartTime;
            creationTimes.push(batchElapsed);

            // Process results and update circuit breaker
            for (const result of results) {
              this.metrics.totalCreationAttempts++;

              if (result.status === 'fulfilled' && result.value) {
                const session = result.value;
                this.warmPool.set(session.id, session);
                providerCreated++;
                this.totalCreated++;
                this.metrics.totalCreationSuccesses++;
                this.trackCreationRate();
                this.recordProviderOutcome(providerName, true);
              } else {
                providerFailed++;
                this.metrics.totalCreationFailures++;
                this.recordProviderOutcome(providerName, false);
              }
            }
          }

          return { created: providerCreated, failed: providerFailed };
        },
      );

      // Wait for all provider pipelines to complete simultaneously
      const providerResults = await Promise.allSettled(providerPromises);

      for (const result of providerResults) {
        if (result.status === 'fulfilled' && result.value) {
          created += result.value.created;
          failed += result.value.failed;
        } else {
          failed += count; // Entire provider pipeline failed
        }
      }

      const elapsed = Date.now() - startTime;
      const rate = elapsed > 0 ? Math.round(created / (elapsed / 60000)) : 0;

      // Update average creation time
      if (creationTimes.length > 0) {
        const avgBatchTime = creationTimes.reduce((a, b) => a + b, 0) / creationTimes.length;
        this.metrics.avgCreationTimeMs = Math.round(
          (this.metrics.avgCreationTimeMs * 0.8) + (avgBatchTime * 0.2), // EMA smoothing
        );
      }

      logger.info(
        {
          created,
          failed,
          totalRequested: count,
          warmPoolSize: this.warmPool.size,
          rate: `${rate}/min`,
          elapsed: `${elapsed}ms`,
          circuitBreakerStates: this.getCircuitBreakerStates(),
        },
        'Session pre-creation completed',
      );
    } catch (err: any) {
      logger.error({ error: err.message }, 'Session pre-creation failed');
    } finally {
      this.creationInProgress = false;
    }

    return { created, failed };
  }

  /**
   * Get a pre-warmed session from the warm pool.
   * Selects the best available session based on quality score, tier, demand
   * priority, session affinity, and health status.
   */
  async getWarmSession(tier?: string, country?: string): Promise<WarmSession | null> {
    const now = Date.now();

    // First try: find a session with domain affinity if we have demand signals
    const affinitySession = this.findSessionWithAffinity(tier, country);
    if (affinitySession) {
      affinitySession.useCount++;
      affinitySession.lastUsed = now;
      this.totalUsed++;
      this.warmPool.delete(affinitySession.id);
      return affinitySession;
    }

    // Second try: general candidate search with quality and demand priority
    const candidates = Array.from(this.warmPool.values())
      .filter((s) => {
        if (!s.isHealthy) return false;
        if (s.expiresAt - now < SESSION_EXPIRY_BUFFER_MS) return false;
        if (tier && s.tier !== tier) return false;
        if (country && s.country !== country.toUpperCase()) return false;
        if (s.qualityScore < QUALITY_SCORE_THRESHOLD) return false;
        if (s.recycleCount >= SESSION_RECYCLE_MAX_USES) return false;
        return true;
      })
      .sort((a, b) => {
        // Sort by: demand priority → quality score → pre-warmed → least used
        const aDemandBoost = this.getDemandPriorityScore(a.country, a.tier);
        const bDemandBoost = this.getDemandPriorityScore(b.country, b.tier);
        const aComposite = a.qualityScore + aDemandBoost;
        const bComposite = b.qualityScore + bDemandBoost;

        if (aComposite !== bComposite) return bComposite - aComposite;
        if (a.prewarmed !== b.prewarmed) return (a.prewarmed ? 1 : 0) - (b.prewarmed ? 1 : 0);
        if (a.latencyMs !== undefined && b.latencyMs !== undefined) return a.latencyMs - b.latencyMs;
        return a.useCount - b.useCount; // Prefer less-used sessions
      });

    if (candidates.length === 0) {
      logger.debug({ tier, country }, 'No warm sessions available');

      // Try to create one on-demand
      const onDemand = await this.preCreateSessions(1, { tier, country });
      if (onDemand.created > 0) {
        const newSession = Array.from(this.warmPool.values()).find(
          (s) => s.isHealthy && (!tier || s.tier === tier) && (!country || s.country === country.toUpperCase()),
        );
        if (newSession) {
          newSession.useCount++;
          newSession.lastUsed = now;
          this.totalUsed++;
          this.warmPool.delete(newSession.id);
          return newSession;
        }
      }

      return null;
    }

    const session = candidates[0];
    session.useCount++;
    session.lastUsed = now;
    this.totalUsed++;

    // Remove from warm pool (it's now in use)
    this.warmPool.delete(session.id);

    return session;
  }

  /**
   * Release a session back to the pool after use.
   * Supports session recycling: sessions with remaining life and quality
   * are returned to the pool instead of being discarded.
   */
  async releaseSession(sessionId: string, success: boolean): Promise<void> {
    const session = this.warmPool.get(sessionId);

    if (session) {
      if (success) {
        session.successCount++;
        session.qualityScore = Math.min(1.0, session.qualityScore + 0.02);
      } else {
        session.failureCount++;
        session.qualityScore = Math.max(0, session.qualityScore - 0.05);
      }
      session.lastUsed = Date.now();
      return;
    }

    try {
      await redis.hset(
        'session-outcomes',
        sessionId,
        JSON.stringify({ success, releasedAt: Date.now() }),
      );
    } catch (err: any) {
      logger.debug({ sessionId, error: err.message }, 'Failed to record session outcome');
    }

    if (success) {
      this.recordDemandSignal(sessionId);
    }
  }

  /**
   * Recycle a session back to the warm pool for reuse.
   * Only recycles if the session has remaining life, quality, and hasn't
   * exceeded the max recycle count.
   */
  recycleSession(session: WarmSession, success: boolean): boolean {
    const now = Date.now();

    // Check if session is still viable for recycling
    if (session.recycleCount >= SESSION_RECYCLE_MAX_USES) return false;
    if (session.expiresAt - now < SESSION_EXPIRY_BUFFER_MS) return false;
    if (now - session.createdAt > MAX_SESSION_AGE_MS) return false;

    // Update session state based on outcome
    if (success) {
      session.successCount++;
      session.qualityScore = Math.min(1.0, session.qualityScore + 0.03);
    } else {
      session.failureCount++;
      session.qualityScore = Math.max(0, session.qualityScore - 0.08);
      session.lastError = 'recycle_failure';
    }

    // Don't recycle low-quality sessions
    if (session.qualityScore < QUALITY_SCORE_THRESHOLD) return false;

    session.recycleCount++;
    session.lastUsed = now;
    session.isHealthy = success;

    // Set affinity if there's a domain association
    if (session.domain) {
      session.affinityDomain = session.domain;
      session.affinityExpiresAt = now + SESSION_AFFINITY_TTL_MS;
      this.sessionAffinities.set(`${session.domain}:${session.country}`, {
        domain: session.domain,
        sessionId: session.id,
        expiresAt: now + SESSION_AFFINITY_TTL_MS,
        hitCount: 0,
      });
    }

    // Add back to warm pool
    this.warmPool.set(session.id, session);
    this.metrics.totalRecycled++;

    logger.debug(
      { sessionId: session.id, recycleCount: session.recycleCount, qualityScore: session.qualityScore },
      'Session recycled back to pool',
    );

    return true;
  }

  /**
   * Scale up sessions for a specific domain's demand.
   */
  async scaleUp(domain: string, count: number): Promise<number> {
    logger.info({ domain, count }, 'Scaling up sessions for domain');

    // Record the demand to influence prioritization
    this.recordExternalDemand(domain, count);

    const result = await this.preCreateSessions(count, { domain });
    return result.created;
  }

  /**
   * Scale down when demand is low.
   */
  async scaleDown(): Promise<number> {
    const currentSize = this.warmPool.size;
    if (currentSize <= this.targetPoolSize) return 0;

    const excess = currentSize - this.targetPoolSize;
    let removed = 0;

    // Sort by: lowest quality first, then oldest, then most recycled
    const sessions = Array.from(this.warmPool.values()).sort((a, b) => {
      if (a.qualityScore !== b.qualityScore) return a.qualityScore - b.qualityScore;
      if (a.recycleCount !== b.recycleCount) return b.recycleCount - a.recycleCount;
      return a.createdAt - b.createdAt;
    });

    for (const session of sessions) {
      if (removed >= Math.min(excess, SCALE_DOWN_INCREMENT)) break;
      this.warmPool.delete(session.id);
      this.totalExpired++;
      this.totalSessionLifeMs += Date.now() - session.createdAt;
      removed++;
    }

    logger.info({ removed, warmPoolSize: this.warmPool.size, targetPoolSize: this.targetPoolSize }, 'Scaled down');
    return removed;
  }

  /**
   * Check health of warm sessions by testing a sample.
   * Now includes parallel validation for higher throughput.
   */
  async healthCheckSessions(): Promise<{ checked: number; healthy: number; unhealthy: number; removed: number }> {
    let checked = 0;
    let healthy = 0;
    let unhealthy = 0;
    let removed = 0;
    const now = Date.now();

    const sessions = Array.from(this.warmPool.values());
    const sampleSize = Math.min(sessions.length, 200); // 200 (was 100) for more coverage
    const sample = this.sampleArray(sessions, sampleSize);

    // Parallel health checks with controlled concurrency
    const results = await Promise.allSettled(
      sample.map(async (session) => {
        // Check expiry
        if (session.expiresAt < now + SESSION_EXPIRY_BUFFER_MS) {
          return { session, action: 'remove' as const, reason: 'expired' };
        }

        // Check max age
        if (now - session.createdAt > MAX_SESSION_AGE_MS) {
          return { session, action: 'remove' as const, reason: 'aged' };
        }

        // Check recycle limit
        if (session.recycleCount >= SESSION_RECYCLE_MAX_USES) {
          return { session, action: 'remove' as const, reason: 'max_recycled' };
        }

        // Test connectivity (only for pre-warmed sessions or random sample)
        if (session.prewarmed || Math.random() < 0.15) { // 15% sample rate (was 10%)
          try {
            const result = await testProxy(session.proxyUrl, 'https://httpbin.org/ip', SESSION_PREWARM_VALIDATE_TIMEOUT);
            if (result.working) {
              return { session, action: 'healthy' as const, reason: 'validation', latencyMs: result.latencyMs };
            } else {
              return { session, action: 'unhealthy' as const, reason: 'validation_failed' };
            }
          } catch {
            return { session, action: 'unhealthy' as const, reason: 'validation_error' };
          }
        }

        return { session, action: 'healthy' as const, reason: 'unchecked' };
      }),
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { session, action, reason, latencyMs } = result.value;
      checked++;

      switch (action) {
        case 'remove':
          this.warmPool.delete(session.id);
          this.totalExpired++;
          this.totalSessionLifeMs += now - session.createdAt;
          removed++;
          break;
        case 'unhealthy':
          session.isHealthy = false;
          session.qualityScore = Math.max(0, session.qualityScore - 0.2);
          session.lastError = reason;
          unhealthy++;
          break;
        case 'healthy':
          session.isHealthy = true;
          session.qualityScore = Math.min(1.0, session.qualityScore + 0.02);
          if (latencyMs !== undefined) {
            session.latencyMs = latencyMs;
          }
          healthy++;
          break;
      }
    }

    // Bulk remove all expired sessions from the pool
    const expiredIds: string[] = [];
    for (const [id, session] of this.warmPool) {
      if (
        session.expiresAt < now + SESSION_EXPIRY_BUFFER_MS ||
        now - session.createdAt > MAX_SESSION_AGE_MS ||
        session.recycleCount >= SESSION_RECYCLE_MAX_USES
      ) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      const session = this.warmPool.get(id);
      if (session) {
        this.totalSessionLifeMs += now - session.createdAt;
      }
      this.warmPool.delete(id);
      this.totalExpired++;
      removed++;
    }

    // Clean up expired affinities
    this.cleanExpiredAffinities();

    return { checked, healthy, unhealthy, removed };
  }

  /**
   * Run parallel validation on a batch of sessions.
   * This is separate from health checks and focuses on validating
   * unvalidated sessions in the pool.
   */
  async parallelValidateSessions(
    sessions: WarmSession[],
    concurrency: number = PARALLEL_VALIDATION_CONCURRENCY,
  ): Promise<{ validated: number; healthy: number; unhealthy: number }> {
    let validated = 0;
    let healthy = 0;
    let unhealthy = 0;

    // Process in chunks of `concurrency`
    for (let i = 0; i < sessions.length; i += concurrency) {
      const chunk = sessions.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        chunk.map(async (session) => {
          try {
            const result = await testProxy(
              session.proxyUrl,
              'https://httpbin.org/ip',
              SESSION_PREWARM_VALIDATE_TIMEOUT,
            );

            return {
              session,
              working: result.working,
              latencyMs: result.latencyMs,
            };
          } catch {
            return { session, working: false, latencyMs: undefined };
          }
        }),
      );

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { session, working, latencyMs } = result.value;
        validated++;
        this.metrics.totalParallelValidations++;

        if (working) {
          session.prewarmed = true;
          session.isHealthy = true;
          session.latencyMs = latencyMs;
          session.qualityScore = Math.min(1.0, session.qualityScore + 0.1);
          healthy++;

          if (latencyMs !== undefined) {
            this.validationLatencySum += latencyMs;
            this.validationLatencyCount++;
            this.metrics.avgValidationLatencyMs = Math.round(
              this.validationLatencySum / this.validationLatencyCount,
            );
          }
        } else {
          session.isHealthy = false;
          session.qualityScore = Math.max(0, session.qualityScore - 0.2);
          session.prewarmed = false;
          unhealthy++;
        }
      }
    }

    return { validated, healthy, unhealthy };
  }

  /**
   * Auto-replenish: automatically create more sessions when pool drops below target.
   * Now with 5s check interval and smarter replenishment logic.
   */
  private async autoReplenish(): Promise<void> {
    const activeCount = Array.from(this.warmPool.values()).filter(s => s.isHealthy).length;

    if (activeCount < this.targetPoolSize * 0.8) {
      const deficit = this.targetPoolSize - activeCount;
      // Create up to 2x the deficit to stay ahead of demand
      const toCreate = Math.min(deficit * 2, MAX_CONCURRENT_CREATIONS * 2);

      this.metrics.totalAutoReplenishments++;
      this.metrics.lastReplenishmentAt = Date.now();

      logger.info(
        { active: activeCount, target: this.targetPoolSize, creating: toCreate },
        'Auto-replenishing session pool',
      );

      await this.preCreateSessions(toCreate);
    }

    // Emergency replenishment -- pool critically low
    if (activeCount < MIN_WARM_POOL_SIZE) {
      logger.warn(
        { active: activeCount, threshold: MIN_WARM_POOL_SIZE },
        'Session pool critically low -- EMERGENCY replenishment',
      );

      const emergencyCount = Math.min(
        MIN_WARM_POOL_SIZE * EMERGENCY_POOL_MULTIPLIER,
        MAX_CONCURRENT_CREATIONS * 3,
      );
      this.metrics.totalEmergencyReplenishments++;
      await this.preCreateSessions(emergencyCount);
    }

    // Proactive replenishment -- pool declining but not yet critical
    if (activeCount < this.targetPoolSize * 0.9 && activeCount >= this.targetPoolSize * 0.8) {
      const deficit = this.targetPoolSize - activeCount;
      const toCreate = Math.min(deficit, MAX_CONCURRENT_CREATIONS);

      logger.debug(
        { active: activeCount, target: this.targetPoolSize, creating: toCreate },
        'Proactive replenishment -- pool declining',
      );

      await this.preCreateSessions(toCreate);
    }
  }

  /**
   * Get current session statistics.
   */
  getStats(): SessionStats {
    const sessions = Array.from(this.warmPool.values());
    const now = Date.now();

    const byProvider: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    let totalRemainingLifeMs = 0;

    for (const session of sessions) {
      byProvider[session.provider] = (byProvider[session.provider] || 0) + 1;
      byCountry[session.country] = (byCountry[session.country] || 0) + 1;
      byTier[session.tier] = (byTier[session.tier] || 0) + 1;
      totalRemainingLifeMs += Math.max(0, session.expiresAt - now);
    }

    let costPerHour = 0;
    for (const session of sessions) {
      if (session.isHealthy) {
        costPerHour += session.costPerGb * 0.5;
      }
    }

    const avgSessionLifeMs = this.totalExpired > 0 ? this.totalSessionLifeMs / this.totalExpired : 0;
    const avgQualityScore = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + s.qualityScore, 0) / sessions.length
      : 0;
    const prewarmedCount = sessions.filter(s => s.prewarmed).length;
    const creationRate = this.computeCreationRate();

    // Country distribution skew (0 = perfect distribution)
    const countrySkew = this.computeCountryDistributionSkew(byCountry, sessions.length);

    return {
      warmPoolSize: sessions.length,
      targetPoolSize: this.targetPoolSize,
      activeSessions: sessions.filter((s) => s.isHealthy).length,
      totalCreated: this.totalCreated,
      totalExpired: this.totalExpired,
      totalUsed: this.totalUsed,
      avgSessionLifeMs,
      byProvider,
      byCountry,
      byTier,
      costPerHour: Math.round(costPerHour * 100) / 100,
      poolUtilization: this.targetPoolSize > 0 ? sessions.length / this.targetPoolSize : 0,
      avgQualityScore: Math.round(avgQualityScore * 100) / 100,
      prewarmedCount,
      creationRate,
      countryDistributionSkew: Math.round(countrySkew * 100) / 100,
      metrics: { ...this.metrics, timeSeriesSnapshots: [...this.metrics.timeSeriesSnapshots] },
    };
  }

  /**
   * Predictive demand analysis.
   */
  predictDemand(): PredictionResult[] {
    const now = Date.now();
    const recentSignals = this.demandSignals.filter(s => now - s.timestamp < PREDICTION_WINDOW_MS);

    const domainMap = new Map<string, DemandSignal[]>();
    for (const signal of recentSignals) {
      const existing = domainMap.get(signal.domain) || [];
      existing.push(signal);
      domainMap.set(signal.domain, existing);
    }

    const predictions: PredictionResult[] = [];

    for (const [domain, signals] of domainMap) {
      const totalRequests = signals.reduce((sum, s) => sum + s.requestCount, 0);
      const timeSpanMs = now - Math.min(...signals.map((s) => s.timestamp));
      const requestsPerMinute = timeSpanMs > 0 ? (totalRequests / timeSpanMs) * 60_000 : 0;
      const predictedDemand = Math.ceil(requestsPerMinute * (PREDICTION_WINDOW_MS / 60_000));
      const suggestedSessions = Math.max(1, Math.ceil(predictedDemand / 10));
      const confidence = Math.min(1, signals.length / 20);

      predictions.push({
        domain,
        predictedDemand,
        suggestedSessions,
        confidence,
        tier: signals[0]?.tier,
        country: signals[0]?.country,
      });
    }

    return predictions.sort((a, b) => b.predictedDemand - a.predictedDemand);
  }

  // --- Private: Session Creation ---------------------------------------------

  /**
   * Create a single session with exponential backoff retry.
   * Retries are spaced using exponential backoff with jitter.
   */
  private async createSessionWithRetry(
    providerName: string,
    config: ProviderConfig,
    credentials: { username: string; password: string },
    options: {
      tier?: string;
      country?: string;
      domain?: string;
      sessionIndex: number;
      prewarm?: boolean;
      maxRetries: number;
    },
  ): Promise<WarmSession | null> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      // Apply exponential backoff delay for retries (not first attempt)
      if (attempt > 0) {
        const backoffDelay = computeExponentialBackoff(attempt - 1);
        this.metrics.totalBackoffDelays++;
        logger.debug(
          { provider: providerName, attempt, backoffMs: backoffDelay },
          'Retrying session creation with exponential backoff',
        );
        await sleep(backoffDelay);
      }

      // Check circuit breaker before each attempt
      if (!this.canAttemptProvider(providerName)) {
        logger.debug({ provider: providerName }, 'Circuit breaker open -- skipping creation attempt');
        return null;
      }

      try {
        const session = await this.createSession(providerName, config, credentials, {
          tier: options.tier,
          country: options.country,
          domain: options.domain,
          sessionIndex: options.sessionIndex,
          prewarm: options.prewarm,
        });

        if (session) {
          session.creationAttempt = attempt + 1;
          session.adaptiveBatch = true;
          session.providerCircuitState = this.getCircuitBreaker(providerName).state;
          if (lastError) {
            session.lastError = lastError;
          }
          return session;
        } else {
          lastError = 'creation_returned_null';
          this.metrics.totalRetries++;
        }
      } catch (err: any) {
        lastError = err.message;
        this.metrics.totalRetries++;
        logger.debug(
          { provider: providerName, attempt, error: err.message },
          'Session creation attempt failed',
        );
      }
    }

    return null;
  }

  /**
   * Create a single session (no retry logic -- use createSessionWithRetry for that).
   */
  private async createSession(
    providerName: string,
    config: ProviderConfig,
    credentials: { username: string; password: string },
    options: {
      tier?: string;
      country?: string;
      domain?: string;
      sessionIndex: number;
      prewarm?: boolean;
    },
  ): Promise<WarmSession | null> {
    try {
      const sessionId = crypto.randomUUID();
      const stickySuffix = config.supportsSticky ? `-session-${sessionId.substring(0, 8)}` : '';
      const countrySuffix = options.country && config.supportsCountry ? `-country-${options.country.toLowerCase()}` : '';

      const proxyUrl = this.buildProviderProxyUrl(providerName, config, credentials, stickySuffix, countrySuffix);
      const expiryMs = 10 * 60 * 1000 + Math.random() * 10 * 60 * 1000; // 10-20 min
      const now = Date.now();

      // Compute quality score based on provider, tier, and current demand
      const qualityScore = this.computeEnhancedQualityScore(
        providerName,
        options.tier || 'residential',
        options.country || 'US',
      );

      const session: WarmSession = {
        id: sessionId,
        proxyUrl,
        provider: providerName,
        tier: options.tier || 'residential',
        country: options.country?.toUpperCase() || 'US',
        city: undefined,
        costPerGb: config.costPerGb,
        createdAt: now,
        lastUsed: now,
        useCount: 0,
        successCount: 0,
        failureCount: 0,
        isHealthy: true,
        expiresAt: now + expiryMs,
        domain: options.domain,
        qualityScore,
        prewarmed: false,
        creationAttempt: 1,
        recycleCount: 0,
        affinityExpiresAt: 0,
        adaptiveBatch: false,
        providerCircuitState: CircuitState.CLOSED,
      };

      // Session pre-warming: validate before adding to pool
      if (options.prewarm) {
        this.metrics.totalPrewarmAttempts++;
        try {
          const result = await testProxy(proxyUrl, 'https://httpbin.org/ip', SESSION_PREWARM_VALIDATE_TIMEOUT);
          if (result.working) {
            session.prewarmed = true;
            session.latencyMs = result.latencyMs;
            session.qualityScore = Math.min(1.0, session.qualityScore + 0.1);

            // Track validation latency
            if (result.latencyMs !== undefined) {
              this.validationLatencySum += result.latencyMs;
              this.validationLatencyCount++;
              this.metrics.avgValidationLatencyMs = Math.round(
                this.validationLatencySum / this.validationLatencyCount,
              );
            }

            this.metrics.totalPrewarmSuccesses++;
          } else {
            // Pre-warm failed -- lower quality score but still add
            session.qualityScore = Math.max(0, session.qualityScore - 0.2);
            session.prewarmed = false;
            session.lastError = 'prewarm_validation_failed';

            // Reject if quality is too low
            if (session.qualityScore < QUALITY_SCORE_THRESHOLD) {
              this.metrics.totalQualityRejections++;
              return null;
            }
          }
        } catch (err: any) {
          session.qualityScore = Math.max(0, session.qualityScore - 0.2);
          session.prewarmed = false;
          session.lastError = `prewarm_error:${err.message?.substring(0, 100) || 'unknown'}`;

          if (session.qualityScore < QUALITY_SCORE_THRESHOLD) {
            this.metrics.totalQualityRejections++;
            return null;
          }
        }
      }

      return session;
    } catch (err: any) {
      logger.debug({ provider: providerName, error: err.message }, 'Failed to create session');
      return null;
    }
  }

  private buildProviderProxyUrl(
    providerName: string,
    config: ProviderConfig,
    credentials: { username: string; password: string },
    stickySuffix: string,
    countrySuffix: string,
  ): string {
    const { username, password } = credentials;

    switch (providerName) {
      case 'brightdata':
        return `http://${username}${stickySuffix}${countrySuffix}:${password}@${config.sessionEndpoint}:${config.defaultPort}`;
      case 'oxylabs':
        return `http://${username}${stickySuffix}${countrySuffix.replace('country', 'cc')}:${password}@${config.sessionEndpoint}:${config.defaultPort}`;
      case 'smartproxy':
        return `http://${username}${stickySuffix}${countrySuffix}:${password}@${config.sessionEndpoint}:${config.defaultPort}`;
      case 'iproyal':
        return `http://${username}${stickySuffix}${countrySuffix}:${password}@${config.sessionEndpoint}:${config.defaultPort}`;
      case 'webshare':
        return `http://${username}${stickySuffix}:${password}@${config.sessionEndpoint}:${config.defaultPort}`;
      default:
        return `http://${username}:${password}@${config.sessionEndpoint}:${config.defaultPort}`;
    }
  }

  private getAvailableProviders(preferredProvider?: string): string[] {
    const configured = Object.keys(this.providerCredentials);

    if (preferredProvider && configured.includes(preferredProvider)) {
      return [preferredProvider];
    }

    return configured.filter((name) => PROVIDER_CONFIGS[name] !== undefined);
  }

  /**
   * Get available providers, filtering out ones with open circuit breakers.
   * Includes half-open providers for probing.
   */
  private getAvailableProvidersWithCircuitCheck(preferredProvider?: string): string[] {
    let configured = this.getAvailableProviders(preferredProvider);

    // Filter out providers with open circuit breakers (half-open is allowed for probing)
    configured = configured.filter((provider) => {
      const breaker = this.circuitBreakers.get(provider);
      if (!breaker) return true;
      return breaker.state !== CircuitState.OPEN;
    });

    return configured;
  }

  private loadProviderCredentials(): void {
    const providerNames = Object.keys(PROVIDER_CONFIGS);

    for (const name of providerNames) {
      const envPrefix = `PROVIDER_${name.toUpperCase()}_`;
      const username = process.env[`${envPrefix}USERNAME`];
      const password = process.env[`${envPrefix}PASSWORD`];

      if (username && password) {
        this.providerCredentials[name] = { username, password };
        logger.debug({ provider: name }, 'Provider credentials loaded');
      }
    }

    logger.info(
      { configuredProviders: Object.keys(this.providerCredentials) },
      'Provider credentials loaded',
    );
  }

  // --- Private: Distribution & Prioritization -------------------------------

  /**
   * Compute smart provider distribution for balanced creation.
   * Takes into account: provider capacity, cost efficiency, circuit breaker
   * state, current success rate, and demand prioritization.
   */
  private computeSmartProviderDistribution(
    providers: string[],
    totalSessions: number,
    tier?: string,
    country?: string,
  ): Record<string, number> {
    const distribution: Record<string, number> = {};

    // Compute weights considering multiple factors
    const weights: Record<string, number> = {};
    let totalWeight = 0;

    for (const provider of providers) {
      const config = PROVIDER_CONFIGS[provider];
      if (!config) continue;

      // Factor 1: Capacity weight
      const capacityWeight = config.maxConcurrentSessions / 500;

      // Factor 2: Cost efficiency weight
      const costWeight = 1 / config.costPerGb;

      // Factor 3: Circuit breaker state weight
      const breaker = this.circuitBreakers.get(provider);
      let circuitWeight = 1.0;
      if (breaker) {
        if (breaker.state === CircuitState.HALF_OPEN) {
          circuitWeight = 0.3; // Reduced weight for half-open
        } else if (breaker.state === CircuitState.OPEN) {
          circuitWeight = 0; // Should not reach here, but safety
        }
      }

      // Factor 4: Provider success rate weight
      const health = this.providerHealthMap.get(provider);
      const successRateWeight = health ? Math.max(0.1, health.successRate) : 0.5;

      // Factor 5: Cost optimization -- prefer cheaper providers when quality allows
      let costOptimizationBoost = 1.0;
      if (health && health.successRate >= COST_OPTIMIZATION_THRESHOLD) {
        // Provider is reliable enough -- boost cheaper ones
        costOptimizationBoost = 1.0 + (1 / config.costPerGb) * 0.3;
        this.metrics.totalCostOptimizedCreations++;
      }

      // Combined weight
      weights[provider] = capacityWeight * costWeight * circuitWeight * successRateWeight * costOptimizationBoost;
      totalWeight += weights[provider];
    }

    // Distribute sessions proportionally
    let allocated = 0;
    for (const provider of providers) {
      const weight = weights[provider] || 1;
      const share = Math.round((weight / totalWeight) * totalSessions);
      distribution[provider] = share;
      allocated += share;
    }

    // Adjust for rounding
    const diff = totalSessions - allocated;
    if (diff !== 0 && providers.length > 0) {
      distribution[providers[0]] = (distribution[providers[0]] || 0) + diff;
    }

    return distribution;
  }

  /**
   * Select a country for distribution using demand priority.
   * High-demand countries get a probability boost.
   */
  private selectCountryWithDemandPriority(): string {
    // First check if there are high-demand countries that need more sessions
    const highDemandCountries = this.getHighDemandCountries();

    if (highDemandCountries.length > 0 && Math.random() < 0.4) {
      // 40% chance to pick a high-demand country
      const priority = highDemandCountries[Math.floor(Math.random() * highDemandCountries.length)];
      this.metrics.totalDemandPrioritizedCreations++;
      return priority;
    }

    // Default: use target distribution
    return this.selectCountryForDistribution();
  }

  /**
   * Select a tier for distribution using demand priority.
   */
  private selectTierWithDemandPriority(): string {
    // Check for high-demand tiers
    const highDemandTiers = this.getHighDemandTiers();

    if (highDemandTiers.length > 0 && Math.random() < 0.3) {
      // 30% chance to pick a high-demand tier
      const priority = highDemandTiers[Math.floor(Math.random() * highDemandTiers.length)];
      this.metrics.totalDemandPrioritizedCreations++;
      return priority;
    }

    // Default: use target distribution
    return this.selectTierForDistribution();
  }

  /**
   * Get countries with high demand (deficit > 0).
   */
  private getHighDemandCountries(): string[] {
    const countries: string[] = [];
    for (const [, priority] of this.demandPriorities) {
      if (priority.deficit > 0 && !countries.includes(priority.country)) {
        countries.push(priority.country);
      }
    }
    return countries;
  }

  /**
   * Get tiers with high demand (deficit > 0).
   */
  private getHighDemandTiers(): string[] {
    const tiers: string[] = [];
    for (const [, priority] of this.demandPriorities) {
      if (priority.deficit > 0 && !tiers.includes(priority.tier)) {
        tiers.push(priority.tier);
      }
    }
    return tiers;
  }

  /**
   * Select a country for distribution using target percentages.
   */
  private selectCountryForDistribution(): string {
    const countries = Object.entries(TARGET_COUNTRY_DISTRIBUTION);
    let random = Math.random();

    for (const [country, probability] of countries) {
      random -= probability;
      if (random <= 0) return country;
    }

    return 'US';
  }

  /**
   * Select a tier for distribution using target percentages.
   */
  private selectTierForDistribution(): string {
    const tiers = Object.entries(TARGET_TIER_DISTRIBUTION);
    let random = Math.random();

    for (const [tier, probability] of tiers) {
      random -= probability;
      if (random <= 0) return tier;
    }

    return 'residential';
  }

  /**
   * Compute enhanced quality score based on provider, tier, country, and demand.
   */
  private computeEnhancedQualityScore(provider: string, tier: string, country: string): number {
    const providerScores: Record<string, number> = {
      brightdata: 0.85,
      oxylabs: 0.83,
      smartproxy: 0.78,
      iproyal: 0.70,
      webshare: 0.65,
    };

    const tierScores: Record<string, number> = {
      residential: 0.85,
      mobile: 0.80,
      isp: 0.75,
      datacenter: 0.60,
    };

    // Country reliability scores (based on general proxy quality)
    const countryScores: Record<string, number> = {
      US: 0.90, GB: 0.88, DE: 0.87, FR: 0.85, NL: 0.86,
      JP: 0.84, CA: 0.87, AU: 0.83, SG: 0.82, KR: 0.81,
      BR: 0.72, IN: 0.68, IT: 0.80, ES: 0.79, MX: 0.70,
    };

    const providerScore = providerScores[provider] || 0.5;
    const tierScore = tierScores[tier] || 0.5;
    const countryScore = countryScores[country] || 0.7;

    // Base score is weighted average of all three factors
    let baseScore = (providerScore * 0.4) + (tierScore * 0.35) + (countryScore * 0.25);

    // Apply demand priority boost
    const demandPriority = this.getDemandPriorityScore(country, tier);
    if (demandPriority > 0) {
      baseScore += demandPriority * DEMAND_PRIORITY_BOOST_FACTOR;
    }

    return Math.min(1.0, Math.max(0, baseScore));
  }

  /**
   * Compute initial quality score based on provider and tier (backward compat).
   */
  private computeInitialQualityScore(provider: string, tier: string): number {
    return this.computeEnhancedQualityScore(provider, tier, 'US');
  }

  /**
   * Get demand priority score for a country/tier combination.
   * Returns 0-1 where higher values indicate more unmet demand.
   */
  private getDemandPriorityScore(country: string, tier: string): number {
    const key = `${country}:${tier}`;
    const priority = this.demandPriorities.get(key);
    if (!priority || priority.deficit <= 0) return 0;

    // Normalize: deficit of 10+ = max priority
    return Math.min(1.0, priority.deficit / 10);
  }

  /**
   * Compute country distribution skew.
   * Returns 0 for perfect distribution, higher values for more skew.
   */
  private computeCountryDistributionSkew(byCountry: Record<string, number>, total: number): number {
    if (total === 0) return 0;

    let totalDiff = 0;
    for (const [country, count] of Object.entries(byCountry)) {
      const actualShare = count / total;
      const targetShare = TARGET_COUNTRY_DISTRIBUTION[country] || 0.01;
      totalDiff += Math.abs(actualShare - targetShare);
    }

    return totalDiff / 2;
  }

  // --- Private: Circuit Breaker --------------------------------------------

  /**
   * Initialize circuit breakers for all known providers.
   */
  private initializeCircuitBreakers(): void {
    for (const providerName of Object.keys(PROVIDER_CONFIGS)) {
      this.circuitBreakers.set(providerName, {
        state: CircuitState.CLOSED,
        failureCount: 0,
        successCount: 0,
        lastFailureAt: 0,
        openedAt: 0,
        halfOpenRequests: 0,
        totalTrips: 0,
        consecutiveSuccesses: 0,
        lastStateChangeAt: Date.now(),
      });
    }
  }

  /**
   * Get the circuit breaker for a provider.
   */
  private getCircuitBreaker(provider: string): CircuitBreaker {
    let breaker = this.circuitBreakers.get(provider);
    if (!breaker) {
      breaker = {
        state: CircuitState.CLOSED,
        failureCount: 0,
        successCount: 0,
        lastFailureAt: 0,
        openedAt: 0,
        halfOpenRequests: 0,
        totalTrips: 0,
        consecutiveSuccesses: 0,
        lastStateChangeAt: Date.now(),
      };
      this.circuitBreakers.set(provider, breaker);
    }
    return breaker;
  }

  /**
   * Check if a provider is available for requests based on circuit breaker state.
   * CLOSED → always available
   * OPEN → not available (but check if it should transition to HALF_OPEN)
   * HALF_OPEN → available for limited probing
   */
  private canAttemptProvider(provider: string): boolean {
    const breaker = this.getCircuitBreaker(provider);
    const now = Date.now();

    switch (breaker.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if we should transition to HALF_OPEN
        if (now - breaker.openedAt >= CIRCUIT_BREAKER_OPEN_DURATION_MS) {
          breaker.state = CircuitState.HALF_OPEN;
          breaker.halfOpenRequests = 0;
          breaker.lastStateChangeAt = now;
          logger.info({ provider }, 'Circuit breaker transitioned to HALF_OPEN');
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        // Allow limited requests in half-open state
        return breaker.halfOpenRequests < CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS;

      default:
        return true;
    }
  }

  /**
   * Record the outcome of a provider request and update circuit breaker state.
   */
  private recordProviderOutcome(provider: string, success: boolean): void {
    const breaker = this.getCircuitBreaker(provider);
    const now = Date.now();

    if (success) {
      breaker.successCount++;
      breaker.consecutiveSuccesses++;
      breaker.failureCount = 0; // Reset failure count on success

      switch (breaker.state) {
        case CircuitState.HALF_OPEN:
          breaker.halfOpenRequests++;
          // If we get enough successes in half-open, close the circuit
          if (breaker.consecutiveSuccesses >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
            breaker.state = CircuitState.CLOSED;
            breaker.lastStateChangeAt = now;
            logger.info({ provider }, 'Circuit breaker CLOSED -- provider recovered');
          }
          break;

        case CircuitState.CLOSED:
          // All good, no state change needed
          break;
      }
    } else {
      breaker.failureCount++;
      breaker.lastFailureAt = now;
      breaker.consecutiveSuccesses = 0;

      switch (breaker.state) {
        case CircuitState.CLOSED:
          // Check if we should open the circuit
          if (breaker.failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
            breaker.state = CircuitState.OPEN;
            breaker.openedAt = now;
            breaker.lastStateChangeAt = now;
            breaker.totalTrips++;
            this.metrics.totalCircuitBreakerTrips++;
            logger.warn(
              { provider, failureCount: breaker.failureCount },
              'Circuit breaker OPENED -- provider failing',
            );
          }
          break;

        case CircuitState.HALF_OPEN:
          // Failure in half-open → back to open
          breaker.state = CircuitState.OPEN;
          breaker.openedAt = now;
          breaker.lastStateChangeAt = now;
          breaker.totalTrips++;
          this.metrics.totalCircuitBreakerTrips++;
          logger.warn({ provider }, 'Circuit breaker re-OPENED -- provider still failing');
          break;
      }
    }

    // Record outcome in provider health tracking
    this.recordProviderHealthOutcome(provider, success);
  }

  /**
   * Get the current circuit breaker states for all providers.
   */
  getCircuitBreakerStates(): Record<string, CircuitState> {
    const states: Record<string, CircuitState> = {};
    for (const [provider, breaker] of this.circuitBreakers) {
      states[provider] = breaker.state;
    }
    return states;
  }

  /**
   * Get detailed circuit breaker info for dashboard.
   */
  getCircuitBreakerDetails(): Record<string, {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    totalTrips: number;
    lastFailureAt: number;
    openedAt: number;
    consecutiveSuccesses: number;
    timeInCurrentStateMs: number;
  }> {
    const now = Date.now();
    const details: Record<string, {
      state: CircuitState;
      failureCount: number;
      successCount: number;
      totalTrips: number;
      lastFailureAt: number;
      openedAt: number;
      consecutiveSuccesses: number;
      timeInCurrentStateMs: number;
    }> = {};

    for (const [provider, breaker] of this.circuitBreakers) {
      details[provider] = {
        state: breaker.state,
        failureCount: breaker.failureCount,
        successCount: breaker.successCount,
        totalTrips: breaker.totalTrips,
        lastFailureAt: breaker.lastFailureAt,
        openedAt: breaker.openedAt,
        consecutiveSuccesses: breaker.consecutiveSuccesses,
        timeInCurrentStateMs: now - breaker.lastStateChangeAt,
      };
    }

    return details;
  }

  // --- Private: Provider Health Tracking ----------------------------------

  /**
   * Initialize provider health tracking.
   */
  private initializeProviderHealth(): void {
    for (const providerName of Object.keys(PROVIDER_CONFIGS)) {
      this.providerHealthMap.set(providerName, {
        provider: providerName,
        successRate: 0.5, // Start at 50% -- neutral
        avgLatencyMs: 0,
        activeSessions: 0,
        creationAttempts: 0,
        creationSuccesses: 0,
        lastSuccessAt: 0,
        adaptiveBatchSize: PARALLEL_CREATE_BATCH,
        recentOutcomes: [],
        costEfficiencyScore: 0.5,
      });
    }
  }

  /**
   * Record a provider health outcome for rolling success rate.
   */
  private recordProviderHealthOutcome(provider: string, success: boolean): void {
    const health = this.providerHealthMap.get(provider);
    if (!health) return;

    health.creationAttempts++;
    if (success) {
      health.creationSuccesses++;
      health.lastSuccessAt = Date.now();
    }

    // Rolling success rate using last 50 outcomes
    health.recentOutcomes.push(success);
    if (health.recentOutcomes.length > 50) {
      health.recentOutcomes.shift();
    }

    // Compute rolling success rate
    const successes = health.recentOutcomes.filter(o => o).length;
    health.successRate = successes / health.recentOutcomes.length;

    // Compute cost efficiency score
    const config = PROVIDER_CONFIGS[provider];
    if (config) {
      // Higher success rate and lower cost = higher efficiency
      health.costEfficiencyScore = health.successRate * (1 / config.costPerGb) * 10;
    }

    // Adjust adaptive batch size based on success rate
    health.adaptiveBatchSize = this.computeAdaptiveBatchSize(health.successRate, provider);
  }

  /**
   * Compute adaptive batch size for a provider based on its success rate.
   * Higher success rate → larger batches. Lower → smaller batches.
   */
  private computeAdaptiveBatchSize(successRate: number, provider: string): number {
    const config = PROVIDER_CONFIGS[provider];
    if (!config) return ADAPTIVE_BATCH_MIN;

    // Scale batch size based on success rate
    let batchSize: number;

    if (successRate >= 0.8) {
      batchSize = ADAPTIVE_BATCH_MAX; // Full speed for healthy providers
    } else if (successRate >= 0.6) {
      batchSize = Math.round(ADAPTIVE_BATCH_MIN + (ADAPTIVE_BATCH_MAX - ADAPTIVE_BATCH_MIN) * 0.5);
    } else if (successRate >= MIN_PROVIDER_SUCCESS_RATE) {
      batchSize = Math.round(ADAPTIVE_BATCH_MIN + (ADAPTIVE_BATCH_MAX - ADAPTIVE_BATCH_MIN) * 0.25);
    } else {
      batchSize = ADAPTIVE_BATCH_MIN; // Minimum batch for struggling providers
    }

    // Don't exceed provider's max concurrent sessions
    batchSize = Math.min(batchSize, config.maxConcurrentSessions);

    // Update metrics
    this.metrics.currentAdaptiveBatchSize = batchSize;

    return batchSize;
  }

  /**
   * Get the adaptive batch size for a provider.
   */
  private getAdaptiveBatchSize(provider: string): number {
    const health = this.providerHealthMap.get(provider);
    if (!health) return PARALLEL_CREATE_BATCH;
    return health.adaptiveBatchSize;
  }

  /**
   * Update provider health tracking (called periodically).
   */
  private updateProviderHealthTracking(): void {
    const now = Date.now();

    for (const [provider, health] of this.providerHealthMap) {
      // Count active sessions for this provider
      health.activeSessions = Array.from(this.warmPool.values())
        .filter(s => s.provider === provider && s.isHealthy)
        .length;

      // Compute average latency for this provider's sessions
      const providerSessions = Array.from(this.warmPool.values())
        .filter(s => s.provider === provider && s.latencyMs !== undefined);

      if (providerSessions.length > 0) {
        health.avgLatencyMs = Math.round(
          providerSessions.reduce((sum, s) => sum + (s.latencyMs || 0), 0) / providerSessions.length,
        );
      }

      // Decay old outcomes -- if no recent activity, gradually return to neutral
      if (now - health.lastSuccessAt > 60_000 && health.recentOutcomes.length > 0) {
        // Remove oldest outcome to gradually decay
        health.recentOutcomes.shift();
        const successes = health.recentOutcomes.filter(o => o).length;
        health.successRate = health.recentOutcomes.length > 0
          ? successes / health.recentOutcomes.length
          : 0.5; // Reset to neutral if no outcomes
      }
    }

    // Update demand priorities
    this.updateDemandPriorities();
  }

  // --- Private: Demand Priority -------------------------------------------

  /**
   * Update demand priorities based on demand signals and current pool state.
   */
  private updateDemandPriorities(): void {
    const now = Date.now();
    const recentSignals = this.demandSignals.filter(s => now - s.timestamp < PREDICTION_WINDOW_MS);

    // Aggregate demand by country:tier
    const demandMap = new Map<string, { country: string; tier: string; count: number; lastAt: number }>();

    for (const signal of recentSignals) {
      const key = `${signal.country || 'US'}:${signal.tier || 'residential'}`;
      const existing = demandMap.get(key);
      if (existing) {
        existing.count += signal.requestCount;
        existing.lastAt = Math.max(existing.lastAt, signal.timestamp);
      } else {
        demandMap.set(key, {
          country: signal.country || 'US',
          tier: signal.tier || 'residential',
          count: signal.requestCount,
          lastAt: signal.timestamp,
        });
      }
    }

    // Compute priorities
    for (const [key, demand] of demandMap) {
      const currentSupply = Array.from(this.warmPool.values()).filter(
        s => s.country === demand.country && s.tier === demand.tier && s.isHealthy,
      ).length;

      const deficit = Math.max(0, demand.count - currentSupply);
      const priority = deficit > 0 ? Math.min(1.0, deficit / 20) : 0;

      this.demandPriorities.set(key, {
        country: demand.country,
        tier: demand.tier,
        priority,
        demandCount: demand.count,
        lastDemandAt: demand.lastAt,
        currentSupply,
        deficit,
      });
    }

    // Remove stale priorities
    const staleKeys: string[] = [];
    for (const [key, priority] of this.demandPriorities) {
      if (now - priority.lastDemandAt > PREDICTION_WINDOW_MS) {
        staleKeys.push(key);
      }
    }
    for (const key of staleKeys) {
      this.demandPriorities.delete(key);
    }
  }

  // --- Private: Session Affinity ------------------------------------------

  /**
   * Find a session with domain affinity for the given tier/country.
   */
  private findSessionWithAffinity(tier?: string, country?: string): WarmSession | null {
    const now = Date.now();

    // Find the best affinity match
    for (const [key, affinity] of this.sessionAffinities) {
      if (affinity.expiresAt < now) continue;

      const session = this.warmPool.get(affinity.sessionId);
      if (!session) continue;
      if (!session.isHealthy) continue;
      if (session.expiresAt - now < SESSION_EXPIRY_BUFFER_MS) continue;
      if (tier && session.tier !== tier) continue;
      if (country && session.country !== country.toUpperCase()) continue;
      if (session.qualityScore < QUALITY_SCORE_THRESHOLD) continue;

      // Found an affinity match -- boost its hit count
      affinity.hitCount++;
      return session;
    }

    return null;
  }

  /**
   * Clean up expired session affinities.
   */
  private cleanExpiredAffinities(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, affinity] of this.sessionAffinities) {
      if (affinity.expiresAt < now) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.sessionAffinities.delete(key);
    }
  }

  // --- Private: Management Cycle ------------------------------------------

  private async runManagementCycle(): Promise<void> {
    this.metrics.lastManagementCycleAt = Date.now();

    // 1. Remove expired sessions
    await this.removeExpiredSessions();

    // 2. Check current utilization
    const utilization = this.warmPool.size / this.targetPoolSize;

    // 3. Replenish pool if below target
    if (this.warmPool.size < this.targetPoolSize) {
      const deficit = this.targetPoolSize - this.warmPool.size;
      const toCreate = Math.min(deficit, MAX_CONCURRENT_CREATIONS * 3);

      logger.debug({ deficit, toCreate }, 'Replenishing warm pool');
      await this.preCreateSessions(toCreate);
    }

    // 4. Auto-scale based on demand
    if (utilization > DEMAND_SCALE_UP_THRESHOLD) {
      const newSize = Math.min(this.targetPoolSize + SCALE_UP_INCREMENT, MAX_WARM_POOL_SIZE);
      if (newSize > this.targetPoolSize) {
        this.targetPoolSize = newSize;
        logger.info({ newSize }, 'Scaled up target pool size');
      }
    } else if (utilization < DEMAND_SCALE_DOWN_THRESHOLD) {
      const newSize = Math.max(this.targetPoolSize - SCALE_DOWN_INCREMENT, MIN_WARM_POOL_SIZE);
      if (newSize < this.targetPoolSize) {
        this.targetPoolSize = newSize;
        logger.info({ newSize }, 'Scaled down target pool size');
      }
    }

    // 5. Predictive warming
    await this.predictiveWarm();

    // 6. Validate unvalidated sessions in the pool (parallel)
    await this.validateUnvalidatedSessions();

    // 7. Persist state
    await this.persistState();
  }

  private async removeExpiredSessions(): Promise<number> {
    const now = Date.now();
    let removed = 0;

    const expiredIds: string[] = [];
    for (const [id, session] of this.warmPool) {
      if (session.expiresAt < now + SESSION_EXPIRY_BUFFER_MS || now - session.createdAt > MAX_SESSION_AGE_MS) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      const session = this.warmPool.get(id);
      if (session) this.totalSessionLifeMs += now - session.createdAt;
      this.warmPool.delete(id);
      this.totalExpired++;
      removed++;
    }

    return removed;
  }

  private async predictiveWarm(): Promise<void> {
    const predictions = this.predictDemand();

    for (const prediction of predictions) {
      if (prediction.confidence < 0.3) continue;

      const existingForDomain = Array.from(this.warmPool.values()).filter(
        (s) => s.domain === prediction.domain && s.isHealthy,
      ).length;

      const needed = prediction.suggestedSessions - existingForDomain;
      if (needed <= 0) continue;

      // Create more aggressively for high-confidence predictions
      const maxCreate = Math.min(needed, Math.ceil(prediction.confidence * 100));

      await this.preCreateSessions(maxCreate, {
        domain: prediction.domain,
        tier: prediction.tier,
        country: prediction.country,
      });
    }
  }

  /**
   * Validate sessions in the pool that haven't been pre-warmed yet.
   * Runs parallel validation for efficiency.
   */
  private async validateUnvalidatedSessions(): Promise<void> {
    const unvalidated = Array.from(this.warmPool.values())
      .filter(s => !s.prewarmed && s.isHealthy)
      .slice(0, 50); // Validate up to 50 per cycle

    if (unvalidated.length === 0) return;

    const result = await this.parallelValidateSessions(unvalidated, 25);

    logger.debug(
      { validated: result.validated, healthy: result.healthy, unhealthy: result.unhealthy },
      'Parallel validation completed',
    );
  }

  private recordDemandSignal(sessionId: string): void {
    const session = this.warmPool.get(sessionId);

    this.demandSignals.push({
      domain: session?.domain || 'unknown',
      requestCount: 1,
      timestamp: Date.now(),
      tier: session?.tier,
      country: session?.country,
    });

    const cutoff = Date.now() - 2 * PREDICTION_WINDOW_MS;
    this.demandSignals = this.demandSignals.filter((s) => s.timestamp > cutoff);

    if (this.demandSignals.length > 10_000) {
      this.demandSignals = this.demandSignals.slice(-5_000);
    }
  }

  // --- Private: Metrics & Dashboard ---------------------------------------

  /**
   * Collect a metrics snapshot for dashboard time-series display.
   */
  private collectMetricsSnapshot(): void {
    const now = Date.now();
    const sessions = Array.from(this.warmPool.values());
    const avgQuality = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + s.qualityScore, 0) / sessions.length
      : 0;

    const providerSuccessRates: Record<string, number> = {};
    for (const [provider, health] of this.providerHealthMap) {
      providerSuccessRates[provider] = Math.round(health.successRate * 100) / 100;
    }

    const snapshot: MetricsSnapshot = {
      timestamp: now,
      poolSize: sessions.length,
      healthyCount: sessions.filter(s => s.isHealthy).length,
      prewarmedCount: sessions.filter(s => s.prewarmed).length,
      creationRate: this.computeCreationRate(),
      avgQualityScore: Math.round(avgQuality * 100) / 100,
      circuitBreakerStates: this.getCircuitBreakerStates(),
      providerSuccessRates,
    };

    this.metrics.timeSeriesSnapshots.push(snapshot);

    // Trim old snapshots (keep last hour)
    const cutoff = now - METRICS_RETENTION_MS;
    this.metrics.timeSeriesSnapshots = this.metrics.timeSeriesSnapshots.filter(
      s => s.timestamp > cutoff,
    );

    // Limit to 500 snapshots max to prevent memory issues
    if (this.metrics.timeSeriesSnapshots.length > 500) {
      this.metrics.timeSeriesSnapshots = this.metrics.timeSeriesSnapshots.slice(-500);
    }
  }

  /**
   * Get dashboard data for monitoring UI.
   */
  getDashboardData(): {
    current: {
      poolSize: number;
      targetSize: number;
      healthySessions: number;
      prewarmedSessions: number;
      avgQualityScore: number;
      creationRate: number;
      costPerHour: number;
      recycledSessions: number;
      activeProviders: number;
      circuitBreakerStates: Record<string, CircuitState>;
    };
    timeSeries: MetricsSnapshot[];
    providerHealth: Record<string, ProviderHealth>;
    demandPriorities: DemandPriority[];
    circuitBreakerDetails: Record<string, {
      state: CircuitState;
      failureCount: number;
      successCount: number;
      totalTrips: number;
      lastFailureAt: number;
      openedAt: number;
      consecutiveSuccesses: number;
      timeInCurrentStateMs: number;
    }>;
    predictions: PredictionResult[];
  } {
    const sessions = Array.from(this.warmPool.values());
    const stats = this.getStats();

    const providerHealth: Record<string, ProviderHealth> = {};
    for (const [provider, health] of this.providerHealthMap) {
      providerHealth[provider] = { ...health, recentOutcomes: [...health.recentOutcomes] };
    }

    return {
      current: {
        poolSize: sessions.length,
        targetSize: this.targetPoolSize,
        healthySessions: sessions.filter(s => s.isHealthy).length,
        prewarmedSessions: sessions.filter(s => s.prewarmed).length,
        avgQualityScore: stats.avgQualityScore,
        creationRate: stats.creationRate,
        costPerHour: stats.costPerHour,
        recycledSessions: sessions.filter(s => s.recycleCount > 0).length,
        activeProviders: this.getAvailableProviders().length,
        circuitBreakerStates: this.getCircuitBreakerStates(),
      },
      timeSeries: [...this.metrics.timeSeriesSnapshots],
      providerHealth,
      demandPriorities: Array.from(this.demandPriorities.values()),
      circuitBreakerDetails: this.getCircuitBreakerDetails(),
      predictions: this.predictDemand(),
    };
  }

  // --- Private: Persistence ----------------------------------------------

  private async persistState(): Promise<void> {
    try {
      const state = {
        sessions: Array.from(this.warmPool.values()),
        targetPoolSize: this.targetPoolSize,
        totalCreated: this.totalCreated,
        totalExpired: this.totalExpired,
        totalUsed: this.totalUsed,
        metrics: {
          totalRecycled: this.metrics.totalRecycled,
          totalCircuitBreakerTrips: this.metrics.totalCircuitBreakerTrips,
          totalCostOptimizedCreations: this.metrics.totalCostOptimizedCreations,
          totalDemandPrioritizedCreations: this.metrics.totalDemandPrioritizedCreations,
          totalEmergencyReplenishments: this.metrics.totalEmergencyReplenishments,
        },
      };

      await cacheSet('bulk-sessions:state', state, 300);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to persist session state');
    }
  }

  async loadState(): Promise<boolean> {
    try {
      const state = await cacheGet<{
        sessions: WarmSession[];
        targetPoolSize: number;
        totalCreated: number;
        totalExpired: number;
        totalUsed: number;
        metrics?: {
          totalRecycled: number;
          totalCircuitBreakerTrips: number;
          totalCostOptimizedCreations: number;
          totalDemandPrioritizedCreations: number;
          totalEmergencyReplenishments: number;
        };
      }>('bulk-sessions:state');

      if (!state) return false;

      const now = Date.now();
      for (const session of state.sessions) {
        if (session.expiresAt > now && now - session.createdAt < MAX_SESSION_AGE_MS) {
          this.warmPool.set(session.id, session);
        }
      }

      this.targetPoolSize = state.targetPoolSize || DEFAULT_WARM_POOL_SIZE;
      this.totalCreated = state.totalCreated || 0;
      this.totalExpired = state.totalExpired || 0;
      this.totalUsed = state.totalUsed || 0;

      // Restore metrics if available
      if (state.metrics) {
        this.metrics.totalRecycled = state.metrics.totalRecycled || 0;
        this.metrics.totalCircuitBreakerTrips = state.metrics.totalCircuitBreakerTrips || 0;
        this.metrics.totalCostOptimizedCreations = state.metrics.totalCostOptimizedCreations || 0;
        this.metrics.totalDemandPrioritizedCreations = state.metrics.totalDemandPrioritizedCreations || 0;
        this.metrics.totalEmergencyReplenishments = state.metrics.totalEmergencyReplenishments || 0;
      }

      logger.info(
        { loadedSessions: this.warmPool.size, targetPoolSize: this.targetPoolSize },
        'Session state loaded from Redis',
      );

      return true;
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to load session state');
      return false;
    }
  }

  private sampleArray<T>(arr: T[], size: number): T[] {
    if (arr.length <= size) return arr;
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, size);
  }

  // --- Private: Rate Tracking ----------------------------------------------

  private trackCreationRate(): void {
    this.metrics.creationTimestamps.push(Date.now());

    const cutoff = Date.now() - 60_000;
    this.metrics.creationTimestamps = this.metrics.creationTimestamps.filter(t => t > cutoff);

    const rate = this.metrics.creationTimestamps.length;
    if (rate > this.metrics.peakCreationRate) {
      this.metrics.peakCreationRate = rate;
    }
  }

  private computeCreationRate(): number {
    const cutoff = Date.now() - 60_000;
    const recent = this.metrics.creationTimestamps.filter(t => t > cutoff);
    return recent.length; // sessions in last 60s
  }

  // --- Additional Public Methods --------------------------------------------

  setTargetPoolSize(size: number): void {
    this.targetPoolSize = Math.max(MIN_WARM_POOL_SIZE, Math.min(MAX_WARM_POOL_SIZE, size));
    logger.info({ targetPoolSize: this.targetPoolSize }, 'Target pool size updated');
  }

  getTargetPoolSize(): number {
    return this.targetPoolSize;
  }

  getSession(sessionId: string): WarmSession | null {
    return this.warmPool.get(sessionId) || null;
  }

  getAllSessions(): WarmSession[] {
    return Array.from(this.warmPool.values());
  }

  getSessionsByProvider(provider: string): WarmSession[] {
    return Array.from(this.warmPool.values()).filter((s) => s.provider === provider);
  }

  getSessionsByCountry(country: string): WarmSession[] {
    return Array.from(this.warmPool.values()).filter((s) => s.country === country.toUpperCase());
  }

  getSessionsByDomain(domain: string): WarmSession[] {
    return Array.from(this.warmPool.values()).filter((s) => s.domain === domain);
  }

  /**
   * Get sessions by quality score range.
   */
  getSessionsByQuality(minScore: number, maxScore: number = 1.0): WarmSession[] {
    return Array.from(this.warmPool.values()).filter(
      (s) => s.qualityScore >= minScore && s.qualityScore <= maxScore,
    );
  }

  /**
   * Get sessions that are recyclable (not yet at max recycle count).
   */
  getRecyclableSessions(): WarmSession[] {
    const now = Date.now();
    return Array.from(this.warmPool.values()).filter(
      (s) => s.recycleCount < SESSION_RECYCLE_MAX_USES
        && s.isHealthy
        && s.expiresAt - now > SESSION_EXPIRY_BUFFER_MS,
    );
  }

  removeSession(sessionId: string): boolean {
    const removed = this.warmPool.delete(sessionId);
    if (removed) this.totalExpired++;
    return removed;
  }

  clearAllSessions(): number {
    const count = this.warmPool.size;
    this.warmPool.clear();
    this.totalExpired += count;
    logger.info({ count }, 'All sessions cleared from warm pool');
    return count;
  }

  /**
   * Clear sessions for a specific provider.
   */
  clearProviderSessions(provider: string): number {
    let removed = 0;
    for (const [id, session] of this.warmPool) {
      if (session.provider === provider) {
        this.warmPool.delete(id);
        this.totalExpired++;
        removed++;
      }
    }
    logger.info({ provider, removed }, 'Provider sessions cleared');
    return removed;
  }

  getProviderUtilization(): Record<string, {
    total: number;
    healthy: number;
    prewarmed: number;
    recycled: number;
    maxConcurrent: number;
    utilizationPct: number;
    successRate: number;
    avgLatencyMs: number;
    adaptiveBatchSize: number;
    circuitBreakerState: CircuitState;
  }> {
    const result: Record<string, {
      total: number;
      healthy: number;
      prewarmed: number;
      recycled: number;
      maxConcurrent: number;
      utilizationPct: number;
      successRate: number;
      avgLatencyMs: number;
      adaptiveBatchSize: number;
      circuitBreakerState: CircuitState;
    }> = {};

    for (const [providerName, config] of Object.entries(PROVIDER_CONFIGS)) {
      const sessions = Array.from(this.warmPool.values()).filter((s) => s.provider === providerName);
      const healthy = sessions.filter((s) => s.isHealthy).length;
      const prewarmed = sessions.filter((s) => s.prewarmed).length;
      const recycled = sessions.filter((s) => s.recycleCount > 0).length;
      const health = this.providerHealthMap.get(providerName);
      const breaker = this.circuitBreakers.get(providerName);

      result[providerName] = {
        total: sessions.length,
        healthy,
        prewarmed,
        recycled,
        maxConcurrent: config.maxConcurrentSessions,
        utilizationPct: config.maxConcurrentSessions > 0
          ? Math.round((sessions.length / config.maxConcurrentSessions) * 100)
          : 0,
        successRate: health?.successRate || 0,
        avgLatencyMs: health?.avgLatencyMs || 0,
        adaptiveBatchSize: health?.adaptiveBatchSize || PARALLEL_CREATE_BATCH,
        circuitBreakerState: breaker?.state || CircuitState.CLOSED,
      };
    }

    return result;
  }

  getCostBreakdown(): Record<string, {
    sessions: number;
    costPerGb: number;
    estimatedCostPerHour: number;
    costEfficiencyScore: number;
  }> {
    const result: Record<string, {
      sessions: number;
      costPerGb: number;
      estimatedCostPerHour: number;
      costEfficiencyScore: number;
    }> = {};

    for (const [providerName, config] of Object.entries(PROVIDER_CONFIGS)) {
      const sessions = Array.from(this.warmPool.values()).filter(
        (s) => s.provider === providerName && s.isHealthy,
      );
      const health = this.providerHealthMap.get(providerName);

      result[providerName] = {
        sessions: sessions.length,
        costPerGb: config.costPerGb,
        estimatedCostPerHour: sessions.length * config.costPerGb * 0.5,
        costEfficiencyScore: health?.costEfficiencyScore || 0,
      };
    }

    return result;
  }

  async getHealthSummary(): Promise<{
    isRunning: boolean;
    warmPoolSize: number;
    targetPoolSize: number;
    healthySessions: number;
    prewarmedSessions: number;
    recycledSessions: number;
    activeProviders: number;
    costPerHour: number;
    avgQualityScore: number;
    creationRate: number;
    circuitBreakerStates: Record<string, CircuitState>;
    avgValidationLatencyMs: number;
  }> {
    const sessions = Array.from(this.warmPool.values());
    const avgQuality = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + s.qualityScore, 0) / sessions.length
      : 0;

    return {
      isRunning: this.isRunning,
      warmPoolSize: sessions.length,
      targetPoolSize: this.targetPoolSize,
      healthySessions: sessions.filter((s) => s.isHealthy).length,
      prewarmedSessions: sessions.filter((s) => s.prewarmed).length,
      recycledSessions: sessions.filter((s) => s.recycleCount > 0).length,
      activeProviders: this.getAvailableProviders().length,
      costPerHour: this.getStats().costPerHour,
      avgQualityScore: Math.round(avgQuality * 100) / 100,
      creationRate: this.computeCreationRate(),
      circuitBreakerStates: this.getCircuitBreakerStates(),
      avgValidationLatencyMs: this.metrics.avgValidationLatencyMs,
    };
  }

  isManagerRunning(): boolean {
    return this.isRunning;
  }

  addProviderCredentials(provider: string, username: string, password: string): void {
    if (!PROVIDER_CONFIGS[provider]) {
      logger.warn({ provider }, 'Unknown provider');
      return;
    }

    this.providerCredentials[provider] = { username, password };

    // Initialize circuit breaker and health tracking if new
    if (!this.circuitBreakers.has(provider)) {
      this.circuitBreakers.set(provider, {
        state: CircuitState.CLOSED,
        failureCount: 0,
        successCount: 0,
        lastFailureAt: 0,
        openedAt: 0,
        halfOpenRequests: 0,
        totalTrips: 0,
        consecutiveSuccesses: 0,
        lastStateChangeAt: Date.now(),
      });
    }

    if (!this.providerHealthMap.has(provider)) {
      this.providerHealthMap.set(provider, {
        provider,
        successRate: 0.5,
        avgLatencyMs: 0,
        activeSessions: 0,
        creationAttempts: 0,
        creationSuccesses: 0,
        lastSuccessAt: 0,
        adaptiveBatchSize: PARALLEL_CREATE_BATCH,
        recentOutcomes: [],
        costEfficiencyScore: 0.5,
      });
    }

    logger.info({ provider }, 'Provider credentials added');
  }

  removeProviderCredentials(provider: string): boolean {
    if (!this.providerCredentials[provider]) return false;

    delete this.providerCredentials[provider];

    // Clean up all sessions for this provider
    for (const [id, session] of this.warmPool) {
      if (session.provider === provider) {
        this.warmPool.delete(id);
        this.totalExpired++;
      }
    }

    // Trip the circuit breaker (will be reset if credentials are re-added)
    const breaker = this.circuitBreakers.get(provider);
    if (breaker) {
      breaker.state = CircuitState.OPEN;
      breaker.openedAt = Date.now();
    }

    logger.info({ provider }, 'Provider credentials removed');
    return true;
  }

  getConfiguredProviders(): string[] {
    return Object.keys(this.providerCredentials);
  }

  getDemandSignals(): DemandSignal[] {
    return [...this.demandSignals];
  }

  recordExternalDemand(domain: string, requestCount: number, tier?: string, country?: string): void {
    this.demandSignals.push({ domain, requestCount, timestamp: Date.now(), tier, country });
  }

  /**
   * Force-reset a circuit breaker for a provider (manual override).
   */
  resetCircuitBreaker(provider: string): boolean {
    const breaker = this.circuitBreakers.get(provider);
    if (!breaker) return false;

    breaker.state = CircuitState.CLOSED;
    breaker.failureCount = 0;
    breaker.consecutiveSuccesses = 0;
    breaker.lastStateChangeAt = Date.now();

    // Reset provider health
    const health = this.providerHealthMap.get(provider);
    if (health) {
      health.successRate = 0.5;
      health.recentOutcomes = [];
      health.adaptiveBatchSize = PARALLEL_CREATE_BATCH;
    }

    logger.info({ provider }, 'Circuit breaker manually reset');
    return true;
  }

  /**
   * Force-replenish the pool to a specific size immediately.
   */
  async forceReplenish(targetSize?: number): Promise<{ created: number; failed: number }> {
    const target = targetSize || this.targetPoolSize;
    const deficit = target - this.warmPool.size;
    if (deficit <= 0) return { created: 0, failed: 0 };

    logger.info({ target, deficit }, 'Force-replenishing pool');
    return this.preCreateSessions(deficit);
  }

  /**
   * Bulk validate all unvalidated sessions in the pool.
   */
  async validateAllSessions(): Promise<{ validated: number; healthy: number; unhealthy: number }> {
    const unvalidated = Array.from(this.warmPool.values()).filter(s => !s.prewarmed && s.isHealthy);
    if (unvalidated.length === 0) return { validated: 0, healthy: 0, unhealthy: 0 };

    logger.info({ count: unvalidated.length }, 'Starting bulk validation of all unvalidated sessions');
    return this.parallelValidateSessions(unvalidated, PARALLEL_VALIDATION_CONCURRENCY);
  }

  async importSessionsToDb(): Promise<number> {
    let imported = 0;

    const sessions = Array.from(this.warmPool.values());
    const results = await Promise.allSettled(
      sessions.map(async (session) => {
        await db.proxy.upsert({
          where: { id: session.id },
          update: {
            url: session.proxyUrl,
            retired: !session.isHealthy,
            country: session.country,
            provider: `session:${session.provider}`,
            lastChecked: new Date(),
          },
          create: {
            id: session.id,
            url: session.proxyUrl,
            tier: session.tier as any,
            country: session.country,
            provider: `session:${session.provider}`,
            successRate: session.useCount > 0 ? session.successCount / session.useCount : 0.5,
            p95Latency: session.latencyMs || 0,
            failures: session.failureCount,
            consecutiveFailures: session.failureCount > 3 ? session.failureCount : 0,
            retired: !session.isHealthy,
            sticky: true,
            lastUsed: new Date(),
            lastChecked: new Date(),
            addedAt: new Date(),
          },
        });

        return true;
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) imported++;
    }

    logger.info({ imported }, 'Sessions imported to database');
    return imported;
  }

  getMetrics(): BulkSessionMetrics {
    return { ...this.metrics, timeSeriesSnapshots: [...this.metrics.timeSeriesSnapshots] };
  }

  /**
   * Get the current demand priorities for monitoring.
   */
  getDemandPriorities(): DemandPriority[] {
    return Array.from(this.demandPriorities.values())
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get provider health summary.
   */
  getProviderHealthSummary(): Record<string, ProviderHealth> {
    const result: Record<string, ProviderHealth> = {};
    for (const [provider, health] of this.providerHealthMap) {
      result[provider] = { ...health, recentOutcomes: [...health.recentOutcomes] };
    }
    return result;
  }

  /**
   * Export session data for backup/migration.
   */
  exportSessionData(): {
    sessions: WarmSession[];
    metadata: {
      exportedAt: number;
      targetPoolSize: number;
      totalCreated: number;
      totalExpired: number;
      totalUsed: number;
      circuitBreakerStates: Record<string, CircuitState>;
    };
  } {
    return {
      sessions: Array.from(this.warmPool.values()),
      metadata: {
        exportedAt: Date.now(),
        targetPoolSize: this.targetPoolSize,
        totalCreated: this.totalCreated,
        totalExpired: this.totalExpired,
        totalUsed: this.totalUsed,
        circuitBreakerStates: this.getCircuitBreakerStates(),
      },
    };
  }

  /**
   * Import session data from a backup.
   */
  importSessionData(data: {
    sessions: WarmSession[];
    metadata?: {
      targetPoolSize?: number;
      totalCreated?: number;
      totalExpired?: number;
      totalUsed?: number;
    };
  }): number {
    const now = Date.now();
    let imported = 0;

    for (const session of data.sessions) {
      // Only import sessions that are still viable
      if (session.expiresAt > now && now - session.createdAt < MAX_SESSION_AGE_MS && session.isHealthy) {
        if (!this.warmPool.has(session.id)) {
          this.warmPool.set(session.id, session);
          imported++;
        }
      }
    }

    if (data.metadata) {
      if (data.metadata.targetPoolSize) {
        this.targetPoolSize = data.metadata.targetPoolSize;
      }
      if (data.metadata.totalCreated) {
        this.totalCreated += data.metadata.totalCreated;
      }
      if (data.metadata.totalExpired) {
        this.totalExpired += data.metadata.totalExpired;
      }
      if (data.metadata.totalUsed) {
        this.totalUsed += data.metadata.totalUsed;
      }
    }

    logger.info({ imported, totalPoolSize: this.warmPool.size }, 'Session data imported');
    return imported;
  }

  /**
   * Get a summary of session recycling statistics.
   */
  getRecyclingStats(): {
    totalRecycled: number;
    currentlyRecyclable: number;
    avgRecycleCount: number;
    maxRecycleCount: number;
    byProvider: Record<string, { recycled: number; avgCount: number }>;
  } {
    const sessions = Array.from(this.warmPool.values());
    const recycledSessions = sessions.filter(s => s.recycleCount > 0);
    const avgRecycleCount = recycledSessions.length > 0
      ? recycledSessions.reduce((sum, s) => sum + s.recycleCount, 0) / recycledSessions.length
      : 0;
    const maxRecycleCount = recycledSessions.length > 0
      ? Math.max(...recycledSessions.map(s => s.recycleCount))
      : 0;

    const byProvider: Record<string, { recycled: number; avgCount: number }> = {};
    for (const [provider] of Object.entries(PROVIDER_CONFIGS)) {
      const providerRecycled = sessions.filter(s => s.provider === provider && s.recycleCount > 0);
      byProvider[provider] = {
        recycled: providerRecycled.length,
        avgCount: providerRecycled.length > 0
          ? providerRecycled.reduce((sum, s) => sum + s.recycleCount, 0) / providerRecycled.length
          : 0,
      };
    }

    return {
      totalRecycled: this.metrics.totalRecycled,
      currentlyRecyclable: sessions.filter(s => s.recycleCount < SESSION_RECYCLE_MAX_USES && s.isHealthy).length,
      avgRecycleCount: Math.round(avgRecycleCount * 100) / 100,
      maxRecycleCount,
      byProvider,
    };
  }

  /**
   * Get adaptive batch size info for all providers.
   */
  getAdaptiveBatchInfo(): Record<string, {
    currentBatchSize: number;
    successRate: number;
    minBatch: number;
    maxBatch: number;
  }> {
    const result: Record<string, {
      currentBatchSize: number;
      successRate: number;
      minBatch: number;
      maxBatch: number;
    }> = {};

    for (const [provider, health] of this.providerHealthMap) {
      result[provider] = {
        currentBatchSize: health.adaptiveBatchSize,
        successRate: Math.round(health.successRate * 100) / 100,
        minBatch: ADAPTIVE_BATCH_MIN,
        maxBatch: ADAPTIVE_BATCH_MAX,
      };
    }

    return result;
  }
}

// --- Singleton ----------------------------------------------------------------

export const bulkSessionManager = new BulkSessionManager();
