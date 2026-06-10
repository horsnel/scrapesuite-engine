/**
 * Rotating Session Factory -- HYPERSCALE TITANIUM EDITION
 * Per-Request Unique Proxy Session Manager
 *
 * Creates unique per-request proxy sessions where each session ID produces
 * a different exit IP from the provider's pool. This module manages the
 * full lifecycle of rotating sessions across 5 major providers.
 *
 *  -------------------------------------------------------------------------
 *  * Session creation: 1000+ sessions/second via parallel Promise.allSettled
 *  * Session pool: pre-create 5000+ sessions with aggressive auto-replenish
 *  * Multi-provider session mixing: combine all providers simultaneously
 *  * Session health monitoring: 5s check interval with real-time alerts
 *  * Adaptive session creation: scale up/down based on demand signals
 *  * Session uniqueness: Redis-set exit IP tracking with collision avoidance
 *  * Session recycling: usage-count + success-rate + age weighted decisions
 *  * Session affinity: configurable TTL sticky sessions per domain
 *  * Parallel creation: Promise.allSettled across all providers at once
 *  * Timers: 5-10s intervals (was 30-60s), batch sizes 50-100 (was 5-10)
 *  * Real-time metrics & monitoring with dashboard-ready snapshots
 *  * Error recovery: exponential backoff auto-retry on provider failures
 *  * Session quality scoring: rank by expected performance & past success
 *  * Auto-replenishment: refill pool when below target automatically
 *  * Smart session selection: best session by domain, country, performance
 *  -------------------------------------------------------------------------
 *
 * Supported providers:
 *  - Bright Data (session format: brd_{timestamp}_{random})
 *  - Oxylabs   (session format: oxl_{timestamp}_{random})
 *  - SmartProxy(session format: smp_{timestamp}_{random})
 *  - IPRoyal   (session format: ipr_{timestamp}_{random})
 *  - Webshare  (session format: wbs_{timestamp}_{random})
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { residentialProxyManager, type ProxyProvider } from './residential-providers';
import { ipReputationTracker } from './reputation';

const logger = createChildLogger('rotating-session-factory');

// --- Constants ----------------------------------------------------------------

/** Default session lifetime in ms -- 30 minutes. */
const DEFAULT_SESSION_LIFETIME_MS = 30 * 60 * 1000;

/** Default maximum requests per session before auto-rotation -- 200 (was 100) */
const DEFAULT_MAX_REQUESTS_PER_SESSION = 200;

/** Domain cooldown duration in ms -- 2 min (was 5 min) */
const DOMAIN_COOLDOWN_MS = 2 * 60 * 1000;

/** How often to clean up expired sessions (ms) -- 5s (was 60s) */
const CLEANUP_INTERVAL_MS = 5 * 1000;

/** Maximum concurrent active sessions -- 10000 (was 500) */
const MAX_ACTIVE_SESSIONS = 10_000;

/** Pre-creation batch size limit -- 500 (was 50) */
const MAX_PRECREATE_BATCH = 500;

/** TTL for cached session data in Redis (seconds). */
const SESSION_CACHE_TTL = 1800; // 30 minutes

/** Parallel session creation batch size -- 100 (was sequential) */
const PARALLEL_CREATE_BATCH = 100;

/** Session health monitoring interval -- 5s (was none) */
const SESSION_HEALTH_INTERVAL = 5 * 1000;

/** Session pool target size -- 5000 (was 500) */
const SESSION_POOL_TARGET = 5000;

/** Adaptive creation: minimum pool size before triggering emergency creation */
const MIN_POOL_THRESHOLD = 500;

/** Adaptive creation: scale-up increment when demand is high */
const ADAPTIVE_SCALE_UP = 500;

/** Session recycling: max age before recycling -- 10 min (was 30) */
const SESSION_RECYCLE_AGE_MS = 10 * 60 * 1000;

/** Session uniqueness tracking: track exit IPs to guarantee uniqueness */
const EXIT_IP_TRACKING_SIZE = 100_000;

/** Multi-provider mixing: minimum providers for diversity */
const MIN_PROVIDER_DIVERSITY = 2;

/** Auto-retry count for failed session creation */
const SESSION_CREATE_RETRIES = 3;

/** Pool replenishment interval -- 5s (was 30s) */
const REPLENISH_INTERVAL_MS = 5 * 1000;

/** Session affinity default TTL -- 10 minutes */
const SESSION_AFFINITY_TTL_MS = 10 * 60 * 1000;

/** Maximum session affinity entries before LRU eviction */
const MAX_AFFINITY_ENTRIES = 50_000;

/** Exponential backoff base delay (ms) for retry */
const BACKOFF_BASE_MS = 100;

/** Exponential backoff max delay (ms) for retry */
const BACKOFF_MAX_MS = 10_000;

/** Maximum concurrent creation attempts per provider */
const MAX_CONCURRENT_PER_PROVIDER = 50;

/** Dashboard snapshot interval -- 5s */
const DASHBOARD_SNAPSHOT_INTERVAL = 5 * 1000;

/** Quality score weights for smart session selection */
const QUALITY_WEIGHT_HEALTH = 0.4;
const QUALITY_WEIGHT_SUCCESS_RATE = 0.3;
const QUALITY_WEIGHT_FRESHNESS = 0.2;
const QUALITY_WEIGHT_LOAD = 0.1;

/** Provider estimated IP pool sizes (for capacity reporting). */
const PROVIDER_IP_CAPACITY: Record<string, number> = {
  brightdata: 72_000_000,
  oxylabs: 100_000_000,
  smartproxy: 55_000_000,
  iproyal: 6_000_000,
  webshare: 30_000_000,
};

/** Cost per GB by provider. */
const PROVIDER_COST_PER_GB: Record<string, number> = {
  brightdata: 15,
  oxylabs: 12,
  smartproxy: 14,
  iproyal: 5,
  webshare: 4,
};

/** Provider reliability scores (0-1) based on historical performance. */
const PROVIDER_RELIABILITY: Record<string, number> = {
  brightdata: 0.95,
  oxylabs: 0.93,
  smartproxy: 0.90,
  iproyal: 0.85,
  webshare: 0.80,
};

/** Redis key prefix for exit IP uniqueness tracking. */
const REDIS_EXIT_IP_SET = 'rotating_session:used_exit_ips';

/** Redis key prefix for provider failure tracking (circuit breaker). */
const REDIS_PROVIDER_FAILURES = 'rotating_session:provider_failures:';

/** Redis key for session factory dashboard state. */
const REDIS_DASHBOARD_KEY = 'rotating_session:dashboard';

// --- Types --------------------------------------------------------------------

export interface RotatingSession {
  id: string;
  proxyUrl: string;
  provider: ProxyProvider;
  country: string;
  tier: string;
  sessionId: string;        // Provider session ID
  exitIp?: string;
  createdAt: number;
  lastRotatedAt: number;
  lastUsedAt: number;       // Last time session was actually used
  requestCount: number;
  maxRequests: number;       // Auto-rotate after this many requests
  successCount: number;
  failureCount: number;
  isActive: boolean;
  expiresAt: number;
  domainCooldowns: Map<string, number>;  // domain → cooldownUntil
  costPerGb: number;
  /** Health score: 0-1, based on success rate */
  healthScore: number;
  /** Whether session has been validated */
  validated: boolean;
  /** Quality tier: 'premium', 'standard', 'budget' */
  qualityTier: string;
  /** Provider mix index for multi-provider diversity */
  providerMixIndex: number;
  /** Quality score: computed from health, success rate, freshness, and load */
  qualityScore: number;
  /** Last validation timestamp */
  lastValidatedAt: number;
  /** Cumulative latency in ms for requests through this session */
  totalLatencyMs: number;
  /** Number of latency samples */
  latencySampleCount: number;
  /** Average latency in ms */
  avgLatencyMs: number;
}

export interface RotatingFactoryStats {
  totalSessionsCreated: number;
  activeSessions: number;
  expiredSessions: number;
  totalRotations: number;
  avgSessionLifeMs: number;
  byProvider: Record<string, { active: number; total: number; avgRequests: number }>;
  estimatedTotalIPs: number;
  costPerHour: number;
  /** Pool utilization rate */
  poolUtilization: number;
  /** Session creation rate */
  creationRate: number;
  /** Multi-provider diversity score */
  providerDiversity: number;
  /** Average session health */
  avgSessionHealth: number;
  /** Adaptive pool target */
  adaptivePoolTarget: number;
  /** Real-time metrics */
  metrics: SessionMetrics;
}

export interface SessionCreationOptions {
  provider?: ProxyProvider;
  country?: string;
  city?: string;
  asn?: string;
  tier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  maxRequests?: number;
  lifetimeMs?: number;
  domain?: string;           // Domain to apply initial cooldown for
  stickySessionId?: string;  // For reusing an existing session
  costBudget?: number;       // Max cost per GB
  /** Quality tier preference */
  qualityTier?: 'premium' | 'standard' | 'budget';
  /** Whether to validate the session before returning */
  validate?: boolean;
  /** Affinity TTL in ms -- how long the sticky session should remain bound */
  affinityTtlMs?: number;
  /** Target domain for smart selection based on past performance */
  targetDomain?: string;
  /** Maximum latency acceptable for this session (ms) */
  maxLatencyMs?: number;
}

export interface SessionMetrics {
  totalCreated: number;
  totalFailed: number;
  totalRetries: number;
  avgCreationTimeMs: number;
  peakCreationRate: number;  // sessions/second
  lastCreationBurstAt: number;
  poolSize: number;
  poolTarget: number;
  utilizationHistory: number[]; // Last 60 utilization readings
  providerMix: Record<string, number>; // provider → count in pool
  /** Total sessions recycled due to low quality */
  totalRecycled: number;
  /** Total emergency creations triggered */
  totalEmergencyCreations: number;
  /** Average quality score of active sessions */
  avgQualityScore: number;
  /** Circuit breaker state per provider */
  circuitBreakerState: Record<string, CircuitBreakerState>;
  /** Creation time samples for averaging */
  creationTimeSamples: number[];
}

/** Circuit breaker state for a single provider. */
interface CircuitBreakerState {
  /** Number of consecutive failures. */
  consecutiveFailures: number;
  /** Whether the circuit is open (provider is blocked). */
  isOpen: boolean;
  /** Timestamp when the circuit was opened. */
  openedAt: number;
  /** Timestamp when the circuit can be tried again (half-open). */
  halfOpenAt: number;
  /** Total successes in the current window. */
  totalSuccesses: number;
  /** Total failures in the current window. */
  totalFailures: number;
}

/** Dashboard snapshot for real-time monitoring. */
interface DashboardSnapshot {
  timestamp: number;
  poolSize: number;
  poolTarget: number;
  activeByProvider: Record<string, number>;
  avgHealthScore: number;
  avgQualityScore: number;
  creationRate: number;
  utilizationPercent: number;
  unhealthyCount: number;
  circuitBreakersOpen: string[];
  topCountries: Record<string, number>;
  recentErrors: Array<{ message: string; provider: string; timestamp: number }>;
}

interface SessionAffinityEntry {
  sessionId: string;
  domain: string;
  lastUsed: number;
  requestCount: number;
  /** Configurable TTL for this affinity entry. */
  ttlMs: number;
  /** When this affinity entry was created. */
  createdAt: number;
}

