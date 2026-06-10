/**
 * Real-Time Cascade Learner -- ScrapeSuite Engine Self-Improver
 *
 * ULTRA-OPTIMIZED EDITION — Target: <0.1ms per outcome (was <1ms)
 *
 * Extends the self-improving engine with microsecond-level learning.
 * Records every reaction outcome and learns in real-time using:
 *   - Pre-allocated circular buffer instead of array.shift()
 *   - Direct Map operations instead of Array.find()
 *   - Deferred Redis persistence (fire-and-forget)
 *   - No performance.now() in hot path (use hrtime only when needed)
 *   - Pre-computed pattern keys
 *   - Avoid Array.sort() in hot path (use insertion-order)
 *
 * Performance: Learning target <0.1ms per outcome (was <1ms)
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type {
  ReactionType,
  AntiBotPlatform,
  SignalCategory,
} from '../fusion-reactor/types';

const logger = createChildLogger('real-time-learner');

// ===============================================================================
// TYPES
// ===============================================================================

export interface ReactionOutcome {
  reactionType: ReactionType;
  platform: AntiBotPlatform;
  domain: string;
  signalCategories: SignalCategory[];
  success: boolean;
  reactionTimeMs: number;
  cascadeSuccess: boolean;
  cascadeDepth: number;
  timestamp: number;
  sessionId?: string;
  requestId?: string;
}

export interface ReactionPattern {
  key: string;
  reactionType: ReactionType;
  platform: AntiBotPlatform;
  signalCategories: SignalCategory[];
  successCount: number;
  failureCount: number;
  emaSuccessRate: number;
  avgReactionTimeMs: number;
  optimalCascadeDepth: number;
  lastObservedAt: number;
  trend: 'improving' | 'stable' | 'declining';
  /** Circular buffer for recent outcomes (avoids array.shift()) */
  recentOutcomes: number; // bitmask: 1=success, 0=failure (up to 20 bits)
  recentOutcomeCount: number;
}

export interface DomainReactionModel {
  domain: string;
  platform: AntiBotPlatform;
  bestReactions: Array<{
    reactionType: ReactionType;
    successRate: number;
    avgTimeMs: number;
  }>;
  optimalCascadeDepth: number;
  totalObservations: number;
  overallSuccessRate: number;
  lastUpdated: number;
  /** Index for O(1) reaction type lookup */
  reactionIndex: Map<ReactionType, number>;
}

export interface RealTimeLearnerStats {
  totalOutcomesRecorded: number;
  totalPatternsLearned: number;
  totalDomainModels: number;
  avgLearningTimeMs: number;
  patternsImproved: number;
  patternsDeclined: number;
  hotPatterns: number;
  coldPatterns: number;
}

// ===============================================================================
// CONSTANTS
// ===============================================================================

const EMA_ALPHA = 0.2;
const MAX_RECENT_BITS = 20; // 20 bits in a number
const RECENT_OUTCOME_MASK = (1 << MAX_RECENT_BITS) - 1; // 0xFFFFF

// ===============================================================================
// REAL-TIME LEARNER ENGINE — ULTRA-OPTIMIZED
// ===============================================================================

export class RealTimeLearnerEngine {
  private patterns: Map<string, ReactionPattern> = new Map();
  private domainModels: Map<string, DomainReactionModel> = new Map();
  private stats = {
    totalOutcomesRecorded: 0,
    totalPatternsLearned: 0,
    totalDomainModels: 0,
    avgLearningTimeMs: 0,
    patternsImproved: 0,
    patternsDeclined: 0,
  };

  constructor() {
    logger.info('Real-time cascade learner initialized (ULTRA-OPTIMIZED)');
  }

  /**
   * Record a reaction outcome and learn from it in real-time.
   * ULTRA-OPTIMIZED HOT PATH — Target: <0.1ms
   *
   * Optimizations:
   *   - No performance.now() in hot path (removed timing overhead)
   *   - Circular bitmask instead of array.shift() for recent outcomes
   *   - Direct Map.get/set instead of Array.find
   *   - No Array.sort() in hot path
   *   - Deferred Redis persistence
   *   - Pre-computed keys
   */
  recordOutcome(outcome: ReactionOutcome): void {
    this.stats.totalOutcomesRecorded++;

    // Update patterns — single pass with pre-computed keys
    const successBit = outcome.success ? 1 : 0;
    for (let i = 0; i < outcome.signalCategories.length; i++) {
      const key = `${outcome.reactionType}:${outcome.platform}:${outcome.signalCategories[i]}`;
      this.updatePatternFast(key, outcome, successBit);
    }

    // Update domain model
    this.updateDomainModelFast(outcome, successBit);

    // Deferred persistence
    if (this.stats.totalOutcomesRecorded % 50 === 0) {
      this.persistState().catch(() => {});
    }
  }

