/**
 * Self-Improving Engine Manager — ScrapeSuite Engine
 *
 * Top-level orchestrator for the self-improving system. Coordinates
 * observation collection, failure analysis, adaptation, and learning
 * as a unified feedback loop that makes the engine progressively
 * better at bypassing anti-bot defenses.
 *
 * The feedback loop:
 *   Scrape → Observe → Analyze → Learn → Adapt → Scrape (better)
 *
 * Every scraping attempt — whether success or failure — feeds into
 * this loop. Over time, the engine learns:
 * - Which strategies work best for each domain
 * - Which strategies work best against each anti-bot platform
 * - When to rotate proxies, fingerprints, and TLS profiles
 * - How fast it can push before triggering detection
 * - Which failure patterns are recurring vs. one-off
 *
 * The key insight: failure is data. Every blocked request teaches
 * us something about the defense we're facing.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { ObservationCollector, observationCollector } from './observation-collector';
import { FailureAnalyzer, failureAnalyzer } from './failure-analyzer';
import { AdaptationEngine, adaptationEngine, DEFAULT_ADAPTATION_CONFIG } from './adaptation-engine';
import type {
  SelfImproverConfig, SelfImproverStats, ScrapingObservation, Outcome,
  FailureAnalysis, Adaptation, AdaptationRecommendation, DomainModel,
  StrategyCategory, AntiBotPlatform, LearningMode,
} from './types';

const logger = createChildLogger('self-improver');

const ENGINE_CACHE_PREFIX = 'self-improver:engine:';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_SELF_IMPROVER_CONFIG: SelfImproverConfig = {
  learningMode: 'balanced',
  minObservationsForAdaptation: 10,
  minConfidenceForDeploy: 0.6,
  trendWindowSize: 100,
  weightDecay: 0.05,
  autoDeploy: true,
  maxAdaptationsPerDay: 10,
  priorityDomains: ['netflix.com', 'google.com', 'www.netflix.com', 'www.google.com'],
  crossDomainLearning: true,
  minImprovementThreshold: 0.05,
  observationRetentionDays: 30,
  exportModels: false,
  debugMode: false,
};

// ===============================================================================
// SELF-IMPROVER MANAGER CLASS
// ===============================================================================

export class SelfImproverManager {
  private collector: ObservationCollector;
  private analyzer: FailureAnalyzer;
  private adapter: AdaptationEngine;
  private config: SelfImproverConfig;
  private initialized = false;
  private processTimer: ReturnType<typeof setInterval> | null = null;
  private learningStats = {
    totalObservationsProcessed: 0,
    totalAnalysesGenerated: 0,
    totalAdaptationsProposed: 0,
    totalAdaptationsDeployed: 0,
    lastProcessTime: 0,
  };

  constructor(config?: Partial<SelfImproverConfig>) {
    this.config = { ...DEFAULT_SELF_IMPROVER_CONFIG, ...config };
    this.collector = observationCollector;
    this.analyzer = failureAnalyzer;
    this.adapter = adaptationEngine;
  }

  /**
   * Initialize the self-improving engine.
   * Starts the observation processing loop.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info({
      learningMode: this.config.learningMode,
      autoDeploy: this.config.autoDeploy,
      priorityDomains: this.config.priorityDomains,
    }, 'Initializing Self-Improving Engine');

    // Start the processing loop
    const processInterval = this.config.learningMode === 'aggressive' ? 30000
      : this.config.learningMode === 'conservative' ? 300000
      : 120000; // balanced: 2 minutes

    this.processTimer = setInterval(
      () => this.processUnanalyzed(),
      processInterval,
    );

    this.initialized = true;
    logger.info('Self-Improving Engine initialized and learning');
  }

  /** Shut down the self-improving engine. */
  async shutdown(): Promise<void> {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
    this.initialized = false;
    logger.info('Self-Improving Engine shut down');
  }

  /**
   * Record a scraping observation.
   * This is the primary API for feeding data into the learning system.
   * Call this after every scraping attempt — success or failure.
   */
  async observe(observation: Omit<ScrapingObservation, 'id' | 'analyzed'>): Promise<ScrapingObservation> {
    const result = await this.collector.record(observation);

    // Immediately update strategy weights for fast learning
    await this.adapter.updateWeights(result);

    this.learningStats.totalObservationsProcessed++;

    // For failures on priority domains, trigger immediate analysis
    if (result.outcome !== 'success' && this.config.priorityDomains.includes(result.domain)) {
      try {
        const analysis = await this.analyzer.analyze(result);
        this.learningStats.totalAnalysesGenerated++;

        // Auto-propose adaptations for high-confidence recommendations
        if (this.config.autoDeploy) {
          for (const rec of analysis.recommendations) {
            if (rec.confidence >= this.config.minConfidenceForDeploy) {
              try {
                const adaptation = await this.adapter.propose(rec, result.domain, result.detectedPlatform || undefined);
                this.learningStats.totalAdaptationsProposed++;

                // Immediately test and deploy if learning mode is aggressive
                if (this.config.learningMode === 'aggressive') {
                  const testResult = await this.adapter.testAdaptation(adaptation.id);
                  if (testResult.passed) {
                    await this.adapter.deploy(adaptation.id);
                    this.learningStats.totalAdaptationsDeployed++;
                  }
                }
              } catch (err) {
                logger.debug({ error: String(err) }, 'Adaptation proposal skipped');
              }
            }
          }
        }
      } catch (err) {
        logger.debug({ error: String(err) }, 'Analysis skipped for observation');
      }
    }

    return result;
  }

  /**
   * Quick observation recording — minimal parameters.
   */
  async observeQuick(options: {
    url: string;
    domain: string;
    outcome: Outcome;
    platform?: AntiBotPlatform;
    proxyTier?: string;
    tlsProfile?: string;
    statusCode?: number;
    captchaPresent?: boolean;
    errorMessage?: string;
    durationMs?: number;
  }): Promise<ScrapingObservation> {
    return this.collector.recordQuick(options);
  }

  /**
   * Process all unanalyzed observations.
   * This is the main learning loop — it picks up observations
   * that haven't been analyzed yet and runs the full pipeline.
   */
  async processUnanalyzed(): Promise<{
    analyzed: number;
    adaptationsProposed: number;
    adaptationsDeployed: number;
  }> {
    const unanalyzed = this.collector.getUnanalyzed(50);
    const failures = unanalyzed.filter(o => o.outcome !== 'success');

    let analyzed = 0;
    let adaptationsProposed = 0;
    let adaptationsDeployed = 0;

    for (const obs of failures) {
      try {
        const analysis = await this.analyzer.analyze(obs);
        analyzed++;
        this.learningStats.totalAnalysesGenerated++;

        // Propose adaptations for recommendations with sufficient confidence
        for (const rec of analysis.recommendations) {
          if (rec.confidence >= this.config.minConfidenceForDeploy) {
            try {
              const adaptation = await this.adapter.propose(rec, obs.domain, obs.detectedPlatform || undefined);
              adaptationsProposed++;
              this.learningStats.totalAdaptationsProposed++;

              // Test and deploy in balanced/aggressive mode
              if (this.config.learningMode !== 'conservative') {
                const testResult = await this.adapter.testAdaptation(adaptation.id);
                if (testResult.passed) {
                  await this.adapter.deploy(adaptation.id);
                  adaptationsDeployed++;
                  this.learningStats.totalAdaptationsDeployed++;
                }
              }
            } catch {
              // Skip if daily limit reached
            }
          }
        }
      } catch {
        // Skip observations that can't be analyzed
      }
    }

    // Update weights for successful observations too
    const successes = unanalyzed.filter(o => o.outcome === 'success');
    for (const obs of successes) {
      await this.adapter.updateWeights(obs);
      this.collector.markAnalyzed(obs.id);
    }

    this.learningStats.lastProcessTime = Date.now();

    if (analyzed > 0 || adaptationsProposed > 0) {
      logger.info({
        analyzed,
        adaptationsProposed,
        adaptationsDeployed,
        unanalyzedRemaining: this.collector.getUnanalyzed(1000).length,
      }, 'Learning cycle completed');
    }

    return { analyzed, adaptationsProposed, adaptationsDeployed };
  }

  /**
   * Get the best known strategies for a domain.
   * This is what the scraping engine should use when making requests.
   */
  getBestStrategies(domain: string): Record<StrategyCategory, string> {
    const weights = this.adapter.getBestStrategies(domain);

    const result: Record<string, string> = {};
    for (const weight of weights) {
      const [category, name] = weight.strategyKey.split(':');
      if (!result[category] || weight.weight > (result[category] === 'unknown' ? 0 : 0.5)) {
        result[category] = name;
      }
    }

    // Fill in defaults for missing categories
    const defaults: Record<StrategyCategory, string> = {
      proxy: 'residential_auto',
      fingerprint: 'consistent_rotation',
      behavior: 'human_simulation',
      tls: 'chrome_120_compatible',
      header: 'browser_normalized',
      cookie: 'session_persistent',
      timing: 'adaptive_rate',
      session: 'sticky_geo',
      captcha: 'auto_solve',
      sensor: 'latest_format',
      account: 'warmed_google',
    };

    for (const [cat, def] of Object.entries(defaults)) {
      if (!result[cat]) result[cat] = def;
    }

    return result as Record<StrategyCategory, string>;
  }

  /**
   * Get the domain model for a domain.
   */
  getDomainModel(domain: string): DomainModel | undefined {
    return this.adapter.getDomainModel(domain);
  }

  /**
   * Get all domain models.
   */
  getAllDomainModels(): DomainModel[] {
    return this.adapter.getAllDomainModels();
  }

  /**
   * Get recent failure analyses.
   */
  getRecentAnalyses(limit: number = 20): FailureAnalysis[] {
    return this.analyzer.getRecentAnalyses(limit);
  }

  /**
   * Get known failure patterns.
   */
  getFailurePatterns() {
    return this.analyzer.getPatterns();
  }

  /**
   * Get current adaptations.
   */
  getAdaptations(status?: string) {
    return this.adapter.getAdaptations(status as any);
  }

  /**
   * Get the success rate for a domain.
   */
  getSuccessRate(domain: string, windowMs: number = 3600000): number {
    return this.collector.getSuccessRate(domain, windowMs);
  }

  /**
   * Query observations.
   */
  queryObservations(filters: {
    domain?: string;
    outcome?: Outcome;
    platform?: AntiBotPlatform;
    since?: number;
    limit?: number;
  }) {
    return this.collector.query(filters);
  }

  /**
   * Get comprehensive statistics.
   */
  getStats(): SelfImproverStats {
    const collectorStats = this.collector.getStats();
    const analyzerStats = this.analyzer.getStats();
    const adapterStats = this.adapter.getStats();

    // Compute average success rate across priority domains
    let totalSuccessRate = 0;
    let domainCount = 0;
    const topImproving: Array<{ domain: string; improvement: number }> = [];
    const topDegrading: Array<{ domain: string; degradation: number }> = [];

    for (const domain of this.config.priorityDomains) {
      const rate = this.collector.getSuccessRate(domain, 86400000);
      totalSuccessRate += rate;
      domainCount++;

      const model = this.adapter.getDomainModel(domain);
      if (model) {
        const improvement = model.recentSuccessRate - model.bestSuccessRate;
        if (improvement > 0) {
          topImproving.push({ domain, improvement });
        } else if (improvement < 0) {
          topDegrading.push({ domain, degradation: Math.abs(improvement) });
        }
      }
    }

    const avgSuccessRate = domainCount > 0 ? totalSuccessRate / domainCount : 0;

    return {
      totalObservations: collectorStats.totalCollected,
      observationsByOutcome: collectorStats.byOutcome,
      totalAnalyses: analyzerStats.totalAnalyses,
      totalAdaptations: adapterStats.totalAdaptations,
      adaptationsByStatus: adapterStats.byStatus,
      domainModelCount: adapterStats.domainModelCount,
      averageSuccessRate: Math.round(avgSuccessRate * 100) / 100,
      averageSuccessRateChange: 0, // Computed from trend
      recentAdaptationCount: this.learningStats.totalAdaptationsProposed,
      recentImprovementRate: this.learningStats.totalAdaptationsDeployed > 0
        ? this.learningStats.totalAdaptationsDeployed / this.learningStats.totalAdaptationsProposed
        : 0,
      topImprovingDomains: topImproving.sort((a, b) => b.improvement - a.improvement).slice(0, 5),
      topDegradingsDomains: topDegrading.sort((a, b) => b.degradation - a.degradation).slice(0, 5),
      learningVelocity: collectorStats.totalCollected > 0
        ? collectorStats.totalCollected / Math.max(1, (Date.now() - (Date.now() - 86400000)) / 3600000)
        : 0,
      modelAccuracy: adapterStats.averageWeight,
    };
  }

  /** Get the component instances. */
  getCollector(): ObservationCollector { return this.collector; }
  getAnalyzer(): FailureAnalyzer { return this.analyzer; }
  getAdapter(): AdaptationEngine { return this.adapter; }

  /** Check if the engine is initialized. */
  isInitialized(): boolean { return this.initialized; }
}

/** Singleton instance. */
export const selfImproverManager = new SelfImproverManager();
