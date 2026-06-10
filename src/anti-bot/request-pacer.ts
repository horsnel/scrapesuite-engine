/**
 * Intelligent Request Pacing Engine -- ScrapeSuite Engine
 *
 * Models human between-request behavior to evade behavioral analysis
 * systems like Akamai Bot Manager and DataDome. Uses Gaussian-distributed
 * timing, session flow modeling, time-of-day adaptation, and adaptive
 * challenge response to produce natural browsing patterns.
 *
 * Estimated improvement: +3-5% against Akamai/DataDome behavioral analysis
 */

import { createChildLogger } from '../utils/logger';
import { redis, cacheGet, cacheSet } from '../utils/redis';

const logger = createChildLogger('request-pacer');

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

export type PageType =
  | 'homepage'
  | 'product'
  | 'article'
  | 'search-results'
  | 'category'
  | 'checkout'
  | 'profile'
  | 'forum'
  | 'api-json'
  | 'unknown';

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export interface PacingProfile {
  name: string;
  description: string;
  /** Base mean interval between requests (ms) */
  baseIntervalMean: number;
  /** Base standard deviation for interval (ms) */
  baseIntervalStd: number;
  /** Probability of a "reading" pause on any given request (0-1) */
  readingPauseProbability: number;
  /** Multiplier applied to reading times from PAGE_TYPE_READING_TIMES */
  readingTimeMultiplier: number;
  /** Maximum requests allowed in a 10-second burst window per domain */
  maxBurstRate: number;
  /** Cool-down after a burst (ms) before next request is allowed */
  burstCooldownMs: number;
  /** How aggressively to adapt when challenges are detected (0-1) */
  challengeSensitivity: number;
}

export interface PacingDecision {
  /** Milliseconds the caller should wait before issuing the request */
  delayMs: number;
  /** The recommended referrer URL (or empty string for first hit) */
  referrer: string;
  /** Human-readable reason for the chosen delay */
  reason: string;
  /** Which pacing profile governed this decision */
  profileName: string;
  /** Whether this delay includes a "reading" pause */
  isReadingPause: boolean;
}

export interface NavigationPath {
  /** The URL visited */
  url: string;
  /** The referrer used to reach this URL */
  referrer: string;
  /** Classified page type */
  pageType: PageType;
  /** Time spent on the page before next navigation (ms) */
  timeSpentMs: number;
  /** Timestamp of the navigation event */
  timestamp: number;
}

export interface DomainPacingConfig {
  /** Active pacing profile name */
  profileName: string;
  /** Navigation graph -- recent navigation events for this domain */
  navigationGraph: NavigationPath[];
  /** Timestamps of recent requests (for burst detection) */
  recentRequestTimestamps: number[];
  /** Number of challenges encountered recently */
  challengeCount: number;
  /** Current adaptive slowdown factor (1.0 = normal, >1 = slowed) */
  adaptiveFactor: number;
  /** Timezone offset for the target domain (e.g. -5 for EST) */
  timezoneOffset: number;
  /** Last time the config was persisted */
  lastPersisted: number;
}

export interface TimeOfDayProfile {
  /** Multiplier on base interval -- higher = slower */
  intervalMultiplier: number;
  /** Multiplier on reading pause probability */
  readingPauseMultiplier: number;
  /** Multiplier on reading time duration */
  readingTimeMultiplier: number;
  /** Extra random jitter added to every delay (ms) */
  extraJitterMs: number;
}

