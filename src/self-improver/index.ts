/**
 * Self-Improving Engine Module — ScrapeSuite Engine
 *
 * The intelligence layer that makes the engine progressively better
 * at bypassing anti-bot defenses. Every scraping attempt — success
 * or failure — feeds into the learning loop:
 *
 *   Scrape → Observe → Analyze → Learn → Adapt → Scrape (better)
 *
 * Submodules:
 * - ObservationCollector: Records every attempt with full context
 * - FailureAnalyzer: Identifies root causes and patterns in failures
 * - AdaptationEngine: Proposes, tests, and deploys strategy changes
 * - SelfImproverManager: Top-level orchestrator and API entry point
 *
 * Key insight: Failure is data. Every blocked request teaches us
 * something about the defense we're facing. The engine that learns
 * from its failures will eventually overcome any defense.
 */

// Types
export type {
  Outcome, AntiBotPlatform, StrategyCategory, LearningMode, AdaptationStatus,
  ScrapingObservation, AppliedStrategy, ScrapingContext, ResponseDetails,
  FailureAnalysis, FailurePattern, AdaptationRecommendation,
  StrategyWeight, DomainModel, DomainRule,
  Adaptation, AdaptationChange, AdaptationTestResult,
  SelfImproverConfig, SelfImproverStats,
} from './types';

// Observation Collector
export { ObservationCollector, observationCollector } from './observation-collector';

// Failure Analyzer
export { FailureAnalyzer, failureAnalyzer } from './failure-analyzer';

// Adaptation Engine
export { AdaptationEngine, DEFAULT_ADAPTATION_CONFIG, adaptationEngine } from './adaptation-engine';

// Manager
export { SelfImproverManager, DEFAULT_SELF_IMPROVER_CONFIG, selfImproverManager } from './manager';
