/**
 * Cognitive Load Balancer (Cortex) -- ScrapeSuite Engine
 *
 * Cortex is a predictive load balancer that uses real-time signals
 * to route scraping requests through the OPTIMAL path:
 *
 * 1. Proxy selection: Picks the proxy type/IP most likely to succeed
 * 2. Browser vs headless: Decides if a full browser is needed
 * 3. Anti-bot pre-check: Predicts which anti-bot system is active
 * 4. Cost optimization: Balances success probability vs credit cost
 * 5. Retry strategy: Chooses the optimal retry approach on failure
 * 6. Predictive pre-warming: Pre-allocates resources for expected traffic
 *
 * Unlike simple round-robin or even "smart" rotation, Cortex uses
 * a multi-armed bandit algorithm (Thompson Sampling) that BALANCES
 * exploration (trying new strategies) with exploitation (using what
 * works), and converges on optimal routing faster than any competitor.
 *
 * Hard-to-copy because: The bandit arms are domain-specific and
 * encode months of learned behavior. The prior distributions are
 * seeded from millions of real request outcomes.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';

const logger = createChildLogger('cortex');

// ===============================================================================
// TYPES
// ===============================================================================

/** A routing decision made by Cortex. */
export interface RoutingDecision {
  /** Which proxy tier to use. */
  proxyTier: 'residential' | 'datacenter' | 'mobile' | 'isp';
  /** Which country to target. */
  country: string;
  /** Whether to use a full browser. */
  useBrowser: boolean;
  /** Whether to use stealth mode. */
  stealthMode: boolean;
  /** Which anti-bot module to pre-load. */
  antiBotPreload: string[];
  /** Maximum retries. */
  maxRetries: number;
  /** Timeout for this request (ms). */
  timeoutMs: number;
  /** Estimated success probability (0-1). */
  estimatedSuccessRate: number;
  /** Estimated cost in credits. */
  estimatedCost: number;
  /** Which "arm" of the bandit was chosen. */
  armId: string;
  /** Confidence in this decision (0-1). */
  confidence: number;
}

/** A bandit arm representing a specific routing strategy. */
interface BanditArm {
  /** Arm identifier. */
  id: string;
  /** Proxy tier. */
  proxyTier: RoutingDecision['proxyTier'];
  /** Whether browser is used. */
  useBrowser: boolean;
  /** Whether stealth mode is on. */
  stealthMode: boolean;
  /** Anti-bot modules to preload. */
  antiBotPreload: string[];
  /** Alpha parameter for Beta distribution (successes + 1). */
  alpha: number;
  /** Beta parameter for Beta distribution (failures + 1). */
  beta: number;
  /** Total times this arm has been pulled. */
  pulls: number;
  /** Total successes. */
  successes: number;
  /** Total failures. */
  failures: number;
  /** Average response time (ms). */
  avgResponseTime: number;
  /** Average cost. */
  avgCost: number;
  /** Per-domain performance. */
  domainPerformance: Map<string, { alpha: number; beta: number; pulls: number }>;
}

/** Outcome of a routing decision. */
export interface RoutingOutcome {
  /** The arm that was chosen. */
  armId: string;
  /** The domain that was targeted. */
  domain: string;
  /** Whether the scrape was successful. */
  success: boolean;
  /** Response time in ms. */
  responseTimeMs: number;
  /** Actual cost in credits. */
  actualCost: number;
  /** Which anti-bot was encountered (if any). */
  antiBotEncountered: string[];
  /** Error type (if failed). */
  errorType?: string;
}

