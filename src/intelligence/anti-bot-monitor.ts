/**
 * Anti-Bot Detection Monitor -- ScrapeSuite Engine
 *
 * Continuously monitors target domains for anti-bot defenses and
 * auto-adjusts bypass strategies in real time.
 *
 * * Per-domain success rate tracking with EMA (exponential moving average)
 * * CAPTCHA encounter rate tracking and classification
 * * Anti-bot system identification (Cloudflare, DataDome, Akamai, PerimeterX, Imperva)
 * * Best bypass strategy selection per domain
 * * Fingerprint/TLS profile performance comparison
 * * Automatic success rate drop detection with auto-adjustment triggers
 * * A/B testing of fingerprint and TLS profiles against domains
 * * Threat feed summarizing most active anti-bot systems
 */

import { createChildLogger } from '../utils/logger';
import { redis, cacheGet, cacheSet } from '../utils/redis';

const logger = createChildLogger('anti-bot-monitor');

// ===============================================================================
// TYPES
// ===============================================================================

export type HealthLevel = 'green' | 'yellow' | 'red' | 'critical';
export type AntiBotSystem = 'cloudflare' | 'datadome' | 'akamai' | 'perimeterx' | 'imperva' | 'kasada' | 'shape' | 'none';
export type CaptchaType = 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'funcaptcha' | 'geetest' | 'none';
export type ProxyTier = 'datacenter' | 'residential' | 'mobile' | 'isp';
export type BypassStrategy = 'http' | 'browser' | 'stealth-browser' | 'maximum-stealth';

export interface ScrapingAttempt {
  domain: string;
  success: boolean;
  statusCode: number;
  captchaType: CaptchaType;
  antibotSystem: AntiBotSystem;
  fingerprintProfile: string;
  tlsProfile: string;
  proxyTier: ProxyTier;
  responseTimeMs: number;
  timestamp: number;
}

export interface DomainHealthStatus {
  domain: string;
  health: HealthLevel;
  successRate: number;
  emaSuccessRate: number;
  captchaRate: number;
  antibotSystems: AntiBotSystem[];
  bestStrategy: BypassStrategy;
  bestFingerprintProfile: string;
  bestTlsProfile: string;
  bestProxyTier: ProxyTier;
  totalAttempts: number;
  recentAttempts: number;
  lastDetectedAntibot: string | null;
  lastUpdated: number;
}

export interface ProfilePerformance {
  profileName: string;
  profileType: 'fingerprint' | 'tls';
  successCount: number;
  failCount: number;
  successRate: number;
  avgResponseMs: number;
  domainsTested: number;
  lastUsed: number;
}

export interface ThreatFeedEntry {
  antibotSystem: AntiBotSystem;
  activeDomains: number;
  avgBlockRate: number;
  trend: 'increasing' | 'stable' | 'decreasing';
  lastDetected: number;
  recommendedAction: string;
}

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Success rate thresholds for health alert levels */
export const DOMAIN_HEALTH_THRESHOLDS: Record<HealthLevel, { min: number; max: number }> = {
  green:    { min: 0.85, max: 1.01 },
  yellow:   { min: 0.65, max: 0.85 },
  red:      { min: 0.45, max: 0.65 },
  critical: { min: 0.00, max: 0.45 },
};

/** EMA smoothing factor -- higher = more responsive to recent changes */
const EMA_ALPHA = 0.15;

/** Window for recent attempt counting (5 minutes) */
const RECENT_WINDOW_MS = 5 * 60 * 1000;

/** Minimum attempts before EMA is meaningful */
const MIN_ATTEMPTS_FOR_EMA = 5;

/** Drop detection: if EMA drops by this percentage relative to previous, flag it */
const DROP_DETECTION_THRESHOLD = 0.15;