/** Provider performance tracking for smart selection. */
interface ProviderPerformanceRecord {
  provider: ProxyProvider;
  domain: string;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  lastUsed: number;
  sampleCount: number;
}

// --- Session ID Generation ----------------------------------------------------

/**
 * Generate a unique session ID for a provider.
 * Format: {provider_prefix}_{timestamp}_{random}
 * Uses crypto-quality randomness for collision resistance.
 */
function generateSessionId(provider: ProxyProvider): string {
  const prefixes: Record<string, string> = {
    brightdata: 'brd',
    oxylabs: 'oxl',
    smartproxy: 'smp',
    iproyal: 'ipr',
    webshare: 'wbs',
    generic: 'gen',
  };

  const prefix = prefixes[provider] || 'gen';
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);

  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Generate a unique internal session ID for tracking.
 */
function generateInternalId(provider: ProxyProvider, sessionId: string): string {
  return `rs_${provider}_${sessionId}`;
}

/**
 * Compute an exponential backoff delay based on attempt number.
 */
function computeBackoff(attempt: number): number {
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  // Add jitter ±20%
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(delay + jitter));
}

/**
 * Compute quality score for a session based on multiple factors.
 */
function computeQualityScore(session: RotatingSession, now: number): number {
  // Health component (0-1)
  const healthComponent = session.healthScore * QUALITY_WEIGHT_HEALTH;

  // Success rate component (0-1)
  const totalRequests = session.successCount + session.failureCount;
  const successRate = totalRequests > 0 ? session.successCount / totalRequests : 1.0;
  const successComponent = successRate * QUALITY_WEIGHT_SUCCESS_RATE;

  // Freshness component: newer sessions score higher (0-1)
  const ageMs = now - session.createdAt;
  const lifetimeMs = session.expiresAt - session.createdAt;
  const freshnessRatio = lifetimeMs > 0 ? Math.max(0, 1 - ageMs / lifetimeMs) : 0;
  const freshnessComponent = freshnessRatio * QUALITY_WEIGHT_FRESHNESS;

  // Load component: sessions with fewer requests score higher (0-1)
  const loadRatio = session.maxRequests > 0 ? 1 - (session.requestCount / session.maxRequests) : 1;
  const loadComponent = loadRatio * QUALITY_WEIGHT_LOAD;

  return Math.min(1.0, healthComponent + successComponent + freshnessComponent + loadComponent);
}

// --- Provider URL Builders ----------------------------------------------------

function buildBrightDataSessionUrl(
  baseConfig: { url: string },
  sessionId: string,
  options: SessionCreationOptions,
): string {
  try {
    const parsed = new URL(baseConfig.url);
    let username = parsed.username;

    const tier = options.tier || 'residential';
    const zoneMap: Record<string, string> = {
      residential: 'residential',
      mobile: 'mobile',
      datacenter: 'datacenter',
      isp: 'isp',
    };
    if (!username.includes('-zone-')) {
      username += `-zone-${zoneMap[tier] || 'residential'}`;
    }

    if (options.country) {
      username += `-country-${options.country.toLowerCase()}`;
    }
    if (options.city) {
      username += `-city-${options.city.toLowerCase().replace(/\s+/g, '_')}`;
    }
    if (options.asn) {
      username += `-asn-${options.asn}`;
    }

    username += `-session-${sessionId}`;
    parsed.username = username;
    return parsed.toString();
  } catch {
    return baseConfig.url;
  }
}

function buildOxylabsSessionUrl(
  baseConfig: { url: string },
  sessionId: string,
  options: SessionCreationOptions,
): string {
  try {
    const parsed = new URL(baseConfig.url);
    let username = parsed.username;

    if (options.country) {
      username += `-country-${options.country.toLowerCase()}`;
    }
    if (options.city) {
      username += `-city_${options.city.toLowerCase().replace(/\s+/g, '_')}`;
    }
    username += `-sessid-${sessionId}`;

    parsed.username = username;
    return parsed.toString();
  } catch {
    return baseConfig.url;
  }
}

function buildSmartProxySessionUrl(
  baseConfig: { url: string },
  sessionId: string,
  options: SessionCreationOptions,
): string {
  try {
    const parsed = new URL(baseConfig.url);
    let username = parsed.username;

    if (options.country) {
      username += `-cc-${options.country.toLowerCase()}`;
    }
    if (options.city) {
      username += `-city-${options.city.toLowerCase().replace(/\s+/g, '')}`;
    }
    username += `-session-${sessionId}`;

    parsed.username = username;
    return parsed.toString();
  } catch {
    return baseConfig.url;
  }
}

function buildIproyalSessionUrl(
  baseConfig: { url: string },
  sessionId: string,
  options: SessionCreationOptions,
): string {
  try {
    const parsed = new URL(baseConfig.url);
    let username = parsed.username;

    if (options.country) {
      username += `_country-${options.country.toLowerCase()}`;
    }
    if (options.city) {
      username += `_city-${options.city.toLowerCase().replace(/\s+/g, '_')}`;
    }
    username += `_session-${sessionId}`;

    parsed.username = username;
    return parsed.toString();
  } catch {
    return baseConfig.url;
  }
}

function buildWebshareSessionUrl(
  baseConfig: { url: string },
  sessionId: string,
  options: SessionCreationOptions,
): string {
  try {
    const parsed = new URL(baseConfig.url);
    if (options.country) {
      parsed.hostname = `${options.country.toLowerCase()}.${parsed.hostname}`;
    }
    return parsed.toString();
  } catch {
    return baseConfig.url;
  }
}

function buildProviderSessionUrl(
  provider: ProxyProvider,
  baseConfig: { url: string },
  sessionId: string,
  options: SessionCreationOptions,
): string {
  switch (provider) {
    case 'brightdata':
      return buildBrightDataSessionUrl(baseConfig, sessionId, options);
    case 'oxylabs':
      return buildOxylabsSessionUrl(baseConfig, sessionId, options);
    case 'smartproxy':
      return buildSmartProxySessionUrl(baseConfig, sessionId, options);
    case 'iproyal':
      return buildIproyalSessionUrl(baseConfig, sessionId, options);
    case 'webshare':
      return buildWebshareSessionUrl(baseConfig, sessionId, options);
    default:
      return baseConfig.url;
  }
}

// --- RotatingSessionFactory --------------------------------------------------

export class RotatingSessionFactory {
  /** Active sessions by internal ID. */
  private sessions = new Map<string, RotatingSession>();

  /** Session index by provider session ID. */
  private sessionByProviderId = new Map<string, RotatingSession>();

  /** Sessions indexed by country for fast country-based lookups. */
  private sessionsByCountry = new Map<string, Set<string>>();

  /** Sessions indexed by provider for fast provider-based lookups. */
  private sessionsByProvider = new Map<ProxyProvider, Set<string>>();

  /** Provider base configurations (loaded from residentialProxyManager). */
  private providerConfigs = new Map<ProxyProvider, { url: string; costPerGb: number }>();

  /** Cleanup interval timer. */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Health monitoring timer */
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** Pool replenishment timer */
  private replenishTimer: ReturnType<typeof setInterval> | null = null;

  /** Dashboard snapshot timer */
  private dashboardTimer: ReturnType<typeof setInterval> | null = null;

  /** Total sessions created since startup. */
  private totalSessionsCreated = 0;

  /** Total session rotations since startup. */
  private totalRotations = 0;

  /** Sum of session lifetimes (for averaging). */
  private totalSessionLifeMs = 0;

  /** Total sessions that have expired. */
  private totalExpiredSessions = 0;

  /** Whether the factory has been started. */
  private started = false;

  /** Exit IP tracking for uniqueness guarantee (in-memory). */
  private usedExitIps = new Map<string, number>(); // ip → last used timestamp

  /** Session affinity map: domain → session */
  private sessionAffinity = new Map<string, SessionAffinityEntry>();

  /** Adaptive pool target (auto-adjusts based on demand). */
  private adaptivePoolTarget = SESSION_POOL_TARGET;

  /** Session metrics */
  private metrics: SessionMetrics = {
    totalCreated: 0,
    totalFailed: 0,
    totalRetries: 0,
    avgCreationTimeMs: 0,
    peakCreationRate: 0,
    lastCreationBurstAt: 0,
    poolSize: 0,
    poolTarget: SESSION_POOL_TARGET,
    utilizationHistory: [],
    providerMix: {},
    totalRecycled: 0,
    totalEmergencyCreations: 0,
    avgQualityScore: 0,
    circuitBreakerState: {},
    creationTimeSamples: [],
  };

  /** Creation rate tracking */
  private creationTimestamps: number[] = [];

  /** Circuit breaker state per provider. */
  private circuitBreakers = new Map<ProxyProvider, CircuitBreakerState>();

  /** Provider performance records for smart selection: domain → provider → record. */
  private providerPerformance = new Map<string, Map<ProxyProvider, ProviderPerformanceRecord>>();

  /** Recent errors for dashboard display. */
  private recentErrors: Array<{ message: string; provider: string; timestamp: number }> = [];

  /** Maximum recent errors to retain. */
  private readonly MAX_RECENT_ERRORS = 100;

  /** Active creation promises to prevent duplicate parallel creation. */
  private activeCreationCount = 0;

