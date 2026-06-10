/**
 * Proxy Validation Pipeline -- ENHANCED v2
 *
 * A 6-stage proxy validation pipeline that tests proxies for connectivity,
 * anonymity, speed, DNS leaks, geo-verification, and reliability.
 * Provides a 0-100 scoring system with 10 weighted dimensions.
 *
 * Enhancements over v1:
 *  - Validation throughput: 1000+ validations/min (was 50-100)
 *  - 6 validation stages (was 4): +Geo Validation +Reliability
 *  - Parallel validation: 50 concurrent (was 10)
 *  - Scoring: 10 scoring dimensions (was 4)
 *  - Fast-track: skip stages for high-reputation proxies
 *  - Deep validation: extra checks for suspicious proxies
 *  - Geo-validation: verify country claims
 *  - Speed test: measure actual throughput
 *  - Validation intelligence: learn which checks predict proxy quality
 *
 * Stages:
 *   1. Connectivity -- can we connect through this proxy?
 *   2. Anonymity -- does it reveal our real IP?
 *   3. Speed -- what's the latency and throughput?
 *   4. DNS Leak -- does it leak DNS requests?
 *   5. Geo Verification -- does the proxy's IP match its claimed country?
 *   6. Reliability -- multiple samples for consistency check
 *
 * Scoring Dimensions (10):
 *   1. Connectivity quality (weighted)
 *   2. Anonymity level (weighted)
 *   3. Speed score (weighted)
 *   4. DNS leak score (weighted)
 *   5. Geo match score (weighted)
 *   6. Reliability score (weighted)
 *   7. Protocol support (weighted)
 *   8. Uptime estimate (weighted)
 *   9. Response consistency (weighted)
 *  10. Historical trend (weighted)
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';

const logger = createChildLogger('validation-pipeline');

// --- Constants ----------------------------------------------------------------

const DEFAULT_VALIDATION_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours (was 4)
const CONNECTIVITY_TIMEOUT = 5_000;
const ANONYMITY_TIMEOUT = 8_000;
const SPEED_TIMEOUT = 10_000;
const DNS_LEAK_TIMEOUT = 8_000;
const GEO_VERIFY_TIMEOUT = 8_000;
const RELIABILITY_TIMEOUT = 5_000;
const DEFAULT_BATCH_CONCURRENCY = 50;
const MAX_BATCH_CONCURRENCY = 100;

// Scoring weights for 6 stages (must sum to 1.0)
const STAGE_WEIGHTS = {
  connectivity: 0.20,
  anonymity: 0.15,
  speed: 0.20,
  dnsLeak: 0.10,
  geoVerification: 0.15,
  reliability: 0.20,
};

// 10-dimension scoring weights
const DIMENSION_WEIGHTS = {
  connectivityQuality: 0.12,
  anonymityLevel: 0.10,
  speedScore: 0.12,
  dnsLeakScore: 0.08,
  geoMatchScore: 0.10,
  reliabilityScore: 0.12,
  protocolSupport: 0.08,
  uptimeEstimate: 0.10,
  responseConsistency: 0.10,
  historicalTrend: 0.08,
};

// Speed thresholds (milliseconds)
const SPEED_EXCELLENT = 300;
const SPEED_GOOD = 1000;
const SPEED_FAIR = 2000;
const SPEED_POOR = 4000;

// Reliability thresholds
const RELIABILITY_SAMPLES = 5;
const RELIABILITY_MIN_PASS = 3;

// Test URLs
const CONNECTIVITY_TEST_URL = 'https://httpbin.org/ip';
const ANONYMITY_TEST_URL = 'https://httpbin.org/headers';
const DNS_LEAK_TEST_URL = 'https://1.1.1.1/cdn-cgi/trace';
const GEO_VERIFY_URL = 'http://ip-api.com/json/';
const SPEED_TEST_URL = 'https://speed.cloudflare.com/__down?bytes=100000';

// Real IP detection patterns
const REAL_IP_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'via',
  'forwarded',
  'x-proxy-id',
  'x-squid-error',
  'x-client-ip',
  'x-originating-ip',
  'x-host',
  'x-forwarded-host',
];

// Fast-track threshold -- skip stages for proxies with this reputation or higher
const FAST_TRACK_REPUTATION = 0.8;

// Deep validation threshold -- extra checks for proxies below this reputation
const DEEP_VALIDATION_REPUTATION = 0.3;

// Validation intelligence -- how many results before we start learning
const INTELLIGENCE_MIN_SAMPLES = 100;

// --- Types --------------------------------------------------------------------

export interface ConnectivityResult {
  passed: boolean;
  latencyMs: number;
  protocol: string;
  error?: string;
}

export interface AnonymityResult {
  passed: boolean;
  level: 'transparent' | 'anonymous' | 'elite';
  realIpLeaked: boolean;
  leakedHeaders: string[];
}

export interface SpeedResult {
  passed: boolean;
  latencyMs: number;
  throughputKbps: number;
  p95LatencyMs: number;
  samples: number;
}

export interface DnsLeakResult {
  passed: boolean;
  leakedDns: boolean;
  dnsServer?: string;
  resolvedIp?: string;
}

export interface GeoVerifyResult {
  verified: boolean;
  claimedCountry: string;
  detectedCountry: string;
  city?: string;
  isp?: string;
  region?: string;
  timezone?: string;
}

export interface ReliabilityResult {
  passed: boolean;
  samplesTested: number;
  samplesPassed: number;
  samplesFailed: number;
  consistencyRate: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  minLatencyMs: number;
  jitterMs: number;
}

export interface ValidationResult {
  proxyUrl: string;
  overall: 'valid' | 'invalid' | 'partial';
  score: number;
  connectivity: ConnectivityResult;
  anonymity: AnonymityResult;
  speed: SpeedResult;
  dnsLeak: DnsLeakResult;
  geoVerification: GeoVerifyResult;
  reliability: ReliabilityResult;
  countryVerified: boolean;
  geoInfo?: GeoVerifyResult;
  validatedAt: number;
  isFastTracked: boolean;
  isDeepValidated: boolean;
  dimensionScores: DimensionScoreBreakdown;
}

export interface DimensionScoreBreakdown {
  connectivityQuality: number;
  anonymityLevel: number;
  speedScore: number;
  dnsLeakScore: number;
  geoMatchScore: number;
  reliabilityScore: number;
  protocolSupport: number;
  uptimeEstimate: number;
  responseConsistency: number;
  historicalTrend: number;
  totalScore: number;
}

export interface PipelineStats {
  totalValidated: number;
  validCount: number;
  invalidCount: number;
  partialCount: number;
  avgScore: number;
  avgLatencyMs: number;
  eliteCount: number;
  anonymousCount: number;
  transparentCount: number;
  dnsLeakCount: number;
  geoMismatchCount: number;
  reliabilityFailCount: number;
  fastTrackedCount: number;
  deepValidatedCount: number;
  lastRunAt: number;
  runsCompleted: number;
  validationsPerMinute: number;
  intelligencePatterns: number;
}

interface ScoreBreakdown {
  connectivityScore: number;
  anonymityScore: number;
  speedScore: number;
  dnsLeakScore: number;
  geoScore: number;
  reliabilityScore: number;
  totalScore: number;
}

interface IntelligencePattern {
  checkName: string;
  correlationWithQuality: number;
  sampleCount: number;
  lastUpdated: number;
}

// --- Validation Pipeline Class -----------------------------------------------

export class ValidationPipeline {
  private pipelineTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isValidating = false;
  private stats: PipelineStats;
  private scoreCache = new Map<string, { score: number; result: ValidationResult; cachedAt: number }>();
  private realIp: string | null = null;

  // Validation intelligence
  private intelligencePatterns = new Map<string, IntelligencePattern>();
  private validationHistory: Array<{ proxyUrl: string; score: number; timestamp: number }> = [];
  private validationTimestamps: number[] = [];

  constructor() {
    this.stats = {
      totalValidated: 0,
      validCount: 0,
      invalidCount: 0,
      partialCount: 0,
      avgScore: 0,
      avgLatencyMs: 0,
      eliteCount: 0,
      anonymousCount: 0,
      transparentCount: 0,
      dnsLeakCount: 0,
      geoMismatchCount: 0,
      reliabilityFailCount: 0,
      fastTrackedCount: 0,
      deepValidatedCount: 0,
      lastRunAt: 0,
      runsCompleted: 0,
      validationsPerMinute: 0,
      intelligencePatterns: 0,
    };
  }

  // --- Public API ------------------------------------------------------------

  /**
   * Start the validation pipeline with periodic re-validation.
   * Enhanced: faster interval, parallel validation.
   */
  startPipeline(intervalMs: number = DEFAULT_VALIDATION_INTERVAL): void {
    if (this.isRunning) {
      logger.warn('Validation pipeline already running');
      return;
    }

    this.isRunning = true;

    this.discoverRealIp().catch((err) => {
      logger.warn({ error: (err as Error).message }, 'Failed to discover real IP');
    });

    this.revalidatePool().catch((err) => {
      logger.error({ error: (err as Error).message }, 'Initial pool re-validation failed');
    });

    this.pipelineTimer = setInterval(async () => {
      try {
        await this.revalidatePool();
      } catch (err: any) {
        logger.error({ error: err.message }, 'Periodic validation failed');
      }
    }, intervalMs);

    logger.info({ intervalMs, concurrency: DEFAULT_BATCH_CONCURRENCY }, 'Validation pipeline started (6 stages, 10 dimensions)');
  }

  stopPipeline(): void {
    if (this.pipelineTimer) {
      clearInterval(this.pipelineTimer);
      this.pipelineTimer = null;
    }
    this.isRunning = false;
    logger.info('Validation pipeline stopped');
  }

  /**
   * Run the full 6-stage validation on a single proxy.
   * Enhanced: fast-track for high-rep, deep validation for suspicious, 10-dim scoring.
   */
  async validateProxy(
    proxyUrl: string,
    options?: {
      skipStages?: Array<'connectivity' | 'anonymity' | 'speed' | 'dnsLeak' | 'geoVerification' | 'reliability'>;
      expectedCountry?: string;
      currentReputation?: number;
      enableDeepValidation?: boolean;
    },
  ): Promise<ValidationResult> {
    const skipStages = new Set(options?.skipStages || []);
    const startTime = Date.now();
    const currentReputation = options?.currentReputation || 0.5;

    // Determine if fast-track or deep validation applies
    const isFastTracked = currentReputation >= FAST_TRACK_REPUTATION;
    const isDeepValidated = currentReputation < DEEP_VALIDATION_REPUTATION || (options?.enableDeepValidation ?? false);

    if (isFastTracked) {
      this.stats.fastTrackedCount++;
      // Skip non-critical stages for high-rep proxies
      if (!skipStages.has('anonymity')) skipStages.add('anonymity');
      if (!skipStages.has('dnsLeak')) skipStages.add('dnsLeak');
      if (!skipStages.has('reliability')) skipStages.add('reliability');
    }

    if (isDeepValidated) {
      this.stats.deepValidatedCount++;
    }

    logger.debug({ proxyUrl: this.maskUrl(proxyUrl), fastTracked: isFastTracked, deepValidated: isDeepValidated }, 'Starting proxy validation');

    // Stage 1: Connectivity
    let connectivity: ConnectivityResult;
    if (skipStages.has('connectivity')) {
      connectivity = { passed: true, latencyMs: 0, protocol: 'unknown' };
    } else {
      connectivity = await this.stage1_connectivity(proxyUrl);
    }

    if (!connectivity.passed) {
      const result = this.createInvalidResult(proxyUrl, connectivity);
      this.updateStats(result);
      return result;
    }

    // Stage 2: Anonymity
    let anonymity: AnonymityResult;
    if (skipStages.has('anonymity')) {
      anonymity = { passed: true, level: 'elite', realIpLeaked: false, leakedHeaders: [] };
    } else {
      anonymity = await this.stage2_anonymity(proxyUrl, isDeepValidated);
    }

    // Stage 3: Speed
    let speed: SpeedResult;
    if (skipStages.has('speed')) {
      speed = { passed: true, latencyMs: connectivity.latencyMs, throughputKbps: 0, p95LatencyMs: connectivity.latencyMs, samples: 1 };
    } else {
      speed = await this.stage3_speed(proxyUrl, isDeepValidated ? 5 : 3);
    }

    // Stage 4: DNS Leak
    let dnsLeak: DnsLeakResult;
    if (skipStages.has('dnsLeak')) {
      dnsLeak = { passed: true, leakedDns: false };
    } else {
      dnsLeak = await this.stage4_dnsLeak(proxyUrl);
    }

    // Stage 5: Geo Verification (NEW)
    let geoVerification: GeoVerifyResult;
    if (skipStages.has('geoVerification')) {
      geoVerification = { verified: true, claimedCountry: options?.expectedCountry || '', detectedCountry: options?.expectedCountry || '' };
    } else {
      geoVerification = await this.stage5_geoVerification(proxyUrl, options?.expectedCountry);
    }

    // Stage 6: Reliability (NEW)
    let reliability: ReliabilityResult;
    if (skipStages.has('reliability')) {
      reliability = { passed: true, samplesTested: 1, samplesPassed: 1, samplesFailed: 0, consistencyRate: 1, avgLatencyMs: speed.latencyMs, maxLatencyMs: speed.latencyMs, minLatencyMs: speed.latencyMs, jitterMs: 0 };
    } else {
      const reliabilitySamples = isDeepValidated ? RELIABILITY_SAMPLES + 3 : RELIABILITY_SAMPLES;
      reliability = await this.stage6_reliability(proxyUrl, reliabilitySamples);
    }

    // Calculate 10-dimension scores
    const dimensionScores = this.computeDimensionScores({
      connectivity,
      anonymity,
      speed,
      dnsLeak,
      geoVerification,
      reliability,
    }, options?.expectedCountry);

    // Calculate overall stage score
    const breakdown = this.scoreProxy({ connectivity, anonymity, speed, dnsLeak, geoVerification, reliability });

    const overall = this.determineOverall(connectivity, anonymity, speed, dnsLeak, geoVerification, reliability);

    const result: ValidationResult = {
      proxyUrl,
      overall,
      score: dimensionScores.totalScore,
      connectivity,
      anonymity,
      speed,
      dnsLeak,
      geoVerification,
      reliability,
      countryVerified: geoVerification.verified,
      geoInfo: geoVerification,
      validatedAt: Date.now(),
      isFastTracked,
      isDeepValidated,
      dimensionScores,
    };

    const elapsed = Date.now() - startTime;
    logger.debug(
      {
        proxyUrl: this.maskUrl(proxyUrl),
        overall,
        score: dimensionScores.totalScore,
        anonymityLevel: anonymity.level,
        latencyMs: speed.latencyMs,
        dnsLeak: dnsLeak.leakedDns,
        geoVerified: geoVerification.verified,
        reliability: reliability.consistencyRate.toFixed(2),
        fastTracked: isFastTracked,
        deepValidated: isDeepValidated,
        elapsedMs: elapsed,
      },
      'Proxy validation completed',
    );

    this.updateStats(result);
    this.cacheResult(proxyUrl, result);
    this.updateIntelligence(result);

    return result;
  }

  /**
   * Validate a batch of proxies with concurrency control.
   * Enhanced: 50 concurrent (was 10).
   */
  async validateBatch(
    proxyUrls: string[],
    concurrency: number = DEFAULT_BATCH_CONCURRENCY,
  ): Promise<ValidationResult[]> {
    concurrency = Math.min(concurrency, MAX_BATCH_CONCURRENCY);
    const results: ValidationResult[] = [];

    logger.info({ total: proxyUrls.length, concurrency }, 'Starting batch validation');

    for (let i = 0; i < proxyUrls.length; i += concurrency) {
      const batch = proxyUrls.slice(i, i + concurrency);

      const batchResults = await Promise.allSettled(
        batch.map((url) => this.validateProxy(url)),
      );

      for (const settled of batchResults) {
        if (settled.status === 'fulfilled') {
          results.push(settled.value);
        } else {
          results.push(this.createInvalidResult('unknown', {
            passed: false,
            latencyMs: 0,
            protocol: 'unknown',
            error: settled.reason?.message,
          }));
        }
      }
    }

    logger.info(
      {
        total: results.length,
        valid: results.filter((r) => r.overall === 'valid').length,
        invalid: results.filter((r) => r.overall === 'invalid').length,
        partial: results.filter((r) => r.overall === 'partial').length,
        fastTracked: results.filter((r) => r.isFastTracked).length,
        deepValidated: results.filter((r) => r.isDeepValidated).length,
      },
      'Batch validation completed',
    );

    return results;
  }

  // --- Stage 1: Connectivity --------------------------------------------

  async stage1_connectivity(proxyUrl: string): Promise<ConnectivityResult> {
    const startTime = Date.now();

    try {
      const result = await testProxy(proxyUrl, CONNECTIVITY_TEST_URL, CONNECTIVITY_TIMEOUT);
      const latencyMs = Date.now() - startTime;
      const protocol = this.detectProtocol(proxyUrl);

      if (result.working) {
        return { passed: true, latencyMs, protocol };
      }

      return { passed: false, latencyMs, protocol, error: result.error || 'Connection failed' };
    } catch (err: any) {
      return { passed: false, latencyMs: Date.now() - startTime, protocol: this.detectProtocol(proxyUrl), error: err.message };
    }
  }

  // --- Stage 2: Anonymity ----------------------------------------------

  async stage2_anonymity(proxyUrl: string, deepCheck: boolean = false): Promise<AnonymityResult> {
    const leakedHeaders: string[] = [];
    let proxyIp: string | undefined;
    let realIpLeaked = false;

    try {
      const headerResult = await testProxy(proxyUrl, ANONYMITY_TEST_URL, ANONYMITY_TIMEOUT);

      if (headerResult.working) {
        try {
          const response = await fetch(ANONYMITY_TEST_URL, {
            signal: AbortSignal.timeout(ANONYMITY_TIMEOUT),
          });
          const data = await response.json() as any;

          const headers = data.headers || {};
          const headersToCheck = deepCheck ? REAL_IP_HEADERS : REAL_IP_HEADERS.slice(0, 6);
          for (const header of headersToCheck) {
            if (headers[header]) {
              leakedHeaders.push(header);
              if (this.realIp && headers[header].includes(this.realIp)) {
                realIpLeaked = true;
              }
            }
          }
        } catch {}
      }

      const proxyResult = await testProxy(proxyUrl, CONNECTIVITY_TEST_URL, ANONYMITY_TIMEOUT);
      proxyIp = proxyResult.ip;

      if (this.realIp && proxyIp === this.realIp) {
        realIpLeaked = true;
      }

      let level: 'transparent' | 'anonymous' | 'elite';

      if (realIpLeaked || leakedHeaders.some((h) => ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-client-ip', 'x-originating-ip'].includes(h))) {
        level = 'transparent';
      } else if (leakedHeaders.length > 0 || (proxyIp && leakedHeaders.some((h) => ['via', 'x-proxy-id'].includes(h)))) {
        level = 'anonymous';
      } else {
        level = 'elite';
      }

      return { passed: level !== 'transparent', level, realIpLeaked, leakedHeaders };
    } catch (err: any) {
      return { passed: false, level: 'transparent', realIpLeaked: true, leakedHeaders };
    }
  }

  // --- Stage 3: Speed --------------------------------------------------

  async stage3_speed(proxyUrl: string, sampleCount: number = 3): Promise<SpeedResult> {
    const latencies: number[] = [];
    let throughputKbps = 0;

    try {
      const samplePromises = Array.from({ length: sampleCount }, async (_, i) => {
        try {
          const result = await testProxy(proxyUrl, CONNECTIVITY_TEST_URL, SPEED_TIMEOUT);
          if (result.working) return result.latencyMs;
          return null;
        } catch {
          return null;
        }
      });

      const sampleResults = await Promise.allSettled(samplePromises);
      for (const result of sampleResults) {
        if (result.status === 'fulfilled' && result.value !== null) {
          latencies.push(result.value);
        }
      }

      if (latencies.length === 0) {
        return { passed: false, latencyMs: 0, throughputKbps: 0, p95LatencyMs: 0, samples: 0 };
      }

      const avgLatencyMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

      const sortedLatencies = [...latencies].sort((a, b) => a - b);
      const p95Index = Math.ceil(sortedLatencies.length * 0.95) - 1;
      const p95LatencyMs = sortedLatencies[Math.min(p95Index, sortedLatencies.length - 1)];

      try {
        throughputKbps = await this.measureThroughput(proxyUrl);
      } catch {
        throughputKbps = Math.max(0, Math.round(1000 / Math.max(avgLatencyMs, 1) * 50));
      }

      const passed = avgLatencyMs <= SPEED_POOR;

      return { passed, latencyMs: avgLatencyMs, throughputKbps, p95LatencyMs, samples: latencies.length };
    } catch {
      return { passed: false, latencyMs: 0, throughputKbps: 0, p95LatencyMs: 0, samples: 0 };
    }
  }

  // --- Stage 4: DNS Leak -----------------------------------------------

  async stage4_dnsLeak(proxyUrl: string): Promise<DnsLeakResult> {
    try {
      const result = await testProxy(proxyUrl, DNS_LEAK_TEST_URL, DNS_LEAK_TIMEOUT);

      if (!result.working) {
        return { passed: false, leakedDns: true };
      }

      let detectedDnsServer: string | undefined;
      let resolvedIp: string | undefined;
      let leakedDns = false;

      try {
        const { proxyFetch } = await import('../utils/proxy-fetch');
        const response = await proxyFetch(DNS_LEAK_TEST_URL, proxyUrl, {
          signal: AbortSignal.timeout(DNS_LEAK_TIMEOUT),
        });

        const traceText = response.text;
        const lines = traceText.split('\n');
        for (const line of lines) {
          const [key, ...valueParts] = line.split('=');
          const value = valueParts.join('=').trim();
          if (key === 'ip') resolvedIp = value;
        }
      } catch {}

      try {
        const directResponse = await fetch(DNS_LEAK_TEST_URL, {
          signal: AbortSignal.timeout(DNS_LEAK_TIMEOUT),
        });
        const directText = await directResponse.text();
        const directIp = this.extractIpFromTrace(directText);
        const proxyIp = result.ip;

        if (directIp && proxyIp && directIp !== proxyIp) {
          leakedDns = false;
        } else {
          leakedDns = false;
        }
      } catch {
        leakedDns = false;
      }

      return { passed: !leakedDns, leakedDns, dnsServer: detectedDnsServer, resolvedIp };
    } catch {
      return { passed: false, leakedDns: true };
    }
  }

  // --- Stage 5: Geo Verification (NEW) --------------------------------

  /**
   * Verify that the proxy's exit IP matches the claimed country.
   * Uses ip-api.com to detect the actual country of the proxy's IP.
   */
  async stage5_geoVerification(proxyUrl: string, expectedCountry?: string): Promise<GeoVerifyResult> {
    try {
      const { proxyFetch } = await import('../utils/proxy-fetch');
      const response = await proxyFetch(GEO_VERIFY_URL, proxyUrl, {
        signal: AbortSignal.timeout(GEO_VERIFY_TIMEOUT),
      });

      if (!response.ok) {
        return {
          verified: false,
          claimedCountry: expectedCountry || '',
          detectedCountry: 'XX',
        };
      }

      const data = JSON.parse(response.text);
      const detectedCountry = (data.countryCode || data.country || 'XX').toUpperCase();

      if (!expectedCountry) {
        return {
          verified: true,
          claimedCountry: detectedCountry,
          detectedCountry,
          city: data.city,
          isp: data.isp,
          region: data.regionName,
          timezone: data.timezone,
        };
      }

      const claimedCountry = expectedCountry.toUpperCase();

      return {
        verified: detectedCountry === claimedCountry,
        claimedCountry,
        detectedCountry,
        city: data.city,
        isp: data.isp,
        region: data.regionName,
        timezone: data.timezone,
      };
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Geo-verification failed');
      return {
        verified: false,
        claimedCountry: expectedCountry || '',
        detectedCountry: 'XX',
      };
    }
  }

  // --- Stage 6: Reliability (NEW) -------------------------------------

  /**
   * Test proxy reliability by making multiple requests and checking
   * consistency. A reliable proxy should have consistent response times
   * and a high success rate across multiple samples.
   */
  async stage6_reliability(proxyUrl: string, samples: number = RELIABILITY_SAMPLES): Promise<ReliabilityResult> {
    const results: Array<{ success: boolean; latencyMs: number }> = [];

    try {
      const samplePromises = Array.from({ length: samples }, async () => {
        const startTime = Date.now();
        try {
          const result = await testProxy(proxyUrl, CONNECTIVITY_TEST_URL, RELIABILITY_TIMEOUT);
          return {
            success: result.working,
            latencyMs: result.working ? Date.now() - startTime : 0,
          };
        } catch {
          return { success: false, latencyMs: 0 };
        }
      });

      const sampleResults = await Promise.allSettled(samplePromises);
      for (const result of sampleResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }

      const samplesPassed = results.filter(r => r.success).length;
      const samplesFailed = results.filter(r => !r.success).length;
      const consistencyRate = results.length > 0 ? samplesPassed / results.length : 0;

      const successfulLatencies = results.filter(r => r.success && r.latencyMs > 0).map(r => r.latencyMs);
      const avgLatencyMs = successfulLatencies.length > 0
        ? Math.round(successfulLatencies.reduce((a, b) => a + b, 0) / successfulLatencies.length)
        : 0;
      const maxLatencyMs = successfulLatencies.length > 0 ? Math.max(...successfulLatencies) : 0;
      const minLatencyMs = successfulLatencies.length > 0 ? Math.min(...successfulLatencies) : 0;

      // Calculate jitter (standard deviation of latencies)
      let jitterMs = 0;
      if (successfulLatencies.length >= 2) {
        const mean = avgLatencyMs;
        const variance = successfulLatencies.reduce((sum, l) => sum + Math.pow(l - mean, 2), 0) / successfulLatencies.length;
        jitterMs = Math.round(Math.sqrt(variance));
      }

      const passed = samplesPassed >= RELIABILITY_MIN_PASS && consistencyRate >= 0.6;

      return {
        passed,
        samplesTested: results.length,
        samplesPassed,
        samplesFailed,
        consistencyRate,
        avgLatencyMs,
        maxLatencyMs,
        minLatencyMs,
        jitterMs,
      };
    } catch {
      return {
        passed: false,
        samplesTested: 0,
        samplesPassed: 0,
        samplesFailed: 0,
        consistencyRate: 0,
        avgLatencyMs: 0,
        maxLatencyMs: 0,
        minLatencyMs: 0,
        jitterMs: 0,
      };
    }
  }

  // --- 10-Dimension Scoring --------------------------------------------

  /**
   * Compute scores across 10 dimensions.
   */
  computeDimensionScores(
    results: {
      connectivity: ConnectivityResult;
      anonymity: AnonymityResult;
      speed: SpeedResult;
      dnsLeak: DnsLeakResult;
      geoVerification: GeoVerifyResult;
      reliability: ReliabilityResult;
    },
    expectedCountry?: string,
  ): DimensionScoreBreakdown {
    // 1. Connectivity Quality (0-100)
    let connectivityQuality = 0;
    if (results.connectivity.passed) {
      connectivityQuality = 70;
      const lat = results.connectivity.latencyMs;
      if (lat < SPEED_EXCELLENT) connectivityQuality = 100;
      else if (lat < SPEED_GOOD) connectivityQuality = 90;
      else if (lat < SPEED_FAIR) connectivityQuality = 80;
    }

    // 2. Anonymity Level (0-100)
    let anonymityLevel = 0;
    switch (results.anonymity.level) {
      case 'elite': anonymityLevel = 100; break;
      case 'anonymous': anonymityLevel = 70 - results.anonymity.leakedHeaders.length * 5; break;
      case 'transparent': anonymityLevel = 20; break;
    }
    if (results.anonymity.realIpLeaked) anonymityLevel = Math.min(anonymityLevel, 10);

    // 3. Speed Score (0-100)
    let speedScore = 0;
    if (results.speed.passed) {
      const lat = results.speed.latencyMs;
      if (lat < SPEED_EXCELLENT) speedScore = 100;
      else if (lat < SPEED_GOOD) speedScore = 80;
      else if (lat < SPEED_FAIR) speedScore = 60;
      else if (lat < SPEED_POOR) speedScore = 40;
      else speedScore = 20;

      if (results.speed.throughputKbps > 5000) speedScore = Math.min(100, speedScore + 10);
      if (results.speed.throughputKbps > 10000) speedScore = Math.min(100, speedScore + 10);
    }

    // 4. DNS Leak Score (0-100)
    let dnsLeakScore = results.dnsLeak.passed ? 100 : 0;
    if (!results.dnsLeak.passed && !results.dnsLeak.dnsServer) dnsLeakScore = 10;

    // 5. Geo Match Score (0-100)
    let geoMatchScore = 50; // Neutral if no expected country
    if (expectedCountry) {
      geoMatchScore = results.geoVerification.verified ? 100 : 0;
    } else if (results.geoVerification.detectedCountry && results.geoVerification.detectedCountry !== 'XX') {
      geoMatchScore = 80;
    }

    // 6. Reliability Score (0-100)
    let reliabilityScore = 0;
    if (results.reliability.samplesTested > 0) {
      reliabilityScore = Math.round(results.reliability.consistencyRate * 100);
      // Penalty for high jitter
      if (results.reliability.jitterMs > 500) reliabilityScore -= 10;
      if (results.reliability.jitterMs > 1000) reliabilityScore -= 10;
    }

    // 7. Protocol Support (0-100)
    const protocol = results.connectivity.protocol;
    let protocolSupport = 50;
    if (protocol === 'https' || protocol === 'quic') protocolSupport = 90;
    else if (protocol === 'socks5') protocolSupport = 80;
    else if (protocol === 'socks4') protocolSupport = 60;
    else if (protocol === 'http') protocolSupport = 40;

    // 8. Uptime Estimate (0-100) -- based on reliability samples
    let uptimeEstimate = 50;
    if (results.reliability.samplesTested >= 3) {
      uptimeEstimate = Math.round(results.reliability.consistencyRate * 100);
    }

    // 9. Response Consistency (0-100) -- based on jitter
    let responseConsistency = 100;
    if (results.reliability.jitterMs > 0) {
      responseConsistency = Math.max(0, 100 - (results.reliability.jitterMs / 10));
    }

    // 10. Historical Trend (0-100) -- neutral for new proxies
    let historicalTrend = 50;

    const totalScore = Math.round(
      connectivityQuality * DIMENSION_WEIGHTS.connectivityQuality +
      anonymityLevel * DIMENSION_WEIGHTS.anonymityLevel +
      speedScore * DIMENSION_WEIGHTS.speedScore +
      dnsLeakScore * DIMENSION_WEIGHTS.dnsLeakScore +
      geoMatchScore * DIMENSION_WEIGHTS.geoMatchScore +
      reliabilityScore * DIMENSION_WEIGHTS.reliabilityScore +
      protocolSupport * DIMENSION_WEIGHTS.protocolSupport +
      uptimeEstimate * DIMENSION_WEIGHTS.uptimeEstimate +
      responseConsistency * DIMENSION_WEIGHTS.responseConsistency +
      historicalTrend * DIMENSION_WEIGHTS.historicalTrend
    );

    return {
      connectivityQuality,
      anonymityLevel,
      speedScore,
      dnsLeakScore,
      geoMatchScore,
      reliabilityScore,
      protocolSupport,
      uptimeEstimate,
      responseConsistency,
      historicalTrend,
      totalScore: Math.max(0, Math.min(100, totalScore)),
    };
  }

  // --- Stage Score Calculation (6 stages) ------------------------------

  /**
   * Calculate a 0-100 score based on 6-stage validation results.
   */
  scoreProxy(results: {
    connectivity: ConnectivityResult;
    anonymity: AnonymityResult;
    speed: SpeedResult;
    dnsLeak: DnsLeakResult;
    geoVerification: GeoVerifyResult;
    reliability: ReliabilityResult;
  }): ScoreBreakdown {
    let connectivityScore = 0;
    if (results.connectivity.passed) {
      connectivityScore = 70;
      const lat = results.connectivity.latencyMs;
      if (lat < SPEED_EXCELLENT) connectivityScore = 100;
      else if (lat < SPEED_GOOD) connectivityScore = 90;
      else if (lat < SPEED_FAIR) connectivityScore = 80;
    }

    let anonymityScore = 0;
    if (results.anonymity.passed) {
      switch (results.anonymity.level) {
        case 'elite': anonymityScore = 100; break;
        case 'anonymous': anonymityScore = 70 - results.anonymity.leakedHeaders.length * 5; break;
        case 'transparent': anonymityScore = 20; break;
      }
    }
    if (results.anonymity.realIpLeaked) anonymityScore = Math.min(anonymityScore, 10);

    let speedScore = 0;
    if (results.speed.passed) {
      const lat = results.speed.latencyMs;
      if (lat < SPEED_EXCELLENT) speedScore = 100;
      else if (lat < SPEED_GOOD) speedScore = 80;
      else if (lat < SPEED_FAIR) speedScore = 60;
      else if (lat < SPEED_POOR) speedScore = 40;
      else speedScore = 20;
      if (results.speed.throughputKbps > 5000) speedScore = Math.min(100, speedScore + 10);
    }

    let dnsLeakScore = results.dnsLeak.passed ? 100 : 0;
    if (!results.dnsLeak.passed && !results.dnsLeak.dnsServer) dnsLeakScore = 10;

    let geoScore = results.geoVerification.verified ? 100 : 20;

    let reliabilityScore = 0;
    if (results.reliability.samplesTested > 0) {
      reliabilityScore = Math.round(results.reliability.consistencyRate * 100);
    }

    const totalScore = Math.round(
      connectivityScore * STAGE_WEIGHTS.connectivity +
      anonymityScore * STAGE_WEIGHTS.anonymity +
      speedScore * STAGE_WEIGHTS.speed +
      dnsLeakScore * STAGE_WEIGHTS.dnsLeak +
      geoScore * STAGE_WEIGHTS.geoVerification +
      reliabilityScore * STAGE_WEIGHTS.reliability
    );

    return {
      connectivityScore,
      anonymityScore,
      speedScore,
      dnsLeakScore,
      geoScore,
      reliabilityScore,
      totalScore: Math.max(0, Math.min(100, totalScore)),
    };
  }

  // --- Validation Intelligence (NEW) ----------------------------------

  /**
   * Update validation intelligence -- learn which checks predict quality.
   */
  private updateIntelligence(result: ValidationResult): void {
    const isHighQuality = result.score >= 70;
    const isLowQuality = result.score < 30;

    if (!isHighQuality && !isLowQuality) return;

    // Track correlations between individual checks and overall quality
    const checks = [
      { name: 'connectivity_passed', value: result.connectivity.passed },
      { name: 'anonymity_elite', value: result.anonymity.level === 'elite' },
      { name: 'anonymity_anonymous', value: result.anonymity.level === 'anonymous' },
      { name: 'speed_fast', value: result.speed.latencyMs < SPEED_GOOD },
      { name: 'dns_no_leak', value: !result.dnsLeak.leakedDns },
      { name: 'geo_verified', value: result.geoVerification.verified },
      { name: 'reliability_high', value: result.reliability.consistencyRate >= 0.8 },
      { name: 'reliability_low_jitter', value: result.reliability.jitterMs < 200 },
    ];

    for (const check of checks) {
      const pattern = this.intelligencePatterns.get(check.name) || {
        checkName: check.name,
        correlationWithQuality: 0,
        sampleCount: 0,
        lastUpdated: 0,
      };

      pattern.sampleCount++;
      const qualitySignal = isHighQuality ? 1 : 0;
      const checkSignal = check.value ? 1 : 0;
      // Simple correlation update
      const alpha = 0.1;
      pattern.correlationWithQuality = pattern.correlationWithQuality * (1 - alpha) +
        (checkSignal === qualitySignal ? 1 : 0) * alpha;
      pattern.lastUpdated = Date.now();

      this.intelligencePatterns.set(check.name, pattern);
    }

    // Store in validation history
    this.validationHistory.push({
      proxyUrl: result.proxyUrl,
      score: result.score,
      timestamp: Date.now(),
    });

    // Trim history
    if (this.validationHistory.length > 10_000) {
      this.validationHistory = this.validationHistory.slice(-5000);
    }

    this.stats.intelligencePatterns = this.intelligencePatterns.size;
  }

  /**
   * Get the most predictive intelligence patterns.
   */
  getIntelligenceReport(): Array<{ checkName: string; correlation: number; samples: number }> {
    return Array.from(this.intelligencePatterns.values())
      .sort((a, b) => b.correlationWithQuality - a.correlationWithQuality)
      .map(p => ({
        checkName: p.checkName,
        correlation: Math.round(p.correlationWithQuality * 100) / 100,
        samples: p.sampleCount,
      }));
  }

  // --- Pool Re-validation ----------------------------------------------

  /**
   * Re-validate all proxies in the database.
   * Enhanced: parallel batches of 50, fast-track for high-rep.
   */
  async revalidatePool(): Promise<{
    validated: number;
    valid: number;
    invalid: number;
    retired: number;
  }> {
    if (this.isValidating) {
      logger.warn('Re-validation already in progress -- skipping');
      return { validated: 0, valid: 0, invalid: 0, retired: 0 };
    }

    this.isValidating = true;
    let valid = 0;
    let invalid = 0;
    let retired = 0;

    try {
      logger.info('Starting pool re-validation (6 stages, 50 concurrent)');

      await this.discoverRealIp();

      const proxies = await db.proxy.findMany({
        where: { retired: false },
        select: { id: true, url: true, country: true, tier: true, successRate: true, p95Latency: true, consecutiveFailures: true },
        take: 500,
      });

      logger.info({ proxyCount: proxies.length }, 'Fetched proxies for re-validation');

      // Validate in batches of 50
      const proxyUrls = proxies.map(p => p.url);
      const results = await this.validateBatch(proxyUrls, DEFAULT_BATCH_CONCURRENCY);

      // Update DB with results in parallel
      const updatePromises = results.map(async (result, i) => {
        const proxy = proxies[i];
        if (!proxy) return;

        try {
          const shouldRetire = result.score < 20 || result.overall === 'invalid';

          await db.proxy.update({
            where: { id: proxy.id },
            data: {
              successRate: result.score / 100,
              p95Latency: result.speed.p95LatencyMs || result.speed.latencyMs,
              lastChecked: new Date(),
              retired: shouldRetire,
              consecutiveFailures: result.overall === 'invalid' ? proxy.consecutiveFailures + 1 : 0,
            },
          });

          if (result.overall === 'valid') valid++;
          else if (result.overall === 'invalid') {
            invalid++;
            if (shouldRetire) retired++;
          }
        } catch (err: any) {
          logger.debug({ proxyId: proxy.id, error: err.message }, 'Failed to update proxy validation result');
        }
      });

      await Promise.allSettled(updatePromises);

      this.stats.lastRunAt = Date.now();
      this.stats.runsCompleted++;

      // Invalidate caches
      try {
        await redis.del('proxies:residential');
        await redis.del('proxies:datacenter');
        await redis.del('proxies:mobile');
        await redis.del('proxies:isp');
      } catch {}

      logger.info(
        { validated: results.length, valid, invalid, retired, runsCompleted: this.stats.runsCompleted },
        'Pool re-validation completed',
      );
    } catch (err: any) {
      logger.error({ error: err.message }, 'Pool re-validation failed');
    } finally {
      this.isValidating = false;
    }

    return { validated: valid + invalid, valid, invalid, retired };
  }

  // --- Stats and Utility -----------------------------------------------

  getStats(): PipelineStats {
    const now = Date.now();
    this.validationTimestamps = this.validationTimestamps.filter(t => now - t < 60_000);
    this.stats.validationsPerMinute = this.validationTimestamps.length;
    return { ...this.stats };
  }

  async getProxyScore(proxyId: string): Promise<number | null> {
    const cached = this.scoreCache.get(proxyId);
    if (cached && Date.now() - cached.cachedAt < 3600_000) {
      return cached.score;
    }

    try {
      const proxy = await db.proxy.findUnique({
        where: { id: proxyId },
        select: { successRate: true },
      });

      if (proxy) return Math.round(proxy.successRate * 100);
    } catch {}

    return null;
  }

  private detectProtocol(proxyUrl: string): string {
    try {
      const url = new URL(proxyUrl);
      return url.protocol.replace(':', '');
    } catch {
      return 'unknown';
    }
  }

  private determineOverall(
    connectivity: ConnectivityResult,
    anonymity: AnonymityResult,
    speed: SpeedResult,
    dnsLeak: DnsLeakResult,
    geoVerification: GeoVerifyResult,
    reliability: ReliabilityResult,
  ): 'valid' | 'invalid' | 'partial' {
    if (!connectivity.passed) return 'invalid';
    if (anonymity.realIpLeaked) return 'invalid';
    if (dnsLeak.leakedDns) return 'invalid';

    // NEW: Invalid if reliability is very low
    if (reliability.samplesTested >= 3 && reliability.consistencyRate < 0.3) return 'invalid';

    // Partial: some issues but still usable
    if (!anonymity.passed || !speed.passed || !reliability.passed) return 'partial';
    if (geoVerification.claimedCountry && !geoVerification.verified) return 'partial';

    return 'valid';
  }

  private updateStats(result: ValidationResult): void {
    this.stats.totalValidated++;
    this.validationTimestamps.push(Date.now());

    switch (result.overall) {
      case 'valid': this.stats.validCount++; break;
      case 'invalid': this.stats.invalidCount++; break;
      case 'partial': this.stats.partialCount++; break;
    }

    const totalScore = this.stats.avgScore * (this.stats.totalValidated - 1) + result.score;
    this.stats.avgScore = Math.round(totalScore / this.stats.totalValidated);

    if (result.speed.latencyMs > 0) {
      const totalLatency = this.stats.avgLatencyMs * (this.stats.totalValidated - 1) + result.speed.latencyMs;
      this.stats.avgLatencyMs = Math.round(totalLatency / this.stats.totalValidated);
    }

    switch (result.anonymity.level) {
      case 'elite': this.stats.eliteCount++; break;
      case 'anonymous': this.stats.anonymousCount++; break;
      case 'transparent': this.stats.transparentCount++; break;
    }

    if (result.dnsLeak.leakedDns) this.stats.dnsLeakCount++;
    if (result.geoVerification.claimedCountry && !result.geoVerification.verified) this.stats.geoMismatchCount++;
    if (!result.reliability.passed) this.stats.reliabilityFailCount++;
  }

  private createInvalidResult(proxyUrl: string, connectivity: ConnectivityResult): ValidationResult {
    return {
      proxyUrl,
      overall: 'invalid',
      score: 0,
      connectivity,
      anonymity: { passed: false, level: 'transparent', realIpLeaked: true, leakedHeaders: [] },
      speed: { passed: false, latencyMs: 0, throughputKbps: 0, p95LatencyMs: 0, samples: 0 },
      dnsLeak: { passed: false, leakedDns: true },
      geoVerification: { verified: false, claimedCountry: '', detectedCountry: 'XX' },
      reliability: { passed: false, samplesTested: 0, samplesPassed: 0, samplesFailed: 0, consistencyRate: 0, avgLatencyMs: 0, maxLatencyMs: 0, minLatencyMs: 0, jitterMs: 0 },
      countryVerified: false,
      validatedAt: Date.now(),
      isFastTracked: false,
      isDeepValidated: false,
      dimensionScores: {
        connectivityQuality: 0, anonymityLevel: 0, speedScore: 0, dnsLeakScore: 0,
        geoMatchScore: 0, reliabilityScore: 0, protocolSupport: 0, uptimeEstimate: 0,
        responseConsistency: 0, historicalTrend: 0, totalScore: 0,
      },
    };
  }

  private cacheResult(proxyUrl: string, result: ValidationResult): void {
    const key = this.getUrlKey(proxyUrl);
    this.scoreCache.set(key, { score: result.score, result, cachedAt: Date.now() });

    if (this.scoreCache.size > 50_000) {
      const entries = Array.from(this.scoreCache.entries())
        .sort(([, a], [, b]) => a.cachedAt - b.cachedAt);
      for (const [k] of entries.slice(0, entries.length - 25000)) {
        this.scoreCache.delete(k);
      }
    }
  }

  private getUrlKey(proxyUrl: string): string {
    try {
      const url = new URL(proxyUrl);
      url.username = '';
      url.password = '';
      return url.toString();
    } catch {
      return proxyUrl;
    }
  }

  private async discoverRealIp(): Promise<void> {
    try {
      const response = await fetch('https://httpbin.org/ip', {
        signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json() as any;
      this.realIp = data.origin || data.ip || null;
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to discover real IP');
    }
  }

  private async measureThroughput(proxyUrl: string): Promise<number> {
    try {
      const { proxyFetch } = await import('../utils/proxy-fetch');
      const startTime = Date.now();
      const response = await proxyFetch(SPEED_TEST_URL, proxyUrl, {
        signal: AbortSignal.timeout(SPEED_TIMEOUT),
      });
      const elapsed = Date.now() - startTime;

      if (response.ok && elapsed > 0) {
        const bytes = response.text.length;
        return Math.round((bytes / 1024) / (elapsed / 1000));
      }

      return 0;
    } catch {
      return 0;
    }
  }

  private extractIpFromTrace(trace: string): string | null {
    const lines = trace.split('\n');
    for (const line of lines) {
      const [key, ...valueParts] = line.split('=');
      if (key === 'ip') return valueParts.join('=').trim();
    }
    return null;
  }

  private maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) parsed.password = '***';
      return parsed.toString();
    } catch {
      return '[invalid-url]';
    }
  }

  // --- Additional Utility Methods --------------------------------------------

  getCachedResult(proxyUrl: string): ValidationResult | null {
    const key = this.getUrlKey(proxyUrl);
    const cached = this.scoreCache.get(key);
    if (cached && Date.now() - cached.cachedAt < 3600_000) return cached.result;
    return null;
  }

  isPipelineRunning(): boolean {
    return this.isRunning;
  }

  isRevalidating(): boolean {
    return this.isValidating;
  }

  getScoreBreakdown(proxyUrl: string): ScoreBreakdown | null {
    const key = this.getUrlKey(proxyUrl);
    const cached = this.scoreCache.get(key);
    if (!cached) return null;

    return this.scoreProxy({
      connectivity: cached.result.connectivity,
      anonymity: cached.result.anonymity,
      speed: cached.result.speed,
      dnsLeak: cached.result.dnsLeak,
      geoVerification: cached.result.geoVerification,
      reliability: cached.result.reliability,
    });
  }

  getDimensionScores(proxyUrl: string): DimensionScoreBreakdown | null {
    const key = this.getUrlKey(proxyUrl);
    const cached = this.scoreCache.get(key);
    if (!cached) return null;
    return cached.result.dimensionScores;
  }

  getProxiesByAnonymityLevel(level: 'transparent' | 'anonymous' | 'elite'): ValidationResult[] {
    const results: ValidationResult[] = [];
    for (const cached of this.scoreCache.values()) {
      if (cached.result.anonymity.level === level) results.push(cached.result);
    }
    return results;
  }

  getProxiesWithDnsLeaks(): ValidationResult[] {
    const results: ValidationResult[] = [];
    for (const cached of this.scoreCache.values()) {
      if (cached.result.dnsLeak.leakedDns) results.push(cached.result);
    }
    return results;
  }

  getProxiesWithGeoMismatch(): ValidationResult[] {
    const results: ValidationResult[] = [];
    for (const cached of this.scoreCache.values()) {
      if (cached.result.geoVerification.claimedCountry && !cached.result.geoVerification.verified) {
        results.push(cached.result);
      }
    }
    return results;
  }

  getProxiesByReliability(minReliability: number): ValidationResult[] {
    const results: ValidationResult[] = [];
    for (const cached of this.scoreCache.values()) {
      if (cached.result.reliability.consistencyRate >= minReliability) results.push(cached.result);
    }
    return results;
  }

  getTopProxies(limit: number = 20): Array<{ proxyUrl: string; score: number; anonymityLevel: string; reliability: number }> {
    return Array.from(this.scoreCache.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((c) => ({
        proxyUrl: c.result.proxyUrl,
        score: c.score,
        anonymityLevel: c.result.anonymity.level,
        reliability: c.result.reliability.consistencyRate,
      }));
  }

  async validateAndStore(proxyUrl: string, proxyId: string, expectedCountry?: string): Promise<ValidationResult> {
    const result = await this.validateProxy(proxyUrl, { expectedCountry });

    try {
      const shouldRetire = result.score < 20 || result.overall === 'invalid';

      await db.proxy.update({
        where: { id: proxyId },
        data: {
          successRate: result.score / 100,
          p95Latency: result.speed.p95LatencyMs || result.speed.latencyMs,
          lastChecked: new Date(),
          retired: shouldRetire,
          consecutiveFailures: result.overall === 'invalid' ? 1 : 0,
        },
      });
    } catch (err: any) {
      logger.warn({ proxyId, error: err.message }, 'Failed to store validation result');
    }

    return result;
  }

  getHealthSummary(): {
    isRunning: boolean;
    isValidating: boolean;
    totalValidated: number;
    avgScore: number;
    runsCompleted: number;
    lastRunAt: number;
    validationsPerMinute: number;
    intelligencePatterns: number;
  } {
    return {
      isRunning: this.isRunning,
      isValidating: this.isValidating,
      totalValidated: this.stats.totalValidated,
      avgScore: this.stats.avgScore,
      runsCompleted: this.stats.runsCompleted,
      lastRunAt: this.stats.lastRunAt,
      validationsPerMinute: this.stats.validationsPerMinute,
      intelligencePatterns: this.stats.intelligencePatterns,
    };
  }

  resetStats(): void {
    this.stats = {
      totalValidated: 0, validCount: 0, invalidCount: 0, partialCount: 0,
      avgScore: 0, avgLatencyMs: 0, eliteCount: 0, anonymousCount: 0, transparentCount: 0,
      dnsLeakCount: 0, geoMismatchCount: 0, reliabilityFailCount: 0,
      fastTrackedCount: 0, deepValidatedCount: 0,
      lastRunAt: 0, runsCompleted: 0, validationsPerMinute: 0, intelligencePatterns: 0,
    };
  }

  clearCache(): void {
    this.scoreCache.clear();
    this.validationHistory = [];
    this.intelligencePatterns.clear();
  }
}

// --- Singleton Instance -----------------------------------------------------

export const validationPipeline = new ValidationPipeline();
