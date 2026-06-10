/**
 * Bot Detection Evader — ScrapeSuite Engine
 *
 * Evades Google's bot detection mechanisms on YouTube.
 * Google employs a multi-layered anti-bot system:
 *   - "Unusual traffic" interstitial pages
 *   - reCAPTCHA Enterprise (risk-based challenges)
 *   - Rate limiting via HTTP 429 + Retry-After headers
 *   - Consent/cookie walls (GDPR CONSENT, SOCS)
 *   - Behavioral fingerprinting (request patterns, timing)
 *   - Device fingerprint correlation (TLS JA3, canvas, WebGL)
 *   - Visitor tracking (_visitor_key, visitorData)
 *
 * This module detects bot signals and generates appropriate
 * evasion strategies including header generation, cookie crafting,
 * and visitor data fabrication.
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type {
  BotDetectionSignals,
  BotDetectionEvaderConfig,
  EvasionStrategy,
} from './types';

const logger = createChildLogger('youtube-bot-evader');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Default bot detection evader configuration */
const DEFAULT_EVADER_CONFIG: BotDetectionEvaderConfig = {
  minCooldownSeconds: 30,
  maxCooldownSeconds: 300,
  cooldownMultiplier: 1.5,
  maxCooldownCapSeconds: 3600,
  autoSolveCaptcha: true,
  autoRotateDevice: true,
  autoRotateProxy: true,
  unusualTrafficPatterns: [
    'unusual traffic',
    'not a robot',
    'verify you are human',
    'captcha',
    'sorry, we just need to make sure',
    'our systems have detected',
    'automated requests',
  ],
  fastResponseThresholdMs: 50,
};

/** Chrome versions for realistic User-Agent generation */
const CHROME_VERSIONS = [
  '125.0.6422.113',
  '126.0.6478.55',
  '126.0.6478.62',
  '127.0.6533.72',
  '127.0.6533.88',
  '128.0.6613.84',
  '128.0.6613.113',
  '129.0.6668.58',
  '130.0.6723.48',
  '131.0.6778.70',
];

/** Operating system strings for User-Agent */
const OS_STRINGS: Record<string, string[]> = {
  windows: [
    'Windows NT 10.0; Win64; x64',
    'Windows NT 10.0; Win64; x64',
    'Windows NT 11.0; Win64; x64',
  ],
  mac: [
    'Macintosh; Intel Mac OS X 10_15_7',
    'Macintosh; Intel Mac OS X 11_6_1',
    'Macintosh; Intel Mac OS X 12_7_4',
    'Macintosh; Intel Mac OS X 13_5_2',
    'Macintosh; Intel Mac OS X 14_3_1',
    'Macintosh; Intel Mac OS X 15_0',
  ],
  linux: [
    'X11; Linux x86_64',
    'X11; Ubuntu; Linux x86_64',
    'X11; Fedora; Linux x86_64',
  ],
};

/** Screen resolutions commonly used on desktop */
const COMMON_RESOLUTIONS = [
  { width: 1920, height: 1080, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1.25 },
  { width: 2560, height: 1440, dpr: 1 },
  { width: 1366, height: 768, dpr: 1 },
  { width: 1536, height: 864, dpr: 1.25 },
  { width: 1440, height: 900, dpr: 2 },
  { width: 2560, height: 1600, dpr: 2 },
  { width: 3840, height: 2160, dpr: 1 },
  { width: 1680, height: 1050, dpr: 1 },
  { width: 1280, height: 720, dpr: 1 },
];

/** Platform strings matching OS */
const PLATFORM_MAP: Record<string, string> = {
  'Windows NT': 'Win32',
  'Macintosh': 'MacIntel',
  'Linux': 'Linux x86_64',
  'X11': 'Linux x86_64',
};

/** Cache key prefix for evasion state */
const CACHE_KEY_PREFIX = 'youtube:evader';

// ===============================================================================
// HELPER FUNCTIONS
// ===============================================================================

/**
 * Pick a random element from an array.
 */
function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a random hexadecimal string of the given length.
 */
function randomHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Generate a random base64-like string.
 */
function randomBase64(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Generate a random alphanumeric string.
 */
function randomAlphanumeric(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Generate a random number in range [min, max].
 */
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ===============================================================================
// BOT DETECTION EVADER CLASS
// ===============================================================================

export class BotDetectionEvader {
  private config: BotDetectionEvaderConfig;
  private consecutiveDetections = 0;
  private lastDetectionTime = 0;
  private currentCooldownEnd = 0;
  private stats = {
    totalDetections: 0,
    totalEvasions: 0,
    captchaEncounters: 0,
    unusualTrafficEncounters: 0,
    rateLimitEncounters: 0,
    consentWallEncounters: 0,
    successfulEvasions: 0,
  };

  constructor(config?: Partial<BotDetectionEvaderConfig>) {
    this.config = { ...DEFAULT_EVADER_CONFIG, ...config };
    logger.info('YouTube bot detection evader initialized');
  }

  // ---------------------------------------------------------------------------
  // SIGNAL DETECTION
  // ---------------------------------------------------------------------------

  /**
   * Detect Google bot detection signals from a response.
   *
   * Analyzes HTTP response headers, body content, status codes, and timing
   * to identify when YouTube/Google has flagged the request as automated.
   *
   * @param response - The HTTP response to analyze
   * @returns Detected bot signals
   */
  detectBotSignals(response: {
    status: number;
    headers: Record<string, string>;
    body?: string;
    url?: string;
    responseTimeMs?: number;
  }): BotDetectionSignals {
    const signals: BotDetectionSignals = {
      unusualTrafficPage: false,
      captchaDetected: false,
      rateLimited: false,
      consentWall: false,
      loginWall: false,
      verificationRedirect: false,
      responseTimeAnomaly: false,
      statusCode: response.status,
      detectedAt: Date.now(),
    };

    const body = response.body?.toLowerCase() || '';
    const headers = response.headers || {};

    // Detect "unusual traffic" page
    for (const pattern of this.config.unusualTrafficPatterns) {
      if (body.includes(pattern.toLowerCase())) {
        signals.unusualTrafficPage = true;
        break;
      }
    }

    // Detect CAPTCHA
    if (
      body.includes('recaptcha') ||
      body.includes('g-recaptcha') ||
      body.includes('sitekey') ||
      body.includes('captcha') ||
      headers['x-recaptcha'] !== undefined
    ) {
      signals.captchaDetected = true;

      // Determine CAPTCHA type
      if (body.includes('enterprise') || body.includes('recaptchaenterprise')) {
        signals.captchaType = 'enterprise';
      } else if (body.includes('recaptcha-checkbox') || body.includes("recaptcha['fallback']")) {
        signals.captchaType = 'v2';
      } else {
        signals.captchaType = 'v3';
      }
    }

    // Detect rate limiting
    if (response.status === 429) {
      signals.rateLimited = true;
      signals.rateLimitDetails = {
        remaining: headers['x-ratelimit-remaining']
          ? parseInt(headers['x-ratelimit-remaining'], 10)
          : undefined,
        resetAt: headers['x-ratelimit-reset']
          ? parseInt(headers['x-ratelimit-reset'], 10)
          : undefined,
        retryAfter: headers['retry-after']
          ? parseInt(headers['retry-after'], 10)
          : undefined,
      };
    }

    // Detect consent wall
    if (
      body.includes('consent.youtube.com') ||
      body.includes('google.com/consent') ||
      body.includes('"consentBumpV2"') ||
      headers['x-consent-redirect'] !== undefined
    ) {
      signals.consentWall = true;
    }

    // Detect login wall
    if (
      body.includes('accounts.google.com/signin') ||
      body.includes('"signInEndpoint"') ||
      body.includes('login_required')
    ) {
      signals.loginWall = true;
    }

    // Detect verification redirect
    if (
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307
    ) {
      const location = headers['location'] || '';
      if (
        location.includes('google.com/sorry') ||
        location.includes('google.com/verify') ||
        location.includes('accounts.google.com') ||
        location.includes('recaptcha')
      ) {
        signals.verificationRedirect = true;
      }
    }

    // Detect response time anomaly (suspiciously fast = CDN cache or bot detection)
    if (response.responseTimeMs !== undefined && response.responseTimeMs < this.config.fastResponseThresholdMs) {
      signals.responseTimeAnomaly = true;
    }

    // Determine bot classification based on signals
    const signalCount = [
      signals.unusualTrafficPage,
      signals.captchaDetected,
      signals.rateLimited,
      signals.verificationRedirect,
    ].filter(Boolean).length;

    if (signalCount === 0) {
      signals.botClassification = 'none';
    } else if (signalCount === 1) {
      signals.botClassification = 'suspicious';
    } else if (signalCount === 2) {
      signals.botClassification = 'bot';
    } else {
      signals.botClassification = 'confirmed_bot';
    }

    // Update internal state if detection found
    if (signalCount > 0) {
      this.consecutiveDetections++;
      this.lastDetectionTime = Date.now();
      this.stats.totalDetections++;

      if (signals.unusualTrafficPage) this.stats.unusualTrafficEncounters++;
      if (signals.captchaDetected) this.stats.captchaEncounters++;
      if (signals.rateLimited) this.stats.rateLimitEncounters++;
      if (signals.consentWall) this.stats.consentWallEncounters++;

      logger.warn({
        signals: {
          unusualTraffic: signals.unusualTrafficPage,
          captcha: signals.captchaDetected,
          captchaType: signals.captchaType,
          rateLimited: signals.rateLimited,
          consentWall: signals.consentWall,
          loginWall: signals.loginWall,
          verificationRedirect: signals.verificationRedirect,
          classification: signals.botClassification,
        },
        consecutiveDetections: this.consecutiveDetections,
      }, 'YouTube bot detection signals detected');
    } else {
      this.consecutiveDetections = Math.max(0, this.consecutiveDetections - 1);
    }

    return signals;
  }

  // ---------------------------------------------------------------------------
  // EVASION STRATEGY GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate an evasion strategy based on detected bot signals.
   *
   * Analyzes the combination of detected signals to produce a comprehensive
   * evasion strategy that includes cooldown timing, identity rotation,
   * and header/cookie modifications.
   *
   * @param signals - The detected bot signals
   * @returns Evasion strategy to apply
   */
  generateEvadeStrategy(signals: BotDetectionSignals): EvasionStrategy {
    const strategy: EvasionStrategy = {
      requiresCooldown: false,
      cooldownDurationSeconds: 0,
      rotateCookies: false,
      rotateDevice: false,
      rotateProxy: false,
      requiresCaptchaSolve: false,
      headerModifications: {},
      cookieModifications: {},
      priority: 3,
      description: 'No evasion needed',
    };

    // --- Unusual traffic page ---
    if (signals.unusualTrafficPage) {
      const cooldown = this.calculateCooldown();
      strategy.requiresCooldown = true;
      strategy.cooldownDurationSeconds = cooldown;
      strategy.rotateCookies = true;
      strategy.rotateDevice = this.config.autoRotateDevice;
      strategy.rotateProxy = this.config.autoRotateProxy;
      strategy.priority = 1;
      strategy.description = `Unusual traffic page detected. Cooldown ${cooldown}s, rotate identity.`;

      // Add fresh consent cookies
      strategy.cookieModifications = {
        ...this.buildConsentCookies(),
      };
    }

    // --- CAPTCHA detected ---
    if (signals.captchaDetected) {
      strategy.requiresCaptchaSolve = this.config.autoSolveCaptcha;
      strategy.requiresCooldown = true;
      strategy.cooldownDurationSeconds = Math.max(
        strategy.cooldownDurationSeconds,
        this.calculateCooldown(),
      );
      strategy.rotateDevice = true;
      strategy.rotateProxy = true;
      strategy.priority = 1;
      strategy.description = `CAPTCHA (${signals.captchaType}) detected. Requires solving + cooldown.`;

      // Modify headers to appear more human
      strategy.headerModifications = {
        ...this.buildEvadeHeaders(),
      };
    }

    // --- Rate limited ---
    if (signals.rateLimited) {
      const retryAfter = signals.rateLimitDetails?.retryAfter || 60;
      strategy.requiresCooldown = true;
      strategy.cooldownDurationSeconds = Math.max(
        strategy.cooldownDurationSeconds,
        retryAfter * 2,
      );
      strategy.rotateProxy = true;
      strategy.priority = 2;
      strategy.description = `Rate limited (429). Cooldown ${retryAfter * 2}s, rotate proxy.`;

      // Add rate-limit-aware headers
      strategy.headerModifications['X-Origin'] = 'https://www.youtube.com';
    }

    // --- Consent wall ---
    if (signals.consentWall) {
      strategy.rotateCookies = true;
      strategy.priority = 2;
      strategy.description = 'Consent wall triggered. Rotating consent cookies.';
      strategy.cookieModifications = {
        ...this.buildConsentCookies(),
      };
    }

    // --- Login wall ---
    if (signals.loginWall) {
      strategy.priority = 3;
      strategy.description = 'Login wall encountered. Some content requires authentication.';
      strategy.headerModifications['X-Auth-Required'] = 'true';
    }

    // --- Verification redirect ---
    if (signals.verificationRedirect) {
      const cooldown = this.calculateCooldown();
      strategy.requiresCooldown = true;
      strategy.cooldownDurationSeconds = Math.max(
        strategy.cooldownDurationSeconds,
        cooldown,
      );
      strategy.rotateDevice = true;
      strategy.rotateProxy = true;
      strategy.priority = 1;
      strategy.description = `Verification redirect detected. Cooldown ${cooldown}s, full rotation.`;
    }

    // --- Response time anomaly ---
    if (signals.responseTimeAnomaly) {
      strategy.headerModifications['X-Request-Spacing'] = 'true';
      strategy.priority = Math.min(strategy.priority, 4) as 1 | 2 | 3 | 4 | 5;
      if (strategy.description === 'No evasion needed') {
        strategy.description = 'Response time anomaly detected. Adding request spacing.';
      }
    }

    // Set cooldown end time if required
    if (strategy.requiresCooldown && strategy.cooldownDurationSeconds > 0) {
      this.currentCooldownEnd = Date.now() + strategy.cooldownDurationSeconds * 1000;
    }

    this.stats.totalEvasions++;
    logger.info({
      strategy: {
        cooldown: strategy.cooldownDurationSeconds,
        rotateCookies: strategy.rotateCookies,
        rotateDevice: strategy.rotateDevice,
        rotateProxy: strategy.rotateProxy,
        captchaSolve: strategy.requiresCaptchaSolve,
        priority: strategy.priority,
      },
    }, 'Evasion strategy generated');

    return strategy;
  }

  // ---------------------------------------------------------------------------
  // HEADER GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate realistic Chrome headers for YouTube requests.
   *
   * Produces a complete set of HTTP headers that mimic a real Chrome browser
   * accessing YouTube, including proper Accept headers, Sec-CH-UA hints,
   * and YouTube-specific headers like X-YouTube-Client-Name.
   *
   * @param options - Optional overrides for header generation
   * @returns Headers object for HTTP requests
   */
  buildEvadeHeaders(options?: {
    clientName?: string;
    clientVersion?: string;
    referer?: string;
    origin?: string;
    language?: string;
    region?: string;
  }): Record<string, string> {
    const chromeVersion = randomPick(CHROME_VERSIONS);
    const majorVersion = chromeVersion.split('.')[0];
    const osString = randomPick([
      ...OS_STRINGS.windows,
      ...OS_STRINGS.mac,
      ...OS_STRINGS.linux,
    ]);
    const language = options?.language || 'en';
    const region = options?.region || 'US';
    const origin = options?.origin || 'https://www.youtube.com';

    // Detect platform for Sec-CH-UA-Platform
    let secChPlatform = '"Windows"';
    if (osString.includes('Macintosh')) secChPlatform = '"macOS"';
    else if (osString.includes('Linux')) secChPlatform = '"Linux"';

    const headers: Record<string, string> = {
      'User-Agent': `Mozilla/5.0 (${osString}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': `${language}-${region},${language};q=0.9,en;q=0.8`,
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Sec-Ch-Ua': `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not-A.Brand";v="99"`,
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': secChPlatform,
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Origin': origin,
      'Referer': options?.referer || `${origin}/`,
    };

    // YouTube-specific InnerTube headers
    if (options?.clientName) {
      headers['X-Youtube-Client-Name'] = options.clientName;
    }
    if (options?.clientVersion) {
      headers['X-Youtube-Client-Version'] = options.clientVersion;
    }

    // Add DNT (Do Not Track) — about 25% of real users have it enabled
    if (Math.random() < 0.25) {
      headers['DNT'] = '1';
    }

    return headers;
  }

  // ---------------------------------------------------------------------------
  // CONSENT COOKIE GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate YouTube consent cookies required for GDPR/cookie compliance.
   *
   * YouTube requires specific consent cookies before serving content in
   * many regions. This generates valid CONSENT, SOCS, and related cookies
   * that indicate the user has accepted the terms.
   *
   * @returns Cookie key-value pairs for consent
   */
  buildConsentCookies(): Record<string, string> {
    const cookies: Record<string, string> = {};

    // CONSENT cookie — Google consent status
    // Format: "PENDING+{number}" or "YES+{number}" (accepted)
    // The number is a random consent ID
    const consentId = randomBetween(100, 999);
    cookies['CONSENT'] = `YES+cb.20210328-17-p0.en+FX+${consentId}`;

    // SOCS cookie — Same-Origin Cookie Setting
    // Indicates cookie consent has been given
    // Value is a base64-encoded JSON object
    const socsValue = Buffer.from(
      JSON.stringify({
        visitId: randomAlphanumeric(21),
        lastVisitTime: Date.now(),
        consentStatus: 1, // 1 = consented
        isUserSignedIn: false,
        isGmUser: false,
        isEtmUser: false,
        consentTimestamp: Date.now(),
      }),
    ).toString('base64');
    cookies['SOCS'] = `CAESHAgBEhJnd3NfMjAyMzEwMTAtMF9SQzIaAmVuIAEaBgiA-LaoBg`;

    // GPS cookie — YouTube's GDPR Processing Stamp
    cookies['GPS'] = '1';

    // YSC cookie — YouTube Service Cookie (session identifier)
    cookies['YSC'] = randomAlphanumeric(24);

    // VISITOR_INFO1_LIVE — Visitor tracking cookie
    // 11-character alphanumeric string
    cookies['VISITOR_INFO1_LIVE'] = randomAlphanumeric(11);

    // PREF cookie — YouTube preferences
    // f6 = 43200 (12-hour history), hl=en (language), gl=US (region)
    const fGroup = randomBetween(1, 8);
    cookies['PREF'] = `f${fGroup}=43200&hl=en&gl=US`;

    // __Secure-1PSID — First-party secure session ID
    // This is a Google-signed cookie (starts with a specific prefix)
    cookies['__Secure-1PSID'] = randomAlphanumeric(80);

    // __Secure-3PSID — Third-party secure session ID
    cookies['__Secure-3PSID'] = randomAlphanumeric(80);

    // SIDCC — Session ID Cookie (for cross-site request forgery protection)
    cookies['SIDCC'] = `AFvY0eb0-${randomAlphanumeric(40)}`;

    return cookies;
  }

  // ---------------------------------------------------------------------------
  // VISITOR DATA GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate valid YouTube visitor data (_visitor_key and visitorData).
   *
   * YouTube uses visitor tracking to correlate requests and detect
   * automated access. This generates realistic visitor identifiers
   * that are consistent with real browser sessions.
   *
   * @returns Visitor data object with key and data string
   */
  generateYouTubeVisitorData(): {
    visitorKey: string;
    visitorData: string;
    visitorId: string;
  } {
    // _visitor_key — A random hex string (typically 16 characters)
    const visitorKey = randomHex(16);

    // visitorData — Base64-encoded protobuf containing visitor info
    // Real format: base64-encoded string starting with "Cgs"
    // This is a protobuf-encoded message with:
    //   - field 1: visitor ID (string)
    //   - field 2: timestamp
    // We generate a plausible base64 string

    const visitorId = randomAlphanumeric(11);

    // Simulate the protobuf structure:
    // The visitorData in YouTube is a base64-encoded proto that contains
    // a visitor ID and timestamp. We build a realistic-looking one.
    const timestamp = Math.floor(Date.now() / 1000);

    // Build raw protobuf-like bytes for visitorData
    // Field 1 (length-delimited): visitor ID
    // Field 2 (varint): timestamp
    const idBytes = Buffer.from(visitorId, 'utf-8');
    const protoParts: number[] = [];

    // Field 1: tag = (1 << 3) | 2 = 0x0A (length-delimited)
    protoParts.push(0x0A);
    protoParts.push(idBytes.length);
    for (let i = 0; i < idBytes.length; i++) {
      protoParts.push(idBytes[i]!);
    }

    // Field 2: tag = (2 << 3) | 0 = 0x10 (varint)
    protoParts.push(0x10);
    // Encode timestamp as varint
    let ts = timestamp;
    while (ts > 0x7F) {
      protoParts.push((ts & 0x7F) | 0x80);
      ts >>>= 7;
    }
    protoParts.push(ts & 0x7F);

    const visitorData = Buffer.from(protoParts).toString('base64');

    logger.debug({
      visitorKey: visitorKey.substring(0, 8) + '...',
      visitorId,
    }, 'Generated YouTube visitor data');

    return {
      visitorKey,
      visitorData,
      visitorId,
    };
  }

  // ---------------------------------------------------------------------------
  // UTILITY METHODS
  // ---------------------------------------------------------------------------

  /**
   * Calculate cooldown duration based on consecutive detection count.
   * Uses exponential backoff with a configurable multiplier and cap.
   *
   * @returns Cooldown duration in seconds
   */
  private calculateCooldown(): number {
    const base = this.config.minCooldownSeconds;
    const multiplier = Math.pow(
      this.config.cooldownMultiplier,
      this.consecutiveDetections,
    );
    const cooldown = Math.min(
      base * multiplier,
      this.config.maxCooldownCapSeconds,
    );

    // Add jitter (±20%) to avoid synchronized retries
    const jitter = cooldown * 0.2 * (Math.random() * 2 - 1);

    return Math.max(
      this.config.minCooldownSeconds,
      Math.round(cooldown + jitter),
    );
  }

  /**
   * Check if currently in a cooldown period.
   *
   * @returns Remaining cooldown in seconds (0 if not cooling down)
   */
  getRemainingCooldown(): number {
    if (this.currentCooldownEnd <= Date.now()) return 0;
    return Math.ceil((this.currentCooldownEnd - Date.now()) / 1000);
  }

  /**
   * Clear the current cooldown period.
   */
  clearCooldown(): void {
    this.currentCooldownEnd = 0;
    logger.info('Cooldown cleared');
  }

  /**
   * Record a successful evasion to improve success rate tracking.
   */
  recordEvasionSuccess(): void {
    this.stats.successfulEvasions++;
  }

  /**
   * Generate a random screen resolution from common desktop resolutions.
   *
   * @returns Screen resolution object
   */
  generateRandomResolution(): { width: number; height: number; dpr: number } {
    return randomPick(COMMON_RESOLUTIONS);
  }

  /**
   * Get evader statistics.
   */
  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      consecutiveDetections: this.consecutiveDetections,
      currentCooldownSeconds: this.getRemainingCooldown(),
      evasionSuccessRate: this.stats.totalEvasions > 0
        ? this.stats.successfulEvasions / this.stats.totalEvasions
        : 1,
    };
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const botDetectionEvader = new BotDetectionEvader();