  /**
   * Fast pattern update — no array allocations, bitmask for recent outcomes.
   */
  private updatePatternFast(key: string, outcome: ReactionOutcome, successBit: number): void {
    let pattern = this.patterns.get(key);

    if (!pattern) {
      pattern = {
        key,
        reactionType: outcome.reactionType,
        platform: outcome.platform,
        signalCategories: outcome.signalCategories,
        successCount: 0,
        failureCount: 0,
        emaSuccessRate: 0.5,
        avgReactionTimeMs: 0,
        optimalCascadeDepth: 1,
        lastObservedAt: outcome.timestamp,
        trend: 'stable',
        recentOutcomes: 0,
        recentOutcomeCount: 0,
      };
      this.patterns.set(key, pattern);
      this.stats.totalPatternsLearned++;
    }

    // Update counts
    if (successBit) pattern.successCount++;
    else pattern.failureCount++;

    // EMA update
    const prevEma = pattern.emaSuccessRate;
    pattern.emaSuccessRate = prevEma * (1 - EMA_ALPHA) + successBit * EMA_ALPHA;

    // Trend detection (compare directly, no intermediate variable)
    const rateChange = pattern.emaSuccessRate - prevEma;
    if (rateChange > 0.05) {
      pattern.trend = 'improving';
      this.stats.patternsImproved++;
    } else if (rateChange < -0.05) {
      pattern.trend = 'declining';
      this.stats.patternsDeclined++;
    } else {
      pattern.trend = 'stable';
    }

    // Update average reaction time
    const totalOutcomes = pattern.successCount + pattern.failureCount;
    pattern.avgReactionTimeMs = totalOutcomes > 1
      ? (pattern.avgReactionTimeMs * (totalOutcomes - 1) + outcome.reactionTimeMs) / totalOutcomes
      : outcome.reactionTimeMs;

    // Update optimal cascade depth
    if (outcome.cascadeSuccess && outcome.cascadeDepth > pattern.optimalCascadeDepth) {
      pattern.optimalCascadeDepth = outcome.cascadeDepth;
    }

    // Update recent outcomes bitmask (shift left, add new bit, mask to 20 bits)
    pattern.recentOutcomes = ((pattern.recentOutcomes << 1) | successBit) & RECENT_OUTCOME_MASK;
    pattern.recentOutcomeCount = Math.min(pattern.recentOutcomeCount + 1, MAX_RECENT_BITS);

    pattern.lastObservedAt = outcome.timestamp;
  }

  /**
   * Fast domain model update — uses Map for O(1) reaction lookup.
   */
  private updateDomainModelFast(outcome: ReactionOutcome, successBit: number): void {
    let model = this.domainModels.get(outcome.domain);

    if (!model) {
      model = {
        domain: outcome.domain,
        platform: outcome.platform,
        bestReactions: [],
        optimalCascadeDepth: 2,
        totalObservations: 0,
        overallSuccessRate: 0.5,
        lastUpdated: outcome.timestamp,
        reactionIndex: new Map(),
      };
      this.domainModels.set(outcome.domain, model);
      this.stats.totalDomainModels++;
    }

    model.totalObservations++;

    // EMA success rate
    model.overallSuccessRate = model.overallSuccessRate * (1 - EMA_ALPHA) + successBit * EMA_ALPHA;

    // Update best reactions using O(1) index lookup
    const idx = model.reactionIndex.get(outcome.reactionType);
    if (idx !== undefined && idx < model.bestReactions.length) {
      const existing = model.bestReactions[idx];
      existing.successRate = existing.successRate * (1 - EMA_ALPHA) + successBit * EMA_ALPHA;
      existing.avgTimeMs = (existing.avgTimeMs + outcome.reactionTimeMs) / 2;
    } else {
      model.bestReactions.push({
        reactionType: outcome.reactionType,
        successRate: successBit,
        avgTimeMs: outcome.reactionTimeMs,
      });
      model.reactionIndex.set(outcome.reactionType, model.bestReactions.length - 1);
    }

    // Only sort when we have enough observations (not on every update)
    if (model.totalObservations % 10 === 0) {
      model.bestReactions.sort((a, b) => b.successRate - a.successRate);
      // Rebuild index after sort
      for (let i = 0; i < model.bestReactions.length; i++) {
        model.reactionIndex.set(model.bestReactions[i].reactionType, i);
      }
      // Keep top 10
      if (model.bestReactions.length > 10) {
        model.bestReactions.length = 10;
      }
    }

    if (outcome.cascadeSuccess) {
      model.optimalCascadeDepth = Math.max(model.optimalCascadeDepth, outcome.cascadeDepth);
    }

    model.lastUpdated = outcome.timestamp;
  }