/** Auto-adjustment rules keyed by anti-bot system */
export const AUTO_ADJUSTMENT_RULES: Record<string, {
  triggerRate: number;
  strategy: BypassStrategy;
  proxyTier: ProxyTier;
  notes: string;
}> = {
  datadome: {
    triggerRate: 0.60,
    strategy: 'maximum-stealth',
    proxyTier: 'mobile',
    notes: 'DataDome ML is aggressive -- switch to mobile proxies + maximum stealth with canvas/audio noise',
  },
  cloudflare: {
    triggerRate: 0.55,
    strategy: 'stealth-browser',
    proxyTier: 'residential',
    notes: 'Cloudflare challenge pages require stealth browser with TLS JA3 match + residential proxy',
  },
  akamai: {
    triggerRate: 0.50,
    strategy: 'maximum-stealth',
    proxyTier: 'residential',
    notes: 'Akamai Bot Manager uses sensor data -- maximum stealth with consistent fingerprint required',
  },
  perimeterx: {
    triggerRate: 0.55,
    strategy: 'maximum-stealth',
    proxyTier: 'mobile',
    notes: 'PerimeterX HUMAN uses advanced behavioral analysis -- mobile proxies + human-like behavior',
  },
  imperva: {
    triggerRate: 0.50,
    strategy: 'stealth-browser',
    proxyTier: 'residential',
    notes: 'Imperva Incapsula uses JS challenges -- stealth browser with proper JS execution needed',
  },
  kasada: {
    triggerRate: 0.45,
    strategy: 'maximum-stealth',
    proxyTier: 'mobile',
    notes: 'Kasada obfuscates JS heavily -- maximum stealth with rotated mobile IPs essential',
  },
  shape: {
    triggerRate: 0.40,
    strategy: 'maximum-stealth',
    proxyTier: 'mobile',
    notes: 'F5 Shape uses signal processing -- extremely difficult, mobile + maximum stealth only option',
  },
};

/** Cache TTLs */
const DOMAIN_STATUS_CACHE_TTL = 120;     // 2 min
const THREAT_FEED_CACHE_TTL = 300;       // 5 min
const STATS_CACHE_TTL = 60;              // 1 min

// ===============================================================================
// ANTI-BOT MONITOR ENGINE
// ===============================================================================

export class AntiBotMonitorEngine {
  private domainStatuses = new Map<string, DomainHealthStatus>();
  private attemptHistory: ScrapingAttempt[] = [];
  private profilePerformances = new Map<string, ProfilePerformance>();
  private emaValues = new Map<string, number>();
  private previousEmaValues = new Map<string, number>();
  private dropAlerts = new Map<string, number>(); // domain -> timestamp of last alert
  private initialized = false;

  private readonly MAX_HISTORY = 5000;
  private readonly DROP_ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown between alerts

  // --- Initialization ---------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Anti-Bot Detection Monitor...');

    // Try to load cached domain statuses from Redis
    try {
      const cachedStatuses = await cacheGet<Record<string, DomainHealthStatus>>('antibot:domain-statuses');
      if (cachedStatuses && typeof cachedStatuses === 'object') {
        const entries = Object.entries(cachedStatuses);
        for (const [domain, status] of entries) {
          this.domainStatuses.set(domain, status);
        }
        logger.info({ count: entries.length }, 'Loaded cached domain statuses from Redis');
      }
    } catch (err) {
      logger.debug({ err }, 'No cached domain statuses found -- starting fresh');
    }

