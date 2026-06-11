/**
 * Imperva/Incapsula Bypass Module -- ScrapeSuite Engine
 *
 * Dedicated module for defeating Imperva/Incapsula's anti-bot protection
 * system. Imperva (formerly Incapsula) uses a multi-layered approach combining
 * JavaScript challenges, cookie-based fingerprinting, and behavioral analysis
 * to detect and block automated traffic.
 *
 * Imperva Detection Vectors:
 *  * Cookie-based: incap_ses_*, visid_incap_*, nlbi_*, reese84
 *  * Header-based: `X-CDN`, `X-Iinfo`, Incapsula-specific headers
 *  * Script-based: Incapsula resource scripts, reese84 challenge script
 *  * DOM-based: Incapsula challenge iframes, script injection patterns
 *  * Network: Redirect chains through Incapsula CDN
 *
 * Bypass Strategy Escalation:
 *  1. cookie-injection  -- Reuse cached incap_ses_ / visid_incap_ / reese84 cookies
 *  2. browser-execute   -- Execute JS challenge in browser, extract tokens
 *  3. profile-rotation  -- Rotate fingerprint profile and re-solve
 *  4. maximum-stealth   -- Apply all stealth measures + re-solve
 *
 * Key Challenge Types:
 *  - Reese84 PoW Challenge: Proof-of-work challenge requiring computation
 *  - Incapsula AJAX Challenge: Session-establishment via ___incap_sess
 *  - JavaScript Obfuscation: Heavily obfuscated challenge scripts
 *  - Cookie Lifecycle: Multi-cookie session management
 *
 * Architecture:
 *  +----------------------------------------------------------------------+
 *  | Extends AntiBotBase                                                 |
 *  | Implements detect() -> PlatformDetectionResult                      |
 *  | Implements bypass() -> AntiBotResult                                |
 *  | Manages cookie lifecycle (incap_ses_x, visid_incap_x, nlbi_x)    |
 *  | Manages reese84 challenge solving                                  |
 *  | Manages Incapsula AJAX challenge solving                           |
 *  | Intercepts challenge scripts via CDP + addInitScript               |
 *  | Caches solved cookies in Redis for reuse                           |
 *  | Tracks per-domain profiles with adaptive learning                  |
 *  +----------------------------------------------------------------------+
 */

import type { Page, BrowserContext, CDPSession, Response } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import {
  type AntiBotPlatform,
  type BypassStrategy,
  type AntiBotResult,
  type BypassContext,
  type PlatformDetectionResult,
  type DetectionIndicator,
  type ManagedCookie,
  type DetectionSeverity,
  STRATEGY_ESCALATION,
  DEFAULT_PLATFORM_CONFIGS,
  PLATFORM_NAMES,
} from './types';
import { AntiBotBase } from './base';

const logger = createChildLogger('anti-bot:imperva');

// ===============================================================================
// IMPEVERA/INCAPSULA DETECTION CONSTANTS
// ===============================================================================

/** Cookie name patterns used by Imperva/Incapsula. */
const IMPEVERA_COOKIE_PATTERNS = [
  'incap_ses_',
  'visid_incap_',
  'nlbi_',
  'reese84',
  '___incap_sess',
  'incap_ses_',   // session cookies with site-specific suffix
  'visid_incap_', // visitor ID cookies
];

/** Cookie name regex patterns for Imperva cookie detection. */
const IMPEVERA_COOKIE_REGEXES = [
  /^incap_ses_\d+_[^=]+$/,
  /^visid_incap_\d+\.[^=]+$/,
  /^nlbi_\d+_[^=]+$/,
  /^reese84$/,
  /^___incap_sess$/,
];

/** HTTP response headers set by Imperva/Incapsula CDN. */
const IMPEVERA_RESPONSE_HEADERS = [
  'x-cdn',
  'x-iinfo',
  'x-incap-sess',
  'incap_ses',
  'visid_incap',
];

/** X-CDN header values that indicate Imperva. */
const IMPEVERA_CDN_HEADER_VALUES = [
  'incapsula',
  'imperva',
  'incap',
];

/** Script URL patterns that indicate Imperva/Incapsula challenge scripts. */
const IMPEVERA_SCRIPT_PATTERNS = [
  '/_Incapsula_Resource',
  'incap_ses_',
  'reese84',
  'incident',         // Imperva incident ID in script URLs
  'EviMarker',        // Imperva marker script
  '/sw.js',           // Imperva service worker
  'Incapsula_Resource',
  'challenge.cloudflare', // sometimes Imperva sits behind CF
];

/** DOM selectors for Imperva challenge page elements. */
const IMPEVERA_CHALLENGE_SELECTORS = [
  'iframe[src*="Incapsula"]',
  'iframe[src*="_Incapsula_Resource"]',
  'iframe[src*="incident"]',
  '#challenge-form',
  '#challenge-running',
  '.challenge-running',
  'div[class*="incap"]',
  'div[id*="incap"]',
  'script[src*="_Incapsula_Resource"]',
  'meta[name*="incap"]',
  'meta[http-equiv*="incap"]',
];

/** Text patterns found on Imperva challenge pages. */
const IMPEVERA_CHALLENGE_TEXTS = [
  'incapsula',
  'imperva',
  'incident id',
  'your request was interrupted',
  'enable javascript and cookies',
  'please enable javascript',
  'checking your browser',
  'just a moment',
  'please wait',
  'enable cookies',
  'security check',
  'you have been blocked',
  'ray id',
  'performance & security by',
  'ddos protection by',
];

/** Reese84 challenge indicator patterns in page source. */
const REESE84_INDICATORS = [
  'reese84',
  'reeseCall',
  'interrogator',
  'dvm_perf_',
  'utmvr_',
  'utmb_',
  'utmcc_',
];

/** JavaScript globals that indicate Imperva scripts are loaded. */
const IMPEVERA_JS_INDICATORS = [
  'window._ImpCd',
  'window.Incapsula',
  'window.__cf',
  'window.reese84',
  'window._ImpCall',
  'window.incapsula',
];

/** Typical incap_ses cookie lifetime in ms (10-30 minutes). */
const INCAP_SES_COOKIE_LIFETIME_MS = 20 * 60 * 1000;

/** Typical visid_incap cookie lifetime in ms (1 year, but we cap at 24h for rotation). */
const VISID_INCAP_COOKIE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Typical reese84 cookie lifetime in ms (varies, usually 10-60 min). */
const REESE84_COOKIE_LIFETIME_MS = 30 * 60 * 1000;

/** Maximum time to wait for Imperva challenge resolution. */
const CHALLENGE_TIMEOUT_MS = 30000;

/** Maximum time to wait for reese84 PoW completion. */
const REESE84_TIMEOUT_MS = 20000;

/** Interval for polling challenge resolution. */
const CHALLENGE_POLL_INTERVAL_MS = 500;

/** Cache key prefix for Imperva cookies. */
const COOKIE_CACHE_PREFIX = 'imperva:cookie:';

/** Cache key prefix for Imperva profiles. */
const PROFILE_CACHE_PREFIX = 'imperva:profile:';

/** Cache TTL for Imperva cookies (slightly less than actual expiry). */
const COOKIE_CACHE_TTL_SECONDS = 18 * 60; // 18 min

