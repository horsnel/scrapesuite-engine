/**
 * Anti-Bot Base Module -- ScrapeSuite Engine
 *
 * Abstract base class providing shared infrastructure for all anti-bot
 * platform modules. Every platform module (Kasada, Akamai, Cloudflare,
 * DataDome, PerimeterX) extends this class to inherit:
 *
 *  * Token/cookie lifecycle management with Redis persistence
 *  * Adaptive domain profile tracking with success/failure learning
 *  * Strategy escalation with configurable thresholds
 *  * Cooldown management to avoid hammering protected sites
 *  * Unified logging with platform prefix
 *  * Statistics tracking
 *
 * Usage:
 *  class AkamaiEvader extends AntiBotBase { ... }
 */

import type { Page, BrowserContext, CDPSession } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import {
  type AntiBotPlatform,
  type BypassStrategy,
  type ChallengePhase,
  type AntiBotResult,
  type AntiBotPlatformConfig,
  type ManagedCookie,
  type PlatformProfile,
  type PlatformDetectionResult,
  type BypassContext,
  type DetectionIndicator,
  type IAntiBotModule,
  type AntiBotManagerStats,
  DEFAULT_PLATFORM_CONFIGS,
  STRATEGY_ESCALATION,
  PLATFORM_NAMES,
} from './types';

const logger = createChildLogger('anti-bot-base');

// ===============================================================================
// ABSTRACT BASE CLASS
// ===============================================================================

export abstract class AntiBotBase implements IAntiBotModule {
  abstract readonly platform: AntiBotPlatform;

  protected config: AntiBotPlatformConfig;
  protected profiles = new Map<string, PlatformProfile>();
  protected tokenCache = new Map<string, ManagedCookie[]>();
  protected initialized = false;
  protected currentPhase: ChallengePhase = 'idle';

  protected stats = {
    totalAttempts: 0,
    successes: 0,
    failures: 0,
    totalSolveTimeMs: 0,
    tokenReuses: 0,
    tokenExpirations: 0,
    strategyEscalations: 0,
    cooldowns: 0,
  };

  constructor(configOverride?: Partial<AntiBotPlatformConfig>) {
    const defaults = DEFAULT_PLATFORM_CONFIGS[this.platformOverride()] || DEFAULT_PLATFORM_CONFIGS.generic;
    this.config = { ...defaults, ...configOverride };
  }

  /** Override in subclass to provide the platform key. */
  protected abstract platformOverride(): AntiBotPlatform;

  /** Subclass must implement challenge detection logic. */
  abstract detect(ctx: BypassContext): Promise<PlatformDetectionResult>;

  /** Subclass must implement bypass logic. */
  abstract bypass(ctx: BypassContext, strategy?: BypassStrategy): Promise<AntiBotResult>;

  // --- Initialization ------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const platformName = PLATFORM_NAMES[this.platformOverride()];
    logger.info({ platform: platformName }, 'Initializing anti-bot module');

    try {
      // Load cached tokens from Redis
      const tokenKeys = await this.getCacheKeys(`${this.cachePrefix()}token:`);
      for (const key of tokenKeys) {
        const tokens = await cacheGet<ManagedCookie[]>(key);
        if (tokens && tokens.length > 0) {
          const domain = tokens[0].domain;
          const validTokens = tokens.filter(t => t.expiresAt > Date.now() && t.isValid);
          if (validTokens.length > 0) {
            this.tokenCache.set(domain, validTokens);
          }
        }
      }

      // Load domain profiles from Redis
      const profileKeys = await this.getCacheKeys(`${this.cachePrefix()}profile:`);
      for (const key of profileKeys) {
        const profile = await cacheGet<PlatformProfile>(key);
        if (profile) {
          this.profiles.set(profile.domain, profile);
        }
      }

      logger.info(
        { platform: platformName, cachedTokens: this.tokenCache.size, profiles: this.profiles.size },
        'Anti-bot module initialized'
      );
    } catch (err: any) {
      logger.warn(
        { platform: platformName, err: err.message },
        'Partial initialization -- some cached data unavailable'
      );
    }