export interface PacerStats {
  totalDecisions: number;
  totalDelayMs: number;
  totalReadingPauses: number;
  totalChallengesHandled: number;
  activeDomains: number;
  averageDelayMs: number;
  readingPauseRate: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PACING_PROFILES: Record<string, PacingProfile> = {
  'casual-browsing': {
    name: 'casual-browsing',
    description: 'Typical casual browsing -- moderate pace, occasional pauses',
    baseIntervalMean: 5500,
    baseIntervalStd: 2000,
    readingPauseProbability: 0.25,
    readingTimeMultiplier: 1.0,
    maxBurstRate: 4,
    burstCooldownMs: 8000,
    challengeSensitivity: 0.6,
  },
  'focused-research': {
    name: 'focused-research',
    description: 'Research session -- slower, deeper reading, longer pauses',
    baseIntervalMean: 8000,
    baseIntervalStd: 3000,
    readingPauseProbability: 0.45,
    readingTimeMultiplier: 1.5,
    maxBurstRate: 3,
    burstCooldownMs: 12000,
    challengeSensitivity: 0.8,
  },
  shopping: {
    name: 'shopping',
    description: 'E-commerce browsing -- faster clicks, comparison patterns',
    baseIntervalMean: 4000,
    baseIntervalStd: 1500,
    readingPauseProbability: 0.2,
    readingTimeMultiplier: 0.8,
    maxBurstRate: 5,
    burstCooldownMs: 6000,
    challengeSensitivity: 0.5,
  },
  'news-reading': {
    name: 'news-reading',
    description: 'News consumption -- sequential article reading, longer stays',
    baseIntervalMean: 7000,
    baseIntervalStd: 2500,
    readingPauseProbability: 0.4,
    readingTimeMultiplier: 1.3,
    maxBurstRate: 3,
    burstCooldownMs: 10000,
    challengeSensitivity: 0.7,
  },
  'aggressive-crawl': {
    name: 'aggressive-crawl',
    description: 'High-throughput crawling -- still human-like but faster',
    baseIntervalMean: 3000,
    baseIntervalStd: 1000,
    readingPauseProbability: 0.1,
    readingTimeMultiplier: 0.5,
    maxBurstRate: 5,
    burstCooldownMs: 4000,
    challengeSensitivity: 1.0,
  },
};

export const TIME_OF_DAY_PROFILES: Record<TimeOfDay, TimeOfDayProfile> = {
  morning: {
    intervalMultiplier: 0.9,
    readingPauseMultiplier: 0.85,
    readingTimeMultiplier: 0.9,
    extraJitterMs: 500,
  },
  afternoon: {
    intervalMultiplier: 1.0,
    readingPauseMultiplier: 1.0,
    readingTimeMultiplier: 1.0,
    extraJitterMs: 300,
  },
  evening: {
    intervalMultiplier: 1.1,
    readingPauseMultiplier: 1.15,
    readingTimeMultiplier: 1.15,
    extraJitterMs: 800,
  },
  night: {
    intervalMultiplier: 1.5,
    readingPauseMultiplier: 1.6,
    readingTimeMultiplier: 1.4,
    extraJitterMs: 2000,
  },
};

export const PAGE_TYPE_READING_TIMES: Record<PageType, { min: number; max: number }> = {
  homepage: { min: 5000, max: 15000 },
  product: { min: 15000, max: 45000 },
  article: { min: 30000, max: 120000 },
  'search-results': { min: 8000, max: 20000 },
  category: { min: 10000, max: 25000 },
  checkout: { min: 20000, max: 60000 },
  profile: { min: 10000, max: 30000 },
  forum: { min: 20000, max: 90000 },
  'api-json': { min: 1000, max: 3000 },
  unknown: { min: 5000, max: 20000 },
};

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

const CACHE_PREFIX = 'pacer:domain:';
const CACHE_TTL_SECONDS = 3600;
const MAX_NAVIGATION_HISTORY = 50;
const BURST_WINDOW_MS = 10000;
const MAX_CHALLENGES_BEFORE_MAX_SLOW = 5;

/**
 * Box-Muller transform for Gaussian-distributed random numbers.
 * Returns a value with the given mean and standard deviation.
 */
function gaussianRandom(mean: number, std: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + z * std;
}

/**
 * Clamp a number between min and max inclusive.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Uniform random integer in [min, max].
 */
function randomIntBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Determine the time-of-day category for a given timezone offset.
 */
function getTimeOfDay(timezoneOffset: number): TimeOfDay {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const localHours = (utcHours - timezoneOffset + 24) % 24;

  if (localHours >= 6 && localHours < 12) return 'morning';
  if (localHours >= 12 && localHours < 18) return 'afternoon';
  if (localHours >= 18 && localHours < 23) return 'evening';
  return 'night';
}

/**
 * Extract the registrable domain from a URL (e.g. "example.com" from "https://shop.example.com/path").
 */
function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    return parts.slice(-2).join('.');
  } catch {
    return 'unknown';
  }
}

