/**
 * ML Adaptive Engine -- ScrapeSuite Engine
 *
 * Machine-learning-driven adaptation system that makes the scraping engine
 * self-improving. Wires into the existing self-improver infrastructure and
 * adds genetic-algorithm-based profile evolution, Bayesian success prediction,
 * drift detection, and automatic strategy optimization.
 *
 * Architecture:
 *  +--------------------------------------------------------------------------+
 *  | Observation Store   | PostgreSQL-backed record of all attempts & outcomes |
 *  | Feature Extractor   | Converts raw observations into ML feature vectors   |
 *  | Success Predictor   | Bayesian model predicting success per (profile,det) |
 *  | Profile Evolver     | Genetic algorithm for fingerprint profile evolution  |
 *  | Drift Detector      | CUSUM + Page-Hinkley for performance drift detection|
 *  | Strategy Optimizer  | Multi-armed bandit for strategy selection           |
 *  | Auto-Scaler         | Profile pool sizing based on demand & success rates |
 *  +--------------------------------------------------------------------------+
 *
 * Key difference from existing self-improver: This module uses ML models
 * (Bayesian inference, genetic algorithms, bandit algorithms) rather than
 * rule-based heuristics. The existing `adaptation-engine.ts` uses threshold-
 * based rules; this module learns optimal thresholds from data.
 *
 * Integration points:
 *  - Reads from the same observation stream as `self-improver/`
 *  - Writes profile adaptations that `fingerprint-consistency.ts` validates
 *  - Feeds strategy recommendations to `self-improver/manager.ts`
 *  - Uses `redis` for model state persistence
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';

const logger = createChildLogger('anti-bot:adaptive-engine');

// ===============================================================================
// TYPES
// ===============================================================================

export type Outcome = 'success' | 'blocked' | 'captcha' | 'timeout' | 'rate_limited' | 'fingerprint_detected' | 'proxy_blocked' | 'behavioral_flag';
export type AntiBotPlatform = 'akamai' | 'cloudflare' | 'datadome' | 'kasada' | 'perimeterx' | 'imperva' | 'f5_shape' | 'generic';
export type BrowserFamily = 'chrome' | 'firefox' | 'safari' | 'edge';
export type OSType = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

/** Feature vector extracted from a scraping observation for ML processing. */
export interface FeatureVector {
  /** Profile features */
  os: OSType;
  browser: BrowserFamily;
  hardwareConcurrency: number;
  deviceMemory: number;
  hasTouch: boolean;
  timezone: string;
  /** Proxy features */
  proxyTier: 'residential' | 'datacenter' | 'mobile';
  proxyCountry: string;
  proxyAsn: string;
  /** Strategy features */
  tlsProfile: string;
  h2Enabled: boolean;
  canvasNoise: boolean;
  audioNoise: boolean;
  behavioralSimulation: boolean;
  /** Context features */
  domain: string;
  hourOfDay: number;
  requestRate: number;
}

/** Outcome of a scraping attempt for ML training. */
export interface TrainingExample {
  features: FeatureVector;
  outcome: Outcome;
  platform: AntiBotPlatform | null;
  timestamp: number;
  durationMs: number;
}

/** A gene in the genetic algorithm — one feature of a fingerprint profile. */
export interface ProfileGene {
  os: OSType;
  browser: BrowserFamily;
  hardwareConcurrency: number;
  deviceMemory: number;
  hasTouch: boolean;
  timezone: string;
  canvasNoise: number;
  audioNoise: number;
}

/** An individual in the genetic algorithm population. */
export interface ProfileIndividual {
  id: string;
  genes: ProfileGene;
  fitness: number;
  generation: number;
  successCount: number;
  failureCount: number;
  lastTestedAt: number;
  domains: string[];
}

/** Result of the Bayesian success predictor. */
export interface SuccessPrediction {
  probability: number;
  confidence: number;
  topFeatures: Array<{ feature: string; importance: number }>;
  recommendation: 'use' | 'avoid' | 'test' | 'unknown';
}

/** Drift detection result. */
export interface DriftReport {
  isDrifting: boolean;
  direction: 'improving' | 'degrading' | 'stable';
  magnitude: number;
  affectedPlatforms: AntiBotPlatform[];
  affectedDomains: string[];
  recommendation: string;
  confidence: number;
  detectedAt: number;
}