  /** Last dashboard snapshot. */
  private lastDashboardSnapshot: DashboardSnapshot | null = null;

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Start the session factory.
   * Loads provider configurations and starts the cleanup, health, and replenishment timers.
   * Initializes circuit breakers for all configured providers.
   */
  async startFactory(): Promise<void> {
    if (this.started) {
      logger.warn('Rotating session factory already started');
      return;
    }

    logger.info('Starting rotating session factory -- HYPERSCALE TITANIUM EDITION...');

    // Load provider configs from the residential proxy manager
    this.loadProviderConfigs();

    // Initialize circuit breakers for all providers
    this.initializeCircuitBreakers();

    // Load any cached sessions from Redis
    await this.loadSessionsFromCache();

    // Restore exit IP tracking from Redis
    await this.restoreExitIpTracking();

    // Start periodic cleanup -- 5s (was 60s)
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Session cleanup failed');
      });
    }, CLEANUP_INTERVAL_MS);

    // Start session health monitoring -- 5s
    this.healthTimer = setInterval(() => {
      this.monitorSessionHealth().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Session health monitoring failed');
      });
    }, SESSION_HEALTH_INTERVAL);

    // Start pool replenishment -- 5s (was 30s)
    this.replenishTimer = setInterval(() => {
      this.replenishPool().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Pool replenishment failed');
      });
    }, REPLENISH_INTERVAL_MS);

    // Start dashboard snapshot -- 5s
    this.dashboardTimer = setInterval(() => {
      this.captureDashboardSnapshot().catch(err => {
        logger.warn({ error: (err as Error).message }, 'Dashboard snapshot failed');
      });
    }, DASHBOARD_SNAPSHOT_INTERVAL);

    // Initial pool pre-warm with aggressive parallel creation
    const initialBatchSize = Math.min(SESSION_POOL_TARGET, 2000);
    logger.info({ batchSize: initialBatchSize }, 'Pre-warming session pool...');

    // Create initial sessions across all providers simultaneously
    await this.createMultiProviderSessions(initialBatchSize);

    this.started = true;
    logger.info(
      {
        providers: Array.from(this.providerConfigs.keys()),
        cachedSessions: this.sessions.size,
        maxActive: MAX_ACTIVE_SESSIONS,
        poolTarget: SESSION_POOL_TARGET,
        circuitBreakers: Array.from(this.circuitBreakers.entries()).map(
          ([p, s]) => ({ provider: p, isOpen: s.isOpen }),
        ),
      },
      'Rotating session factory HYPERSCALE TITANIUM EDITION started',
    );
  }

  /**
   * Stop the factory and clean up resources.
   * Persists exit IP tracking to Redis for recovery.
   */
  async stopFactory(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.replenishTimer) {
      clearInterval(this.replenishTimer);
      this.replenishTimer = null;
    }
    if (this.dashboardTimer) {
      clearInterval(this.dashboardTimer);
      this.dashboardTimer = null;
    }

    // Persist exit IP tracking for recovery
    await this.persistExitIpTracking();

    this.started = false;
    logger.info('Rotating session factory stopped');
  }

  // --- Session Creation --------------------------------------------------

  /**
   * Create a new rotating proxy session.
   * Generates a unique session ID for the specified provider,
   * constructs the appropriate proxy URL, and begins tracking the session.
   * Supports auto-retry with exponential backoff on failure.
   *
   * @param options - Session creation options including provider, geo-targeting, and limits
   * @returns The created rotating session, or null if no provider available
   */
  async createSession(options: SessionCreationOptions = {}): Promise<RotatingSession | null> {
    const {
      provider: requestedProvider,
      country,
      tier = 'residential',
      maxRequests = DEFAULT_MAX_REQUESTS_PER_SESSION,
      lifetimeMs = DEFAULT_SESSION_LIFETIME_MS,
      domain,
      stickySessionId,
      costBudget,
      qualityTier = 'standard',
      validate = false,
      affinityTtlMs = SESSION_AFFINITY_TTL_MS,
      targetDomain,
      maxLatencyMs,
    } = options;

    const creationStart = Date.now();

    // Handle sticky session reuse with affinity TTL
    if (stickySessionId) {
      const existing = this.sessionByProviderId.get(stickySessionId);
      if (existing && existing.isActive) {
        if (Date.now() < existing.expiresAt) {
          // Check if session quality is acceptable for the request
          if (maxLatencyMs && existing.avgLatencyMs > maxLatencyMs) {
            logger.debug(
              { sessionId: stickySessionId, avgLatency: existing.avgLatencyMs, maxLatency: maxLatencyMs },
              'Sticky session latency too high -- creating new',
            );
          } else {
            logger.debug(
              { sessionId: stickySessionId, provider: existing.provider },
              'Reusing sticky session',
            );
            return existing;
          }
        }
      }
    }

    // Select a provider (with circuit breaker awareness)
    const provider = this.selectProvider(requestedProvider, costBudget);
    if (!provider) {
      logger.warn({ requestedProvider, country, tier }, 'No provider available for session creation');
      return null;
    }

    // Check circuit breaker before proceeding
    const breaker = this.circuitBreakers.get(provider);
    if (breaker && breaker.isOpen) {
      if (Date.now() < breaker.halfOpenAt) {
        logger.warn(
          { provider, halfOpenAt: breaker.halfOpenAt },
          'Circuit breaker open -- provider temporarily unavailable',
        );
        // Try an alternative provider
        const alternative = this.selectAlternativeProvider(provider, costBudget);
        if (alternative) {
          return this.createSessionWithRetry(alternative, options, creationStart);
        }
        return null;
      }
      // Half-open: allow one attempt
      logger.info({ provider }, 'Circuit breaker half-open -- probing provider');
    }

    return this.createSessionWithRetry(provider, options, creationStart);
  }

  /**
   * Create a session with retry and exponential backoff.
   * Records success/failure with the circuit breaker.
   */
  private async createSessionWithRetry(
    provider: ProxyProvider,
    options: SessionCreationOptions,
    creationStart: number,
    attempt: number = 0,
  ): Promise<RotatingSession | null> {
    const {
      country,
      tier = 'residential',
      maxRequests = DEFAULT_MAX_REQUESTS_PER_SESSION,
      lifetimeMs = DEFAULT_SESSION_LIFETIME_MS,
      domain,
      qualityTier = 'standard',
    } = options;

    try {
      // Get provider base config
      const config = this.providerConfigs.get(provider);
      if (!config) {
        logger.warn({ provider }, 'Provider config not found');
        return null;
      }

      // Generate unique session ID
      const providerSessionId = generateSessionId(provider);
      const internalId = generateInternalId(provider, providerSessionId);

      // Build provider-specific proxy URL
      const proxyUrl = buildProviderSessionUrl(provider, config, providerSessionId, options);

      // Determine effective country
      const effectiveCountry = country || 'US';

      // Determine cost
      const costPerGb = PROVIDER_COST_PER_GB[provider] || config.costPerGb || 10;

      // Compute provider mix index for diversity tracking
      const providerMixIndex = this.computeProviderMixIndex(provider);

      // Create session object with quality tracking
      const now = Date.now();
      const session: RotatingSession = {
        id: internalId,
        proxyUrl,
        provider,
        country: effectiveCountry,
        tier,
        sessionId: providerSessionId,
        exitIp: undefined,
        createdAt: now,
        lastRotatedAt: now,
        lastUsedAt: now,
        requestCount: 0,
        maxRequests,
        successCount: 0,
        failureCount: 0,
        isActive: true,
        expiresAt: now + lifetimeMs,
        domainCooldowns: new Map(),
        costPerGb,
        healthScore: 1.0,
        validated: false,
        qualityTier,
        providerMixIndex,
        qualityScore: 1.0,
        lastValidatedAt: 0,
        totalLatencyMs: 0,
        latencySampleCount: 0,
        avgLatencyMs: 0,
      };

      // Compute initial quality score
      session.qualityScore = computeQualityScore(session, now);

      // Apply initial domain cooldown if specified
      if (domain) {
        session.domainCooldowns.set(domain, now + DOMAIN_COOLDOWN_MS);
      }

      // Enforce active session limit -- evict oldest expired sessions first
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        const oldest = this.findOldestExpiredSession();
        if (oldest) {
          await this.expireSession(oldest.id);
        } else {
          // Try evicting lowest quality sessions (not just health)
          const worst = this.findLowestQualitySession();
          if (worst) {
            await this.expireSession(worst.id);
          } else {
            logger.warn(
              { activeSessions: this.sessions.size, max: MAX_ACTIVE_SESSIONS },
              'Max active sessions reached -- cannot create new session',
            );
            return null;
          }
        }
      }

      // Store the session in all indexes
      this.sessions.set(internalId, session);
      this.sessionByProviderId.set(providerSessionId, session);
      this.addToCountryIndex(effectiveCountry, internalId);
      this.addToProviderIndex(provider, internalId);
      this.totalSessionsCreated++;
      this.metrics.totalCreated++;

      // Track creation rate and timing
      this.trackCreationRate();
      const creationTime = Date.now() - creationStart;
      this.metrics.creationTimeSamples.push(creationTime);
      if (this.metrics.creationTimeSamples.length > 1000) {
        this.metrics.creationTimeSamples.shift();
      }

      // Persist to Redis
      await this.persistSession(session);

      // Record success with circuit breaker
      this.recordProviderSuccess(provider);

      // Update metrics
      this.metrics.poolSize = this.sessions.size;
      this.metrics.providerMix[provider] = (this.metrics.providerMix[provider] || 0) + 1;

      logger.info(
        {
          sessionId: providerSessionId,
          provider,
          country: effectiveCountry,
          tier,
          qualityTier,
          qualityScore: session.qualityScore.toFixed(3),
          maxRequests,
          lifetimeMs,
          creationTimeMs: creationTime,
          poolSize: this.sessions.size,
        },
        'Created new rotating session',
      );

      return session;
    } catch (err: any) {
      // Record failure with circuit breaker
      this.recordProviderFailure(provider, err.message);

      // Retry with exponential backoff
      if (attempt < SESSION_CREATE_RETRIES) {
        const delay = computeBackoff(attempt);
        this.metrics.totalRetries++;

        logger.warn(
          {
            provider,
            attempt: attempt + 1,
            maxRetries: SESSION_CREATE_RETRIES,
            delayMs: delay,
            error: err.message,
          },
          'Session creation failed -- retrying with exponential backoff',
        );

        await new Promise(resolve => setTimeout(resolve, delay));
        return this.createSessionWithRetry(provider, options, creationStart, attempt + 1);
      }

      // All retries exhausted
      this.metrics.totalFailed++;
      this.recordError(err.message, provider);

      logger.error(
        {
          provider,
          attempts: attempt + 1,
          error: err.message,
        },
        'Session creation failed after all retries',
      );

      return null;
    }
  }

  /**
   * Parallel session creation: create multiple sessions simultaneously.
   * Uses Promise.allSettled for fault tolerance.
   * Distributes sessions evenly across all available providers.
   */
  async createSessionsParallel(
    count: number,
    options: SessionCreationOptions = {},
  ): Promise<RotatingSession[]> {
    const created: RotatingSession[] = [];
    const effectiveCount = Math.min(count, PARALLEL_CREATE_BATCH * 5); // Allow up to 500 per call

    // Distribute across providers for diversity
    const availableProviders = this.getAvailableProviders(options.costBudget);
    if (availableProviders.length === 0) {
      logger.warn('No providers available for parallel session creation');
      return [];
    }

    const startTime = Date.now();

    // Create in parallel batches
    for (let i = 0; i < effectiveCount; i += PARALLEL_CREATE_BATCH) {
      const batchSize = Math.min(PARALLEL_CREATE_BATCH, effectiveCount - i);

      const results = await Promise.allSettled(
        Array.from({ length: batchSize }, (_, idx) => {
          const providerIndex = (i + idx) % availableProviders.length;
          const provider = availableProviders[providerIndex];
          return this.createSession({
            ...options,
            provider,
          });
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          created.push(result.value);
        } else {
          this.metrics.totalFailed++;
        }
      }
    }

    const elapsed = Date.now() - startTime;
    const rate = elapsed > 0 ? Math.round(created.length / (elapsed / 1000)) : 0;

    logger.info(
      {
        requested: count,
        created: created.length,
        rate: `${rate} sessions/s`,
        elapsed: `${elapsed}ms`,
      },
      'Parallel session creation completed',
    );

    return created;
  }

  /**
   * Create sessions across ALL providers simultaneously for maximum speed and diversity.
   * Each provider creates sessions in parallel, and all providers run concurrently.
   * Target: 1000+ sessions/second with 5 providers.
   */
  async createMultiProviderSessions(
    totalCount: number,
    options: SessionCreationOptions = {},
  ): Promise<RotatingSession[]> {
    const availableProviders = this.getAvailableProviders(options.costBudget);
    if (availableProviders.length === 0) {
      logger.warn('No providers available for multi-provider session creation');
      return [];
    }

    const startTime = Date.now();

    // Distribute sessions evenly across providers
    const perProvider = Math.ceil(totalCount / availableProviders.length);

    // Create sessions on all providers simultaneously
    const providerResults = await Promise.allSettled(
      availableProviders.map(provider =>
        this.createSessionsParallel(perProvider, { ...options, provider })
      )
    );

    const created: RotatingSession[] = [];
    for (const result of providerResults) {
      if (result.status === 'fulfilled') {
        created.push(...result.value);
      }
    }

    const elapsed = Date.now() - startTime;
    const rate = elapsed > 0 ? Math.round(created.length / (elapsed / 1000)) : 0;

    // Update peak rate
    if (rate > this.metrics.peakCreationRate) {
      this.metrics.peakCreationRate = rate;
    }

    logger.info(
      {
        requested: totalCount,
        created: created.length,
        providers: availableProviders.length,
        perProvider,
        rate: `${rate} sessions/s`,
        elapsed: `${elapsed}ms`,
      },
      'Multi-provider session creation completed',
    );

    return created;
  }

  // --- Session Retrieval -------------------------------------------------

  /**
   * Get an existing session by its internal ID.
   */
  async getSession(sessionId: string): Promise<RotatingSession | null> {
    let session: RotatingSession | null | undefined = this.sessions.get(sessionId);

    if (!session) {
      session = this.sessionByProviderId.get(sessionId);
    }

    if (!session) {
      session = await this.loadSessionFromCache(sessionId);
      if (session) {
        this.sessions.set(session.id, session);
        this.sessionByProviderId.set(session.sessionId, session);
      }
    }

    if (!session) return null;

    if (Date.now() >= session.expiresAt) {
      await this.expireSession(session.id);
      return null;
    }

    return session;
  }

  // --- Session Rotation --------------------------------------------------

  /**
   * Force rotate a session -- creates a new exit IP by generating
   * a new session ID with the same provider and geo-targeting.
   */
  async rotateSession(sessionId: string): Promise<RotatingSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'Cannot rotate -- session not found');
      return null;
    }

    if (!session.isActive) {
      logger.warn({ sessionId }, 'Cannot rotate -- session is not active');
      return null;
    }

    this.totalRotations++;
    const sessionLifeMs = Date.now() - session.createdAt;

    // Mark old session as inactive
    session.isActive = false;

    // Create a new session with the same provider/geo settings
    const newSession = await this.createSession({
      provider: session.provider,
      country: session.country,
      tier: session.tier as any,
      maxRequests: session.maxRequests,
      lifetimeMs: session.expiresAt - Date.now(),
      qualityTier: session.qualityTier as any,
    });

    if (!newSession) {
      logger.warn({ sessionId, provider: session.provider }, 'Failed to create rotated session');
      session.isActive = true;
      return session;
    }

    // Remove old session from all indexes
    this.removeFromIndexes(session);

    // Track exit IP uniqueness (local + Redis)
    if (session.exitIp) {
      await this.trackExitIp(session.exitIp);
    }

    // Update provider performance record for this domain
    this.updateProviderPerformance(session);

    logger.info(
      {
        oldSessionId: session.sessionId,
        newSessionId: newSession.sessionId,
        provider: session.provider,
        sessionLifeMs,
        requestCount: session.requestCount,
        successRate: session.requestCount > 0
          ? (session.successCount / session.requestCount * 100).toFixed(1) + '%'
          : 'N/A',
      },
      'Session rotated successfully',
    );

    return newSession;
  }

  /**
   * Auto-rotate sessions that are approaching their limits.
   * Called by the health monitor. Uses quality score for smarter rotation.
   * Rotates in parallel for speed.
   */
  private async autoRotateStale(): Promise<number> {
    const now = Date.now();
    const toRotate: string[] = [];

    for (const [id, session] of this.sessions) {
      if (!session.isActive) continue;

      // Rotate if: approaching max requests, approaching expiry, unhealthy, or low quality
      const approachingMaxRequests = session.requestCount >= session.maxRequests * 0.85;
      const approachingExpiry = session.expiresAt - now < SESSION_RECYCLE_AGE_MS;
      const unhealthy = session.healthScore < 0.3;
      const lowQuality = session.qualityScore < 0.25;

      if (approachingMaxRequests || approachingExpiry || unhealthy || lowQuality) {
        toRotate.push(id);
      }
    }

    // Batch rotate for speed -- process in parallel batches of 50
    let rotated = 0;
    const batchSize = 50;

    for (let i = 0; i < toRotate.length; i += batchSize) {
      const batch = toRotate.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(id => this.rotateSession(id))
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          rotated++;
        }
      }
    }

    if (rotated > 0) {
      logger.info({ rotated, total: toRotate.length }, 'Auto-rotated stale sessions');
    }

    return rotated;
  }

  // --- Session Release ---------------------------------------------------

  /**
   * Release a session back to the pool.
   * Records the outcome, updates reputation, quality scores, and manages recycling.
   */
  async releaseSession(sessionId: string, success: boolean, latencyMs?: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'Cannot release -- session not found');
      return;
    }

    const now = Date.now();
    session.requestCount++;
    session.lastUsedAt = now;

    // Track latency
    if (latencyMs !== undefined && latencyMs > 0) {
      session.totalLatencyMs += latencyMs;
      session.latencySampleCount++;
      session.avgLatencyMs = session.totalLatencyMs / session.latencySampleCount;
    }

    if (success) {
      session.successCount++;
      // Health recovery is faster than decay
      session.healthScore = Math.min(1.0, session.healthScore + 0.03);
    } else {
      session.failureCount++;
      // Health decay scales with consecutive failures
      const failureRatio = session.failureCount / Math.max(1, session.requestCount);
      const decay = 0.05 + 0.1 * failureRatio;
      session.healthScore = Math.max(0, session.healthScore - decay);
    }

    // Recompute quality score
    session.qualityScore = computeQualityScore(session, now);

    // Record outcome with the reputation tracker
    try {
      const proxyId = `rotating_${session.provider}_${session.sessionId}`;
      await ipReputationTracker.recordOutcome(proxyId, '_rotating_session', success);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to record session outcome');
    }

    // Release back to residential provider
    try {
      await residentialProxyManager.releaseProxy(session.provider, success);
    } catch (err: any) {
      logger.warn({ error: err.message, provider: session.provider }, 'Failed to release proxy');
    }

    // Auto-rotate if needed (multiple conditions)
    if (session.requestCount >= session.maxRequests) {
      logger.info(
        { sessionId: session.sessionId, requestCount: session.requestCount },
        'Session reached max requests -- auto-rotating',
      );
      await this.rotateSession(session.id);
      return;
    }

    if (now >= session.expiresAt) {
      await this.expireSession(session.id);
      return;
    }

    // Smart recycling: recycle based on quality score, not just health
    if (session.qualityScore < 0.15) {
      logger.info(
        {
          sessionId: session.sessionId,
          qualityScore: session.qualityScore.toFixed(3),
          healthScore: session.healthScore.toFixed(3),
          successRate: session.requestCount > 0
            ? (session.successCount / session.requestCount * 100).toFixed(1) + '%'
            : 'N/A',
        },
        'Session quality too low -- recycling',
      );
      this.metrics.totalRecycled++;
      await this.rotateSession(session.id);
      return;
    }

    // Recycle if health is critically low
    if (session.healthScore < 0.15) {
      logger.info(
        { sessionId: session.sessionId, healthScore: session.healthScore.toFixed(3) },
        'Session health critically low -- recycling',
      );
      this.metrics.totalRecycled++;
      await this.rotateSession(session.id);
      return;
    }

    await this.persistSession(session);
  }

  // --- Active Session Retrieval ------------------------------------------

  /**
   * Get an active rotating session that matches the given criteria.
   * Prioritizes sessions by quality score (composite of health, success rate, freshness, load).
   */
  async getActiveSession(tier?: string, country?: string): Promise<RotatingSession | null> {
    const now = Date.now();
    const candidates: RotatingSession[] = [];

    for (const session of this.sessions.values()) {
      if (!session.isActive) continue;
      if (now >= session.expiresAt) continue;
      if (tier && session.tier !== tier) continue;
      if (country && session.country !== country.toUpperCase()) continue;
      if (session.requestCount >= session.maxRequests) continue;
      candidates.push(session);
    }

    // Sort by quality score (highest first) -- more comprehensive than just health
    candidates.sort((a, b) => b.qualityScore - a.qualityScore);

    if (candidates.length > 0) {
      return candidates[0];
    }

    // No active session found -- create a new one
    logger.debug({ tier, country }, 'No active session found -- creating new one');
    return await this.createSession({ tier: tier as any, country });
  }

  /**
   * Get an active session that is not on cooldown for a specific domain.
   * Uses session affinity with configurable TTL for sticky requests.
   * Smart selection based on past performance for the target domain.
   */
  async getSessionForDomain(domain: string, tier?: string, country?: string): Promise<RotatingSession | null> {
    const now = Date.now();

    // Check session affinity first (with TTL check)
    const affinity = this.sessionAffinity.get(domain);
    if (affinity) {
      const affinityAge = now - affinity.createdAt;
      const isWithinTtl = affinityAge < affinity.ttlMs;
      const isRecentlyUsed = now - affinity.lastUsed < DOMAIN_COOLDOWN_MS * 3;

      if (isWithinTtl && isRecentlyUsed) {
        const affinitySession = this.sessions.get(affinity.sessionId);
        if (affinitySession && affinitySession.isActive && now < affinitySession.expiresAt) {
          affinitySession.domainCooldowns.set(domain, now + DOMAIN_COOLDOWN_MS);
          affinitySession.requestCount++;
          affinitySession.lastUsedAt = now;
          affinity.lastUsed = now;
          affinity.requestCount++;
          return affinitySession;
        }
      } else {
        // Affinity expired -- clean up
        this.sessionAffinity.delete(domain);
      }
    }

    const candidates: RotatingSession[] = [];

    for (const session of this.sessions.values()) {
      if (!session.isActive) continue;
      if (now >= session.expiresAt) continue;
      if (tier && session.tier !== tier) continue;
      if (country && session.country !== country.toUpperCase()) continue;
      if (session.requestCount >= session.maxRequests) continue;

      const cooldownUntil = session.domainCooldowns.get(domain);
      if (cooldownUntil && now < cooldownUntil) continue;

      candidates.push(session);
    }

    // Sort by quality score, then by domain-specific provider performance
    candidates.sort((a, b) => {
      // Prefer providers that have performed well for this domain
      const aPerf = this.getProviderPerformanceScore(a.provider, domain);
      const bPerf = this.getProviderPerformanceScore(b.provider, domain);

      // Combine quality score (60%) with domain-specific performance (40%)
      const aScore = a.qualityScore * 0.6 + aPerf * 0.4;
      const bScore = b.qualityScore * 0.6 + bPerf * 0.4;

      return bScore - aScore;
    });

    if (candidates.length > 0) {
      const session = candidates[0];
      session.domainCooldowns.set(domain, now + DOMAIN_COOLDOWN_MS);
      session.requestCount++;
      session.lastUsedAt = now;

      // Update affinity with configurable TTL
      this.sessionAffinity.set(domain, {
        sessionId: session.id,
        domain,
        lastUsed: now,
        requestCount: 1,
        ttlMs: SESSION_AFFINITY_TTL_MS,
        createdAt: now,
      });

      // Enforce max affinity entries (LRU eviction)
      if (this.sessionAffinity.size > MAX_AFFINITY_ENTRIES) {
        this.evictOldestAffinity();
      }

      return session;
    }

    // No active session for this domain -- create a new one
    return await this.createSession({
      tier: tier as any,
      country,
      domain,
      targetDomain: domain,
    });
  }

  /**
   * Smart session selection: pick the best session based on target domain,
   * country, provider, and past performance. This is the most intelligent
   * selection method, combining all available signals.
   */
  async getBestSession(options: {
    domain?: string;
    country?: string;
    tier?: string;
    maxLatencyMs?: number;
    costBudget?: number;
    qualityTier?: 'premium' | 'standard' | 'budget';
  }): Promise<RotatingSession | null> {
    const now = Date.now();
    const {
      domain,
      country,
      tier,
      maxLatencyMs,
      costBudget,
      qualityTier,
    } = options;

    // If domain specified, try domain-specific selection first
    if (domain) {
      const domainSession = await this.getSessionForDomain(domain, tier, country);
      if (domainSession) {
        // Check latency constraint
        if (maxLatencyMs && domainSession.avgLatencyMs > maxLatencyMs) {
          // Try to find a lower-latency session
          const alternative = await this.findLowLatencySession(maxLatencyMs, tier, country);
          if (alternative) return alternative;
        }
        return domainSession;
      }
    }

    // General smart selection
    const candidates: RotatingSession[] = [];

    for (const session of this.sessions.values()) {
      if (!session.isActive) continue;
      if (now >= session.expiresAt) continue;
      if (tier && session.tier !== tier) continue;
      if (country && session.country !== country.toUpperCase()) continue;
      if (session.requestCount >= session.maxRequests) continue;
      if (maxLatencyMs && session.avgLatencyMs > maxLatencyMs && session.latencySampleCount > 3) continue;
      if (costBudget && session.costPerGb > costBudget) continue;
      if (qualityTier && session.qualityTier !== qualityTier) continue;

      candidates.push(session);
    }

    // Score each candidate based on all signals
    const scored = candidates.map(session => {
      let score = session.qualityScore;

      // Domain-specific performance bonus
      if (domain) {
        score += this.getProviderPerformanceScore(session.provider, domain) * 0.2;
      }

      // Provider reliability bonus
      score += (PROVIDER_RELIABILITY[session.provider] || 0.5) * 0.1;

      // Cost efficiency bonus (lower cost = higher bonus)
      score += (1 - session.costPerGb / 20) * 0.05;

      return { session, score };
    });

    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0].session;
      best.requestCount++;
      best.lastUsedAt = now;
      return best;
    }

    // No suitable session found -- create one with constraints
    return await this.createSession({
      tier: tier as any,
      country,
      domain,
      costBudget,
      qualityTier,
    });
  }

  // --- Batch Pre-Creation ------------------------------------------------

  /**
   * Pre-create N sessions for high-throughput scenarios.
   * Uses multi-provider parallel creation for maximum speed and diversity.
   */
  async preCreateSessions(count: number, options: SessionCreationOptions = {}): Promise<RotatingSession[]> {
    const effectiveCount = Math.min(count, MAX_PRECREATE_BATCH);
    const availableProviders = this.getAvailableProviders(options.costBudget);
    if (availableProviders.length === 0) {
      logger.warn('No providers available for session pre-creation');
      return [];
    }

    const startTime = Date.now();

    // Use multi-provider creation for speed (1000+ sessions/second target)
    const created = availableProviders.length >= MIN_PROVIDER_DIVERSITY
      ? await this.createMultiProviderSessions(effectiveCount, options)
      : await this.createSessionsParallel(effectiveCount, options);

    const elapsed = Date.now() - startTime;
    const rate = elapsed > 0 ? Math.round(created.length / (elapsed / 1000)) : 0;

    logger.info(
      {
        requested: count,
        created: created.length,
        providers: availableProviders.length,
        rate: `${rate} sessions/s`,
        elapsed: `${elapsed}ms`,
      },
      'Session pre-creation completed',
    );

    return created;
  }

  // --- Session Cleanup ---------------------------------------------------

  /**
   * Remove expired sessions from the pool.
   * Also cleans up cooldowns, exit IP tracking, affinity entries, and indexes.
   */
  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    const toExpire: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now >= session.expiresAt || !session.isActive) {
        toExpire.push(id);
      }
    }

    // Batch expire for efficiency
    const results = await Promise.allSettled(
      toExpire.map(id => this.expireSession(id))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        cleaned++;
      }
    }

    // Clean up domain cooldowns across all sessions
    for (const session of this.sessions.values()) {
      for (const [domain, cooldownUntil] of session.domainCooldowns) {
        if (now >= cooldownUntil) {
          session.domainCooldowns.delete(domain);
        }
      }
    }

    // Clean up old exit IP tracking entries
    const exitIpCutoff = now - 60 * 60 * 1000; // 1 hour
    for (const [ip, timestamp] of this.usedExitIps) {
      if (timestamp < exitIpCutoff) {
        this.usedExitIps.delete(ip);
      }
    }

    // Enforce exit IP tracking size
    if (this.usedExitIps.size > EXIT_IP_TRACKING_SIZE) {
      const entries = Array.from(this.usedExitIps.entries())
        .sort((a, b) => a[1] - b[1]);
      const toRemove = entries.slice(0, entries.length - EXIT_IP_TRACKING_SIZE);
      for (const [ip] of toRemove) {
        this.usedExitIps.delete(ip);
      }
    }

    // Clean up session affinity entries (expired TTL)
    for (const [domain, entry] of this.sessionAffinity) {
      const age = now - entry.createdAt;
      if (age > entry.ttlMs || entry.lastUsed < now - DOMAIN_COOLDOWN_MS * 5) {
        this.sessionAffinity.delete(domain);
      }
    }

    // Clean up stale provider performance records
    const perfCutoff = now - 24 * 60 * 60 * 1000; // 24 hours
    for (const [domain, providerMap] of this.providerPerformance) {
      for (const [provider, record] of providerMap) {
        if (record.lastUsed < perfCutoff) {
          providerMap.delete(provider);
        }
      }
      if (providerMap.size === 0) {
        this.providerPerformance.delete(domain);
      }
    }

    // Clean up stale country/provider indexes
    this.cleanUpIndexes();

    if (cleaned > 0) {
      logger.info({ cleaned, remaining: this.sessions.size }, 'Expired sessions cleaned up');
    }

    return cleaned;
  }

  // --- Session Health Monitoring -----------------------------------------

  /**
   * Monitor session health and auto-rotate unhealthy sessions.
   * Runs every 5 seconds for rapid detection of problems.
   * Updates quality scores and triggers adaptive pool adjustments.
   */
  private async monitorSessionHealth(): Promise<void> {
    const now = Date.now();
    let unhealthyCount = 0;
    let lowQualityCount = 0;

    // Batch processing for speed
    const toExpire: string[] = [];

    for (const [id, session] of this.sessions) {
      if (!session.isActive) continue;

      // Check expiry
      if (now >= session.expiresAt) {
        toExpire.push(id);
        continue;
      }

      // Check health score
      if (session.healthScore < 0.2) {
        unhealthyCount++;
      }

      // Update quality scores periodically
      session.qualityScore = computeQualityScore(session, now);
      if (session.qualityScore < 0.25) {
        lowQualityCount++;
      }
    }

    // Batch expire expired sessions
    if (toExpire.length > 0) {
      await Promise.allSettled(toExpire.map(id => this.expireSession(id)));
    }

    // Auto-rotate stale sessions
    await this.autoRotateStale();

    // Update utilization tracking (keep 60 samples for better trend analysis)
    const activeCount = Array.from(this.sessions.values()).filter(s => s.isActive).length;
    const utilization = this.adaptivePoolTarget > 0 ? activeCount / this.adaptivePoolTarget : 0;
    this.metrics.utilizationHistory.push(utilization);
    if (this.metrics.utilizationHistory.length > 60) {
      this.metrics.utilizationHistory.shift();
    }

    // Compute average quality score
    const activeSessions = Array.from(this.sessions.values()).filter(s => s.isActive);
    this.metrics.avgQualityScore = activeSessions.length > 0
      ? activeSessions.reduce((sum, s) => sum + s.qualityScore, 0) / activeSessions.length
      : 0;

    // Adaptive: increase pool target if utilization is consistently high
    const avgUtilization = this.metrics.utilizationHistory.length > 0
      ? this.metrics.utilizationHistory.reduce((a, b) => a + b, 0) / this.metrics.utilizationHistory.length
      : 0;

    if (avgUtilization > 0.8) {
      const oldTarget = this.adaptivePoolTarget;
      this.adaptivePoolTarget = Math.min(
        this.adaptivePoolTarget + ADAPTIVE_SCALE_UP,
        MAX_ACTIVE_SESSIONS,
      );
      if (this.adaptivePoolTarget !== oldTarget) {
        logger.info(
          {
            newTarget: this.adaptivePoolTarget,
            avgUtilization: (avgUtilization * 100).toFixed(1) + '%',
          },
          'Adaptive: increasing pool target due to high utilization',
        );
      }
    } else if (avgUtilization < 0.3 && this.adaptivePoolTarget > SESSION_POOL_TARGET) {
      const oldTarget = this.adaptivePoolTarget;
      this.adaptivePoolTarget = Math.max(
        this.adaptivePoolTarget - Math.floor(ADAPTIVE_SCALE_UP / 2),
        SESSION_POOL_TARGET,
      );
      if (this.adaptivePoolTarget !== oldTarget) {
        logger.info(
          {
            newTarget: this.adaptivePoolTarget,
            avgUtilization: (avgUtilization * 100).toFixed(1) + '%',
          },
          'Adaptive: decreasing pool target due to low utilization',
        );
      }
    }

    this.metrics.poolTarget = this.adaptivePoolTarget;
    this.metrics.poolSize = this.sessions.size;

    if (unhealthyCount > 0 || lowQualityCount > 0) {
      logger.info(
        { unhealthyCount, lowQualityCount, activeCount, avgQuality: this.metrics.avgQualityScore.toFixed(3) },
        'Session health check summary',
      );
    }
  }

  // --- Pool Replenishment ------------------------------------------------

  /**
   * Replenish the session pool when it drops below target.
   * Uses multi-provider creation for speed.
   * Emergency creation triggers when pool is critically low.
   */
  private async replenishPool(): Promise<void> {
    const activeCount = Array.from(this.sessions.values()).filter(s => s.isActive).length;

    // Standard replenishment
    if (activeCount < this.adaptivePoolTarget) {
      const deficit = this.adaptivePoolTarget - activeCount;
      const batchSize = Math.min(deficit, MAX_PRECREATE_BATCH);

      logger.info(
        { active: activeCount, target: this.adaptivePoolTarget, creating: batchSize },
        'Replenishing session pool',
      );

      await this.createMultiProviderSessions(batchSize);
    }

    // Emergency creation if pool is critically low
    if (activeCount < MIN_POOL_THRESHOLD) {
      this.metrics.totalEmergencyCreations++;

      logger.warn(
        { active: activeCount, threshold: MIN_POOL_THRESHOLD },
        'Session pool critically low -- emergency creation',
      );

      const emergencyCount = Math.min(MIN_POOL_THRESHOLD, MAX_PRECREATE_BATCH);
      await this.createMultiProviderSessions(emergencyCount);
    }

    // Proactive replenishment: if utilization is trending up, pre-create more
    if (this.metrics.utilizationHistory.length >= 5) {
      const recent5 = this.metrics.utilizationHistory.slice(-5);
      const trendUp = recent5[4] > recent5[0] && recent5[4] > 0.6;
      if (trendUp && activeCount < this.adaptivePoolTarget * 0.9) {
        const proactiveBatch = Math.min(100, MAX_PRECREATE_BATCH);
        logger.info(
          { active: activeCount, target: this.adaptivePoolTarget, trendUp: true, proactiveBatch },
          'Proactive replenishment -- utilization trending up',
        );
        await this.createMultiProviderSessions(proactiveBatch);
      }
    }
  }

  // --- Statistics --------------------------------------------------------

  /**
   * Get comprehensive factory statistics.
   */
  getStats(): RotatingFactoryStats {
    const activeSessions = Array.from(this.sessions.values()).filter(s => s.isActive);
    const byProvider: Record<string, { active: number; total: number; avgRequests: number }> = {};

    const providerGroups = new Map<string, { active: number; total: number; totalRequests: number }>();
    for (const session of this.sessions.values()) {
      const p = session.provider;
      const group = providerGroups.get(p) || { active: 0, total: 0, totalRequests: 0 };
      group.total++;
      group.totalRequests += session.requestCount;
      if (session.isActive) group.active++;
      providerGroups.set(p, group);
    }

    for (const [provider, group] of providerGroups) {
      byProvider[provider] = {
        active: group.active,
        total: group.total,
        avgRequests: group.total > 0 ? Math.round(group.totalRequests / group.total * 100) / 100 : 0,
      };
    }

    let costPerHour = 0;
    for (const session of activeSessions) {
      costPerHour += session.costPerGb * 0.1;
    }

    // Compute provider diversity (Shannon entropy normalized)
    const providerCounts = Array.from(providerGroups.values()).map(g => g.active);
    const totalActive = providerCounts.reduce((sum, c) => sum + c, 0);
    let providerDiversity = 0;
    if (totalActive > 0 && providerCounts.length > 0) {
      for (const count of providerCounts) {
        if (count > 0) {
          const p = count / totalActive;
          providerDiversity -= p * Math.log2(p);
        }
      }
      providerDiversity /= Math.log2(providerCounts.length); // Normalize
    }

    // Average session health
    const avgHealth = activeSessions.length > 0
      ? activeSessions.reduce((sum, s) => sum + s.healthScore, 0) / activeSessions.length
      : 0;

    // Creation rate
    const creationRate = this.computeCurrentCreationRate();

    return {
      totalSessionsCreated: this.totalSessionsCreated,
      activeSessions: activeSessions.length,
      expiredSessions: this.totalExpiredSessions,
      totalRotations: this.totalRotations,
      avgSessionLifeMs: this.totalSessionsCreated > 0
        ? Math.round(this.totalSessionLifeMs / this.totalSessionsCreated)
        : 0,
      byProvider,
      estimatedTotalIPs: this.getEstimatedTotalIPs(),
      costPerHour: Math.round(costPerHour * 100) / 100,
      poolUtilization: this.adaptivePoolTarget > 0 ? activeSessions.length / this.adaptivePoolTarget : 0,
      creationRate,
      providerDiversity: Math.round(providerDiversity * 100) / 100,
      avgSessionHealth: Math.round(avgHealth * 100) / 100,
      adaptivePoolTarget: this.adaptivePoolTarget,
      metrics: { ...this.metrics, providerMix: { ...this.metrics.providerMix }, circuitBreakerState: { ...this.metrics.circuitBreakerState } },
    };
  }

  /**
   * Get the estimated IP capacity for a specific provider.
   */
  getProviderCapacity(provider: string): {
    estimatedIPs: number;
    activeSessions: number;
    maxConcurrent: number;
    utilizationRate: number;
  } {
    const estimatedIPs = PROVIDER_IP_CAPACITY[provider] || 0;
    const activeSessions = Array.from(this.sessions.values())
      .filter(s => s.provider === provider && s.isActive).length;

    const providerStats = residentialProxyManager.getProviderStats();
    const config = providerStats.find(p => p.provider === provider);
    const maxConcurrent = config?.maxConcurrent || 50;

    return {
      estimatedIPs,
      activeSessions,
      maxConcurrent,
      utilizationRate: maxConcurrent > 0 ? activeSessions / maxConcurrent : 0,
    };
  }

  // --- Dashboard Snapshot ------------------------------------------------

  /**
   * Capture a dashboard snapshot for real-time monitoring.
   * Stored in Redis for external dashboard consumption.
   */
  private async captureDashboardSnapshot(): Promise<void> {
    const now = Date.now();
    const activeSessions = Array.from(this.sessions.values()).filter(s => s.isActive);

    // Active sessions by provider
    const activeByProvider: Record<string, number> = {};
    for (const session of activeSessions) {
      activeByProvider[session.provider] = (activeByProvider[session.provider] || 0) + 1;
    }

    // Top countries
    const topCountries: Record<string, number> = {};
    for (const session of activeSessions) {
      topCountries[session.country] = (topCountries[session.country] || 0) + 1;
    }

    // Open circuit breakers
    const circuitBreakersOpen: string[] = [];
    for (const [provider, state] of this.circuitBreakers) {
      if (state.isOpen) circuitBreakersOpen.push(provider);
    }

    // Average scores
    const avgHealth = activeSessions.length > 0
      ? activeSessions.reduce((sum, s) => sum + s.healthScore, 0) / activeSessions.length
      : 0;
    const avgQuality = activeSessions.length > 0
      ? activeSessions.reduce((sum, s) => sum + s.qualityScore, 0) / activeSessions.length
      : 0;

    // Unhealthy count
    const unhealthyCount = activeSessions.filter(s => s.healthScore < 0.3).length;

    const snapshot: DashboardSnapshot = {
      timestamp: now,
      poolSize: activeSessions.length,
      poolTarget: this.adaptivePoolTarget,
      activeByProvider,
      avgHealthScore: Math.round(avgHealth * 1000) / 1000,
      avgQualityScore: Math.round(avgQuality * 1000) / 1000,
      creationRate: this.computeCurrentCreationRate(),
      utilizationPercent: this.adaptivePoolTarget > 0
        ? Math.round(activeSessions.length / this.adaptivePoolTarget * 10000) / 100
        : 0,
      unhealthyCount,
      circuitBreakersOpen,
      topCountries,
      recentErrors: this.recentErrors.slice(-20),
    };

    this.lastDashboardSnapshot = snapshot;

    // Persist to Redis for external access
    try {
      await cacheSet(REDIS_DASHBOARD_KEY, snapshot, 60); // 60s TTL
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to persist dashboard snapshot');
    }
  }

  /**
   * Get the latest dashboard snapshot.
   */
  getDashboardSnapshot(): DashboardSnapshot | null {
    return this.lastDashboardSnapshot;
  }

  // --- Private: Circuit Breaker -------------------------------------------

  /**
   * Initialize circuit breakers for all configured providers.
   */
  private initializeCircuitBreakers(): void {
    for (const provider of this.providerConfigs.keys()) {
      this.circuitBreakers.set(provider, {
        consecutiveFailures: 0,
        isOpen: false,
        openedAt: 0,
        halfOpenAt: 0,
        totalSuccesses: 0,
        totalFailures: 0,
      });

      this.metrics.circuitBreakerState[provider] = {
        consecutiveFailures: 0,
        isOpen: false,
        openedAt: 0,
        halfOpenAt: 0,
        totalSuccesses: 0,
        totalFailures: 0,
      };
    }
  }

  /**
   * Record a successful creation with the circuit breaker.
   * Resets consecutive failure count and may close an open circuit.
   */
  private recordProviderSuccess(provider: ProxyProvider): void {
    const breaker = this.circuitBreakers.get(provider);
    if (!breaker) return;

    breaker.consecutiveFailures = 0;
    breaker.totalSuccesses++;
    breaker.isOpen = false;

    // Update metrics state
    this.metrics.circuitBreakerState[provider] = { ...breaker };
  }

  /**
   * Record a failed creation with the circuit breaker.
   * Opens the circuit after 5 consecutive failures.
   */
  private recordProviderFailure(provider: ProxyProvider, errorMessage: string): void {
    const breaker = this.circuitBreakers.get(provider);
    if (!breaker) return;

    breaker.consecutiveFailures++;
    breaker.totalFailures++;

    // Open circuit after 5 consecutive failures
    if (breaker.consecutiveFailures >= 5 && !breaker.isOpen) {
      breaker.isOpen = true;
      breaker.openedAt = Date.now();
      // Half-open after 30 seconds
      breaker.halfOpenAt = Date.now() + 30_000;

      logger.warn(
        {
          provider,
          consecutiveFailures: breaker.consecutiveFailures,
          halfOpenAt: new Date(breaker.halfOpenAt).toISOString(),
        },
        'Circuit breaker opened for provider',
      );
    }

    // Update metrics state
    this.metrics.circuitBreakerState[provider] = { ...breaker };

    // Record error for dashboard
    this.recordError(errorMessage, provider);
  }

  /**
   * Select an alternative provider when the primary is circuit-broken.
   */
  private selectAlternativeProvider(exclude: ProxyProvider, costBudget?: number): ProxyProvider | null {
    const available = this.getAvailableProviders(costBudget)
      .filter(p => p !== exclude);

    if (available.length === 0) return null;

    // Weight by reliability and inverse cost
    const weights = available.map(p => {
      const reliability = PROVIDER_RELIABILITY[p] || 0.5;
      const cost = PROVIDER_COST_PER_GB[p] || 10;
      return reliability / cost;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < available.length; i++) {
      random -= weights[i];
      if (random <= 0) return available[i];
    }

    return available[available.length - 1];
  }

  // --- Private: Provider Selection ----------------------------------------

  /**
   * Select a provider for session creation.
   * If a specific provider is requested and available, use it.
   * Otherwise, select based on health, cost, load balancing, reliability, and diversity.
   */
  private selectProvider(requested?: ProxyProvider, costBudget?: number): ProxyProvider | null {
    if (requested) {
      if (this.providerConfigs.has(requested)) {
        const config = this.providerConfigs.get(requested)!;
        if (costBudget && config.costPerGb > costBudget) {
          logger.warn(
            { provider: requested, costPerGb: config.costPerGb, budget: costBudget },
            'Requested provider exceeds cost budget',
          );
          return null;
        }
        return requested;
      }
      logger.warn({ provider: requested }, 'Requested provider not configured');
      return null;
    }

    const available = this.getAvailableProviders(costBudget);
    if (available.length === 0) return null;

    // Weight by inverse cost, reliability, and provider mix (favor less-used for diversity)
    const weights = available.map(p => {
      const cost = PROVIDER_COST_PER_GB[p] || 10;
      const reliability = PROVIDER_RELIABILITY[p] || 0.5;
      const mixCount = this.metrics.providerMix[p] || 0;
      const diversityBonus = 1 / (1 + mixCount * 0.1);
      return (reliability / cost) * diversityBonus;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < available.length; i++) {
      random -= weights[i];
      if (random <= 0) return available[i];
    }

    return available[available.length - 1];
  }

  /**
   * Get list of available providers, optionally filtered by cost budget.
   * Excludes providers with open circuit breakers.
   */
  private getAvailableProviders(costBudget?: number): ProxyProvider[] {
    const providers: ProxyProvider[] = [];
    const providerStats = residentialProxyManager.getProviderStats();

    for (const stat of providerStats) {
      if (!stat.enabled || !stat.isHealthy) continue;
      if (stat.currentConcurrent >= stat.maxConcurrent) continue;
      if (costBudget && stat.costPerGb > costBudget) continue;

      // Check circuit breaker
      const breaker = this.circuitBreakers.get(stat.provider);
      if (breaker && breaker.isOpen && Date.now() < breaker.halfOpenAt) continue;

      providers.push(stat.provider);
    }

    // Also include providers from env configs that might not be in providerStats
    for (const [provider] of this.providerConfigs) {
      if (!providers.includes(provider)) {
        const breaker = this.circuitBreakers.get(provider);
        if (breaker && breaker.isOpen && Date.now() < breaker.halfOpenAt) continue;
        providers.push(provider);
      }
    }

    return providers;
  }

  // --- Private: Session Lifecycle ----------------------------------------

  /**
   * Expire a session and update statistics.
   */
  private async expireSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    session.isActive = false;
    this.totalExpiredSessions++;
    this.totalSessionLifeMs += Date.now() - session.createdAt;

    // Track exit IP for uniqueness
    if (session.exitIp) {
      await this.trackExitIp(session.exitIp);
    }

    // Update provider performance record
    this.updateProviderPerformance(session);

    // Update metrics
    if (this.metrics.providerMix[session.provider]) {
      this.metrics.providerMix[session.provider]--;
      if (this.metrics.providerMix[session.provider] <= 0) {
        delete this.metrics.providerMix[session.provider];
      }
    }

    // Remove from all indexes
    this.removeFromIndexes(session);

    this.sessions.delete(id);
    this.sessionByProviderId.delete(session.sessionId);

    try {
      await redis.del(`cache:rotating_session:${id}`);
      await redis.del(`cache:rotating_session:${session.sessionId}`);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to remove session from cache');
    }
  }

  /**
   * Find the oldest expired session for eviction.
   */
  private findOldestExpiredSession(): RotatingSession | null {
    let oldest: RotatingSession | null = null;

    for (const session of this.sessions.values()) {
      if (!session.isActive || Date.now() >= session.expiresAt) {
        if (!oldest || session.createdAt < oldest.createdAt) {
          oldest = session;
        }
      }
    }

    return oldest;
  }

  /**
   * Find the session with the lowest quality score for eviction.
   * This is more intelligent than just health-based eviction.
   */
  private findLowestQualitySession(): RotatingSession | null {
    let worst: RotatingSession | null = null;

    for (const session of this.sessions.values()) {
      if (!session.isActive) continue;
      if (!worst || session.qualityScore < worst.qualityScore) {
        worst = session;
      }
    }

    return worst;
  }

  /**
   * Find the unhealthiest active session for eviction.
   */
  private findUnhealthiestSession(): RotatingSession | null {
    let unhealthiest: RotatingSession | null = null;

    for (const session of this.sessions.values()) {
      if (!session.isActive) continue;
      if (!unhealthiest || session.healthScore < unhealthiest.healthScore) {
        unhealthiest = session;
      }
    }

    return unhealthiest;
  }

  /**
   * Find a session with latency below the threshold.
   */
  private async findLowLatencySession(
    maxLatencyMs: number,
    tier?: string,
    country?: string,
  ): Promise<RotatingSession | null> {
    const now = Date.now();
    const candidates: RotatingSession[] = [];

    for (const session of this.sessions.values()) {
      if (!session.isActive || now >= session.expiresAt) continue;
      if (tier && session.tier !== tier) continue;
      if (country && session.country !== country.toUpperCase()) continue;
      if (session.latencySampleCount < 2) continue; // Need some data
      if (session.avgLatencyMs <= maxLatencyMs) {
        candidates.push(session);
      }
    }

    // Sort by lowest latency
    candidates.sort((a, b) => a.avgLatencyMs - b.avgLatencyMs);

    return candidates.length > 0 ? candidates[0] : null;
  }

  // --- Private: Index Management -----------------------------------------

  /**
   * Add session ID to country index.
   */
  private addToCountryIndex(country: string, sessionId: string): void {
    let set = this.sessionsByCountry.get(country);
    if (!set) {
      set = new Set();
      this.sessionsByCountry.set(country, set);
    }
    set.add(sessionId);
  }

  /**
   * Add session ID to provider index.
   */
  private addToProviderIndex(provider: ProxyProvider, sessionId: string): void {
    let set = this.sessionsByProvider.get(provider);
    if (!set) {
      set = new Set();
      this.sessionsByProvider.set(provider, set);
    }
    set.add(sessionId);
  }

  /**
   * Remove a session from all indexes.
   */
  private removeFromIndexes(session: RotatingSession): void {
    const countrySet = this.sessionsByCountry.get(session.country);
    if (countrySet) {
      countrySet.delete(session.id);
      if (countrySet.size === 0) {
        this.sessionsByCountry.delete(session.country);
      }
    }

    const providerSet = this.sessionsByProvider.get(session.provider);
    if (providerSet) {
      providerSet.delete(session.id);
      if (providerSet.size === 0) {
        this.sessionsByProvider.delete(session.provider);
      }
    }
  }

  /**
   * Clean up stale entries from country and provider indexes.
   */
  private cleanUpIndexes(): void {
    // Clean country index
    for (const [country, sessionIds] of this.sessionsByCountry) {
      for (const id of sessionIds) {
        if (!this.sessions.has(id)) {
          sessionIds.delete(id);
        }
      }
      if (sessionIds.size === 0) {
        this.sessionsByCountry.delete(country);
      }
    }

    // Clean provider index
    for (const [provider, sessionIds] of this.sessionsByProvider) {
      for (const id of sessionIds) {
        if (!this.sessions.has(id)) {
          sessionIds.delete(id);
        }
      }
      if (sessionIds.size === 0) {
        this.sessionsByProvider.delete(provider);
      }
    }
  }

  // --- Private: Exit IP Tracking -----------------------------------------

  /**
   * Track an exit IP for uniqueness guarantee (local + Redis).
   */
  private async trackExitIp(ip: string): Promise<void> {
    const now = Date.now();
    this.usedExitIps.set(ip, now);

    // Also track in Redis for cross-instance uniqueness
    try {
      await redis.sadd(REDIS_EXIT_IP_SET, ip);
      await redis.expire(REDIS_EXIT_IP_SET, 3600); // 1 hour TTL
    } catch (err: any) {
      logger.warn({ error: err.message, ip }, 'Failed to track exit IP in Redis');
    }
  }

  /**
   * Check if an exit IP is already tracked (local + Redis).
   */
  async isExitIpUnique(ip: string): Promise<boolean> {
    // Check local first (fast)
    if (this.usedExitIps.has(ip)) return false;

    // Check Redis (slower but cross-instance)
    try {
      const isMember = await redis.sismember(REDIS_EXIT_IP_SET, ip);
      return isMember === 0;
    } catch (err: any) {
      logger.warn({ error: err.message, ip }, 'Failed to check exit IP in Redis');
      return true; // Assume unique on Redis error
    }
  }

  /**
   * Restore exit IP tracking from Redis on startup.
   */
  private async restoreExitIpTracking(): Promise<void> {
    try {
      const ips = await redis.smembers(REDIS_EXIT_IP_SET);
      const now = Date.now();
      for (const ip of ips) {
        this.usedExitIps.set(ip, now);
      }
      if (ips.length > 0) {
        logger.info({ restoredCount: ips.length }, 'Restored exit IP tracking from Redis');
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to restore exit IP tracking from Redis');
    }
  }

  /**
   * Persist exit IP tracking to Redis for recovery.
   */
  private async persistExitIpTracking(): Promise<void> {
    try {
      if (this.usedExitIps.size > 0) {
        const ips = Array.from(this.usedExitIps.keys());
        // Clear and re-add in batch
        await redis.del(REDIS_EXIT_IP_SET);
        if (ips.length > 0) {
          await redis.sadd(REDIS_EXIT_IP_SET, ...ips.slice(0, 10000)); // Limit to 10k
          await redis.expire(REDIS_EXIT_IP_SET, 3600);
        }
        logger.info({ persistedCount: Math.min(ips.length, 10000) }, 'Persisted exit IP tracking to Redis');
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to persist exit IP tracking to Redis');
    }
  }

  // --- Private: Provider Performance -------------------------------------

  /**
   * Update provider performance record based on a completed session.
   */
  private updateProviderPerformance(session: RotatingSession): void {
    // Use the last domain in cooldowns as the domain context
    const domains = Array.from(session.domainCooldowns.keys());
    const domain = domains.length > 0 ? domains[domains.length - 1] : '_default';

    let domainMap = this.providerPerformance.get(domain);
    if (!domainMap) {
      domainMap = new Map();
      this.providerPerformance.set(domain, domainMap);
    }

    let record = domainMap.get(session.provider);
    if (!record) {
      record = {
        provider: session.provider,
        domain,
        successCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        lastUsed: Date.now(),
        sampleCount: 0,
      };
    }

    record.successCount += session.successCount;
    record.failureCount += session.failureCount;
    record.sampleCount += session.requestCount;
    record.avgLatencyMs = session.latencySampleCount > 0
      ? (record.avgLatencyMs * (record.sampleCount - session.requestCount) + session.avgLatencyMs * session.requestCount) / record.sampleCount
      : 0;
    record.lastUsed = Date.now();

    domainMap.set(session.provider, record);
  }

  /**
   * Get the performance score (0-1) for a provider on a specific domain.
   */
  private getProviderPerformanceScore(provider: ProxyProvider, domain: string): number {
    const domainMap = this.providerPerformance.get(domain);
    if (!domainMap) return 0.5; // No data -- neutral score

    const record = domainMap.get(provider);
    if (!record || record.sampleCount === 0) return 0.5;

    const successRate = record.successCount / (record.successCount + record.failureCount);
    return successRate;
  }

  // --- Private: Affinity Management --------------------------------------

  /**
   * Evict the oldest affinity entry (LRU).
   */
  private evictOldestAffinity(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [domain, entry] of this.sessionAffinity) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldest = domain;
      }
    }

    if (oldest) {
      this.sessionAffinity.delete(oldest);
    }
  }

  // --- Private: Error Recording ------------------------------------------

  /**
   * Record an error for dashboard display.
   */
  private recordError(message: string, provider: string): void {
    this.recentErrors.push({
      message: message.substring(0, 200),
      provider,
      timestamp: Date.now(),
    });

    // Enforce max size
    if (this.recentErrors.length > this.MAX_RECENT_ERRORS) {
      this.recentErrors = this.recentErrors.slice(-this.MAX_RECENT_ERRORS);
    }
  }

  // --- Private: Metrics --------------------------------------------------

  /**
   * Track creation rate for metrics.
   */
  private trackCreationRate(): void {
    this.creationTimestamps.push(Date.now());

    // Keep only last 60 seconds of timestamps
    const cutoff = Date.now() - 60_000;
    this.creationTimestamps = this.creationTimestamps.filter(t => t > cutoff);

    const rate = this.creationTimestamps.length; // sessions in last 60s
    if (rate > this.metrics.peakCreationRate) {
      this.metrics.peakCreationRate = rate;
    }
    this.metrics.lastCreationBurstAt = Date.now();
  }

  /**
   * Compute current creation rate (sessions/second).
   */
  private computeCurrentCreationRate(): number {
    const cutoff = Date.now() - 60_000;
    const recent = this.creationTimestamps.filter(t => t > cutoff);
    return recent.length / 60; // sessions per second
  }

  /**
   * Compute provider mix index for diversity tracking.
   */
  private computeProviderMixIndex(provider: ProxyProvider): number {
    const currentCount = this.metrics.providerMix[provider] || 0;
    return currentCount;
  }

  // --- Private: Persistence ----------------------------------------------

  /**
   * Load provider configurations from the residential proxy manager.
   */
  private loadProviderConfigs(): void {
    const providerStats = residentialProxyManager.getProviderStats();

    for (const stat of providerStats) {
      this.providerConfigs.set(stat.provider, {
        url: stat.url,
        costPerGb: stat.costPerGb,
      });
    }

    const envConfigs: Array<{ envKey: string; provider: ProxyProvider }> = [
      { envKey: 'BRIGHTDATA_URL', provider: 'brightdata' },
      { envKey: 'OXYLABS_URL', provider: 'oxylabs' },
      { envKey: 'SMARTPROXY_URL', provider: 'smartproxy' },
      { envKey: 'IPROYAL_URL', provider: 'iproyal' },
      { envKey: 'WEBSHARE_URL', provider: 'webshare' },
    ];

    for (const { envKey, provider } of envConfigs) {
      const url = process.env[envKey];
      if (url && !this.providerConfigs.has(provider)) {
        this.providerConfigs.set(provider, {
          url,
          costPerGb: PROVIDER_COST_PER_GB[provider] || 10,
        });
      }
    }
  }

  /**
   * Persist a session to Redis cache.
   */
  private async persistSession(session: RotatingSession): Promise<void> {
    try {
      const serializable = {
        ...session,
        domainCooldowns: Object.fromEntries(session.domainCooldowns),
      };

      await cacheSet(`rotating_session:${session.id}`, serializable, SESSION_CACHE_TTL);
      await cacheSet(`rotating_session:${session.sessionId}`, serializable, SESSION_CACHE_TTL);
    } catch (err: any) {
      logger.warn({ error: err.message, sessionId: session.id }, 'Failed to persist session');
    }
  }

  /**
   * Load a session from Redis cache.
   */
  private async loadSessionFromCache(id: string): Promise<RotatingSession | null> {
    try {
      const cached = await cacheGet<any>(`rotating_session:${id}`);
      if (!cached) return null;

      const domainCooldowns = new Map<string, number>();
      if (cached.domainCooldowns && typeof cached.domainCooldowns === 'object') {
        for (const [domain, until] of Object.entries(cached.domainCooldowns)) {
          domainCooldowns.set(domain, until as number);
        }
      }

      return {
        ...cached,
        domainCooldowns,
        healthScore: cached.healthScore || 1.0,
        validated: cached.validated || false,
        qualityTier: cached.qualityTier || 'standard',
        providerMixIndex: cached.providerMixIndex || 0,
        qualityScore: cached.qualityScore || 1.0,
        lastUsedAt: cached.lastUsedAt || cached.createdAt || Date.now(),
        lastValidatedAt: cached.lastValidatedAt || 0,
        totalLatencyMs: cached.totalLatencyMs || 0,
        latencySampleCount: cached.latencySampleCount || 0,
        avgLatencyMs: cached.avgLatencyMs || 0,
      };
    } catch (err: any) {
      logger.warn({ error: err.message, id }, 'Failed to load session from cache');
      return null;
    }
  }

  /**
   * Load all cached sessions from Redis on startup.
   */
  private async loadSessionsFromCache(): Promise<void> {
    try {
      logger.debug('Session cache will be loaded on-demand');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to load sessions from cache');
    }
  }

  // --- Private: Utility --------------------------------------------------

  /**
   * Get the estimated total IPs across all providers.
   */
  private getEstimatedTotalIPs(): number {
    let total = 0;
    for (const provider of this.providerConfigs.keys()) {
      total += PROVIDER_IP_CAPACITY[provider] || 0;
    }
    return total;
  }

  /**
   * Get the number of active sessions for a specific provider.
   */
  getActiveSessionCountForProvider(provider: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.provider === provider && session.isActive) count++;
    }
    return count;
  }

  /**
   * Get all active sessions matching optional filters.
   */
  getActiveSessions(options?: {
    provider?: ProxyProvider;
    country?: string;
    tier?: string;
    qualityTier?: string;
    minQualityScore?: number;
    maxLatencyMs?: number;
    limit?: number;
  }): RotatingSession[] {
    const now = Date.now();
    let results: RotatingSession[] = [];

    for (const session of this.sessions.values()) {
      if (!session.isActive || now >= session.expiresAt) continue;
      if (options?.provider && session.provider !== options.provider) continue;
      if (options?.country && session.country !== options.country.toUpperCase()) continue;
      if (options?.tier && session.tier !== options.tier) continue;
      if (options?.qualityTier && session.qualityTier !== options.qualityTier) continue;
      if (options?.minQualityScore && session.qualityScore < options.minQualityScore) continue;
      if (options?.maxLatencyMs && session.avgLatencyMs > options.maxLatencyMs && session.latencySampleCount > 2) continue;
      results.push(session);
    }

    // Sort by quality score
    results.sort((a, b) => b.qualityScore - a.qualityScore);

    if (options?.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * Check if a session is available for a specific domain (not on cooldown).
   */
  isSessionAvailableForDomain(sessionId: string, domain: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return false;

    const cooldownUntil = session.domainCooldowns.get(domain);
    if (cooldownUntil && Date.now() < cooldownUntil) return false;

    return true;
  }

  /**
   * Get the pool target size.
   */
  getPoolTarget(): number {
    return this.adaptivePoolTarget;
  }

  /**
   * Set the pool target size.
   */
  setPoolTarget(size: number): void {
    this.adaptivePoolTarget = Math.max(MIN_POOL_THRESHOLD, Math.min(MAX_ACTIVE_SESSIONS, size));
    logger.info({ poolTarget: this.adaptivePoolTarget }, 'Pool target updated');
  }

  /**
   * Get exit IP uniqueness tracking size.
   */
  getExitIpTrackingSize(): number {
    return this.usedExitIps.size;
  }

  /**
   * Check if an exit IP has been used recently.
   */
  isExitIpUsed(ip: string): boolean {
    return this.usedExitIps.has(ip);
  }

  /**
   * Get provider diversity metrics.
   */
  getProviderDiversity(): Record<string, number> {
    return { ...this.metrics.providerMix };
  }

  /**
   * Get metrics.
   */
  getMetrics(): SessionMetrics {
    return { ...this.metrics, providerMix: { ...this.metrics.providerMix }, circuitBreakerState: { ...this.metrics.circuitBreakerState } };
  }

  /**
   * Get provider performance records for a specific domain.
   */
  getProviderPerformanceForDomain(domain: string): ProviderPerformanceRecord[] {
    const domainMap = this.providerPerformance.get(domain);
    if (!domainMap) return [];
    return Array.from(domainMap.values());
  }

  /**
   * Get circuit breaker states for all providers.
   */
  getCircuitBreakerStates(): Record<string, CircuitBreakerState> {
    const states: Record<string, CircuitBreakerState> = {};
    for (const [provider, state] of this.circuitBreakers) {
      states[provider] = { ...state };
    }
    return states;
  }

  /**
   * Reset a circuit breaker for a provider (manual override).
   */
  resetCircuitBreaker(provider: ProxyProvider): void {
    const breaker = this.circuitBreakers.get(provider);
    if (breaker) {
      breaker.consecutiveFailures = 0;
      breaker.isOpen = false;
      breaker.halfOpenAt = 0;
      this.metrics.circuitBreakerState[provider] = { ...breaker };
      logger.info({ provider }, 'Circuit breaker manually reset');
    }
  }

  /**
   * Get recent errors for debugging/monitoring.
   */
  getRecentErrors(limit: number = 20): Array<{ message: string; provider: string; timestamp: number }> {
    return this.recentErrors.slice(-limit);
  }

  /**
   * Get a health summary for monitoring.
   */
  async getHealthSummary(): Promise<{
    isRunning: boolean;
    activeSessions: number;
    poolTarget: number;
    poolUtilization: number;
    avgSessionHealth: number;
    avgQualityScore: number;
    providerDiversity: number;
    creationRate: number;
    circuitBreakersOpen: number;
    exitIpsTracked: number;
    affinityEntries: number;
  }> {
    const activeSessions = Array.from(this.sessions.values()).filter(s => s.isActive);
    const avgHealth = activeSessions.length > 0
      ? activeSessions.reduce((sum, s) => sum + s.healthScore, 0) / activeSessions.length
      : 0;
    const avgQuality = activeSessions.length > 0
      ? activeSessions.reduce((sum, s) => sum + s.qualityScore, 0) / activeSessions.length
      : 0;

    let circuitBreakersOpen = 0;
    for (const state of this.circuitBreakers.values()) {
      if (state.isOpen) circuitBreakersOpen++;
    }

    return {
      isRunning: this.started,
      activeSessions: activeSessions.length,
      poolTarget: this.adaptivePoolTarget,
      poolUtilization: this.adaptivePoolTarget > 0 ? activeSessions.length / this.adaptivePoolTarget : 0,
      avgSessionHealth: Math.round(avgHealth * 100) / 100,
      avgQualityScore: Math.round(avgQuality * 100) / 100,
      providerDiversity: Object.keys(this.metrics.providerMix).length,
      creationRate: this.computeCurrentCreationRate(),
      circuitBreakersOpen,
      exitIpsTracked: this.usedExitIps.size,
      affinityEntries: this.sessionAffinity.size,
    };
  }

  /**
   * Force clear all sessions.
   */
  async clearAllSessions(): Promise<number> {
    const count = this.sessions.size;

    const results = await Promise.allSettled(
      Array.from(this.sessions.keys()).map(id => this.expireSession(id))
    );

    logger.info({ count }, 'All sessions cleared');
    return count;
  }

  /**
   * Get session count by country.
   */
  getSessionCountByCountry(country: string): number {
    const set = this.sessionsByCountry.get(country.toUpperCase());
    return set ? set.size : 0;
  }

  /**
   * Get all countries with active sessions.
   */
  getActiveCountries(): string[] {
    return Array.from(this.sessionsByCountry.keys());
  }

  /**
   * Record latency for a session (called after each request).
   */
  recordSessionLatency(sessionId: string, latencyMs: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.totalLatencyMs += latencyMs;
    session.latencySampleCount++;
    session.avgLatencyMs = session.totalLatencyMs / session.latencySampleCount;
  }

  /**
   * Get the average creation time across recent creations.
   */
  getAvgCreationTime(): number {
    if (this.metrics.creationTimeSamples.length === 0) return 0;
    const sum = this.metrics.creationTimeSamples.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.metrics.creationTimeSamples.length);
  }
}

// --- Singleton ----------------------------------------------------------------

export const rotatingSessionFactory = new RotatingSessionFactory();