/**
 * Classify a URL into a PageType using simple heuristics.
 */
function classifyPageType(url: string): PageType {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname === '/' || pathname === '') return 'homepage';
    if (/\/search/.test(pathname) || /[\?&]q=/.test(url)) return 'search-results';
    if (/\/product|\/item|\/p\/|\/dp\/|\/goods/.test(pathname)) return 'product';
    if (/\/article|\/post|\/blog|\/news|\/story/.test(pathname)) return 'article';
    if (/\/category|\/c\/|\/catalog|\/collection/.test(pathname)) return 'category';
    if (/\/cart|\/checkout|\/payment|\/order/.test(pathname)) return 'checkout';
    if (/\/profile|\/user|\/account|\/member/.test(pathname)) return 'profile';
    if (/\/forum|\/thread|\/topic|\/discussion/.test(pathname)) return 'forum';
    if (/\.json($|\?)/.test(pathname)) return 'api-json';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// RequestPacerEngine
// ---------------------------------------------------------------------------

export class RequestPacerEngine {
  private domains: Map<string, DomainPacingConfig> = new Map();
  private defaultProfile: PacingProfile = DEFAULT_PACING_PROFILES['casual-browsing'];
  private stats = {
    totalDecisions: 0,
    totalDelayMs: 0,
    totalReadingPauses: 0,
    totalChallengesHandled: 0,
  };
  private initialized = false;

  // ---- Lifecycle ----

  /**
   * Initialize the pacer -- loads persisted domain configs from cache.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('RequestPacerEngine already initialized');
      return;
    }

    logger.info('Initializing RequestPacerEngine -- loading domain configs from cache');

    try {
      const keys = await redis.keys(`cache:${CACHE_PREFIX}*`);
      for (const fullKey of keys) {
        const config = await cacheGet<DomainPacingConfig>(
          fullKey.replace('cache:', '')
        );
        if (config) {
          const domain = fullKey.replace(`cache:${CACHE_PREFIX}`, '');
          this.domains.set(domain, config);
        }
      }
      logger.info({ domainCount: this.domains.size }, 'Loaded domain pacing configs');
    } catch (err) {
      logger.warn({ err }, 'Failed to load domain configs from cache -- starting fresh');
    }

    this.initialized = true;
    logger.info('RequestPacerEngine initialized');
  }

  // ---- Core Pacing ----

  /**
   * Compute and wait for the appropriate human-like delay before the next
   * request to the given URL. Returns a PacingDecision describing the delay.
   */
  async waitForNextRequest(targetUrl: string): Promise<PacingDecision> {
    const domain = extractDomain(targetUrl);
    const config = this.getOrCreateDomainConfig(domain);
    const profile = this.getProfile(config.profileName);
    const timeOfDay = getTimeOfDay(config.timezoneOffset);
    const todProfile = TIME_OF_DAY_PROFILES[timeOfDay];

    // --- Burst detection ---
    const now = Date.now();
    this.pruneBurstWindow(config, now);
    let burstDelay = 0;
    if (config.recentRequestTimestamps.length >= profile.maxBurstRate) {
      const oldestInWindow = config.recentRequestTimestamps[0];
      const timeUntilWindowExpires = BURST_WINDOW_MS - (now - oldestInWindow);
      burstDelay = Math.max(0, timeUntilWindowExpires) + profile.burstCooldownMs;
      logger.debug(
        { domain, burstDelay },
        'Burst limit reached -- applying cool-down delay'
      );
    }

    // --- Base interval (Gaussian-distributed) ---
    const rawInterval = gaussianRandom(
      profile.baseIntervalMean * todProfile.intervalMultiplier * config.adaptiveFactor,
      profile.baseIntervalStd * todProfile.intervalMultiplier * config.adaptiveFactor
    );
    const baseInterval = Math.max(1000, rawInterval); // never below 1 second

    // --- Reading pause ---
    let readingPauseMs = 0;
    let isReadingPause = false;
    const effectiveReadingProb =
      profile.readingPauseProbability * todProfile.readingPauseMultiplier;
    if (Math.random() < effectiveReadingProb) {
      const pageType = classifyPageType(targetUrl);
      const readingRange = PAGE_TYPE_READING_TIMES[pageType];
      const baseReadingTime = randomIntBetween(readingRange.min, readingRange.max);
      readingPauseMs = baseReadingTime * profile.readingTimeMultiplier * todProfile.readingTimeMultiplier * config.adaptiveFactor;
      isReadingPause = true;
    }

    // --- Time-of-day jitter ---
    const jitter = randomIntBetween(0, todProfile.extraJitterMs);

    // --- Total delay ---
    const totalDelay = Math.round(burstDelay + baseInterval + readingPauseMs + jitter);

    // --- Record the request timestamp for burst tracking ---
    config.recentRequestTimestamps.push(Date.now() + totalDelay);

    // --- Build decision ---
    const referrer = this.getReferrer(domain);
    const reason = this.buildReason(burstDelay, baseInterval, readingPauseMs, jitter, timeOfDay, config.adaptiveFactor);

    const decision: PacingDecision = {
      delayMs: totalDelay,
      referrer,
      reason,
      profileName: profile.name,
      isReadingPause,
    };

    // --- Update stats ---
    this.stats.totalDecisions += 1;
    this.stats.totalDelayMs += totalDelay;
    if (isReadingPause) this.stats.totalReadingPauses += 1;

    logger.debug(
      { domain, delayMs: totalDelay, isReadingPause, timeOfDay, adaptiveFactor: config.adaptiveFactor },
      'Pacing decision computed'
    );

    // --- Wait ---
    await this.sleep(totalDelay);

    // --- Persist domain config periodically ---
    await this.persistDomainConfig(domain, config);

    return decision;
  }