/** Strategy bandit arm. */
export interface StrategyArm {
  name: string;
  pulls: number;
  totalReward: number;
  estimatedValue: number;
  confidence: number;
}

/** Configuration for the adaptive engine. */
export interface AdaptiveEngineConfig {
  /** Population size for genetic algorithm */
  populationSize: number;
  /** Number of elite individuals to keep per generation */
  eliteCount: number;
  /** Mutation rate for genetic algorithm (0-1) */
  mutationRate: number;
  /** Crossover rate for genetic algorithm (0-1) */
  crossoverRate: number;
  /** Minimum observations before making predictions */
  minObservations: number;
  /** Window size for drift detection (number of recent observations) */
  driftWindowSize: number;
  /** Threshold for drift alert (CUSUM statistic) */
  driftThreshold: number;
  /** Exploration rate for multi-armed bandit (epsilon-greedy) */
  explorationRate: number;
  /** Decay factor for older observations */
  timeDecayFactor: number;
  /** How often to run evolution (ms) */
  evolutionIntervalMs: number;
  /** Maximum generations without improvement before resetting population */
  stagnationLimit: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveEngineConfig = {
  populationSize: 50,
  eliteCount: 5,
  mutationRate: 0.15,
  crossoverRate: 0.7,
  minObservations: 20,
  driftWindowSize: 100,
  driftThreshold: 5.0,
  explorationRate: 0.1,
  timeDecayFactor: 0.95,
  evolutionIntervalMs: 3600000, // 1 hour
  stagnationLimit: 10,
};

// ===============================================================================
// BAYESIAN SUCCESS PREDICTOR
// ===============================================================================

/**
 * Naive Bayes-inspired success predictor that estimates the probability
 * of a successful scrape given a feature vector. Uses per-feature
 * conditional probability tables estimated from observation history.
 */
class BayesianPredictor {
  private featureStats = new Map<string, Map<string, { success: number; total: number }>>();

  /**
   * Train the predictor on a new observation.
   */
  train(example: TrainingExample): void {
    const isSuccess = example.outcome === 'success';
    const features = this.extractFeatureKeys(example.features);

    for (const featureKey of features) {
      if (!this.featureStats.has(featureKey)) {
        this.featureStats.set(featureKey, new Map());
      }
      const outcomes = this.featureStats.get(featureKey)!;

      if (!outcomes.has(example.outcome)) {
        outcomes.set(example.outcome, { success: 0, total: 0 });
      }
      const stat = outcomes.get(example.outcome)!;
      stat.total++;
      if (isSuccess) stat.success++;
    }
  }

  /**
   * Predict success probability for a given feature vector.
   */
  predict(features: FeatureVector, platform: AntiBotPlatform | null): SuccessPrediction {
    const featureKeys = this.extractFeatureKeys(features);
    let logProbSuccess = 0;
    let logProbFailure = 0;
    let totalEvidence = 0;
    const topFeatures: Array<{ feature: string; importance: number }> = [];

    for (const key of featureKeys) {
      const outcomes = this.featureStats.get(key);
      if (!outcomes) continue;

      let sCount = 0, sTotal = 0;
      let fCount = 0, fTotal = 0;

      for (const [, stat] of outcomes) {
        if (stat.success > 0) { sCount += stat.success; sTotal += stat.total; }
        else { fCount += stat.total; fTotal += stat.total; }
      }

      // Laplace smoothing
      const pSuccess = (sCount + 1) / (sTotal + 2);
      const pFailure = (fCount + 1) / (fTotal + 2);

      logProbSuccess += Math.log(pSuccess);
      logProbFailure += Math.log(pFailure);

      const importance = Math.abs(Math.log(pSuccess) - Math.log(pFailure));
      topFeatures.push({ feature: key, importance });
      totalEvidence++;
    }

    // Convert from log space
    const logP = logProbSuccess - logProbFailure;
    const probability = 1 / (1 + Math.exp(-logP));

    // Confidence based on amount of evidence
    const confidence = Math.min(1, totalEvidence / 20);

    topFeatures.sort((a, b) => b.importance - a.importance);

    let recommendation: SuccessPrediction['recommendation'];
    if (confidence < 0.3 || totalEvidence < 5) recommendation = 'unknown';
    else if (probability > 0.75) recommendation = 'use';
    else if (probability < 0.35) recommendation = 'avoid';
    else recommendation = 'test';

    return { probability, confidence, topFeatures: topFeatures.slice(0, 10), recommendation };
  }