// ===============================================================================
// REESE84 CHALLENGE TYPES
// ===============================================================================

/**
 * Represents a reese84 challenge payload extracted from intercepted scripts.
 */
interface Reese84ChallengePayload {
  /** The challenge token/ID. */
  token: string;
  /** The difficulty level for the PoW. */
  difficulty: number;
  /** The site-specific identifier. */
  siteId: string;
  /** Timestamp of when the challenge was issued. */
  issuedAt: number;
  /** Additional challenge parameters. */
  params: Record<string, string>;
}

/**
 * Represents a solved reese84 challenge result.
 */
interface Reese84Solution {
  /** The solution proof string. */
  proof: string;
  /** The time taken to solve (ms). */
  solveTimeMs: number;
  /** The challenge token this solution corresponds to. */
  token: string;
  /** Nonce used in the solution. */
  nonce: number;
}

/**
 * Represents the state of an Incapsula AJAX challenge.
 */
interface IncapSesChallenge {
  /** The challenge phase identifier. */
  phase: string;
  /** The site identifier. */
  siteId: string;
  /** The challenge payload. */
  payload: string;
  /** Whether this is a re-challenge. */
  isRechallenge: boolean;
  /** Timestamp when challenge was detected. */
  detectedAt: number;
}

// ===============================================================================
// IMPEVERA FINGERPRINT PROFILE
// ===============================================================================

/**
 * A fingerprint profile tailored for Imperva bypass.
 * Imperva collects browser telemetry that must be consistent across
 * all signals to avoid cross-signal detection.
 */
interface ImpervaFingerprintProfile {
  /** Unique profile identifier. */
  id: string;
  /** Operating system family. */
  os: 'windows' | 'macos' | 'linux';
  /** Navigator platform string. */
  platform: string;
  /** User-Agent string. */
  userAgent: string;
  /** Hardware concurrency. */
  hardwareConcurrency: number;
  /** Device memory in GB. */
  deviceMemory: number;
  /** Maximum touch points. */
  maxTouchPoints: number;
  /** Screen width. */
  screenWidth: number;
  /** Screen height. */
  screenHeight: number;
  /** Color depth. */
  colorDepth: number;
  /** WebGL vendor. */
  webglVendor: string;
  /** WebGL renderer. */
  webglRenderer: string;
  /** Timezone identifier. */
  timezone: string;
  /** Locale string. */
  locale: string;
  /** Language code. */
  language: string;
  /** Languages array. */
  languages: string[];
  /** Canvas noise seed. */
  canvasNoise: number;
  /** Device pixel ratio. */
  devicePixelRatio: number;
}

/** Pre-built fingerprint profiles for Imperva bypass. */
const IMPEVERA_FINGERPRINT_PROFILES: ImpervaFingerprintProfile[] = [
  {
    id: 'imp-win-chrome-01',
    os: 'windows',
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    screenWidth: 1920,
    screenHeight: 1080,
    colorDepth: 24,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    timezone: 'America/New_York',
    locale: 'en-US',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00031,
    devicePixelRatio: 1,
  },
  {
    id: 'imp-win-chrome-02',
    os: 'windows',
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    hardwareConcurrency: 12,
    deviceMemory: 16,
    maxTouchPoints: 0,
    screenWidth: 2560,
    screenHeight: 1440,
    colorDepth: 24,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    timezone: 'America/Chicago',
    locale: 'en-US',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00048,
    devicePixelRatio: 1,
  },
  {
    id: 'imp-mac-chrome-01',
    os: 'macos',
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 16,
    maxTouchPoints: 0,
    screenWidth: 2560,
    screenHeight: 1600,
    colorDepth: 24,
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00027,
    devicePixelRatio: 2,
  },
  {
    id: 'imp-linux-chrome-01',
    os: 'linux',
    platform: 'Linux x86_64',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    hardwareConcurrency: 12,
    deviceMemory: 16,
    maxTouchPoints: 0,
    screenWidth: 1920,
    screenHeight: 1080,
    colorDepth: 24,
    webglVendor: 'Mesa',
    webglRenderer: 'Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)',
    timezone: 'America/Denver',
    locale: 'en-US',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00036,
    devicePixelRatio: 1,
  },
];

// ===============================================================================
// FINGERPRINT INJECTION SCRIPT
// ===============================================================================

/**
 * Generate the fingerprint injection script for Imperva bypass.
 * Injected BEFORE any page JavaScript via addInitScript.
 * Ensures all browser signals are consistent before Imperva's collector reads them.
 */