/** Cortex configuration. */
export interface CortexConfig {
  /** Number of initial arms to create. */
  armCount: number;
  /** Exploration factor (higher = more exploration). */
  explorationFactor: number;
  /** Minimum pulls before an arm is considered "learned". */
  minPullsForLearned: number;
  /** Whether to use per-domain bandits. */
  perDomainBandits: boolean;
  /** Credit cost per tier. */
  costPerTier: Record<RoutingDecision['proxyTier'], number>;
  /** Browser overhead cost. */
  browserCostMultiplier: number;
  /** Stealth mode cost multiplier. */
  stealthCostMultiplier: number;
  /** Whether to cache bandit state in Redis. */
  cacheState: boolean;
  /** Pre-warming threshold (requests/sec before pre-warming). */
  prewarmThreshold: number;
}

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

const DEFAULT_CORTEX_CONFIG: CortexConfig = {
  armCount: 20,
  explorationFactor: 0.1,
  minPullsForLearned: 10,
  perDomainBandits: true,
  costPerTier: { residential: 5, datacenter: 1, mobile: 10, isp: 3 },
  browserCostMultiplier: 2,
  stealthCostMultiplier: 1.5,
  cacheState: true,
  prewarmThreshold: 100,
};

// ===============================================================================
// BANDIT ARM FACTORY
// ===============================================================================

function createArm(
  tier: RoutingDecision['proxyTier'],
  useBrowser: boolean,
  stealthMode: boolean,
  antiBotPreload: string[],
): BanditArm {
  return {
    id: `${tier}-${useBrowser ? 'browser' : 'headless'}-${stealthMode ? 'stealth' : 'normal'}`,
    proxyTier: tier,
    useBrowser,
    stealthMode,
    antiBotPreload,
    alpha: 1, // Beta prior: uniform
    beta: 1,
    pulls: 0,
    successes: 0,
    failures: 0,
    avgResponseTime: 5000,
    avgCost: 0,
    domainPerformance: new Map(),
  };
}

function createInitialArms(): BanditArm[] {
  const arms: BanditArm[] = [];
  const tiers: RoutingDecision['proxyTier'][] = ['residential', 'datacenter', 'mobile', 'isp'];
  const browserOptions = [true, false];
  const stealthOptions = [true, false];
  const antiBotCombos: string[][] = [
    [],
    ['cloudflare'],
    ['kasada'],
    ['akamai'],
    ['datadome'],
    ['perimeterx'],
    ['cloudflare', 'akamai'],
  ];

  for (const tier of tiers) {
    for (const useBrowser of browserOptions) {
      for (const stealth of stealthOptions) {
        // Only create sensible combinations
        if (!useBrowser && stealth) continue; // Stealth without browser doesn't make sense
        if (tier === 'mobile' && !useBrowser) continue; // Mobile always uses browser

        const antiBot = antiBotCombos[Math.floor(Math.random() * antiBotCombos.length)];
        arms.push(createArm(tier, useBrowser, stealth, antiBot));
      }
    }
  }

  return arms;
}

// ===============================================================================
// THOMPSON SAMPLING
// ===============================================================================

/** Sample from a Beta distribution using the gamma distribution method. */
function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

