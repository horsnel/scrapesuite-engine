/**
 * Google Account Pool Manager — ScrapeSuite Engine
 *
 * Manages the lifecycle and allocation of Google accounts used
 * for authenticated scraping. The pool maintains accounts at
 * various stages — from newly created to fully warmed — and
 * allocates them based on task requirements.
 *
 * Key responsibilities:
 * - Account provisioning and lifecycle management
 * - Geographic consistency enforcement (same proxy region = same account)
 * - Health-based allocation (high-risk tasks get high-health accounts)
 * - Session tracking and usage limits
 * - Automatic account retirement and replacement
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type {
  GoogleAccount, AccountStatus, AccountTier, WarmupPhase,
  ServiceType, RiskLevel, AccountPoolConfig, AccountAllocation,
  AccountSession, ActivityRecord,
} from './types';

const logger = createChildLogger('account-pool');

const ACCOUNT_CACHE_PREFIX = 'account-warmer:account:';
const POOL_CACHE_PREFIX = 'account-warmer:pool:';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_POOL_CONFIG: AccountPoolConfig = {
  minReadyAccounts: 10,
  maxAccounts: 200,
  minReadyAgeDays: 14,
  targetRecaptchaScore: 0.7,
  maxParallelWarming: 5,
  flagCooldownHours: 48,
  maxUsagePerDay: 8,
  rotationStrategy: 'highest_health',
  targetRegions: ['US', 'GB', 'DE', 'JP', 'BR'],
};

// ===============================================================================
// ACCOUNT POOL MANAGER CLASS
// ===============================================================================

export class AccountPoolManager {
  private config: AccountPoolConfig;
  private accounts: Map<string, GoogleAccount> = new Map();
  private allocations: Map<string, AccountAllocation> = new Map();
  private dailyUsage: Map<string, number> = new Map();
  private lastUsageReset: number = Date.now();

  constructor(config?: Partial<AccountPoolConfig>) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  /**
   * Initialize the account pool with seed accounts.
   */
  async initialize(): Promise<void> {
    logger.info('Initializing account pool');
    await this.loadAccounts();
    logger.info({ accountCount: this.accounts.size }, 'Account pool loaded');
  }

  /**
   * Allocate an account for a scraping task.
   * Selects the best account based on health, region, and usage.
   */
  async allocate(options: {
    region?: string;
    service: ServiceType;
    requiresHighTrust?: boolean;
    maxSessionDuration?: number;
  }): Promise<AccountAllocation | null> {
    const { region, service, requiresHighTrust = false, maxSessionDuration = 1800000 } = options;

    // Reset daily usage if needed
    this.checkDailyReset();

    // Filter eligible accounts
    const eligible = Array.from(this.accounts.values()).filter(account => {
      if (account.status !== 'ready' && account.status !== 'active') return false;
      if (region && account.geoRegion !== region) return false;
      if (requiresHighTrust && account.healthScore < 70) return false;
      if (requiresHighTrust && account.recaptchaScore < 0.7) return false;
      const dailyCount = this.dailyUsage.get(account.id) || 0;
      if (dailyCount >= this.config.maxUsagePerDay) return false;
      return true;
    });

    if (eligible.length === 0) {
      logger.warn({ region, service, requiresHighTrust }, 'No eligible accounts available');
      return null;
    }

    // Select account based on rotation strategy
    const account = this.selectAccount(eligible);

    // Create allocation
    const allocation: AccountAllocation = {
      account,
      proxyEndpointId: account.proxyEndpointId,
      fingerprintId: account.fingerprintId,
      maxSessionDuration,
      highRisk: requiresHighTrust,
      allocatedAt: Date.now(),
    };

    // Track allocation and usage
    this.allocations.set(account.id, allocation);
    this.dailyUsage.set(account.id, (this.dailyUsage.get(account.id) || 0) + 1);

    // Update account state
    account.lastUsedAt = Date.now();
    account.totalSessions++;

    logger.info({
      accountId: account.id,
      email: account.email,
      healthScore: account.healthScore,
      recaptchaScore: account.recaptchaScore,
      service,
    }, 'Account allocated');

    return allocation;
  }

  /**
   * Release an account after a session ends.
   * Records session data and updates health metrics.
   */
  async release(accountId: string, sessionData: {
    durationMs: number;
    servicesVisited: ServiceType[];
    pagesVisited: number;
    searchesPerformed: number;
    recaptchaEncountered: boolean;
    recaptchaScore: number | null;
    flagged: boolean;
  }): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;

    // Update session history
    const session: AccountSession = {
      id: `session-${randomUUID().substring(0, 8)}`,
      startedAt: Date.now() - sessionData.durationMs,
      endedAt: Date.now(),
      durationMs: sessionData.durationMs,
      servicesVisited: sessionData.servicesVisited,
      pagesVisited: sessionData.pagesVisited,
      searchesPerformed: sessionData.searchesPerformed,
      recaptchaEncountered: sessionData.recaptchaEncountered,
      recaptchaScore: sessionData.recaptchaScore,
      flagged: sessionData.flagged,
      proxyIp: account.proxyEndpointId,
    };

    account.sessionHistory.push(session);
    if (account.sessionHistory.length > 100) account.sessionHistory.shift();

    account.totalBrowsingTimeMs += sessionData.durationMs;

    // Update services used
    for (const service of sessionData.servicesVisited) {
      if (!account.servicesUsed.includes(service)) {
        account.servicesUsed.push(service);
      }
    }

    // Calculate deep service count
    const serviceCounts: Record<string, number> = {};
    for (const s of account.sessionHistory) {
      for (const svc of s.servicesVisited) {
        serviceCounts[svc] = (serviceCounts[svc] || 0) + 1;
      }
    }
    account.deepServiceCount = Object.values(serviceCounts).filter(c => c >= 5).length;

    // Update reCAPTCHA score
    if (sessionData.recaptchaScore !== null) {
      account.recaptchaScore = account.recaptchaScore * 0.7 + sessionData.recaptchaScore * 0.3;
    }

    // Handle flagging
    if (sessionData.flagged) {
      account.riskLevel = 'high';
      account.status = 'flagged';
      logger.warn({ accountId, email: account.email }, 'Account flagged during session');
    } else {
      account.status = 'ready';
      // Improve risk level gradually
      if (account.riskLevel === 'high') account.riskLevel = 'medium';
      else if (account.riskLevel === 'medium') account.riskLevel = 'low';
    }

    // Remove allocation
    this.allocations.delete(accountId);

    // Persist
    await cacheSet(`${ACCOUNT_CACHE_PREFIX}${account.id}`, account, 86400 * 30);
  }

  /**
   * Create a new account and add it to the pool.
   * In production, this would use browser automation to create
   * a real Google account with email verification.
   */
  async createAccount(options: {
    region: string;
    proxyEndpointId: string;
    fingerprintId: string;
  }): Promise<GoogleAccount> {
    const { region, proxyEndpointId, fingerprintId } = options;

    const account: GoogleAccount = {
      id: `gacc-${randomUUID().substring(0, 8)}`,
      email: `scrape.warm.${randomUUID().substring(0, 6)}@gmail.com`,
      passwordHash: `[encrypted]${randomUUID().substring(0, 16)}`,
      createdAt: Date.now(),
      status: 'created',
      tier: 'basic',
      warmupPhase: 'creation',
      geoRegion: region,
      proxyEndpointId,
      fingerprintId,
      lastUsedAt: 0,
      totalSessions: 0,
      totalBrowsingTimeMs: 0,
      recaptchaScore: 0.3, // New accounts start low
      healthScore: 20, // New accounts start low
      riskLevel: 'medium',
      servicesUsed: [],
      deepServiceCount: 0,
      emailVerified: false,
      hasPhoneNumber: false,
      ageDays: 0,
      sessionHistory: [],
      recentActivity: [],
      metadata: {},
    };

    this.accounts.set(account.id, account);
    await cacheSet(`${ACCOUNT_CACHE_PREFIX}${account.id}`, account, 86400 * 30);

    logger.info({
      accountId: account.id,
      email: account.email,
      region,
    }, 'New account created');

    return account;
  }

  /**
   * Update an account's status.
   */
  async updateStatus(accountId: string, status: AccountStatus): Promise<boolean> {
    const account = this.accounts.get(accountId);
    if (!account) return false;

    account.status = status;
    await cacheSet(`${ACCOUNT_CACHE_PREFIX}${account.id}`, account, 86400 * 30);
    return true;
  }

  /**
   * Update an account's warmup phase.
   */
  async updateWarmupPhase(accountId: string, phase: WarmupPhase): Promise<boolean> {
    const account = this.accounts.get(accountId);
    if (!account) return false;

    account.warmupPhase = phase;
    if (phase === 'operational') {
      account.status = 'ready';
      account.tier = 'aged';
    }
    await cacheSet(`${ACCOUNT_CACHE_PREFIX}${account.id}`, account, 86400 * 30);
    return true;
  }

  /**
   * Record an activity for an account.
   */
  async recordActivity(accountId: string, activity: {
    type: string;
    service: ServiceType;
    durationMs: number;
    success: boolean;
    message?: string;
  }): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;

    const record: ActivityRecord = {
      type: activity.type as any,
      timestamp: Date.now(),
      service: activity.service,
      durationMs: activity.durationMs,
      success: activity.success,
      message: activity.message,
    };

    account.recentActivity.push(record);
    if (account.recentActivity.length > 1000) account.recentActivity.shift();

    // Update age
    account.ageDays = Math.floor((Date.now() - account.createdAt) / 86400000);

    // Update tier based on age
    if (account.ageDays >= 90) account.tier = 'premium';
    else if (account.ageDays >= 30) account.tier = 'aged';
    else account.tier = 'basic';
  }

  /**
   * Get accounts by status.
   */
  getAccountsByStatus(status: AccountStatus): GoogleAccount[] {
    return Array.from(this.accounts.values()).filter(a => a.status === status);
  }

  /**
   * Get all accounts.
   */
  getAllAccounts(): GoogleAccount[] {
    return Array.from(this.accounts.values());
  }

  /**
   * Get a specific account.
   */
  getAccount(accountId: string): GoogleAccount | undefined {
    return this.accounts.get(accountId);
  }

  /**
   * Get pool statistics.
   */
  getStats(): {
    totalAccounts: number;
    byStatus: Record<string, number>;
    byTier: Record<string, number>;
    byRegion: Record<string, number>;
    averageHealthScore: number;
    averageRecaptchaScore: number;
    readyCount: number;
    warmingCount: number;
    flaggedCount: number;
    poolUtilization: number;
  } {
    const accounts = Array.from(this.accounts.values());
    const byStatus: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    const byRegion: Record<string, number> = {};

    let totalHealth = 0;
    let totalRecaptcha = 0;

    for (const account of accounts) {
      byStatus[account.status] = (byStatus[account.status] || 0) + 1;
      byTier[account.tier] = (byTier[account.tier] || 0) + 1;
      byRegion[account.geoRegion] = (byRegion[account.geoRegion] || 0) + 1;
      totalHealth += account.healthScore;
      totalRecaptcha += account.recaptchaScore;
    }

    const ready = byStatus['ready'] || 0;
    const active = byStatus['active'] || 0;
    const total = accounts.length;

    return {
      totalAccounts: total,
      byStatus,
      byTier,
      byRegion,
      averageHealthScore: total > 0 ? Math.round(totalHealth / total) : 0,
      averageRecaptchaScore: total > 0 ? Math.round(totalRecaptcha / total * 100) / 100 : 0,
      readyCount: ready,
      warmingCount: byStatus['warming'] || 0,
      flaggedCount: byStatus['flagged'] || 0,
      poolUtilization: total > 0 ? Math.round(this.allocations.size / total * 100) : 0,
    };
  }

  // ---------- Internal Methods -------------------------------------------------

  private selectAccount(eligible: GoogleAccount[]): GoogleAccount {
    switch (this.config.rotationStrategy) {
      case 'highest_health':
        return eligible.sort((a, b) => b.healthScore - a.healthScore)[0];
      case 'least_used':
        return eligible.sort((a, b) => a.totalSessions - b.totalSessions)[0];
      case 'round_robin': {
        const leastRecent = eligible.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        return leastRecent[0];
      }
      case 'random':
        return eligible[Math.floor(Math.random() * eligible.length)];
      default:
        return eligible.sort((a, b) => b.healthScore - a.healthScore)[0];
    }
  }

  private checkDailyReset(): void {
    const now = Date.now();
    if (now - this.lastUsageReset > 86400000) {
      this.dailyUsage.clear();
      this.lastUsageReset = now;
    }
  }

  private async loadAccounts(): Promise<void> {
    // In production, load from database. For now, seed with sample accounts.
    const regions = this.config.targetRegions;
    for (let i = 0; i < 15; i++) {
      const region = regions[i % regions.length];
      const ageDays = 7 + Math.floor(Math.random() * 90);
      const healthScore = 30 + Math.floor(Math.random() * 60);
      const status: AccountStatus = healthScore >= 60 ? 'ready' : healthScore >= 40 ? 'warming' : 'created';
      const tier: AccountTier = ageDays >= 90 ? 'premium' : ageDays >= 30 ? 'aged' : 'basic';

      const account: GoogleAccount = {
        id: `gacc-seed-${i}`,
        email: `warm.account.${i}@gmail.com`,
        passwordHash: `[encrypted]seed${i}`,
        createdAt: Date.now() - ageDays * 86400000,
        status,
        tier,
        warmupPhase: status === 'ready' ? 'operational' : status === 'warming' ? 'depth_building' : 'initial_browsing',
        geoRegion: region,
        proxyEndpointId: `proxy-${region.toLowerCase()}-${i % 5}`,
        fingerprintId: `fp-${i}`,
        lastUsedAt: Date.now() - Math.random() * 86400000,
        totalSessions: Math.floor(Math.random() * 50),
        totalBrowsingTimeMs: Math.floor(Math.random() * 36000000),
        recaptchaScore: 0.3 + Math.random() * 0.6,
        healthScore,
        riskLevel: healthScore >= 60 ? 'low' : healthScore >= 40 ? 'medium' : 'high',
        servicesUsed: status === 'ready' ? ['search', 'gmail', 'youtube', 'maps'] : ['search'],
        deepServiceCount: status === 'ready' ? 3 : 1,
        emailVerified: ageDays > 3,
        hasPhoneNumber: ageDays > 14,
        ageDays,
        sessionHistory: [],
        recentActivity: [],
        metadata: { seed: true },
      };

      this.accounts.set(account.id, account);
    }
  }
}

/** Singleton instance. */
export const accountPoolManager = new AccountPoolManager();