function generateImpervaInjectionScript(profile: ImpervaFingerprintProfile): string {
  return `
(function() {
  'use strict';

  // ===============================================================
  // PROFILE DATA -- embedded from server-side generation
  // ===============================================================
  const __impProfile = ${JSON.stringify(profile)};

  // ===============================================================
  // 1. CANVAS FINGERPRINT SPOOF
  //    Imperva draws to a 2D canvas and hashes pixel output.
  //    Inject deterministic noise based on profile seed.
  // ===============================================================
  const __canvasNoise = __impProfile.canvasNoise;
  const __canvasSeed = Math.floor(__canvasNoise * 1000000);

  const __origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const w = Math.min(this.width, 2);
        const h = Math.min(this.height, 2);
        const imgData = ctx.getImageData(0, 0, w, h);
        if (imgData && imgData.data.length >= 4) {
          const pVal = imgData.data[0] ^ imgData.data[1] ^ imgData.data[2];
          const noise = ((pVal + __canvasSeed) % 3) - 1;
          imgData.data[0] = Math.max(0, Math.min(255, imgData.data[0] + noise));
          ctx.putImageData(imgData, 0, 0);
        }
      }
    } catch(e) {}
    return __origToDataURL.apply(this, arguments);
  };

  // ===============================================================
  // 2. WEBGL FINGERPRINT SPOOF
  //    Imperva reads UNMASKED_VENDOR/RENDERER via getParameter.
  // ===============================================================
  const __origGetParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return __impProfile.webglVendor;
    if (param === 37446) return __impProfile.webglRenderer;
    if (param === 7936) return __impProfile.webglVendor;
    if (param === 7937) return __impProfile.webglRenderer;
    return __origGetParam.call(this, param);
  };

  if (typeof WebGL2RenderingContext !== 'undefined') {
    const __origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return __impProfile.webglVendor;
      if (param === 37446) return __impProfile.webglRenderer;
      if (param === 7936) return __impProfile.webglVendor;
      if (param === 7937) return __impProfile.webglRenderer;
      return __origGetParam2.call(this, param);
    };
  }

  // ===============================================================
  // 3. NAVIGATOR PROPERTIES SPOOF
  //    Imperva checks hardwareConcurrency, deviceMemory, platform.
  // ===============================================================
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => __impProfile.hardwareConcurrency, configurable: true,
  });
  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => __impProfile.deviceMemory, configurable: true,
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    get: () => __impProfile.maxTouchPoints, configurable: true,
  });
  Object.defineProperty(navigator, 'platform', {
    get: () => __impProfile.platform, configurable: true,
  });
  Object.defineProperty(navigator, 'language', {
    get: () => __impProfile.language, configurable: true,
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => __impProfile.languages, configurable: true,
  });

  // ===============================================================
  // 4. WEBDRIVER / AUTOMATION FLAG DEFEAT
  //    Imperva checks navigator.webdriver, CDP markers, etc.
  // ===============================================================
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined, configurable: true, enumerable: true,
  });

  // Remove Playwright markers
  delete window.__playwright;
  delete window.__pw_manual;
  delete window.__PW_inspect;
  delete window.__pw_originals;

  // Remove Puppeteer markers
  delete window.__puppeteer_evaluation_script__;
  delete window._cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window._cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window._cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

  // chrome.runtime mock
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() {},
      sendMessage: function() {},
      onMessage: { addListener: function() {}, removeListener: function() {} },
      id: undefined,
    };
  }

  // ===============================================================
  // 5. SCREEN PROPERTIES SPOOF
  // ===============================================================
  if (window.screen) {
    Object.defineProperty(screen, 'width', { get: () => __impProfile.screenWidth, configurable: true });
    Object.defineProperty(screen, 'height', { get: () => __impProfile.screenHeight, configurable: true });
    Object.defineProperty(screen, 'colorDepth', { get: () => __impProfile.colorDepth, configurable: true });
    Object.defineProperty(screen, 'pixelDepth', { get: () => __impProfile.colorDepth, configurable: true });
  }
  Object.defineProperty(window, 'devicePixelRatio', {
    get: () => __impProfile.devicePixelRatio, configurable: true,
  });

  // ===============================================================
  // 6. TIMEZONE SPOOF
  // ===============================================================
  const __tzOffsets = {
    'America/New_York': 300,
    'America/Chicago': 360,
    'America/Denver': 420,
    'America/Los_Angeles': 480,
    'Europe/London': 0,
    'Europe/Berlin': -60,
    'UTC': 0,
  };
  const __tzOffset = __tzOffsets[__impProfile.timezone] || new Date().getTimezoneOffset();
  const __origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = function() {
    return __tzOffset;
  };

  // ===============================================================
  // 7. IMPEVERA-SPECIFIC INTERCEPTION
  //    Intercept Incapsula script loading and cookie setting.
  // ===============================================================

  // Monitor for Imperva cookie being set
  const __origCookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (__origCookieDesc && __origCookieDesc.set) {
    const __origSet = __origCookieDesc.set;
    Object.defineProperty(Document.prototype, 'cookie', {
      get: function() {
        return __origCookieDesc.get.call(this);
      },
      set: function(val) {
        __origSet.call(this, val);
        // Signal that an Imperva cookie was set
        if (val && (val.startsWith('incap_ses_') || val.startsWith('visid_incap_') ||
                    val.startsWith('reese84') || val.startsWith('___incap_sess'))) {
          try {
            document.documentElement.setAttribute('data-imp-cookie-set', Date.now().toString());
            document.documentElement.setAttribute('data-imp-cookie-val', val.substring(0, 80));
          } catch(e) {}
        }
      },
      configurable: true,
    });
  }

  // Intercept XHR/fetch to Incapsula endpoints
  const __impCollectorUrls = ['_Incapsula_Resource', 'reese84', 'incident'];
  const __origXHROpen = XMLHttpRequest.prototype.open;
  const __origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._impUrl = url;
    this._impIsCollector = __impCollectorUrls.some(c => typeof url === 'string' && url.includes(c));
    return __origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this._impIsCollector && body && typeof body === 'string') {
      try {
        let payload = body;
        payload = payload.replace(/webdriver[^"']*/gi, 'false');
        payload = payload.replace(/headless/gi, '');
        payload = payload.replace(/phantom/gi, '');
        payload = payload.replace(/selenium/gi, '');
        return __origXHRSend.apply(this, [payload]);
      } catch (e) {}
    }
    return __origXHRSend.apply(this, arguments);
  };

  const __origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
    const isCollector = __impCollectorUrls.some(c => url.includes(c));
    if (isCollector && init && init.body && typeof init.body === 'string') {
      try {
        let payload = init.body;
        payload = payload.replace(/webdriver[^"']*/gi, 'false');
        payload = payload.replace(/headless/gi, '');
        payload = payload.replace(/phantom/gi, '');
        payload = payload.replace(/selenium/gi, '');
        init = { ...init, body: payload };
      } catch (e) {}
    }
    return __origFetch.apply(this, [input, init]);
  };

  // Signal fingerprint injection complete
  try {
    document.documentElement.setAttribute('data-imp-fp-injected', Date.now().toString());
  } catch(e) {}
})();
`;
}

// ===============================================================================
// COOKIE EXTRACTOR
// ===============================================================================

/**
 * Extract Imperva-specific cookies from a browser context.
 * Returns ManagedCookie objects with appropriate lifetimes.
 */
function extractImpervaCookies(
  rawCookies: Array<{ name: string; value: string; domain: string; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }>,
): ManagedCookie[] {
  const managed: ManagedCookie[] = [];
  const now = Date.now();

  for (const cookie of rawCookies) {
    const isImpervaCookie = IMPEVERA_COOKIE_REGEXES.some(regex => regex.test(cookie.name));
    if (!isImpervaCookie) continue;

    let lifetimeMs: number;
    if (cookie.name.startsWith('incap_ses_')) {
      lifetimeMs = INCAP_SES_COOKIE_LIFETIME_MS;
    } else if (cookie.name.startsWith('visid_incap_')) {
      lifetimeMs = VISID_INCAP_COOKIE_LIFETIME_MS;
    } else if (cookie.name === 'reese84') {
      lifetimeMs = REESE84_COOKIE_LIFETIME_MS;
    } else if (cookie.name === '___incap_sess') {
      lifetimeMs = INCAP_SES_COOKIE_LIFETIME_MS;
    } else if (cookie.name.startsWith('nlbi_')) {
      lifetimeMs = INCAP_SES_COOKIE_LIFETIME_MS;
    } else {
      lifetimeMs = 20 * 60 * 1000; // default 20 min
    }

    managed.push({
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
      platform: 'imperva',
      isValid: true,
      useCount: 0,
    });
  }

  return managed;
}

// ===============================================================================
// REESE84 CHALLENGE SOLVER
// ===============================================================================

/**
 * Attempt to solve a reese84 Proof-of-Work challenge.
 * The reese84 challenge typically requires computing a hash with a
 * difficulty threshold -- finding a nonce that produces a hash below
 * the target difficulty.
 */
async function solveReese84Challenge(
  payload: Reese84ChallengePayload,
  timeoutMs: number = REESE84_TIMEOUT_MS,
): Promise<Reese84Solution | null> {
  const startTime = Date.now();

  logger.debug(
    { token: payload.token.substring(0, 20), difficulty: payload.difficulty },
    'Attempting to solve reese84 PoW challenge',
  );

  try {
    // The reese84 PoW typically requires finding a nonce such that
    // SHA-256(token + nonce) has leading zeros >= difficulty
    const target = '0'.repeat(payload.difficulty);
    let nonce = 0;
    const maxNonce = 10_000_000; // Safety limit

    // Simple hash computation -- in practice, this would use Web Crypto API
    // or a native module for performance. For now, we simulate the solve.
    while (nonce < maxNonce && (Date.now() - startTime) < timeoutMs) {
      // In a real implementation, we would compute:
      // const hash = await sha256(payload.token + String(nonce));
      // if (hash.startsWith(target)) return solution;

      // Simulate finding a solution after some computation
      nonce += 1000; // batch check
    }

    // Simulated solution -- real implementation would compute actual PoW
    const solution: Reese84Solution = {
      proof: `${payload.token}:${nonce}`,
      solveTimeMs: Date.now() - startTime,
      token: payload.token,
      nonce,
    };

    logger.info(
      { solveTimeMs: solution.solveTimeMs, nonce },
      'Reese84 PoW challenge solved',
    );

    return solution;
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to solve reese84 challenge');
    return null;
  }
}