    this.initialized = true;
    logger.info('Anti-Bot Detection Monitor initialized');
  }

  // --- Record Attempt ---------------------------------------------------------

  async recordAttempt(attempt: ScrapingAttempt): Promise<void> {
    // Store in history ring buffer
    this.attemptHistory.push(attempt);
    if (this.attemptHistory.length > this.MAX_HISTORY) {
      this.attemptHistory = this.attemptHistory.slice(-this.MAX_HISTORY);
    }

    // Get or create domain status
    const existing = this.domainStatuses.get(attempt.domain);
    const domainAttempts = this.getDomainAttempts(attempt.domain);
    const recentAttempts = this.getRecentAttempts(attempt.domain);
    const totalAttempts = domainAttempts.length;
    const recentSuccesses = recentAttempts.filter(a => a.success).length;
    const captchaEncounters = recentAttempts.filter(a => a.captchaType !== 'none').length;
    const successRate = totalAttempts > 0 ? domainAttempts.filter(a => a.success).length / totalAttempts : 1;
    const captchaRate = recentAttempts.length > 0 ? captchaEncounters / recentAttempts.length : 0;

    // Compute EMA success rate
    const prevEma = this.emaValues.get(attempt.domain) ?? successRate;
    const newEma = totalAttempts >= MIN_ATTEMPTS_FOR_EMA
      ? prevEma * (1 - EMA_ALPHA) + (attempt.success ? 1 : 0) * EMA_ALPHA
      : successRate;

    this.previousEmaValues.set(attempt.domain, prevEma);
    this.emaValues.set(attempt.domain, newEma);

    // Detect anti-bot systems
    const antibotSystems = this.detectAntibotSystems(attempt.domain, domainAttempts);

    // Determine best performing profiles
    this.updateProfilePerformance(attempt);

    // Compute best strategy and profiles
    const bestStrategy = this.computeBestStrategy(attempt.domain, antibotSystems, newEma);
    const bestFingerprint = this.computeBestProfile(attempt.domain, 'fingerprint');
    const bestTls = this.computeBestProfile(attempt.domain, 'tls');
    const bestProxyTier = this.computeBestProxyTier(attempt.domain, antibotSystems, newEma);

    // Compute health level
    const health = this.classifyHealth(newEma);

    // Build updated status
    const status: DomainHealthStatus = {
      domain: attempt.domain,
      health,
      successRate: Math.round(successRate * 1000) / 1000,
      emaSuccessRate: Math.round(newEma * 1000) / 1000,
      captchaRate: Math.round(captchaRate * 1000) / 1000,
      antibotSystems,
      bestStrategy,
      bestFingerprintProfile: bestFingerprint,
      bestTlsProfile: bestTls,
      bestProxyTier,
      totalAttempts,
      recentAttempts: recentAttempts.length,
      lastDetectedAntibot: attempt.antibotSystem !== 'none' ? attempt.antibotSystem : (existing?.lastDetectedAntibot ?? null),
      lastUpdated: Date.now(),
    };

    this.domainStatuses.set(attempt.domain, status);

    // Check for success rate drop
    await this.detectSuccessRateDrop(attempt.domain);

    // Persist to Redis periodically (every 10th attempt)
    if (totalAttempts % 10 === 0) {
      await this.persistDomainStatuses();
    }

    logger.debug({
      domain: attempt.domain,
      success: attempt.success,
      ema: Math.round(newEma * 100) / 100,
      health,
      antibot: attempt.antibotSystem,
    }, 'Attempt recorded');
  }

  // --- Get Domain Status ------------------------------------------------------

  async getDomainStatus(domain: string): Promise<DomainHealthStatus | null> {
    // Check memory first
    const cached = this.domainStatuses.get(domain);
    if (cached) return cached;

    // Check Redis
    try {
      const redisStatus = await cacheGet<DomainHealthStatus>(`antibot:status:${domain}`);
      if (redisStatus) {
        this.domainStatuses.set(domain, redisStatus);
        return redisStatus;
      }
    } catch { /* ignore */ }

    return null;
  }

  // --- Get Recommended Strategy -----------------------------------------------

  async getRecommendedStrategy(domain: string): Promise<{
    strategy: BypassStrategy;
    proxyTier: ProxyTier;
    fingerprintProfile: string;
    tlsProfile: string;
    confidence: number;
  }> {
    const status = await this.getDomainStatus(domain);

    if (!status) {
      return {
        strategy: 'http',
        proxyTier: 'residential',
        fingerprintProfile: 'chrome-130-win',
        tlsProfile: 'chrome-130-win',
        confidence: 0.5,
      };
    }

    // Check auto-adjustment rules for detected anti-bot systems
    for (const system of status.antibotSystems) {
      const rule = AUTO_ADJUSTMENT_RULES[system];
      if (rule && status.emaSuccessRate < rule.triggerRate) {
        logger.info({
          domain,
          system,
          ema: status.emaSuccessRate,
          rule: rule.notes,
        }, 'Auto-adjustment rule triggered');
        return {
          strategy: rule.strategy,
          proxyTier: rule.proxyTier,
          fingerprintProfile: status.bestFingerprintProfile,
          tlsProfile: status.bestTlsProfile,
          confidence: 0.7,
        };
      }
    }

    return {
      strategy: status.bestStrategy,
      proxyTier: status.bestProxyTier,
      fingerprintProfile: status.bestFingerprintProfile,
      tlsProfile: status.bestTlsProfile,
      confidence: Math.min(status.emaSuccessRate, 0.95),
    };
  }

  // --- Detect Success Rate Drop (EMA-based) ----------------------------------

  async detectSuccessRateDrop(domain?: string): Promise<Array<{
    domain: string;
    previousEma: number;
    currentEma: number;
    dropPercent: number;
    severity: HealthLevel;
    recommendation: string;
  }>> {
    const alerts: Array<{
      domain: string;
      previousEma: number;
      currentEma: number;
      dropPercent: number;
      severity: HealthLevel;
      recommendation: string;
    }> = [];

    const domains = domain ? [domain] : [...this.emaValues.keys()];

    for (const d of domains) {
      const currentEma = this.emaValues.get(d) ?? 1;
      const prevEma = this.previousEmaValues.get(d) ?? 1;

      // Calculate relative drop
      if (prevEma > 0) {
        const dropPercent = (prevEma - currentEma) / prevEma;

        if (dropPercent >= DROP_DETECTION_THRESHOLD) {
          // Cooldown check
          const lastAlert = this.dropAlerts.get(d) ?? 0;
          if (Date.now() - lastAlert < this.DROP_ALERT_COOLDOWN_MS) continue;

          this.dropAlerts.set(d, Date.now());
          const severity = this.classifyHealth(currentEma);

          // Build recommendation from auto-adjustment rules
          const status = this.domainStatuses.get(d);
          let recommendation = 'Monitor closely -- success rate is declining';
          if (status) {
            for (const system of status.antibotSystems) {
              const rule = AUTO_ADJUSTMENT_RULES[system];
              if (rule) {
                recommendation = rule.notes;
                break;
              }
            }
          }

          const alert = {
            domain: d,
            previousEma: Math.round(prevEma * 1000) / 1000,
            currentEma: Math.round(currentEma * 1000) / 1000,
            dropPercent: Math.round(dropPercent * 1000) / 10,
            severity,
            recommendation,
          };

          alerts.push(alert);
          logger.warn(alert, 'Success rate drop detected via EMA');
        }
      }
    }

    return alerts;
  }

  // --- A/B Test Profiles ------------------------------------------------------

  async abTestProfiles(
    domain: string,
    options?: {
      fingerprintProfiles?: string[];
      tlsProfiles?: string[];
      proxyTiers?: ProxyTier[];
      maxConcurrent?: number;
    },
  ): Promise<{
    results: Array<{
      fingerprintProfile: string;
      tlsProfile: string;
      proxyTier: ProxyTier;
      success: boolean;
      responseTimeMs: number;
      antibotSystem: AntiBotSystem;
    }>;
    winner: {
      fingerprintProfile: string;
      tlsProfile: string;
      proxyTier: ProxyTier;
    } | null;
  }> {
    const fingerprintProfiles = options?.fingerprintProfiles ?? [
      'chrome-130-win', 'chrome-130-android', 'safari-18-mac',
      'firefox-130-win', 'edge-130-win',
    ];
    const tlsProfiles = options?.tlsProfiles ?? [
      'chrome-130-win', 'chrome-130-android', 'safari-18-mac',
      'firefox-130-win', 'safari-18-ios',
    ];
    const proxyTiers = options?.proxyTiers ?? ['residential', 'mobile'];
    const maxConcurrent = options?.maxConcurrent ?? 3;

    logger.info({
      domain,
      fingerprintCount: fingerprintProfiles.length,
      tlsCount: tlsProfiles.length,
      proxyTiers,
    }, 'Starting A/B profile test');

    const results: Array<{
      fingerprintProfile: string;
      tlsProfile: string;
      proxyTier: ProxyTier;
      success: boolean;
      responseTimeMs: number;
      antibotSystem: AntiBotSystem;
    }> = [];

    // Generate test matrix -- pick combinations strategically
    const testMatrix: Array<{ fp: string; tls: string; proxy: ProxyTier }> = [];
    for (let i = 0; i < Math.min(fingerprintProfiles.length, tlsProfiles.length); i++) {
      for (const proxy of proxyTiers) {
        testMatrix.push({
          fp: fingerprintProfiles[i],
          tls: tlsProfiles[i],
          proxy,
        });
      }
    }

    // Run tests in batches (simulated -- in production this would make real requests)
    for (let batch = 0; batch < testMatrix.length; batch += maxConcurrent) {
      const batchItems = testMatrix.slice(batch, batch + maxConcurrent);

      const batchResults = batchItems.map(({ fp, tls, proxy }) => {
        // Simulate test by looking at historical performance
        const perfKey = `${fp}:${domain}`;
        const tlsPerfKey = `${tls}:${domain}`;
        const fpPerf = this.profilePerformances.get(perfKey);
        const tlsPerf = this.profilePerformances.get(tlsPerfKey);

        const fpSuccessRate = fpPerf?.successRate ?? 0.5;
        const tlsSuccessRate = tlsPerf?.successRate ?? 0.5;
        const combinedSuccess = (fpSuccessRate + tlsSuccessRate) / 2;

        // Add proxy tier modifier
        const proxyModifier = proxy === 'mobile' ? 0.1 : proxy === 'residential' ? 0.05 : 0;
        const predictedSuccess = combinedSuccess + proxyModifier;

        const success = Math.random() < Math.min(predictedSuccess, 0.95);
        const responseTimeMs = success
          ? 1000 + Math.floor(Math.random() * 3000)
          : 5000 + Math.floor(Math.random() * 5000);

        const status = this.domainStatuses.get(domain);
        const antibotSystem = status?.antibotSystems[0] ?? 'none';

        return {
          fingerprintProfile: fp,
          tlsProfile: tls,
          proxyTier: proxy,
          success,
          responseTimeMs,
          antibotSystem,
        };
      });

      results.push(...batchResults);
    }

    // Determine winner: highest success rate, then lowest response time
    const successfulResults = results.filter(r => r.success);
    let winner: { fingerprintProfile: string; tlsProfile: string; proxyTier: ProxyTier } | null = null;

    if (successfulResults.length > 0) {
      successfulResults.sort((a, b) => a.responseTimeMs - b.responseTimeMs);
      winner = {
        fingerprintProfile: successfulResults[0].fingerprintProfile,
        tlsProfile: successfulResults[0].tlsProfile,
        proxyTier: successfulResults[0].proxyTier,
      };
    }

    logger.info({
      domain,
      testsRun: results.length,
      successes: successfulResults.length,
      winner: winner?.fingerprintProfile ?? 'none',
    }, 'A/B profile test completed');

    return { results, winner };
  }

  // --- Get Threat Feed --------------------------------------------------------

  async getThreatFeed(): Promise<ThreatFeedEntry[]> {
    // Check Redis cache first
    const cached = await cacheGet<ThreatFeedEntry[]>('antibot:threat-feed');
    if (cached) return cached;

    // Build threat feed from domain statuses
    const systemStats = new Map<AntiBotSystem, {
      domains: Set<string>;
      totalBlockRate: number;
      domainCount: number;
      lastSeen: number;
    }>();

    for (const [, status] of this.domainStatuses) {
      for (const system of status.antibotSystems) {
        const existing = systemStats.get(system);
        if (existing) {
          existing.domains.add(status.domain);
          existing.totalBlockRate += (1 - status.successRate);
          existing.domainCount++;
          existing.lastSeen = Math.max(existing.lastSeen, status.lastUpdated);
        } else {
          systemStats.set(system, {
            domains: new Set([status.domain]),
            totalBlockRate: 1 - status.successRate,
            domainCount: 1,
            lastSeen: status.lastUpdated,
          });
        }
      }
    }

    const feed: ThreatFeedEntry[] = [];

    for (const [system, stats] of systemStats) {
      const avgBlockRate = stats.domainCount > 0 ? stats.totalBlockRate / stats.domainCount : 0;

      // Determine trend by comparing recent vs older data
      const recentDomains = [...this.domainStatuses.values()].filter(
        s => s.antibotSystems.includes(system) && Date.now() - s.lastUpdated < RECENT_WINDOW_MS,
      );
      const olderDomains = [...this.domainStatuses.values()].filter(
        s => s.antibotSystems.includes(system) && Date.now() - s.lastUpdated >= RECENT_WINDOW_MS,
      );
      const recentAvg = recentDomains.length > 0
        ? recentDomains.reduce((sum, s) => sum + (1 - s.successRate), 0) / recentDomains.length
        : 0;
      const olderAvg = olderDomains.length > 0
        ? olderDomains.reduce((sum, s) => sum + (1 - s.successRate), 0) / olderDomains.length
        : 0;

      const trend: 'increasing' | 'stable' | 'decreasing' =
        recentAvg > olderAvg * 1.15 ? 'increasing'
        : recentAvg < olderAvg * 0.85 ? 'decreasing'
        : 'stable';

      const rule = AUTO_ADJUSTMENT_RULES[system];

      feed.push({
        antibotSystem: system,
        activeDomains: stats.domains.size,
        avgBlockRate: Math.round(avgBlockRate * 1000) / 1000,
        trend,
        lastDetected: stats.lastSeen,
        recommendedAction: rule?.notes ?? 'Monitor and adjust strategy as needed',
      });
    }

    // Sort by active domains (most widespread first)
    feed.sort((a, b) => b.activeDomains - a.activeDomains);

    // Cache
    await cacheSet('antibot:threat-feed', feed, THREAT_FEED_CACHE_TTL);

    return feed;
  }

  // --- Get Stats --------------------------------------------------------------

  async getStats(): Promise<{
    totalDomains: number;
    totalAttempts: number;
    healthDistribution: Record<HealthLevel, number>;
    topAntibotSystems: Array<{ system: AntiBotSystem; count: number }>;
    topBlockedDomains: Array<{ domain: string; successRate: number; health: HealthLevel }>;
    profileCount: number;
    initialized: boolean;
  }> {
    const healthDistribution: Record<HealthLevel, number> = { green: 0, yellow: 0, red: 0, critical: 0 };
    const systemCounts = new Map<AntiBotSystem, number>();

    for (const [, status] of this.domainStatuses) {
      healthDistribution[status.health]++;
      for (const system of status.antibotSystems) {
        systemCounts.set(system, (systemCounts.get(system) ?? 0) + 1);
      }
    }

    const topAntibotSystems = [...systemCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([system, count]) => ({ system, count }));

    const topBlockedDomains = [...this.domainStatuses.values()]
      .sort((a, b) => a.emaSuccessRate - b.emaSuccessRate)
      .slice(0, 10)
      .map(s => ({ domain: s.domain, successRate: s.emaSuccessRate, health: s.health }));

    return {
      totalDomains: this.domainStatuses.size,
      totalAttempts: this.attemptHistory.length,
      healthDistribution,
      topAntibotSystems,
      topBlockedDomains,
      profileCount: this.profilePerformances.size,
      initialized: this.initialized,
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private classifyHealth(emaSuccessRate: number): HealthLevel {
    if (emaSuccessRate >= DOMAIN_HEALTH_THRESHOLDS.green.min) return 'green';
    if (emaSuccessRate >= DOMAIN_HEALTH_THRESHOLDS.yellow.min) return 'yellow';
    if (emaSuccessRate >= DOMAIN_HEALTH_THRESHOLDS.red.min) return 'red';
    return 'critical';
  }

  private detectAntibotSystems(domain: string, attempts: ScrapingAttempt[]): AntiBotSystem[] {
    const systems = new Set<AntiBotSystem>();
    const recent = attempts.filter(a => Date.now() - a.timestamp < 30 * 60 * 1000); // last 30 min
    for (const attempt of recent) {
      if (attempt.antibotSystem !== 'none') {
        systems.add(attempt.antibotSystem);
      }
    }
    return [...systems];
  }

  private updateProfilePerformance(attempt: ScrapingAttempt): void {
    // Update fingerprint profile performance
    const fpKey = `${attempt.fingerprintProfile}:${attempt.domain}`;
    const existing = this.profilePerformances.get(fpKey);
    if (existing) {
      existing.successCount += attempt.success ? 1 : 0;
      existing.failCount += attempt.success ? 0 : 1;
      existing.successRate = existing.successCount / (existing.successCount + existing.failCount);
      existing.avgResponseMs = Math.round(
        existing.avgResponseMs * 0.9 + attempt.responseTimeMs * 0.1,
      );
      existing.lastUsed = attempt.timestamp;
    } else {
      this.profilePerformances.set(fpKey, {
        profileName: attempt.fingerprintProfile,
        profileType: 'fingerprint',
        successCount: attempt.success ? 1 : 0,
        failCount: attempt.success ? 0 : 1,
        successRate: attempt.success ? 1 : 0,
        avgResponseMs: attempt.responseTimeMs,
        domainsTested: 1,
        lastUsed: attempt.timestamp,
      });
    }

    // Update TLS profile performance
    const tlsKey = `${attempt.tlsProfile}:${attempt.domain}`;
    const existingTls = this.profilePerformances.get(tlsKey);
    if (existingTls) {
      existingTls.successCount += attempt.success ? 1 : 0;
      existingTls.failCount += attempt.success ? 0 : 1;
      existingTls.successRate = existingTls.successCount / (existingTls.successCount + existingTls.failCount);
      existingTls.avgResponseMs = Math.round(
        existingTls.avgResponseMs * 0.9 + attempt.responseTimeMs * 0.1,
      );
      existingTls.lastUsed = attempt.timestamp;
    } else {
      this.profilePerformances.set(tlsKey, {
        profileName: attempt.tlsProfile,
        profileType: 'tls',
        successCount: attempt.success ? 1 : 0,
        failCount: attempt.success ? 0 : 1,
        successRate: attempt.success ? 1 : 0,
        avgResponseMs: attempt.responseTimeMs,
        domainsTested: 1,
        lastUsed: attempt.timestamp,
      });
    }
  }

  private computeBestStrategy(
    domain: string,
    antibotSystems: AntiBotSystem[],
    emaSuccessRate: number,
  ): BypassStrategy {
    // Check auto-adjustment rules first
    for (const system of antibotSystems) {
      const rule = AUTO_ADJUSTMENT_RULES[system];
      if (rule && emaSuccessRate < rule.triggerRate) {
        return rule.strategy;
      }
    }

    // General strategy based on EMA
    if (emaSuccessRate >= 0.85) return 'http';
    if (emaSuccessRate >= 0.65) return 'browser';
    if (emaSuccessRate >= 0.45) return 'stealth-browser';
    return 'maximum-stealth';
  }

  private computeBestProfile(domain: string, profileType: 'fingerprint' | 'tls'): string {
    let bestProfile = profileType === 'fingerprint' ? 'chrome-130-win' : 'chrome-130-win';
    let bestScore = -1;

    for (const [key, perf] of this.profilePerformances) {
      if (perf.profileType !== profileType) continue;
      if (!key.endsWith(`:${domain}`)) continue;
      const score = perf.successRate * 100 - perf.avgResponseMs * 0.01;
      if (score > bestScore) {
        bestScore = score;
        bestProfile = perf.profileName;
      }
    }

    return bestProfile;
  }

  private computeBestProxyTier(
    domain: string,
    antibotSystems: AntiBotSystem[],
    emaSuccessRate: number,
  ): ProxyTier {
    // Check auto-adjustment rules
    for (const system of antibotSystems) {
      const rule = AUTO_ADJUSTMENT_RULES[system];
      if (rule && emaSuccessRate < rule.triggerRate) {
        return rule.proxyTier;
      }
    }

    // General proxy tier based on EMA
    if (emaSuccessRate >= 0.85) return 'datacenter';
    if (emaSuccessRate >= 0.65) return 'residential';
    return 'mobile';
  }

  private getDomainAttempts(domain: string): ScrapingAttempt[] {
    return this.attemptHistory.filter(a => a.domain === domain);
  }

  private getRecentAttempts(domain: string): ScrapingAttempt[] {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return this.attemptHistory.filter(a => a.domain === domain && a.timestamp >= cutoff);
  }

  private async persistDomainStatuses(): Promise<void> {
    try {
      const obj: Record<string, DomainHealthStatus> = {};
      for (const [domain, status] of this.domainStatuses) {
        obj[domain] = status;
      }
      await cacheSet('antibot:domain-statuses', obj, DOMAIN_STATUS_CACHE_TTL);
    } catch (err) {
      logger.debug({ err }, 'Failed to persist domain statuses to Redis');
    }
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const antiBotMonitor = new AntiBotMonitorEngine();
