/**
 * Failure Analyzer — ScrapeSuite Engine
 *
 * Analyzes failed scraping attempts to identify root causes,
 * patterns, and generate adaptation recommendations. This is
 * the core intelligence of the self-improving engine — it turns
 * raw failure data into actionable insights.
 *
 * Analysis process:
 * 1. Correlation Analysis — Find which strategies correlate with failures
 * 2. Root Cause Identification — Determine the primary cause of failure
 * 3. Pattern Detection — Identify recurring failure patterns across attempts
 * 4. Recommendation Generation — Propose strategy adaptations
 * 5. Confidence Scoring — Rate confidence in each analysis
 *
 * The analyzer uses a multi-signal approach combining:
 * - Statistical correlation (which strategies appear most in failures)
 * - Temporal analysis (when failures started, trend direction)
 * - Contextual analysis (what changed between success and failure)
 * - Cross-domain comparison (do similar domains show similar patterns)
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { observationCollector } from './observation-collector';
import type {
  ScrapingObservation, FailureAnalysis, FailurePattern,
  AdaptationRecommendation, StrategyCategory, AntiBotPlatform, Outcome,
} from './types';

const logger = createChildLogger('failure-analyzer');

const ANALYSIS_CACHE_PREFIX = 'self-improver:analysis:';
const PATTERN_CACHE_PREFIX = 'self-improver:pattern:';

// ===============================================================================
// ROOT CAUSE MAPPING
// ===============================================================================

const OUTCOME_ROOT_CAUSES: Record<Outcome, { category: StrategyCategory; detail: string; confidence: number }[]> = {
  blocked: [
    { category: 'fingerprint', detail: 'Browser fingerprint detected as automated', confidence: 0.7 },
    { category: 'behavior', detail: 'Behavioral pattern flagged as non-human', confidence: 0.6 },
    { category: 'proxy', detail: 'Proxy IP flagged as datacenter/suspicious', confidence: 0.5 },
    { category: 'tls', detail: 'TLS fingerprint does not match browser profile', confidence: 0.4 },
  ],
  captcha: [
    { category: 'captcha', detail: 'CAPTCHA challenge triggered by anti-bot system', confidence: 0.8 },
    { category: 'behavior', detail: 'Behavioral signals triggered CAPTCHA threshold', confidence: 0.6 },
    { category: 'proxy', detail: 'Low-reputation IP triggered CAPTCHA', confidence: 0.5 },
  ],
  timeout: [
    { category: 'proxy', detail: 'Proxy connection timeout', confidence: 0.7 },
    { category: 'timing', detail: 'Response time exceeded threshold', confidence: 0.5 },
  ],
  rate_limited: [
    { category: 'timing', detail: 'Request rate exceeded domain threshold', confidence: 0.8 },
    { category: 'proxy', detail: 'Rate limit applied per IP', confidence: 0.6 },
    { category: 'session', detail: 'Session-level rate limit exceeded', confidence: 0.5 },
  ],
  fingerprint_detected: [
    { category: 'fingerprint', detail: 'Device fingerprint mismatch detected', confidence: 0.9 },
    { category: 'header', detail: 'Browser headers inconsistent with fingerprint', confidence: 0.6 },
    { category: 'sensor', detail: 'Sensor data inconsistent with claimed device', confidence: 0.7 },
  ],
  session_expired: [
    { category: 'session', detail: 'Session cookies expired or invalidated', confidence: 0.8 },
    { category: 'cookie', detail: 'Session cookies rejected by server', confidence: 0.6 },
  ],
  proxy_blocked: [
    { category: 'proxy', detail: 'Proxy IP blacklisted by target domain', confidence: 0.9 },
    { category: 'proxy', detail: 'Proxy ASN blocked by target domain', confidence: 0.7 },
  ],
  tls_rejected: [
    { category: 'tls', detail: 'TLS fingerprint rejected by server', confidence: 0.9 },
    { category: 'tls', detail: 'HTTP/2 settings fingerprint mismatch', confidence: 0.7 },
  ],
  behavioral_flag: [
    { category: 'behavior', detail: 'Mouse movement patterns flagged as automated', confidence: 0.8 },
    { category: 'behavior', detail: 'Keyboard timing patterns flagged as automated', confidence: 0.7 },
    { category: 'behavior', detail: 'Navigation pattern flagged as bot-like', confidence: 0.6 },
  ],
  success: [],
};

// ===============================================================================
// FAILURE ANALYZER CLASS
// ===============================================================================

export class FailureAnalyzer {
  private patterns: Map<string, FailurePattern> = new Map();
  private analyses: FailureAnalysis[] = [];
  private stats = {
    totalAnalyses: 0,
    patternsIdentified: 0,
    recommendationsGenerated: 0,
  };

  /**
   * Analyze a failed scraping observation.
   * Returns a comprehensive failure analysis with root cause,
   * contributing strategies, and adaptation recommendations.
   */
  async analyze(observation: ScrapingObservation): Promise<FailureAnalysis> {
    if (observation.outcome === 'success') {
      throw new Error('Cannot analyze a successful observation');
    }

    logger.info({
      observationId: observation.id,
      domain: observation.domain,
      outcome: observation.outcome,
    }, 'Analyzing failure');

    // 1. Identify root cause candidates
    const rootCauseCandidates = OUTCOME_ROOT_CAUSES[observation.outcome] || [];

    // 2. Score root cause candidates based on context
    const scoredCauses = rootCauseCandidates.map(cause => ({
      ...cause,
      confidence: this.scoreRootCause(cause, observation),
    }));

    // 3. Select most likely root cause
    const primaryCause = scoredCauses.sort((a, b) => b.confidence - a.confidence)[0] || {
      category: 'proxy' as StrategyCategory,
      detail: 'Unknown root cause',
      confidence: 0.3,
    };

    // 4. Analyze strategy contributions
    const failingStrategies = this.analyzeFailingStrategies(observation);
    const helpingStrategies = this.analyzeHelpingStrategies(observation);

    // 5. Detect patterns
    const patterns = this.detectPatterns(observation);

    // 6. Generate recommendations
    const recommendations = this.generateRecommendations(
      observation,
      primaryCause,
      failingStrategies,
      helpingStrategies,
      patterns,
    );

    // 7. Build analysis
    const analysis: FailureAnalysis = {
      id: `analysis-${randomUUID().substring(0, 8)}`,
      observationId: observation.id,
      domain: observation.domain,
      rootCause: primaryCause.category,
      rootCauseDetail: primaryCause.detail,
      confidence: primaryCause.confidence,
      failingStrategies,
      helpingStrategies,
      patterns,
      recommendations,
      analyzedAt: Date.now(),
    };

    // Store
    this.analyses.unshift(analysis);
    if (this.analyses.length > 200) this.analyses.shift();
    await cacheSet(`${ANALYSIS_CACHE_PREFIX}${analysis.id}`, analysis, 86400 * 30);

    // Mark observation as analyzed
    observationCollector.markAnalyzed(observation.id);

    this.stats.totalAnalyses++;
    this.stats.patternsIdentified += patterns.length;
    this.stats.recommendationsGenerated += recommendations.length;

    logger.info({
      analysisId: analysis.id,
      rootCause: analysis.rootCause,
      confidence: analysis.confidence,
      recommendationCount: recommendations.length,
    }, 'Failure analysis completed');

    return analysis;
  }

  /**
   * Analyze all unanalyzed failed observations.
   */
  async analyzeAllUnanalyzed(): Promise<FailureAnalysis[]> {
    const unanalyzed = observationCollector.getUnanalyzed(50)
      .filter(o => o.outcome !== 'success');

    const results: FailureAnalysis[] = [];
    for (const obs of unanalyzed) {
      try {
        const analysis = await this.analyze(obs);
        results.push(analysis);
      } catch (err) {
        logger.debug({ observationId: obs.id, error: String(err) }, 'Analysis skipped');
      }
    }

    return results;
  }

  /**
   * Get known failure patterns.
   */
  getPatterns(): FailurePattern[] {
    return Array.from(this.patterns.values());
  }

  /**
   * Get recent analyses.
   */
  getRecentAnalyses(limit: number = 20): FailureAnalysis[] {
    return this.analyses.slice(0, limit);
  }

  /**
   * Get analyzer statistics.
   */
  getStats(): {
    totalAnalyses: number;
    patternsIdentified: number;
    recommendationsGenerated: number;
    patternCount: number;
  } {
    return {
      ...this.stats,
      patternCount: this.patterns.size,
    };
  }

  // ---------- Internal Methods -------------------------------------------------

  private scoreRootCause(
    cause: { category: StrategyCategory; detail: string; confidence: number },
    observation: ScrapingObservation,
  ): number {
    let score = cause.confidence;

    // Boost score based on context clues
    if (cause.category === 'proxy' && observation.context.proxyTier === 'datacenter') {
      score += 0.15;
    }
    if (cause.category === 'fingerprint' && observation.response.detectionHeaders['x-bot-detection']) {
      score += 0.2;
    }
    if (cause.category === 'tls' && observation.response.statusCode === 403) {
      score += 0.1;
    }
    if (cause.category === 'behavior' && observation.outcome === 'behavioral_flag') {
      score += 0.2;
    }
    if (cause.category === 'captcha' && observation.response.captchaPresent) {
      score += 0.25;
    }
    if (cause.category === 'timing' && observation.outcome === 'rate_limited') {
      score += 0.15;
    }

    // Check if the platform is known for this root cause
    const platform = observation.detectedPlatform;
    if (platform === 'akamai' && cause.category === 'sensor') score += 0.2;
    if (platform === 'akamai' && cause.category === 'behavior') score += 0.15;
    if (platform === 'recaptcha_enterprise' && cause.category === 'captcha') score += 0.2;
    if (platform === 'cloudflare' && cause.category === 'tls') score += 0.15;

    return Math.min(1, score);
  }

  private analyzeFailingStrategies(observation: ScrapingObservation): Array<{
    category: StrategyCategory; name: string; contributionScore: number; reason: string;
  }> {
    const failing: Array<{
      category: StrategyCategory; name: string; contributionScore: number; reason: string;
    }> = [];

    for (const strategy of observation.strategiesApplied) {
      if (strategy.effective === false || (strategy.effective === null && observation.outcome !== 'success')) {
        let contributionScore = 0.5;

        // Increase contribution for strategies that directly relate to the failure
        if (observation.outcome === 'fingerprint_detected' && strategy.category === 'fingerprint') {
          contributionScore = 0.9;
        } else if (observation.outcome === 'captcha' && strategy.category === 'captcha') {
          contributionScore = 0.7;
        } else if (observation.outcome === 'tls_rejected' && strategy.category === 'tls') {
          contributionScore = 0.9;
        } else if (observation.outcome === 'proxy_blocked' && strategy.category === 'proxy') {
          contributionScore = 0.9;
        } else if (observation.outcome === 'behavioral_flag' && strategy.category === 'behavior') {
          contributionScore = 0.8;
        }

        failing.push({
          category: strategy.category,
          name: strategy.name,
          contributionScore,
          reason: `Strategy "${strategy.name}" was ineffective during ${observation.outcome} outcome`,
        });
      }
    }

    // If no strategies were explicitly marked as failing, infer from outcome
    if (failing.length === 0) {
      const inferredCategories = this.inferFailingCategories(observation.outcome);
      for (const category of inferredCategories) {
        failing.push({
          category,
          name: 'inferred',
          contributionScore: 0.4,
          reason: `Inferred from ${observation.outcome} outcome — likely ${category} related`,
        });
      }
    }

    return failing.sort((a, b) => b.contributionScore - a.contributionScore);
  }

  private analyzeHelpingStrategies(observation: ScrapingObservation): Array<{
    category: StrategyCategory; name: string; mitigationScore: number; reason: string;
  }> {
    const helping: Array<{
      category: StrategyCategory; name: string; mitigationScore: number; reason: string;
    }> = [];

    for (const strategy of observation.strategiesApplied) {
      if (strategy.effective === true) {
        helping.push({
          category: strategy.category,
          name: strategy.name,
          mitigationScore: strategy.confidence,
          reason: `Strategy "${strategy.name}" was effective even during failure`,
        });
      }
    }

    return helping;
  }

  private detectPatterns(observation: ScrapingObservation): FailurePattern[] {
    const patterns: FailurePattern[] = [];

    // Get recent failures for the same domain
    const recentFailures = observationCollector.getFailures(observation.domain, 20);

    if (recentFailures.length >= 3) {
      // Check for recurring outcome pattern
      const outcomeCounts: Record<string, number> = {};
      for (const fail of recentFailures) {
        outcomeCounts[fail.outcome] = (outcomeCounts[fail.outcome] || 0) + 1;
      }

      const dominantOutcome = Object.entries(outcomeCounts)
        .sort((a, b) => b[1] - a[1])[0];

      if (dominantOutcome && dominantOutcome[1] >= 3) {
        const patternId = `pattern:${observation.domain}:${dominantOutcome[0]}`;
        let pattern = this.patterns.get(patternId);

        if (!pattern) {
          pattern = {
            description: `Recurring ${dominantOutcome[0]} failures on ${observation.domain} (${dominantOutcome[1]} occurrences)`,
            occurrenceCount: dominantOutcome[1],
            domains: [observation.domain],
            platforms: [observation.detectedPlatform].filter(Boolean) as AntiBotPlatform[],
            significance: Math.min(1, dominantOutcome[1] / 10),
            firstIdentified: Date.now(),
            active: true,
          };
          this.patterns.set(patternId, pattern);
        } else {
          pattern.occurrenceCount = dominantOutcome[1];
          pattern.significance = Math.min(1, pattern.occurrenceCount / 10);
        }

        patterns.push(pattern);
      }

      // Check for proxy-related pattern
      const proxyOutcomes: Record<string, number> = {};
      for (const fail of recentFailures) {
        const key = `${fail.context.proxyTier}:${fail.context.proxyCountry}`;
        proxyOutcomes[key] = (proxyOutcomes[key] || 0) + 1;
      }

      const dominantProxy = Object.entries(proxyOutcomes)
        .sort((a, b) => b[1] - a[1])[0];

      if (dominantProxy && dominantProxy[1] >= 3) {
        patterns.push({
          description: `Proxy ${dominantProxy[0]} has high failure rate on ${observation.domain}`,
          occurrenceCount: dominantProxy[1],
          domains: [observation.domain],
          platforms: [],
          significance: Math.min(1, dominantProxy[1] / 5),
          firstIdentified: Date.now(),
          active: true,
        });
      }
    }

    return patterns;
  }

  private generateRecommendations(
    observation: ScrapingObservation,
    rootCause: { category: StrategyCategory; detail: string; confidence: number },
    failingStrategies: Array<{ category: StrategyCategory; name: string; contributionScore: number; reason: string }>,
    _helpingStrategies: Array<{ category: StrategyCategory; name: string; mitigationScore: number; reason: string }>,
    _patterns: FailurePattern[],
  ): AdaptationRecommendation[] {
    const recommendations: AdaptationRecommendation[] = [];

    // Generate recommendations based on root cause
    switch (rootCause.category) {
      case 'proxy':
        recommendations.push({
          category: 'proxy',
          currentStrategy: failingStrategies[0]?.name || 'current_proxy',
          recommendedStrategy: 'residential_proxy_rotation',
          parameterChanges: { tier: { from: observation.context.proxyTier, to: 'residential' } },
          expectedImprovement: 0.3,
          confidence: rootCause.confidence * 0.8,
          rationale: 'Switching to residential proxies reduces IP-based detection',
          riskLevel: 'low',
        });
        if (observation.context.proxyTier === 'datacenter') {
          recommendations.push({
            category: 'proxy',
            currentStrategy: 'datacenter_proxy',
            recommendedStrategy: 'mobile_proxy',
            parameterChanges: { tier: { from: 'datacenter', to: 'mobile' } },
            expectedImprovement: 0.5,
            confidence: rootCause.confidence * 0.9,
            rationale: 'Mobile IPs have the highest reputation on Netflix and Google',
            riskLevel: 'medium',
          });
        }
        break;

      case 'fingerprint':
        recommendations.push({
          category: 'fingerprint',
          currentStrategy: failingStrategies[0]?.name || 'current_fingerprint',
          recommendedStrategy: 'consistent_fingerprint_rotation',
          parameterChanges: { consistency_check: { from: false, to: true } },
          expectedImprovement: 0.25,
          confidence: rootCause.confidence * 0.7,
          rationale: 'Improving fingerprint consistency across navigator, canvas, and WebGL signals',
          riskLevel: 'medium',
        });
        break;

      case 'behavior':
        recommendations.push({
          category: 'behavior',
          currentStrategy: failingStrategies[0]?.name || 'current_behavior',
          recommendedStrategy: 'enhanced_human_simulation',
          parameterChanges: {
            mouse_profile: { from: 'standard', to: 'realistic_bezier' },
            typing_rhythm: { from: 'fixed', to: 'gaussian_bigram' },
            dwell_time: { from: 'short', to: 'reading_speed_based' },
          },
          expectedImprovement: 0.35,
          confidence: rootCause.confidence * 0.75,
          rationale: 'Enhancing behavioral simulation with more realistic mouse and typing patterns',
          riskLevel: 'low',
        });
        break;

      case 'tls':
        recommendations.push({
          category: 'tls',
          currentStrategy: failingStrategies[0]?.name || 'current_tls',
          recommendedStrategy: 'matched_tls_profile',
          parameterChanges: { profile: { from: observation.context.tlsProfile, to: 'chrome_120_compatible' } },
          expectedImprovement: 0.4,
          confidence: rootCause.confidence * 0.85,
          rationale: 'Using a TLS profile that matches the claimed browser fingerprint',
          riskLevel: 'low',
        });
        break;

      case 'captcha':
        if (observation.detectedPlatform === 'recaptcha_enterprise') {
          recommendations.push({
            category: 'account',
            currentStrategy: 'anonymous_session',
            recommendedStrategy: 'warmed_account_session',
            parameterChanges: { use_account: { from: false, to: true } },
            expectedImprovement: 0.4,
            confidence: rootCause.confidence * 0.8,
            rationale: 'Using warmed Google accounts achieves higher reCAPTCHA Enterprise scores',
            riskLevel: 'medium',
          });
        }
        recommendations.push({
          category: 'captcha',
          currentStrategy: 'auto_detect',
          recommendedStrategy: 'proactive_captcha_solving',
          parameterChanges: { proactive: { from: false, to: true } },
          expectedImprovement: 0.2,
          confidence: rootCause.confidence * 0.6,
          rationale: 'Proactively solving CAPTCHAs before they block the request',
          riskLevel: 'low',
        });
        break;

      case 'sensor':
        recommendations.push({
          category: 'sensor',
          currentStrategy: 'current_sensor_data',
          recommendedStrategy: 'updated_sensor_format',
          parameterChanges: { version: { from: 'current', to: 'latest' } },
          expectedImprovement: 0.45,
          confidence: rootCause.confidence * 0.9,
          rationale: 'Akamai sensor format may have changed — updating to latest format',
          riskLevel: 'medium',
        });
        break;

      case 'timing':
        recommendations.push({
          category: 'timing',
          currentStrategy: 'current_rate',
          recommendedStrategy: 'adaptive_rate_reduction',
          parameterChanges: {
            rpm: { from: observation.context.requestRate, to: Math.max(1, Math.floor(observation.context.requestRate * 0.5)) },
          },
          expectedImprovement: 0.3,
          confidence: rootCause.confidence * 0.8,
          rationale: 'Reducing request rate to stay below detection threshold',
          riskLevel: 'low',
        });
        break;

      default:
        recommendations.push({
          category: rootCause.category,
          currentStrategy: 'current',
          recommendedStrategy: 'alternative_strategy',
          parameterChanges: {},
          expectedImprovement: 0.15,
          confidence: rootCause.confidence * 0.5,
          rationale: `Generic recommendation for ${rootCause.category} improvement`,
          riskLevel: 'medium',
        });
    }

    return recommendations;
  }

  private inferFailingCategories(outcome: Outcome): StrategyCategory[] {
    const mapping: Record<Outcome, StrategyCategory[]> = {
      blocked: ['fingerprint', 'behavior', 'proxy', 'tls'],
      captcha: ['captcha', 'behavior', 'proxy'],
      timeout: ['proxy', 'timing'],
      rate_limited: ['timing', 'proxy', 'session'],
      fingerprint_detected: ['fingerprint', 'header', 'sensor'],
      session_expired: ['session', 'cookie'],
      proxy_blocked: ['proxy'],
      tls_rejected: ['tls'],
      behavioral_flag: ['behavior', 'sensor'],
      success: [],
    };
    return mapping[outcome] || ['proxy'];
  }
}

/** Singleton instance. */
export const failureAnalyzer = new FailureAnalyzer();