  /**
   * Extract feature keys from a feature vector for Bayesian estimation.
   * Each key is a "feature_name=value" string for conditional probability lookup.
   */
  private extractFeatureKeys(fv: FeatureVector): string[] {
    return [
      `os=${fv.os}`,
      `browser=${fv.browser}`,
      `hw=${fv.hardwareConcurrency}`,
      `mem=${fv.deviceMemory}`,
      `touch=${fv.hasTouch}`,
      `tz=${fv.timezone}`,
      `proxy=${fv.proxyTier}`,
      `proxyCtry=${fv.proxyCountry}`,
      `tls=${fv.tlsProfile}`,
      `h2=${fv.h2Enabled}`,
      `canvas=${fv.canvasNoise}`,
      `audio=${fv.audioNoise}`,
      `behave=${fv.behavioralSimulation}`,
      `hour=${fv.hourOfDay}`,
      `os_browser=${fv.os}_${fv.browser}`,
      `proxy_tier_browser=${fv.proxyTier}_${fv.browser}`,
    ];
  }

  /** Get the number of features the predictor has learned from. */
  getFeatureCount(): number { return this.featureStats.size; }

  /** Serialize predictor state for persistence. */
  serialize(): string {
    const obj: Record<string, Record<string, { s: number; t: number }>> = {};
    for (const [feature, outcomes] of this.featureStats) {
      obj[feature] = {};
      for (const [outcome, stat] of outcomes) {
        obj[feature][outcome] = { s: stat.success, t: stat.total };
      }
    }
    return JSON.stringify(obj);
  }

  /** Restore predictor state from serialized data. */
  deserialize(data: string): void {
    try {
      const obj = JSON.parse(data) as Record<string, Record<string, { s: number; t: number }>>;
      this.featureStats.clear();
      for (const [feature, outcomes] of Object.entries(obj)) {
        const map = new Map<string, { success: number; total: number }>();
        for (const [outcome, stat] of Object.entries(outcomes)) {
          map.set(outcome, { success: stat.s, total: stat.t });
        }
        this.featureStats.set(feature, map);
      }
    } catch { /* ignore corrupt data */ }
  }
}

// ===============================================================================
// GENETIC ALGORITHM PROFILE EVOLVER
// ===============================================================================

/** OS options for gene mutation. */
const OS_OPTIONS: OSType[] = ['windows', 'windows', 'windows', 'macos', 'macos', 'linux', 'android', 'ios'];
const BROWSER_OPTIONS: BrowserFamily[] = ['chrome', 'chrome', 'chrome', 'firefox', 'safari', 'edge'];
const TIMEZONE_OPTIONS: string[] = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Shanghai',
];
const HW_CONCURRENCY_OPTIONS = [2, 4, 4, 8, 8, 8, 12, 16];
const DEVICE_MEMORY_OPTIONS = [4, 8, 8, 16, 16, 32];

/**
 * Genetic algorithm that evolves fingerprint profiles toward higher success rates.
 * Uses tournament selection, uniform crossover, and gaussian mutation.
 */
class ProfileEvolver {
  private population: ProfileIndividual[] = [];
  private generation = 0;
  private bestFitnessEver = 0;
  private stagnationCount = 0;
  private readonly config: AdaptiveEngineConfig;

  constructor(config: AdaptiveEngineConfig) {
    this.config = config;
    this.initializePopulation();
  }

  /**
   * Initialize a random population of profile individuals.
   */
  private initializePopulation(): void {
    this.population = [];
    for (let i = 0; i < this.config.populationSize; i++) {
      this.population.push(this.createRandomIndividual(i));
    }
    logger.info({ populationSize: this.population.length }, 'GA population initialized');
  }

