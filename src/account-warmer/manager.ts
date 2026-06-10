/**
 * Google Account Warmer Manager — ScrapeSuite Engine
 *
 * Top-level orchestrator for the Google account warming system.
 * Coordinates account pool management, behavioral warming,
 * health assessment, and lifecycle automation.
 *
 * This is the "nursery" for Google accounts — it takes accounts
 * from creation through a behavioral warming process that builds
 * realistic browsing history, making them trusted enough to
 * achieve high reCAPTCHA scores and bypass Google's bot detection.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { AccountPoolManager, accountPoolManager } from './account-pool';
import { WarmingEngine, warmingEngine, DEFAULT_WARMUP_PLAN } from './warming-engine';
import type {
  AccountWarmerConfig, AccountWarmerStats, GoogleAccount, WarmupPhase,
  AccountAllocation, ServiceType, HealthAssessment,
} from './types';

const logger = createChildLogger('account-warmer');

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_WARMER_CONFIG: AccountWarmerConfig = {
  pool: {
    minReadyAccounts: 10,
    maxAccounts: 200,
    minReadyAgeDays: 14,
    targetRecaptchaScore: 0.7,
    maxParallelWarming: 5,
    flagCooldownHours: 48,
    maxUsagePerDay: 8,
    rotationStrategy: 'highest_health',
    targetRegions: ['US', 'GB', 'DE', 'JP', 'BR'],
  },
  defaultPlan: DEFAULT_WARMUP_PLAN,
  healthCheckInterval: 3600000, // 1 hour
  autoProvision: true,
  maxProvisionRate: 5,
  autoRetire: true,
  retirementHealthThreshold: 20,
  notificationWebhook: null,
  debugMode: false,
};

// ===============================================================================
// ACCOUNT WARMER MANAGER CLASS
// ===============================================================================

export class AccountWarmerManager {
  private pool: AccountPoolManager;
  private warmer: WarmingEngine;
  private config: AccountWarmerConfig;
  private initialized = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<AccountWarmerConfig>) {
    this.config = { ...DEFAULT_WARMER_CONFIG, ...config };
    this.pool = accountPoolManager;
    this.warmer = warmingEngine;
  }

  /**
   * Initialize the account warmer system.
   * Loads the account pool and starts health monitoring.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Account Warmer');

    await this.pool.initialize();

    // Start health check loop
    this.healthCheckTimer = setInterval(
      () => this.runHealthChecks(),
      this.config.healthCheckInterval,
    );

    this.initialized = true;
    logger.info('Account Warmer initialized');
  }

  /** Shut down the account warmer. */
  async shutdown(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.initialized = false;
    logger.info('Account Warmer shut down');
  }

  /**
   * Allocate an account for a scraping task.
   * Returns the best available account matching the requirements.
   */
  async allocateAccount(options: {
    region?: string;
    service: ServiceType;
    requiresHighTrust?: boolean;
  }): Promise<AccountAllocation | null> {
    return this.pool.allocate(options);
  }

  /**
   * Release an account after a session.
   */
  async releaseAccount(accountId: string, sessionData: {
    durationMs: number;
    servicesVisited: ServiceType[];
    pagesVisited: number;
    searchesPerformed: number;
    recaptchaEncountered: boolean;
    recaptchaScore: number | null;
    flagged: boolean;
  }): Promise<void> {
    await this.pool.release(accountId, sessionData);

    // If flagged, stop warming
    if (sessionData.flagged) {
      this.warmer.stopWarming(accountId);
    }
  }

  /**
   * Create and start warming a new account.
   */
  async provisionAccount(options: {
    region: string;
    proxyEndpointId: string;
    fingerprintId: string;
  }): Promise<GoogleAccount> {
    const account = await this.pool.createAccount(options);

    // Start the warming process
    const phase = await this.warmer.startWarming(account);
    await this.pool.updateStatus(account.id, 'warming');
    await this.pool.updateWarmupPhase(account.id, phase);

    return account;
  }

  /**
   * Get the next warming activity for an account.
   */
  getNextWarmupActivity(accountId: string): any | null {
    const account = this.pool.getAccount(accountId);
    if (!account) return null;
    return this.warmer.getNextActivity(account);
  }

  /**
   * Assess the health of a specific account.
   */
  assessAccountHealth(accountId: string): HealthAssessment | null {
    const account = this.pool.getAccount(accountId);
    if (!account) return null;
    return this.warmer.assessHealth(account);
  }

  /**
   * Get all accounts with their health assessments.
   */
  async getAccountHealthReport(): Promise<Array<{ account: GoogleAccount; health: HealthAssessment }>> {
    const accounts = this.pool.getAllAccounts();
    return accounts.map(account => ({
      account,
      health: this.warmer.assessHealth(account),
    }));
  }

  /**
   * Run health checks on all warming accounts.
   */
  async runHealthChecks(): Promise<void> {
    const warmingAccounts = this.pool.getAccountsByStatus('warming');

    for (const account of warmingAccounts) {
      const health = this.warmer.assessHealth(account);

      // Update account health score
      account.healthScore = health.healthScore;
      account.riskLevel = health.riskLevel;

      // Try to advance phase
      const newPhase = await this.warmer.advancePhase(account);
      if (newPhase) {
        await this.pool.updateWarmupPhase(account.id, newPhase);
        if (newPhase === 'operational') {
          await this.pool.updateStatus(account.id, 'ready');
        }
      }

      // Auto-retire critically unhealthy accounts
      if (this.config.autoRetire && health.healthScore < this.config.retirementHealthThreshold) {
        logger.warn({
          accountId: account.id,
          healthScore: health.healthScore,
        }, 'Auto-retiring unhealthy account');
        await this.pool.updateStatus(account.id, 'expired');
      }
    }

    // Check if we need to provision more accounts
    const readyCount = this.pool.getAccountsByStatus('ready').length;
    if (this.config.autoProvision && readyCount < this.config.pool.minReadyAccounts) {
      const needed = this.config.pool.minReadyAccounts - readyCount;
      logger.info({ needed }, 'Provisioning new accounts to maintain pool');
      // Provisioning would happen asynchronously
    }
  }

  /**
   * Get comprehensive statistics.
   */
  getStats(): AccountWarmerStats {
    const poolStats = this.pool.getStats();
    const warmupStats = this.warmer.getStats();

    return {
      totalAccounts: poolStats.totalAccounts,
      byStatus: poolStats.byStatus,
      byTier: poolStats.byTier,
      byRegion: poolStats.byRegion,
      averageHealthScore: poolStats.averageHealthScore,
      averageRecaptchaScore: poolStats.averageRecaptchaScore,
      averageAgeDays: 0, // Computed from pool
      accountsReady: poolStats.readyCount,
      accountsWarming: poolStats.warmingCount,
      accountsFlagged: poolStats.flaggedCount,
      warmupCompletionRate: warmupStats.accountsWarmed > 0
        ? warmupStats.accountsCompleted / warmupStats.accountsWarmed
        : 0,
      averageWarmupDurationDays: warmupStats.averageWarmupDays,
      recentFlagRate: poolStats.flaggedCount / Math.max(1, poolStats.totalAccounts),
      poolUtilization: poolStats.poolUtilization,
    };
  }

  /** Get the pool manager. */
  getPool(): AccountPoolManager { return this.pool; }

  /** Get the warming engine. */
  getWarmer(): WarmingEngine { return this.warmer; }
}

/** Singleton instance. */
export const accountWarmerManager = new AccountWarmerManager();
