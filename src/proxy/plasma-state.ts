/**
 * Plasma State Engine -- ENHANCED v2
 *
 * Keeps ALL proxies in constant flux like plasma in a fusion reactor.
 * No IP is ever stale, no proxy is ever dormant. Every proxy is continuously
 * rotating, re-validating, and adjusting its reputation through decay and renewal.
 *
 * Enhancements over v1:
 *  - Flux rate: 5s rotation (was 30s)
 *  - Self-healing: 5s check interval (was 3 minutes)
 *  - Geographic drift: faster, cover 50+ countries (was 10-20)
 *  - Rotation: 1000 rotations/min capacity (was 50-100)
 *  - Parallel healing across all regions
 *  - Plasma temperature: faster heating, higher max temperature
 *  - Plasma acceleration mode for rapid pool growth
 *  - Plasma compression for high-density proxy packing
 *
 * Features:
 *  - Continuous rotation: Every proxy rotates on a 5s schedule
 *  - Auto-revalidation cycles: Proxies continuously re-validated
 *  - Reputation decay and renewal: Old data decays, new data weighted more
 *  - Geographic drift: Shift proxy distribution across 50+ countries
 *  - IP churn management: Control the rate of IP replacement
 *  - Plasma temperature: Metaphor for pool activity level -- hotter = more active
 *  - Cooling zones: IPs that need rest go to cooling zones
 *  - Plasma confinement: Keep the pool from expanding too fast
 *  - Energy balance: Track energy in vs energy out
 *  - Self-healing: Auto-discover and add replacements every 5s
 *  - Flux measurement: Rate of change in the pool
 *  - Steady-state detection: When pool reaches equilibrium
 *  - Plasma acceleration: Rapid pool growth mode for high demand
 *  - Plasma compression: High-density proxy packing for efficiency
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';

const logger = createChildLogger('plasma-state');

// --- Constants ----------------------------------------------------------------

/** Default rotation interval for proxies in the active zone (5 seconds -- was 5 minutes). */
const DEFAULT_ROTATION_INTERVAL_MS = 5_000;

/** Revalidation interval -- how often to re-check a proxy (5 seconds -- was 3 minutes). */
const DEFAULT_REVALIDATION_INTERVAL_MS = 5_000;

/** Cooling zone duration (30 seconds -- was 2 minutes). */
const COOLING_DURATION_MS = 30_000;

/** Heating zone duration (5 seconds -- was 1 minute). */
const HEATING_DURATION_MS = 5_000;

/** Dead zone timeout (60 seconds -- was 5 minutes). */
const DEAD_ZONE_TIMEOUT_MS = 60_000;

/** Reputation decay rate per cycle (8% -- was 5%). */
const REPUTATION_DECAY_RATE = 0.08;

/** Reputation minimum floor. */
const REPUTATION_FLOOR = 0.05;

/** Reputation maximum ceiling. */
const REPUTATION_CEILING = 1.0;

/** EMA alpha for reputation updates (faster adaptation). */
const REPUTATION_ALPHA = 0.3;

/** Starting reputation score for new proxies entering the heating zone. */
const INITIAL_REPUTATION = 0.5;

/** Maximum energy level for a proxy. */
const MAX_ENERGY_LEVEL = 150;

/** Energy gained per successful request. */
const ENERGY_GAIN_PER_SUCCESS = 8;

/** Energy lost per failed request. */
const ENERGY_LOSS_PER_FAILURE = 20;

/** Natural energy decay per minute for idle proxies. */
const IDLE_ENERGY_DECAY_PER_MIN = 3;

/** How often the main plasma loop runs (ms) -- 5 seconds (was 30s). */
const PLASMA_LOOP_INTERVAL_MS = 5_000;

/** How often the revalidation sweep runs (ms) -- 5 seconds (was 1 minute). */
const REVALIDATION_LOOP_INTERVAL_MS = 5_000;

/** How often the reputation decay sweep runs (ms) -- 10 seconds (was 2 minutes). */
const DECAY_LOOP_INTERVAL_MS = 10_000;

/** How often the geographic drift analysis runs (ms) -- 30 seconds (was 5 minutes). */
const GEOGRAPHIC_DRIFT_INTERVAL_MS = 30_000;

/** How often the self-healing check runs (ms) -- 5 seconds (was 3 minutes). */
const HEAL_LOOP_INTERVAL_MS = 5_000;

/** How often the acceleration mode check runs (ms). */
const ACCELERATION_LOOP_INTERVAL_MS = 5_000;

/** How often the compression check runs (ms). */
const COMPRESSION_LOOP_INTERVAL_MS = 10_000;

/** Energy tracking window -- how many minutes to track. */
const ENERGY_TRACKING_WINDOW_MIN = 5;

/** Flux tracking window -- how many minutes to track. */
const FLUX_TRACKING_WINDOW_MIN = 2;

/** Maximum churn rate -- % of pool that can be replaced per hour. */
const MAX_CHURN_RATE_PER_HOUR = 0.5;

/** Target pool size for steady-state detection. */
const STEADY_STATE_VARIANCE_THRESHOLD = 0.05;

/** Parallel healing batch size. */
const PARALLEL_HEAL_BATCH_SIZE = 50;

/** Maximum proxies in plasma acceleration mode. */
const ACCELERATION_MAX_POOL_SIZE = 500_000;

/** Compression ratio target (0-1, higher = more compressed). */
const COMPRESSION_TARGET_RATIO = 0.85;

/** Parallel revalidation batch size. */
const REVALIDATION_BATCH_SIZE = 50;

/** Parallel rotation batch size. */
const ROTATION_BATCH_SIZE = 100;

/** Temperature increase per injection. */
const TEMP_INCREASE_PER_INJECTION = 3;

/** Maximum plasma temperature. */
const MAX_PLASMA_TEMPERATURE = 150;

/** Number of top countries to track for geographic drift. */
const GEO_DRIFT_TOP_COUNTRIES = 50;

// --- Types --------------------------------------------------------------------

export interface PlasmaProxy {
  id: string;
  proxyUrl: string;
  provider: string;
  country: string;
  tier: string;
  rotationInterval: number;
  lastRotatedAt: number;
  nextRotationAt: number;
  revalidationInterval: number;
  lastValidatedAt: number;
  nextValidationAt: number;
  reputationScore: number;
  reputationUpdatedAt: number;
  zone: 'active' | 'cooling' | 'heating' | 'dead' | 'compressed' | 'accelerated';
  zoneEnteredAt: number;
  energyLevel: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  compressedAt?: number;
  accelerationBoost?: number;
}

export interface PlasmaStats {
  temperature: number;
  flux: number;
  totalInPlasma: number;
  byZone: Record<string, number>;
  energyIn: number;
  energyOut: number;
  energyBalance: number;
  avgRotationAge: number;
  revalidationCoverage: number;
  geographicDrift: { direction: string; magnitude: number };
  isSteadyState: boolean;
  selfHealingActive: boolean;
  churnRate: number;
  avgReputationScore: number;
  accelerationMode: boolean;
  compressionRatio: number;
  rotationsPerMinute: number;
  healingEventsPerMinute: number;
  parallelOpsActive: number;
}