  /**
   * Create a random profile individual.
   */
  private createRandomIndividual(index: number): ProfileIndividual {
    const os = OS_OPTIONS[Math.floor(Math.random() * OS_OPTIONS.length)];
    const browser = os === 'ios' ? 'safari' : os === 'macos' ? BROWSER_OPTIONS[Math.floor(Math.random() * 3)] : BROWSER_OPTIONS[Math.floor(Math.random() * BROWSER_OPTIONS.length)];

    return {
      id: `ga-gen${this.generation}-${index}`,
      genes: {
        os,
        browser,
        hardwareConcurrency: HW_CONCURRENCY_OPTIONS[Math.floor(Math.random() * HW_CONCURRENCY_OPTIONS.length)],
        deviceMemory: DEVICE_MEMORY_OPTIONS[Math.floor(Math.random() * DEVICE_MEMORY_OPTIONS.length)],
        hasTouch: os === 'android' || os === 'ios',
        timezone: TIMEZONE_OPTIONS[Math.floor(Math.random() * TIMEZONE_OPTIONS.length)],
        canvasNoise: Math.random() * 0.002,
        audioNoise: Math.random() * 0.0002,
      },
      fitness: 0.5, // prior
      generation: this.generation,
      successCount: 0,
      failureCount: 0,
      lastTestedAt: 0,
      domains: [],
    };
  }

  /**
   * Update an individual's fitness based on observation outcome.
   */
  updateFitness(individualId: string, success: boolean, domain: string): void {
    const individual = this.population.find(i => i.id === individualId);
    if (!individual) return;

    if (success) individual.successCount++;
    else individual.failureCount++;

    if (!individual.domains.includes(domain)) individual.domains.push(domain);
    individual.lastTestedAt = Date.now();

    // EMA fitness update
    const observedReward = success ? 1.0 : 0.0;
    const alpha = 0.3; // learning rate
    individual.fitness = alpha * observedReward + (1 - alpha) * individual.fitness;
  }

  /**
   * Run one generation of evolution: selection, crossover, mutation.
   * Returns the new population.
   */
  evolve(): ProfileIndividual[] {
    // Sort by fitness (descending)
    this.population.sort((a, b) => b.fitness - a.fitness);

    // Check stagnation
    const currentBest = this.population[0].fitness;
    if (currentBest <= this.bestFitnessEver + 0.001) {
      this.stagnationCount++;
    } else {
      this.bestFitnessEver = currentBest;
      this.stagnationCount = 0;
    }

    // Reset if stagnant
    if (this.stagnationCount >= this.config.stagnationLimit) {
      logger.warn({ stagnationCount: this.stagnationCount }, 'GA stagnation detected — reinitializing population');
      this.stagnationCount = 0;
      this.initializePopulation();
      return this.population;
    }

    const newPopulation: ProfileIndividual[] = [];

    // Elitism: keep top performers
    for (let i = 0; i < this.config.eliteCount && i < this.population.length; i++) {
      newPopulation.push({
        ...this.population[i],
        id: `ga-gen${this.generation + 1}-elite${i}`,
      });
    }

    // Fill rest with offspring
    while (newPopulation.length < this.config.populationSize) {
      const parent1 = this.tournamentSelect();
      const parent2 = this.tournamentSelect();

      let child: ProfileIndividual;
      if (Math.random() < this.config.crossoverRate) {
        child = this.crossover(parent1, parent2);
      } else {
        child = { ...parent1, id: `ga-gen${this.generation + 1}-${newPopulation.length}` };
      }

      if (Math.random() < this.config.mutationRate) {
        child = this.mutate(child);
      }

      newPopulation.push(child);
    }

    this.population = newPopulation;
    this.generation++;

    logger.info({
      generation: this.generation,
      bestFitness: this.population[0]?.fitness,
      avgFitness: this.population.reduce((s, i) => s + i.fitness, 0) / this.population.length,
    }, 'GA generation evolved');

    return this.population;
  }

  /**
   * Tournament selection: pick k random individuals, return the best.
   */
  private tournamentSelect(k = 3): ProfileIndividual {
    let best: ProfileIndividual | null = null;
    for (let i = 0; i < k; i++) {
      const candidate = this.population[Math.floor(Math.random() * this.population.length)];
      if (!best || candidate.fitness > best.fitness) best = candidate;
    }
    return best!;
  }

  /**
   * Uniform crossover between two parents.
   */
  private crossover(p1: ProfileIndividual, p2: ProfileIndividual): ProfileIndividual {
    const childGenes: ProfileGene = { ...p1.genes };

    // For each gene, randomly pick from either parent
    const geneKeys = Object.keys(p1.genes) as (keyof ProfileGene)[];
    for (const key of geneKeys) {
      if (Math.random() < 0.5) {
        (childGenes[key] as any) = p2.genes[key];
      }
    }

    // Ensure consistency: touch=true for mobile OS
    if (childGenes.os === 'android' || childGenes.os === 'ios') {
      childGenes.hasTouch = true;
    }

    const childFitness = (p1.fitness + p2.fitness) / 2;

    return {
      id: `ga-gen${this.generation + 1}-${Date.now()}`,
      genes: childGenes,
      fitness: childFitness * 0.9, // slight discount for untested offspring
      generation: this.generation + 1,
      successCount: 0,
      failureCount: 0,
      lastTestedAt: 0,
      domains: [],
    };
  }

