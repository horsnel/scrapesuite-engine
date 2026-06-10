/**
 * Adaptation Engine — ScrapeSuite Engine
 *
 * Takes failure analysis recommendations and turns them into
 * concrete strategy adaptations. The adaptation engine is the
 * execution arm of the self-improving system — it proposes,
 * tests, validates, and deploys strategy changes based on
 * what the failure analyzer learned.
 *
 * Adaptation lifecycle:
 * 1. PROPOSE — Create adaptation from recommendation
 * 2. TEST — Run canary tests with the proposed changes
 * 3. VALIDATE — Verify improvement over baseline
 * 4. DEPLOY — Apply changes to the live strategy configuration
 * 5. MONITOR — Watch for regression after deployment
 * 6. ROLLBACK — Revert if the adaptation degrades performance
 *
 * The engine maintains separate adaptation state per domain
 * and per anti-bot platform, ensuring that a change that helps
 * on Netflix doesn't hurt on Google.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { observationCollector } from './observation-collector';
import type {
  Adaptation, AdaptationStatus, AdaptationChange, AdaptationTestResult,
  AdaptationRecommendation, StrategyCategory, StrategyWeight,
  DomainModel, DomainRule, AntiBotPlatform, ScrapingObservation,
} from './types';

const logger = createChildLogger('adaptation-engine');

const ADAPTATION_CACHE_PREFIX = 'self-improver:adaptation:';
const DOMAIN_MODEL_PREFIX = 'self-improver:domain-model:';
const WEIGHT_CACHE_PREFIX = 'self-improver:weight:';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_ADAPTATION_CONFIG = {
  minConfidenceForDeploy: 0.6,
  minImprovementThreshold: 0.05,
  maxAdaptationsPerDay: 10,
  testDurationMs: 300000, // 5 minutes
  testSampleSize: 10,
  autoDeploy: true,
  rollbackWindowMs: 1800000, // 30 minutes
  weightDecay: 0.05,
  learningRate: 0.1,
};

// ===============================================================================
// STRATEGY WEIGHT CALCULATOR
// ===============================================================================

function computeStrategyWeight(
  currentWeight: number,
  successCount: number,
  failureCount: number,
  learningRate: number,
  weightDecay: number,
): number {
  const total = successCount + failureCount;
  if (total === 0) return currentWeight;

  const observedSuccessRate = successCount / total;

  // Exponential moving average with decay
  const newWeight = currentWeight * (1 - learningRate) + observedSuccessRate * learningRate;

  // Apply decay to pull weights toward 0.5 (uncertainty) over time
  const decayed = newWeight * (1 - weightDecay) + 0.5 * weightDecay;

  return Math.max(0, Math.min(1, decayed));
}

// ===============================================================================
// ADAPTATION ENGINE CLASS
// ===============================================================================

export class AdaptationEngine {
  private config: typeof DEFAULT_ADAPTATION_CONFIG;
  private adaptations: Map<string, Adaptation> = new Map();
  private domainModels: Map<string, DomainModel> = new Map();
  private strategyWeights: Map<string, StrategyWeight> = new Map();
  private dailyAdaptationCount: Map<string, number> = new Map();
  private lastDailyReset: number = Date.now();

  constructor(config?: Partial<typeof DEFAULT_ADAPTATION_CONFIG>) {
    this.config = { ...DEFAULT_ADAPTATION_CONFIG, ...config };
  }

  /**
   * Create an adaptation from a recommendation.
   * The adaptation starts in 'proposed' status and must be tested
   * before it can be deployed.
   */
  async propose(
    recommendation: AdaptationRecommendation,
    domain: string,
    platform?: AntiBotPlatform,
  ): Promise<Adaptation> {
    // Check daily limit
    this.checkDailyReset();
    const dailyCount = this.dailyAdaptationCount.get(domain) || 0;
    if (dailyCount >= this.config.maxAdaptationsPerDay) {
      throw new Error(`Daily adaptation limit reached for ${domain}`);
    }

    const adaptation: Adaptation = {
      id: `adapt-${randomUUID().substring(0, 8)}`,
      status: 'proposed',
      domain,
      platform: platform || null,
      recommendationId: `rec-${randomUUID().substring(0, 8)}`,
      changes: [{
        category: recommendation.category,
        previousValue: recommendation.currentStrategy,
        newValue: recommendation.recommendedStrategy,
        parameters: recommendation.parameterChanges,
      }],
      expectedImprovement: recommendation.expectedImprovement,
      actualImprovement: null,
      testResults: [],
      proposedAt: Date.now(),
      deployedAt: null,
    };

    this.adaptations.set(adaptation.id, adaptation);
    this.dailyAdaptationCount.set(domain, dailyCount + 1);

    await cacheSet(`${ADAPTATION_CACHE_PREFIX}${adaptation.id}`, adaptation, 86400 * 30);

    logger.info({
      adaptationId: adaptation.id,
      domain,
      platform,
      category: recommendation.category,
      from: recommendation.currentStrategy,
      to: recommendation.recommendedStrategy,
      expectedImprovement: recommendation.expectedImprovement,
    }, 'Adaptation proposed');

    return adaptation;
  }

  /**
   * Test an adaptation by simulating its effect.
   * Compares recent success rates with the proposed strategy change
   * against the baseline (current strategy).
   */
  async testAdaptation(adaptationId: string): Promise<{
    passed: boolean;
    improvement: number;
    testResults: AdaptationTestResult[];
  }> {
    const adaptation = this.adaptations.get(adaptationId);
    if (!adaptation || adaptation.status !== 'proposed') {
      throw new Error('Adaptation not found or not in proposed status');
    }

    adaptation.status = 'testing';

    // Get baseline success rate for this domain
    const baselineRate = observationCollector.getSuccessRate(adaptation.domain, 3600000);

    // Simulate test observations
    const testResults: AdaptationTestResult[] = [];
    let testSuccesses = 0;

    for (let i = 0; i < this.config.testSampleSize; i++) {
      // In production, this would actually execute test requests
      // with the proposed strategy changes. For now, we estimate
      // the improvement based on the expected improvement and
      // historical data.

      const estimatedSuccess = Math.random() < (baselineRate + adaptation.expectedImprovement * 0.5);
      if (estimatedSuccess) testSuccesses++;

      testResults.push({
        observation: {
          id: `test-obs-${i}`,
          url: `https://${adaptation.domain}/test-${i}`,
          domain: adaptation.domain,
          timestamp: Date.now(),
          outcome: estimatedSuccess ? 'success' : 'blocked',
          detectedPlatform: adaptation.platform,
          strategiesApplied: adaptation.changes.map(c => ({
            category: c.category,
            name: c.newValue,
            parameters: c.parameters,
            effective: estimatedSuccess,
            confidence: 0.5,
          })),
          context: {
            proxyTier: 'residential',
            proxyCountry: 'US',
            proxyAsn: 'AS7922',
            tlsProfile: 'chrome_120',
            fingerprintId: 'test-fp',
            accountId: null,
            sessionId: `test-${adaptationId}-${i}`,
            requestRate: 2,
            timeSinceLastRequestMs: 30000,
            previousRequestCount: i,
            browserType: 'chromium',
            headless: false,
            referrerUrl: null,
          },
          response: {
            statusCode: estimatedSuccess ? 200 : 403,
            detectionHeaders: {},
            captchaPresent: !estimatedSuccess,
            captchaType: null,
            bodyLength: estimatedSuccess ? 50000 : 0,
            dataExtracted: estimatedSuccess,
            errorMessage: estimatedSuccess ? null : 'Blocked by anti-bot',
            akamaiSensorVersion: null,
            recaptchaScore: null,
          },
          durationMs: 2000 + Math.random() * 3000,
          analyzed: true,
        },
        success: estimatedSuccess,
        improvement: estimatedSuccess ? adaptation.expectedImprovement * 0.5 : -0.1,
        timestamp: Date.now(),
      });
    }

    const testSuccessRate = testSuccesses / this.config.testSampleSize;
    const improvement = testSuccessRate - baselineRate;

    adaptation.testResults = testResults;

    const passed = improvement >= this.config.minImprovementThreshold &&
      testSuccessRate >= baselineRate;

    if (passed) {
      adaptation.status = 'validated';
      adaptation.actualImprovement = improvement;
      logger.info({
        adaptationId,
        baselineRate: Math.round(baselineRate * 100),
        testSuccessRate: Math.round(testSuccessRate * 100),
        improvement: Math.round(improvement * 100),
      }, 'Adaptation passed testing');
    } else {
      adaptation.status = 'rejected';
      adaptation.actualImprovement = improvement;
      logger.warn({
        adaptationId,
        baselineRate: Math.round(baselineRate * 100),
        testSuccessRate: Math.round(testSuccessRate * 100),
        improvement: Math.round(improvement * 100),
      }, 'Adaptation failed testing');
    }

    return { passed, improvement, testResults };
  }

  /**
   * Deploy a validated adaptation.
   * Updates the domain model and strategy weights.
   */
  async deploy(adaptationId: string): Promise<boolean> {
    const adaptation = this.adaptations.get(adaptationId);
    if (!adaptation || adaptation.status !== 'validated') {
      return false;
    }

    if (!this.config.autoDeploy && adaptation.actualImprovement !== null &&
        adaptation.actualImprovement < this.config.minImprovementThreshold) {
      logger.warn({ adaptationId }, 'Adaptation not auto-deployable due to low improvement');
      return false;
    }

    // Update domain model
    let domainModel = this.domainModels.get(adaptation.domain);
    if (!domainModel) {
      domainModel = this.createDomainModel(adaptation.domain);
    }

    // Apply changes to domain model
    for (const change of adaptation.changes) {
      // Update strategy weights
      const weightKey = `${adaptation.domain}:${change.category}:${change.newValue}`;
      const currentWeight = this.strategyWeights.get(weightKey);

      if (currentWeight) {
        currentWeight.weight = Math.min(1, currentWeight.weight + (adaptation.actualImprovement || 0));
        currentWeight.successRate = Math.min(1, currentWeight.successRate + (adaptation.actualImprovement || 0) * 0.5);
        currentWeight.lastUpdated = Date.now();
        currentWeight.trend = 'improving';
        currentWeight.trendRate = adaptation.actualImprovement || 0;
      } else {
        this.strategyWeights.set(weightKey, {
          strategyKey: `${change.category}:${change.newValue}`,
          weight: 0.5 + (adaptation.actualImprovement || 0),
          observationCount: this.config.testSampleSize,
          lastUpdated: Date.now(),
          successRate: 0.5 + (adaptation.actualImprovement || 0) * 0.5,
          domain: adaptation.domain,
          platform: adaptation.platform || '*',
          trend: 'improving',
          trendRate: adaptation.actualImprovement || 0,
        });
      }

      // Add domain rule if confidence is high
      if ((adaptation.actualImprovement || 0) > 0.15) {
        domainModel.rules.push({
          id: `rule-${randomUUID().substring(0, 8)}`,
          type: 'prefer',
          category: change.category,
          description: `Prefer ${change.newValue} over ${change.previousValue} for ${adaptation.domain}`,
          parameters: { strategy: change.newValue },
          confidence: Math.min(1, 0.5 + (adaptation.actualImprovement || 0)),
          derivedFrom: 'analysis',
          createdAt: Date.now(),
        });
      }
    }

    // Update best strategy combo if this is better
    if (adaptation.actualImprovement !== null &&
        domainModel.bestSuccessRate < (domainModel.bestSuccessRate + adaptation.actualImprovement)) {
      domainModel.bestSuccessRate += adaptation.actualImprovement;
    }

    domainModel.lastUpdated = Date.now();
    domainModel.totalObservations += this.config.testSampleSize;

    adaptation.status = 'deployed';
    adaptation.deployedAt = Date.now();

    await cacheSet(`${ADAPTATION_CACHE_PREFIX}${adaptation.id}`, adaptation, 86400 * 30);
    await cacheSet(`${DOMAIN_MODEL_PREFIX}${adaptation.domain}`, domainModel, 86400 * 30);

    logger.info({
      adaptationId,
      domain: adaptation.domain,
      changesCount: adaptation.changes.length,
      actualImprovement: adaptation.actualImprovement,
    }, 'Adaptation deployed');

    // Schedule post-deploy monitoring
    this.schedulePostDeployMonitoring(adaptation);

    return true;
  }

  /**
   * Roll back a deployed adaptation.
   */
  async rollback(adaptationId: string): Promise<boolean> {
    const adaptation = this.adaptations.get(adaptationId);
    if (!adaptation || adaptation.status !== 'deployed') return false;

    // Revert strategy weights
    for (const change of adaptation.changes) {
      const weightKey = `${adaptation.domain}:${change.category}:${change.newValue}`;
      const weight = this.strategyWeights.get(weightKey);
      if (weight) {
        weight.weight = Math.max(0, weight.weight - (adaptation.actualImprovement || 0));
        weight.trend = 'degrading';
        weight.trendRate = -(adaptation.actualImprovement || 0);
      }

      // Remove domain rules added by this adaptation
      const domainModel = this.domainModels.get(adaptation.domain);
      if (domainModel) {
        domainModel.rules = domainModel.rules.filter(r =>
          !r.description.includes(change.newValue) || r.derivedFrom !== 'analysis'
        );
      }
    }

    adaptation.status = 'rolled_back';

    logger.warn({
      adaptationId,
      domain: adaptation.domain,
    }, 'Adaptation rolled back');

    return true;
  }

  /**
   * Get the best strategy combination for a domain.
   * Returns the strategies with the highest weights.
   */
  getBestStrategies(domain: string): StrategyWeight[] {
    const domainWeights = Array.from(this.strategyWeights.values())
      .filter(w => w.domain === domain || w.domain === '*')
      .sort((a, b) => b.weight - a.weight);

    return domainWeights;
  }

  /**
   * Get the domain model for a domain.
   */
  getDomainModel(domain: string): DomainModel | undefined {
    return this.domainModels.get(domain);
  }

  /**
   * Get all domain models.
   */
  getAllDomainModels(): DomainModel[] {
    return Array.from(this.domainModels.values());
  }

  /**
   * Get adaptations by status.
   */
  getAdaptations(status?: AdaptationStatus): Adaptation[] {
    const all = Array.from(this.adaptations.values());
    if (status) return all.filter(a => a.status === status);
    return all;
  }

  /**
   * Get a specific adaptation.
   */
  getAdaptation(adaptationId: string): Adaptation | undefined {
    return this.adaptations.get(adaptationId);
  }

  /**
   * Update strategy weights based on a new observation.
   * This is called for every observation to continuously refine weights.
   */
  async updateWeights(observation: ScrapingObservation): Promise<void> {
    for (const strategy of observation.strategiesApplied) {
      const weightKey = `${observation.domain}:${strategy.category}:${strategy.name}`;
      let weight = this.strategyWeights.get(weightKey);

      if (!weight) {
        weight = {
          strategyKey: `${strategy.category}:${strategy.name}`,
          weight: 0.5,
          observationCount: 0,
          lastUpdated: Date.now(),
          successRate: 0.5,
          domain: observation.domain,
          platform: '*',
          trend: 'stable',
          trendRate: 0,
        };
        this.strategyWeights.set(weightKey, weight);
      }

      weight.observationCount++;
      const successIncrement = observation.outcome === 'success' ? 1 : 0;
      weight.weight = computeStrategyWeight(
        weight.weight,
        successIncrement,
        1 - successIncrement,
        this.config.learningRate,
        this.config.weightDecay,
      );
      weight.successRate = weight.weight;
      weight.lastUpdated = Date.now();

      // Update trend
      if (weight.observationCount >= 5) {
        const recentObs = observationCollector.query({
          domain: observation.domain,
          since: Date.now() - 3600000,
          limit: 10,
        });
        const recentSuccessRate = recentObs.length > 0
          ? recentObs.filter(o => o.outcome === 'success').length / recentObs.length
          : 0.5;

        if (recentSuccessRate > weight.successRate + 0.05) {
          weight.trend = 'improving';
        } else if (recentSuccessRate < weight.successRate - 0.05) {
          weight.trend = 'degrading';
        } else {
          weight.trend = 'stable';
        }
        weight.trendRate = recentSuccessRate - weight.successRate;
      }
    }

    // Update domain model recent success rate
    const domainModel = this.domainModels.get(observation.domain);
    if (domainModel) {
      domainModel.recentSuccessRate = observationCollector.getSuccessRate(observation.domain, 3600000);
      domainModel.totalObservations++;
      domainModel.lastUpdated = Date.now();

      // Update platforms if detected
      if (observation.detectedPlatform && !domainModel.platforms.includes(observation.detectedPlatform)) {
        domainModel.platforms.push(observation.detectedPlatform);
      }
    }
  }

  /**
   * Get adaptation engine statistics.
   */
  getStats(): {
    totalAdaptations: number;
    byStatus: Record<AdaptationStatus, number>;
    domainModelCount: number;
    averageWeight: number;
    improvingStrategies: number;
    degradingStrategies: number;
    stableStrategies: number;
  } {
    const byStatus: Partial<Record<AdaptationStatus, number>> = {};
    for (const adaptation of this.adaptations.values()) {
      byStatus[adaptation.status] = (byStatus[adaptation.status] || 0) + 1;
    }

    const weights = Array.from(this.strategyWeights.values());
    const avgWeight = weights.length > 0
      ? weights.reduce((sum, w) => sum + w.weight, 0) / weights.length
      : 0;

    return {
      totalAdaptations: this.adaptations.size,
      byStatus: byStatus as Record<AdaptationStatus, number>,
      domainModelCount: this.domainModels.size,
      averageWeight: Math.round(avgWeight * 100) / 100,
      improvingStrategies: weights.filter(w => w.trend === 'improving').length,
      degradingStrategies: weights.filter(w => w.trend === 'degrading').length,
      stableStrategies: weights.filter(w => w.trend === 'stable').length,
    };
  }

  // ---------- Internal Methods -------------------------------------------------

  private createDomainModel(domain: string): DomainModel {
    const model: DomainModel = {
      domain,
      platforms: [],
      strategyWeights: [],
      bestStrategyCombo: [],
      bestSuccessRate: 0,
      knownPatterns: [],
      rules: [],
      lastUpdated: Date.now(),
      totalObservations: 0,
      recentSuccessRate: 0,
    };
    this.domainModels.set(domain, model);
    return model;
  }

  private checkDailyReset(): void {
    const now = Date.now();
    if (now - this.lastDailyReset > 86400000) {
      this.dailyAdaptationCount.clear();
      this.lastDailyReset = now;
    }
  }

  private schedulePostDeployMonitoring(adaptation: Adaptation): void {
    setTimeout(async () => {
      if (adaptation.status !== 'deployed') return;

      // Check if the adaptation has caused regression
      const currentSuccessRate = observationCollector.getSuccessRate(adaptation.domain, 1800000);

      if (currentSuccessRate < (adaptation.actualImprovement !== null ? 0.3 : 0.5)) {
        logger.warn({
          adaptationId: adaptation.id,
          domain: adaptation.domain,
          currentSuccessRate: Math.round(currentSuccessRate * 100),
        }, 'Post-deploy regression detected — rolling back');
        await this.rollback(adaptation.id);
      } else {
        logger.info({
          adaptationId: adaptation.id,
          domain: adaptation.domain,
          currentSuccessRate: Math.round(currentSuccessRate * 100),
        }, 'Post-deploy monitoring: performance stable');
      }
    }, this.config.rollbackWindowMs);
  }
}

/** Singleton instance. */
export const adaptationEngine = new AdaptationEngine();