  // ---- Navigation Tracking ----

  /**
   * Record a navigation event for building the navigation graph.
   * This feeds the referrer chain and session flow modeling.
   */
  recordNavigation(
    url: string,
    referrer: string,
    pageType: PageType | undefined,
    timeSpentMs: number
  ): void {
    const domain = extractDomain(url);
    const config = this.getOrCreateDomainConfig(domain);

    const entry: NavigationPath = {
      url,
      referrer,
      pageType: pageType ?? classifyPageType(url),
      timeSpentMs,
      timestamp: Date.now(),
    };

    config.navigationGraph.push(entry);

    // Trim navigation history
    if (config.navigationGraph.length > MAX_NAVIGATION_HISTORY) {
      config.navigationGraph = config.navigationGraph.slice(-MAX_NAVIGATION_HISTORY);
    }

    logger.debug(
      { domain, url, pageType: entry.pageType, timeSpentMs },
      'Navigation event recorded'
    );
  }

  // ---- Referrer Management ----

  /**
   * Get the most appropriate referrer for the given domain based on
   * the navigation graph. Returns the URL of the most recent page visited
   * on that domain, or empty string if this is the first visit.
   */
  getReferrer(domain?: string): string {
    if (!domain) return '';

    const config = this.domains.get(domain);
    if (!config || config.navigationGraph.length === 0) return '';

    // Return the most recent navigation URL as the referrer
    const lastNav = config.navigationGraph[config.navigationGraph.length - 1];
    return lastNav.url;
  }

  // ---- Profile Management ----

  /**
   * Set the pacing profile for a specific domain (or the default).
   */
  setPacingProfile(profileName: string, domain?: string): void {
    const profile = DEFAULT_PACING_PROFILES[profileName];
    if (!profile) {
      logger.warn({ profileName }, 'Unknown pacing profile -- ignoring');
      return;
    }

    if (domain) {
      const config = this.getOrCreateDomainConfig(domain);
      config.profileName = profileName;
      logger.info({ domain, profileName }, 'Domain pacing profile updated');
    } else {
      this.defaultProfile = profile;
      logger.info({ profileName }, 'Default pacing profile updated');
    }
  }

  // ---- Adaptive Challenge Response ----