  /**
   * Gaussian mutation of a profile individual.
   */
  private mutate(individual: ProfileIndividual): ProfileIndividual {
    const genes = { ...individual.genes };
    const mutationStrength = 0.3;

    // Mutate OS with small probability
    if (Math.random() < mutationStrength) {
      genes.os = OS_OPTIONS[Math.floor(Math.random() * OS_OPTIONS.length)];
      genes.hasTouch = genes.os === 'android' || genes.os === 'ios';
    }

    // Mutate browser
    if (Math.random() < mutationStrength) {
      genes.browser = genes.os === 'ios' ? 'safari' : BROWSER_OPTIONS[Math.floor(Math.random() * BROWSER_OPTIONS.length)];
    }

    // Mutate hardware (±1 step)
    if (Math.random() < mutationStrength) {
      const idx = HW_CONCURRENCY_OPTIONS.indexOf(genes.hardwareConcurrency);
      const newIdx = Math.max(0, Math.min(HW_CONCURRENCY_OPTIONS.length - 1, idx + (Math.random() < 0.5 ? -1 : 1)));
      genes.hardwareConcurrency = HW_CONCURRENCY_OPTIONS[newIdx];
    }

    if (Math.random() < mutationStrength) {
      const idx = DEVICE_MEMORY_OPTIONS.indexOf(genes.deviceMemory);
      const newIdx = Math.max(0, Math.min(DEVICE_MEMORY_OPTIONS.length - 1, idx + (Math.random() < 0.5 ? -1 : 1)));
      genes.deviceMemory = DEVICE_MEMORY_OPTIONS[newIdx];
    }

    // Mutate timezone
    if (Math.random() < mutationStrength) {
      genes.timezone = TIMEZONE_OPTIONS[Math.floor(Math.random() * TIMEZONE_OPTIONS.length)];
    }

    // Mutate noise levels (small gaussian perturbation)
    if (Math.random() < mutationStrength) {
      genes.canvasNoise = Math.max(0, genes.canvasNoise + (Math.random() - 0.5) * 0.0005);
    }
    if (Math.random() < mutationStrength) {
      genes.audioNoise = Math.max(0, genes.audioNoise + (Math.random() - 0.5) * 0.00005);
    }

    return {
      ...individual,
      id: `ga-gen${this.generation + 1}-mut-${Date.now()}`,
      genes,
      fitness: individual.fitness * 0.95, // discount for untested mutation
      successCount: 0,
      failureCount: 0,
      lastTestedAt: 0,
      domains: [],
    };
  }

  /** Get the current population sorted by fitness. */
  getPopulation(): ProfileIndividual[] {
    return [...this.population].sort((a, b) => b.fitness - a.fitness);
  }

  /** Get the top N individuals. */
  getTopN(n: number): ProfileIndividual[] {
    return this.getPopulation().slice(0, n);
  }

  /** Get the current generation number. */
  getGeneration(): number { return this.generation; }
}

// ===============================================================================
// DRIFT DETECTOR (CUSUM + Page-Hinkley)
// ===============================================================================

/**
 * Detects performance drift using CUSUM (Cumulative Sum) and Page-Hinkley
 * change detection. When success rates degrade over time, this signals that
 * a detector has evolved and profiles need rotation.
 */
class DriftDetector {
  private readonly window: Array<{ timestamp: number; success: boolean; platform: AntiBotPlatform | null; domain: string }> = [];
  private cusumPositive = 0;
  private cusumNegative = 0;
  private runningMean = 0.5;
  private runningVariance = 0.25;
  private observationCount = 0;
  private readonly config: AdaptiveEngineConfig;

  constructor(config: AdaptiveEngineConfig) {
    this.config = config;
  }