    this.initialized = true;
  }

  // --- Token Management ----------------------------------------------------

  hasValidTokens(domain: string): boolean {
    const tokens = this.tokenCache.get(domain);
    if (!tokens || tokens.length === 0) return false;

    const now = Date.now();
    return tokens.some(t => t.isValid && t.expiresAt > now);
  }

  invalidateTokens(domain: string): void {
    const tokens = this.tokenCache.get(domain);
    if (tokens) {
      for (const token of tokens) {
        token.isValid = false;
      }
      this.tokenCache.delete(domain);
      logger.info({ platform: this.platformOverride(), domain }, 'Tokens invalidated');
    }
  }

  /**
   * Store tokens for a domain, persisting to Redis.
   */
  protected async storeTokens(domain: string, cookies: ManagedCookie[]): Promise<void> {
    this.tokenCache.set(domain, cookies);

    if (this.config.cacheTokens) {
      try {
        await cacheSet(
          `${this.cachePrefix()}token:${domain}`,
          cookies,
          this.config.cacheTtlSeconds
        );
      } catch (err: any) {
        logger.debug({ err: err.message, domain }, 'Failed to persist tokens to Redis');
      }
    }
  }

  /**
   * Get valid cached tokens for a domain.
   */
  protected getValidTokens(domain: string): ManagedCookie[] {
    const tokens = this.tokenCache.get(domain);
    if (!tokens) return [];

    const now = Date.now();
    return tokens.filter(t => t.isValid && t.expiresAt > now);
  }

  /**
   * Create a ManagedCookie from raw cookie data.
   */
  protected createManagedCookie(
    cookie: { name: string; value: string; domain: string; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' },
    lifetimeMs: number
  ): ManagedCookie {
    const now = Date.now();
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? true,
      sameSite: cookie.sameSite || 'Lax',
      setAt: now,
      refreshedAt: now,
      expiresAt: now + lifetimeMs,
      platform: this.platformOverride(),
      isValid: true,
      useCount: 0,
    };
  }

  // --- Profile Management --------------------------------------------------

  getProfile(domain: string): PlatformProfile | null {
    return this.profiles.get(domain) || null;
  }

  /**
   * Get or create an adaptive profile for a domain.
   */
  protected getOrCreateProfile(domain: string): PlatformProfile {
    let profile = this.profiles.get(domain);
    if (!profile) {
      profile = this.createDefaultProfile(domain);
      this.profiles.set(domain, profile);
    }
    return profile;
  }

  /**
   * Create a default profile for a new domain.
   */
  protected createDefaultProfile(domain: string): PlatformProfile {
    const platform = this.platformOverride();
    const strategies = STRATEGY_ESCALATION[platform] || STRATEGY_ESCALATION.generic;
    return {
      domain,
      platform,
      successCount: 0,
      failCount: 0,
      successRate: 0.5,
      avgSolveTimeMs: 15000,
      preferredStrategy: strategies[0],
      lastSuccessAt: 0,
      lastAttemptAt: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      challengeVersion: 'unknown',
      knownCookieNames: [],
      knownHeaderNames: [],
      avgTokenLifetimeMs: this.config.tokenFreshnessMs,
      extra: {},
    };
  }

  /**
   * Record a bypass result for adaptive learning.
   */
  protected recordResult(
    domain: string,
    success: boolean,
    durationMs: number,
    strategy: BypassStrategy
  ): void {
    const profile = this.getOrCreateProfile(domain);
    profile.lastAttemptAt = Date.now();

    if (success) {
      profile.successCount++;
      profile.lastSuccessAt = Date.now();
      profile.consecutiveFailures = 0;
      profile.preferredStrategy = strategy;
      profile.avgSolveTimeMs = Math.round(
        (profile.avgSolveTimeMs * (profile.successCount - 1) + durationMs) / profile.successCount
      );
    } else {
      profile.failCount++;
      profile.consecutiveFailures++;

      // Apply cooldown
      if (profile.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        profile.cooldownUntil = Date.now() + this.config.deepCooldownMs;
        this.stats.cooldowns++;
      } else {
        profile.cooldownUntil = Date.now() + this.config.failureCooldownMs;
      }
    }

    profile.successRate = profile.successCount / (profile.successCount + profile.failCount);

    // Persist to Redis
    if (this.config.trackProfiles) {
      cacheSet(`${this.cachePrefix()}profile:${domain}`, profile, 86400).catch(() => {});
    }
  }

  /**
   * Check if a domain is in cooldown.
   */
  protected isInCooldown(domain: string): boolean {
    const profile = this.profiles.get(domain);
    if (!profile) return false;
    return Date.now() < profile.cooldownUntil;
  }

  // --- Strategy Escalation -------------------------------------------------

  /**
   * Escalate to the next strategy for a domain.
   */
  protected escalateStrategy(domain: string): BypassStrategy {
    const platform = this.platformOverride();
    const strategies = STRATEGY_ESCALATION[platform] || STRATEGY_ESCALATION.generic;
    const profile = this.getOrCreateProfile(domain);

    const currentIdx = strategies.indexOf(profile.preferredStrategy);
    const nextIdx = Math.min(currentIdx + 1, strategies.length - 1);
    const nextStrategy = strategies[nextIdx];

    profile.preferredStrategy = nextStrategy;
    this.stats.strategyEscalations++;

    logger.info(
      { platform: PLATFORM_NAMES[platform], domain, from: strategies[currentIdx], to: nextStrategy },
      'Escalating bypass strategy'
    );

    return nextStrategy;
  }

  // --- Result Builders -----------------------------------------------------

  /**
   * Build a successful AntiBotResult.
   */
  protected buildSuccessResult(params: {
    strategy: BypassStrategy;
    durationMs: number;
    cookies?: ManagedCookie[];
    extraHeaders?: Record<string, string>;
    detectionSignals?: DetectionIndicator[];
    rechallengeExpected?: boolean;
    rechallengeInMs?: number;
    warnings?: string[];
    metadata?: Record<string, unknown>;
  }): AntiBotResult {
    this.stats.successes++;
    this.stats.totalSolveTimeMs += params.durationMs;

    return {
      success: true,
      platform: this.platformOverride(),
      strategy: params.strategy,
      phase: 'complete',
      durationMs: params.durationMs,
      cookies: params.cookies || [],
      extraHeaders: params.extraHeaders || {},
      detectionSignals: params.detectionSignals || [],
      rechallengeExpected: params.rechallengeExpected ?? false,
      rechallengeInMs: params.rechallengeInMs ?? 0,
      errors: [],
      warnings: params.warnings || [],
      metadata: params.metadata || {},
    };
  }

  /**
   * Build a failed AntiBotResult.
   */
  protected buildFailureResult(params: {
    strategy: BypassStrategy;
    durationMs: number;
    phase?: ChallengePhase;
    errors: string[];
    detectionSignals?: DetectionIndicator[];
    warnings?: string[];
    metadata?: Record<string, unknown>;
    cookies?: ManagedCookie[];
  }): AntiBotResult {
    this.stats.failures++;

    return {
      success: false,
      platform: this.platformOverride(),
      strategy: params.strategy,
      phase: params.phase || 'failed',
      durationMs: params.durationMs,
      cookies: params.cookies || [],
      extraHeaders: {},
      detectionSignals: params.detectionSignals || [],
      rechallengeExpected: false,
      rechallengeInMs: 0,
      errors: params.errors,
      warnings: params.warnings || [],
      metadata: params.metadata || {},
    };
  }

  // --- Statistics ----------------------------------------------------------

  getStats(): Record<string, unknown> {
    const platform = this.platformOverride();
    return {
      platform: PLATFORM_NAMES[platform],
      totalAttempts: this.stats.totalAttempts,
      successes: this.stats.successes,
      failures: this.stats.failures,
      successRate: this.stats.totalAttempts > 0
        ? (this.stats.successes / this.stats.totalAttempts).toFixed(3)
        : '0',
      avgSolveTimeMs: this.stats.successes > 0
        ? Math.round(this.stats.totalSolveTimeMs / this.stats.successes)
        : 0,
      tokenReuses: this.stats.tokenReuses,
      tokenExpirations: this.stats.tokenExpirations,
      strategyEscalations: this.stats.strategyEscalations,
      cooldowns: this.stats.cooldowns,
      cachedTokens: this.tokenCache.size,
      domainProfiles: this.profiles.size,
      domains: Array.from(this.profiles.keys()),
    };
  }

  // --- Helpers -------------------------------------------------------------

  protected extractDomain(url: string): string {
    try {
      const hostname = new URL(url).hostname;
      const parts = hostname.split('.');
      return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
    } catch {
      return 'unknown';
    }
  }

  protected cachePrefix(): string {
    return `antibot:${this.platformOverride()}:`;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async getCacheKeys(prefix: string): Promise<string[]> {
    try {
      const { redis } = await import('../utils/redis');
      const keys = await redis.keys(`cache:${prefix}*`);
      return keys.map((k: string) => k.replace('cache:', ''));
    } catch {
      return [];
    }
  }
}