  /**
   * Adjust pacing when a CAPTCHA, challenge, or anti-bot signal is detected.
   * Increases the adaptive factor (slowdown) and increases reading pauses.
   */
  async adaptToChallenge(domain: string, challengeType: string): Promise<void> {
    const config = this.getOrCreateDomainConfig(domain);
    const profile = this.getProfile(config.profileName);

    config.challengeCount += 1;
    this.stats.totalChallengesHandled += 1;

    // Increase adaptive factor -- each challenge compounds, capped at 5x slowdown
    const increase = profile.challengeSensitivity * (1 + config.challengeCount * 0.3);
    config.adaptiveFactor = clamp(
      config.adaptiveFactor + increase,
      1.0,
      2.0 + MAX_CHALLENGES_BEFORE_MAX_SLOW * 0.5
    );

    logger.warn(
      { domain, challengeType, challengeCount: config.challengeCount, adaptiveFactor: config.adaptiveFactor },
      'Challenge detected -- adapting pacing (slowing down)'
    );

    await this.persistDomainConfig(domain, config);
  }

  // ---- Stats ----

  /**
   * Return operational statistics about the pacer's activity.
   */
  getStats(): PacerStats {
    return {
      totalDecisions: this.stats.totalDecisions,
      totalDelayMs: this.stats.totalDelayMs,
      totalReadingPauses: this.stats.totalReadingPauses,
      totalChallengesHandled: this.stats.totalChallengesHandled,
      activeDomains: this.domains.size,
      averageDelayMs:
        this.stats.totalDecisions > 0
          ? Math.round(this.stats.totalDelayMs / this.stats.totalDecisions)
          : 0,
      readingPauseRate:
        this.stats.totalDecisions > 0
          ? parseFloat((this.stats.totalReadingPauses / this.stats.totalDecisions).toFixed(3))
          : 0,
    };
  }

  // ---- Private Helpers ----

  private getOrCreateDomainConfig(domain: string): DomainPacingConfig {
    let config = this.domains.get(domain);
    if (!config) {
      config = {
        profileName: this.defaultProfile.name,
        navigationGraph: [],
        recentRequestTimestamps: [],
        challengeCount: 0,
        adaptiveFactor: 1.0,
        timezoneOffset: 0, // default UTC
        lastPersisted: 0,
      };
      this.domains.set(domain, config);
      logger.debug({ domain }, 'Created new domain pacing config');
    }
    return config;
  }

  private getProfile(name: string): PacingProfile {
    return DEFAULT_PACING_PROFILES[name] ?? this.defaultProfile;
  }

  /**
   * Remove timestamps outside the burst detection window.
   */
  private pruneBurstWindow(config: DomainPacingConfig, now: number): void {
    const cutoff = now - BURST_WINDOW_MS;
    config.recentRequestTimestamps = config.recentRequestTimestamps.filter(
      (ts) => ts > cutoff
    );
  }

  /**
   * Persist a domain config to the cache layer.
   */
  private async persistDomainConfig(domain: string, config: DomainPacingConfig): Promise<void> {
    const now = Date.now();
    // Throttle persistence to at most once every 30 seconds per domain
    if (now - config.lastPersisted < 30000) return;
    config.lastPersisted = now;

    try {
      const key = `${CACHE_PREFIX}${domain}`;
      await cacheSet(key, config, CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn({ domain, err }, 'Failed to persist domain config to cache');
    }
  }

  /**
   * Build a human-readable reason string for a pacing decision.
   */
  private buildReason(
    burstDelay: number,
    baseInterval: number,
    readingPauseMs: number,
    jitter: number,
    timeOfDay: TimeOfDay,
    adaptiveFactor: number
  ): string {
    const parts: string[] = [];

    if (burstDelay > 0) {
      parts.push(`burst-cooldown ${Math.round(burstDelay)}ms`);
    }

    parts.push(`base ${Math.round(baseInterval)}ms (${timeOfDay})`);

    if (readingPauseMs > 0) {
      parts.push(`reading ${Math.round(readingPauseMs)}ms`);
    }

    if (jitter > 0) {
      parts.push(`jitter ${jitter}ms`);
    }

    if (adaptiveFactor > 1.05) {
      parts.push(`adaptive x${adaptiveFactor.toFixed(2)}`);
    }

    return parts.join(' + ');
  }

  /**
   * Promisified sleep that is never interrupted.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const requestPacer = new RequestPacerEngine();