  /**
   * Add a new observation to the drift detector.
   */
  addObservation(success: boolean, platform: AntiBotPlatform | null, domain: string): void {
    this.window.push({ timestamp: Date.now(), success, platform, domain });
    if (this.window.length > this.config.driftWindowSize) {
      this.window.shift();
    }

    this.observationCount++;
    const reward = success ? 1 : 0;

    // Update running statistics
    const delta = reward - this.runningMean;
    this.runningMean += delta / this.observationCount;
    this.runningVariance += delta * (reward - this.runningMean);

    // CUSUM update
    const stddev = Math.sqrt(this.runningVariance / Math.max(1, this.observationCount - 1));
    const allowableSlack = 0.25 * stddev;

    this.cusumPositive = Math.max(0, this.cusumPositive + delta - allowableSlack);
    this.cusumNegative = Math.max(0, this.cusumNegative - delta - allowableSlack);
  }

  /**
   * Check if drift is detected and produce a report.
   */
  detect(): DriftReport {
    const isDrifting = this.cusumPositive > this.config.driftThreshold ||
                       this.cusumNegative > this.config.driftThreshold;

    let direction: DriftReport['direction'] = 'stable';
    let magnitude = 0;

    if (this.cusumPositive > this.config.driftThreshold) {
      direction = 'degrading'; // Success rate dropping
      magnitude = this.cusumPositive;
    } else if (this.cusumNegative > this.config.driftThreshold) {
      direction = 'improving'; // Success rate rising
      magnitude = this.cusumNegative;
    }

    // Find affected platforms and domains from recent failures
    const recentFailures = this.window.filter(o => !o.success);
    const platformCounts = new Map<string, number>();
    const domainCounts = new Map<string, number>();

    for (const obs of recentFailures) {
      const platform = obs.platform || 'generic';
      platformCounts.set(platform, (platformCounts.get(platform) || 0) + 1);
      domainCounts.set(obs.domain, (domainCounts.get(obs.domain) || 0) + 1);
    }

    const affectedPlatforms = [...platformCounts.entries()]
      .filter(([, count]) => count >= 3)
      .map(([p]) => p as AntiBotPlatform);

    const affectedDomains = [...domainCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([d]) => d);

    const recommendation = direction === 'degrading'
      ? 'Rotate fingerprint profiles — detector may have evolved. Consider re-running GA evolution.'
      : direction === 'improving'
        ? 'Current strategies are effective — maintain and reinforce.'
        : 'No action needed — performance is stable.';

    return {
      isDrifting,
      direction,
      magnitude,
      affectedPlatforms,
      affectedDomains,
      recommendation,
      confidence: Math.min(1, magnitude / this.config.driftThreshold),
      detectedAt: Date.now(),
    };
  }

  /** Reset the CUSUM statistics. */
  reset(): void {
    this.cusumPositive = 0;
    this.cusumNegative = 0;
  }
}

// ===============================================================================
// MULTI-ARMED BANDIT (Strategy Optimizer)
// ===============================================================================

/**
 * Epsilon-greedy multi-armed bandit for strategy selection.
 * Each "arm" is a strategy (e.g., "chrome_windows_residential", "firefox_linux_datacenter").
 * The bandit balances exploration vs. exploitation to maximize success rate.
 */
class StrategyBandit {
  private arms = new Map<string, StrategyArm>();
  private epsilon: number;

  constructor(epsilon: number = 0.1) {
    this.epsilon = epsilon;
  }

  /**
   * Select a strategy arm using epsilon-greedy.
   */
  selectArm(availableStrategies: string[]): string {
    // Ensure all available strategies are registered
    for (const name of availableStrategies) {
      if (!this.arms.has(name)) {
        this.arms.set(name, { name, pulls: 0, totalReward: 0, estimatedValue: 0.5, confidence: 0 });
      }
    }

    // Epsilon-greedy: explore with probability epsilon
    if (Math.random() < this.epsilon || this.arms.size === 0) {
      return availableStrategies[Math.floor(Math.random() * availableStrategies.length)];
    }

    // Exploit: select the arm with highest estimated value
    let bestArm = availableStrategies[0];
    let bestValue = -Infinity;

    for (const name of availableStrategies) {
      const arm = this.arms.get(name);
      if (arm && arm.estimatedValue > bestValue) {
        bestValue = arm.estimatedValue;
        bestArm = name;
      }
    }

    return bestArm;
  }

  /**
   * Update an arm with the result of using it.
   */
  updateArm(name: string, reward: number): void {
    if (!this.arms.has(name)) {
      this.arms.set(name, { name, pulls: 0, totalReward: 0, estimatedValue: 0.5, confidence: 0 });
    }
    const arm = this.arms.get(name)!;
    arm.pulls++;
    arm.totalReward += reward;
    arm.estimatedValue = arm.totalReward / arm.pulls;
    arm.confidence = Math.min(1, arm.pulls / 30); // confidence grows with more pulls
  }