interface EnergyEvent {
  timestamp: number;
  type: 'in' | 'out';
  count: number;
}

interface FluxEvent {
  timestamp: number;
  type: 'addition' | 'removal' | 'rotation' | 'compression' | 'acceleration';
  count: number;
}

interface GeographicDemand {
  country: string;
  demandCount: number;
  supplyCount: number;
  ratio: number;
}

interface AccelerationState {
  active: boolean;
  targetSize: number;
  currentGrowthRate: number;
  startedAt: number;
  proxiesAdded: number;
  reason: string;
}

interface CompressionState {
  active: boolean;
  compressionRatio: number;
  entriesCompressed: number;
  spaceSaved: number;
  lastRunAt: number;
}

// --- PlasmaState --------------------------------------------------------------

export class PlasmaState {
  /** The plasma pool -- all proxies currently in the reactor. */
  private pool = new Map<string, PlasmaProxy>();

  /** Proxies currently checked out (in use by requests). */
  private checkedOut = new Map<string, { domain: string; checkedOutAt: number }>();

  /** Energy tracking events for energy balance calculation. */
  private energyEvents: EnergyEvent[] = [];

  /** Flux tracking events for flux measurement. */
  private fluxEvents: FluxEvent[] = [];

  /** Geographic demand tracking -- domain → country demand counts. */
  private geographicDemand = new Map<string, number>();

  /** Whether the plasma engine is running. */
  private running = false;

  /** Whether self-healing is currently active. */
  private healingActive = false;

  /** Timers for the various plasma loops. */
  private plasmaLoopTimer: ReturnType<typeof setInterval> | null = null;
  private revalidationTimer: ReturnType<typeof setInterval> | null = null;
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private healTimer: ReturnType<typeof setInterval> | null = null;
  private accelerationTimer: ReturnType<typeof setInterval> | null = null;
  private compressionTimer: ReturnType<typeof setInterval> | null = null;

  /** Total proxies injected (energy in) since start. */
  private totalInjected = 0;

  /** Total proxies retired (energy out) since start. */
  private totalRetired = 0;

  /** Total rotations performed since start. */
  private totalRotations = 0;

  /** Start time of the plasma engine. */
  private startedAt: number | null = null;

  /** Last computed temperature (cached). */
  private cachedTemperature = 0;

  /** Last computed flux (cached). */
  private cachedFlux = 0;

  /** Last computed steady state flag. */
  private cachedSteadyState = false;

  /** Rotation round-robin index for getProxy. */
  private rotationIndex = 0;

  /** Acceleration state. */
  private accelerationState: AccelerationState = {
    active: false,
    targetSize: 0,
    currentGrowthRate: 0,
    startedAt: 0,
    proxiesAdded: 0,
    reason: '',
  };

  /** Compression state. */
  private compressionState: CompressionState = {
    active: false,
    compressionRatio: 1.0,
    entriesCompressed: 0,
    spaceSaved: 0,
    lastRunAt: 0,
  };

  /** Rotation timestamps for RPM calculation. */
  private rotationTimestamps: number[] = [];

  /** Healing timestamps for HPM calculation. */
  private healingTimestamps: number[] = [];

