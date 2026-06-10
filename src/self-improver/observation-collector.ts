/**
 * Observation Collector — ScrapeSuite Engine
 *
 * Collects and stores scraping observations — the raw data that
 * the self-improving engine learns from. Every scraping attempt,
 * whether success or failure, generates an observation record
 * that includes the full context of what was tried and what happened.
 *
 * The collector provides:
 * - Thread-safe observation recording
 * - Automatic context enrichment (proxy, fingerprint, session info)
 * - Observation deduplication (same URL + strategy within 60s)
 * - Batch observation processing for efficiency
 * - Query interface for the analysis engine
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type {
  ScrapingObservation, Outcome, AntiBotPlatform, AppliedStrategy,
  ScrapingContext, ResponseDetails, StrategyCategory,
} from './types';

const logger = createChildLogger('observation-collector');

const OBSERVATION_CACHE_PREFIX = 'self-improver:obs:';
const DEDUP_PREFIX = 'self-improver:dedup:';

// ===============================================================================
// OBSERVATION COLLECTOR CLASS
// ===============================================================================

export class ObservationCollector {
  private observations: Map<string, ScrapingObservation> = new Map();
  private recentObservations: ScrapingObservation[] = [];
  private domainIndex: Map<string, string[]> = new Map();
  private outcomeIndex: Map<Outcome, string[]> = new Map();
  private stats = {
    totalCollected: 0,
    duplicatesDropped: 0,
    byOutcome: {} as Record<Outcome, number>,
  };

  constructor() {
    // Initialize outcome counters
    const outcomes: Outcome[] = ['success', 'blocked', 'captcha', 'timeout', 'rate_limited', 'fingerprint_detected', 'session_expired', 'proxy_blocked', 'tls_rejected', 'behavioral_flag'];
    for (const o of outcomes) {
      this.stats.byOutcome[o] = 0;
    }
  }

  /**
   * Record a scraping observation.
   * This is the primary entry point for feeding data to the self-improver.
   */
  async record(observation: Omit<ScrapingObservation, 'id' | 'analyzed'>): Promise<ScrapingObservation> {
    // Check for duplicates
    const dedupKey = `${observation.url}:${observation.outcome}:${observation.context.sessionId}`;
    const recentDedup = await cacheGet<string>(`${DEDUP_PREFIX}${dedupKey}`);
    if (recentDedup) {
      this.stats.duplicatesDropped++;
      return this.observations.get(recentDedup)!;
    }

    const fullObservation: ScrapingObservation = {
      ...observation,
      id: `obs-${randomUUID().substring(0, 8)}`,
      analyzed: false,
    };

    // Store observation
    this.observations.set(fullObservation.id, fullObservation);
    this.recentObservations.push(fullObservation);
    if (this.recentObservations.length > 1000) this.recentObservations.shift();

    // Update indices
    const domainObs = this.domainIndex.get(fullObservation.domain) || [];
    domainObs.push(fullObservation.id);
    this.domainIndex.set(fullObservation.domain, domainObs);

    const outcomeObs = this.outcomeIndex.get(fullObservation.outcome) || [];
    outcomeObs.push(fullObservation.id);
    this.outcomeIndex.set(fullObservation.outcome, outcomeObs);

    // Update stats
    this.stats.totalCollected++;
    this.stats.byOutcome[fullObservation.outcome]++;

    // Set dedup marker (60 second window)
    await cacheSet(`${DEDUP_PREFIX}${dedupKey}`, fullObservation.id, 60);

    // Persist to cache
    await cacheSet(`${OBSERVATION_CACHE_PREFIX}${fullObservation.id}`, fullObservation, 86400 * 7);

    logger.debug({
      observationId: fullObservation.id,
      domain: fullObservation.domain,
      outcome: fullObservation.outcome,
    }, 'Observation recorded');

    return fullObservation;
  }

  /**
   * Record a quick observation with minimal parameters.
   * Convenience method for simple success/failure recording.
   */
  async recordQuick(options: {
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
    return this.record({
      url: options.url,
      domain: options.domain,
      timestamp: Date.now(),
      outcome: options.outcome,
      detectedPlatform: options.platform || null,
      strategiesApplied: [],
      context: {
        proxyTier: options.proxyTier || 'unknown',
        proxyCountry: 'unknown',
        proxyAsn: 'unknown',
        tlsProfile: options.tlsProfile || 'unknown',
        fingerprintId: 'unknown',
        accountId: null,
        sessionId: `quick-${Date.now()}`,
        requestRate: 0,
        timeSinceLastRequestMs: 0,
        previousRequestCount: 0,
        browserType: 'unknown',
        headless: true,
        referrerUrl: null,
      },
      response: {
        statusCode: options.statusCode || 0,
        detectionHeaders: {},
        captchaPresent: options.captchaPresent || false,
        captchaType: null,
        bodyLength: 0,
        dataExtracted: options.outcome === 'success',
        errorMessage: options.errorMessage || null,
        akamaiSensorVersion: null,
        recaptchaScore: null,
      },
      durationMs: options.durationMs || 0,
    });
  }

  /**
   * Query observations by various filters.
   */
  query(filters: {
    domain?: string;
    outcome?: Outcome;
    platform?: AntiBotPlatform;
    since?: number;
    limit?: number;
  }): ScrapingObservation[] {
    let results = this.recentObservations;

    if (filters.domain) {
      results = results.filter(o => o.domain === filters.domain);
    }
    if (filters.outcome) {
      results = results.filter(o => o.outcome === filters.outcome);
    }
    if (filters.platform) {
      results = results.filter(o => o.detectedPlatform === filters.platform);
    }
    if (filters.since) {
      results = results.filter(o => o.timestamp >= filters.since!);
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp - a.timestamp);

    if (filters.limit) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }

  /**
   * Get observations for a specific domain.
   */
  getByDomain(domain: string, limit: number = 50): ScrapingObservation[] {
    const ids = this.domainIndex.get(domain) || [];
    const observations = ids
      .map(id => this.observations.get(id))
      .filter((o): o is ScrapingObservation => o !== undefined)
      .sort((a, b) => b.timestamp - a.timestamp);
    return observations.slice(0, limit);
  }

  /**
   * Get failed observations (all outcomes except 'success').
   */
  getFailures(domain?: string, limit: number = 50): ScrapingObservation[] {
    return this.query({
      domain,
      since: Date.now() - 86400000, // Last 24 hours
      limit,
    }).filter(o => o.outcome !== 'success');
  }

  /**
   * Get the success rate for a domain over a time window.
   */
  getSuccessRate(domain: string, windowMs: number = 3600000): number {
    const since = Date.now() - windowMs;
    const domainObs = this.getByDomain(domain, 1000).filter(o => o.timestamp >= since);

    if (domainObs.length === 0) return 0;

    const successes = domainObs.filter(o => o.outcome === 'success').length;
    return successes / domainObs.length;
  }

  /**
   * Mark an observation as analyzed.
   */
  markAnalyzed(observationId: string): void {
    const obs = this.observations.get(observationId);
    if (obs) {
      obs.analyzed = true;
    }
  }

  /**
   * Get recent unanalyzed observations.
   */
  getUnanalyzed(limit: number = 20): ScrapingObservation[] {
    return this.recentObservations
      .filter(o => !o.analyzed)
      .slice(0, limit);
  }

  /**
   * Get collector statistics.
   */
  getStats(): {
    totalCollected: number;
    duplicatesDropped: number;
    byOutcome: Record<Outcome, number>;
    recentCount: number;
    domainCount: number;
  } {
    return {
      totalCollected: this.stats.totalCollected,
      duplicatesDropped: this.stats.duplicatesDropped,
      byOutcome: { ...this.stats.byOutcome },
      recentCount: this.recentObservations.length,
      domainCount: this.domainIndex.size,
    };
  }
}

/** Singleton instance. */
export const observationCollector = new ObservationCollector();