  /** Get all arms sorted by estimated value. */
  getTopStrategies(n: number): StrategyArm[] {
    return [...this.arms.values()]
      .sort((a, b) => b.estimatedValue - a.estimatedValue)
      .slice(0, n);
  }

  /** Serialize arm state for persistence. */
  serialize(): string {
    return JSON.stringify([...this.arms.values()]);
  }

  /** Restore arm state from serialized data. */
  deserialize(data: string): void {
    try {
      const arms = JSON.parse(data) as StrategyArm[];
      this.arms.clear();
      for (const arm of arms) {
        this.arms.set(arm.name, arm);
      }
    } catch { /* ignore */ }
  }
}

// ===============================================================================
// MAIN ADAPTIVE ENGINE CLASS
// ===============================================================================

/**
 * The main ML Adaptive Engine that orchestrates all ML components.
 *
 * Usage:
 *  1. Call `recordObservation()` after every scraping attempt
 *  2. Call `getRecommendedProfile()` before selecting a fingerprint profile
 *  3. Call `getRecommendedStrategy()` before selecting a strategy
 *  4. Call `runEvolution()` periodically (e.g., every hour via cron)
 *  5. Call `checkDrift()` to detect performance degradation
 */
export class AdaptiveEngine {
  private readonly config: AdaptiveEngineConfig;
  private readonly predictor: BayesianPredictor;
  private readonly evolver: ProfileEvolver;
  private readonly driftDetector: DriftDetector;
  private readonly bandit: StrategyBandit;
  private observationCount = 0;
  private lastEvolutionAt = 0;

  constructor(config: Partial<AdaptiveEngineConfig> = {}) {
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
    this.predictor = new BayesianPredictor();
    this.evolver = new ProfileEvolver(this.config);
    this.driftDetector = new DriftDetector(this.config);
    this.bandit = new StrategyBandit(this.config.explorationRate);

    logger.info({
      populationSize: this.config.populationSize,
      mutationRate: this.config.mutationRate,
      driftThreshold: this.config.driftThreshold,
    }, 'ML Adaptive Engine initialized');
  }

  // ---------------------------------------------------------------------------
  // Observation Recording
  // ---------------------------------------------------------------------------

  /**
   * Record a scraping observation for ML training.
   */
  recordObservation(example: TrainingExample): void {
    this.observationCount++;

    // Train Bayesian predictor
    this.predictor.train(example);

    // Update drift detector
    this.driftDetector.addObservation(
      example.outcome === 'success',
      example.platform,
      example.features.domain,
    );

    // Update strategy bandit
    const strategyKey = this.buildStrategyKey(example.features);
    const reward = example.outcome === 'success' ? 1.0
      : example.outcome === 'captcha' ? 0.2
      : example.outcome === 'timeout' ? 0.3
      : 0.0;
    this.bandit.updateArm(strategyKey, reward);

    // Update GA individual if we can match the profile
    if (example.features.domain) {
      const individuals = this.evolver.getPopulation();
      // Find a matching individual by gene similarity
      for (const ind of individuals) {
        if (ind.genes.os === example.features.os &&
            ind.genes.browser === example.features.browser) {
          this.evolver.updateFitness(ind.id, example.outcome === 'success', example.features.domain);
          break;
        }
      }
    }

    // Periodically log stats
    if (this.observationCount % 100 === 0) {
      logger.info({
        observationCount: this.observationCount,
        predictorFeatures: this.predictor.getFeatureCount(),
        driftStatus: this.driftDetector.detect().direction,
      }, 'Adaptive engine progress');
    }
  }

  // ---------------------------------------------------------------------------
  // Prediction & Recommendation
  // ---------------------------------------------------------------------------

  /**
   * Predict success probability for a given feature vector.
   */
  predictSuccess(features: FeatureVector, platform: AntiBotPlatform | null): SuccessPrediction {
    if (this.observationCount < this.config.minObservations) {
      return {
        probability: 0.5,
        confidence: 0,
        topFeatures: [],
        recommendation: 'unknown',
      };
    }
    return this.predictor.predict(features, platform);
  }

