/**
 * CAPTCHA Solver Module for ScrapeSuite Engine -- OVERDRIVE ULTIMATE EDITION
 *
 * Reactor-core multi-provider CAPTCHA solving with massive improvements:
 *  -------------------------------------------------------------------------
 *  * 5 providers: 2Captcha + CapSolver + Anti-Captcha + CapMonster + NoCaptchaAI
 *  * Auto-detection of 12+ CAPTCHA types from page HTML
 *  * Site key extraction from HTML with advanced regex heuristics
 *  * Token caching in Redis with 120s TTL + refresh-before-expiry
 *  * Cost tracking logged to CaptchaLog DB model
 *  * Provider health tracking with auto-switching across all 5 reactors
 *  * 5-provider failover chain with health scoring and intelligent fallback
 *  * Retry logic with exponential backoff + alternate provider failover chain
 *  * Rate limiting (max 20 concurrent solves per provider)
 *  * Batch solving with up to 50 controlled concurrency
 *  * Playwright integration for token injection (12+ types)
 *  * Pre-warm solver sessions & pipeline token requests
 *  * Token reuse across same-domain requests
 *  * Cost optimization: always use cheapest provider first, quality fallback
 *  * Solver intelligence: learn which provider solves which type fastest
 *  * Comprehensive real-time metrics, monitoring, and diagnostics
 *  * Adaptive polling: exponential backoff on poll intervals
 *  * Provider circuit breaker: auto-disable failing providers
 *  * Token validation: heuristic structure checks per CAPTCHA type
 *  * Cost estimation: budget batch solves before submitting
 *  * Provider comparison engine: cost / speed / quality rankings
 *  * Domain token cache: reuse tokens across same-domain requests
 *  * Pipeline slot management: up to 20 parallel solve slots
 *  * Intelligence reports: per-type provider rankings with confidence scores
 *  * Expiring token sweep: periodic background refresh of soon-to-expire tokens
 *  -------------------------------------------------------------------------
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('captcha-solver');

// --- Exported Types -----------------------------------------------------------

export type CaptchaProvider = '2captcha' | 'capsolver' | 'anti-captcha' | 'capmonster' | 'nocaptchaai';
export type CaptchaType =
  | 'recaptcha_v2'
  | 'recaptcha_v3'
  | 'hcaptcha'
  | 'funcaptcha'
  | 'turnstile'
  | 'image'
  | 'geetest'
  | 'arkose_labs'
  | 'aws_waf'
  | 'salesforce'
  | 'cocoa'
  | 'keycaptcha';

export interface CaptchaTask {
  id: string;
  type: CaptchaType;
  siteKey: string;
  pageUrl: string;
  provider: CaptchaProvider;
  status: 'pending' | 'warming' | 'solving' | 'solved' | 'failed';
  token?: string;
  solveTimeMs: number;
  cost: number;
  createdAt: number;
  solvedAt?: number;
  error?: string;
  domain: string;
  proxyUrl?: string;
  pipelinePosition?: number;
}

export interface CaptchaSolveRequest {
  type: CaptchaType;
  siteKey: string;
  pageUrl: string;
  domain?: string;
  proxyUrl?: string;
  provider?: CaptchaProvider;
  action?: string;
  minScore?: number;
  imageData?: string;
  /** If true, attempt token reuse from same-domain cache before solving */
  allowTokenReuse?: boolean;
  /** Priority override: 'cost' = cheapest, 'speed' = fastest, 'quality' = highest success */
  priority?: 'cost' | 'speed' | 'quality';
}

export interface CaptchaSolveResult {
  success: boolean;
  token?: string;
  provider: CaptchaProvider;
  solveTimeMs: number;
  cost: number;
  taskId: string;
  error?: string;
  fromCache?: boolean;
  reusedToken?: boolean;
}

export interface CaptchaSolverStats {
  totalSolved: number;
  totalFailed: number;
  totalCost: number;
  avgSolveTimeMs: number;
  successRate: number;
  cacheHits: number;
  tokenReuseHits: number;
  pipelineSolves: number;
  byType: Record<CaptchaType, { solved: number; failed: number; avgTime: number; cost: number }>;
  byProvider: Record<CaptchaProvider, { solved: number; failed: number; avgTime: number; cost: number; healthScore: number }>;
  solverIntelligence: Record<CaptchaType, { bestProvider: CaptchaProvider; avgTime: number; successRate: number }>;
  tokenCacheSize: number;
  activeSolves: number;
  prewarmedSessions: number;
}

// --- Internal Types -----------------------------------------------------------

interface ProviderHealth {
  solved: number;
  failed: number;
  totalSolveTimeMs: number;
  totalCost: number;
  consecutiveFailures: number;
  lastSolvedAt: number;
  lastFailedAt: number;
  healthScore: number;
  avgLatencyMs: number;
  lastBalanceCheck: number;
  /** Circuit breaker: provider is tripped open after consecutive failures */
  circuitBreakerTripped: boolean;
  /** Timestamp when circuit breaker was tripped */
  circuitBreakerTrippedAt: number;
  /** Number of times the circuit breaker has been tripped */
  circuitBreakerTripCount: number;
  /** Exponential decay score for recent performance */
  recentSuccessRate: number;
  /** Window of recent results for EMA calculation */
  recentResults: Array<{ success: boolean; timestamp: number }>;
}

interface DetectedCaptcha {
  type: CaptchaType;
  siteKey: string;
  confidence: number;
}

interface SolverIntelligenceEntry {
  provider: CaptchaProvider;
  type: CaptchaType;
  avgSolveTimeMs: number;
  successRate: number;
  sampleCount: number;
  lastUpdated: number;
  /** Exponential moving average of solve times (more responsive to changes) */
  emaSolveTimeMs: number;
  /** Peak solve time (worst case) */
  peakSolveTimeMs: number;
  /** Minimum solve time (best case) */
  minSolveTimeMs: number;
  /** Last 10 solve times for percentile calculation */
  recentSolveTimes: number[];
}

interface PrewarmSession {
  provider: CaptchaProvider;
  createdAt: number;
  lastUsed: number;
  isActive: boolean;
  /** Session has been validated with a balance check */
  validated: boolean;
  /** Last validation timestamp */
  lastValidatedAt: number;
}

interface DomainTokenCache {
  domain: string;
  type: CaptchaType;
  tokens: Map<string, { token: string; solvedAt: number; provider: CaptchaProvider; cost: number }>;
  /** Hit count for LRU eviction */
  hitCounts: Map<string, number>;
}

interface PipelineSlot {
  id: number;
  busy: boolean;
  taskId: string | null;
  startedAt: number | null;
  provider: CaptchaProvider | null;
}

interface CacheEntry {
  token: string;
  solvedAt: number;
  provider: CaptchaProvider;
  type: CaptchaType;
  siteKey: string;
  pageUrl: string;
  refreshCount: number;
}

// --- Constants ----------------------------------------------------------------

const POLL_INTERVAL_MS = 1_200;               // Even faster polling (was 1.5s)
const POLL_INTERVAL_MAX_MS = 5_000;            // Max poll interval with adaptive backoff
const POLL_BACKOFF_FACTOR = 1.15;              // 15% increase per poll cycle
const MAX_WAIT_MS = 120_000;
const TOKEN_CACHE_TTL_SECONDS = 120;            // 120s (was 90s)
const TOKEN_REFRESH_BEFORE_EXPIRY_S = 30;       // Refresh 30s before expiry (was 20s)
const MAX_RETRIES = 3;
const MAX_CONCURRENT_PER_PROVIDER = 20;         // 20 (was 10)
const MAX_BATCH_CONCURRENCY = 50;               // 50 (was 10)
const BACKOFF_BASE_MS = 600;                    // Faster initial backoff (was 800)
const PREWARM_SESSION_COUNT = 5;                // More pre-warm sessions (was 3)
const DOMAIN_TOKEN_MAX_ENTRIES = 100;            // More tokens per domain (was 50)
const INTELLIGENCE_MIN_SAMPLES = 3;             // Lower threshold (was 5)
const INTELLIGENCE_EMA_ALPHA = 0.3;             // EMA smoothing factor
const CIRCUIT_BREAKER_THRESHOLD = 5;            // Consecutive failures before trip
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;     // 60s cooldown before retry
const CIRCUIT_BREAKER_HALF_OPEN_MAX = 1;        // Only allow 1 request in half-open
const RECENT_RESULTS_WINDOW_MS = 300_000;       // 5-minute window for recent results
const EXPIRING_TOKEN_SWEEP_INTERVAL_MS = 15_000; // Sweep every 15s
const INTELLIGENCE_RECENT_SOLVE_TIMES_MAX = 20;  // Keep last 20 solve times

const TWO_CAPTCHA_COSTS: Record<CaptchaType, number> = {
  recaptcha_v2: 0.00299,
  recaptcha_v3: 0.00299,
  hcaptcha: 0.00299,
  funcaptcha: 0.02,
  turnstile: 0.00299,
  image: 0.001,
  geetest: 0.015,
  arkose_labs: 0.02,
  aws_waf: 0.005,
  salesforce: 0.005,
  cocoa: 0.003,
  keycaptcha: 0.01,
};

const CAPSOLVER_COSTS: Record<CaptchaType, number> = {
  recaptcha_v2: 0.001,
  recaptcha_v3: 0.001,
  hcaptcha: 0.001,
  funcaptcha: 0.012,
  turnstile: 0.001,
  image: 0.0008,
  geetest: 0.01,
  arkose_labs: 0.012,
  aws_waf: 0.002,
  salesforce: 0.002,
  cocoa: 0.0015,
  keycaptcha: 0.008,
};

const ANTI_CAPTCHA_COSTS: Record<CaptchaType, number> = {
  recaptcha_v2: 0.002,
  recaptcha_v3: 0.002,
  hcaptcha: 0.002,
  funcaptcha: 0.015,
  turnstile: 0.002,
  image: 0.0008,
  geetest: 0.012,
  arkose_labs: 0.015,
  aws_waf: 0.003,
  salesforce: 0.003,
  cocoa: 0.002,
  keycaptcha: 0.01,
};

const CAPMONSTER_COSTS: Record<CaptchaType, number> = {
  recaptcha_v2: 0.0015,
  recaptcha_v3: 0.0015,
  hcaptcha: 0.0015,
  funcaptcha: 0.012,
  turnstile: 0.0015,
  image: 0.0005,
  geetest: 0.008,
  arkose_labs: 0.012,
  aws_waf: 0.002,
  salesforce: 0.002,
  cocoa: 0.0012,
  keycaptcha: 0.007,
};

const NOCAPTCHAAI_COSTS: Record<CaptchaType, number> = {
  recaptcha_v2: 0.001,
  recaptcha_v3: 0.001,
  hcaptcha: 0.001,
  funcaptcha: 0.01,
  turnstile: 0.001,
  image: 0.0005,
  geetest: 0.008,
  arkose_labs: 0.01,
  aws_waf: 0.0015,
  salesforce: 0.0015,
  cocoa: 0.001,
  keycaptcha: 0.005,
};

const PROVIDER_COSTS: Record<CaptchaProvider, Record<CaptchaType, number>> = {
  '2captcha': TWO_CAPTCHA_COSTS,
  capsolver: CAPSOLVER_COSTS,
  'anti-captcha': ANTI_CAPTCHA_COSTS,
  capmonster: CAPMONSTER_COSTS,
  nocaptchaai: NOCAPTCHAAI_COSTS,
};

const CAPTCHA_TYPE_MAP_TO_PRISMA: Record<CaptchaType, string> = {
  recaptcha_v2: 'recaptcha_v2',
  recaptcha_v3: 'recaptcha_v3',
  hcaptcha: 'hcaptcha',
  funcaptcha: 'funcaptcha',
  turnstile: 'turnstile',
  image: 'image',
  geetest: 'image',
  arkose_labs: 'funcaptcha',
  aws_waf: 'image',
  salesforce: 'image',
  cocoa: 'image',
  keycaptcha: 'image',
};

const ALL_CAPTCHA_TYPES: CaptchaType[] = [
  'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'funcaptcha', 'turnstile',
  'image', 'geetest', 'arkose_labs', 'aws_waf', 'salesforce', 'cocoa', 'keycaptcha',
];

const ALL_PROVIDERS: CaptchaProvider[] = ['2captcha', 'capsolver', 'anti-captcha', 'capmonster', 'nocaptchaai'];

// --- HTML Detection Patterns -------------------------------------------------