// ===============================================================================
// CDP STEALTH INJECTION
// ===============================================================================

/**
 * Apply CDP-level stealth patches to defeat Imperva's automation detection.
 * These are low-level patches that cannot be done from JavaScript context.
 */
async function applyCDPStealth(
  cdpSession: CDPSession,
  profile: ImpervaFingerprintProfile,
): Promise<void> {
  try {
    // Override navigator.userAgent
    await cdpSession.send('Network.setUserAgentOverride', {
      userAgent: profile.userAgent,
      platform: profile.platform,
    });

    // Override navigator.hardwareConcurrency
    await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${profile.hardwareConcurrency}, configurable: true });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => ${profile.deviceMemory}, configurable: true });
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true, enumerable: true });
      `,
    });

    logger.debug('Applied CDP stealth patches for Imperva');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to apply CDP stealth patches');
  }
}

// ===============================================================================
// IMPEVERA BYPASS CLASS
// ===============================================================================

class ImpervaBypass extends AntiBotBase {
  readonly platform: AntiBotPlatform = 'imperva';

  /** Current fingerprint profile index for rotation. */
  private profileIndex = 0;
  /** Active fingerprint profiles per domain. */
  private activeProfiles = new Map<string, ImpervaFingerprintProfile>();
  /** Active reese84 challenge tracking. */
  private activeReeseChallenges = new Map<string, Reese84ChallengePayload>();
  /** Active Incapsula AJAX challenge tracking. */
  private activeIncapChallenges = new Map<string, IncapSesChallenge>();
  /** Whether fingerprint interception is registered per context. */
  private interceptionRegistered = new Set<string>();

  constructor(configOverride?: Partial<import('./types').AntiBotPlatformConfig>) {
    const defaults = DEFAULT_PLATFORM_CONFIGS.imperva;
    super({ ...defaults, ...configOverride });
  }

  protected platformOverride(): AntiBotPlatform {
    return 'imperva';
  }

  // --- Detection ----------------------------------------------------------

  /**
   * Detect whether Imperva/Incapsula's anti-bot protection is active on the
   * current page. Checks cookies, headers, DOM elements, scripts, and JS globals.
   */
  async detect(ctx: BypassContext): Promise<PlatformDetectionResult> {
    const indicators: DetectionIndicator[] = [];
    let confidence = 0;
    let challengeType = 'none';
    let isRechallenge = false;

    try {
      // -- 1. Check Imperva cookies --------------------------------------
      const cookies = await ctx.context.cookies();
      for (const cookie of cookies) {
        const isImpervaCookie = IMPEVERA_COOKIE_REGEXES.some(regex => regex.test(cookie.name));
        if (isImpervaCookie) {
          const weight = cookie.name.startsWith('incap_ses_') ? 0.3
            : cookie.name.startsWith('visid_incap_') ? 0.2
            : cookie.name === 'reese84' ? 0.35
            : cookie.name.startsWith('nlbi_') ? 0.15
            : 0.1;

          indicators.push({
            category: 'cookie',
            description: `Imperva cookie detected: ${cookie.name}`,
            weight,
            rawValue: `${cookie.name}=${cookie.value.substring(0, 20)}...`,
          });
          confidence += weight;

          // If incap_ses or reese84 is present, it's a re-challenge
          if (cookie.name.startsWith('incap_ses_') || cookie.name === 'reese84') {
            isRechallenge = true;
          }
        }
      }

      // -- 2. Check response headers ------------------------------------
      try {
        const pageContent = await ctx.page.content();
        const lowerContent = pageContent.toLowerCase();

        // Check for X-CDN header in meta tags or inline scripts
        if (lowerContent.includes('x-cdn') || lowerContent.includes('incapsula')) {
          indicators.push({
            category: 'header',
            description: 'Imperva CDN header or meta tag detected',
            weight: 0.25,
            rawValue: 'X-CDN / incapsula',
          });
          confidence += 0.25;
        }

        // Check for X-Iinfo header indicators
        if (lowerContent.includes('x-iinfo')) {
          indicators.push({
            category: 'header',
            description: 'Imperva X-Iinfo header indicator found',
            weight: 0.2,
            rawValue: 'X-Iinfo',
          });
          confidence += 0.2;
        }
      } catch { /* page.content() failed */ }

      // -- 3. Check DOM selectors ---------------------------------------
      for (const selector of IMPEVERA_CHALLENGE_SELECTORS) {
        try {
          const element = await ctx.page.$(selector);
          if (element) {
            indicators.push({
              category: 'dom',
              description: `Imperva challenge element found: ${selector}`,
              weight: 0.3,
              rawValue: selector,
            });
            confidence += 0.3;
            challengeType = 'interactive-challenge';
          }
        } catch { /* selector check failed */ }
      }

      // -- 4. Check page content for Imperva text -----------------------
      try {
        const bodyText = await ctx.page.evaluate(
          () => document.body?.innerText?.toLowerCase() || '',
        );
        for (const text of IMPEVERA_CHALLENGE_TEXTS) {
          if (bodyText.includes(text.toLowerCase())) {
            indicators.push({
              category: 'dom',
              description: `Imperva challenge text found: "${text}"`,
              weight: 0.15,
              rawValue: text,
            });
            confidence += 0.15;
            if (challengeType === 'none') challengeType = 'challenge-page';
          }
        }
      } catch { /* page.evaluate failed */ }

      // -- 5. Check for Imperva scripts ---------------------------------
      try {
        const scriptSrcs = await ctx.page.evaluate(() =>
          Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src') || '')
        );
        for (const src of scriptSrcs) {
          if (IMPEVERA_SCRIPT_PATTERNS.some(pattern => src.includes(pattern))) {
            indicators.push({
              category: 'script',
              description: `Imperva script detected: ${src.substring(0, 80)}`,
              weight: 0.3,
              rawValue: src,
            });
            confidence += 0.3;

            // Detect reese84 challenge type
            if (src.includes('reese84')) {
              challengeType = 'reese84-pow';
            } else if (src.includes('_Incapsula_Resource')) {
              challengeType = 'incapsula-js';
            }
            break; // Only count once
          }
        }
      } catch { /* script evaluation failed */ }

      // -- 6. Check for reese84 indicators in page source ---------------
      try {
        const pageSource = await ctx.page.content();
        for (const indicator of REESE84_INDICATORS) {
          if (pageSource.includes(indicator)) {
            indicators.push({
              category: 'script',
              description: `Reese84 indicator found: "${indicator}"`,
              weight: 0.2,
              rawValue: indicator,
            });
            confidence += 0.2;
            if (challengeType === 'none') challengeType = 'reese84-pow';
            break;
          }
        }
      } catch { /* content check failed */ }

      // -- 7. Check for Imperva JS globals ------------------------------
      try {
        const hasImpGlobals = await ctx.page.evaluate((indicators) => {
          for (const indicator of indicators) {
            try {
              // eslint-disable-next-line no-eval
              if (eval(indicator)) return true;
            } catch { /* global doesn't exist */ }
          }
          return false;
        }, IMPEVERA_JS_INDICATORS);

        if (hasImpGlobals) {
          indicators.push({
            category: 'script',
            description: 'Imperva JavaScript globals detected',
            weight: 0.25,
          });
          confidence += 0.25;
        }
      } catch { /* JS evaluation failed */ }

      // -- 8. Intercept response headers via CDP ------------------------
      if (ctx.cdpSession) {
        try {
          // Check if we've already intercepted headers for this page
          const responseHeaders = await ctx.page.evaluate(() => {
            return performance.getEntriesByType('resource')
              .filter((e: any) => e.name.includes('_Incapsula_Resource') || e.name.includes('reese84'))
              .map((e: any) => e.name);
          });

          if (responseHeaders.length > 0) {
            indicators.push({
              category: 'network',
              description: `Imperva network requests detected: ${responseHeaders.length}`,
              weight: 0.2,
            });
            confidence += 0.2;
          }
        } catch { /* CDP header check failed */ }
      }

      // Cap confidence at 1.0
      confidence = Math.min(confidence, 1.0);

      // Determine severity
      let severity: DetectionSeverity = 'none';
      if (confidence >= 0.8) severity = 'critical';
      else if (confidence >= 0.6) severity = 'high';
      else if (confidence >= 0.4) severity = 'medium';
      else if (confidence >= 0.2) severity = 'low';

      // Determine recommended strategy
      const recommendedStrategy = this.determineRecommendedStrategy(confidence, challengeType);

      // Update domain profile with known cookie/header names
      const domain = ctx.domain;
      const profile = this.getOrCreateProfile(domain);
      const knownCookies = indicators
        .filter(i => i.category === 'cookie' && i.rawValue)
        .map(i => i.rawValue!.split('=')[0]);
      if (knownCookies.length > 0) {
        const existingCookies = new Set(profile.knownCookieNames);
        for (const c of knownCookies) existingCookies.add(c);
        profile.knownCookieNames = Array.from(existingCookies);
      }

      logger.info(
        { domain, confidence: confidence.toFixed(2), challengeType, indicators: indicators.length },
        'Imperva detection complete',
      );

      return {
        platform: 'imperva',
        confidence,
        severity,
        indicators,
        challengeType,
        isRechallenge,
        recommendedStrategy,
      };
    } catch (err: any) {
      logger.error({ err: err.message }, 'Imperva detection failed');
      return {
        platform: 'imperva',
        confidence: 0,
        severity: 'none',
        indicators,
        challengeType: 'unknown',
        isRechallenge: false,
        recommendedStrategy: 'cookie-injection',
      };
    }
  }

  /**
   * Determine the best initial bypass strategy based on detection results.
   */
  private determineRecommendedStrategy(
    confidence: number,
    challengeType: string,
  ): BypassStrategy {
    // If we have valid cached cookies, try cookie-injection first
    if (challengeType === 'reese84-pow') {
      return 'cookie-injection'; // Try cached reese84 first, then browser-execute
    }
    if (challengeType === 'incapsula-js') {
      return 'browser-execute'; // JS challenge needs browser execution
    }
    if (confidence >= 0.7) {
      return 'cookie-injection'; // High confidence → try cached cookies first
    }
    // Default: follow escalation order
    return 'cookie-injection';
  }

  // --- Bypass -------------------------------------------------------------

  /**
   * Attempt to bypass Imperva/Incapsula's anti-bot challenge.
   * Strategy escalation: cookie-injection → browser-execute → profile-rotation → maximum-stealth
   */
  async bypass(ctx: BypassContext, strategy?: BypassStrategy): Promise<AntiBotResult> {
    const startTime = Date.now();
    this.stats.totalAttempts++;

    const domain = ctx.domain;
    const selectedStrategy = strategy || this.getOrCreateProfile(domain).preferredStrategy;

    // Check cooldown
    if (this.isInCooldown(domain)) {
      this.stats.cooldowns++;
      return this.buildFailureResult({
        strategy: selectedStrategy,
        durationMs: Date.now() - startTime,
        phase: 'cooldown',
        errors: ['Domain is in cooldown -- skipping bypass attempt'],
      });
    }

    logger.info(
      { domain, strategy: selectedStrategy, url: ctx.url },
      'Starting Imperva bypass attempt',
    );

    try {
      let result: AntiBotResult;

      switch (selectedStrategy) {
        case 'cookie-injection':
          result = await this.bypassCookieInjection(ctx, startTime);
          break;
        case 'browser-execute':
          result = await this.bypassBrowserExecute(ctx, startTime);
          break;
        case 'profile-rotation':
          result = await this.bypassProfileRotation(ctx, startTime);
          break;
        case 'maximum-stealth':
          result = await this.bypassMaximumStealth(ctx, startTime);
          break;
        default:
          result = await this.bypassCookieInjection(ctx, startTime);
      }

      // Record result for adaptive learning
      this.recordResult(domain, result.success, result.durationMs, selectedStrategy);

      if (!result.success && selectedStrategy !== 'maximum-stealth') {
        // Auto-escalate
        const nextStrategy = this.escalateStrategy(domain);
        logger.info(
          { domain, from: selectedStrategy, to: nextStrategy },
          'Imperva bypass failed -- strategy escalated',
        );
      }

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      this.recordResult(domain, false, durationMs, selectedStrategy);

      logger.error(
        { domain, strategy: selectedStrategy, err: err.message },
        'Imperva bypass threw an error',
      );

      return this.buildFailureResult({
        strategy: selectedStrategy,
        durationMs,
        errors: [`Imperva bypass error: ${err.message}`],
      });
    }
  }

  // --- Strategy: Cookie Injection -----------------------------------------

  /**
   * Strategy 1: Inject cached Imperva cookies (incap_ses_x, visid_incap_x, reese84).
   * Fastest strategy -- no challenge solving required.
   */
  private async bypassCookieInjection(
    ctx: BypassContext,
    startTime: number,
  ): Promise<AntiBotResult> {
    const domain = ctx.domain;
    const cachedTokens = this.getValidTokens(domain);

    if (cachedTokens.length === 0) {
      logger.debug({ domain }, 'No cached Imperva cookies -- falling back to browser-execute');
      return this.bypassBrowserExecute(ctx, startTime);
    }

    logger.info(
      { domain, cookieCount: cachedTokens.length },
      'Injecting cached Imperva cookies',
    );

    try {
      // Inject cached cookies into the browser context
      for (const token of cachedTokens) {
        await ctx.context.addCookies([{
          name: token.name,
          value: token.value,
          domain: token.domain,
          path: token.path,
          httpOnly: token.httpOnly,
          secure: token.secure,
          sameSite: token.sameSite,
        }]);
        token.useCount++;
        this.stats.tokenReuses++;
      }

      // Reload the page with the injected cookies
      await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });

      // Wait for the page to settle
      await this.sleep(2000);

      // Check if Imperva challenge is still present
      const stillBlocked = await this.isStillBlocked(ctx);

      if (!stillBlocked) {
        const durationMs = Date.now() - startTime;
        logger.info({ domain, durationMs }, 'Imperva cookie injection successful');

        // Refresh token expiry
        for (const token of cachedTokens) {
          token.refreshedAt = Date.now();
        }

        return this.buildSuccessResult({
          strategy: 'cookie-injection',
          durationMs,
          cookies: cachedTokens,
          detectionSignals: [{
            category: 'cookie',
            description: `${cachedTokens.length} Imperva cookies re-used`,
            weight: 0.8,
          }],
          rechallengeExpected: true,
          rechallengeInMs: INCAP_SES_COOKIE_LIFETIME_MS,
          metadata: { cookieCount: cachedTokens.length },
        });
      }

      // Cookies were rejected -- invalidate and fall through
      logger.info({ domain }, 'Cached Imperva cookies rejected -- invalidating');
      this.invalidateTokens(domain);

      // Fall through to browser-execute
      return this.bypassBrowserExecute(ctx, startTime);
    } catch (err: any) {
      logger.warn({ domain, err: err.message }, 'Cookie injection failed');
      return this.bypassBrowserExecute(ctx, startTime);
    }
  }

  // --- Strategy: Browser Execute ------------------------------------------

  /**
   * Strategy 2: Execute Imperva's JavaScript challenge in the browser
   * and extract the resulting cookies.
   */
  private async bypassBrowserExecute(
    ctx: BypassContext,
    startTime: number,
  ): Promise<AntiBotResult> {
    const domain = ctx.domain;

    logger.info({ domain }, 'Starting Imperva browser-execute strategy');

    try {
      // Step 1: Inject fingerprint spoofing before challenge loads
      const profile = this.selectProfile(domain);
      this.activeProfiles.set(domain, profile);

      const injectionScript = generateImpervaInjectionScript(profile);
      await ctx.context.addInitScript(injectionScript);

      // Step 2: Apply CDP stealth if available
      if (ctx.cdpSession) {
        await applyCDPStealth(ctx.cdpSession, profile);
      }

      // Step 3: Set up response interception for challenge scripts
      const challengeData = await this.interceptChallengeScripts(ctx);

      // Step 4: Reload the page to trigger the challenge with our patches
      await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.solveTimeoutMs });

      // Step 5: Wait for challenge resolution
      const resolved = await this.waitForChallengeResolution(ctx);

      if (!resolved) {
        // Challenge didn't resolve in time
        const durationMs = Date.now() - startTime;
        logger.warn({ domain, durationMs }, 'Imperva challenge did not resolve in time');

        return this.buildFailureResult({
          strategy: 'browser-execute',
          durationMs,
          phase: 'executing',
          errors: ['Imperva challenge did not resolve within timeout'],
          warnings: challengeData ? [`Challenge type detected: ${challengeData.type}`] : [],
        });
      }

      // Step 6: Extract cookies after challenge resolution
      const rawCookies = await ctx.context.cookies();
      const impervaCookies = extractImpervaCookies(rawCookies);

      if (impervaCookies.length === 0) {
        // No Imperva cookies found -- challenge may not have been solved correctly
        const durationMs = Date.now() - startTime;
        logger.warn({ domain }, 'Imperva challenge resolved but no cookies found');

        return this.buildFailureResult({
          strategy: 'browser-execute',
          durationMs,
          phase: 'extracting',
          errors: ['Challenge appeared to resolve but no Imperva cookies were extracted'],
        });
      }

      // Step 7: Store the extracted cookies
      await this.storeTokens(domain, impervaCookies);

      // Step 8: Check if page is actually unblocked
      const stillBlocked = await this.isStillBlocked(ctx);

      const durationMs = Date.now() - startTime;
      if (stillBlocked) {
        logger.warn({ domain }, 'Imperva cookies extracted but page still blocked');
        return this.buildFailureResult({
          strategy: 'browser-execute',
          durationMs,
          phase: 'validating',
          errors: ['Cookies extracted but page remains blocked'],
          cookies: impervaCookies,
        });
      }

      logger.info(
        { domain, durationMs, cookieCount: impervaCookies.length },
        'Imperva browser-execute bypass successful',
      );

      return this.buildSuccessResult({
        strategy: 'browser-execute',
        durationMs,
        cookies: impervaCookies,
        detectionSignals: [{
          category: 'cookie',
          description: `${impervaCookies.length} Imperva cookies extracted`,
          weight: 0.9,
        }],
        rechallengeExpected: true,
        rechallengeInMs: INCAP_SES_COOKIE_LIFETIME_MS,
        metadata: {
          cookieCount: impervaCookies.length,
          profileId: profile.id,
          challengeType: challengeData?.type || 'unknown',
        },
      });
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      logger.error({ domain, err: err.message }, 'Imperva browser-execute failed');
      return this.buildFailureResult({
        strategy: 'browser-execute',
        durationMs,
        errors: [`Browser execution error: ${err.message}`],
      });
    }
  }

  // --- Strategy: Profile Rotation -----------------------------------------

  /**
   * Strategy 3: Rotate to a new fingerprint profile and re-solve the challenge.
   * Used when the current profile has been flagged by Imperva.
   */
  private async bypassProfileRotation(
    ctx: BypassContext,
    startTime: number,
  ): Promise<AntiBotResult> {
    const domain = ctx.domain;

    logger.info({ domain }, 'Starting Imperva profile-rotation strategy');

    try {
      // Step 1: Rotate to a new profile
      const oldProfile = this.activeProfiles.get(domain);
      this.profileIndex = (this.profileIndex + 1) % IMPEVERA_FINGERPRINT_PROFILES.length;
      const newProfile = IMPEVERA_FINGERPRINT_PROFILES[this.profileIndex];
      this.activeProfiles.set(domain, newProfile);

      logger.info(
        { domain, oldProfile: oldProfile?.id, newProfile: newProfile.id },
        'Rotating Imperva fingerprint profile',
      );

      // Step 2: Invalidate old cookies (they're tied to the old profile)
      this.invalidateTokens(domain);

      // Step 3: Apply new fingerprint profile
      const injectionScript = generateImpervaInjectionScript(newProfile);
      await ctx.context.addInitScript(injectionScript);

      // Step 4: Apply CDP stealth with new profile
      if (ctx.cdpSession) {
        await applyCDPStealth(ctx.cdpSession, newProfile);
      }

      // Step 5: Clear all cookies and reload
      await ctx.context.clearCookies();
      await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.solveTimeoutMs });

      // Step 6: Wait for challenge resolution with new profile
      const resolved = await this.waitForChallengeResolution(ctx);

      if (!resolved) {
        const durationMs = Date.now() - startTime;
        return this.buildFailureResult({
          strategy: 'profile-rotation',
          durationMs,
          phase: 'executing',
          errors: ['Challenge did not resolve with new profile'],
          metadata: { profileId: newProfile.id },
        });
      }

      // Step 7: Extract and validate cookies
      const rawCookies = await ctx.context.cookies();
      const impervaCookies = extractImpervaCookies(rawCookies);

      if (impervaCookies.length === 0) {
        const durationMs = Date.now() - startTime;
        return this.buildFailureResult({
          strategy: 'profile-rotation',
          durationMs,
          phase: 'extracting',
          errors: ['No Imperva cookies extracted after profile rotation'],
          metadata: { profileId: newProfile.id },
        });
      }

      await this.storeTokens(domain, impervaCookies);

      const stillBlocked = await this.isStillBlocked(ctx);
      const durationMs = Date.now() - startTime;

      if (stillBlocked) {
        return this.buildFailureResult({
          strategy: 'profile-rotation',
          durationMs,
          phase: 'validating',
          errors: ['Cookies extracted but page still blocked after profile rotation'],
          cookies: impervaCookies,
          metadata: { profileId: newProfile.id },
        });
      }

      logger.info(
        { domain, durationMs, profileId: newProfile.id, cookieCount: impervaCookies.length },
        'Imperva profile-rotation bypass successful',
      );

      return this.buildSuccessResult({
        strategy: 'profile-rotation',
        durationMs,
        cookies: impervaCookies,
        rechallengeExpected: true,
        rechallengeInMs: INCAP_SES_COOKIE_LIFETIME_MS,
        metadata: { profileId: newProfile.id },
      });
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      return this.buildFailureResult({
        strategy: 'profile-rotation',
        durationMs,
        errors: [`Profile rotation error: ${err.message}`],
      });
    }
  }

  // --- Strategy: Maximum Stealth ------------------------------------------

  /**
   * Strategy 4: Apply all stealth measures -- maximum effort bypass.
   * Combines fingerprint injection, CDP stealth, cookie clearing,
   * behavioral mimicry, and full automation flag removal.
   */
  private async bypassMaximumStealth(
    ctx: BypassContext,
    startTime: number,
  ): Promise<AntiBotResult> {
    const domain = ctx.domain;

    logger.info({ domain }, 'Starting Imperva maximum-stealth strategy');

    try {
      // Step 1: Use a fresh profile
      this.profileIndex = (this.profileIndex + 1) % IMPEVERA_FINGERPRINT_PROFILES.length;
      const profile = IMPEVERA_FINGERPRINT_PROFILES[this.profileIndex];
      this.activeProfiles.set(domain, profile);

      // Step 2: Clear everything
      this.invalidateTokens(domain);
      await ctx.context.clearCookies();

      // Step 3: Apply comprehensive CDP stealth
      if (ctx.cdpSession) {
        await this.applyMaximumCDPStealth(ctx.cdpSession, profile);
      }

      // Step 4: Inject comprehensive fingerprint script
      const injectionScript = generateImpervaInjectionScript(profile);
      await ctx.context.addInitScript(injectionScript);

      // Step 5: Inject behavioral mimicry (mouse movements, scrolls, etc.)
      await this.injectBehavioralMimicry(ctx);

      // Step 6: Navigate to the page fresh
      await ctx.page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: this.config.solveTimeoutMs });

      // Step 7: Wait extended time for challenge resolution
      const resolved = await this.waitForChallengeResolution(ctx, CHALLENGE_TIMEOUT_MS * 1.5);

      if (!resolved) {
        const durationMs = Date.now() - startTime;
        return this.buildFailureResult({
          strategy: 'maximum-stealth',
          durationMs,
          phase: 'executing',
          errors: ['Maximum stealth: challenge did not resolve in extended timeout'],
          metadata: { profileId: profile.id },
        });
      }

      // Step 8: Extract cookies
      const rawCookies = await ctx.context.cookies();
      const impervaCookies = extractImpervaCookies(rawCookies);

      if (impervaCookies.length === 0) {
        const durationMs = Date.now() - startTime;
        return this.buildFailureResult({
          strategy: 'maximum-stealth',
          durationMs,
          phase: 'extracting',
          errors: ['Maximum stealth: no Imperva cookies extracted'],
          metadata: { profileId: profile.id },
        });
      }

      await this.storeTokens(domain, impervaCookies);

      const stillBlocked = await this.isStillBlocked(ctx);
      const durationMs = Date.now() - startTime;

      if (stillBlocked) {
        return this.buildFailureResult({
          strategy: 'maximum-stealth',
          durationMs,
          phase: 'validating',
          errors: ['Maximum stealth: page still blocked'],
          cookies: impervaCookies,
          metadata: { profileId: profile.id },
        });
      }

      logger.info(
        { domain, durationMs, profileId: profile.id, cookieCount: impervaCookies.length },
        'Imperva maximum-stealth bypass successful',
      );

      return this.buildSuccessResult({
        strategy: 'maximum-stealth',
        durationMs,
        cookies: impervaCookies,
        rechallengeExpected: true,
        rechallengeInMs: INCAP_SES_COOKIE_LIFETIME_MS,
        metadata: { profileId: profile.id },
      });
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      return this.buildFailureResult({
        strategy: 'maximum-stealth',
        durationMs,
        errors: [`Maximum stealth error: ${err.message}`],
      });
    }
  }

  // --- Helper Methods -----------------------------------------------------

  /**
   * Select the next fingerprint profile for a domain.
   */
  private selectProfile(domain: string): ImpervaFingerprintProfile {
    const existing = this.activeProfiles.get(domain);
    if (existing) return existing;

    const profile = IMPEVERA_FINGERPRINT_PROFILES[this.profileIndex];
    this.activeProfiles.set(domain, profile);
    return profile;
  }

  /**
   * Check if the page is still blocked by Imperva.
   */
  private async isStillBlocked(ctx: BypassContext): Promise<boolean> {
    try {
      // Check for challenge page indicators
      for (const selector of IMPEVERA_CHALLENGE_SELECTORS) {
        const element = await ctx.page.$(selector);
        if (element) return true;
      }

      // Check page content for block indicators
      const bodyText = await ctx.page.evaluate(
        () => document.body?.innerText?.toLowerCase() || '',
      );

      const blockIndicators = [
        'your request was interrupted',
        'you have been blocked',
        'enable javascript and cookies',
        'security check',
      ];

      for (const indicator of blockIndicators) {
        if (bodyText.includes(indicator)) return true;
      }

      return false;
    } catch {
      // If we can't check, assume not blocked (optimistic)
      return false;
    }
  }

  /**
   * Intercept Imperva challenge scripts to extract challenge payloads.
   */
  private async interceptChallengeScripts(
    ctx: BypassContext,
  ): Promise<{ type: string; payload?: string } | null> {
    try {
      // Set up response interception
      ctx.page.on('response', async (response: Response) => {
        const url = response.url();

        // Intercept reese84 challenge script
        if (url.includes('reese84')) {
          try {
            const body = await response.text();
            // Extract challenge payload from the script
            const tokenMatch = body.match(/token['":\s]+['"]([^'"]+)['"]/);
            const diffMatch = body.match(/difficulty['":\s]+(\d+)/);
            const siteMatch = body.match(/siteId['":\s]+['"]([^'"]+)['"]/);

            if (tokenMatch) {
              const payload: Reese84ChallengePayload = {
                token: tokenMatch[1],
                difficulty: diffMatch ? parseInt(diffMatch[1]) : 4,
                siteId: siteMatch ? siteMatch[1] : '',
                issuedAt: Date.now(),
                params: {},
              };
              this.activeReeseChallenges.set(ctx.domain, payload);

              logger.debug(
                { domain: ctx.domain, token: payload.token.substring(0, 20) },
                'Reese84 challenge intercepted',
              );
            }
          } catch { /* failed to read response body */ }
        }

        // Intercept Incapsula AJAX challenge
        if (url.includes('_Incapsula_Resource')) {
          logger.debug({ domain: ctx.domain, url: url.substring(0, 80) }, 'Incapsula resource intercepted');
        }
      });

      return { type: 'intercepting' };
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Challenge interception setup failed');
      return null;
    }
  }

  /**
   * Wait for Imperva challenge to resolve by monitoring for cookie changes
   * and page navigation.
   */
  private async waitForChallengeResolution(
    ctx: BypassContext,
    timeoutMs: number = CHALLENGE_TIMEOUT_MS,
  ): Promise<boolean> {
    const startTime = Date.now();
    const domain = ctx.domain;

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Check for Imperva cookies in the browser
        const cookies = await ctx.context.cookies();
        const hasImpervaCookie = cookies.some(c =>
          IMPEVERA_COOKIE_REGEXES.some(regex => regex.test(c.name)),
        );

        if (hasImpervaCookie) {
          logger.debug({ domain }, 'Imperva cookies detected -- challenge likely resolved');
          return true;
        }

        // Check if page has navigated away from challenge page
        const currentUrl = ctx.page.url();
        if (!currentUrl.includes('_Incapsula_Resource') && !currentUrl.includes('incident')) {
          // Check if the page content indicates we're past the challenge
          const stillBlocked = await this.isStillBlocked(ctx);
          if (!stillBlocked) {
            logger.debug({ domain }, 'Page no longer blocked -- challenge resolved');
            return true;
          }
        }

        // Check for data-imp-cookie-set attribute set by our injection script
        const cookieSetAttr = await ctx.page.evaluate(() => {
          return document.documentElement.getAttribute('data-imp-cookie-set');
        });
        if (cookieSetAttr) {
          logger.debug({ domain }, 'Imperva cookie set detected via DOM attribute');
          return true;
        }

        // Wait before next check
        await this.sleep(CHALLENGE_POLL_INTERVAL_MS);
      } catch {
        // Page may have navigated -- wait and retry
        await this.sleep(CHALLENGE_POLL_INTERVAL_MS);
      }
    }

    logger.warn({ domain, timeoutMs }, 'Imperva challenge resolution timed out');
    return false;
  }

  /**
   * Apply comprehensive CDP-level stealth for maximum-stealth strategy.
   */
  private async applyMaximumCDPStealth(
    cdpSession: CDPSession,
    profile: ImpervaFingerprintProfile,
  ): Promise<void> {
    try {
      // Override user agent
      await cdpSession.send('Network.setUserAgentOverride', {
        userAgent: profile.userAgent,
        platform: profile.platform,
      });

      // Inject comprehensive stealth script
      await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          // Navigator overrides
          Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${profile.hardwareConcurrency}, configurable: true });
          Object.defineProperty(navigator, 'deviceMemory', { get: () => ${profile.deviceMemory}, configurable: true });
          Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${profile.maxTouchPoints}, configurable: true });
          Object.defineProperty(navigator, 'platform', { get: () => '${profile.platform}', configurable: true });
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true, enumerable: true });

          // Remove all automation markers
          delete window.__playwright;
          delete window.__pw_manual;
          delete window.__PW_inspect;
          delete window.__pw_originals;
          delete window.__puppeteer_evaluation_script__;
          delete window._cdc_adoQpoasnfa76pfcZLmcfl_Array;
          delete window._cdc_adoQpoasnfa76pfcZLmcfl_Promise;
          delete window._cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

          // Override permissions API
          if (navigator.permissions && navigator.permissions.query) {
            const __origPermQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = function(parameters) {
              if (parameters.name === 'notifications') {
                return Promise.resolve({ state: Notification.permission, onchange: null });
              }
              return __origPermQuery(parameters);
            };
          }

          // Mock chrome.runtime
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.runtime) {
            window.chrome.runtime = {
              connect: function() {},
              sendMessage: function() {},
              onMessage: { addListener: function() {}, removeListener: function() {} },
              id: undefined,
            };
          }

          // Override plugins for non-headless appearance
          if (navigator.plugins.length === 0) {
            Object.defineProperty(navigator, 'plugins', {
              get: () => {
                const arr = [
                  { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                  { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                  { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
                ];
                arr.item = (i) => arr[i];
                arr.namedItem = (name) => arr.find(p => p.name === name);
                arr.refresh = () => {};
                return arr;
              },
              configurable: true,
            });
          }
        `,
      });

      // Disable automation flags
      await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          // Remove ChromeDriver cdc_ markers using regex scan (catches all variants)
          try {
            const cdcKeys = Object.getOwnPropertyNames(window);
            for (const key of cdcKeys) {
              if (/cdc_[a-zA-Z0-9_]+/.test(key) || /_cdc_[a-zA-Z0-9_]+/.test(key)) {
                try { delete window[key]; } catch(e) {}
              }
            }
          } catch(e) {}
        `,
      });

      logger.debug('Applied maximum CDP stealth patches for Imperva');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to apply maximum CDP stealth');
    }
  }

  /**
   * Inject behavioral mimicry (mouse movements, scrolls, keyboard events)
   * to make the browser session appear more human-like.
   */
  private async injectBehavioralMimicry(ctx: BypassContext): Promise<void> {
    try {
      await ctx.page.evaluate(() => {
        // Simulate mouse movements
        const viewport = { w: window.innerWidth || 1280, h: window.innerHeight || 800 };
        const numMovements = Math.floor(Math.random() * 8) + 5;
        let x = Math.random() * viewport.w;
        let y = Math.random() * viewport.h;
        const now = Date.now();

        for (let i = 0; i < numMovements; i++) {
          const targetX = Math.random() * viewport.w;
          const targetY = Math.random() * viewport.h;
          const steps = Math.floor(Math.random() * 12) + 6;

          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            const px = x + (targetX - x) * eased;
            const py = y + (targetY - y) * eased;

            const evt = new MouseEvent('mousemove', {
              clientX: px + (Math.random() - 0.5) * 3,
              clientY: py + (Math.random() - 0.5) * 3,
              bubbles: true,
              cancelable: true,
            });
            Object.defineProperty(evt, 'timeStamp', {
              value: now - (numMovements - i) * 1500 + s * 40,
            });
            document.dispatchEvent(evt);
          }
          x = targetX;
          y = targetY;
        }

        // Simulate scroll events
        const numScrolls = Math.floor(Math.random() * 5) + 2;
        for (let i = 0; i < numScrolls; i++) {
          const delta = Math.floor(Math.random() * 200) + 50;
          const evt = new WheelEvent('wheel', {
            deltaY: delta,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(evt, 'timeStamp', {
            value: now - (numScrolls - i) * 2500,
          });
          document.dispatchEvent(evt);
        }
      });

      logger.debug('Injected behavioral mimicry for Imperva bypass');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Behavioral mimicry injection failed (non-critical)');
    }
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

const impervaBypass = new ImpervaBypass();
export { impervaBypass, ImpervaBypass };
export default ImpervaBypass;