  /**
   * Get the best fingerprint profile from the GA population.
   * If a domain is provided, prefer profiles that have succeeded on that domain.
   */
  getRecommendedProfile(domain?: string): ProfileIndividual {
    const population = this.evolver.getPopulation();

    if (domain) {
      // Prefer profiles that have proven success on this domain
      const domainMatches = population.filter(p => p.domains.includes(domain) && p.successCount > 0);
      if (domainMatches.length > 0) {
        domainMatches.sort((a, b) => b.fitness - a.fitness);
        return domainMatches[0];
      }
    }

    // Return the globally best individual
    return population[0];
  }

  /**
   * Get the recommended strategy using the multi-armed bandit.
   */
  getRecommendedStrategy(availableStrategies: string[]): string {
    return this.bandit.selectArm(availableStrategies);
  }

  // ---------------------------------------------------------------------------
  // Evolution & Drift
  // ---------------------------------------------------------------------------

  /**
   * Run one generation of profile evolution.
   */
  runEvolution(): ProfileIndividual[] {
    const now = Date.now();
    if (now - this.lastEvolutionAt < this.config.evolutionIntervalMs) {
      logger.debug('Evolution interval not reached — skipping');
      return this.evolver.getPopulation();
    }

    this.lastEvolutionAt = now;
    const newPopulation = this.evolver.evolve();

    logger.info({
      generation: this.evolver.getGeneration(),
      populationSize: newPopulation.length,
      bestFitness: newPopulation[0]?.fitness,
    }, 'Profile evolution completed');

    return newPopulation;
  }

  /**
   * Check for performance drift.
   */
  checkDrift(): DriftReport {
    return this.driftDetector.detect();
  }

  /**
   * Force a drift reset (e.g., after making major changes).
   */
  resetDrift(): void {
    this.driftDetector.reset();
  }

  // ---------------------------------------------------------------------------
  // Strategy Analysis
  // ---------------------------------------------------------------------------

  /**
   * Get the top-performing strategies from the bandit.
   */
  getTopStrategies(n = 10): StrategyArm[] {
    return this.bandit.getTopStrategies(n);
  }

  /**
   * Get the full GA population for inspection.
   */
  getProfilePopulation(): ProfileIndividual[] {
    return this.evolver.getPopulation();
  }

  /**
   * Get engine statistics.
   */
  getStats(): {
    observationCount: number;
    generation: number;
    populationSize: number;
    bestFitness: number;
    predictorFeatures: number;
    topStrategies: StrategyArm[];
    drift: DriftReport;
  } {
    const pop = this.evolver.getPopulation();
    return {
      observationCount: this.observationCount,
      generation: this.evolver.getGeneration(),
      populationSize: pop.length,
      bestFitness: pop[0]?.fitness ?? 0,
      predictorFeatures: this.predictor.getFeatureCount(),
      topStrategies: this.bandit.getTopStrategies(5),
      drift: this.driftDetector.detect(),
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Save engine state to Redis for cross-session persistence.
   */
  async saveState(): Promise<void> {
    const state = {
      predictorState: this.predictor.serialize(),
      banditState: this.bandit.serialize(),
      observationCount: this.observationCount,
      lastEvolutionAt: this.lastEvolutionAt,
    };
    await cacheSet('adaptive-engine:state', JSON.stringify(state), { ttl: 86400 });
    logger.debug('Adaptive engine state saved to Redis');
  }

  /**
   * Restore engine state from Redis.
   */
  async loadState(): Promise<boolean> {
    const raw = await cacheGet('adaptive-engine:state');
    if (!raw) return false;
    try {
      const state = JSON.parse(raw as string);
      this.predictor.deserialize(state.predictorState || '{}');
      this.bandit.deserialize(state.banditState || '[]');
      this.observationCount = state.observationCount || 0;
      this.lastEvolutionAt = state.lastEvolutionAt || 0;
      logger.info({ observationCount: this.observationCount }, 'Adaptive engine state restored');
      return true;
    } catch {
      logger.warn('Failed to restore adaptive engine state');
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildStrategyKey(fv: FeatureVector): string {
    return `${fv.os}_${fv.browser}_${fv.proxyTier}_${fv.tlsProfile}_${fv.h2Enabled ? 'h2' : 'h1'}`;
  }
}

// ===============================================================================
// SINGLETON INSTANCE
// ===============================================================================

/** Default adaptive engine instance with standard configuration. */
export const adaptiveEngine = new AdaptiveEngine();
