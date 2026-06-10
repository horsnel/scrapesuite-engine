/**
 * Anti-Bot Manager -- Central Orchestrator for ScrapeSuite Engine
 *
 * The Manager is the single entry point for all anti-bot bypass operations.
 * It auto-detects which anti-bot platform is active, delegates to the
 * appropriate platform module, handles strategy escalation, and provides
 * a unified API for the rest of the engine.
 *
 * Architecture:
 *  +--------------------------------------------------------------------------+
 *  |                      Anti-Bot Manager (this file)                       |
 *  |                                                                         |
 *  |  +---------+ +---------+ +-----------+ +----------+ +------------+   |
 *  |  | Kasada  | | Akamai  | |Cloudflare | | DataDome | | PerimeterX |   |
 *  |  |Challenger| | Hydra   | | Turnstile | |Circumvent| |  Evader    |   |
 *  |  +---------+ +---------+ +-----------+ +----------+ +------------+   |
 *  |                                                                         |
 *  |  +--------------+ +--------------+ +--------------+ +--------------+ |
 *  |  | Kasada SW    | | Akamai       | | Deep Browser | | Stealth      | |
 *  |  | Proxy        | | Sensor       | | Patcher      | | Browser      | |
 *  |  +--------------+ +--------------+ +--------------+ +--------------+ |
 *  +--------------------------------------------------------------------------+
 *
 * Flow:
 *  1. handlePage(url, page, context, cdpSession) -- main entry
 *  2. Auto-detect which anti-bot platform(s) are active
 *  3. Delegate to the best-matching platform module
 *  4. If bypass fails, escalate strategy or try next platform
 *  5. Cache successful tokens for reuse
 *  6. Report unified statistics
 */

import type { Page, BrowserContext, CDPSession } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import {
  type AntiBotPlatform,
  type BypassStrategy,
  type ChallengePhase,
  type AntiBotResult,
  type AntiBotManagerConfig,
  type AntiBotManagerStats,
  type BypassContext,
  type PlatformDetectionResult,
  type DetectionIndicator,
  type IAntiBotModule,
  DEFAULT_PLATFORM_CONFIGS,
  PLATFORM_NAMES,
  STRATEGY_ESCALATION,
} from './types';

const logger = createChildLogger('anti-bot-manager');

// ===============================================================================
// DEFAULT MANAGER CONFIG
// ===============================================================================

const DEFAULT_MANAGER_CONFIG: AntiBotManagerConfig = {
  enabledPlatforms: ['kasada', 'akamai', 'cloudflare', 'datadome', 'perimeterx'],
  platformOverrides: {},
  autoEscalate: true,
  maxEscalations: 3,
  verboseLogging: false,
};

// ===============================================================================
// ANTI-BOT MANAGER
// ===============================================================================

class AntiBotManager {
  private config: AntiBotManagerConfig;
  private modules = new Map<AntiBotPlatform, IAntiBotModule>();
  private initialized = false;

  private stats = {
    totalBypassAttempts: 0,
    successfulBypasses: 0,
    failedBypasses: 0,
    platformStats: {} as Record<AntiBotPlatform, {
      attempts: number;
      successes: number;
      failures: number;
      successRate: number;
      avgSolveTimeMs: number;
    }>,
  };

  constructor(config?: Partial<AntiBotManagerConfig>) {
    this.config = { ...DEFAULT_MANAGER_CONFIG, ...config };
    this.initializePlatformStats();
  }

  private initializePlatformStats(): void {
    for (const platform of this.config.enabledPlatforms) {
      this.stats.platformStats[platform] = {
        attempts: 0,
        successes: 0,
        failures: 0,
        successRate: 0,
        avgSolveTimeMs: 0,
      };
    }
  }

  // --- Initialization ------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info({ enabledPlatforms: this.config.enabledPlatforms }, 'Initializing Anti-Bot Manager');

    // Load platform modules dynamically (lazy-load to avoid circular deps)
    const loadPromises = this.config.enabledPlatforms.map(async (platform) => {
      try {
        const module = await this.loadModule(platform);
        if (module) {
          await module.initialize();
          this.modules.set(platform, module);
          logger.info({ platform: PLATFORM_NAMES[platform] }, 'Platform module loaded');
        }
      } catch (err: any) {
        logger.warn(
          { platform: PLATFORM_NAMES[platform], err: err.message },
          'Failed to load platform module -- will be unavailable'
        );
      }
    });

    await Promise.allSettled(loadPromises);