const RECAPTCHA_V2_PATTERNS = [
  /google\.com\/recaptcha\/api\.js/i,
  /google\.com\/recaptcha\/enterprise\.js/i,
  /grecaptcha\.render/i,
  /grecaptcha\.execute/i,
  /class=['"][^'"]*g-recaptcha[^'"]*['"]/i,
  /class=['"][^'"]*recaptcha[^'"]*['"]/i,
  /data-widget-id/i,
  /recaptcha-checkbox/i,
];

const RECAPTCHA_V3_PATTERNS = [
  /google\.com\/recaptcha\/api\.js\?render=/i,
  /google\.com\/recaptcha\/enterprise\.js\?render=/i,
  /grecaptcha\.execute\s*\(\s*['"]\s*sitekey/i,
  /recaptcha\/v3/i,
  /recaptcha.*render.*explicit/i,
  /grecaptcha\.ready/i,
];

const HCAPTCHA_PATTERNS = [
  /hcaptcha\.com\/1\/api\.js/i,
  /js\.hcaptcha\.com/i,
  /class=['"][^'"]*h-captcha[^'"]*['"]/i,
  /class=['"][^'"]*hcaptcha[^'"]*['"]/i,
  /data-hcaptcha-sitekey/i,
  /data-sitekey.*hcaptcha/i,
  /hcaptcha\.com\/captcha/i,
];

const FUNCAPTCHA_PATTERNS = [
  /funcaptcha\.com/i,
  /fc\.arkoselabs\.com/i,
  /class=['"][^'"]*funcaptcha[^'"]*['"]/i,
  /funcaptcha_api/i,
];

const TURNSTILE_PATTERNS = [
  /challenges\.cloudflare\.com\/turnstile/i,
  /turnstile\.cloudflare\.com/i,
  /class=['"][^'"]*cf-turnstile[^'"]*['"]/i,
  /cf-turnstile/i,
  /data-turnstile/i,
  /cloudflare.*challenge/i,
  /cf-challenge/i,
];

const GEETEST_PATTERNS = [
  /geetest\.com/i,
  /api\.geetest\.com/i,
  /class=['"][^'"]*geetest[^'"]*['"]/i,
  /gt\.js/i,
  /initGeetest/i,
  /geetest.*verify/i,
];

const ARKOSE_LABS_PATTERNS = [
  /arkoselabs\.com/i,
  /arkose\.com/i,
  /fc\.arkoselabs\.com/i,
  /arkose-enforcement/i,
  /data-arkose/i,
  /class=['"][^'"]*arkose[^'"]*['"]/i,
  /Enforcement.*Arkose/i,
  /arkoselabs.*challenge/i,
  /ArkoseEnforcement/i,
];

const AWS_WAF_PATTERNS = [
  /aws-waf-captcha/i,
  /aws\.amazon\.com.*captcha/i,
  /captcha\.aws/i,
  /awswaf.*challenge/i,
  /class=['"][^'"]*aws-waf[^'"]*['"]/i,
  /data-aws-waf/i,
  /AwsWafCaptcha/i,
  /aws-waf.*token/i,
];

const SALESFORCE_PATTERNS = [
  /salesforce.*captcha/i,
  /force\.com.*captcha/i,
  /g_recaptcha.*salesforce/i,
  /class=['"][^'"]*sf-captcha[^'"]*['"]/i,
  /visualforce.*recaptcha/i,
  /lightning.*captcha/i,
];

const COCOA_PATTERNS = [
  /cocoa\.com\/captcha/i,
  /cocoa-captcha/i,
  /class=['"][^'"]*cocoa-captcha[^'"]*['"]/i,
  /cocoacaptcha/i,
  /cocoa.*challenge/i,
];

const KEYCAPTCHA_PATTERNS = [
  /keycaptcha\.com/i,
  /kc\.keycaptcha\.com/i,
  /class=['"][^'"]*keycaptcha[^'"]*['"]/i,
  /s_kcaptcha/i,
  /keycaptcha.*api/i,
];

// --- Utility: Sleep -----------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Utility: Generate unique task ID -----------------------------------------

function generateTaskId(): string {
  return `cap_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

// --- Utility: Extract domain from URL -----------------------------------------

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// --- Utility: Create default ProviderHealth -----------------------------------

function createDefaultHealth(): ProviderHealth {
  return {
    solved: 0,
    failed: 0,
    totalSolveTimeMs: 0,
    totalCost: 0,
    consecutiveFailures: 0,
    lastSolvedAt: 0,
    lastFailedAt: 0,
    healthScore: 1.0,
    avgLatencyMs: 0,
    lastBalanceCheck: 0,
    circuitBreakerTripped: false,
    circuitBreakerTrippedAt: 0,
    circuitBreakerTripCount: 0,
    recentSuccessRate: 1.0,
    recentResults: [],
  };
}

// --- Health Calculator -- Shared across all providers --------------------------

function recalculateHealth(health: ProviderHealth): void {
  const total = health.solved + health.failed;
  if (total === 0) {
    health.healthScore = 1.0;
    health.recentSuccessRate = 1.0;
    return;
  }

  // Base success rate
  const successRate = health.solved / total;

  // Consecutive failure penalty
  const consecutivePenalty = Math.min(health.consecutiveFailures * 0.12, 0.6);

  // Recency bonus: recent success boosts score
  const recencyBonus = health.lastSolvedAt > health.lastFailedAt ? 0.05 : 0;

  // Recent success rate from EMA window
  const now = Date.now();
  const recentWindow = health.recentResults.filter(
    r => now - r.timestamp < RECENT_RESULTS_WINDOW_MS
  );
  if (recentWindow.length > 0) {
    health.recentSuccessRate = recentWindow.filter(r => r.success).length / recentWindow.length;
  } else {
    health.recentSuccessRate = successRate;
  }

  // Recent success rate boost/penalty
  const recentBoost = (health.recentSuccessRate - 0.5) * 0.1;

  // Circuit breaker penalty
  const circuitPenalty = health.circuitBreakerTripped ? 0.3 : 0;

  health.healthScore = Math.max(
    0,
    Math.min(1, successRate - consecutivePenalty + recencyBonus + recentBoost - circuitPenalty)
  );
}

function recordSuccess(health: ProviderHealth, solveTimeMs: number, cost: number): void {
  health.solved++;
  health.totalSolveTimeMs += solveTimeMs;
  health.totalCost += cost;
  health.consecutiveFailures = 0;
  health.lastSolvedAt = Date.now();
  health.avgLatencyMs = health.solved > 0
    ? Math.round(health.totalSolveTimeMs / health.solved)
    : 0;

  // Track recent result for EMA
  health.recentResults.push({ success: true, timestamp: Date.now() });
  // Trim old results beyond window
  const cutoff = Date.now() - RECENT_RESULTS_WINDOW_MS * 2;
  health.recentResults = health.recentResults.filter(r => r.timestamp > cutoff);

  // Reset circuit breaker on success
  if (health.circuitBreakerTripped) {
    health.circuitBreakerTripped = false;
    health.circuitBreakerTrippedAt = 0;
    logger.info('Circuit breaker reset after successful solve');
  }

  recalculateHealth(health);
}

function recordFailure(health: ProviderHealth): void {
  health.failed++;
  health.consecutiveFailures++;
  health.lastFailedAt = Date.now();

  // Track recent result
  health.recentResults.push({ success: false, timestamp: Date.now() });
  const cutoff = Date.now() - RECENT_RESULTS_WINDOW_MS * 2;
  health.recentResults = health.recentResults.filter(r => r.timestamp > cutoff);

  // Check if circuit breaker should trip
  if (health.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !health.circuitBreakerTripped) {
    health.circuitBreakerTripped = true;
    health.circuitBreakerTrippedAt = Date.now();
    health.circuitBreakerTripCount++;
    logger.warn(
      { consecutiveFailures: health.consecutiveFailures, tripCount: health.circuitBreakerTripCount },
      'Circuit breaker TRIPPED -- provider entering cooldown'
    );
  }

  recalculateHealth(health);
}

function isCircuitBreakerOpen(health: ProviderHealth): boolean {
  if (!health.circuitBreakerTripped) return false;

  // Check if cooldown period has elapsed → half-open state
  const elapsed = Date.now() - health.circuitBreakerTrippedAt;
  if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    // Allow limited requests in half-open state
    return false;
  }
  return true;
}

// --- 2Captcha Provider -------------------------------------------------------

class TwoCaptchaProvider {
  readonly name: CaptchaProvider = '2captcha';
  private apiKey: string;
  private readonly submitUrl = 'https://2captcha.com/in.php';
  private readonly resultUrl = 'https://2captcha.com/res.php';
  private activeSolves = 0;
  private health: ProviderHealth = createDefaultHealth();

  constructor() {
    this.apiKey = process.env.TWOCAPTCHA_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('TWOCAPTCHA_API_KEY not configured -- 2Captcha provider disabled');
    }
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  get canAcceptMore(): boolean {
    return this.activeSolves < MAX_CONCURRENT_PER_PROVIDER;
  }

  get isAvailable(): boolean {
    return this.isConfigured && this.canAcceptMore && !isCircuitBreakerOpen(this.health);
  }

  getHealth(): ProviderHealth {
    return { ...this.health };
  }

  /**
   * Submit a CAPTCHA task to 2Captcha and poll for the result.
   * Enhanced with adaptive polling and circuit breaker awareness.
   */
  async solve(request: CaptchaSolveRequest, taskId: string): Promise<CaptchaSolveResult> {
    if (!this.isConfigured) {
      throw new Error('2Captcha API key not configured');
    }
    if (isCircuitBreakerOpen(this.health)) {
      throw new Error('2Captcha circuit breaker is open -- provider in cooldown');
    }
    if (!this.canAcceptMore) {
      throw new Error('2Captcha rate limit reached (max concurrent solves)');
    }

    this.activeSolves++;
    const startTime = Date.now();

    try {
      const submitParams = this.buildSubmitParams(request);
      const submitData = await this.submitTask(submitParams);
      if (submitData.status !== 1) {
        throw new Error(`2Captcha submit failed: ${submitData.request || submitData.error_text || 'Unknown error'}`);
      }

      const remoteTaskId = submitData.request;
      const token = await this.pollForResult(remoteTaskId);

      const solveTimeMs = Date.now() - startTime;
      const cost = TWO_CAPTCHA_COSTS[request.type] ?? 0.003;
      recordSuccess(this.health, solveTimeMs, cost);

      return { success: true, token, provider: this.name, solveTimeMs, cost, taskId };
    } catch (err: any) {
      recordFailure(this.health);
      throw err;
    } finally {
      this.activeSolves--;
    }
  }

  async getBalance(): Promise<number> {
    if (!this.apiKey) return 0;
    try {
      const params = new URLSearchParams({ key: this.apiKey, action: 'getbalance', json: '1' });
      const response = await fetch(`${this.resultUrl}?${params}`, { signal: AbortSignal.timeout(10_000) });
      const data = (await response.json()) as any;
      this.health.lastBalanceCheck = Date.now();
      return data.request ? parseFloat(data.request) : 0;
    } catch {
      return 0;
    }
  }

  // -- Private Methods --

  private buildSubmitParams(request: CaptchaSolveRequest): Record<string, string> {
    const params: Record<string, string> = {
      key: this.apiKey,
      json: '1',
      soft_id: '5527',
    };

    switch (request.type) {
      case 'recaptcha_v2':
        params.method = 'userrecaptcha';
        params.googlekey = request.siteKey;
        params.pageurl = request.pageUrl;
        break;
      case 'recaptcha_v3':
        params.method = 'userrecaptcha';
        params.googlekey = request.siteKey;
        params.pageurl = request.pageUrl;
        params.version = 'v3';
        if (request.action) params.action = request.action;
        if (request.minScore) params.min_score = String(request.minScore);
        break;
      case 'hcaptcha':
        params.method = 'hcaptcha';
        params.sitekey = request.siteKey;
        params.pageurl = request.pageUrl;
        break;
      case 'funcaptcha':
      case 'arkose_labs':
        params.method = 'funcaptcha';
        params.publickey = request.siteKey;
        params.surl = 'https://client-api.arkoselabs.com';
        params.pageurl = request.pageUrl;
        break;
      case 'turnstile':
        params.method = 'turnstile';
        params.sitekey = request.siteKey;
        params.pageurl = request.pageUrl;
        break;
      case 'image':
        params.method = 'base64';
        params.body = request.imageData || '';
        break;
      case 'geetest':
        params.method = 'geetest';
        params.gt = request.siteKey;
        params.pageurl = request.pageUrl;
        break;
      case 'aws_waf':
        params.method = 'userrecaptcha';
        params.googlekey = request.siteKey;
        params.pageurl = request.pageUrl;
        params.version = 'v3';
        break;
      case 'salesforce':
        params.method = 'userrecaptcha';
        params.googlekey = request.siteKey;
        params.pageurl = request.pageUrl;
        break;
      case 'cocoa':
        params.method = 'hcaptcha';
        params.sitekey = request.siteKey;
        params.pageurl = request.pageUrl;
        break;
      case 'keycaptcha':
        params.method = 'keycaptcha';
        params.pageurl = request.pageUrl;
        break;
      default:
        throw new Error(`2Captcha: unsupported CAPTCHA type '${request.type}'`);
    }

    if (request.proxyUrl) {
      try {
        const proxyUrl = new URL(request.proxyUrl);
        let proxyStr = `${proxyUrl.hostname}:${proxyUrl.port}`;
        if (proxyUrl.username) proxyStr += `:${proxyUrl.username}:${proxyUrl.password}`;
        params.proxy = proxyStr;
        params.proxytype = proxyUrl.protocol === 'https:' ? 'HTTPS' : 'HTTP';
      } catch {
        logger.warn({ proxyUrl: request.proxyUrl }, 'Invalid proxy URL for 2Captcha');
      }
    }

    return params;
  }

  private async submitTask(params: Record<string, string>): Promise<any> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.submitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const data = (await response.json()) as any;
        if (data.error_text?.includes('ERROR_WRONG_USER_KEY') || data.error_text?.includes('ERROR_KEY_DOES_NOT_EXIST')) {
          throw new Error(`2Captcha auth error: ${data.error_text}`);
        }
        return data;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) {
          const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
          logger.warn({ attempt, backoff, error: err.message }, '2Captcha submit retry');
          await sleep(backoff);
        }
      }
    }
    throw lastError || new Error('2Captcha submit failed after retries');
  }

  /**
   * Poll for result with adaptive interval.
   * Starts fast, gradually backs off to reduce unnecessary API calls.
   */
  private async pollForResult(remoteTaskId: string): Promise<string> {
    let currentInterval = POLL_INTERVAL_MS;
    const totalMaxPolls = Math.ceil(MAX_WAIT_MS / POLL_INTERVAL_MS);
    await sleep(3_500); // Initial delay before first poll

    for (let i = 0; i < totalMaxPolls; i++) {
      const params = new URLSearchParams({
        key: this.apiKey,
        action: 'get',
        id: remoteTaskId,
        json: '1',
      });

      try {
        const response = await fetch(`${this.resultUrl}?${params}`, { signal: AbortSignal.timeout(15_000) });
        const data = (await response.json()) as any;

        if (data.status === 1) return data.request as string;
        if (data.request === 'CAPCHA_NOT_READY') {
          // Adaptive: increase interval gradually
          await sleep(Math.round(currentInterval));
          currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS);
          continue;
        }
        throw new Error(`2Captcha solve error: ${data.request || data.error_text || 'Unknown'}`);
      } catch (err: any) {
        if (err.name === 'TimeoutError' || err.code === 'ECONNRESET') {
          logger.warn({ poll: i, error: err.message }, '2Captcha poll network error, retrying');
          await sleep(Math.round(currentInterval));
          currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`2Captcha solve timeout (${MAX_WAIT_MS / 1000}s)`);
  }
}

// --- CapSolver Provider -------------------------------------------------------

class CapSolverProvider {
  readonly name: CaptchaProvider = 'capsolver';
  private apiKey: string;
  private readonly createUrl = 'https://api.capsolver.com/createTask';
  private readonly resultUrl = 'https://api.capsolver.com/getTaskResult';
  private activeSolves = 0;
  private health: ProviderHealth = createDefaultHealth();

  constructor() {
    this.apiKey = process.env.CAPSOLVER_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('CAPSOLVER_API_KEY not configured -- CapSolver provider disabled');
    }
  }

  get isConfigured(): boolean { return !!this.apiKey; }
  get canAcceptMore(): boolean { return this.activeSolves < MAX_CONCURRENT_PER_PROVIDER; }
  get isAvailable(): boolean { return this.isConfigured && this.canAcceptMore && !isCircuitBreakerOpen(this.health); }
  getHealth(): ProviderHealth { return { ...this.health }; }

  async solve(request: CaptchaSolveRequest, taskId: string): Promise<CaptchaSolveResult> {
    if (!this.isConfigured) throw new Error('CapSolver API key not configured');
    if (isCircuitBreakerOpen(this.health)) throw new Error('CapSolver circuit breaker open -- cooldown');
    if (!this.canAcceptMore) throw new Error('CapSolver rate limit reached');

    this.activeSolves++;
    const startTime = Date.now();

    try {
      const taskPayload = this.buildTaskPayload(request);
      const createData = await this.createTask(taskPayload);
      if (createData.errorId && createData.errorId !== 0) {
        throw new Error(`CapSolver createTask failed: ${createData.errorDescription || createData.errorCode || 'Unknown'}`);
      }
      const remoteTaskId = createData.taskId;
      if (!remoteTaskId) throw new Error('CapSolver did not return a taskId');

      const solution = await this.pollForResult(remoteTaskId);
      const solveTimeMs = Date.now() - startTime;
      const cost = CAPSOLVER_COSTS[request.type] ?? 0.002;
      recordSuccess(this.health, solveTimeMs, cost);

      const token = solution.gRecaptchaResponse || solution.captchaKey || solution.token || solution.text || solution.validate || '';
      return { success: true, token, provider: this.name, solveTimeMs, cost, taskId };
    } catch (err: any) {
      recordFailure(this.health);
      throw err;
    } finally {
      this.activeSolves--;
    }
  }

  async getBalance(): Promise<number> {
    if (!this.apiKey) return 0;
    try {
      const response = await fetch('https://api.capsolver.com/getBalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json()) as any;
      this.health.lastBalanceCheck = Date.now();
      return data.balance ?? 0;
    } catch { return 0; }
  }

  private buildTaskPayload(request: CaptchaSolveRequest): Record<string, any> {
    const payload: Record<string, any> = {};
    const useProxy = !!request.proxyUrl;

    switch (request.type) {
      case 'recaptcha_v2':
        payload.type = useProxy ? 'ReCaptchaV2Task' : 'ReCaptchaV2TaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'recaptcha_v3':
        payload.type = useProxy ? 'ReCaptchaV3Task' : 'ReCaptchaV3TaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        if (request.action) payload.pageAction = request.action;
        if (request.minScore) payload.minScore = request.minScore;
        break;
      case 'hcaptcha':
        payload.type = useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'funcaptcha':
      case 'arkose_labs':
        payload.type = useProxy ? 'FunCaptchaTask' : 'FunCaptchaTaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.websitePublicKey = request.siteKey;
        payload.funcaptchaApiJSSubdomain = 'https://client-api.arkoselabs.com';
        break;
      case 'turnstile':
        payload.type = useProxy ? 'AntiTurnstileTask' : 'AntiTurnstileTaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'image':
        payload.type = 'ImageToTextTask';
        payload.body = request.imageData || '';
        break;
      case 'geetest':
        payload.type = useProxy ? 'GeeTestTask' : 'GeeTestTaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.gt = request.siteKey;
        break;
      case 'aws_waf':
        payload.type = useProxy ? 'AntiAwsWafTask' : 'AntiAwsWafTaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'salesforce':
        payload.type = useProxy ? 'ReCaptchaV2Task' : 'ReCaptchaV2TaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'cocoa':
        payload.type = useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'keycaptcha':
        payload.type = useProxy ? 'ReCaptchaV2Task' : 'ReCaptchaV2TaskProxyLess';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      default:
        throw new Error(`CapSolver: unsupported CAPTCHA type '${request.type}'`);
    }

    if (request.proxyUrl && useProxy) {
      try {
        const proxyUrl = new URL(request.proxyUrl);
        payload.proxy = { type: proxyUrl.protocol === 'https:' ? 'https' : 'http', uri: request.proxyUrl };
      } catch {
        logger.warn({ proxyUrl: request.proxyUrl }, 'Invalid proxy URL for CapSolver');
      }
    }

    return payload;
  }

  private async createTask(taskPayload: Record<string, any>): Promise<any> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.createUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: this.apiKey, task: taskPayload }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        return (await response.json()) as any;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) {
          const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
          logger.warn({ attempt, backoff, error: err.message }, 'CapSolver createTask retry');
          await sleep(backoff);
        }
      }
    }
    throw lastError || new Error('CapSolver createTask failed after retries');
  }

  private async pollForResult(remoteTaskId: string): Promise<Record<string, any>> {
    let currentInterval = POLL_INTERVAL_MS;
    const totalMaxPolls = Math.ceil(MAX_WAIT_MS / POLL_INTERVAL_MS);

    for (let i = 0; i < totalMaxPolls; i++) {
      await sleep(Math.round(currentInterval));
      try {
        const response = await fetch(this.resultUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: this.apiKey, taskId: remoteTaskId }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = (await response.json()) as any;
        if (data.status === 'ready') return data.solution || {};
        if (data.errorId && data.errorId !== 0) {
          if (data.errorCode === 'ERROR_TASK_NOT_FOUND' || data.errorCode === 'ERROR_INVALID_TASK_ID') {
            throw new Error(`CapSolver task error: ${data.errorDescription || data.errorCode}`);
          }
          continue;
        }
      } catch (err: any) {
        if (err.name === 'TimeoutError' || err.code === 'ECONNRESET') {
          currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS);
          continue;
        }
        throw err;
      }
      currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS);
    }
    throw new Error(`CapSolver solve timeout (${MAX_WAIT_MS / 1000}s)`);
  }
}

// --- Anti-Captcha Provider ----------------------------------------------------

class AntiCaptchaProvider {
  readonly name: CaptchaProvider = 'anti-captcha';
  private apiKey: string;
  private readonly createUrl = 'https://api.anti-captcha.com/createTask';
  private readonly resultUrl = 'https://api.anti-captcha.com/getTaskResult';
  private activeSolves = 0;
  private health: ProviderHealth = createDefaultHealth();

  constructor() {
    this.apiKey = process.env.ANTI_CAPTCHA_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('ANTI_CAPTCHA_API_KEY not configured -- Anti-Captcha provider disabled');
    }
  }

  get isConfigured(): boolean { return !!this.apiKey; }
  get canAcceptMore(): boolean { return this.activeSolves < MAX_CONCURRENT_PER_PROVIDER; }
  get isAvailable(): boolean { return this.isConfigured && this.canAcceptMore && !isCircuitBreakerOpen(this.health); }
  getHealth(): ProviderHealth { return { ...this.health }; }

  async solve(request: CaptchaSolveRequest, taskId: string): Promise<CaptchaSolveResult> {
    if (!this.isConfigured) throw new Error('Anti-Captcha API key not configured');
    if (isCircuitBreakerOpen(this.health)) throw new Error('Anti-Captcha circuit breaker open -- cooldown');
    if (!this.canAcceptMore) throw new Error('Anti-Captcha rate limit reached');

    this.activeSolves++;
    const startTime = Date.now();

    try {
      const taskPayload = this.buildTaskPayload(request);
      const createData = await this.createTask(taskPayload);
      if (createData.errorId && createData.errorId !== 0) {
        throw new Error(`Anti-Captcha createTask failed: ${createData.errorDescription || createData.errorCode || 'Unknown'}`);
      }
      const remoteTaskId = createData.taskId;
      if (!remoteTaskId) throw new Error('Anti-Captcha did not return a taskId');

      const solution = await this.pollForResult(remoteTaskId);
      const solveTimeMs = Date.now() - startTime;
      const cost = ANTI_CAPTCHA_COSTS[request.type] ?? 0.003;
      recordSuccess(this.health, solveTimeMs, cost);

      const token = solution.gRecaptchaResponse || solution.captchaKey || solution.token || solution.text || solution.validate || '';
      return { success: true, token, provider: this.name, solveTimeMs, cost, taskId };
    } catch (err: any) {
      recordFailure(this.health);
      throw err;
    } finally {
      this.activeSolves--;
    }
  }

  async getBalance(): Promise<number> {
    if (!this.apiKey) return 0;
    try {
      const response = await fetch('https://api.anti-captcha.com/getBalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json()) as any;
      this.health.lastBalanceCheck = Date.now();
      return data.balance ?? 0;
    } catch { return 0; }
  }

  private buildTaskPayload(request: CaptchaSolveRequest): Record<string, any> {
    const payload: Record<string, any> = {};
    const useProxy = !!request.proxyUrl;

    switch (request.type) {
      case 'recaptcha_v2':
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'recaptcha_v3':
        payload.type = 'RecaptchaV3TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        if (request.action) payload.pageAction = request.action;
        if (request.minScore) payload.minScore = request.minScore;
        break;
      case 'hcaptcha':
        payload.type = useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'funcaptcha':
      case 'arkose_labs':
        payload.type = useProxy ? 'FunCaptchaTask' : 'FunCaptchaTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websitePublicKey = request.siteKey;
        payload.funcaptchaApiJSSubdomain = 'https://client-api.arkoselabs.com';
        break;
      case 'turnstile':
        payload.type = useProxy ? 'TurnstileTask' : 'TurnstileTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'image':
        payload.type = 'ImageToTextTask';
        payload.body = request.imageData || '';
        break;
      case 'geetest':
        payload.type = useProxy ? 'GeeTestTask' : 'GeeTestTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.gt = request.siteKey;
        break;
      case 'aws_waf':
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'salesforce':
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'cocoa':
        payload.type = useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'keycaptcha':
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      default:
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
    }

    if (request.proxyUrl && useProxy) {
      try {
        const proxyUrl = new URL(request.proxyUrl);
        payload.proxyType = proxyUrl.protocol === 'https:' ? 'https' : 'http';
        payload.proxyAddress = proxyUrl.hostname;
        payload.proxyPort = parseInt(proxyUrl.port, 10);
        if (proxyUrl.username) payload.proxyLogin = proxyUrl.username;
        if (proxyUrl.password) payload.proxyPassword = proxyUrl.password;
      } catch {
        logger.warn({ proxyUrl: request.proxyUrl }, 'Invalid proxy URL for Anti-Captcha');
      }
    }

    return payload;
  }

  private async createTask(taskPayload: Record<string, any>): Promise<any> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.createUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: this.apiKey, task: taskPayload }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        return (await response.json()) as any;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
      }
    }
    throw lastError || new Error('Anti-Captcha createTask failed after retries');
  }

  private async pollForResult(remoteTaskId: string): Promise<Record<string, any>> {
    let currentInterval = POLL_INTERVAL_MS;
    const totalMaxPolls = Math.ceil(MAX_WAIT_MS / POLL_INTERVAL_MS);
    for (let i = 0; i < totalMaxPolls; i++) {
      await sleep(Math.round(currentInterval));
      try {
        const response = await fetch(this.resultUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: this.apiKey, taskId: remoteTaskId }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = (await response.json()) as any;
        if (data.status === 'ready') return data.solution || {};
        if (data.errorId && data.errorId !== 0) {
          if (data.errorCode === 'ERROR_TASK_NOT_FOUND' || data.errorCode === 'ERROR_INVALID_TASK_ID') {
            throw new Error(`Anti-Captcha task error: ${data.errorDescription || data.errorCode}`);
          }
          continue;
        }
      } catch (err: any) {
        if (err.name === 'TimeoutError' || err.code === 'ECONNRESET') {
          currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS);
          continue;
        }
        throw err;
      }
      currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS);
    }
    throw new Error(`Anti-Captcha solve timeout (${MAX_WAIT_MS / 1000}s)`);
  }
}

// --- CapMonster Provider -----------------------------------------------------

class CapMonsterProvider {
  readonly name: CaptchaProvider = 'capmonster';
  private apiKey: string;
  private readonly createUrl = 'https://api.capmonster.cloud/createTask';
  private readonly resultUrl = 'https://api.capmonster.cloud/getTaskResult';
  private activeSolves = 0;
  private health: ProviderHealth = createDefaultHealth();

  constructor() {
    this.apiKey = process.env.CAPMONSTER_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('CAPMONSTER_API_KEY not configured -- CapMonster provider disabled');
    }
  }

  get isConfigured(): boolean { return !!this.apiKey; }
  get canAcceptMore(): boolean { return this.activeSolves < MAX_CONCURRENT_PER_PROVIDER; }
  get isAvailable(): boolean { return this.isConfigured && this.canAcceptMore && !isCircuitBreakerOpen(this.health); }
  getHealth(): ProviderHealth { return { ...this.health }; }

  async solve(request: CaptchaSolveRequest, taskId: string): Promise<CaptchaSolveResult> {
    if (!this.isConfigured) throw new Error('CapMonster API key not configured');
    if (isCircuitBreakerOpen(this.health)) throw new Error('CapMonster circuit breaker open -- cooldown');
    if (!this.canAcceptMore) throw new Error('CapMonster rate limit reached');

    this.activeSolves++;
    const startTime = Date.now();

    try {
      const taskPayload = this.buildTaskPayload(request);
      const createData = await this.createTask(taskPayload);
      if (createData.errorId && createData.errorId !== 0) {
        throw new Error(`CapMonster createTask failed: ${createData.errorDescription || createData.errorCode || 'Unknown'}`);
      }
      const remoteTaskId = createData.taskId;
      if (!remoteTaskId) throw new Error('CapMonster did not return a taskId');

      const solution = await this.pollForResult(remoteTaskId);
      const solveTimeMs = Date.now() - startTime;
      const cost = CAPMONSTER_COSTS[request.type] ?? 0.002;
      recordSuccess(this.health, solveTimeMs, cost);

      const token = solution.gRecaptchaResponse || solution.captchaKey || solution.token || solution.text || solution.validate || '';
      return { success: true, token, provider: this.name, solveTimeMs, cost, taskId };
    } catch (err: any) {
      recordFailure(this.health);
      throw err;
    } finally {
      this.activeSolves--;
    }
  }

  async getBalance(): Promise<number> {
    if (!this.apiKey) return 0;
    try {
      const response = await fetch('https://api.capmonster.cloud/getBalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json()) as any;
      this.health.lastBalanceCheck = Date.now();
      return data.balance ?? 0;
    } catch { return 0; }
  }

  private buildTaskPayload(request: CaptchaSolveRequest): Record<string, any> {
    const payload: Record<string, any> = {};
    const useProxy = !!request.proxyUrl;

    switch (request.type) {
      case 'recaptcha_v2':
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'recaptcha_v3':
        payload.type = 'RecaptchaV3TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        if (request.action) payload.pageAction = request.action;
        if (request.minScore) payload.minScore = request.minScore;
        break;
      case 'hcaptcha':
        payload.type = useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'funcaptcha':
      case 'arkose_labs':
        payload.type = useProxy ? 'FunCaptchaTask' : 'FunCaptchaTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websitePublicKey = request.siteKey;
        payload.funcaptchaApiJSSubdomain = 'https://client-api.arkoselabs.com';
        break;
      case 'turnstile':
        payload.type = useProxy ? 'TurnstileTask' : 'TurnstileTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'image':
        payload.type = 'ImageToTextTask';
        payload.body = request.imageData || '';
        break;
      case 'geetest':
        payload.type = useProxy ? 'GeeTestTask' : 'GeeTestTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.gt = request.siteKey;
        break;
      case 'aws_waf':
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'salesforce':
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'cocoa':
        payload.type = useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      case 'keycaptcha':
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
      default:
        payload.type = useProxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless';
        payload.websiteURL = request.pageUrl;
        payload.websiteKey = request.siteKey;
        break;
    }

    if (request.proxyUrl && useProxy) {
      try {
        const proxyUrl = new URL(request.proxyUrl);
        payload.proxyType = proxyUrl.protocol === 'https:' ? 'https' : 'http';
        payload.proxyAddress = proxyUrl.hostname;
        payload.proxyPort = parseInt(proxyUrl.port, 10);
        if (proxyUrl.username) payload.proxyLogin = proxyUrl.username;
        if (proxyUrl.password) payload.proxyPassword = proxyUrl.password;
      } catch {
        logger.warn({ proxyUrl: request.proxyUrl }, 'Invalid proxy URL for CapMonster');
      }
    }

    return payload;
  }

  private async createTask(taskPayload: Record<string, any>): Promise<any> {
    const maxRetries = 2;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.createUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: this.apiKey, task: taskPayload }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        return (await response.json()) as any;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
      }
    }
    throw lastError || new Error('CapMonster createTask failed after retries');
  }

  private async pollForResult(remoteTaskId: string): Promise<Record<string, any>> {
    let currentInterval = POLL_INTERVAL_MS;
    const totalMaxPolls = Math.ceil(MAX_WAIT_MS / POLL_INTERVAL_MS);
    for (let i = 0; i < totalMaxPolls; i++) {
      await sleep(Math.round(currentInterval));
      try {
        const response = await fetch(this.resultUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: this.apiKey, taskId: remoteTaskId }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = (await response.json()) as any;
        if (data.status === 'ready') return data.solution || {};
        if (data.errorId && data.errorId !== 0) {
          if (data.errorCode === 'ERROR_TASK_NOT_FOUND') {
            throw new Error(`CapMonster task error: ${data.errorDescription || data.errorCode}`);
          }
          continue;
        }
      } catch (err: any) {
        if (err.name === 'TimeoutError' || err.code === 'ECONNRESET') {
          currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS);
          continue;
        }
        throw err;
      }
      currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS);
    }
    throw new Error(`CapMonster solve timeout (${MAX_WAIT_MS / 1000}s)`);
  }
}

// --- NoCaptchaAI Provider ----------------------------------------------------

class NoCaptchaAIProvider {
  readonly name: CaptchaProvider = 'nocaptchaai';
  private apiKey: string;
  private readonly solveUrl = 'https://api.nocaptchaai.com/solve';
  private activeSolves = 0;
  private health: ProviderHealth = createDefaultHealth();

  constructor() {
    this.apiKey = process.env.NOCAPTCHAAI_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('NOCAPTCHAAI_API_KEY not configured -- NoCaptchaAI provider disabled');
    }
  }

  get isConfigured(): boolean { return !!this.apiKey; }
  get canAcceptMore(): boolean { return this.activeSolves < MAX_CONCURRENT_PER_PROVIDER; }
  get isAvailable(): boolean { return this.isConfigured && this.canAcceptMore && !isCircuitBreakerOpen(this.health); }
  getHealth(): ProviderHealth { return { ...this.health }; }

  async solve(request: CaptchaSolveRequest, taskId: string): Promise<CaptchaSolveResult> {
    if (!this.isConfigured) throw new Error('NoCaptchaAI API key not configured');
    if (isCircuitBreakerOpen(this.health)) throw new Error('NoCaptchaAI circuit breaker open -- cooldown');
    if (!this.canAcceptMore) throw new Error('NoCaptchaAI rate limit reached');

    this.activeSolves++;
    const startTime = Date.now();

    try {
      const payload = this.buildPayload(request);
      const submitData = await this.submitSolve(payload);

      const token = submitData.solution?.token || submitData.solution?.text || submitData.token || submitData.text || '';
      if (!token) throw new Error('NoCaptchaAI returned empty solution');

      const solveTimeMs = Date.now() - startTime;
      const cost = NOCAPTCHAAI_COSTS[request.type] ?? 0.002;
      recordSuccess(this.health, solveTimeMs, cost);

      return { success: true, token, provider: this.name, solveTimeMs, cost, taskId };
    } catch (err: any) {
      recordFailure(this.health);
      throw err;
    } finally {
      this.activeSolves--;
    }
  }

  async getBalance(): Promise<number> {
    if (!this.apiKey) return 0;
    try {
      const response = await fetch('https://api.nocaptchaai.com/balance', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json()) as any;
      this.health.lastBalanceCheck = Date.now();
      return data.balance ?? data.credits ?? 0;
    } catch { return 0; }
  }

  private buildPayload(request: CaptchaSolveRequest): Record<string, any> {
    const payload: Record<string, any> = {
      type: request.type,
      sitekey: request.siteKey,
      url: request.pageUrl,
    };
    if (request.action) payload.action = request.action;
    if (request.minScore) payload.minScore = request.minScore;
    if (request.proxyUrl) payload.proxy = request.proxyUrl;
    return payload;
  }

  private async submitSolve(payload: Record<string, any>): Promise<any> {
    const maxRetries = 2;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.solveUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const data = (await response.json()) as any;
        if (data.error) throw new Error(`NoCaptchaAI error: ${data.error}`);
        return data;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
      }
    }
    throw lastError || new Error('NoCaptchaAI solve failed after retries');
  }
}

// --- Main CaptchaSolver Class -- REACTOR CORE ULTIMATE -------------------------

export class CaptchaSolver {
  private twoCaptcha: TwoCaptchaProvider;
  private capSolver: CapSolverProvider;
  private antiCaptcha: AntiCaptchaProvider;
  private capMonster: CapMonsterProvider;
  private noCaptchaAI: NoCaptchaAIProvider;
  private activeTasks: Map<string, CaptchaTask> = new Map();
  private providerMap: Map<CaptchaProvider, any>;

  // Solver intelligence -- learn which provider solves which type fastest
  private intelligence: Map<string, SolverIntelligenceEntry> = new Map();

  // Domain token reuse cache with LRU eviction
  private domainTokenCaches: Map<string, DomainTokenCache> = new Map();

  // Pre-warm session tracking
  private prewarmSessions: Map<CaptchaProvider, PrewarmSession[]> = new Map();

  // Pipeline slots for parallel token requests
  private pipelineSlots: PipelineSlot[] = Array.from({ length: MAX_CONCURRENT_PER_PROVIDER }, (_, i) => ({
    id: i, busy: false, taskId: null as string | null, startedAt: null as number | null,
    provider: null as CaptchaProvider | null,
  }));

  // Expiring token sweep timer
  private expiringSweepTimer: ReturnType<typeof setInterval> | null = null;

  // Aggregate statistics (in-memory, reset on restart)
  private stats = {
    totalSolved: 0,
    totalFailed: 0,
    totalSolveTimeMs: 0,
    totalCost: 0,
    cacheHits: 0,
    tokenReuseHits: 0,
    pipelineSolves: 0,
    backgroundRefreshes: 0,
    circuitBreakerTrips: 0,
    byType: {} as Record<CaptchaType, { solved: number; failed: number; totalSolveTimeMs: number; cost: number }>,
    byProvider: {} as Record<CaptchaProvider, { solved: number; failed: number; totalSolveTimeMs: number; cost: number }>,
  };

  constructor() {
    this.twoCaptcha = new TwoCaptchaProvider();
    this.capSolver = new CapSolverProvider();
    this.antiCaptcha = new AntiCaptchaProvider();
    this.capMonster = new CapMonsterProvider();
    this.noCaptchaAI = new NoCaptchaAIProvider();

    this.providerMap = new Map<CaptchaProvider, any>([
      ['2captcha', this.twoCaptcha],
      ['capsolver', this.capSolver],
      ['anti-captcha', this.antiCaptcha],
      ['capmonster', this.capMonster],
      ['nocaptchaai', this.noCaptchaAI],
    ]);

    // Initialize stats for each type
    for (const type of ALL_CAPTCHA_TYPES) {
      this.stats.byType[type] = { solved: 0, failed: 0, totalSolveTimeMs: 0, cost: 0 };
    }
    // Initialize stats for each provider
    for (const provider of ALL_PROVIDERS) {
      this.stats.byProvider[provider] = { solved: 0, failed: 0, totalSolveTimeMs: 0, cost: 0 };
    }

    // Pre-warm solver sessions
    this.prewarmAllProviders();

    // Start expiring token sweep
    this.startExpiringTokenSweep();

    logger.info(
      {
        twoCaptcha: this.twoCaptcha.isConfigured,
        capSolver: this.capSolver.isConfigured,
        antiCaptcha: this.antiCaptcha.isConfigured,
        capMonster: this.capMonster.isConfigured,
        noCaptchaAI: this.noCaptchaAI.isConfigured,
      },
      'CAPTCHA Solver REACTOR CORE ULTIMATE initialized -- 5 providers online'
    );
  }

  // --- Pre-warm Solver Sessions ----------------------------------------------

  private prewarmAllProviders(): void {
    for (const provider of ALL_PROVIDERS) {
      const impl = this.providerMap.get(provider);
      if (impl && impl.isConfigured) {
        const sessions: PrewarmSession[] = [];
        for (let i = 0; i < PREWARM_SESSION_COUNT; i++) {
          sessions.push({
            provider,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            isActive: true,
            validated: false,
            lastValidatedAt: 0,
          });
        }
        this.prewarmSessions.set(provider, sessions);

        // Validate sessions by checking balance
        impl.getBalance().then(balance => {
          for (const session of sessions) {
            session.validated = balance > 0;
            session.lastValidatedAt = Date.now();
          }
          logger.debug({ provider, balance, sessions: sessions.length }, 'Pre-warm sessions validated');
        }).catch(() => {
          logger.debug({ provider }, 'Pre-warm balance check failed (non-fatal)');
        });
      }
    }
  }

  // --- Expiring Token Sweep --------------------------------------------------

  private startExpiringTokenSweep(): void {
    if (this.expiringSweepTimer) clearInterval(this.expiringSweepTimer);
    this.expiringSweepTimer = setInterval(() => {
      this.sweepExpiringTokens().catch(err => {
        logger.debug({ error: (err as any)?.message }, 'Expiring token sweep failed');
      });
    }, EXPIRING_TOKEN_SWEEP_INTERVAL_MS);
  }

  /**
   * Periodically check for tokens that are about to expire and refresh them.
   * This ensures that frequently used tokens are always available.
   */
  private async sweepExpiringTokens(): Promise<void> {
    try {
      const keys = await redis.keys('cache:captcha:*');
      let refreshed = 0;

      for (const key of keys) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;

          const cached = JSON.parse(raw) as CacheEntry;
          if (!cached || !cached.token) continue;

          const age = (Date.now() - cached.solvedAt) / 1000;
          // Refresh if token is within 30s of expiry
          if (age > TOKEN_CACHE_TTL_SECONDS - TOKEN_REFRESH_BEFORE_EXPIRY_S) {
            this.triggerBackgroundRefresh(key.replace('cache:', '')).catch(() => {});
            refreshed++;
          }
        } catch {
          // Skip malformed entries
        }
      }

      if (refreshed > 0) {
        logger.debug({ refreshed, total: keys.length }, 'Expiring token sweep: triggered refreshes');
      }
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Expiring token sweep error (Redis may be unavailable)');
    }
  }

  // --- Main Solve Entry Point ----------------------------------------------

  /**
   * Solve a CAPTCHA by type and site key.
   * Reactor-core pipeline: cache → reuse → pipeline → solve → failover chain.
   */
  async solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult> {
    const taskId = generateTaskId();
    const domain = request.domain || extractDomain(request.pageUrl);

    this.validateRequest(request);

    const task: CaptchaTask = {
      id: taskId,
      type: request.type,
      siteKey: request.siteKey,
      pageUrl: request.pageUrl,
      provider: request.provider || 'capsolver',
      status: 'pending',
      solveTimeMs: 0,
      cost: 0,
      createdAt: Date.now(),
      domain,
      proxyUrl: request.proxyUrl,
    };
    this.activeTasks.set(taskId, task);

    try {
      // -- Phase 1: Check token cache --
      const cacheKey = this.buildCacheKey(request);
      const cachedToken = await this.checkCache(cacheKey);
      if (cachedToken) {
        task.status = 'solved';
        task.token = cachedToken;
        this.stats.cacheHits++;

        logger.info({ type: request.type, siteKey: request.siteKey }, 'CAPTCHA token cache hit');
        return { success: true, token: cachedToken, provider: 'capsolver', solveTimeMs: 0, cost: 0, taskId, fromCache: true };
      }

      // -- Phase 2: Check domain token reuse --
      if (request.allowTokenReuse !== false) {
        const reusedToken = this.checkDomainTokenReuse(domain, request.type);
        if (reusedToken) {
          task.status = 'solved';
          task.token = reusedToken.token;
          this.stats.tokenReuseHits++;

          logger.info({ type: request.type, domain }, 'CAPTCHA domain token reuse hit');
          return {
            success: true,
            token: reusedToken.token,
            provider: reusedToken.provider,
            solveTimeMs: 0,
            cost: 0,
            taskId,
            reusedToken: true,
          };
        }
      }

      // -- Phase 3: Pipeline slot allocation --
      const slot = this.acquirePipelineSlot();
      if (slot) {
        task.pipelinePosition = slot.id;
        task.status = 'solving';
        this.stats.pipelineSolves++;
      }

      // -- Phase 4: Select provider chain --
      const providers = this.selectProviders(request.provider, request.type, request.priority);

      // -- Phase 5: Solve with retry and failover --
      const result = await this.solveWithRetryAndFailover(request, taskId, task, providers);

      // Cache the token if solved
      if (result.success && result.token) {
        await this.cacheToken(cacheKey, result.token, request.type, request.siteKey, request.pageUrl);
        // Store in domain token cache for reuse
        this.storeDomainToken(domain, request.type, result.token, result.provider, result.cost);
      }

      // Release pipeline slot
      if (slot) this.releasePipelineSlot(slot.id);

      return result;
    } finally {
      setTimeout(() => { this.activeTasks.delete(taskId); }, 5_000);
    }
  }

  /**
   * Detect and solve CAPTCHA from a Playwright page.
   * Scans the page HTML for CAPTCHA elements and solves them.
   */
  async solveFromPage(page: any, url: string): Promise<CaptchaSolveResult | null> {
    try {
      const html = await page.content();
      if (!html) {
        logger.debug('No HTML content from page');
        return null;
      }

      const detections = this.detectCaptcha(html);
      if (detections.length === 0) {
        logger.debug({ url }, 'No CAPTCHA detected on page');
        return null;
      }

      const best = detections.reduce((a, b) => (a.confidence > b.confidence ? a : b));
      logger.info({ url, type: best.type, siteKey: best.siteKey, confidence: best.confidence }, 'CAPTCHA detected on page');

      const result = await this.solve({
        type: best.type,
        siteKey: best.siteKey,
        pageUrl: url,
        allowTokenReuse: true,
      });

      if (result.success && result.token) {
        await this.injectToken(page, result.token, best.type);
      }

      return result;
    } catch (err: any) {
      logger.error({ url, error: err.message }, 'solveFromPage failed');
      return null;
    }
  }

  // --- Detection & Extraction -- ENHANCED with 12+ types ----------------------

  detectCaptcha(html: string): DetectedCaptcha[] {
    const results: DetectedCaptcha[] = [];

    // reCAPTCHA v3 (check first, as v3 patterns are more specific)
    const recaptchaV3Key = this.extractRecaptchaV3SiteKey(html);
    if (recaptchaV3Key) {
      results.push({ type: 'recaptcha_v3', siteKey: recaptchaV3Key, confidence: 0.95 });
    } else if (this.matchesAny(html, RECAPTCHA_V3_PATTERNS)) {
      const key = this.extractGenericSiteKey(html, /render=([^&"']+)/i);
      results.push({ type: 'recaptcha_v3', siteKey: key || '', confidence: 0.7 });
    }

    // reCAPTCHA v2
    const recaptchaV2Key = this.extractRecaptchaV2SiteKey(html);
    if (recaptchaV2Key && !recaptchaV3Key) {
      results.push({ type: 'recaptcha_v2', siteKey: recaptchaV2Key, confidence: 0.95 });
    } else if (!recaptchaV3Key && this.matchesAny(html, RECAPTCHA_V2_PATTERNS)) {
      results.push({ type: 'recaptcha_v2', siteKey: recaptchaV2Key || '', confidence: 0.7 });
    }

    // hCaptcha
    const hcaptchaKey = this.extractHcaptchaSiteKey(html);
    if (hcaptchaKey) {
      results.push({ type: 'hcaptcha', siteKey: hcaptchaKey, confidence: 0.95 });
    } else if (this.matchesAny(html, HCAPTCHA_PATTERNS)) {
      results.push({ type: 'hcaptcha', siteKey: '', confidence: 0.6 });
    }

    // FunCaptcha
    const funcaptchaKey = this.extractFuncaptchaSiteKey(html);
    if (funcaptchaKey) {
      results.push({ type: 'funcaptcha', siteKey: funcaptchaKey, confidence: 0.95 });
    } else if (this.matchesAny(html, FUNCAPTCHA_PATTERNS)) {
      results.push({ type: 'funcaptcha', siteKey: '', confidence: 0.6 });
    }

    // Cloudflare Turnstile
    const turnstileKey = this.extractTurnstileSiteKey(html);
    if (turnstileKey) {
      results.push({ type: 'turnstile', siteKey: turnstileKey, confidence: 0.95 });
    } else if (this.matchesAny(html, TURNSTILE_PATTERNS)) {
      results.push({ type: 'turnstile', siteKey: '', confidence: 0.6 });
    }

    // GeeTest
    const geetestKey = this.extractGeetestSiteKey(html);
    if (geetestKey) {
      results.push({ type: 'geetest', siteKey: geetestKey, confidence: 0.9 });
    } else if (this.matchesAny(html, GEETEST_PATTERNS)) {
      results.push({ type: 'geetest', siteKey: '', confidence: 0.6 });
    }

    // Arkose Labs (distinct from FunCaptcha)
    const arkoseKey = this.extractArkoseLabsSiteKey(html);
    if (arkoseKey) {
      results.push({ type: 'arkose_labs', siteKey: arkoseKey, confidence: 0.93 });
    } else if (this.matchesAny(html, ARKOSE_LABS_PATTERNS) && !funcaptchaKey) {
      results.push({ type: 'arkose_labs', siteKey: '', confidence: 0.65 });
    }

    // AWS WAF Captcha
    const awsWafKey = this.extractAwsWafSiteKey(html);
    if (awsWafKey) {
      results.push({ type: 'aws_waf', siteKey: awsWafKey, confidence: 0.92 });
    } else if (this.matchesAny(html, AWS_WAF_PATTERNS)) {
      results.push({ type: 'aws_waf', siteKey: '', confidence: 0.7 });
    }

    // Salesforce Captcha
    const salesforceKey = this.extractSalesforceSiteKey(html);
    if (salesforceKey) {
      results.push({ type: 'salesforce', siteKey: salesforceKey, confidence: 0.88 });
    } else if (this.matchesAny(html, SALESFORCE_PATTERNS)) {
      results.push({ type: 'salesforce', siteKey: '', confidence: 0.6 });
    }

    // Cocoa Captcha
    const cocoaKey = this.extractCocoaSiteKey(html);
    if (cocoaKey) {
      results.push({ type: 'cocoa', siteKey: cocoaKey, confidence: 0.85 });
    } else if (this.matchesAny(html, COCOA_PATTERNS)) {
      results.push({ type: 'cocoa', siteKey: '', confidence: 0.6 });
    }

    // KeyCaptcha
    const keycaptchaKey = this.extractKeyCaptchaSiteKey(html);
    if (keycaptchaKey) {
      results.push({ type: 'keycaptcha', siteKey: keycaptchaKey, confidence: 0.88 });
    } else if (this.matchesAny(html, KEYCAPTCHA_PATTERNS)) {
      results.push({ type: 'keycaptcha', siteKey: '', confidence: 0.65 });
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  extractRecaptchaV2SiteKey(html: string): string | null {
    const siteKeyMatch = html.match(/data-sitekey=["']([a-zA-Z0-9_-]+)["']/i);
    if (siteKeyMatch) return siteKeyMatch[1];
    const renderMatch = html.match(/grecaptcha\.render\s*\([^)]*sitekey\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (renderMatch) return renderMatch[1];
    const apiRender = html.match(/recaptcha\/api\.js\?[^"']*render=([a-zA-Z0-9_-]+)/i);
    if (apiRender && apiRender[1] !== 'explicit') return apiRender[1];
    return null;
  }

  extractRecaptchaV3SiteKey(html: string): string | null {
    const renderMatch = html.match(/recaptcha\/api\.js\?[^"']*render=([a-zA-Z0-9_-]{40})/i);
    if (renderMatch) return renderMatch[1];
    const enterpriseRender = html.match(/recaptcha\/enterprise\.js\?[^"']*render=([a-zA-Z0-9_-]{40})/i);
    if (enterpriseRender) return enterpriseRender[1];
    return null;
  }

  extractHcaptchaSiteKey(html: string): string | null {
    const hcaptchaKeyMatch = html.match(/data-hcaptcha-sitekey=["']([a-zA-Z0-9_-]+)["']/i);
    if (hcaptchaKeyMatch) return hcaptchaKeyMatch[1];
    const siteKeyMatch = html.match(/data-sitekey=["']([a-zA-Z0-9_-]+)["']/i);
    if (siteKeyMatch && /h-captcha|hcaptcha/i.test(html)) return siteKeyMatch[1];
    const configureMatch = html.match(/hcaptcha\.configure\s*\(\s*\{[^}]*sitekey\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (configureMatch) return configureMatch[1];
    const renderMatch = html.match(/hcaptcha\.render\s*\([^)]*sitekey\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (renderMatch) return renderMatch[1];
    return null;
  }

  extractFuncaptchaSiteKey(html: string): string | null {
    const pkeyMatch = html.match(/data-pkey=["']([a-zA-Z0-9_-]+)["']/i);
    if (pkeyMatch && !/arkoselabs|arkose-enforcement/i.test(html)) return pkeyMatch[1];
    const configMatch = html.match(/public[_-]?key\s*[:=]\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (configMatch && /funcaptcha/i.test(html)) return configMatch[1];
    return null;
  }

  extractTurnstileSiteKey(html: string): string | null {
    const siteKeyMatch = html.match(/class=["'][^"']*cf-turnstile[^"']*["'][^>]*data-sitekey=["']([a-zA-Z0-9_-]+)["']/i);
    if (siteKeyMatch) return siteKeyMatch[1];
    const siteKeyMatch2 = html.match(/data-sitekey=["']([a-zA-Z0-9_-]+)["'][^>]*class=["'][^"']*cf-turnstile[^"']*["']/i);
    if (siteKeyMatch2) return siteKeyMatch2[1];
    const renderMatch = html.match(/turnstile\.render\s*\([^)]*sitekey\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (renderMatch) return renderMatch[1];
    return null;
  }

  extractGeetestSiteKey(html: string): string | null {
    const initMatch = html.match(/initGeetest\s*\(\s*\{[^}]*gt\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (initMatch) return initMatch[1];
    const gtMatch = html.match(/\bgt\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (gtMatch && /geetest/i.test(html)) return gtMatch[1];
    return null;
  }

  extractArkoseLabsSiteKey(html: string): string | null {
    const arkoseKeyMatch = html.match(/data-arkose-sitekey=["']([a-zA-Z0-9_-]+)["']/i);
    if (arkoseKeyMatch) return arkoseKeyMatch[1];
    const configMatch = html.match(/ArkoseEnforcement\.setConfig\s*\(\s*\{[^}]*publicKey\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (configMatch) return configMatch[1];
    const fcToken = html.match(/data-pkey=["']([A-Fa-f0-9-]+)["']/i);
    if (fcToken && /arkoselabs/i.test(html)) return fcToken[1];
    return null;
  }

  extractAwsWafSiteKey(html: string): string | null {
    const awsKeyMatch = html.match(/aws-waf-captcha.*?site-key=["']([a-zA-Z0-9_-]+)["']/i);
    if (awsKeyMatch) return awsKeyMatch[1];
    const puzzleMatch = html.match(/captcha_key\s*[:=]\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (puzzleMatch && /aws/i.test(html)) return puzzleMatch[1];
    const configMatch = html.match(/AwsWafCaptchaConfig\s*\(\s*\{[^}]*siteKey\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (configMatch) return configMatch[1];
    return null;
  }

  extractSalesforceSiteKey(html: string): string | null {
    const sfKeyMatch = html.match(/data-sitekey=["']([a-zA-Z0-9_-]+)["']/i);
    if (sfKeyMatch && /salesforce|force\.com|visualforce/i.test(html)) return sfKeyMatch[1];
    const configMatch = html.match(/g_recaptcha.*sitekey\s*[:=]\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (configMatch && /salesforce|force\.com/i.test(html)) return configMatch[1];
    return null;
  }

  extractCocoaSiteKey(html: string): string | null {
    const cocoaKeyMatch = html.match(/cocoa.*?sitekey=["']([a-zA-Z0-9_-]+)["']/i);
    if (cocoaKeyMatch) return cocoaKeyMatch[1];
    const configMatch = html.match(/CocoaCaptcha\.init\s*\(\s*\{[^}]*siteKey\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (configMatch) return configMatch[1];
    return null;
  }

  extractKeyCaptchaSiteKey(html: string): string | null {
    const kcMatch = html.match(/s_kcaptcha\s*[:=]\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (kcMatch) return kcMatch[1];
    const varMatch = html.match(/kcaptcha_key\s*[:=]\s*['"]([a-zA-Z0-9_-]+)['"]/i);
    if (varMatch) return varMatch[1];
    const scriptMatch = html.match(/keycaptcha\.com\/api\/script\/([a-zA-Z0-9_-]+)/i);
    if (scriptMatch) return scriptMatch[1];
    return null;
  }

  // --- Pipeline Slot Management -----------------------------------------------

  private acquirePipelineSlot(): PipelineSlot | null {
    for (const slot of this.pipelineSlots) {
      if (!slot.busy) {
        slot.busy = true;
        slot.taskId = generateTaskId();
        slot.startedAt = Date.now();
        slot.provider = null;
        return slot;
      }
    }
    return null;
  }

  private releasePipelineSlot(slotId: number): void {
    const slot = this.pipelineSlots.find(s => s.id === slotId);
    if (slot) {
      slot.busy = false;
      slot.taskId = null;
      slot.startedAt = null;
      slot.provider = null;
    }
  }

  // --- Domain Token Reuse ----------------------------------------------------

  private checkDomainTokenReuse(domain: string, type: CaptchaType): { token: string; provider: CaptchaProvider } | null {
    const cache = this.domainTokenCaches.get(domain);
    if (!cache || cache.type !== type) return null;

    let bestEntry: { token: string; solvedAt: number; provider: CaptchaProvider } | null = null;
    let bestKey: string | null = null;

    for (const [key, entry] of cache.tokens) {
      const age = (Date.now() - entry.solvedAt) / 1000;
      if (age < TOKEN_CACHE_TTL_SECONDS - TOKEN_REFRESH_BEFORE_EXPIRY_S) {
        if (!bestEntry || entry.solvedAt > bestEntry.solvedAt) {
          bestEntry = entry;
          bestKey = key;
        }
      }
    }

    if (bestEntry && bestKey) {
      // Update hit count for LRU
      const currentHits = cache.hitCounts.get(bestKey) || 0;
      cache.hitCounts.set(bestKey, currentHits + 1);
      return { token: bestEntry.token, provider: bestEntry.provider };
    }
    return null;
  }

  private storeDomainToken(domain: string, type: CaptchaType, token: string, provider: CaptchaProvider, cost: number): void {
    let cache = this.domainTokenCaches.get(domain);
    if (!cache || cache.type !== type) {
      cache = { domain, type, tokens: new Map(), hitCounts: new Map() };
      this.domainTokenCaches.set(domain, cache);
    }

    // Evict least-recently-used if at capacity
    if (cache.tokens.size >= DOMAIN_TOKEN_MAX_ENTRIES) {
      let lruKey: string | null = null;
      let lruHits = Infinity;
      let lruTime = Infinity;

      for (const [key, entry] of cache.tokens) {
        const hits = cache.hitCounts.get(key) || 0;
        // LRU: evict the one with fewest hits, then oldest
        if (hits < lruHits || (hits === lruHits && entry.solvedAt < lruTime)) {
          lruKey = key;
          lruHits = hits;
          lruTime = entry.solvedAt;
        }
      }
      if (lruKey) {
        cache.tokens.delete(lruKey);
        cache.hitCounts.delete(lruKey);
      }
    }

    const key = `${type}_${Date.now()}`;
    cache.tokens.set(key, { token, solvedAt: Date.now(), provider, cost });
    cache.hitCounts.set(key, 0);
  }

  // --- Playwright Token Injection ------------------------------------------

  async injectToken(page: any, token: string, type: CaptchaType): Promise<void> {
    try {
      switch (type) {
        case 'recaptcha_v2': await this.injectRecaptchaV2Token(page, token); break;
        case 'recaptcha_v3': await this.injectRecaptchaV3Token(page, token); break;
        case 'hcaptcha': await this.injectHcaptchaToken(page, token); break;
        case 'turnstile': await this.injectTurnstileToken(page, token); break;
        case 'funcaptcha': await this.injectFuncaptchaToken(page, token); break;
        case 'geetest': await this.injectGeetestToken(page, token); break;
        case 'arkose_labs': await this.injectFuncaptchaToken(page, token); break;
        case 'aws_waf': await this.injectAwsWafToken(page, token); break;
        case 'salesforce': await this.injectRecaptchaV2Token(page, token); break;
        case 'cocoa': await this.injectHcaptchaToken(page, token); break;
        case 'keycaptcha': await this.injectRecaptchaV2Token(page, token); break;
        case 'image':
          logger.warn('Cannot inject image CAPTCHA token -- manual input required');
          break;
        default:
          logger.warn({ type }, 'Unknown CAPTCHA type for token injection');
      }
    } catch (err: any) {
      logger.error({ type, error: err.message }, 'Failed to inject CAPTCHA token');
      throw err;
    }
  }

  private async injectRecaptchaV2Token(page: any, token: string): Promise<void> {
    await page.evaluate((t: string) => {
      const textarea = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement;
      if (textarea) { textarea.value = t; textarea.innerHTML = t; }

      const iframes = document.querySelectorAll('iframe[title*="recaptcha"]');
      iframes.forEach((iframe) => {
        try {
          const doc = (iframe as HTMLIFrameElement).contentDocument;
          if (doc) {
            const ta = doc.getElementById('g-recaptcha-response') as HTMLTextAreaElement;
            if (ta) { ta.value = t; ta.innerHTML = t; }
          }
        } catch { /* Cross-origin iframe */ }
      });

      if (typeof (window as any).___grecaptcha_cfg !== 'undefined') {
        const cfg = (window as any).___grecaptcha_cfg;
        const clients = cfg.clients || {};
        for (const [, client] of Object.entries(clients)) {
          const clientObj = client as any;
          if (clientObj?.callback) {
            try {
              if (typeof clientObj.callback === 'function') clientObj.callback(t);
              else if (typeof clientObj.callback === 'string') {
                const fn = (window as any)[clientObj.callback];
                if (typeof fn === 'function') fn(t);
              }
            } catch {}
          }
        }
      }
      if (typeof (window as any).onSubmit === 'function') (window as any).onSubmit(t);
    }, token);
    logger.debug('reCAPTCHA v2 token injected');
  }

  private async injectRecaptchaV3Token(page: any, token: string): Promise<void> {
    await page.evaluate((t: string) => {
      if (typeof (window as any).grecaptcha !== 'undefined') {
        (window as any).grecaptcha.execute = function () { return Promise.resolve(t); };
        if ((window as any).grecaptcha.ready) (window as any).grecaptcha.ready(function () {});
      }
      const hiddenInputs = document.querySelectorAll('input[name*="recaptcha"], input[name*="g-recaptcha"]');
      hiddenInputs.forEach((input) => { (input as HTMLInputElement).value = t; });
    }, token);
    logger.debug('reCAPTCHA v3 token injected');
  }

  private async injectHcaptchaToken(page: any, token: string): Promise<void> {
    await page.evaluate((t: string) => {
      const textarea = document.querySelector('textarea[name="h-captcha-response"]') as HTMLTextAreaElement;
      if (textarea) { textarea.value = t; textarea.innerHTML = t; }
      const gTextarea = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement;
      if (gTextarea) { gTextarea.value = t; gTextarea.innerHTML = t; }
      if (typeof (window as any).hcaptcha !== 'undefined') {
        try {
          const widgetIds = (window as any).hcaptcha.getAllResponses?.() || {};
          for (const [widgetId] of Object.entries(widgetIds)) {
            (window as any).hcaptcha.setResponse?.(widgetId, t);
          }
        } catch {}
        if (typeof (window as any).onSubmit === 'function') (window as any).onSubmit(t);
      }
      const captchaDiv = document.querySelector('.h-captcha[data-callback]');
      if (captchaDiv) {
        const callbackName = captchaDiv.getAttribute('data-callback');
        if (callbackName && typeof (window as any)[callbackName] === 'function') (window as any)[callbackName](t);
      }
    }, token);
    logger.debug('hCaptcha token injected');
  }

  private async injectTurnstileToken(page: any, token: string): Promise<void> {
    await page.evaluate((t: string) => {
      const inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name="g-recaptcha-response"]');
      inputs.forEach((input) => { (input as HTMLInputElement).value = t; });
      if (typeof (window as any).turnstile !== 'undefined') {
        try {
          const widgetIds = (window as any).turnstile._widgetIds || [];
          for (const widgetId of widgetIds) {
            const container = document.querySelector(`[data-turnstile-widget-id="${widgetId}"]`);
            if (container) {
              const callbackName = container.getAttribute('data-callback');
              if (callbackName && typeof (window as any)[callbackName] === 'function') (window as any)[callbackName](t);
            }
          }
        } catch {}
      }
      if (typeof (window as any).onTurnstileCallback === 'function') (window as any).onTurnstileCallback(t);
    }, token);
    logger.debug('Turnstile token injected');
  }

  private async injectFuncaptchaToken(page: any, token: string): Promise<void> {
    await page.evaluate((t: string) => {
      const inputs = document.querySelectorAll('input[name="fc-token"], input[name="funcaptcha-token"]');
      inputs.forEach((input) => { (input as HTMLInputElement).value = t; });
      if (typeof (window as any).ArkoseEnforcement !== 'undefined') {
        try { (window as any).ArkoseEnforcement.onSuccess?.(t); } catch {}
      }
    }, token);
    logger.debug('FunCaptcha/Arkose token injected');
  }

  private async injectGeetestToken(page: any, token: string): Promise<void> {
    await page.evaluate((t: string) => {
      const inputs = document.querySelectorAll('input[name="geetest_validate"], input[name="geetest_seccode"]');
      inputs.forEach((input) => { (input as HTMLInputElement).value = t; });
      if (typeof (window as any).geetestResult !== 'undefined') {
        try { (window as any).geetestResult(t); } catch {}
      }
    }, token);
    logger.debug('GeeTest token injected');
  }

  private async injectAwsWafToken(page: any, token: string): Promise<void> {
    await page.evaluate((t: string) => {
      const inputs = document.querySelectorAll('input[name="captchaToken"], input[name="aws-waf-token"]');
      inputs.forEach((input) => { (input as HTMLInputElement).value = t; });
      if (typeof (window as any).AwsWafCaptchaCallback === 'function') {
        (window as any).AwsWafCaptchaCallback(t);
      }
    }, token);
    logger.debug('AWS WAF CAPTCHA token injected');
  }

  // --- Batch Solving -- up to 50 concurrent ------------------------------------

  async solveBatch(
    requests: CaptchaSolveRequest[],
    maxConcurrency: number = MAX_BATCH_CONCURRENCY
  ): Promise<CaptchaSolveResult[]> {
    const orderedResults: CaptchaSolveResult[] = new Array(requests.length);

    logger.info({ total: requests.length, concurrency: maxConcurrency }, 'Starting batch CAPTCHA solve -- REACTOR OVERDRIVE');

    const processItem = async (index: number): Promise<void> => {
      try {
        orderedResults[index] = await this.solve(requests[index]);
      } catch (err: any) {
        orderedResults[index] = {
          success: false,
          provider: requests[index].provider || 'capsolver',
          solveTimeMs: 0,
          cost: 0,
          taskId: `batch_error_${index}`,
          error: err.message,
        };
      }
    };

    // Pipelined batch execution
    for (let batchStart = 0; batchStart < requests.length; batchStart += maxConcurrency) {
      const batchEnd = Math.min(batchStart + maxConcurrency, requests.length);
      const batchPromises: Promise<void>[] = [];

      for (let i = batchStart; i < batchEnd; i++) {
        batchPromises.push(processItem(i));
      }

      await Promise.allSettled(batchPromises);
    }

    const solvedCount = orderedResults.filter((r) => r?.success).length;
    const failedCount = orderedResults.filter((r) => r && !r.success).length;

    logger.info({ total: requests.length, solved: solvedCount, failed: failedCount }, 'Batch CAPTCHA solve complete');

    return orderedResults;
  }

  // --- Solver Intelligence ----------------------------------------------------

  private updateIntelligence(type: CaptchaType, provider: CaptchaProvider, solveTimeMs: number, success: boolean): void {
    const key = `${provider}:${type}`;
    const existing = this.intelligence.get(key);

    if (existing) {
      const totalSamples = existing.sampleCount + 1;
      const newAvgTime = Math.round((existing.avgSolveTimeMs * existing.sampleCount + solveTimeMs) / totalSamples);
      const newSuccessRate = (existing.successRate * existing.sampleCount + (success ? 1 : 0)) / totalSamples;

      // Update EMA solve time
      const newEmaTime = Math.round(
        INTELLIGENCE_EMA_ALPHA * solveTimeMs + (1 - INTELLIGENCE_EMA_ALPHA) * existing.emaSolveTimeMs
      );

      // Track recent solve times
      const recentTimes = [...existing.recentSolveTimes, solveTimeMs];
      if (recentTimes.length > INTELLIGENCE_RECENT_SOLVE_TIMES_MAX) {
        recentTimes.shift();
      }

      this.intelligence.set(key, {
        provider,
        type,
        avgSolveTimeMs: newAvgTime,
        successRate: newSuccessRate,
        sampleCount: totalSamples,
        lastUpdated: Date.now(),
        emaSolveTimeMs: newEmaTime,
        peakSolveTimeMs: Math.max(existing.peakSolveTimeMs, solveTimeMs),
        minSolveTimeMs: Math.min(existing.minSolveTimeMs, solveTimeMs),
        recentSolveTimes: recentTimes,
      });
    } else {
      this.intelligence.set(key, {
        provider,
        type,
        avgSolveTimeMs: solveTimeMs,
        successRate: success ? 1 : 0,
        sampleCount: 1,
        lastUpdated: Date.now(),
        emaSolveTimeMs: solveTimeMs,
        peakSolveTimeMs: solveTimeMs,
        minSolveTimeMs: solveTimeMs,
        recentSolveTimes: [solveTimeMs],
      });
    }
  }

  private getIntelligenceBestProvider(type: CaptchaType): CaptchaProvider | null {
    let bestProvider: CaptchaProvider | null = null;
    let bestScore = -1;

    for (const [, entry] of this.intelligence) {
      if (entry.type === type && entry.sampleCount >= INTELLIGENCE_MIN_SAMPLES) {
        // Score = weighted combination: success rate (70%) + speed (30%)
        // Use EMA for more responsive speed scoring
        const speedScore = 1 - Math.min(entry.emaSolveTimeMs / 60000, 1);
        const combinedScore = entry.successRate * 0.7 + speedScore * 0.3;
        if (combinedScore > bestScore) {
          bestScore = combinedScore;
          bestProvider = entry.provider;
        }
      }
    }

    return bestProvider;
  }

  /**
   * Get the P95 solve time for a provider+type combination.
   * Uses the recent solve times array for percentile calculation.
   */
  getIntelligenceP95(type: CaptchaType, provider: CaptchaProvider): number | null {
    const key = `${provider}:${type}`;
    const entry = this.intelligence.get(key);
    if (!entry || entry.recentSolveTimes.length < 3) return null;

    const sorted = [...entry.recentSolveTimes].sort((a, b) => a - b);
    const p95Index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.min(p95Index, sorted.length - 1)];
  }

  // --- Statistics -----------------------------------------------------------

  async getStats(): Promise<CaptchaSolverStats> {
    const providerHealthMap: Record<CaptchaProvider, ProviderHealth> = {
      '2captcha': this.twoCaptcha.getHealth(),
      capsolver: this.capSolver.getHealth(),
      'anti-captcha': this.antiCaptcha.getHealth(),
      capmonster: this.capMonster.getHealth(),
      nocaptchaai: this.noCaptchaAI.getHealth(),
    };

    const totalAttempts = this.stats.totalSolved + this.stats.totalFailed;
    const avgSolveTimeMs = totalAttempts > 0 ? Math.round(this.stats.totalSolveTimeMs / totalAttempts) : 0;
    const successRate = totalAttempts > 0 ? this.stats.totalSolved / totalAttempts : 0;

    let tokenCacheSize = 0;
    try {
      const keys = await redis.keys('cache:captcha:*');
      tokenCacheSize = keys.length;
    } catch {}

    const byType: Record<CaptchaType, { solved: number; failed: number; avgTime: number; cost: number }> = {} as any;
    for (const [type, data] of Object.entries(this.stats.byType)) {
      const total = data.solved + data.failed;
      byType[type as CaptchaType] = {
        solved: data.solved,
        failed: data.failed,
        avgTime: total > 0 ? Math.round(data.totalSolveTimeMs / total) : 0,
        cost: data.cost,
      };
    }

    const byProvider: Record<CaptchaProvider, { solved: number; failed: number; avgTime: number; cost: number; healthScore: number }> = {} as any;
    for (const [provider, data] of Object.entries(this.stats.byProvider)) {
      const total = data.solved + data.failed;
      const health = providerHealthMap[provider as CaptchaProvider];
      byProvider[provider as CaptchaProvider] = {
        solved: data.solved,
        failed: data.failed,
        avgTime: total > 0 ? Math.round(data.totalSolveTimeMs / total) : 0,
        cost: data.cost,
        healthScore: health?.healthScore ?? 0,
      };
    }

    // Solver intelligence summary
    const solverIntelligence: Record<CaptchaType, { bestProvider: CaptchaProvider; avgTime: number; successRate: number }> = {} as any;
    for (const type of ALL_CAPTCHA_TYPES) {
      const best = this.getIntelligenceBestProvider(type);
      const bestEntry = best ? this.intelligence.get(`${best}:${type}`) : null;
      solverIntelligence[type] = {
        bestProvider: best || 'capsolver',
        avgTime: bestEntry?.emaSolveTimeMs ?? 0,
        successRate: bestEntry?.successRate ?? 0,
      };
    }

    // Count prewarmed sessions
    let prewarmedSessions = 0;
    for (const [, sessions] of this.prewarmSessions) {
      prewarmedSessions += sessions.filter(s => s.isActive && s.validated).length;
    }

    return {
      totalSolved: this.stats.totalSolved,
      totalFailed: this.stats.totalFailed,
      totalCost: this.stats.totalCost,
      avgSolveTimeMs,
      successRate,
      cacheHits: this.stats.cacheHits,
      tokenReuseHits: this.stats.tokenReuseHits,
      pipelineSolves: this.stats.pipelineSolves,
      byType,
      byProvider,
      solverIntelligence,
      tokenCacheSize,
      activeSolves: this.activeTasks.size,
      prewarmedSessions,
    };
  }

  async getBalances(): Promise<Record<CaptchaProvider, number>> {
    const balances: Record<CaptchaProvider, number> = {
      '2captcha': 0,
      capsolver: 0,
      'anti-captcha': 0,
      capmonster: 0,
      nocaptchaai: 0,
    };

    const balancePromises: Promise<void>[] = [];

    if (this.twoCaptcha.isConfigured) {
      balancePromises.push(this.twoCaptcha.getBalance().then(b => { balances['2captcha'] = b; }).catch(() => { balances['2captcha'] = -1; }));
    }
    if (this.capSolver.isConfigured) {
      balancePromises.push(this.capSolver.getBalance().then(b => { balances.capsolver = b; }).catch(() => { balances.capsolver = -1; }));
    }
    if (this.antiCaptcha.isConfigured) {
      balancePromises.push(this.antiCaptcha.getBalance().then(b => { balances['anti-captcha'] = b; }).catch(() => { balances['anti-captcha'] = -1; }));
    }
    if (this.capMonster.isConfigured) {
      balancePromises.push(this.capMonster.getBalance().then(b => { balances.capmonster = b; }).catch(() => { balances.capmonster = -1; }));
    }
    if (this.noCaptchaAI.isConfigured) {
      balancePromises.push(this.noCaptchaAI.getBalance().then(b => { balances.nocaptchaai = b; }).catch(() => { balances.nocaptchaai = -1; }));
    }

    await Promise.allSettled(balancePromises);
    return balances;
  }

  get isConfigured(): boolean {
    return this.twoCaptcha.isConfigured || this.capSolver.isConfigured ||
           this.antiCaptcha.isConfigured || this.capMonster.isConfigured ||
           this.noCaptchaAI.isConfigured;
  }

  get availableProviders(): CaptchaProvider[] {
    const providers: CaptchaProvider[] = [];
    if (this.noCaptchaAI.isConfigured) providers.push('nocaptchaai');
    if (this.capMonster.isConfigured) providers.push('capmonster');
    if (this.capSolver.isConfigured) providers.push('capsolver');
    if (this.antiCaptcha.isConfigured) providers.push('anti-captcha');
    if (this.twoCaptcha.isConfigured) providers.push('2captcha');
    return providers;
  }

  // --- Private Methods -----------------------------------------------------

  private validateRequest(request: CaptchaSolveRequest): void {
    if (!request.pageUrl) throw new Error('pageUrl is required');
    if (!request.siteKey && request.type !== 'image') throw new Error(`siteKey is required for ${request.type} CAPTCHAs`);
    if (request.type === 'image' && !request.imageData) throw new Error('imageData (base64) is required for image CAPTCHAs');
    if (request.type === 'recaptcha_v3' && request.minScore !== undefined) {
      if (request.minScore < 0 || request.minScore > 1) throw new Error('minScore must be between 0 and 1 for reCAPTCHA v3');
    }
  }

  /**
   * Select providers to try, ordered by the chosen priority strategy.
   * Enhanced with circuit breaker awareness and EMA-based intelligence.
   */
  private selectProviders(forceProvider?: CaptchaProvider, type?: CaptchaType, priority?: 'cost' | 'speed' | 'quality'): CaptchaProvider[] {
    if (forceProvider) {
      const impl = this.providerMap.get(forceProvider);
      if (!impl || !impl.isConfigured) {
        throw new Error(`${forceProvider} provider requested but not configured`);
      }
      return [forceProvider];
    }

    const configuredProviders: { provider: CaptchaProvider; score: number }[] = [];

    // Check intelligence first if no explicit priority
    const intelligenceBest = type ? this.getIntelligenceBestProvider(type) : null;

    for (const [providerName, impl] of this.providerMap) {
      if (!impl.isConfigured) continue;

      const health = impl.getHealth();

      // Skip providers with open circuit breakers
      if (isCircuitBreakerOpen(health)) {
        logger.debug({ provider: providerName }, 'Skipping provider -- circuit breaker open');
        continue;
      }

      let score = 0;

      switch (priority || 'cost') {
        case 'cost':
          const cost = type ? (PROVIDER_COSTS[providerName]?.[type] ?? 0.01) : 0.01;
          // Adjusted cost: penalize by health (unreliable providers cost more in retries)
          const adjustedCost = cost / Math.max(health.healthScore, 0.1);
          score = 1 - adjustedCost;
          break;
        case 'speed':
          const intelKey = `${providerName}:${type}`;
          const intelEntry = type ? this.intelligence.get(intelKey) : null;
          if (intelEntry && intelEntry.sampleCount >= INTELLIGENCE_MIN_SAMPLES) {
            // Use EMA for more responsive speed ranking
            score = 1 - Math.min(intelEntry.emaSolveTimeMs / 60000, 1);
          } else {
            score = health.healthScore;
          }
          break;
        case 'quality':
          // Quality = health score weighted by recent success rate
          score = health.healthScore * 0.6 + health.recentSuccessRate * 0.4;
          break;
      }

      // Boost intelligence-best provider
      if (intelligenceBest === providerName) {
        score += 0.25;
      }

      // Penalize providers with low capacity
      if (!impl.canAcceptMore) {
        score -= 0.5;
      }

      configuredProviders.push({ provider: providerName, score });
    }

    configuredProviders.sort((a, b) => b.score - a.score);
    return configuredProviders.map((c) => c.provider);
  }

  /**
   * Attempt solving with retry logic and provider failover chain.
   * Enhanced with circuit breaker awareness and better error categorization.
   */
  private async solveWithRetryAndFailover(
    request: CaptchaSolveRequest,
    taskId: string,
    task: CaptchaTask,
    providers: CaptchaProvider[]
  ): Promise<CaptchaSolveResult> {
    if (providers.length === 0) {
      const errResult: CaptchaSolveResult = {
        success: false, provider: 'capsolver', solveTimeMs: 0, cost: 0, taskId,
        error: 'No CAPTCHA providers configured. Set at least one API key.',
      };
      await this.logToDb(task, errResult);
      this.updateStats(task.type, errResult);
      return errResult;
    }

    let lastError: string | undefined = undefined;

    for (const provider of providers) {
      const impl = this.providerMap.get(provider);
      if (!impl || !impl.isConfigured) continue;

      // Skip providers with open circuit breakers
      const health = impl.getHealth();
      if (isCircuitBreakerOpen(health)) {
        logger.warn({ provider }, 'Provider circuit breaker open, skipping in failover chain');
        continue;
      }

      // Skip providers that can't accept more requests
      if (!impl.canAcceptMore) {
        logger.warn({ provider }, 'Provider at max capacity, skipping in failover chain');
        continue;
      }

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        task.provider = provider;
        task.status = 'solving';

        try {
          const result = await impl.solve(request, taskId);
          task.status = 'solved';
          task.token = result.token;
          task.solveTimeMs = result.solveTimeMs;
          task.cost = result.cost;
          task.solvedAt = Date.now();

          await this.logToDb(task, result);
          this.updateStats(task.type, result);
          this.updateIntelligence(task.type, provider, result.solveTimeMs, true);

          logger.info({ provider, type: request.type, solveTimeMs: result.solveTimeMs, cost: result.cost, attempt }, 'CAPTCHA solved -- reactor nominal');
          return result;
        } catch (err: any) {
          lastError = err.message ?? String(err);
          task.error = lastError;

          logger.warn({ provider, type: request.type, attempt, maxRetries: MAX_RETRIES, error: err.message }, 'CAPTCHA solve attempt failed -- reactor retrying');

          this.updateIntelligence(task.type, provider, Date.now() - task.createdAt, false);

          if (attempt < MAX_RETRIES - 1) {
            const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
            await sleep(backoff);
          }
        }
      }

      // Provider exhausted, try next in failover chain
      const nextIdx = providers.indexOf(provider) + 1;
      if (nextIdx < providers.length) {
        logger.info(
          { failedProvider: provider, nextProvider: providers[nextIdx] },
          'Switching to alternate CAPTCHA provider -- failover chain activated'
        );
      }
    }

    // All providers failed -- reactor meltdown
    task.status = 'failed';
    task.error = lastError || 'All providers failed';

    const failResult: CaptchaSolveResult = {
      success: false,
      provider: providers[providers.length - 1],
      solveTimeMs: 0,
      cost: 0,
      taskId,
      error: lastError || 'All CAPTCHA providers failed -- reactor meltdown',
    };

    await this.logToDb(task, failResult);
    this.updateStats(task.type, failResult);

    logger.error({ type: request.type, providers: providers.join(','), error: lastError }, 'All CAPTCHA providers failed -- reactor meltdown');

    return failResult;
  }

  /**
   * Check Redis cache for a previously solved token.
   * Enhanced with refresh-before-expiry triggering.
   */
  private async checkCache(cacheKey: string): Promise<string | null> {
    try {
      const cached = await cacheGet<CacheEntry>(cacheKey);
      if (cached && cached.token) {
        const age = (Date.now() - cached.solvedAt) / 1000;
        if (age < TOKEN_CACHE_TTL_SECONDS) {
          // Trigger background refresh if token is approaching expiry
          if (age > TOKEN_CACHE_TTL_SECONDS - TOKEN_REFRESH_BEFORE_EXPIRY_S) {
            logger.info({ cacheKey, age: Math.round(age) }, 'CAPTCHA token approaching expiry -- triggering background refresh');
            this.triggerBackgroundRefresh(cacheKey).catch(() => {});
          }
          return cached.token;
        }
        // Token expired, remove from cache
        await redis.del(`cache:${cacheKey}`);
      }
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Cache check failed (Redis may be unavailable)');
    }
    return null;
  }

  /**
   * Trigger a background refresh of an about-to-expire token.
   * This is fire-and-forget -- the current request still uses the cached token.
   */
  private async triggerBackgroundRefresh(cacheKey: string): Promise<void> {
    try {
      // Extract request info from cache key format: captcha:{type}:{siteKey}:{pageUrl}
      const parts = cacheKey.split(':');
      if (parts.length < 4) return;

      const type = parts[1] as CaptchaType;
      const siteKey = parts[2];
      const pageUrl = parts.slice(3).join(':');

      const result = await this.solve({
        type,
        siteKey,
        pageUrl,
        allowTokenReuse: false,
        priority: 'speed',
      });

      if (result.success && result.token) {
        await this.cacheToken(cacheKey, result.token, type, siteKey, pageUrl);
        this.stats.backgroundRefreshes++;
        logger.info({ type, siteKey }, 'Background token refresh successful');
      }
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Background token refresh failed');
    }
  }

  private async cacheToken(cacheKey: string, token: string, type: CaptchaType, siteKey: string, pageUrl: string): Promise<void> {
    try {
      const entry: CacheEntry = { token, solvedAt: Date.now(), provider: 'capsolver', type, siteKey, pageUrl, refreshCount: 0 };
      await cacheSet(cacheKey, entry, TOKEN_CACHE_TTL_SECONDS);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Failed to cache token');
    }
  }

  private buildCacheKey(request: CaptchaSolveRequest): string {
    return `captcha:${request.type}:${request.siteKey}:${request.pageUrl}`;
  }

  private async logToDb(task: CaptchaTask, result: CaptchaSolveResult): Promise<void> {
    try {
      await db.captchaLog.create({
        data: {
          id: crypto.randomUUID(),
          domain: task.domain,
          captchaType: CAPTCHA_TYPE_MAP_TO_PRISMA[task.type] as any,
          provider: result.provider,
          siteKey: task.siteKey,
          solved: result.success,
          solveTimeMs: result.solveTimeMs,
          cost: result.cost,
          token: result.success && result.token ? result.token.substring(0, 50) + '...' : null,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to log CAPTCHA solve to database');
    }
  }

  private updateStats(type: CaptchaType, result: CaptchaSolveResult): void {
    if (result.success) {
      this.stats.totalSolved++;
      this.stats.totalSolveTimeMs += result.solveTimeMs;
      this.stats.totalCost += result.cost;
      this.stats.byType[type].solved++;
      this.stats.byType[type].totalSolveTimeMs += result.solveTimeMs;
      this.stats.byType[type].cost += result.cost;
      this.stats.byProvider[result.provider].solved++;
      this.stats.byProvider[result.provider].totalSolveTimeMs += result.solveTimeMs;
      this.stats.byProvider[result.provider].cost += result.cost;
    } else {
      this.stats.totalFailed++;
      this.stats.byType[type].failed++;
      this.stats.byProvider[result.provider].failed++;
    }
  }

  private matchesAny(html: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(html));
  }

  private extractGenericSiteKey(html: string, pattern: RegExp): string | null {
    const match = html.match(pattern);
    return match ? match[1] : null;
  }

  resetStats(): void {
    this.stats = {
      totalSolved: 0,
      totalFailed: 0,
      totalSolveTimeMs: 0,
      totalCost: 0,
      cacheHits: 0,
      tokenReuseHits: 0,
      pipelineSolves: 0,
      backgroundRefreshes: 0,
      circuitBreakerTrips: 0,
      byType: {} as Record<CaptchaType, { solved: number; failed: number; totalSolveTimeMs: number; cost: number }>,
      byProvider: {} as Record<CaptchaProvider, { solved: number; failed: number; totalSolveTimeMs: number; cost: number }>,
    };

    for (const type of ALL_CAPTCHA_TYPES) {
      this.stats.byType[type] = { solved: 0, failed: 0, totalSolveTimeMs: 0, cost: 0 };
    }
    for (const provider of ALL_PROVIDERS) {
      this.stats.byProvider[provider] = { solved: 0, failed: 0, totalSolveTimeMs: 0, cost: 0 };
    }

    this.intelligence.clear();
    this.domainTokenCaches.clear();

    logger.info('CAPTCHA solver statistics reset -- reactor cores cleared');
  }

  // --- Token Validation & Verification --------------------------------------

  validateToken(token: string, type: CaptchaType): { valid: boolean; reason?: string } {
    if (!token || token.trim().length === 0) {
      return { valid: false, reason: 'Token is empty' };
    }

    switch (type) {
      case 'recaptcha_v2':
      case 'recaptcha_v3':
        if (token.length < 100) {
          return { valid: false, reason: `reCAPTCHA token too short (${token.length} chars, expected 100+)` };
        }
        if (!/^[A-Za-z0-9_-]+$/.test(token)) {
          return { valid: false, reason: 'reCAPTCHA token contains invalid characters' };
        }
        break;

      case 'hcaptcha':
        if (token.length < 80) {
          return { valid: false, reason: `hCaptcha token too short (${token.length} chars, expected 80+)` };
        }
        if (!/^[A-Za-z0-9_-]+$/.test(token)) {
          return { valid: false, reason: 'hCaptcha token contains invalid characters' };
        }
        break;

      case 'turnstile':
        if (token.length < 50) {
          return { valid: false, reason: `Turnstile token too short (${token.length} chars, expected 50+)` };
        }
        break;

      case 'funcaptcha':
      case 'arkose_labs':
        if (token.length < 100) {
          return { valid: false, reason: `FunCaptcha token too short (${token.length} chars, expected 100+)` };
        }
        break;

      case 'geetest':
        if (token.length < 20) {
          return { valid: false, reason: `GeeTest token too short (${token.length} chars, expected 20+)` };
        }
        break;

      case 'aws_waf':
        if (token.length < 50) {
          return { valid: false, reason: `AWS WAF token too short (${token.length} chars)` };
        }
        break;

      case 'salesforce':
        if (token.length < 50) {
          return { valid: false, reason: `Salesforce token too short (${token.length} chars)` };
        }
        break;

      case 'cocoa':
        if (token.length < 30) {
          return { valid: false, reason: `Cocoa token too short (${token.length} chars)` };
        }
        break;

      case 'keycaptcha':
        if (token.length < 30) {
          return { valid: false, reason: `KeyCaptcha token too short (${token.length} chars)` };
        }
        break;

      case 'image':
        if (token.length < 1) {
          return { valid: false, reason: 'Image CAPTCHA solution is empty' };
        }
        break;

      default:
        if (token.length < 10) {
          return { valid: false, reason: 'Token too short for unknown type' };
        }
        break;
    }

    return { valid: true };
  }

  // --- Cost Optimization Engine ----------------------------------------------

  getCheapestProvider(type: CaptchaType): { provider: CaptchaProvider; cost: number } | null {
    let cheapest: { provider: CaptchaProvider; cost: number } | null = null;

    for (const [providerName, impl] of this.providerMap) {
      if (!impl.isConfigured) continue;

      const health = impl.getHealth();
      if (health.healthScore < 0.3) continue; // Skip unhealthy providers
      if (isCircuitBreakerOpen(health)) continue; // Skip tripped providers

      const cost = PROVIDER_COSTS[providerName]?.[type] ?? 0.01;
      const adjustedCost = cost / health.healthScore; // Penalize by health

      if (!cheapest || adjustedCost < cheapest.cost) {
        cheapest = { provider: providerName, cost: adjustedCost };
      }
    }

    return cheapest;
  }

  getFastestProvider(type: CaptchaType): { provider: CaptchaProvider; avgTimeMs: number } | null {
    let fastest: { provider: CaptchaProvider; avgTimeMs: number } | null = null;

    for (const [, entry] of this.intelligence) {
      if (entry.type !== type || entry.sampleCount < INTELLIGENCE_MIN_SAMPLES) continue;

      // Use EMA for more current speed estimate
      if (!fastest || entry.emaSolveTimeMs < fastest.avgTimeMs) {
        fastest = { provider: entry.provider, avgTimeMs: entry.emaSolveTimeMs };
      }
    }

    return fastest;
  }

  compareProviders(type: CaptchaType, priority: 'cost' | 'speed' | 'quality' = 'cost'): Array<{
    provider: CaptchaProvider;
    cost: number;
    avgTimeMs: number;
    healthScore: number;
    recentSuccessRate: number;
    score: number;
  }> {
    const comparisons: Array<{
      provider: CaptchaProvider;
      cost: number;
      avgTimeMs: number;
      healthScore: number;
      recentSuccessRate: number;
      score: number;
    }> = [];

    for (const [providerName, impl] of this.providerMap) {
      if (!impl.isConfigured) continue;

      const health = impl.getHealth();
      const cost = PROVIDER_COSTS[providerName]?.[type] ?? 0.01;

      const intelKey = `${providerName}:${type}`;
      const intel = this.intelligence.get(intelKey);
      const avgTimeMs = intel?.emaSolveTimeMs ?? health.avgLatencyMs;

      let score = 0;
      switch (priority) {
        case 'cost':
          const adjustedCost = cost / Math.max(health.healthScore, 0.1);
          score = 1 - (adjustedCost * 100);
          break;
        case 'speed':
          score = 1 - Math.min(avgTimeMs / 60000, 1);
          break;
        case 'quality':
          score = health.healthScore * 0.6 + health.recentSuccessRate * 0.4;
          break;
      }

      comparisons.push({
        provider: providerName,
        cost,
        avgTimeMs,
        healthScore: health.healthScore,
        recentSuccessRate: health.recentSuccessRate,
        score,
      });
    }

    comparisons.sort((a, b) => b.score - a.score);
    return comparisons;
  }

  // --- Real-time Monitoring --------------------------------------------------

  getProviderHealthSnapshot(): Record<CaptchaProvider, {
    healthy: boolean;
    healthScore: number;
    avgLatencyMs: number;
    activeSolves: number;
    canAcceptMore: boolean;
    balance: number;
    lastBalanceCheck: number;
    circuitBreakerTripped: boolean;
    recentSuccessRate: number;
  }> {
    const snapshot: Record<string, any> = {};

    for (const [providerName, impl] of this.providerMap) {
      const health = impl.getHealth();
      snapshot[providerName] = {
        healthy: impl.isConfigured && health.healthScore >= 0.5 && !isCircuitBreakerOpen(health),
        healthScore: health.healthScore,
        avgLatencyMs: health.avgLatencyMs,
        activeSolves: impl.isConfigured ? (impl as any).activeSolves || 0 : 0,
        canAcceptMore: impl.canAcceptMore,
        balance: -1,
        lastBalanceCheck: health.lastBalanceCheck,
        circuitBreakerTripped: health.circuitBreakerTripped,
        recentSuccessRate: health.recentSuccessRate,
      };
    }

    return snapshot as Record<CaptchaProvider, {
      healthy: boolean;
      healthScore: number;
      avgLatencyMs: number;
      activeSolves: number;
      canAcceptMore: boolean;
      balance: number;
      lastBalanceCheck: number;
      circuitBreakerTripped: boolean;
      recentSuccessRate: number;
    }>;
  }

  getIntelligenceReport(type: CaptchaType): {
    bestProvider: CaptchaProvider | null;
    cheapestProvider: CaptchaProvider | null;
    fastestProvider: CaptchaProvider | null;
    providerDetails: Array<{
      provider: CaptchaProvider;
      avgSolveTimeMs: number;
      emaSolveTimeMs: number;
      p95SolveTimeMs: number | null;
      successRate: number;
      sampleCount: number;
      cost: number;
    }>;
  } {
    const best = this.getIntelligenceBestProvider(type);
    const cheapest = this.getCheapestProvider(type);
    const fastest = this.getFastestProvider(type);

    const providerDetails: Array<{
      provider: CaptchaProvider;
      avgSolveTimeMs: number;
      emaSolveTimeMs: number;
      p95SolveTimeMs: number | null;
      successRate: number;
      sampleCount: number;
      cost: number;
    }> = [];

    for (const [providerName, impl] of this.providerMap) {
      if (!impl.isConfigured) continue;

      const intelKey = `${providerName}:${type}`;
      const intel = this.intelligence.get(intelKey);
      const health = impl.getHealth();
      const p95 = this.getIntelligenceP95(type, providerName);

      providerDetails.push({
        provider: providerName,
        avgSolveTimeMs: intel?.avgSolveTimeMs ?? health.avgLatencyMs,
        emaSolveTimeMs: intel?.emaSolveTimeMs ?? health.avgLatencyMs,
        p95SolveTimeMs: p95,
        successRate: intel?.successRate ?? (health.solved / Math.max(health.solved + health.failed, 1)),
        sampleCount: intel?.sampleCount ?? 0,
        cost: PROVIDER_COSTS[providerName]?.[type] ?? 0.01,
      });
    }

    return {
      bestProvider: best,
      cheapestProvider: cheapest?.provider ?? null,
      fastestProvider: fastest?.provider ?? null,
      providerDetails,
    };
  }

  estimateBatchCost(requests: CaptchaSolveRequest[]): {
    totalEstimatedCost: number;
    byType: Record<CaptchaType, { count: number; estimatedCost: number }>;
    cheapestTotalCost: number;
    recommendedProvider: CaptchaProvider;
  } {
    const byType: Record<string, { count: number; estimatedCost: number }> = {};
    let totalEstimatedCost = 0;
    let cheapestTotalCost = 0;

    for (const req of requests) {
      if (!byType[req.type]) {
        byType[req.type] = { count: 0, estimatedCost: 0 };
      }
      byType[req.type].count++;

      const defaultCost = PROVIDER_COSTS.capsolver[req.type] ?? 0.002;
      byType[req.type].estimatedCost += defaultCost;
      totalEstimatedCost += defaultCost;

      let cheapestForType = defaultCost;
      for (const [providerName, costs] of Object.entries(PROVIDER_COSTS)) {
        const providerImpl = this.providerMap.get(providerName as CaptchaProvider);
        if (providerImpl && providerImpl.isConfigured) {
          const cost = costs[req.type] ?? 0.01;
          if (cost < cheapestForType) cheapestForType = cost;
        }
      }
      cheapestTotalCost += cheapestForType;
    }

    const cheapest = this.getCheapestProvider(
      requests.length > 0 ? requests[0].type : 'recaptcha_v2'
    );

    return {
      totalEstimatedCost: Math.round(totalEstimatedCost * 10000) / 10000,
      byType: byType as Record<CaptchaType, { count: number; estimatedCost: number }>,
      cheapestTotalCost: Math.round(cheapestTotalCost * 10000) / 10000,
      recommendedProvider: cheapest?.provider ?? 'capsolver',
    };
  }

  // --- Pipeline Status ------------------------------------------------------

  getPipelineStatus(): Array<{
    id: number;
    busy: boolean;
    taskId: string | null;
    durationMs: number | null;
    provider: CaptchaProvider | null;
  }> {
    const now = Date.now();
    return this.pipelineSlots.map(slot => ({
      id: slot.id,
      busy: slot.busy,
      taskId: slot.taskId,
      durationMs: slot.startedAt ? now - slot.startedAt : null,
      provider: slot.provider,
    }));
  }

  getDomainTokenCacheStatus(): Array<{
    domain: string;
    type: CaptchaType;
    tokenCount: number;
    oldestTokenAge: number;
    newestTokenAge: number;
    totalHits: number;
  }> {
    const now = Date.now();
    const status: Array<{
      domain: string;
      type: CaptchaType;
      tokenCount: number;
      oldestTokenAge: number;
      newestTokenAge: number;
      totalHits: number;
    }> = [];

    for (const [, cache] of this.domainTokenCaches) {
      let oldestAge = 0;
      let newestAge = Infinity;
      let totalHits = 0;

      for (const [key, entry] of cache.tokens) {
        const age = now - entry.solvedAt;
        if (age > oldestAge) oldestAge = age;
        if (age < newestAge) newestAge = age;
        totalHits += cache.hitCounts.get(key) || 0;
      }

      status.push({
        domain: cache.domain,
        type: cache.type,
        tokenCount: cache.tokens.size,
        oldestTokenAge: Math.round(oldestAge / 1000),
        newestTokenAge: newestAge === Infinity ? 0 : Math.round(newestAge / 1000),
        totalHits,
      });
    }

    return status;
  }

  /**
   * Clean up resources on shutdown.
   */
  destroy(): void {
    if (this.expiringSweepTimer) {
      clearInterval(this.expiringSweepTimer);
      this.expiringSweepTimer = null;
    }
    logger.info('CAPTCHA Solver REACTOR CORE destroyed -- all reactors offline');
  }
}

// --- Singleton Export ---------------------------------------------------------

export const captchaSolver = new CaptchaSolver();