  /**
   * Get the best reaction for a given platform and signal category.
   */
  getBestReaction(platform: AntiBotPlatform, signalCategory: SignalCategory): ReactionType | null {
    let bestReaction: ReactionType | null = null;
    let bestRate = 0;

    for (const pattern of this.patterns.values()) {
      if (pattern.platform === platform && pattern.signalCategories.includes(signalCategory)) {
        if (pattern.emaSuccessRate > bestRate) {
          bestRate = pattern.emaSuccessRate;
          bestReaction = pattern.reactionType;
        }
      }
    }

    return bestReaction;
  }

  getOptimalCascadeDepth(domain: string): number {
    return this.domainModels.get(domain)?.optimalCascadeDepth ?? 2;
  }

  getDomainModel(domain: string): DomainReactionModel | null {
    return this.domainModels.get(domain) || null;
  }

  getPatterns(): ReactionPattern[] {
    return [...this.patterns.values()];
  }

  getPatternsByPlatform(platform: AntiBotPlatform): ReactionPattern[] {
    return [...this.patterns.values()].filter(p => p.platform === platform);
  }

  private async persistState(): Promise<void> {
    try {
      // Convert reactionIndex Maps to plain objects for serialization
      const serializableModels: Record<string, any> = {};
      for (const [domain, model] of this.domainModels) {
        serializableModels[domain] = {
          ...model,
          reactionIndex: Object.fromEntries(model.reactionIndex),
        };
      }

      await cacheSet('self-improver:real-time-learner', {
        patterns: Object.fromEntries(this.patterns),
        domainModels: serializableModels,
        stats: this.stats,
        lastPersisted: Date.now(),
      }, 3600);
    } catch {
      logger.debug('Failed to persist real-time learner state');
    }
  }

  async loadState(): Promise<void> {
    try {
      const state = await cacheGet<{
        patterns: Record<string, ReactionPattern>;
        domainModels: Record<string, any>;
      }>('self-improver:real-time-learner');

      if (state) {
        if (state.patterns) {
          for (const [key, pattern] of Object.entries(state.patterns)) {
            this.patterns.set(key, pattern);
          }
        }
        if (state.domainModels) {
          for (const [domain, modelData] of Object.entries(state.domainModels)) {
            const model = modelData as DomainReactionModel;
            // Rebuild reactionIndex Map from serialized data
            if (!(model.reactionIndex instanceof Map)) {
              const idx = new Map<ReactionType, number>();
              if (model.reactionIndex && typeof model.reactionIndex === 'object') {
                for (const [k, v] of Object.entries(model.reactionIndex)) {
                  idx.set(k as ReactionType, v as number);
                }
              }
              model.reactionIndex = idx;
            }
            this.domainModels.set(domain, model);
          }
        }
        logger.info({
          patterns: this.patterns.size,
          domainModels: this.domainModels.size,
        }, 'Real-time learner state loaded from cache');
      }
    } catch {
      logger.debug('No cached real-time learner state found');
    }
  }

  getStats(): RealTimeLearnerStats {
    let hotPatterns = 0;
    let coldPatterns = 0;
    for (const pattern of this.patterns.values()) {
      if (pattern.emaSuccessRate > 0.7) hotPatterns++;
      else if (pattern.emaSuccessRate < 0.3) coldPatterns++;
    }

    return {
      totalOutcomesRecorded: this.stats.totalOutcomesRecorded,
      totalPatternsLearned: this.patterns.size,
      totalDomainModels: this.domainModels.size,
      avgLearningTimeMs: Math.round(this.stats.avgLearningTimeMs * 100) / 100,
      patternsImproved: this.stats.patternsImproved,
      patternsDeclined: this.stats.patternsDeclined,
      hotPatterns,
      coldPatterns,
    };
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const realTimeLearner = new RealTimeLearnerEngine();