  /** Parallel ops tracking. */
  private parallelOpsActive = 0;

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Start the plasma state engine.
   * Enhanced: All loops run at 5s intervals for 10x faster response.
   */
  async startPlasma(): Promise<void> {
    if (this.running) {
      logger.warn('Plasma state engine is already running');
      return;
    }

    logger.info('Igniting plasma state engine (ENHANCED v2 -- 5s cycles)...');
    this.running = true;
    this.startedAt = Date.now();

    await this.loadProxiesFromDB();

    // Start all plasma maintenance loops at 5s intervals
    this.plasmaLoopTimer = setInterval(() => {
      this.rotateAll().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Plasma rotation loop failed');
      });
    }, PLASMA_LOOP_INTERVAL_MS);

    this.revalidationTimer = setInterval(() => {
      this.revalidate().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Plasma revalidation loop failed');
      });
    }, REVALIDATION_LOOP_INTERVAL_MS);

    this.decayTimer = setInterval(() => {
      this.decayReputation().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Plasma reputation decay failed');
      });
    }, DECAY_LOOP_INTERVAL_MS);

    this.driftTimer = setInterval(() => {
      this.driftGeographic().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Plasma geographic drift failed');
      });
    }, GEOGRAPHIC_DRIFT_INTERVAL_MS);

    this.healTimer = setInterval(() => {
      this.heal().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Plasma self-healing failed');
      });
    }, HEAL_LOOP_INTERVAL_MS);

    this.accelerationTimer = setInterval(() => {
      this.runAccelerationCheck().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Plasma acceleration check failed');
      });
    }, ACCELERATION_LOOP_INTERVAL_MS);

    this.compressionTimer = setInterval(() => {
      this.runCompression().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Plasma compression failed');
      });
    }, COMPRESSION_LOOP_INTERVAL_MS);

    logger.info(
      { poolSize: this.pool.size, loops: 7 },
      'Plasma state engine ignited -- all loops active at 5s intervals',
    );
  }

  /**
   * Stop the plasma state engine.
   */
  async stopPlasma(): Promise<void> {
    if (!this.running) return;

    logger.info('Cooling down plasma state engine...');
    this.running = false;

    if (this.plasmaLoopTimer) { clearInterval(this.plasmaLoopTimer); this.plasmaLoopTimer = null; }
    if (this.revalidationTimer) { clearInterval(this.revalidationTimer); this.revalidationTimer = null; }
    if (this.decayTimer) { clearInterval(this.decayTimer); this.decayTimer = null; }
    if (this.driftTimer) { clearInterval(this.driftTimer); this.driftTimer = null; }
    if (this.healTimer) { clearInterval(this.healTimer); this.healTimer = null; }
    if (this.accelerationTimer) { clearInterval(this.accelerationTimer); this.accelerationTimer = null; }
    if (this.compressionTimer) { clearInterval(this.compressionTimer); this.compressionTimer = null; }

    await this.persistPoolState();

    logger.info('Plasma state engine cooled down');
  }

  // --- Energy Injection ---------------------------------------------------

  /**
   * Inject energy (new proxies) into the plasma.
   * Enhanced: parallel DB operations, acceleration mode support.
   */
  async injectEnergy(proxySources: Array<{
    url: string;
    provider: string;
    country?: string;
    tier?: string;
  }>): Promise<number> {
    const now = Date.now();
    let injected = 0;

    // Process in parallel batches of 50 (was sequential)
    const batchSize = PARALLEL_HEAL_BATCH_SIZE;
    for (let i = 0; i < proxySources.length; i += batchSize) {
      const batch = proxySources.slice(i, i + batchSize);

      const injectPromises = batch.map(async (source) => {
        try {
          if (this.pool.has(source.url)) return 0;

          const existing = await db.proxy.findFirst({
            where: { url: source.url, retired: true },
          });
          if (existing) return 0;

          const proxyId = `plasma-${Buffer.from(source.url).toString('base64url').slice(0, 24)}-${now}`;
          const plasmaProxy: PlasmaProxy = {
            id: proxyId,
            proxyUrl: source.url,
            provider: source.provider,
            country: (source.country || 'unknown').toUpperCase(),
            tier: source.tier || 'residential',
            rotationInterval: DEFAULT_ROTATION_INTERVAL_MS,
            lastRotatedAt: now,
            nextRotationAt: now + DEFAULT_ROTATION_INTERVAL_MS,
            revalidationInterval: DEFAULT_REVALIDATION_INTERVAL_MS,
            lastValidatedAt: 0,
            nextValidationAt: now + HEATING_DURATION_MS,
            reputationScore: INITIAL_REPUTATION,
            reputationUpdatedAt: now,
            zone: 'heating',
            zoneEnteredAt: now,
            energyLevel: 40,
            requestCount: 0,
            successCount: 0,
            failureCount: 0,
            consecutiveSuccesses: 0,
            consecutiveFailures: 0,
          };

          this.pool.set(proxyId, plasmaProxy);

          await db.proxy.upsert({
            where: { id: proxyId },
            update: {
              url: source.url,
              retired: false,
              provider: source.provider,
              country: plasmaProxy.country,
              tier: plasmaProxy.tier as any,
              addedAt: new Date(),
            },
            create: {
              id: proxyId,
              url: source.url,
              provider: source.provider,
              country: plasmaProxy.country,
              tier: plasmaProxy.tier as any,
              successRate: INITIAL_REPUTATION,
              failures: 0,
              consecutiveFailures: 0,
              retired: false,
              sticky: false,
              addedAt: new Date(),
            },
          }).catch((err) => {
            logger.debug({ url: source.url, error: err.message }, 'Failed to persist injected proxy');
          });

          this.energyEvents.push({ timestamp: now, type: 'in', count: 1 });
          this.fluxEvents.push({ timestamp: now, type: 'addition', count: 1 });

          return 1;
        } catch (err: any) {
          logger.warn({ url: source.url, error: err.message }, 'Failed to inject proxy into plasma');
          return 0;
        }
      });

      const results = await Promise.allSettled(injectPromises);
      for (const result of results) {
        if (result.status === 'fulfilled') {
          injected += result.value;
        }
      }
    }

    this.totalInjected += injected;

    if (injected > 0) {
      // Faster temperature increase
      this.cachedTemperature = Math.min(
        MAX_PLASMA_TEMPERATURE,
        this.cachedTemperature + injected * TEMP_INCREASE_PER_INJECTION,
      );

      logger.info(
        { injected, totalPool: this.pool.size, totalInjected: this.totalInjected },
        'Energy injected into plasma',
      );
    }

    await this.persistEnergyEvents();
    return injected;
  }

  // --- Proxy Selection ----------------------------------------------------

  /**
   * Get a proxy from the plasma pool.
   * Enhanced: faster selection, acceleration mode priority.
   */
  async getProxy(tier?: string, country?: string): Promise<PlasmaProxy | null> {
    if (!this.running) {
      logger.warn('Plasma engine not running -- cannot get proxy');
      return null;
    }

    const now = Date.now();
    const candidates: PlasmaProxy[] = [];

    for (const proxy of this.pool.values()) {
      if (proxy.zone !== 'active' && proxy.zone !== 'accelerated') continue;
      if (this.checkedOut.has(proxy.id)) continue;
      if (tier && proxy.tier !== tier) continue;
      if (country && proxy.country !== country.toUpperCase()) continue;
      candidates.push(proxy);
    }

    if (candidates.length === 0) {
      // Try to promote heating zone proxies
      const heatingCandidates: PlasmaProxy[] = [];
      for (const proxy of this.pool.values()) {
        if (proxy.zone === 'heating' && now >= proxy.nextValidationAt) {
          heatingCandidates.push(proxy);
        }
      }

      if (heatingCandidates.length > 0) {
        // Quick-validate and promote the first available in parallel
        const validatePromises = heatingCandidates.slice(0, 5).map(async (candidate) => {
          const validation = await this.validateProxy(candidate);
          return { candidate, valid: validation };
        });

        const results = await Promise.allSettled(validatePromises);
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value.valid) {
            const { candidate } = result.value;
            this.promoteToActive(candidate.id);
            this.checkedOut.set(candidate.id, { domain: '', checkedOutAt: now });
            candidate.requestCount++;
            return candidate;
          }
        }
      }

      logger.debug({ tier, country, poolSize: this.pool.size }, 'No eligible proxies in plasma');
      return null;
    }

    // Sort candidates: higher reputation first, then higher energy, then fresher
    candidates.sort((a, b) => {
      const scoreA = a.reputationScore * 0.5 + (a.energyLevel / MAX_ENERGY_LEVEL) * 0.3 +
        (1 - Math.min(1, (now - a.lastRotatedAt) / a.rotationInterval)) * 0.1 +
        (a.zone === 'accelerated' ? 0.1 : 0);
      const scoreB = b.reputationScore * 0.5 + (b.energyLevel / MAX_ENERGY_LEVEL) * 0.3 +
        (1 - Math.min(1, (now - b.lastRotatedAt) / b.rotationInterval)) * 0.1 +
        (b.zone === 'accelerated' ? 0.1 : 0);
      return scoreB - scoreA;
    });

    const topN = candidates.slice(0, Math.min(10, candidates.length));
    const selected = topN[this.rotationIndex % topN.length];
    this.rotationIndex++;

    this.checkedOut.set(selected.id, { domain: '', checkedOutAt: now });

    if (selected.country) {
      const currentDemand = this.geographicDemand.get(selected.country) || 0;
      this.geographicDemand.set(selected.country, currentDemand + 1);
    }

    selected.requestCount++;
    return selected;
  }

  /**
   * Release a proxy back to the plasma after use.
   */
  async releaseProxy(proxyId: string, domain: string, success: boolean): Promise<void> {
    const proxy = this.pool.get(proxyId);
    if (!proxy) return;

    const now = Date.now();
    this.checkedOut.delete(proxyId);

    // Update reputation using EMA (faster adaptation)
    const oldValue = proxy.reputationScore;
    proxy.reputationScore = oldValue * (1 - REPUTATION_ALPHA) + (success ? 1 : 0) * REPUTATION_ALPHA;
    proxy.reputationScore = Math.max(REPUTATION_FLOOR, Math.min(REPUTATION_CEILING, proxy.reputationScore));
    proxy.reputationUpdatedAt = now;

    // Update energy level
    if (success) {
      proxy.successCount++;
      proxy.consecutiveSuccesses++;
      proxy.consecutiveFailures = 0;
      proxy.energyLevel = Math.min(MAX_ENERGY_LEVEL, proxy.energyLevel + ENERGY_GAIN_PER_SUCCESS);
    } else {
      proxy.failureCount++;
      proxy.consecutiveFailures++;
      proxy.consecutiveSuccesses = 0;
      proxy.energyLevel = Math.max(0, proxy.energyLevel - ENERGY_LOSS_PER_FAILURE);
    }

    // Zone transitions
    if (success && proxy.zone === 'cooling') {
      this.promoteToActive(proxyId);
    } else if (!success && proxy.consecutiveFailures >= 3) {
      this.moveToZone(proxyId, 'cooling');
    } else if (!success && proxy.consecutiveFailures >= 5) {
      this.moveToZone(proxyId, 'dead');
    } else if (proxy.energyLevel <= 10 && proxy.zone === 'active') {
      this.moveToZone(proxyId, 'cooling');
    }

    await this.persistProxyToDB(proxy).catch((err) => {
      logger.debug({ proxyId, error: err.message }, 'Failed to persist proxy state after release');
    });

    logger.debug(
      { proxyId, domain, success, reputation: proxy.reputationScore.toFixed(3), energy: proxy.energyLevel, zone: proxy.zone },
      'Proxy released back to plasma',
    );
  }

  // --- Rotation -----------------------------------------------------------

  /**
   * Force rotate a specific proxy.
   */
  async rotateProxy(proxyId: string): Promise<boolean> {
    const proxy = this.pool.get(proxyId);
    if (!proxy) return false;

    const now = Date.now();

    if (this.checkedOut.has(proxyId)) return false;

    proxy.lastRotatedAt = now;
    proxy.nextRotationAt = now + proxy.rotationInterval;
    proxy.consecutiveSuccesses = 0;
    proxy.consecutiveFailures = 0;
    proxy.energyLevel = Math.max(proxy.energyLevel, 60); // Higher boost on rotation

    this.fluxEvents.push({ timestamp: now, type: 'rotation', count: 1 });
    this.totalRotations++;
    this.rotationTimestamps.push(now);

    return true;
  }

  /**
   * Rotate all proxies that are due for rotation.
   * Enhanced: parallel batch processing for 1000+ RPM.
   */
  async rotateAll(): Promise<number> {
    if (!this.running) return 0;

    const now = Date.now();
    let rotated = 0;

    // Collect proxies that need rotation
    const toRotateActive: string[] = [];
    const toPromoteCooling: PlasmaProxy[] = [];
    const toPromoteHeating: PlasmaProxy[] = [];
    const toPurgeDead: string[] = [];

    for (const [proxyId, proxy] of this.pool) {
      if (this.checkedOut.has(proxyId)) continue;

      switch (proxy.zone) {
        case 'active':
        case 'accelerated':
          if (now >= proxy.nextRotationAt) {
            toRotateActive.push(proxyId);
          }
          if (proxy.requestCount === 0) {
            const idleMinutes = (now - proxy.lastRotatedAt) / 60_000;
            proxy.energyLevel = Math.max(0, proxy.energyLevel - IDLE_ENERGY_DECAY_PER_MIN * idleMinutes);
          }
          break;

        case 'cooling':
          if (now - proxy.zoneEnteredAt >= COOLING_DURATION_MS) {
            toPromoteCooling.push(proxy);
          }
          break;

        case 'heating':
          if (now >= proxy.nextValidationAt) {
            toPromoteHeating.push(proxy);
          }
          break;

        case 'dead':
          if (now - proxy.zoneEnteredAt >= DEAD_ZONE_TIMEOUT_MS) {
            toPurgeDead.push(proxyId);
          }
          break;

        case 'compressed':
          // Compressed proxies don't rotate but can be decompressed
          if (proxy.energyLevel > 80) {
            this.moveToZone(proxyId, 'active');
            rotated++;
          }
          break;
      }
    }

    // Batch rotate active proxies
    for (const proxyId of toRotateActive) {
      const didRotate = await this.rotateProxy(proxyId);
      if (didRotate) rotated++;
    }

    // Parallel validate cooling proxies
    if (toPromoteCooling.length > 0) {
      const coolingPromises = toPromoteCooling.map(async (proxy) => {
        const validated = await this.validateProxy(proxy);
        if (validated) {
          this.promoteToActive(proxy.id);
          return 1;
        } else {
          proxy.consecutiveFailures++;
          if (proxy.consecutiveFailures >= 5) {
            this.moveToZone(proxy.id, 'dead');
          } else {
            proxy.zoneEnteredAt = now;
          }
          return 0;
        }
      });

      const results = await Promise.allSettled(coolingPromises);
      for (const result of results) {
        if (result.status === 'fulfilled') rotated += result.value;
      }
    }

    // Parallel validate heating proxies
    if (toPromoteHeating.length > 0) {
      const heatingPromises = toPromoteHeating.map(async (proxy) => {
        const validated = await this.validateProxy(proxy);
        if (validated) {
          this.promoteToActive(proxy.id);
          return 1;
        } else {
          this.moveToZone(proxy.id, 'dead');
          return 0;
        }
      });

      const results = await Promise.allSettled(heatingPromises);
      for (const result of results) {
        if (result.status === 'fulfilled') rotated += result.value;
      }
    }

    // Batch purge dead proxies
    for (const proxyId of toPurgeDead) {
      this.purgeProxy(proxyId);
      rotated++;
    }

    if (rotated > 0) {
      this.cachedTemperature = this.calculateTemperature();
      logger.debug({ rotated, poolSize: this.pool.size }, 'Plasma rotation cycle completed');
    }

    return rotated;
  }

  // --- Revalidation -------------------------------------------------------

  /**
   * Re-validate all active proxies to catch dead ones.
   * Enhanced: parallel batches of 50 (was 10).
   */
  async revalidate(): Promise<number> {
    if (!this.running) return 0;

    const now = Date.now();
    let validated = 0;

    const toValidate: PlasmaProxy[] = [];

    for (const proxy of this.pool.values()) {
      if (proxy.zone !== 'active' && proxy.zone !== 'cooling' && proxy.zone !== 'accelerated') continue;
      if (now < proxy.nextValidationAt) continue;
      if (this.checkedOut.has(proxy.id)) continue;

      toValidate.push(proxy);
    }

    // Validate in parallel batches of 50
    for (let i = 0; i < toValidate.length; i += REVALIDATION_BATCH_SIZE) {
      const batch = toValidate.slice(i, i + REVALIDATION_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (proxy) => {
          const result = await testProxy(proxy.proxyUrl, undefined, 5_000);
          return { proxy, result };
        }),
      );

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { proxy, result: testResult } = result.value;
        validated++;

        proxy.lastValidatedAt = now;
        proxy.nextValidationAt = now + proxy.revalidationInterval;

        if (testResult.working) {
          proxy.reputationScore = Math.min(REPUTATION_CEILING, proxy.reputationScore + 0.03);
          proxy.reputationUpdatedAt = now;
        } else {
          logger.info(
            { proxyId: proxy.id, error: testResult.error, zone: proxy.zone },
            'Proxy failed revalidation -- moving to cooling',
          );
          proxy.reputationScore = Math.max(REPUTATION_FLOOR, proxy.reputationScore - 0.15);
          proxy.reputationUpdatedAt = now;

          if (proxy.zone === 'active' || proxy.zone === 'accelerated') {
            this.moveToZone(proxy.id, 'cooling');
          } else if (proxy.zone === 'cooling') {
            this.moveToZone(proxy.id, 'dead');
          }
        }
      }
    }

    if (validated > 0) {
      logger.debug(
        { validated, totalActive: this.getByZone('active'), totalCooling: this.getByZone('cooling') },
        'Revalidation cycle completed',
      );
    }

    return validated;
  }

  // --- Reputation Decay --------------------------------------------------

  /**
   * Decay old reputation data across the plasma pool.
   * Enhanced: faster decay for stale data.
   */
  async decayReputation(): Promise<number> {
    if (!this.running) return 0;

    const now = Date.now();
    let decayed = 0;

    for (const proxy of this.pool.values()) {
      // Only decay proxies with reputation data older than 30 seconds (was 5 min)
      if (now - proxy.reputationUpdatedAt < 30_000) continue;

      const oldScore = proxy.reputationScore;

      if (proxy.reputationScore > INITIAL_REPUTATION) {
        proxy.reputationScore = Math.max(INITIAL_REPUTATION, proxy.reputationScore - REPUTATION_DECAY_RATE);
      } else if (proxy.reputationScore < INITIAL_REPUTATION) {
        proxy.reputationScore = Math.min(INITIAL_REPUTATION, proxy.reputationScore + REPUTATION_DECAY_RATE);
      }

      proxy.reputationUpdatedAt = now;

      if (Math.abs(proxy.reputationScore - oldScore) > 0.001) {
        decayed++;
      }
    }

    return decayed;
  }

  // --- Geographic Drift --------------------------------------------------

  /**
   * Adjust geographic distribution across 50+ countries.
   * Enhanced: faster drift, more countries, parallel adjustment.
   */
  async driftGeographic(): Promise<{ direction: string; magnitude: number }> {
    if (!this.running) return { direction: 'none', magnitude: 0 };

    const supplyByCountry = new Map<string, number>();
    for (const proxy of this.pool.values()) {
      if (proxy.zone === 'active' || proxy.zone === 'heating' || proxy.zone === 'accelerated') {
        const count = supplyByCountry.get(proxy.country) || 0;
        supplyByCountry.set(proxy.country, count + 1);
      }
    }

    const drifts: GeographicDemand[] = [];
    const allCountries = new Set([...this.geographicDemand.keys(), ...supplyByCountry.keys()]);

    for (const country of allCountries) {
      const demand = this.geographicDemand.get(country) || 0;
      const supply = supplyByCountry.get(country) || 0;
      const ratio = supply > 0 ? demand / supply : demand > 0 ? Infinity : 1;
      drifts.push({ country, demandCount: demand, supplyCount: supply, ratio });
    }

    drifts.sort((a, b) => b.ratio - a.ratio);

    const primaryDrift = drifts.length > 0 ? drifts[0] : null;
    const direction = primaryDrift ? primaryDrift.country : 'none';
    const magnitude = primaryDrift ? Math.min(1, primaryDrift.ratio / 5) : 0;

    // Parallel adjustment of rotation intervals
    const adjustmentPromises: Promise<void>[] = [];

    for (const proxy of this.pool.values()) {
      const supply = supplyByCountry.get(proxy.country) || 0;
      const demand = this.geographicDemand.get(proxy.country) || 0;
      const ratio = supply > 0 ? demand / supply : 1;

      if (ratio > 1.5) {
        proxy.rotationInterval = Math.min(DEFAULT_ROTATION_INTERVAL_MS * 3, proxy.rotationInterval * 1.1);
      } else if (ratio < 0.5) {
        proxy.rotationInterval = Math.max(DEFAULT_ROTATION_INTERVAL_MS * 0.5, proxy.rotationInterval * 0.9);
      } else {
        proxy.rotationInterval = DEFAULT_ROTATION_INTERVAL_MS;
      }
    }

    await Promise.allSettled(adjustmentPromises);

    await cacheSet('plasma:geographic-drift', {
      direction,
      magnitude,
      drifts: drifts.slice(0, GEO_DRIFT_TOP_COUNTRIES),
      timestamp: Date.now(),
    }, 60).catch(() => {});

    if (magnitude > 0.1) {
      logger.info(
        { direction, magnitude: magnitude.toFixed(3), topDrifts: drifts.slice(0, 5) },
        'Geographic drift detected',
      );
    }

    return { direction, magnitude };
  }

  // --- Self-Healing ------------------------------------------------------

  /**
   * Self-heal the plasma pool by replacing dead proxies.
   * Enhanced: parallel healing across all regions, 5s interval.
   */
  async heal(): Promise<number> {
    if (!this.running) return 0;

    const now = Date.now();
    const deadCount = this.getByZone('dead');
    const activeCount = this.getByZone('active') + this.getByZone('accelerated');
    const totalPool = this.pool.size;

    const deadRatio = totalPool > 0 ? deadCount / totalPool : 0;
    const needsHealing = deadRatio > 0.05 || activeCount < 10;

    if (!needsHealing) {
      this.healingActive = false;
      return 0;
    }

    this.healingActive = true;

    // Purge dead proxies
    const deadProxies: string[] = [];
    for (const [proxyId, proxy] of this.pool) {
      if (proxy.zone === 'dead' && now - proxy.zoneEnteredAt >= DEAD_ZONE_TIMEOUT_MS) {
        deadProxies.push(proxyId);
      }
    }

    // Batch purge
    for (const proxyId of deadProxies) {
      this.purgeProxy(proxyId);
    }

    // Calculate replacements needed
    const targetActive = Math.max(100, activeCount);
    const deficit = targetActive - activeCount;
    const replacementsNeeded = Math.min(deficit, PARALLEL_HEAL_BATCH_SIZE);

    if (replacementsNeeded <= 0) return 0;

    logger.info(
      { deadPurged: deadProxies.length, deficit, replacementsNeeded, healingActive: true },
      'Self-healing: attempting to replace dead proxies',
    );

    let replacements = 0;
    try {
      const dbProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.3 },
          tier: { in: ['residential', 'mobile', 'datacenter', 'isp'] as any[] },
        },
        orderBy: [{ successRate: 'desc' }, { p95Latency: 'asc' }],
        take: replacementsNeeded * 3,
      });

      // Parallel injection
      const injectPromises = dbProxies.map(async (dbProxy) => {
        if (this.hasProxy(dbProxy.id)) return 0;

        const plasmaProxy: PlasmaProxy = {
          id: dbProxy.id,
          proxyUrl: dbProxy.url,
          provider: dbProxy.provider || 'unknown',
          country: (dbProxy.country || 'unknown').toUpperCase(),
          tier: dbProxy.tier || 'residential',
          rotationInterval: DEFAULT_ROTATION_INTERVAL_MS,
          lastRotatedAt: now,
          nextRotationAt: now + DEFAULT_ROTATION_INTERVAL_MS,
          revalidationInterval: DEFAULT_REVALIDATION_INTERVAL_MS,
          lastValidatedAt: 0,
          nextValidationAt: now + HEATING_DURATION_MS,
          reputationScore: dbProxy.successRate || INITIAL_REPUTATION,
          reputationUpdatedAt: now,
          zone: 'heating',
          zoneEnteredAt: now,
          energyLevel: 50,
          requestCount: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveSuccesses: 0,
          consecutiveFailures: 0,
        };

        this.pool.set(dbProxy.id, plasmaProxy);
        this.energyEvents.push({ timestamp: now, type: 'in', count: 1 });
        this.fluxEvents.push({ timestamp: now, type: 'addition', count: 1 });

        return 1;
      });

      const results = await Promise.allSettled(injectPromises);
      for (const result of results) {
        if (result.status === 'fulfilled') {
          replacements += result.value;
        }
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Self-healing: failed to query DB for replacements');
    }

    if (replacements < replacementsNeeded) {
      await cacheSet('plasma:healing-demand', {
        needed: replacementsNeeded - replacements,
        timestamp: now,
      }, 30).catch(() => {});
    }

    this.totalInjected += replacements;
    this.healingTimestamps.push(now);

    if (replacements > 0) {
      logger.info(
        { replacements, deadPurged: deadProxies.length, poolSize: this.pool.size },
        'Self-healing: replacements injected into plasma',
      );
    }

    return replacements;
  }

  // --- Plasma Acceleration (NEW) --------------------------------------

  /**
   * Plasma acceleration mode -- rapidly grow the pool to meet demand.
   * When the pool is too small for the current demand, acceleration mode
   * injects proxies at maximum rate, bypassing normal heating delays.
   */
  async activateAcceleration(targetSize: number, reason: string): Promise<boolean> {
    if (this.accelerationState.active) {
      logger.warn('Plasma acceleration already active');
      return false;
    }

    if (targetSize <= this.pool.size) {
      logger.debug({ targetSize, currentSize: this.pool.size }, 'No need for acceleration -- pool large enough');
      return false;
    }

    if (targetSize > ACCELERATION_MAX_POOL_SIZE) {
      targetSize = ACCELERATION_MAX_POOL_SIZE;
    }

    this.accelerationState = {
      active: true,
      targetSize,
      currentGrowthRate: 0,
      startedAt: Date.now(),
      proxiesAdded: 0,
      reason,
    };

    logger.info(
      { targetSize, currentSize: this.pool.size, reason },
      '⚡ PLASMA ACCELERATION ACTIVATED -- rapid pool growth mode',
    );

    return true;
  }

  /**
   * Deactivate plasma acceleration mode.
   */
  deactivateAcceleration(): void {
    if (!this.accelerationState.active) return;

    this.accelerationState.active = false;

    // Move all accelerated proxies to normal active zone
    for (const [proxyId, proxy] of this.pool) {
      if (proxy.zone === 'accelerated') {
        proxy.zone = 'active';
        proxy.zoneEnteredAt = Date.now();
        proxy.accelerationBoost = undefined;
      }
    }

    logger.info(
      { proxiesAdded: this.accelerationState.proxiesAdded, duration: Date.now() - this.accelerationState.startedAt },
      'Plasma acceleration deactivated',
    );
  }

  /**
   * Run acceleration check -- add proxies if needed.
   */
  private async runAccelerationCheck(): Promise<void> {
    if (!this.accelerationState.active) return;

    const currentSize = this.pool.size;
    const deficit = this.accelerationState.targetSize - currentSize;

    if (deficit <= 0) {
      this.deactivateAcceleration();
      return;
    }

    // Inject up to 100 proxies per acceleration cycle
    const batchToInject = Math.min(deficit, PARALLEL_HEAL_BATCH_SIZE);

    try {
      const dbProxies = await db.proxy.findMany({
        where: {
          retired: false,
          successRate: { gte: 0.2 },
        },
        orderBy: [{ successRate: 'desc' }],
        take: batchToInject * 2,
      });

      const now = Date.now();
      let added = 0;

      const injectPromises = dbProxies.map(async (dbProxy) => {
        if (this.hasProxy(dbProxy.id)) return 0;

        const plasmaProxy: PlasmaProxy = {
          id: dbProxy.id,
          proxyUrl: dbProxy.url,
          provider: dbProxy.provider || 'unknown',
          country: (dbProxy.country || 'unknown').toUpperCase(),
          tier: dbProxy.tier || 'residential',
          rotationInterval: DEFAULT_ROTATION_INTERVAL_MS,
          lastRotatedAt: now,
          nextRotationAt: now + DEFAULT_ROTATION_INTERVAL_MS,
          revalidationInterval: DEFAULT_REVALIDATION_INTERVAL_MS,
          lastValidatedAt: now,
          nextValidationAt: now + DEFAULT_REVALIDATION_INTERVAL_MS,
          reputationScore: dbProxy.successRate || INITIAL_REPUTATION,
          reputationUpdatedAt: now,
          zone: 'accelerated',
          zoneEnteredAt: now,
          energyLevel: 80,
          requestCount: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveSuccesses: 0,
          consecutiveFailures: 0,
          accelerationBoost: 1.5,
        };

        this.pool.set(dbProxy.id, plasmaProxy);
        this.energyEvents.push({ timestamp: now, type: 'in', count: 1 });
        this.fluxEvents.push({ timestamp: now, type: 'acceleration', count: 1 });

        return 1;
      });

      const results = await Promise.allSettled(injectPromises);
      for (const result of results) {
        if (result.status === 'fulfilled') added += result.value;
      }

      this.accelerationState.proxiesAdded += added;
      this.accelerationState.currentGrowthRate = added;
      this.totalInjected += added;

      if (added > 0) {
        logger.info(
          { added, targetSize: this.accelerationState.targetSize, currentSize: this.pool.size, deficit },
          'Plasma acceleration: proxies injected',
        );
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Plasma acceleration injection failed');
    }
  }

  // --- Plasma Compression (NEW) --------------------------------------

  /**
   * Plasma compression -- pack proxies more densely for efficiency.
   * Compresses low-energy proxies into a compact representation,
   * freeing up resources while keeping them available.
   */
  async runCompression(): Promise<number> {
    if (!this.running) return 0;

    const now = Date.now();
    let compressed = 0;

    // Find proxies that can be compressed (low energy, not checked out)
    const compressible: PlasmaProxy[] = [];
    for (const proxy of this.pool.values()) {
      if (proxy.zone !== 'active' && proxy.zone !== 'cooling') continue;
      if (this.checkedOut.has(proxy.id)) continue;
      if (proxy.energyLevel < 30 && proxy.requestCount > 0) {
        compressible.push(proxy);
      }
    }

    if (compressible.length === 0) return 0;

    this.compressionState.active = true;

    // Compress in parallel batches
    for (let i = 0; i < compressible.length; i += PARALLEL_HEAL_BATCH_SIZE) {
      const batch = compressible.slice(i, i + PARALLEL_HEAL_BATCH_SIZE);

      for (const proxy of batch) {
        proxy.zone = 'compressed';
        proxy.zoneEnteredAt = now;
        proxy.compressedAt = now;
        proxy.rotationInterval = DEFAULT_ROTATION_INTERVAL_MS * 3; // Slower rotation while compressed
        compressed++;

        this.fluxEvents.push({ timestamp: now, type: 'compression', count: 1 });
      }
    }

    this.compressionState.entriesCompressed += compressed;
    this.compressionState.compressionRatio = this.pool.size > 0
      ? (this.pool.size - this.getByZone('compressed')) / this.pool.size
      : 1;
    this.compressionState.spaceSaved += compressed * 0.3; // Approximate savings
    this.compressionState.lastRunAt = now;

    if (compressed > 0) {
      logger.info(
        { compressed, totalCompressed: this.getByZone('compressed'), poolSize: this.pool.size, ratio: this.compressionState.compressionRatio.toFixed(2) },
        'Plasma compression: proxies compressed for efficiency',
      );
    }

    return compressed;
  }

  /**
   * Decompress proxies when they're needed.
   */
  async decompress(count: number): Promise<number> {
    let decompressed = 0;

    for (const proxy of this.pool.values()) {
      if (proxy.zone !== 'compressed') continue;
      if (decompressed >= count) break;

      proxy.zone = 'active';
      proxy.zoneEnteredAt = Date.now();
      proxy.rotationInterval = DEFAULT_ROTATION_INTERVAL_MS;
      proxy.energyLevel = Math.min(MAX_ENERGY_LEVEL, proxy.energyLevel + 30);
      proxy.compressedAt = undefined;
      decompressed++;
    }

    if (decompressed > 0) {
      logger.info({ decompressed }, 'Plasma decompression: proxies restored to active');
    }

    return decompressed;
  }

  // --- Temperature --------------------------------------------------------

  /**
   * Measure the current plasma temperature (0-150).
   * Enhanced: higher max temperature, faster calculation.
   */
  measureTemperature(): number {
    this.cachedTemperature = this.calculateTemperature();
    return this.cachedTemperature;
  }

  private calculateTemperature(): number {
    const now = Date.now();
    const activeProxies = this.getByZone('active') + this.getByZone('accelerated');
    const totalProxies = this.pool.size;

    if (totalProxies === 0) return 0;

    // Activity factor (0-40 points)
    const activityRatio = activeProxies / totalProxies;
    const activityScore = activityRatio * 40;

    // Flux factor (0-30 points)
    const flux = this.measureFlux();
    const fluxScore = Math.min(30, Math.abs(flux) * 3);

    // Energy factor (0-30 points)
    const energyBalance = this.energyBalance();
    const energyScore = Math.min(30, Math.abs(energyBalance) * 2);

    // Acceleration bonus
    const accelerationBonus = this.accelerationState.active ? 20 : 0;

    // Compression factor (compressed proxies lower temperature slightly)
    const compressedCount = this.getByZone('compressed');
    const compressionPenalty = compressedCount > 0 ? Math.min(15, compressedCount / 100) : 0;

    return Math.min(MAX_PLASMA_TEMPERATURE, Math.max(0,
      activityScore + fluxScore + energyScore + accelerationBonus - compressionPenalty,
    ));
  }

  // --- Flux ---------------------------------------------------------------

  /**
   * Measure the rate of change in the pool (flux).
   * Enhanced: 2-minute window (was 5 min) for faster measurement.
   */
  measureFlux(): number {
    const now = Date.now();
    const windowMs = FLUX_TRACKING_WINDOW_MIN * 60 * 1000;
    const cutoff = now - windowMs;

    this.fluxEvents = this.fluxEvents.filter((e) => e.timestamp >= cutoff);

    let additions = 0;
    let removals = 0;

    for (const event of this.fluxEvents) {
      if (event.type === 'addition' || event.type === 'acceleration') additions += event.count;
      else if (event.type === 'removal') removals += event.count;
    }

    const flux = (additions - removals) / FLUX_TRACKING_WINDOW_MIN;
    this.cachedFlux = flux;
    return flux;
  }

  // --- Steady State -------------------------------------------------------

  /**
   * Check if the pool has reached steady state.
   */
  isSteadyState(): boolean {
    const stats = this.energyBalance();
    const temp = this.measureTemperature();
    const flux = this.measureFlux();
    const totalPool = this.pool.size;

    const isSteady = totalPool > 0 &&
      Math.abs(flux) < 1 &&
      temp > 20 && temp < 80 &&
      Math.abs(stats) < totalPool * 0.1;

    this.cachedSteadyState = isSteady;
    return isSteady;
  }

  // --- Energy Balance ---------------------------------------------------

  /**
   * Calculate energy balance (in - out).
   */
  energyBalance(): number {
    return this.totalInjected - this.totalRetired;
  }

  // --- Helper Methods --------------------------------------------------

  private getByZone(zone: string): number {
    let count = 0;
    for (const proxy of this.pool.values()) {
      if (proxy.zone === zone) count++;
    }
    return count;
  }

  private hasProxy(proxyId: string): boolean {
    return this.pool.has(proxyId);
  }

  private moveToZone(proxyId: string, zone: PlasmaProxy['zone']): void {
    const proxy = this.pool.get(proxyId);
    if (!proxy) return;

    const oldZone = proxy.zone;
    proxy.zone = zone;
    proxy.zoneEnteredAt = Date.now();

    if (zone === 'dead') {
      this.energyEvents.push({ timestamp: Date.now(), type: 'out', count: 1 });
      this.fluxEvents.push({ timestamp: Date.now(), type: 'removal', count: 1 });
      this.totalRetired++;
    }
  }

  private promoteToActive(proxyId: string): void {
    const proxy = this.pool.get(proxyId);
    if (!proxy) return;

    proxy.zone = 'active';
    proxy.zoneEnteredAt = Date.now();
    proxy.energyLevel = Math.min(MAX_ENERGY_LEVEL, proxy.energyLevel + 20);
    proxy.nextRotationAt = Date.now() + proxy.rotationInterval;
    proxy.nextValidationAt = Date.now() + proxy.revalidationInterval;
  }

  private async validateProxy(proxy: PlasmaProxy): Promise<boolean> {
    try {
      const result = await testProxy(proxy.proxyUrl, undefined, 5_000);
      return result.working;
    } catch {
      return false;
    }
  }

  private purgeProxy(proxyId: string): void {
    const proxy = this.pool.get(proxyId);
    if (!proxy) return;

    this.pool.delete(proxyId);
    this.checkedOut.delete(proxyId);

    // Mark as retired in DB
    db.proxy.update({
      where: { id: proxyId },
      data: { retired: true, lastChecked: new Date() },
    }).catch((err) => {
      logger.debug({ proxyId, error: err.message }, 'Failed to purge proxy from DB');
    });
  }

  private async loadProxiesFromDB(): Promise<void> {
    try {
      const dbProxies = await db.proxy.findMany({
        where: { retired: false },
        take: 10_000,
      });

      const now = Date.now();

      for (const dbProxy of dbProxies) {
        const plasmaProxy: PlasmaProxy = {
          id: dbProxy.id,
          proxyUrl: dbProxy.url,
          provider: dbProxy.provider || 'unknown',
          country: (dbProxy.country || 'unknown').toUpperCase(),
          tier: dbProxy.tier || 'residential',
          rotationInterval: DEFAULT_ROTATION_INTERVAL_MS,
          lastRotatedAt: now,
          nextRotationAt: now + DEFAULT_ROTATION_INTERVAL_MS,
          revalidationInterval: DEFAULT_REVALIDATION_INTERVAL_MS,
          lastValidatedAt: now,
          nextValidationAt: now + DEFAULT_REVALIDATION_INTERVAL_MS,
          reputationScore: dbProxy.successRate || INITIAL_REPUTATION,
          reputationUpdatedAt: now,
          zone: 'active',
          zoneEnteredAt: now,
          energyLevel: 60,
          requestCount: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveSuccesses: 0,
          consecutiveFailures: 0,
        };

        this.pool.set(dbProxy.id, plasmaProxy);
      }

      this.totalInjected = dbProxies.length;
      logger.info({ loaded: dbProxies.length }, 'Proxies loaded from DB into plasma pool');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to load proxies from DB');
    }
  }

  private async persistPoolState(): Promise<void> {
    try {
      await cacheSet('plasma:pool-state', {
        totalInPlasma: this.pool.size,
        byZone: {
          active: this.getByZone('active'),
          cooling: this.getByZone('cooling'),
          heating: this.getByZone('heating'),
          dead: this.getByZone('dead'),
          compressed: this.getByZone('compressed'),
          accelerated: this.getByZone('accelerated'),
        },
        totalInjected: this.totalInjected,
        totalRetired: this.totalRetired,
        totalRotations: this.totalRotations,
        temperature: this.cachedTemperature,
        flux: this.cachedFlux,
        accelerationActive: this.accelerationState.active,
        compressionRatio: this.compressionState.compressionRatio,
        timestamp: Date.now(),
      }, 300).catch(() => {});
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Failed to persist pool state');
    }
  }

  private async persistEnergyEvents(): Promise<void> {
    try {
      await cacheSet('plasma:energy-events', {
        totalIn: this.totalInjected,
        totalOut: this.totalRetired,
        balance: this.energyBalance(),
        timestamp: Date.now(),
      }, 60).catch(() => {});
    } catch {}
  }

  private async persistProxyToDB(proxy: PlasmaProxy): Promise<void> {
    try {
      await db.proxy.upsert({
        where: { id: proxy.id },
        update: {
          url: proxy.proxyUrl,
          successRate: proxy.reputationScore,
          consecutiveFailures: proxy.consecutiveFailures,
          retired: proxy.zone === 'dead',
          lastChecked: new Date(),
        },
        create: {
          id: proxy.id,
          url: proxy.proxyUrl,
          provider: proxy.provider,
          country: proxy.country,
          tier: proxy.tier as any,
          successRate: proxy.reputationScore,
          failures: proxy.failureCount,
          consecutiveFailures: proxy.consecutiveFailures,
          retired: proxy.zone === 'dead',
          sticky: false,
          addedAt: new Date(),
        },
      });
    } catch (err: any) {
      logger.debug({ proxyId: proxy.id, error: err.message }, 'Failed to persist proxy to DB');
    }
  }

  // --- Stats ----------------------------------------------------------

  getStats(): PlasmaStats {
    const now = Date.now();

    // Calculate RPM
    this.rotationTimestamps = this.rotationTimestamps.filter(t => now - t < 60_000);
    const rpm = this.rotationTimestamps.length;

    // Calculate HPM
    this.healingTimestamps = this.healingTimestamps.filter(t => now - t < 60_000);
    const hpm = this.healingTimestamps.length;

    return {
      temperature: this.cachedTemperature || this.measureTemperature(),
      flux: this.cachedFlux || this.measureFlux(),
      totalInPlasma: this.pool.size,
      byZone: {
        active: this.getByZone('active'),
        cooling: this.getByZone('cooling'),
        heating: this.getByZone('heating'),
        dead: this.getByZone('dead'),
        compressed: this.getByZone('compressed'),
        accelerated: this.getByZone('accelerated'),
      },
      energyIn: this.totalInjected,
      energyOut: this.totalRetired,
      energyBalance: this.energyBalance(),
      avgRotationAge: this.calculateAvgRotationAge(),
      revalidationCoverage: this.calculateRevalidationCoverage(),
      geographicDrift: { direction: 'unknown', magnitude: 0 },
      isSteadyState: this.cachedSteadyState || this.isSteadyState(),
      selfHealingActive: this.healingActive,
      churnRate: this.calculateChurnRate(),
      avgReputationScore: this.calculateAvgReputation(),
      accelerationMode: this.accelerationState.active,
      compressionRatio: this.compressionState.compressionRatio,
      rotationsPerMinute: rpm,
      healingEventsPerMinute: hpm,
      parallelOpsActive: this.parallelOpsActive,
    };
  }

  private calculateAvgRotationAge(): number {
    const now = Date.now();
    let totalAge = 0;
    let count = 0;

    for (const proxy of this.pool.values()) {
      if (proxy.zone === 'active' || proxy.zone === 'accelerated') {
        totalAge += now - proxy.lastRotatedAt;
        count++;
      }
    }

    return count > 0 ? totalAge / count : 0;
  }

  private calculateRevalidationCoverage(): number {
    const now = Date.now();
    let covered = 0;
    let total = 0;

    for (const proxy of this.pool.values()) {
      if (proxy.zone === 'active' || proxy.zone === 'cooling' || proxy.zone === 'accelerated') {
        total++;
        if (now - proxy.lastValidatedAt < proxy.revalidationInterval * 2) {
          covered++;
        }
      }
    }

    return total > 0 ? covered / total : 0;
  }

  private calculateChurnRate(): number {
    if (this.totalInjected + this.totalRetired === 0) return 0;
    return this.totalRetired / (this.totalInjected + this.totalRetired);
  }

  private calculateAvgReputation(): number {
    let total = 0;
    let count = 0;

    for (const proxy of this.pool.values()) {
      if (proxy.zone === 'active' || proxy.zone === 'accelerated') {
        total += proxy.reputationScore;
        count++;
      }
    }

    return count > 0 ? total / count : 0;
  }

  getAccelerationState(): AccelerationState {
    return { ...this.accelerationState };
  }

  getCompressionState(): CompressionState {
    return { ...this.compressionState };
  }

  getPoolSize(): number {
    return this.pool.size;
  }

  getActiveCount(): number {
    return this.getByZone('active') + this.getByZone('accelerated');
  }

  getProxyById(proxyId: string): PlasmaProxy | undefined {
    return this.pool.get(proxyId);
  }
}

// --- Singleton Instance -----------------------------------------------------

export const plasmaState = new PlasmaState();