    this.initialized = true;
    logger.info(
      { loadedModules: Array.from(this.modules.keys()).map(p => PLATFORM_NAMES[p]) },
      'Anti-Bot Manager initialized'
    );
  }

  private async loadModule(platform: AntiBotPlatform): Promise<IAntiBotModule | null> {
    switch (platform) {
      case 'kasada': {
        const { kasadaChallenger } = await import('./kasada-challenger');
        // Wrap the KasadaChallengerOrchestrator to match IAntiBotModule interface
        return this.wrapKasadaModule(kasadaChallenger);
      }
      case 'akamai': {
        const { akamaiHydra } = await import('./akamai-hydra');
        return akamaiHydra as unknown as IAntiBotModule;
      }
      case 'cloudflare': {
        const { cloudflareTurnstileSolver } = await import('./cloudflare-turnstyle');
        return cloudflareTurnstileSolver as unknown as IAntiBotModule;
      }
      case 'datadome': {
        const { datadomeCircumvent } = await import('./datadome-circumvent');
        return datadomeCircumvent as unknown as IAntiBotModule;
      }
      case 'perimeterx': {
        const { perimeterxEvader } = await import('./perimeterx-evader');
        return perimeterxEvader as unknown as IAntiBotModule;
      }
      default:
        logger.warn({ platform }, 'Unknown platform -- no module available');
        return null;
    }
  }

  /**
   * Wrap the existing KasadaChallengerOrchestrator to conform to IAntiBotModule.
   * The Kasada module was built before the unified interface, so it needs an adapter.
   */
  private wrapKasadaModule(challenger: any): IAntiBotModule {
    const self = this;
    return {
      platform: 'kasada' as AntiBotPlatform,
      async initialize() {
        // Already initialized by its own module
      },
      async detect(ctx: BypassContext): Promise<PlatformDetectionResult> {
        try {
          const detection = await challenger.detectChallenge(ctx.page);
          return {
            platform: 'kasada',
            confidence: detection.confidence,
            severity: detection.confidence > 0.7 ? 'high' : detection.confidence > 0.4 ? 'medium' : 'low',
            indicators: detection.indicators.map((ind: string) => ({
              category: 'dom' as const,
              description: ind,
              weight: 0.2,
            })),
            challengeType: detection.challengeType,
            isRechallenge: detection.challengeType === 'rechallenge',
            recommendedStrategy: 'browser-execute' as BypassStrategy,
          };
        } catch (err: any) {
          return {
            platform: 'kasada',
            confidence: 0,
            severity: 'none',
            indicators: [],
            challengeType: 'unknown',
            isRechallenge: false,
            recommendedStrategy: 'browser-execute' as BypassStrategy,
          };
        }
      },
      async bypass(ctx: BypassContext, strategy?: BypassStrategy): Promise<AntiBotResult> {
        const startTime = Date.now();
        try {
          const result = await challenger.solveChallenge(ctx.page, ctx.context, {
            cdpSession: ctx.cdpSession,
            domain: ctx.domain,
          });
          return {
            success: result.success,
            platform: 'kasada',
            strategy: (strategy || 'browser-execute') as BypassStrategy,
            phase: result.success ? 'complete' : 'failed',
            durationMs: result.solveDurationMs || Date.now() - startTime,
            cookies: (result.tokens || []).map((t: any) => ({
              name: 'kpsdk_cc',
              value: t.kpsdkCc || '',
              domain: t.domain || ctx.domain,
              path: '/',
              httpOnly: true,
              secure: true,
              sameSite: 'Lax' as const,
              setAt: t.extractedAt || Date.now(),
              refreshedAt: t.extractedAt || Date.now(),
              expiresAt: t.expiresAt || Date.now() + 300000,
              platform: 'kasada' as AntiBotPlatform,
              isValid: t.isValid,
              useCount: 0,
            })),
            extraHeaders: result.success ? { 'x-kpsdk-ct': (result.tokens[0]?.xKpsdkCt || '') } : {},
            detectionSignals: [],
            rechallengeExpected: result.rechallengeRequired,
            rechallengeInMs: 0,
            errors: result.errors || [],
            warnings: [],
            metadata: { strategy: result.strategy },
          };
        } catch (err: any) {
          return {
            success: false,
            platform: 'kasada',
            strategy: (strategy || 'browser-execute') as BypassStrategy,
            phase: 'failed',
            durationMs: Date.now() - startTime,
            cookies: [],
            extraHeaders: {},
            detectionSignals: [],
            rechallengeExpected: false,
            rechallengeInMs: 0,
            errors: [err.message],
            warnings: [],
            metadata: {},
          };
        }
      },
      hasValidTokens(domain: string): boolean {
        return !!challenger.getTokenForDomain(domain);
      },
      invalidateTokens(domain: string): void {
        challenger.invalidateToken(domain);
      },
      getProfile(domain: string) {
        const profile = challenger.getChallengeProfile(domain);
        if (!profile) return null;
        return {
          domain: profile.domain,
          platform: 'kasada' as AntiBotPlatform,
          successCount: profile.solveCount,
          failCount: profile.failCount,
          successRate: profile.successRate,
          avgSolveTimeMs: profile.avgSolveTimeMs,
          preferredStrategy: 'browser-execute' as BypassStrategy,
          lastSuccessAt: profile.lastSolvedAt,
          lastAttemptAt: 0,
          consecutiveFailures: 0,
          cooldownUntil: 0,
          challengeVersion: profile.challengeVersion,
          knownCookieNames: ['kpsdk_cc', 'kpsdk_st', 'cdkct'],
          knownHeaderNames: ['x-kpsdk-ct'],
          avgTokenLifetimeMs: profile.tokenExpiryMs,
          extra: {},
        };
      },
      getStats(): Record<string, unknown> {
        return challenger.getStats();
      },
    };
  }

  // --- Main Entry Point ----------------------------------------------------

  /**
   * Handle an anti-bot challenge on a page.
   * This is the primary API for the rest of the engine.
   *
   * @param url The URL being accessed
   * @param page The Playwright Page
   * @param context The BrowserContext
   * @param cdpSession Optional CDP session for low-level operations
   * @returns AntiBotResult indicating success or failure
   */
  async handlePage(
    url: string,
    page: Page,
    context: BrowserContext,
    cdpSession?: CDPSession
  ): Promise<AntiBotResult> {
    if (!this.initialized) await this.initialize();

    const domain = this.extractDomain(url);
    const startTime = Date.now();

    this.stats.totalBypassAttempts++;

    logger.info({ url, domain }, 'Anti-Bot Manager: handling page');

    // Step 1: Build bypass context
    const ctx: BypassContext = {
      page,
      context,
      cdpSession,
      url,
      domain,
    };

    // Step 2: Detect which anti-bot platform(s) are active
    const detections = await this.detectAll(ctx);

    if (detections.length === 0) {
      logger.info({ url }, 'No anti-bot platform detected -- page is clean');
      return {
        success: true,
        platform: 'generic',
        strategy: 'browser-execute',
        phase: 'complete',
        durationMs: Date.now() - startTime,
        cookies: [],
        extraHeaders: {},
        detectionSignals: [],
        rechallengeExpected: false,
        rechallengeInMs: 0,
        errors: [],
        warnings: ['No anti-bot platform detected'],
        metadata: {},
      };
    }

    // Step 3: Sort by confidence (highest first)
    detections.sort((a, b) => b.confidence - a.confidence);

    logger.info(
      {
        detected: detections.map(d => `${PLATFORM_NAMES[d.platform]} (${d.confidence.toFixed(2)})`),
      },
      'Anti-bot platforms detected'
    );

    // Step 4: Try bypass with the most likely platform first
    let lastResult: AntiBotResult | null = null;

    for (const detection of detections) {
      const module = this.modules.get(detection.platform);
      if (!module) {
        logger.warn(
          { platform: PLATFORM_NAMES[detection.platform] },
          'Platform detected but no module loaded -- skipping'
        );
        continue;
      }

      // Update context with detection info
      ctx.detectedPlatform = detection.platform;
      ctx.detectionConfidence = detection.confidence;

      logger.info(
        { platform: PLATFORM_NAMES[detection.platform], confidence: detection.confidence.toFixed(2), strategy: detection.recommendedStrategy },
        'Attempting bypass'
      );

      // Try the recommended strategy first, then escalate
      let strategy = detection.recommendedStrategy;
      const maxEscalations = this.config.maxEscalations;

      for (let escalation = 0; escalation <= maxEscalations; escalation++) {
        const result = await module.bypass(ctx, strategy);

        // Update stats
        const pStats = this.stats.platformStats[detection.platform];
        if (pStats) {
          pStats.attempts++;
          if (result.success) {
            pStats.successes++;
            this.stats.successfulBypasses++;
          } else {
            pStats.failures++;
          }
          pStats.successRate = pStats.successes / pStats.attempts;
          pStats.avgSolveTimeMs = pStats.successes > 0
            ? Math.round((pStats.avgSolveTimeMs * (pStats.successes - 1) + result.durationMs) / pStats.successes)
            : 0;
        }

        if (result.success) {
          logger.info(
            {
              platform: PLATFORM_NAMES[detection.platform],
              strategy: result.strategy,
              durationMs: result.durationMs,
              cookiesFound: result.cookies.length,
            },
            'Anti-bot bypass successful'
          );
          return result;
        }

        lastResult = result;

        // Escalate strategy
        if (this.config.autoEscalate && escalation < maxEscalations) {
          strategy = this.getNextStrategy(detection.platform, strategy);
          logger.info(
            { platform: PLATFORM_NAMES[detection.platform], newStrategy: strategy },
            'Escalating strategy'
          );
        } else {
          break;
        }
      }
    }

    // All attempts failed
    this.stats.failedBypasses++;

    logger.warn(
      { url, domain, attempts: detections.length },
      'All anti-bot bypass attempts failed'
    );

    return lastResult || {
      success: false,
      platform: 'generic',
      strategy: 'browser-execute',
      phase: 'failed',
      durationMs: Date.now() - startTime,
      cookies: [],
      extraHeaders: {},
      detectionSignals: [],
      rechallengeExpected: false,
      rechallengeInMs: 0,
      errors: ['All anti-bot bypass attempts failed'],
      warnings: [],
      metadata: {},
    };
  }

  // --- Detection -----------------------------------------------------------

  /**
   * Run detection across all enabled platform modules.
   * Returns all platforms that were detected (with confidence scores).
   */
  async detectAll(ctx: BypassContext): Promise<PlatformDetectionResult[]> {
    const results: PlatformDetectionResult[] = [];

    const detectPromises = Array.from(this.modules.entries()).map(
      async ([platform, module]) => {
        try {
          const detection = await module.detect(ctx);
          if (detection.confidence >= (this.config.globalDetectionThreshold ?? 0.3)) {
            return detection;
          }
          return null;
        } catch (err: any) {
          logger.debug(
            { platform: PLATFORM_NAMES[platform], err: err.message },
            'Detection failed for platform'
          );
          return null;
        }
      }
    );

    const settled = await Promise.allSettled(detectPromises);
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
      }
    }

    return results;
  }

  /**
   * Quick detection -- returns the most likely platform without full detection.
   * Useful for pre-checking before committing to a full bypass attempt.
   */
  async quickDetect(url: string, page: Page, context: BrowserContext): Promise<PlatformDetectionResult | null> {
    if (!this.initialized) await this.initialize();

    const ctx: BypassContext = {
      page,
      context,
      url,
      domain: this.extractDomain(url),
    };

    const detections = await this.detectAll(ctx);
    if (detections.length === 0) return null;

    detections.sort((a, b) => b.confidence - a.confidence);
    return detections[0];
  }

  // --- Token Management ----------------------------------------------------

  /**
   * Check if any module has valid cached tokens for a domain.
   */
  hasValidTokens(domain: string): boolean {
    for (const module of this.modules.values()) {
      if (module.hasValidTokens(domain)) return true;
    }
    return false;
  }

  /**
   * Invalidate tokens for all modules for a domain.
   */
  invalidateTokens(domain: string): void {
    for (const module of this.modules.values()) {
      module.invalidateTokens(domain);
    }
    logger.info({ domain }, 'All anti-bot tokens invalidated');
  }

  /**
   * Get the module for a specific platform.
   */
  getModule(platform: AntiBotPlatform): IAntiBotModule | undefined {
    return this.modules.get(platform);
  }

  // --- Strategy Helpers ----------------------------------------------------

  private getNextStrategy(platform: AntiBotPlatform, current: BypassStrategy): BypassStrategy {
    // Import is already available at module scope
    const strategies = STRATEGY_ESCALATION[platform] || STRATEGY_ESCALATION.generic;
    const currentIdx = strategies.indexOf(current);
    const nextIdx = Math.min(currentIdx + 1, strategies.length - 1);
    return strategies[nextIdx];
  }

  // --- Statistics ----------------------------------------------------------

  getStats(): AntiBotManagerStats {
    const overallSuccessRate = this.stats.totalBypassAttempts > 0
      ? this.stats.successfulBypasses / this.stats.totalBypassAttempts
      : 0;

    let cachedTokens = 0;
    let activeDomains = 0;
    const domainSet = new Set<string>();

    for (const module of this.modules.values()) {
      const moduleStats = module.getStats();
      cachedTokens += (moduleStats.cachedTokens as number) || 0;
      for (const domain of ((moduleStats.domains as string[]) || [])) {
        domainSet.add(domain);
      }
    }
    activeDomains = domainSet.size;

    return {
      totalBypassAttempts: this.stats.totalBypassAttempts,
      successfulBypasses: this.stats.successfulBypasses,
      failedBypasses: this.stats.failedBypasses,
      overallSuccessRate,
      platformStats: { ...this.stats.platformStats },
      activeDomains,
      cachedTokens,
    };
  }

  // --- Helpers -------------------------------------------------------------

  private extractDomain(url: string): string {
    try {
      const hostname = new URL(url).hostname;
      const parts = hostname.split('.');
      return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
    } catch {
      return 'unknown';
    }
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const antiBotManager = new AntiBotManager();
export default AntiBotManager;
