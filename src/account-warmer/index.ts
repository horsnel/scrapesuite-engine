/**
 * Google Account Warmer Module — ScrapeSuite Engine
 *
 * Manages Google account warming for high-trust authenticated scraping.
 * Aged accounts with realistic browsing history achieve significantly
 * higher reCAPTCHA scores (0.7-0.9+) compared to new or anonymous
 * sessions (0.3-0.5), making them critical for Google scraping at scale.
 *
 * Submodules:
 * - AccountPoolManager: Account lifecycle, allocation, and session tracking
 * - WarmingEngine: Behavioral warming with phased activity schedules
 * - AccountWarmerManager: Top-level orchestrator
 */

// Types
export type {
  AccountStatus, AccountTier, WarmupPhase, ServiceType, ActivityType, RiskLevel,
  GoogleAccount, AccountSession, ActivityRecord,
  WarmupSchedule, WarmupActivity, WarmupPlan,
  HealthAssessment, HealthIssue,
  AccountPoolConfig, AccountAllocation,
  AccountWarmerConfig, AccountWarmerStats,
} from './types';

// Account Pool
export { AccountPoolManager, DEFAULT_POOL_CONFIG, accountPoolManager } from './account-pool';

// Warming Engine
export { WarmingEngine, DEFAULT_WARMUP_PLAN, warmingEngine } from './warming-engine';

// Manager
export { AccountWarmerManager, DEFAULT_WARMER_CONFIG, accountWarmerManager } from './manager';