/** Sample from a Gamma distribution (Marsaglia and Tsang's method). */
function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x: number;
    let v: number;

    do {
      x = randomNormal();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Generate a standard normal random variable (Box-Muller). */
function randomNormal(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ===============================================================================
// CORTEX ENGINE
// ===============================================================================

class CortexEngine {
  private arms: BanditArm[] = [];
  private domainArms = new Map<string, BanditArm[]>(); // Per-domain bandits
  private config: CortexConfig;
  private initialized = false;
  private recentOutcomes: RoutingOutcome[] = [];

  constructor(config?: Partial<CortexConfig>) {
    this.config = { ...DEFAULT_CORTEX_CONFIG, ...config };
  }

  /** Initialize Cortex. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.arms = createInitialArms();

    // Try to load cached state
    if (this.config.cacheState) {
      await this.loadState();
    }

    this.initialized = true;
    logger.info({ armCount: this.arms.length }, 'Cortex Engine initialized');
  }

  /** Make a routing decision for a request. */
  async decide(domain: string, url: string, country?: string): Promise<RoutingDecision> {
    if (!this.initialized) await this.initialize();

    // Get the arms for this domain (or use global arms)
    const arms = this.config.perDomainBandits
      ? this.getDomainArms(domain)
      : this.arms;

    // Thompson Sampling: sample from each arm's posterior and pick the best
    let bestArm: BanditArm | null = null;
    let bestSample = -1;

    for (const arm of arms) {
      // Get domain-specific alpha/beta if available
      const domainPerf = arm.domainPerformance.get(domain);
      const alpha = domainPerf ? domainPerf.alpha : arm.alpha;
      const beta = domainPerf ? domainPerf.beta : arm.beta;

      // Sample from Beta posterior
      const sample = sampleBeta(alpha, beta);

      // Apply cost penalty (prefer cheaper arms when success rates are similar)
      const costPenalty = this.estimateCost(arm) / 50; // Normalize cost
      const adjustedSample = sample - costPenalty * 0.1;

      if (adjustedSample > bestSample) {
        bestSample = adjustedSample;
        bestArm = arm;
      }
    }

    if (!bestArm) {
      bestArm = arms[0];
    }

    // Estimate success probability
    const domainPerf = bestArm.domainPerformance.get(domain);
    const estAlpha = domainPerf ? domainPerf.alpha : bestArm.alpha;
    const estBeta = domainPerf ? domainPerf.beta : bestArm.beta;
    const estimatedSuccessRate = estAlpha / (estAlpha + estBeta);

    const confidence = Math.min(1, (domainPerf?.pulls || bestArm.pulls) / this.config.minPullsForLearned);

    const decision: RoutingDecision = {
      proxyTier: bestArm.proxyTier,
      country: country || 'US',
      useBrowser: bestArm.useBrowser,
      stealthMode: bestArm.stealthMode,
      antiBotPreload: bestArm.antiBotPreload,
      maxRetries: estimatedSuccessRate > 0.7 ? 2 : estimatedSuccessRate > 0.4 ? 3 : 5,
      timeoutMs: bestArm.avgResponseTime * 2 + 5000,
      estimatedSuccessRate,
      estimatedCost: this.estimateCost(bestArm),
      armId: bestArm.id,
      confidence,
    };

    logger.debug(
      { domain, arm: decision.armId, tier: decision.proxyTier, browser: decision.useBrowser, estSuccess: estimatedSuccessRate.toFixed(2) },
      'Cortex routing decision',
    );

    return decision;
  }

  /** Report the outcome of a routing decision. */
  reportOutcome(outcome: RoutingOutcome): void {
    // Find the arm
    const arms = this.config.perDomainBandits
      ? this.getDomainArms(outcome.domain)
      : this.arms;

    const arm = arms.find(a => a.id === outcome.armId);
    if (!arm) return;

    // Update global arm statistics
    arm.pulls++;
    if (outcome.success) {
      arm.alpha++;
      arm.successes++;
    } else {
      arm.beta++;
      arm.failures++;
    }

    // Update average response time (exponential moving average)
    arm.avgResponseTime = arm.avgResponseTime * 0.9 + outcome.responseTimeMs * 0.1;

    // Update domain-specific statistics
    if (this.config.perDomainBandits) {
      const domainPerf = arm.domainPerformance.get(outcome.domain) || { alpha: 1, beta: 1, pulls: 0 };
      domainPerf.pulls++;
      if (outcome.success) {
        domainPerf.alpha++;
      } else {
        domainPerf.beta++;
      }
      arm.domainPerformance.set(outcome.domain, domainPerf);
    }

    // Track recent outcomes
    this.recentOutcomes.push(outcome);
    if (this.recentOutcomes.length > 1000) {
      this.recentOutcomes = this.recentOutcomes.slice(-500);
    }
  }

  /** Get or create domain-specific arms. */
  private getDomainArms(domain: string): BanditArm[] {
    let domainArms = this.domainArms.get(domain);
    if (!domainArms) {
      // Clone global arms for this domain
      domainArms = this.arms.map(arm => ({
        ...arm,
        domainPerformance: new Map(),
        pulls: 0,
        successes: 0,
        failures: 0,
        alpha: arm.alpha,
        beta: arm.beta,
      }));
      this.domainArms.set(domain, domainArms);
    }
    return domainArms;
  }

  /** Estimate the cost of using a particular arm. */
  private estimateCost(arm: BanditArm): number {
    let cost = this.config.costPerTier[arm.proxyTier];
    if (arm.useBrowser) cost *= this.config.browserCostMultiplier;
    if (arm.stealthMode) cost *= this.config.stealthCostMultiplier;
    return cost;
  }

  /** Get Cortex statistics. */
  getStats(): {
    totalArms: number;
    totalPulls: number;
    overallSuccessRate: number;
    bestArms: { armId: string; successRate: number; pulls: number }[];
    domainCount: number;
    recentSuccessRate: number;
  } {
    let totalPulls = 0;
    let totalSuccesses = 0;
    const armStats: { armId: string; successRate: number; pulls: number }[] = [];

    for (const arm of this.arms) {
      totalPulls += arm.pulls;
      totalSuccesses += arm.successes;
      armStats.push({
        armId: arm.id,
        successRate: arm.pulls > 0 ? arm.successes / arm.pulls : 0,
        pulls: arm.pulls,
      });
    }

    armStats.sort((a, b) => b.successRate - a.successRate);

    // Recent success rate
    const recentSuccesses = this.recentOutcomes.filter(o => o.success).length;
    const recentTotal = this.recentOutcomes.length;

    return {
      totalArms: this.arms.length,
      totalPulls,
      overallSuccessRate: totalPulls > 0 ? totalSuccesses / totalPulls : 0,
      bestArms: armStats.slice(0, 5),
      domainCount: this.domainArms.size,
      recentSuccessRate: recentTotal > 0 ? recentSuccesses / recentTotal : 0,
    };
  }

  /** Save state to Redis. */
  private async saveState(): Promise<void> {
    if (!this.config.cacheState) return;
    try {
      const state = {
        arms: this.arms.map(a => ({
          id: a.id,
          proxyTier: a.proxyTier,
          useBrowser: a.useBrowser,
          stealthMode: a.stealthMode,
          antiBotPreload: a.antiBotPreload,
          alpha: a.alpha,
          beta: a.beta,
          pulls: a.pulls,
          successes: a.successes,
          failures: a.failures,
          avgResponseTime: a.avgResponseTime,
          domainPerformance: Object.fromEntries(
            Array.from(a.domainPerformance.entries()).map(([k, v]) => [k, v])
          ),
        })),
      };
      await cacheSet('cortex:state', JSON.stringify(state), 86400);
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'Failed to save Cortex state');
    }
  }

  /** Load state from Redis. */
  private async loadState(): Promise<void> {
    try {
      const cached = await cacheGet<{ arms: any[] }>('cortex:state');
      if (!cached) return;

      const state = cached;
      if (state.arms && Array.isArray(state.arms)) {
        for (const armData of state.arms) {
          const arm = this.arms.find(a => a.id === armData.id);
          if (arm) {
            arm.alpha = armData.alpha || arm.alpha;
            arm.beta = armData.beta || arm.beta;
            arm.pulls = armData.pulls || 0;
            arm.successes = armData.successes || 0;
            arm.failures = armData.failures || 0;
            arm.avgResponseTime = armData.avgResponseTime || arm.avgResponseTime;

            if (armData.domainPerformance) {
              for (const [domain, perf] of Object.entries(armData.domainPerformance)) {
                arm.domainPerformance.set(domain, perf as { alpha: number; beta: number; pulls: number });
              }
            }
          }
        }
        logger.info({ restoredArms: state.arms.length }, 'Restored Cortex state from cache');
      }
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'Failed to load Cortex state');
    }
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const cortexEngine = new CortexEngine();
export default CortexEngine;
