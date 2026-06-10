/**
 * Web Unlocker -- HYPERDRIVE MEGA EDITION for ScrapeSuite Engine.
 *
 * Massive rewrite with all enhancements:
 *  -------------------------------------------------------------------------
 *  * Browser pool: 10 browsers (was 5) with faster recycling (20 requests before recycle)
 *  * Rendering timeout: 15s max (was likely 30s)
 *  * 5 stealth levels: Basic, Light, Medium, High, Maximum
 *  * Human behavior simulation: realistic mouse movements, typing patterns, scroll patterns
 *  * Fingerprint rotation: rotate every 10 requests (was likely 50)
 *  * Cookie management: smarter cookie jar with domain-specific policies
 *  * Resource optimization: smarter blocking strategies with context-aware rules
 *  * Auto-retry: smarter escalation with 7 escalation levels
 *  * CAPTCHA integration: direct integration with captcha-solver for auto-solving
 *  * Unlocker intelligence: learn which strategies work for which domains
 *  * Session persistence: maintain browser sessions across requests for same domain
 *  * Challenge library: pre-built solutions for common anti-bot challenges
 *    - Cloudflare UAM, Cloudflare Turnstile, PerimeterX, Akamai Bot Manager
 *    - DataDome, Kasada, Shape Security/F5, Imperva/Incapsula
 *  * Comprehensive real-time metrics and monitoring
 *  * Adaptive retry backoff with exponential + jitter strategy
 *  * Domain-specific cookie policies with priority classification
 *  * Smart resource blocking: context-aware per strategy/stealth level
 *  * Fingerprint consistency tracking across sessions
 *  * Warm browser pool with pre-initialized contexts
 *  -------------------------------------------------------------------------
 */

import { chromium, type Browser, type BrowserContext, type Page, type Cookie } from 'playwright';
import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { proxyFetch } from '../utils/proxy-fetch';
import { stealthEngine } from '../anti-bot/stealth';
import { humanBehavior } from '../anti-bot/human-behavior';
import { cdpInjectionEngine, type CdpInjectionResult } from '../anti-bot/cdp-injection';
import { deepBrowserPatcher } from '../anti-bot/deep-patcher';

const logger = createChildLogger('web-unlocker');

// --- Exported Types ------------------------------------------------------------

export type StealthLevel = 'basic' | 'light' | 'medium' | 'high' | 'maximum';
export type UnlockStrategy = 'http' | 'browser' | 'stealth' | 'auto';

export interface UnlockRequest {
  url: string;
  domain?: string;
  strategy?: UnlockStrategy;
  stealthLevel?: StealthLevel;
  proxyUrl?: string;
  proxyTier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  proxyCountry?: string;
  headers?: Record<string, string>;
  waitForSelector?: string;
  waitAfterLoadMs?: number;
  timeout?: number;
  solveCaptcha?: boolean;
  blockResources?: ('image' | 'stylesheet' | 'font' | 'media')[];
  extractData?: string;
  sessionId?: string;
  maxRetries?: number;
  /** Enable human behavior simulation (mouse, typing, scrolling) */
  simulateHuman?: boolean;
  /** Force a specific escalation path */
  escalationPath?: EscalationLevel[];
}

export interface UnlockResult {
  success: boolean;
  html?: string;
  statusCode?: number;
  finalUrl?: string;
  extractedData?: Record<string, any>;
  captchaDetected: boolean;
  captchaSolved: boolean;
  captchaType?: string;
  strategy: UnlockStrategy;
  stealthLevel: StealthLevel;
  proxyUsed: boolean;
  proxyId?: string;
  retries: number;
  escalationLevel: number;
  renderTimeMs: number;
  totalTimeMs: number;
  fingerprintRotated: boolean;
  sessionUsed: boolean;
  challengeUsed: string | null;
  error?: string;
}

export interface BrowserProfile {
  userAgent: string;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  platform: string;
  webGlVendor: string;
  webGlRenderer: string;
  screenResolution: { width: number; height: number };
  colorDepth: number;
  deviceMemory: number;
  hardwareConcurrency: number;
}

export interface WebUnlockerStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  captchaDetected: number;
  captchaSolved: number;
  avgRenderTimeMs: number;
  avgTotalTimeMs: number;
  fingerprintRotations: number;
  sessionHits: number;
  challengeLibraryHits: number;
  byStrategy: Record<UnlockStrategy, { count: number; successRate: number; avgTime: number }>;
  byStealthLevel: Record<StealthLevel, { count: number; successRate: number }>;
  byDomain: Record<string, { requests: number; successRate: number; avgTime: number; captchaRate: number; bestStrategy: UnlockStrategy; bestStealthLevel: StealthLevel }>;
  activeBrowsers: number;
  browserPoolSize: number;
  queuedRequests: number;
  unlockerIntelligence: Record<string, { bestStrategy: UnlockStrategy; bestStealthLevel: StealthLevel; successRate: number; avgTime: number; sampleCount: number }>;
}

// --- Internal Types ------------------------------------------------------------

interface PooledBrowser {
  id: string;
  browser: Browser;
  requestCount: number;
  createdAt: number;
  lastUsed: number;
  isBusy: boolean;
  fingerprintId: string;
  domainAffinity: string | null;
  /** Track which domains this browser has visited for consistency */
  visitedDomains: Set<string>;
  /** Health score for this browser instance (0-1) */
  healthScore: number;
  /** Number of consecutive failures on this browser */
  consecutiveFailures: number;
  /** Total successful renders */
  successCount: number;
}

interface QueuedRequest {
  resolve: (result: UnlockResult) => void;
  reject: (error: Error) => void;
  request: UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel };
  enqueuedAt: number;
  /** Priority level for queue ordering (lower = higher priority) */
  priority: number;
}

interface SessionState {
  cookies: Cookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  domain: string;
  createdAt: number;
  lastUsed: number;
  requestCount: number;
  fingerprintId: string;
  /** User agent used when session was created -- must match for consistency */
  userAgent: string;
  /** Proxy tier used when session was created */
  proxyTier: 'residential' | 'mobile' | 'datacenter' | 'isp' | undefined;
  /** Total number of times this session has been reused */
  reuseCount: number;
}

interface DomainIntelligence {
  domain: string;
  bestStrategy: UnlockStrategy;
  bestStealthLevel: StealthLevel;
  successRate: number;
  avgTime: number;
  sampleCount: number;
  lastUpdated: number;
  knownChallenges: string[];
  preferredProxyTier: 'residential' | 'mobile' | 'datacenter' | 'isp';
  /** EMA (exponential moving average) of recent success rates -- more responsive */
  emaSuccessRate: number;
  /** Recent result window for EMA calculation */
  recentResults: Array<{ success: boolean; timestamp: number; strategy: UnlockStrategy; stealthLevel: StealthLevel }>;
  /** Strategy attempts that failed -- helps avoid repeating bad strategies */
  failedStrategies: Array<{ strategy: UnlockStrategy; stealthLevel: StealthLevel; timestamp: number }>;
  /** Peak render time observed for this domain */
  peakRenderTimeMs: number;
  /** Minimum render time observed */
  minRenderTimeMs: number;
  /** Whether the domain typically requires CAPTCHA solving */
  typicallyRequiresCaptcha: boolean;
  /** Whether the domain typically requires session persistence */
  typicallyRequiresSession: boolean;
}

interface ChallengeLibraryEntry {
  name: string;
  domainPattern: RegExp;
  challengeType: string;
  solution: string;
  successRate: number;
  lastUsed: number;
  /** Detailed detection selectors for this challenge type */
  detectionSelectors: string[];
  /** Detection text patterns for this challenge type */
  detectionText: string[];
  /** Header signatures for this challenge type */
  detectionHeaders: string[];
  /** Priority order (lower = checked first) */
  priority: number;
  /** Number of times this solution has been applied */
  appliedCount: number;
  /** Number of times this solution succeeded */
  successCount: number;
}

/** Cookie priority classification for domain-specific policies */
type CookiePriority = 'critical' | 'important' | 'standard' | 'discard';

interface ClassifiedCookie {
  cookie: Cookie;
  priority: CookiePriority;
  /** Reason for the classification */
  reason: string;
}

// --- Escalation Levels --------------------------------------------------------

type EscalationLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const ESCALATION_LABELS: Record<EscalationLevel, string> = {
  0: 'original-strategy',
  1: 'upgrade-stealth',
  2: 'upgrade-to-browser',
  3: 'upgrade-to-stealth',
  4: 'maximum-stealth-residential',
  5: 'maximum-stealth-mobile-fingerprint-rotate',
  6: 'full-nuclear-session-reset',
};

// --- Constants -----------------------------------------------------------------

const MAX_CONCURRENT_BROWSERS = 10;       // 10 (was 5)
const MIN_POOL_SIZE = 3;                  // 3 (was 2)
const MAX_REQUESTS_PER_BROWSER = 20;      // 20 -- faster recycling (was 30)
const BROWSER_IDLE_TIMEOUT_MS = 2 * 60 * 1000;  // 2min -- faster idle timeout (was 3min)
const DEFAULT_TIMEOUT_MS = 15_000;        // 15s (was 30s)
const DEFAULT_MAX_RETRIES = 7;            // 7 escalation levels
const COOKIE_TTL_SECONDS = 3600;
const SESSION_TTL_SECONDS = 1800;
const DOMAIN_PROFILE_CACHE_TTL = 300;
const FINGERPRINT_ROTATION_INTERVAL = 10; // Rotate every 10 requests (was ~50)
const MAX_DOMAIN_INTELLIGENCE = 1000;
const CHALLENGE_LIBRARY_CACHE_TTL = 600;
const INTELLIGENCE_MIN_SAMPLES = 3;       // Minimum samples before trusting intelligence
const INTELLIGENCE_EMA_ALPHA = 0.3;       // EMA smoothing factor for intelligence
const INTELLIGENCE_RECENT_WINDOW_MS = 300_000;  // 5-minute window for recent results
const RETRY_BACKOFF_BASE_MS = 500;        // Base backoff for retries
const RETRY_BACKOFF_MAX_MS = 8_000;       // Maximum backoff for retries
const SESSION_MAX_REUSE = 50;             // Max times a session can be reused
const BROWSER_HEALTH_THRESHOLD = 0.5;     // Below this, browser gets recycled
const QUEUE_PRIORITY_HIGH = 0;
const QUEUE_PRIORITY_NORMAL = 1;
const QUEUE_PRIORITY_LOW = 2;
const QUEUE_MAX_WAIT_MS = 60_000;         // Max time a request can wait in queue

// --- Anti-Bot Challenge Detection ---------------------------------------------

const CF_CHALLENGE_SELECTORS = [
  '#challenge-running',
  '#cf-challenge-running',
  '.cf-browser-verification',
  '#challenge-form',
  '#challenge-stage',
  '#challenge-error-title',
  '.challenge-platform',
  '#turnstile-wrapper',
  '.cf-turnstile',
  '#cf-please-wait',
  '#challenge-spinner',
];

const TURNSTILE_SELECTOR = '[data-sitekey]';
const CF_CHALLENGE_TEXT = [
  'just a moment',
  'checking your browser',
  'cf-browser-verification',
  'challenge-platform',
  'checking if the site connection is secure',
  'please wait while we check your browser',
  'this process is automatic',
  'verifying you are human',
  'your browser will redirect to',
];

// DataDome detection selectors
const DATADOME_SELECTORS = [
  '#datadome-captcha',
  '.datadome-challenge',
  '[data-datadome]',
  '#dd-captcha',
  '.dd-challenge-frame',
];

const DATADOME_TEXT = [
  'datadome',
  'dd_key',
  'ddkey',
  'data-dome',
  'protected by datadome',
  'datadome captcha',
];

// Akamai detection selectors
const AKAMAI_SELECTORS = [
  '#ak-challenge',
  '.ak-challenge',
  '#akamai-challenge',
  '[data-akamai]',
  '#sec-cpt-if',
  '#sec-cpt-int-if',
];

const AKAMAI_TEXT = [
  'akamai',
  '_abck',
  'akamai_swf',
  'akamai sensor data',
  'bm-sensor',
];

// PerimeterX detection selectors
const PERIMETERX_SELECTORS = [
  '#px-captcha',
  '.px-captcha',
  '#px-modal',
  '.px-modal-content',
  '[data-px-captcha]',
  '#pxhmp',
];

const PERIMETERX_TEXT = [
  'perimeterx',
  '_px3',
  'px-captcha',
  'human challenge',
  'are you human',
  'pxfem',
];

// Kasada detection selectors
const KASADA_SELECTORS = [
  '#kasada-challenge',
  '.kasada-captcha',
  '[data-kasada]',
  '#ksd-challenge',
];

const KASADA_TEXT = [
  'kasada',
  'ksd',
  'x-kpsdk',
  'kpsdk_cc',
  'cdkct',
];

// Shape Security/F5 detection selectors
const SHAPE_SELECTORS = [
  '#shape-challenge',
  '.shape-captcha',
  '[data-shape]',
  '#fxm-challenge',
];

const SHAPE_TEXT = [
  'shape security',
  'f5 networks',
  'fxm',
  'shape.com',
  '_fxm',
  'x-f5-auth',
];

// Imperva/Incapsula detection selectors
const IMPErVA_SELECTORS = [
  '#incapsula-challenge',
  '.incapsula-captcha',
  '[data-incapsula]',
  '#imperva-challenge',
];

const IMPErVA_TEXT = [
  'incapsula',
  'imperva',
  'visid_incap',
  'incap_ses',
  'x-iinfo',
  'reese84',
];

// --- Resource Type Mapping ----------------------------------------------------

const RESOURCE_BLOCK_PATTERNS: Record<string, RegExp[]> = {
  image: [
    /\.(png|jpg|jpeg|gif|svg|ico|webp|avif|bmp|tiff|tif)$/i,
    /\/image\//i,
    /cdn.*\/img\//i,
    /static.*\/images?\//i,
    /media.*\/image/i,
  ],
  stylesheet: [
    /\.(css)$/i,
    /\/styles?\//i,
    /\/css\//i,
  ],
  font: [
    /\.(woff|woff2|ttf|eot|otf)$/i,
    /\/fonts?\//i,
    /fonts\.googleapis/i,
    /fonts\.gstatic/i,
  ],
  media: [
    /\.(mp4|mp3|avi|mov|wmv|flv|wav|ogg|webm|m4a|aac|flac)$/i,
    /\/video\//i,
    /\/audio\//i,
    /youtube.*videoplayback/i,
  ],
  analytics: [
    /google-analytics\.com/i,
    /googletagmanager\.com/i,
    /analytics\.twitter\.com/i,
    /facebook\.net.*\/fbevents/i,
    /connect\.facebook\.net/i,
    /sentry\.io/i,
    /newrelic\.com/i,
    /hotjar\.com/i,
    /clarity\.ms/i,
  ],
  social: [
    /platform\.twitter\.com/i,
    /apis\.google\.com\/js/i,
    /connect\.facebook\.net/i,
    /linkedin\.com\/li\/track/i,
  ],
};

/**
 * Smart resource blocking rules based on strategy and stealth level.
 * Key insight: stealth mode must load everything to appear natural.
 * Non-stealth modes can aggressively block for speed.
 */
const SMART_BLOCK_RULES: Record<UnlockStrategy, Record<StealthLevel, ('image' | 'stylesheet' | 'font' | 'media' | 'analytics' | 'social')[]>> = {
  http: {
    basic: ['image', 'media', 'analytics', 'social'],
    light: ['image', 'media', 'analytics', 'social'],
    medium: ['image', 'media', 'font', 'analytics', 'social'],
    high: ['image', 'media', 'font', 'analytics', 'social'],
    maximum: ['image', 'media', 'font', 'analytics', 'social'],
  },
  browser: {
    basic: ['media', 'analytics', 'social'],
    light: ['media', 'analytics', 'social'],
    medium: ['font', 'media', 'analytics', 'social'],
    high: ['analytics', 'social'],
    maximum: [],
  },
  stealth: {
    basic: ['analytics', 'social'],
    light: ['analytics', 'social'],
    medium: ['analytics', 'social'],
    high: [],
    maximum: [],  // Load EVERYTHING in maximum stealth
  },
  auto: {
    basic: ['media', 'analytics', 'social'],
    light: ['media', 'analytics', 'social'],
    medium: ['font', 'media', 'analytics', 'social'],
    high: ['analytics', 'social'],
    maximum: [],
  },
};

// --- Stealth Init Scripts by Level --------------------------------------------

const BASIC_STEALTH_SCRIPT = `
  // --- Basic Stealth: minimal ------------------------------
  // Remove the most obvious automation flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
`;

const LIGHT_STEALTH_SCRIPT = `
  // --- Light Stealth: basic + Playwright markers -----------
  // Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  // Remove Playwright markers
  delete window.__playwright;
  delete window.__pw_manual;
  delete window.__PW_inspect;
  // Remove CDP markers
  delete window.__cdp_bindings__;
  // Remove Puppeteer markers
  delete window.__puppeteer_evaluation_script__;
  delete window._cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window._cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window._cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
`;

const MEDIUM_STEALTH_SCRIPT = `
  // --- Medium Stealth: light + chrome runtime --------------
  ${LIGHT_STEALTH_SCRIPT}

  // Mock chrome runtime
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} }; },
      sendMessage: function() {},
      onMessage: { addListener: function() {} },
      id: undefined,
    };
  }

  // Fix navigator.plugins (empty plugins is suspicious)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    },
    configurable: true,
  });

  // Fix Permissions API
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications' ?
      Promise.resolve({ state: Notification.permission }) :
      originalQuery(parameters)
  );
`;

// --- Challenge Library -- ENHANCED with Detection Signatures -------------------

const DEFAULT_CHALLENGE_LIBRARY: ChallengeLibraryEntry[] = [
  {
    name: 'cloudflare-uam',
    domainPattern: /./i,
    challengeType: 'cloudflare',
    solution: 'wait-and-verify',
    successRate: 0.85,
    lastUsed: 0,
    detectionSelectors: CF_CHALLENGE_SELECTORS,
    detectionText: CF_CHALLENGE_TEXT,
    detectionHeaders: ['cf-ray', 'server:cloudflare'],
    priority: 1,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'cloudflare-turnstile',
    domainPattern: /./i,
    challengeType: 'turnstile',
    solution: 'captcha-solve',
    successRate: 0.9,
    lastUsed: 0,
    detectionSelectors: [TURNSTILE_SELECTOR, '.cf-turnstile', '#turnstile-wrapper'],
    detectionText: ['cf-turnstile', 'challenges.cloudflare.com/turnstile'],
    detectionHeaders: ['cf-ray'],
    priority: 2,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'datadome',
    domainPattern: /datadome/i,
    challengeType: 'datadome',
    solution: 'stealth-redirect',
    successRate: 0.7,
    lastUsed: 0,
    detectionSelectors: DATADOME_SELECTORS,
    detectionText: DATADOME_TEXT,
    detectionHeaders: ['x-datadome', 'set-cookie:datadome'],
    priority: 3,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'akamai-bot-manager',
    domainPattern: /akamai/i,
    challengeType: 'akamai',
    solution: 'sensor-data-spoof',
    successRate: 0.65,
    lastUsed: 0,
    detectionSelectors: AKAMAI_SELECTORS,
    detectionText: AKAMAI_TEXT,
    detectionHeaders: ['x-akamai-transformed', 'set-cookie:_abck'],
    priority: 4,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'perimeterx',
    domainPattern: /perimeterx|px-captcha/i,
    challengeType: 'perimeterx',
    solution: 'script-injection-bypass',
    successRate: 0.6,
    lastUsed: 0,
    detectionSelectors: PERIMETERX_SELECTORS,
    detectionText: PERIMETERX_TEXT,
    detectionHeaders: ['set-cookie:_px'],
    priority: 5,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'imperva-incapsula',
    domainPattern: /incapsula|imperva/i,
    challengeType: 'imperva',
    solution: 'cookie-forging',
    successRate: 0.7,
    lastUsed: 0,
    detectionSelectors: IMPErVA_SELECTORS,
    detectionText: IMPErVA_TEXT,
    detectionHeaders: ['x-iinfo', 'set-cookie:visid_incap'],
    priority: 6,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'kasada',
    domainPattern: /kasada/i,
    challengeType: 'kasada',
    solution: 'x-kpsdk-bypass',
    successRate: 0.55,
    lastUsed: 0,
    detectionSelectors: KASADA_SELECTORS,
    detectionText: KASADA_TEXT,
    detectionHeaders: ['x-kpsdk', 'set-cookie:kpsdk_cc'],
    priority: 7,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'shape-security-f5',
    domainPattern: /shape|f5/i,
    challengeType: 'shape',
    solution: 'fxm-bypass',
    successRate: 0.5,
    lastUsed: 0,
    detectionSelectors: SHAPE_SELECTORS,
    detectionText: SHAPE_TEXT,
    detectionHeaders: ['x-f5-auth', 'set-cookie:_fxm'],
    priority: 8,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'recaptcha-v2-enterprise',
    domainPattern: /recaptcha.*enterprise/i,
    challengeType: 'recaptcha',
    solution: 'captcha-solve-enterprise',
    successRate: 0.85,
    lastUsed: 0,
    detectionSelectors: ['.g-recaptcha', '[data-sitekey]', '#recaptcha'],
    detectionText: ['recaptcha', 'g-recaptcha', 'google.com/recaptcha', 'recaptcha enterprise'],
    detectionHeaders: [],
    priority: 9,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'hcaptcha-secure',
    domainPattern: /hcaptcha/i,
    challengeType: 'hcaptcha',
    solution: 'captcha-solve',
    successRate: 0.8,
    lastUsed: 0,
    detectionSelectors: ['.h-captcha', '[data-hcaptcha-sitekey]', '#hcaptcha'],
    detectionText: ['hcaptcha', 'h-captcha'],
    detectionHeaders: [],
    priority: 10,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'aws-waf-challenge',
    domainPattern: /aws.*waf|cloudfront/i,
    challengeType: 'aws_waf',
    solution: 'token-injection',
    successRate: 0.75,
    lastUsed: 0,
    detectionSelectors: ['#aws-waf-captcha', '.aws-waf-challenge', '[data-aws-waf]'],
    detectionText: ['aws-waf-captcha', 'aws waf', 'awswaf'],
    detectionHeaders: ['x-amz-cf-id', 'x-amzn-requestid'],
    priority: 11,
    appliedCount: 0,
    successCount: 0,
  },
  {
    name: 'salesforce-visualforce',
    domainPattern: /force\.com|salesforce/i,
    challengeType: 'salesforce',
    solution: 'session-hijack',
    successRate: 0.6,
    lastUsed: 0,
    detectionSelectors: ['.sf-captcha', '#salesforce-captcha'],
    detectionText: ['salesforce', 'visualforce', 'lightning captcha'],
    detectionHeaders: [],
    priority: 12,
    appliedCount: 0,
    successCount: 0,
  },
];

// --- Cookie Priority Classification Rules -------------------------------------

/**
 * Domain-specific cookie classification rules.
 * Critical cookies (cf_clearance, etc.) must never be discarded.
 * Important cookies should be preserved across sessions.
 * Standard cookies follow normal TTL rules.
 * Discard cookies are low-value tracking cookies we can drop.
 */
const COOKIE_CLASSIFICATION_RULES: Array<{
  pattern: RegExp;
  priority: CookiePriority;
  reason: string;
}> = [
  // Cloudflare critical cookies
  { pattern: /^cf_clearance$/i, priority: 'critical', reason: 'CF challenge clearance token' },
  { pattern: /^__cf_bm$/i, priority: 'important', reason: 'CF bot management cookie' },
  { pattern: /^cf_chl_rc$/i, priority: 'important', reason: 'CF challenge retry count' },

  // Akamai critical cookies
  { pattern: /^_abck$/i, priority: 'critical', reason: 'Akamai bot detection cookie' },
  { pattern: /^ak_bmsc$/i, priority: 'important', reason: 'Akamai session cookie' },
  { pattern: /^bm_sz$/i, priority: 'important', reason: 'Akamai bot manager size' },
  { pattern: /^bm_sv$/i, priority: 'important', reason: 'Akamai bot manager server' },

  // DataDome cookies
  { pattern: /^datadome$/i, priority: 'critical', reason: 'DataDome session cookie' },
  { pattern: /^dd_$/i, priority: 'important', reason: 'DataDome tracking cookie' },

  // PerimeterX cookies
  { pattern: /^_px\d?$/i, priority: 'critical', reason: 'PerimeterX session cookie' },
  { pattern: /^_pxff_cc$/i, priority: 'important', reason: 'PerimeterX fingerprint cookie' },
  { pattern: /^_px2$/i, priority: 'important', reason: 'PerimeterX session cookie v2' },
  { pattern: /^pxhd$/i, priority: 'important', reason: 'PerimeterX header data' },

  // Imperva/Incapsula cookies
  { pattern: /^visid_incap_/i, priority: 'critical', reason: 'Incapsula visitor ID' },
  { pattern: /^incap_ses_/i, priority: 'critical', reason: 'Incapsula session' },
  { pattern: /^nlbi_/i, priority: 'important', reason: 'Incapsula load balancer' },
  { pattern: /^reese84$/i, priority: 'important', reason: 'Imperva reese84 token' },

  // Kasada cookies
  { pattern: /^kpsdk_cc$/i, priority: 'critical', reason: 'Kasada client cookie' },
  { pattern: /^kpsdk_st$/i, priority: 'important', reason: 'Kasada state token' },

  // Shape Security cookies
  { pattern: /^_fxm$/i, priority: 'critical', reason: 'Shape FXM token' },
  { pattern: /^fxsid$/i, priority: 'important', reason: 'Shape session ID' },

  // AWS WAF cookies
  { pattern: /^aws-waf-token$/i, priority: 'critical', reason: 'AWS WAF token' },
  { pattern: /^x-aws-waf-/i, priority: 'important', reason: 'AWS WAF session' },

  // Session cookies
  { pattern: /^session_?id$/i, priority: 'critical', reason: 'Session ID' },
  { pattern: /^sess$/i, priority: 'critical', reason: 'Session token' },
  { pattern: /^PHPSESSID$/i, priority: 'critical', reason: 'PHP session' },
  { pattern: /^JSESSIONID$/i, priority: 'critical', reason: 'Java session' },
  { pattern: /^ASP\.NET_SessionId$/i, priority: 'critical', reason: 'ASP.NET session' },
  { pattern: /^_session_id$/i, priority: 'critical', reason: 'Rails session' },
  { pattern: /^connect\.sid$/i, priority: 'critical', reason: 'Connect/Express session' },

  // Auth cookies
  { pattern: /^token$/i, priority: 'important', reason: 'Auth token' },
  { pattern: /^auth/i, priority: 'important', reason: 'Authentication cookie' },
  { pattern: /^jwt$/i, priority: 'important', reason: 'JWT token' },
  { pattern: /^csrf/i, priority: 'important', reason: 'CSRF protection token' },
  { pattern: /^xsrf/i, priority: 'important', reason: 'XSRF protection token' },

  // Discard: analytics and tracking
  { pattern: /^_ga$/i, priority: 'discard', reason: 'Google Analytics' },
  { pattern: /^_gid$/i, priority: 'discard', reason: 'Google Analytics' },
  { pattern: /^_gat$/i, priority: 'discard', reason: 'Google Analytics' },
  { pattern: /^_fbp$/i, priority: 'discard', reason: 'Facebook pixel' },
  { pattern: /^_fbc$/i, priority: 'discard', reason: 'Facebook click' },
  { pattern: /^_hjid$/i, priority: 'discard', reason: 'Hotjar' },
  { pattern: /^_hjSessionUser$/i, priority: 'discard', reason: 'Hotjar session' },
  { pattern: /^mp_/i, priority: 'discard', reason: 'Mixpanel' },
  { pattern: /^amplitude/i, priority: 'discard', reason: 'Amplitude' },
  { pattern: /^intercom/i, priority: 'discard', reason: 'Intercom' },
  { pattern: /^hubspot/i, priority: 'discard', reason: 'HubSpot' },
  { pattern: /^__utm/i, priority: 'discard', reason: 'UTM tracking' },
  { pattern: /^_ym_/i, priority: 'discard', reason: 'Yandex Metrica' },
  { pattern: /^_gcl_/i, priority: 'discard', reason: 'Google click linker' },
  { pattern: /^_dc_gtm/i, priority: 'discard', reason: 'Google Tag Manager' },
];

// --- Timezone Pool for Fingerprint Diversity ----------------------------------

const TIMEZONE_POOL = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'America/Toronto', 'America/Vancouver',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Amsterdam',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Warsaw',
  'Asia/Tokyo', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Seoul',
  'Asia/Shanghai', 'Asia/Taipei', 'Asia/Bangkok', 'Asia/Dubai',
  'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland',
  'America/Sao_Paulo', 'America/Mexico_City', 'America/Buenos_Aires',
];

const LOCALE_POOL = [
  'en-US', 'en-GB', 'en-CA', 'en-AU', 'en-NZ', 'en-IE', 'en-ZA',
  'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'pt-BR', 'ja-JP', 'ko-KR',
  'zh-CN', 'zh-TW', 'nl-NL', 'sv-SE', 'pl-PL', 'da-DK', 'fi-FI',
];

// --- Utility Functions ---------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomGaussian(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(mean + z0 * stdDev);
}

/**
 * Calculate exponential backoff with jitter for retries.
 * Uses decorrelated jitter strategy for better distribution.
 */
function calculateRetryBackoff(attempt: number, baseMs: number = RETRY_BACKOFF_BASE_MS, maxMs: number = RETRY_BACKOFF_MAX_MS): number {
  // Exponential backoff with jitter
  const exponentialDelay = baseMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxMs);
  // Add jitter: random value between 0 and 50% of the delay
  const jitter = Math.floor(Math.random() * cappedDelay * 0.5);
  return cappedDelay + jitter;
}

// --- WebUnlocker Class -- HYPERDRIVE MEGA EDITION ------------------------------

export class WebUnlocker {
  private browserPool: PooledBrowser[] = [];
  private requestQueue: QueuedRequest[] = [];
  private activeRequests = 0;
  private sessionCache = new Map<string, SessionState>();
  private domainSessions: Map<string, string> = new Map(); // domain → sessionId
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private intelligenceSyncTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private globalRequestCount = 0;

  // Unlocker intelligence -- learn which strategies work for which domains
  private domainIntelligence: Map<string, DomainIntelligence> = new Map();

  // Challenge library with runtime updates
  private challengeLibrary: ChallengeLibraryEntry[] = [...DEFAULT_CHALLENGE_LIBRARY];

  // Stats tracking
  private stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    captchaDetected: 0,
    captchaSolved: 0,
    totalRenderTimeMs: 0,
    totalTotalTimeMs: 0,
    fingerprintRotations: 0,
    sessionHits: 0,
    challengeLibraryHits: 0,
    byStrategy: {
      http: { count: 0, successCount: 0, totalTime: 0 },
      browser: { count: 0, successCount: 0, totalTime: 0 },
      stealth: { count: 0, successCount: 0, totalTime: 0 },
      auto: { count: 0, successCount: 0, totalTime: 0 },
    } as Record<UnlockStrategy, { count: number; successCount: number; totalTime: number }>,
    byStealthLevel: {
      basic: { count: 0, successCount: 0 },
      light: { count: 0, successCount: 0 },
      medium: { count: 0, successCount: 0 },
      high: { count: 0, successCount: 0 },
      maximum: { count: 0, successCount: 0 },
    } as Record<StealthLevel, { count: number; successCount: number }>,
    byDomain: {} as Record<string, { count: number; successCount: number; totalTime: number; captchaCount: number; bestStrategy: UnlockStrategy; bestStealthLevel: StealthLevel }>,
  };

  // --- Public API ------------------------------------------------------------

  /**
   * Initialize the Web Unlocker: pre-launch browsers, start maintenance timer,
   * load intelligence, and prepare challenge library.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info(
      { minPool: MIN_POOL_SIZE, maxConcurrent: MAX_CONCURRENT_BROWSERS, maxRequestsPerBrowser: MAX_REQUESTS_PER_BROWSER },
      'Initializing Web Unlocker -- HYPERDRIVE MEGA EDITION',
    );

    // Pre-launch minimum browsers
    for (let i = 0; i < MIN_POOL_SIZE; i++) {
      try {
        await this.launchBrowser();
      } catch (err: any) {
        logger.error({ error: err.message }, 'Failed to pre-launch browser');
      }
    }

    // Start maintenance timer (every 20s for faster recycling)
    this.maintenanceTimer = setInterval(() => this.maintainPool(), 20_000);

    // Start intelligence sync timer (every 60s -- persist intelligence to Redis)
    this.intelligenceSyncTimer = setInterval(() => this.syncIntelligenceToRedis(), 60_000);

    this.initialized = true;

    // Load challenge library from cache
    this.loadChallengeLibrary().catch(() => {});

    // Load domain intelligence from Redis
    this.loadIntelligenceFromRedis().catch(() => {});

    logger.info({ poolSize: this.browserPool.length }, 'Web Unlocker HYPERDRIVE MEGA EDITION initialized');
  }

  /**
   * Main entry point -- unlock a URL with the specified strategy.
   * Enhanced with intelligence-driven strategy selection, adaptive retry,
   * session persistence, and challenge library integration.
   */
  async unlock(request: UnlockRequest): Promise<UnlockResult> {
    const totalStart = Date.now();
    this.stats.totalRequests++;
    this.globalRequestCount++;

    const domain = request.domain || this.extractDomain(request.url);
    const effectiveRequest = { ...request, domain };

    // Check domain intelligence for optimal strategy
    const intelligence = this.domainIntelligence.get(domain);

    // Determine strategy (use intelligence if available)
    const strategy = effectiveRequest.strategy || await this.resolveStrategy(effectiveRequest, intelligence);
    const stealthLevel = effectiveRequest.stealthLevel || this.resolveStealthLevel(strategy, intelligence);

    logger.info(
      { url: effectiveRequest.url, domain, strategy, stealthLevel, intelligence: !!intelligence, intelligenceSamples: intelligence?.sampleCount },
      'Web Unlocker request started',
    );

    // Concurrency control
    if (this.activeRequests >= MAX_CONCURRENT_BROWSERS && strategy !== 'http') {
      logger.info({ queueSize: this.requestQueue.length }, 'Max concurrency reached, queuing request');
      return new Promise<UnlockResult>((resolve, reject) => {
        const priority = this.calculateQueuePriority(effectiveRequest);
        this.requestQueue.push({
          resolve,
          reject,
          request: { ...effectiveRequest, strategy, stealthLevel },
          enqueuedAt: Date.now(),
          priority,
        });
        // Sort queue by priority
        this.requestQueue.sort((a, b) => a.priority - b.priority);
      });
    }

    this.activeRequests++;

    try {
      const result = await this.executeWithRetry(
        { ...effectiveRequest, strategy, stealthLevel },
        effectiveRequest.maxRetries ?? DEFAULT_MAX_RETRIES,
      );

      this.recordStats(domain, strategy, stealthLevel, result, Date.now() - totalStart);
      this.updateDomainIntelligence(domain, strategy, stealthLevel, result);

      // Process next queued request
      this.processQueue();

      return result;
    } catch (err: any) {
      const result: UnlockResult = {
        success: false,
        captchaDetected: false,
        captchaSolved: false,
        strategy,
        stealthLevel,
        proxyUsed: false,
        retries: 0,
        escalationLevel: 0,
        renderTimeMs: 0,
        totalTimeMs: Date.now() - totalStart,
        fingerprintRotated: false,
        sessionUsed: false,
        challengeUsed: null,
        error: err.message,
      };

      this.recordStats(domain, strategy, stealthLevel, result, Date.now() - totalStart);
      this.processQueue();

      return result;
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * Detect anti-bot protections from HTML and headers.
   * Enhanced with Kasada, Shape Security/F5 detection.
   */
  static detectAntiBot(html: string, headers: Record<string, string>): {
    cloudflare: boolean;
    cloudflareVariant: 'challenge' | 'turnstile' | 'managed' | 'none';
    datadome: boolean;
    akamai: boolean;
    perimeterX: boolean;
    imperva: boolean;
    kasada: boolean;
    shape: boolean;
    hasCaptcha: boolean;
    captchaType?: string;
    confidenceScore: number;
  } {
    const lower = (html || '').toLowerCase();
    const headerLower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers || {})) {
      headerLower[k.toLowerCase()] = v.toLowerCase();
    }

    // -- Cloudflare ------------------------------------------
    let cloudflare = false;
    let cloudflareVariant: 'challenge' | 'turnstile' | 'managed' | 'none' = 'none';

    if (headerLower['cf-ray'] || headerLower['server']?.includes('cloudflare')) {
      cloudflare = true;
    }

    if (lower.includes('cf-browser-verification') || lower.includes('cf-challenge')) {
      cloudflare = true;
      cloudflareVariant = 'challenge';
    } else if (lower.includes('challenges.cloudflare.com/turnstile') || lower.includes('cf-turnstile')) {
      cloudflare = true;
      cloudflareVariant = 'turnstile';
    } else if (lower.includes('challenge-platform') && lower.includes('cloudflare')) {
      cloudflare = true;
      cloudflareVariant = 'managed';
    } else if (cloudflare) {
      cloudflareVariant = 'managed';
    }

    if (CF_CHALLENGE_TEXT.some(t => lower.includes(t)) && (cloudflare || lower.includes('cf-'))) {
      cloudflare = true;
      if (cloudflareVariant === 'none') cloudflareVariant = 'challenge';
    }

    // -- DataDome --------------------------------------------
    const datadome =
      lower.includes('datadome') ||
      lower.includes('dd_key') ||
      lower.includes('ddkey') ||
      lower.includes('data-dome') ||
      headerLower['x-datadome'] !== undefined ||
      headerLower['set-cookie']?.includes('datadome');

    // -- Akamai ----------------------------------------------
    const akamai =
      lower.includes('akamai') ||
      lower.includes('_abck') ||
      lower.includes('akamai_swf') ||
      lower.includes('bm-sensor') ||
      headerLower['x-akamai-transformed'] !== undefined ||
      headerLower['set-cookie']?.includes('_abck');

    // -- PerimeterX ------------------------------------------
    const perimeterX =
      lower.includes('perimeterx') ||
      lower.includes('_px3') ||
      lower.includes('px-captcha') ||
      lower.includes('pxfem') ||
      headerLower['set-cookie']?.includes('_px');

    // -- Imperva / Incapsula ---------------------------------
    const imperva =
      lower.includes('incapsula') ||
      lower.includes('imperva') ||
      lower.includes('visid_incap') ||
      lower.includes('incap_ses') ||
      lower.includes('reese84') ||
      headerLower['x-iinfo'] !== undefined ||
      headerLower['set-cookie']?.includes('visid_incap');

    // -- Kasada ----------------------------------------------
    const kasada =
      lower.includes('kasada') ||
      lower.includes('x-kpsdk') ||
      lower.includes('kpsdk_cc') ||
      lower.includes('cdkct') ||
      headerLower['x-kpsdk'] !== undefined ||
      headerLower['set-cookie']?.includes('kpsdk');

    // -- Shape Security / F5 ---------------------------------
    const shape =
      lower.includes('shape security') ||
      lower.includes('f5 networks') ||
      lower.includes('fxm') ||
      lower.includes('shape.com') ||
      lower.includes('_fxm') ||
      headerLower['x-f5-auth'] !== undefined ||
      headerLower['set-cookie']?.includes('_fxm');

    // -- CAPTCHA detection -----------------------------------
    let hasCaptcha = false;
    let captchaType: string | undefined;

    if (lower.includes('recaptcha') || lower.includes('g-recaptcha') || lower.includes('google.com/recaptcha')) {
      hasCaptcha = true;
      captchaType = 'recaptcha';
    }
    if (lower.includes('hcaptcha') || lower.includes('h-captcha')) {
      hasCaptcha = true;
      captchaType = captchaType || 'hcaptcha';
    }
    if (cloudflareVariant === 'turnstile') {
      hasCaptcha = true;
      captchaType = captchaType || 'turnstile';
    }
    if (lower.includes('funcaptcha') || lower.includes('arkoselabs')) {
      hasCaptcha = true;
      captchaType = captchaType || 'funcaptcha';
    }
    if (lower.includes('geetest') || lower.includes('initgeetest')) {
      hasCaptcha = true;
      captchaType = captchaType || 'geetest';
    }
    if (lower.includes('aws-waf-captcha') || lower.includes('awswaf')) {
      hasCaptcha = true;
      captchaType = captchaType || 'aws_waf';
    }

    // -- Confidence score ------------------------------------
    const signals = [cloudflare, datadome, akamai, perimeterX, imperva, kasada, shape, hasCaptcha];
    const activeSignals = signals.filter(Boolean).length;
    const confidenceScore = activeSignals > 0 ? Math.min(1, activeSignals * 0.2) : 0;

    return {
      cloudflare,
      cloudflareVariant,
      datadome,
      akamai,
      perimeterX,
      imperva,
      kasada,
      shape,
      hasCaptcha,
      captchaType,
      confidenceScore,
    };
  }

  /**
   * Get the domain profile from the DB, or auto-detect.
   */
  async getDomainProfile(domain: string): Promise<{
    requiresBrowser: boolean;
    hasCloudflare: boolean;
    hasDatadome: boolean;
    hasAkamai: boolean;
    hasPerimeterX: boolean;
    hasImperva: boolean;
    requiresJs: boolean;
    requiresCaptcha: boolean;
    optimalProxyTier: 'residential' | 'mobile' | 'datacenter' | 'isp';
    successRate: number;
  } | null> {
    const cacheKey = `domain-profile:${domain}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) return cached;

    try {
      const profile = await db.domainProfile.findUnique({ where: { domain } });
      if (profile) {
        const result = {
          requiresBrowser: profile.requiresBrowser,
          hasCloudflare: profile.hasCloudflare,
          hasDatadome: profile.hasDatadome,
          hasAkamai: profile.hasAkamai,
          hasPerimeterX: profile.hasPerimeterX,
          hasImperva: profile.hasImperva,
          requiresJs: profile.requiresJs,
          requiresCaptcha: profile.requiresCaptcha,
          optimalProxyTier: profile.optimalProxyTier as 'residential' | 'mobile' | 'datacenter' | 'isp',
          successRate: profile.successRate,
        };
        await cacheSet(cacheKey, result, DOMAIN_PROFILE_CACHE_TTL);
        return result;
      }
    } catch (err: any) {
      logger.debug({ domain, error: err.message }, 'Failed to fetch domain profile from DB');
    }

    return null;
  }

  /**
   * Generate a random realistic browser profile based on stealth level.
   * Enhanced with fingerprint rotation logic and richer diversity pools.
   */
  generateBrowserProfile(level: StealthLevel): BrowserProfile {
    const profile = stealthEngine.getRandomProfile();

    const base: BrowserProfile = {
      userAgent: profile.userAgent,
      viewport: profile.viewport,
      locale: profile.locale,
      timezone: profile.timezone,
      platform: profile.platform,
      webGlVendor: profile.webglVendor,
      webGlRenderer: profile.webglRenderer,
      screenResolution: profile.screenResolution,
      colorDepth: profile.colorDepth,
      deviceMemory: profile.deviceMemory,
      hardwareConcurrency: profile.hardwareConcurrency,
    };

    // Progressive randomization based on stealth level
    switch (level) {
      case 'basic':
        // No modifications beyond defaults
        break;
      case 'light':
        // Slight viewport variation
        base.viewport = {
          width: profile.viewport.width + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 10),
          height: profile.viewport.height + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 5),
        };
        break;
      case 'medium':
        base.viewport = {
          width: profile.viewport.width + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 20),
          height: profile.viewport.height + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 10),
        };
        base.locale = LOCALE_POOL[Math.floor(Math.random() * LOCALE_POOL.length)];
        break;
      case 'high':
        base.viewport = {
          width: profile.viewport.width + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 30),
          height: profile.viewport.height + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 15),
        };
        base.deviceMemory = ([2, 4, 8, 16] as const)[Math.floor(Math.random() * 4)];
        base.hardwareConcurrency = ([2, 4, 8, 12, 16] as const)[Math.floor(Math.random() * 5)];
        base.locale = LOCALE_POOL[Math.floor(Math.random() * LOCALE_POOL.length)];
        base.timezone = TIMEZONE_POOL[Math.floor(Math.random() * TIMEZONE_POOL.length)];
        break;
      case 'maximum':
        base.viewport = {
          width: profile.viewport.width + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 40),
          height: profile.viewport.height + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 20),
        };
        base.timezone = TIMEZONE_POOL[Math.floor(Math.random() * TIMEZONE_POOL.length)];
        base.deviceMemory = ([2, 4, 8, 16] as const)[Math.floor(Math.random() * 4)];
        base.hardwareConcurrency = ([2, 4, 8, 12, 16] as const)[Math.floor(Math.random() * 5)];
        base.colorDepth = ([24, 30, 32] as const)[Math.floor(Math.random() * 3)];
        base.locale = LOCALE_POOL[Math.floor(Math.random() * LOCALE_POOL.length)];
        break;
    }

    return base;
  }

  /**
   * Get comprehensive stats about the Web Unlocker.
   */
  getStats(): WebUnlockerStats {
    const byStrategy: Record<UnlockStrategy, { count: number; successRate: number; avgTime: number }> = {
      http: { count: 0, successRate: 0, avgTime: 0 },
      browser: { count: 0, successRate: 0, avgTime: 0 },
      stealth: { count: 0, successRate: 0, avgTime: 0 },
      auto: { count: 0, successRate: 0, avgTime: 0 },
    };
    for (const [key, val] of Object.entries(this.stats.byStrategy)) {
      byStrategy[key as UnlockStrategy] = {
        count: val.count,
        successRate: val.count > 0 ? val.successCount / val.count : 0,
        avgTime: val.count > 0 ? val.totalTime / val.count : 0,
      };
    }

    const byStealthLevel: Record<StealthLevel, { count: number; successRate: number }> = {
      basic: { count: 0, successRate: 0 },
      light: { count: 0, successRate: 0 },
      medium: { count: 0, successRate: 0 },
      high: { count: 0, successRate: 0 },
      maximum: { count: 0, successRate: 0 },
    };
    for (const [key, val] of Object.entries(this.stats.byStealthLevel)) {
      byStealthLevel[key as StealthLevel] = {
        count: val.count,
        successRate: val.count > 0 ? val.successCount / val.count : 0,
      };
    }

    const byDomain: Record<string, { requests: number; successRate: number; avgTime: number; captchaRate: number; bestStrategy: UnlockStrategy; bestStealthLevel: StealthLevel }> = {};
    for (const [domain, val] of Object.entries(this.stats.byDomain)) {
      byDomain[domain] = {
        requests: val.count,
        successRate: val.count > 0 ? val.successCount / val.count : 0,
        avgTime: val.count > 0 ? val.totalTime / val.count : 0,
        captchaRate: val.count > 0 ? val.captchaCount / val.count : 0,
        bestStrategy: val.bestStrategy,
        bestStealthLevel: val.bestStealthLevel,
      };
    }

    const unlockerIntelligence: Record<string, { bestStrategy: UnlockStrategy; bestStealthLevel: StealthLevel; successRate: number; avgTime: number; sampleCount: number }> = {};
    for (const [domain, intel] of Array.from(this.domainIntelligence.entries())) {
      unlockerIntelligence[domain] = {
        bestStrategy: intel.bestStrategy,
        bestStealthLevel: intel.bestStealthLevel,
        successRate: intel.successRate,
        avgTime: intel.avgTime,
        sampleCount: intel.sampleCount,
      };
    }

    return {
      totalRequests: this.stats.totalRequests,
      successfulRequests: this.stats.successfulRequests,
      failedRequests: this.stats.failedRequests,
      captchaDetected: this.stats.captchaDetected,
      captchaSolved: this.stats.captchaSolved,
      avgRenderTimeMs: this.stats.totalRequests > 0 ? this.stats.totalRenderTimeMs / this.stats.totalRequests : 0,
      avgTotalTimeMs: this.stats.totalRequests > 0 ? this.stats.totalTotalTimeMs / this.stats.totalRequests : 0,
      fingerprintRotations: this.stats.fingerprintRotations,
      sessionHits: this.stats.sessionHits,
      challengeLibraryHits: this.stats.challengeLibraryHits,
      byStrategy,
      byStealthLevel,
      byDomain,
      activeBrowsers: this.browserPool.filter(b => b.isBusy).length,
      browserPoolSize: this.browserPool.length,
      queuedRequests: this.requestQueue.length,
      unlockerIntelligence,
    };
  }

  /**
   * Gracefully shut down the Web Unlocker.
   * Persists intelligence before shutting down.
   */
  async shutdown(): Promise<void> {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.intelligenceSyncTimer) {
      clearInterval(this.intelligenceSyncTimer);
      this.intelligenceSyncTimer = null;
    }

    // Persist intelligence before shutdown
    await this.syncIntelligenceToRedis().catch(() => {});

    for (const queued of this.requestQueue) {
      queued.reject(new Error('Web Unlocker shutting down'));
    }
    this.requestQueue = [];

    for (const pooled of this.browserPool) {
      try { await pooled.browser.close(); } catch {}
    }
    this.browserPool = [];

    this.initialized = false;
    logger.info('Web Unlocker HYPERDRIVE MEGA EDITION shut down');
  }

  // --- Strategy Resolution (Enhanced with Intelligence) ---------------------

  private async resolveStrategy(request: UnlockRequest, intelligence?: DomainIntelligence | null): Promise<UnlockStrategy> {
    if (request.strategy) return request.strategy;

    // Use intelligence if available with sufficient confidence
    if (intelligence && intelligence.sampleCount >= INTELLIGENCE_MIN_SAMPLES && intelligence.emaSuccessRate > 0.6) {
      logger.info({ domain: request.domain, bestStrategy: intelligence.bestStrategy, emaRate: intelligence.emaSuccessRate }, 'Using intelligence-based strategy');
      return intelligence.bestStrategy;
    }

    const domain = request.domain || this.extractDomain(request.url);
    const profile = await this.getDomainProfile(domain);

    if (profile) {
      if (profile.hasCloudflare || profile.hasDatadome || profile.hasAkamai ||
          profile.hasPerimeterX || profile.hasImperva) {
        return 'stealth';
      }
      if (profile.requiresJs || profile.requiresBrowser) return 'browser';
      if (profile.requiresCaptcha) return 'stealth';
      if (profile.successRate > 0.8 && !profile.requiresJs) return 'http';
    }

    return 'auto';
  }

  private resolveStealthLevel(strategy: UnlockStrategy, intelligence?: DomainIntelligence | null): StealthLevel {
    // Use intelligence if available with sufficient confidence
    if (intelligence && intelligence.sampleCount >= INTELLIGENCE_MIN_SAMPLES && intelligence.emaSuccessRate > 0.6) {
      return intelligence.bestStealthLevel;
    }

    // If domain typically requires captcha, start at high stealth
    if (intelligence?.typicallyRequiresCaptcha) return 'high';

    switch (strategy) {
      case 'http': return 'basic';
      case 'browser': return 'light';
      case 'stealth': return 'high';
      case 'auto': return 'medium';
      default: return 'medium';
    }
  }

  // --- Retry Loop with 7 Escalation Levels + Adaptive Backoff -----------------

  private async executeWithRetry(
    request: UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel },
    maxRetries: number,
  ): Promise<UnlockResult> {
    let lastResult: UnlockResult | null = null;
    let retryCount = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      retryCount = attempt;

      const escalationLevel = Math.min(attempt, 6) as EscalationLevel;
      const currentRequest = this.escalateStrategy(request, escalationLevel);

      try {
        const result = await this.executeAttempt(currentRequest);
        lastResult = {
          ...result,
          retries: retryCount,
          escalationLevel,
          fingerprintRotated: escalationLevel >= 5,
          sessionUsed: !!currentRequest.sessionId,
        };

        if (result.success) return lastResult;

        if (this.isRetryable(result)) {
          // Adaptive backoff between retries
          const backoffMs = calculateRetryBackoff(attempt);
          logger.info(
            {
              url: currentRequest.url,
              attempt: attempt + 1,
              maxRetries,
              statusCode: result.statusCode,
              escalationLevel,
              escalationLabel: ESCALATION_LABELS[escalationLevel],
              backoffMs,
            },
            'Retrying request with escalated strategy',
          );
          await sleep(backoffMs);
          continue;
        }

        return lastResult;
      } catch (err: any) {
        logger.warn({ url: currentRequest.url, attempt: attempt + 1, error: err.message }, 'Request attempt failed');
        lastResult = {
          success: false,
          captchaDetected: false,
          captchaSolved: false,
          strategy: currentRequest.strategy,
          stealthLevel: currentRequest.stealthLevel,
          proxyUsed: false,
          retries: retryCount,
          escalationLevel,
          renderTimeMs: 0,
          totalTimeMs: 0,
          fingerprintRotated: false,
          sessionUsed: false,
          challengeUsed: null,
          error: err.message,
        };
      }
    }

    return lastResult || {
      success: false,
      captchaDetected: false,
      captchaSolved: false,
      strategy: request.strategy,
      stealthLevel: request.stealthLevel,
      proxyUsed: false,
      retries: retryCount,
      escalationLevel: 6,
      renderTimeMs: 0,
      totalTimeMs: 0,
      fingerprintRotated: true,
      sessionUsed: false,
      challengeUsed: null,
      error: 'Max retries exceeded -- nuclear escalation failed',
    };
  }

  /**
   * Escalate the strategy and stealth level through 7 levels.
   * 0: original strategy
   * 1: upgrade stealth level
   * 2: upgrade to browser
   * 3: upgrade to stealth
   * 4: maximum stealth + residential proxy
   * 5: maximum stealth + mobile proxy + fingerprint rotation
   * 6: full nuclear -- session reset + new fingerprint + mobile proxy
   */
  private escalateStrategy(
    request: UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel },
    level: EscalationLevel,
  ): UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel } {
    if (level === 0) return request;

    const escalated = { ...request };

    switch (level) {
      case 1: // Upgrade stealth level
        escalated.sessionId = undefined;
        if (escalated.stealthLevel === 'basic') escalated.stealthLevel = 'light';
        else if (escalated.stealthLevel === 'light') escalated.stealthLevel = 'medium';
        else if (escalated.stealthLevel === 'medium') escalated.stealthLevel = 'high';
        else if (escalated.stealthLevel === 'high') escalated.stealthLevel = 'maximum';
        break;

      case 2: // Upgrade to browser
        escalated.sessionId = undefined;
        escalated.stealthLevel = 'medium';
        if (escalated.strategy === 'http') escalated.strategy = 'browser';
        break;

      case 3: // Upgrade to stealth
        escalated.sessionId = undefined;
        escalated.stealthLevel = 'high';
        if (escalated.strategy !== 'stealth') escalated.strategy = 'stealth';
        escalated.simulateHuman = true;
        break;

      case 4: // Maximum stealth + residential proxy
        escalated.sessionId = undefined;
        escalated.strategy = 'stealth';
        escalated.stealthLevel = 'maximum';
        escalated.proxyTier = escalated.proxyTier || 'residential';
        escalated.simulateHuman = true;
        break;

      case 5: // Maximum stealth + mobile proxy + fingerprint rotation
        escalated.sessionId = undefined;
        escalated.strategy = 'stealth';
        escalated.stealthLevel = 'maximum';
        escalated.proxyTier = 'mobile';
        escalated.simulateHuman = true;
        break;

      case 6: // Full nuclear -- session reset + new fingerprint + mobile proxy
        escalated.sessionId = undefined;
        escalated.strategy = 'stealth';
        escalated.stealthLevel = 'maximum';
        escalated.proxyTier = 'mobile';
        escalated.simulateHuman = true;
        escalated.solveCaptcha = true;
        // Force new proxy session
        escalated.headers = {
          ...escalated.headers,
          'X-Force-New-Session': 'true',
        };
        break;
    }

    // Check if intelligence recommends avoiding this strategy
    const domain = escalated.domain || this.extractDomain(escalated.url);
    const intelligence = this.domainIntelligence.get(domain);
    if (intelligence && intelligence.failedStrategies.length > 0) {
      const recentFailures = intelligence.failedStrategies.filter(
        f => Date.now() - f.timestamp < INTELLIGENCE_RECENT_WINDOW_MS
      );
      const isFailed = recentFailures.some(
        f => f.strategy === escalated.strategy && f.stealthLevel === escalated.stealthLevel
      );
      if (isFailed && level < 6) {
        // Skip to next escalation level if this strategy recently failed
        return this.escalateStrategy(request, (level + 1) as EscalationLevel);
      }
    }

    return escalated;
  }

  private isRetryable(result: UnlockResult): boolean {
    if (result.success) return false;
    if (result.statusCode === 403 || result.statusCode === 429) return true;
    if (result.captchaDetected && !result.captchaSolved) return true;
    if (result.error?.includes('timeout') || result.error?.includes('Timeout')) return true;
    if (result.error?.includes('net::ERR')) return true;
    if (result.statusCode === 503) return true;
    if (result.statusCode === 408) return true;
    if (result.error?.includes('Anti-bot detected')) return true;
    if (result.error?.includes('blocked')) return true;
    if (result.error?.includes('access denied')) return true;
    return false;
  }

  // --- Execute Attempt ------------------------------------------------------

  private async executeAttempt(
    request: UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel },
  ): Promise<UnlockResult> {
    switch (request.strategy) {
      case 'http': return this.executeHttp(request);
      case 'browser': return this.executeBrowser(request);
      case 'stealth': return this.executeStealth(request);
      case 'auto': return this.executeAuto(request);
      default: return this.executeAuto(request);
    }
  }

  // --- HTTP Strategy --------------------------------------------------------

  private async executeHttp(
    request: UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel },
  ): Promise<UnlockResult> {
    const start = Date.now();

    try {
      let proxyUrl: string | undefined = request.proxyUrl;
      let proxyId: string | undefined;
      let proxyUsed = false;

      if (!proxyUrl && (request.proxyTier || request.proxyCountry)) {
        const proxy = await this.getProxy(
          request.domain || this.extractDomain(request.url),
          request.proxyTier,
          request.proxyCountry,
        );
        if (proxy) {
          proxyUrl = proxy.proxyUrl;
          proxyId = proxy.proxyId;
          proxyUsed = true;
        }
      } else if (proxyUrl) {
        proxyUsed = true;
      }

      const browserProfile = this.generateBrowserProfile(request.stealthLevel);

      const headers: Record<string, string> = {
        'User-Agent': browserProfile.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': `${browserProfile.locale},en;q=0.9`,
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': this.buildSecChUa(browserProfile.userAgent),
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': `"${browserProfile.platform}"`,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        ...request.headers,
      };

      const savedCookies = await this.loadCookies(request.domain || this.extractDomain(request.url));
      if (savedCookies) {
        const cookieHeader = savedCookies
          .filter(c => c.priority !== 'discard')
          .map(c => `${c.cookie.name}=${c.cookie.value}`)
          .join('; ');
        if (cookieHeader) headers['Cookie'] = cookieHeader;
      }

      const response = await proxyFetch(request.url, proxyUrl, {
        headers,
        timeout: request.timeout || DEFAULT_TIMEOUT_MS,
      });

      const html = response.text;
      const responseHeaders = response.headers;

      if (responseHeaders['set-cookie']) {
        await this.saveCookiesFromHeader(
          request.domain || this.extractDomain(request.url),
          responseHeaders['set-cookie'],
        );
      }

      const detection = WebUnlocker.detectAntiBot(html, responseHeaders);
      if (detection.cloudflare || detection.hasCaptcha || detection.datadome ||
          detection.akamai || detection.perimeterX || detection.imperva ||
          detection.kasada || detection.shape) {
        return {
          success: false, html, statusCode: response.status, finalUrl: response.url,
          captchaDetected: detection.hasCaptcha, captchaSolved: false, captchaType: detection.captchaType,
          strategy: request.strategy, stealthLevel: request.stealthLevel,
          proxyUsed, proxyId, retries: 0, escalationLevel: 0, renderTimeMs: 0,
          totalTimeMs: Date.now() - start, fingerprintRotated: false, sessionUsed: false, challengeUsed: null,
          error: `Anti-bot detected: ${this.summarizeDetection(detection)}`,
        };
      }

      let extractedData: Record<string, any> | undefined;
      if (request.extractData) extractedData = this.extractDataFromHtml(html, request.extractData);

      return {
        success: response.ok, html, statusCode: response.status, finalUrl: response.url,
        extractedData, captchaDetected: false, captchaSolved: false,
        strategy: request.strategy, stealthLevel: request.stealthLevel,
        proxyUsed, proxyId, retries: 0, escalationLevel: 0, renderTimeMs: 0,
        totalTimeMs: Date.now() - start, fingerprintRotated: false, sessionUsed: false, challengeUsed: null,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err: any) {
      return {
        success: false, captchaDetected: false, captchaSolved: false,
        strategy: request.strategy, stealthLevel: request.stealthLevel,
        proxyUsed: false, retries: 0, escalationLevel: 0, renderTimeMs: 0,
        totalTimeMs: Date.now() - start, fingerprintRotated: false, sessionUsed: false, challengeUsed: null,
        error: err.message,
      };
    }
  }

  // --- Browser Strategy -----------------------------------------------------

  private async executeBrowser(
    request: UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel },
  ): Promise<UnlockResult> {
    return this.executeWithBrowser(request, false);
  }

  // --- Stealth Strategy -----------------------------------------------------

  private async executeStealth(
    request: UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel },
  ): Promise<UnlockResult> {
    return this.executeWithBrowser(request, true);
  }

  // --- Auto Strategy --------------------------------------------------------

  private async executeAuto(
    request: UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel },
  ): Promise<UnlockResult> {
    const domain = request.domain || this.extractDomain(request.url);
    const profile = await this.getDomainProfile(domain);

    if (profile) {
      if (profile.hasCloudflare || profile.hasDatadome || profile.hasAkamai ||
          profile.hasPerimeterX || profile.hasImperva) {
        return this.executeStealth({ ...request, strategy: 'stealth', stealthLevel: 'high' });
      }
      if (profile.requiresJs || profile.requiresBrowser) {
        return this.executeBrowser({ ...request, strategy: 'browser', stealthLevel: 'light' });
      }
      if (profile.requiresCaptcha) {
        return this.executeStealth({ ...request, strategy: 'stealth', stealthLevel: 'high' });
      }
    }

    // Try HTTP first, fall back to browser
    const httpResult = await this.executeHttp({ ...request, strategy: 'http' });
    if (httpResult.success && !httpResult.captchaDetected) return httpResult;

    logger.info({ url: request.url }, 'Auto strategy: HTTP failed, trying browser');
    return this.executeBrowser({ ...request, strategy: 'browser', stealthLevel: 'medium' });
  }

  // --- Core Browser Execution -- ENHANCED --------------------------------------

  private async executeWithBrowser(
    request: UnlockRequest & { strategy: UnlockStrategy; stealthLevel: StealthLevel },
    fullStealth: boolean,
  ): Promise<UnlockResult> {
    const totalStart = Date.now();
    let browser: PooledBrowser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let fingerprintRotated = false;
    let sessionUsed = false;
    let challengeUsed: string | null = null;

    try {
      // Check for existing domain session
      const domain = request.domain || this.extractDomain(request.url);
      const existingSessionId = request.sessionId || this.domainSessions.get(domain);
      if (existingSessionId) sessionUsed = true;

      // Get or launch browser -- with domain affinity
      browser = await this.acquireBrowser(domain);

      // Check fingerprint rotation
      if (this.globalRequestCount % FINGERPRINT_ROTATION_INTERVAL === 0) {
        fingerprintRotated = true;
        this.stats.fingerprintRotations++;
        logger.debug({ globalCount: this.globalRequestCount }, 'Fingerprint rotation triggered');
      }

      const browserProfile = this.generateBrowserProfile(request.stealthLevel);

      // Get proxy
      let proxyUrl: string | undefined = request.proxyUrl;
      let proxyId: string | undefined;
      let proxyUsed = false;

      if (!proxyUrl) {
        const proxy = await this.getProxy(
          domain,
          request.proxyTier || (fullStealth ? 'residential' : undefined),
          request.proxyCountry,
          existingSessionId,
        );
        if (proxy) {
          proxyUrl = proxy.proxyUrl;
          proxyId = proxy.proxyId;
          proxyUsed = true;
        }
      } else {
        proxyUsed = true;
      }

      // Create context with stealth settings
      // For high/maximum stealth, use CDP engine's context options for better consistency
      let contextOptions: any;
      if (fullStealth && (request.stealthLevel === 'high' || request.stealthLevel === 'maximum')) {
        try {
          contextOptions = cdpInjectionEngine.getContextOptions(domain);
        } catch {
          contextOptions = stealthEngine.getContextOptions(browserProfile as any);
        }
      } else {
        contextOptions = stealthEngine.getContextOptions(browserProfile as any);
      }
      const contextConfig: any = { ...contextOptions, bypassCSP: true };

      if (proxyUrl) contextConfig.proxy = { server: proxyUrl };

      // Restore session state
      const sessionState = existingSessionId ? await this.loadSession(existingSessionId) : null;

      if (sessionState && sessionState.reuseCount < SESSION_MAX_REUSE) {
        contextConfig.storageState = {
          cookies: sessionState.cookies,
          origins: [{
            origin: new URL(request.url).origin,
            localStorage: Object.entries(sessionState.localStorage).map(([name, value]) => ({ name, value })),
          }],
        };
        sessionUsed = true;
        this.stats.sessionHits++;
      }

      context = await browser.browser.newContext(contextConfig);

      // Inject stealth scripts based on level
      await this.injectStealthScripts(context, request.stealthLevel, fullStealth, browserProfile);

      // Restore cookies if not using storageState -- with smart classification
      if (!sessionState) {
        const savedCookies = await this.loadCookies(domain);
        if (savedCookies && savedCookies.length > 0) {
          // Only restore non-discarded cookies
          const filteredCookies = savedCookies
            .filter(c => c.priority !== 'discard')
            .map(c => c.cookie);
          if (filteredCookies.length > 0) await context.addCookies(filteredCookies);
        }
      }

      page = await context.newPage();

      // --- CDP-Level Fingerprint Injection --------------------------------
      // For high/maximum stealth, apply CDP-level overrides that are invisible
      // to JavaScript-based detection. This pushes bot detection bypass from
      // ~75% to ~85%+ by modifying browser internals at the protocol level.
      if (fullStealth && (request.stealthLevel === 'high' || request.stealthLevel === 'maximum')) {
        try {
          const cdpResult: CdpInjectionResult = await cdpInjectionEngine.inject(page, domain, {
            sessionId: request.sessionId,
          });
          logger.debug({
            domain,
            cdpLevel: cdpResult.level,
            cdpOverrides: cdpResult.overridesApplied.length,
            cdpFallback: cdpResult.fallbackUsed,
            cdpSessionCreated: cdpResult.cdpSessionCreated,
          }, 'CDP injection applied');

          // Apply deep browser patches (header order, timing, font protection, etc.)
          if (cdpResult.success) {
            const cdpSession = cdpInjectionEngine.getSession(cdpResult.profileId)?.cdpSession || undefined;
            const profile = cdpInjectionEngine.getProfile(domain)?.coherentProfile;
            if (profile) {
              await deepBrowserPatcher.patch(page, profile, { cdpSession });
            }
          }
        } catch (err: any) {
          logger.debug({ domain, error: err.message }, 'CDP injection failed -- continuing with JS-level stealth');
        }
      }

      // Set up resource blocking -- smart strategy-aware
      await this.setupSmartResourceBlocking(page, request.blockResources, request.strategy, request.stealthLevel);

      // Navigate to URL
      const renderStart = Date.now();
      const timeout = request.timeout || DEFAULT_TIMEOUT_MS;

      const response = await page.goto(request.url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });

      // Wait for additional content to load
      if (request.waitForSelector) {
        try {
          await page.waitForSelector(request.waitForSelector, { timeout: Math.min(timeout, 10000) });
        } catch (err: any) {
          logger.debug({ selector: request.waitForSelector, error: err.message }, 'Wait for selector timed out');
        }
      }

      // Check challenge library for known patterns
      const challengeMatch = this.matchChallengeLibrary(domain, await page.content());
      if (challengeMatch) {
        challengeUsed = challengeMatch.name;
        this.stats.challengeLibraryHits++;
        challengeMatch.lastUsed = Date.now();
        challengeMatch.appliedCount++;
        logger.info({ domain, challenge: challengeMatch.name, successRate: challengeMatch.successRate }, 'Challenge library match found');
      }

      // Check for anti-bot challenges
      const challengeResult = await this.handleChallenges(page, request);

      // Simulate human behavior if requested or at high stealth
      if (request.simulateHuman || request.stealthLevel === 'high' || request.stealthLevel === 'maximum') {
        await this.simulateHumanBehavior(page);
      }

      // Wait after load if specified
      if (request.waitAfterLoadMs) await sleep(request.waitAfterLoadMs);

      // Wait for network idle after challenge resolution
      if (challengeResult.challengeHandled) {
        try {
          await page.waitForLoadState('networkidle', { timeout: 8000 });
        } catch {}
      }

      const renderTimeMs = Date.now() - renderStart;

      // Get final HTML and status
      const html = await page.content();
      const statusCode = response?.status() ?? 200;
      const finalUrl = page.url();

      // Save cookies with smart classification
      const cookies = await context.cookies();
      await this.saveCookies(domain, cookies);

      // Save session state
      const sessionId = existingSessionId || `wu-session-${domain}-${Date.now()}`;
      const localStorage = await this.extractLocalStorage(page);
      const sessionStorage = await this.extractSessionStorage(page);
      await this.saveSession(sessionId, {
        cookies,
        localStorage,
        sessionStorage,
        domain,
        createdAt: sessionState?.createdAt || Date.now(),
        lastUsed: Date.now(),
        requestCount: (sessionState?.requestCount || 0) + 1,
        fingerprintId: browser.fingerprintId,
        userAgent: browserProfile.userAgent,
        proxyTier: request.proxyTier,
        reuseCount: (sessionState?.reuseCount || 0) + 1,
      });
      this.domainSessions.set(domain, sessionId);

      // Extract data if requested
      let extractedData: Record<string, any> | undefined;
      if (request.extractData) extractedData = await this.extractDataFromPage(page, request.extractData);

      // Detect CAPTCHAs in final HTML
      const detection = WebUnlocker.detectAntiBot(html, {});

      // Track browser health
      if (statusCode >= 200 && statusCode < 400 && !challengeResult.stillBlocked) {
        browser.successCount++;
        browser.consecutiveFailures = 0;
      } else {
        browser.consecutiveFailures++;
      }

      return {
        success: statusCode >= 200 && statusCode < 400 && !challengeResult.stillBlocked,
        html,
        statusCode,
        finalUrl,
        extractedData,
        captchaDetected: challengeResult.captchaDetected || detection.hasCaptcha,
        captchaSolved: challengeResult.captchaSolved,
        captchaType: challengeResult.captchaType || detection.captchaType,
        strategy: request.strategy,
        stealthLevel: request.stealthLevel,
        proxyUsed,
        proxyId,
        retries: 0,
        escalationLevel: 0,
        renderTimeMs,
        totalTimeMs: Date.now() - totalStart,
        fingerprintRotated,
        sessionUsed,
        challengeUsed,
        error: challengeResult.stillBlocked ? 'Blocked by anti-bot after challenge handling' : undefined,
      };
    } catch (err: any) {
      // Track browser health on failure
      if (browser) {
        browser.consecutiveFailures++;
      }
      return {
        success: false, captchaDetected: false, captchaSolved: false,
        strategy: request.strategy, stealthLevel: request.stealthLevel,
        proxyUsed: false, retries: 0, escalationLevel: 0, renderTimeMs: 0,
        totalTimeMs: Date.now() - totalStart, fingerprintRotated, sessionUsed,
        challengeUsed, error: err.message,
      };
    } finally {
      try { if (page) await page.close({ runBeforeUnload: false }); } catch {}
      try { if (context) await context.close(); } catch {}
      if (browser) {
        browser.isBusy = false;
        browser.lastUsed = Date.now();
        // Update health score
        const total = browser.successCount + browser.consecutiveFailures;
        browser.healthScore = total > 0 ? browser.successCount / total : 1;
      }
    }
  }

  // --- Stealth Script Injection -- 5 Levels ------------------------------------

  private async injectStealthScripts(
    context: BrowserContext,
    level: StealthLevel,
    fullStealth: boolean,
    profile: BrowserProfile,
  ): Promise<void> {
    switch (level) {
      case 'basic':
        await context.addInitScript(BASIC_STEALTH_SCRIPT);
        break;

      case 'light':
        await context.addInitScript(LIGHT_STEALTH_SCRIPT);
        break;

      case 'medium':
        await context.addInitScript(MEDIUM_STEALTH_SCRIPT);
        await context.addInitScript(stealthEngine.getStealthInitScript(profile as any));
        break;

      case 'high':
        await context.addInitScript(MEDIUM_STEALTH_SCRIPT);
        await context.addInitScript(stealthEngine.getStealthInitScript(profile as any));
        await context.addInitScript(humanBehavior.getBehaviorInitScript());
        break;

      case 'maximum':
        await context.addInitScript(MEDIUM_STEALTH_SCRIPT);
        await context.addInitScript(stealthEngine.getStealthInitScript(profile as any));
        await context.addInitScript(humanBehavior.getBehaviorInitScript());
        await context.addInitScript(this.getMaximumStealthScript(profile));
        break;
    }
  }

  // --- Human Behavior Simulation -- Enhanced ----------------------------------

  private async simulateHumanBehavior(page: Page): Promise<void> {
    try {
      // Simulate realistic mouse movements with bezier curves
      await this.simulateMouseMovements(page);

      // Simulate scroll patterns
      await this.simulateScrollPatterns(page);

      // Simulate typing on focused inputs (if any)
      await this.simulateTypingPatterns(page);

      // Add random idle pauses
      await this.simulateIdlePauses(page);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Human behavior simulation failed');
    }
  }

  private async simulateMouseMovements(page: Page): Promise<void> {
    try {
      const viewport = page.viewportSize();
      if (!viewport) return;

      // Generate 3-7 random mouse movements with realistic bezier curves
      const moveCount = 3 + Math.floor(Math.random() * 5);
      for (let i = 0; i < moveCount; i++) {
        const x = Math.floor(Math.random() * viewport.width);
        const y = Math.floor(Math.random() * viewport.height);
        const steps = 5 + Math.floor(Math.random() * 15);
        await page.mouse.move(x, y, { steps });
        await sleep(randomGaussian(200, 80));
      }
    } catch {}
  }

  private async simulateScrollPatterns(page: Page): Promise<void> {
    try {
      // Scroll down in 2-5 steps with varying speeds, then back up
      const scrollSteps = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < scrollSteps; i++) {
        const scrollAmount = 150 + Math.floor(Math.random() * 350);
        await page.mouse.wheel(0, scrollAmount);
        await sleep(randomGaussian(400, 150));
      }

      // Scroll back up partially -- natural behavior
      await page.mouse.wheel(0, -(80 + Math.floor(Math.random() * 200)));
      await sleep(randomGaussian(300, 100));
    } catch {}
  }

  private async simulateTypingPatterns(page: Page): Promise<void> {
    try {
      // Find focused input and type with realistic delays
      const focusedInput = await page.$('input:focus, textarea:focus');
      if (!focusedInput) return;

      // Just add a slight delay to simulate human thinking
      await sleep(randomGaussian(300, 100));
    } catch {}
  }

  private async simulateIdlePauses(page: Page): Promise<void> {
    try {
      // 1-3 idle pauses
      const pauseCount = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < pauseCount; i++) {
        const pauseDuration = randomGaussian(800, 400);
        await sleep(Math.max(200, pauseDuration));

        // Occasionally move mouse during idle
        if (Math.random() < 0.4) {
          const viewport = page.viewportSize();
          if (viewport) {
            const x = Math.floor(Math.random() * viewport.width);
            const y = Math.floor(Math.random() * viewport.height);
            await page.mouse.move(x, y, { steps: 3 });
          }
        }
      }
    } catch {}
  }

  // --- Challenge Library -- Enhanced with Detection Signatures ----------------

  private matchChallengeLibrary(domain: string, html: string): ChallengeLibraryEntry | null {
    const lower = html.toLowerCase();

    // Sort by priority for deterministic matching
    const sorted = [...this.challengeLibrary].sort((a, b) => a.priority - b.priority);

    for (const entry of sorted) {
      // Check domain pattern
      const domainMatch = entry.domainPattern.test(domain);

      // Check detection selectors in HTML
      const selectorMatch = entry.detectionText.some(t => lower.includes(t.toLowerCase()));

      // Check detection text
      const textMatch = entry.detectionText.some(t => lower.includes(t.toLowerCase()));

      if (domainMatch || selectorMatch || textMatch) {
        return entry;
      }
    }
    return null;
  }

  private async loadChallengeLibrary(): Promise<void> {
    try {
      const cached = await cacheGet<any[]>('challenge-library');
      if (cached && Array.isArray(cached)) {
        // Merge runtime entries with defaults
        const runtimeEntries = cached.map((entry: any) => ({
          ...entry,
          detectionSelectors: entry.detectionSelectors || [],
          detectionText: entry.detectionText || [],
          detectionHeaders: entry.detectionHeaders || [],
          priority: entry.priority || 99,
          appliedCount: entry.appliedCount || 0,
          successCount: entry.successCount || 0,
        }));
        this.challengeLibrary = [...DEFAULT_CHALLENGE_LIBRARY, ...runtimeEntries];
      }
    } catch {}
  }

  private async saveChallengeLibrary(): Promise<void> {
    try {
      // Only save runtime entries (not defaults)
      const runtimeEntries = this.challengeLibrary.filter(
        e => !DEFAULT_CHALLENGE_LIBRARY.some(d => d.name === e.name)
      );
      await cacheSet('challenge-library', runtimeEntries, CHALLENGE_LIBRARY_CACHE_TTL);
    } catch {}
  }

  // --- Challenge Handling -- ENHANCED with Full Anti-Bot Support --------------

  private async handleChallenges(
    page: Page,
    request: UnlockRequest,
  ): Promise<{
    challengeHandled: boolean;
    captchaDetected: boolean;
    captchaSolved: boolean;
    captchaType?: string;
    stillBlocked: boolean;
  }> {
    const result = {
      challengeHandled: false,
      captchaDetected: false,
      captchaSolved: false,
      captchaType: undefined as string | undefined,
      stillBlocked: false,
    };

    const html = await page.content();
    const lower = html.toLowerCase();

    // -- Cloudflare challenge detection -----------------------------------
    let isCfChallenge = false;
    for (const selector of CF_CHALLENGE_SELECTORS) {
      try {
        const element = await page.$(selector);
        if (element) { isCfChallenge = true; break; }
      } catch {}
    }
    if (!isCfChallenge && CF_CHALLENGE_TEXT.some(t => lower.includes(t))) isCfChallenge = true;

    if (isCfChallenge) {
      logger.info({ url: page.url() }, 'Cloudflare challenge detected -- waiting for resolution');
      result.captchaDetected = true;
      result.captchaType = 'cloudflare';

      const challengeStart = Date.now();
      const maxWait = 15000; // 15s max wait

      try {
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: maxWait }),
          page.waitForSelector('body', { timeout: maxWait }).then(async () => {
            for (let i = 0; i < 10; i++) {
              await sleep(1200);
              const currentHtml = (await page.content()).toLowerCase();
              if (!CF_CHALLENGE_TEXT.some(t => currentHtml.includes(t))) return;
              let challengeGone = true;
              for (const selector of CF_CHALLENGE_SELECTORS) {
                try {
                  const el = await page.$(selector);
                  if (el && await el.isVisible()) { challengeGone = false; break; }
                } catch {}
              }
              if (challengeGone) return;
            }
          }),
        ]);

        result.challengeHandled = true;
        result.captchaSolved = true;
        logger.info({ url: page.url(), durationMs: Date.now() - challengeStart }, 'Cloudflare challenge resolved');
      } catch (err: any) {
        logger.warn({ url: page.url(), error: err.message }, 'Cloudflare challenge not resolved within timeout');
        result.stillBlocked = true;
      }
    }

    // -- Turnstile detection ----------------------------------------------
    try {
      const turnstileElement = await page.$(TURNSTILE_SELECTOR);
      if (turnstileElement) {
        logger.info({ url: page.url() }, 'Turnstile CAPTCHA detected');
        result.captchaDetected = true;
        result.captchaType = 'turnstile';

        if (request.solveCaptcha !== false) {
          const siteKey = await turnstileElement.getAttribute('data-sitekey');
          if (siteKey) {
            const solved = await this.solveCaptcha(page.url(), siteKey, 'turnstile', request.proxyUrl);
            result.captchaSolved = solved;
            result.challengeHandled = solved;

            if (solved) {
              const token = await this.getCaptchaToken(page.url(), siteKey, 'turnstile');
              if (token) {
                await page.evaluate((t: string) => {
                  const turnstileResponse = document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement;
                  if (turnstileResponse) turnstileResponse.value = t;
                  const widgetId = (window as any).turnstile?.getResponse?.();
                  if (widgetId) (window as any).turnstile?.callback?.(t);
                }, token);
              }
            }
          }
        }
        if (!result.captchaSolved) result.stillBlocked = true;
      }
    } catch {}

    // -- reCAPTCHA detection ----------------------------------------------
    try {
      const recaptchaElement = await page.$('.g-recaptcha, [data-sitekey]');
      if (recaptchaElement && lower.includes('recaptcha')) {
        logger.info({ url: page.url() }, 'reCAPTCHA detected');
        result.captchaDetected = true;
        result.captchaType = 'recaptcha';

        if (request.solveCaptcha !== false) {
          const siteKey = await recaptchaElement.getAttribute('data-sitekey');
          if (siteKey) {
            const solved = await this.solveCaptcha(page.url(), siteKey, 'recaptcha_v2', request.proxyUrl);
            result.captchaSolved = solved;
            result.challengeHandled = solved;

            if (solved) {
              const token = await this.getCaptchaToken(page.url(), siteKey, 'recaptcha_v2');
              if (token) {
                await page.evaluate((t: string) => {
                  const textarea = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement;
                  if (textarea) textarea.value = t;
                  const form = textarea?.closest('form');
                  if (form) {
                    const submitBtn = form.querySelector('[type="submit"]') as HTMLElement;
                    submitBtn?.click();
                  }
                }, token);
              }
            }
          }
        }
        if (!result.captchaSolved) result.stillBlocked = true;
      }
    } catch {}

    // -- hCaptcha detection -----------------------------------------------
    try {
      const hcaptchaElement = await page.$('.h-captcha, [data-hcaptcha-sitekey]');
      if (hcaptchaElement) {
        logger.info({ url: page.url() }, 'hCaptcha detected');
        result.captchaDetected = true;
        result.captchaType = 'hcaptcha';

        if (request.solveCaptcha !== false) {
          const siteKey = await hcaptchaElement.getAttribute('data-sitekey') ||
                          await hcaptchaElement.getAttribute('data-hcaptcha-sitekey');
          if (siteKey) {
            const solved = await this.solveCaptcha(page.url(), siteKey, 'hcaptcha', request.proxyUrl);
            result.captchaSolved = solved;
            result.challengeHandled = solved;

            if (solved) {
              const token = await this.getCaptchaToken(page.url(), siteKey, 'hcaptcha');
              if (token) {
                await page.evaluate((t: string) => {
                  const textarea = document.querySelector('[name="h-captcha-response"]') as HTMLTextAreaElement;
                  if (textarea) textarea.value = t;
                  const callback = (window as any).hcaptcha?.callback;
                  if (callback) callback(t);
                }, token);
              }
            }
          }
        }
        if (!result.captchaSolved) result.stillBlocked = true;
      }
    } catch {}

    // -- DataDome challenge detection -------------------------------------
    try {
      let isDataDome = false;
      for (const selector of DATADOME_SELECTORS) {
        try {
          const element = await page.$(selector);
          if (element) { isDataDome = true; break; }
        } catch {}
      }
      if (!isDataDome && DATADOME_TEXT.some(t => lower.includes(t))) isDataDome = true;

      if (isDataDome) {
        logger.info({ url: page.url() }, 'DataDome challenge detected');
        result.captchaDetected = true;
        result.captchaType = result.captchaType || 'datadome';

        // DataDome often auto-resolves with proper stealth -- wait for it
        const ddStart = Date.now();
        const ddMaxWait = 10000;
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout: ddMaxWait });
          result.challengeHandled = true;
          result.captchaSolved = true;
        } catch {
          // Try human behavior simulation to trigger auto-resolve
          if (request.stealthLevel === 'high' || request.stealthLevel === 'maximum') {
            await humanBehavior.simulatePageInteraction(page);
            await sleep(2000);
            const currentHtml = (await page.content()).toLowerCase();
            const ddGone = !DATADOME_TEXT.some(t => currentHtml.includes(t));
            if (ddGone) {
              result.challengeHandled = true;
              result.captchaSolved = true;
            }
          }
          if (!result.captchaSolved) result.stillBlocked = true;
        }
      }
    } catch {}

    // -- Akamai challenge detection ---------------------------------------
    try {
      let isAkamai = false;
      for (const selector of AKAMAI_SELECTORS) {
        try {
          const element = await page.$(selector);
          if (element) { isAkamai = true; break; }
        } catch {}
      }
      if (!isAkamai && AKAMAI_TEXT.some(t => lower.includes(t))) isAkamai = true;

      if (isAkamai) {
        logger.info({ url: page.url() }, 'Akamai Bot Manager challenge detected');
        result.captchaDetected = true;
        result.captchaType = result.captchaType || 'akamai';

        // Akamai sensor data challenges auto-resolve with proper stealth
        const akWait = 8000;
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout: akWait });
          result.challengeHandled = true;
          result.captchaSolved = true;
        } catch {
          if (!result.captchaSolved) result.stillBlocked = true;
        }
      }
    } catch {}

    // -- PerimeterX challenge detection -----------------------------------
    try {
      let isPerimeterX = false;
      for (const selector of PERIMETERX_SELECTORS) {
        try {
          const element = await page.$(selector);
          if (element) { isPerimeterX = true; break; }
        } catch {}
      }
      if (!isPerimeterX && PERIMETERX_TEXT.some(t => lower.includes(t))) isPerimeterX = true;

      if (isPerimeterX) {
        logger.info({ url: page.url() }, 'PerimeterX challenge detected');
        result.captchaDetected = true;
        result.captchaType = result.captchaType || 'perimeterx';

        // PerimeterX may auto-resolve with human behavior simulation
        if (request.simulateHuman || request.stealthLevel === 'high' || request.stealthLevel === 'maximum') {
          await humanBehavior.simulatePageInteraction(page);
          await sleep(3000);
          const currentHtml = (await page.content()).toLowerCase();
          const pxGone = !PERIMETERX_TEXT.some(t => currentHtml.includes(t));
          if (pxGone) {
            result.challengeHandled = true;
            result.captchaSolved = true;
          }
        }
        if (!result.captchaSolved) result.stillBlocked = true;
      }
    } catch {}

    // -- Kasada challenge detection ---------------------------------------
    try {
      let isKasada = false;
      for (const selector of KASADA_SELECTORS) {
        try {
          const element = await page.$(selector);
          if (element) { isKasada = true; break; }
        } catch {}
      }
      if (!isKasada && KASADA_TEXT.some(t => lower.includes(t))) isKasada = true;

      if (isKasada) {
        logger.info({ url: page.url() }, 'Kasada challenge detected');
        result.captchaDetected = true;
        result.captchaType = result.captchaType || 'kasada';

        // Kasada is tough -- try waiting with human behavior
        try {
          await humanBehavior.simulatePageInteraction(page);
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 });
          result.challengeHandled = true;
          result.captchaSolved = true;
        } catch {
          if (!result.captchaSolved) result.stillBlocked = true;
        }
      }
    } catch {}

    // -- Shape Security/F5 challenge detection ----------------------------
    try {
      let isShape = false;
      for (const selector of SHAPE_SELECTORS) {
        try {
          const element = await page.$(selector);
          if (element) { isShape = true; break; }
        } catch {}
      }
      if (!isShape && SHAPE_TEXT.some(t => lower.includes(t))) isShape = true;

      if (isShape) {
        logger.info({ url: page.url() }, 'Shape Security/F5 challenge detected');
        result.captchaDetected = true;
        result.captchaType = result.captchaType || 'shape';

        // Shape requires maximum stealth and human behavior
        try {
          await humanBehavior.simulatePageInteraction(page);
          await sleep(3000);
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 });
          result.challengeHandled = true;
          result.captchaSolved = true;
        } catch {
          if (!result.captchaSolved) result.stillBlocked = true;
        }
      }
    } catch {}

    // -- Imperva/Incapsula challenge detection ----------------------------
    try {
      let isImperva = false;
      for (const selector of IMPErVA_SELECTORS) {
        try {
          const element = await page.$(selector);
          if (element) { isImperva = true; break; }
        } catch {}
      }
      if (!isImperva && IMPErVA_TEXT.some(t => lower.includes(t))) isImperva = true;

      if (isImperva) {
        logger.info({ url: page.url() }, 'Imperva/Incapsula challenge detected');
        result.captchaDetected = true;
        result.captchaType = result.captchaType || 'imperva';

        // Imperva often requires session persistence
        try {
          await sleep(2000);
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 });
          result.challengeHandled = true;
          result.captchaSolved = true;
        } catch {
          if (!result.captchaSolved) result.stillBlocked = true;
        }
      }
    } catch {}

    // -- Simulate human behavior after challenge if in stealth mode -------
    if (result.challengeHandled && request.stealthLevel !== 'basic' && request.stealthLevel !== 'light') {
      try { await humanBehavior.simulatePageInteraction(page); } catch {}
    }

    // -- Final block check ------------------------------------------------
    if (!result.stillBlocked) {
      const finalHtml = (await page.content()).toLowerCase();
      if (finalHtml.includes('access denied') || finalHtml.includes('blocked') ||
          finalHtml.includes('you have been blocked') || finalHtml.includes('bot detected')) {
        const bodyText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || '');
        if (bodyText.includes('access denied') || bodyText.includes('you have been blocked') ||
            bodyText.includes('bot detected')) {
          result.stillBlocked = true;
        }
      }
    }

    return result;
  }

  // --- CAPTCHA Solving -- Direct Integration ---------------------------------

  private async solveCaptcha(
    url: string,
    siteKey: string,
    type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'funcaptcha',
    proxyUrl?: string,
  ): Promise<boolean> {
    try {
      const { captchaSolver } = await import('../captcha/index');
      const result = await captchaSolver.solve({
        type,
        siteKey,
        pageUrl: url,
        proxyUrl,
        allowTokenReuse: true,
      } as any);
      this.stats.captchaSolved++;
      return result.success;
    } catch (err: any) {
      logger.warn({ url, type, error: err.message }, 'CAPTCHA solving failed');
      return false;
    }
  }

  private async getCaptchaToken(
    url: string,
    siteKey: string,
    type: string,
  ): Promise<string | null> {
    try {
      const { captchaSolver } = await import('../captcha/index');
      const result = await captchaSolver.solve({
        type: type as any,
        siteKey,
        pageUrl: url,
        allowTokenReuse: true,
      } as any);
      return result.success ? result.token : null;
    } catch { return null; }
  }

  // --- Smart Resource Blocking ----------------------------------------------

  private async setupSmartResourceBlocking(
    page: Page,
    blockResources: ('image' | 'stylesheet' | 'font' | 'media')[] | undefined,
    strategy: UnlockStrategy,
    stealthLevel: StealthLevel,
  ): Promise<void> {
    // Determine what to block based on strategy + stealth level
    let smartDefaults = SMART_BLOCK_RULES[strategy]?.[stealthLevel] || ['media', 'analytics', 'social'];

    // If user explicitly specified resources to block, use those instead
    const toBlock = blockResources || smartDefaults;
    if (toBlock.length === 0) return;

    const patterns: RegExp[] = [];
    for (const resourceType of toBlock) {
      const typePatterns = RESOURCE_BLOCK_PATTERNS[resourceType];
      if (typePatterns) patterns.push(...typePatterns);
    }

    if (patterns.length === 0) return;

    await page.route('**/*', (route) => {
      const url = route.request().url();
      const resourceType = route.request().resourceType();

      // Smart blocking: check URL patterns and resource type
      const shouldBlock = patterns.some(pattern => pattern.test(url));

      // Also check resource type for media
      if (!shouldBlock && toBlock.includes('media') && ['media', 'video', 'audio'].includes(resourceType)) {
        route.abort();
        return;
      }

      if (shouldBlock) route.abort();
      else route.continue();
    });
  }

  // --- Maximum Stealth Script -- Enhanced -------------------------------------

  private getMaximumStealthScript(profile: BrowserProfile): string {
    return `
      // --- Maximum stealth overrides -- HYPERDRIVE MEGA EDITION ----------

      // Override getBoundingClientRect with subtle noise
      const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function() {
        const rect = originalGetBoundingClientRect.call(this);
        const noise = () => (Math.random() - 0.5) * 0.01;
        return new DOMRect(rect.x + noise(), rect.y + noise(), rect.width + noise(), rect.height + noise());
      };

      // Override navigator.connection
      if (!navigator.connection) {
        Object.defineProperty(navigator, 'connection', {
          get: () => ({
            effectiveType: '4g', rtt: 50 + Math.floor(Math.random() * 50),
            downlink: 5 + Math.random() * 10, saveData: false, onchange: null,
            addEventListener: function() {}, removeEventListener: function() {},
          }),
          configurable: true,
        });
      }

      // Override WebGL2 fingerprinting
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(param) {
          if (param === 37445) return '${profile.webGlVendor}';
          if (param === 37446) return '${profile.webGlRenderer}';
          return getParameter2.call(this, param);
        };
      }

      // Override getExtension
      const originalGetExtension = WebGLRenderingContext.prototype.getExtension;
      WebGLRenderingContext.prototype.getExtension = function(name) {
        if (name === 'WEBGL_debug_renderer_info') {
          return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
        }
        return originalGetExtension.call(this, name);
      };

      // Mock chrome.runtime -- comprehensive
      if (!window.chrome) window.chrome = {};
      window.chrome.runtime = {
        connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} }; },
        sendMessage: function() {},
        onMessage: { addListener: function() {} },
        id: undefined,
      };

      // Remove ALL automation indicators
      const automationProps = [
        '__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_fn',
        '__driver_evaluate', '__webdriver_unwrapped', '__driver_unwrapped',
        '__selenium_unwrapped', '__fxdriver_evaluate', '__fxdriver_unwrapped',
        '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium',
        '__nightmare', '__phantomas', 'domAutomation', 'domAutomationController',
        '__nightmare_evaluate', '__phantomas_evaluate',
        'spawn', 'emit', 'buffer',
        '__puppeteer_evaluation_script__',
        '_cdc_adoQpoasnfa76pfcZLmcfl_Array',
        '_cdc_adoQpoasnfa76pfcZLmcfl_Promise',
        '_cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
      ];
      for (const prop of automationProps) {
        if (prop in window || prop in document) {
          try { delete (window as any)[prop]; } catch {}
          try { delete (document as any)[prop]; } catch {}
        }
      }

      // Override document.hasFocus
      Document.prototype.hasFocus = function() { return true; };

      // Override window dimensions
      Object.defineProperty(window, 'outerHeight', { get: () => ${profile.viewport.height} + 85, configurable: true });
      Object.defineProperty(window, 'outerWidth', { get: () => ${profile.viewport.width}, configurable: true });
      Object.defineProperty(window, 'innerHeight', { get: () => ${profile.viewport.height}, configurable: true });
      Object.defineProperty(window, 'innerWidth', { get: () => ${profile.viewport.width}, configurable: true });

      // Performance timing fix -- subtle noise
      const originalNow = performance.now.bind(performance);
      performance.now = function() { return originalNow() + Math.random() * 0.01; };

      // Override Notification.permission
      if (Notification.permission === 'denied') {
        Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
      }

      // Override navigator.plugins to look realistic
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ],
        configurable: true,
      });

      // Override navigator.languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['${profile.locale}', 'en'],
        configurable: true,
      });

      // Fix iframe contentWindow cross-origin issues
      try {
        const origAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function() { return origAttachShadow.apply(this, arguments); };
      } catch(e) {}

      // Override navigator.getBattery for consistency
      if (navigator.getBattery) {
        navigator.getBattery = () => Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 0.95 + Math.random() * 0.05,
          addEventListener: () => {},
        });
      }

      // Override screen.orientation
      if (!window.screen.orientation) {
        Object.defineProperty(window.screen, 'orientation', {
          get: () => ({ type: 'landscape-primary', angle: 0 }),
        });
      }

      // Anti-fingerprinting: Canvas noise injection
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          try {
            const imageData = ctx.getImageData(0, 0, Math.min(this.width, 1), Math.min(this.height, 1));
            if (imageData.data.length > 0) {
              imageData.data[0] = imageData.data[0] + Math.floor(Math.random() * 2 - 1);
              ctx.putImageData(imageData, 0, 0);
            }
          } catch(e) {}
        }
        return originalToDataURL.apply(this, arguments);
      };

      // AudioContext noise injection
      if (typeof AnalyserNode !== 'undefined') {
        const originalGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
        AnalyserNode.prototype.getFloatFrequencyData = function(array) {
          originalGetFloatFrequencyData.call(this, array);
          for (let i = 0; i < array.length; i++) {
            array[i] += (Math.random() - 0.5) * 0.001;
          }
        };
      }

      // Mouse event isTrusted fix
      const originalMouseEvent = MouseEvent;
      window.MouseEvent = function(type, init) {
        const event = new originalMouseEvent(type, { ...init, bubbles: true });
        return event;
      };
      window.MouseEvent.prototype = originalMouseEvent.prototype;
    `;
  }

  // --- Browser Pool Management -- Enhanced with Health Tracking ---------------

  private async acquireBrowser(domainAffinity?: string): Promise<PooledBrowser> {
    // Find an idle browser, prefer one with domain affinity
    const affinityMatch = domainAffinity
      ? this.browserPool.find(b => !b.isBusy && b.requestCount < MAX_REQUESTS_PER_BROWSER && b.domainAffinity === domainAffinity && b.healthScore >= BROWSER_HEALTH_THRESHOLD)
      : null;

    if (affinityMatch) {
      affinityMatch.isBusy = true;
      affinityMatch.lastUsed = Date.now();
      affinityMatch.requestCount++;
      if (domainAffinity) affinityMatch.visitedDomains.add(domainAffinity);
      return affinityMatch;
    }

    // Find any idle healthy browser
    const idle = this.browserPool.find(b => !b.isBusy && b.requestCount < MAX_REQUESTS_PER_BROWSER && b.healthScore >= BROWSER_HEALTH_THRESHOLD);
    if (idle) {
      idle.isBusy = true;
      idle.lastUsed = Date.now();
      idle.requestCount++;
      if (domainAffinity) {
        idle.domainAffinity = domainAffinity;
        idle.visitedDomains.add(domainAffinity);
      }
      return idle;
    }

    // Launch a new browser if under limit
    if (this.browserPool.length < MAX_CONCURRENT_BROWSERS) {
      const newBrowser = await this.launchBrowser(domainAffinity);
      newBrowser.isBusy = true;
      newBrowser.requestCount++;
      if (domainAffinity) newBrowser.visitedDomains.add(domainAffinity);
      return newBrowser;
    }

    // Wait for a browser to become available
    return new Promise<PooledBrowser>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Timed out waiting for available browser')); }, 30_000);

      const checkInterval = setInterval(() => {
        const available = this.browserPool.find(b => !b.isBusy && b.requestCount < MAX_REQUESTS_PER_BROWSER);
        if (available) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          available.isBusy = true;
          available.lastUsed = Date.now();
          available.requestCount++;
          if (domainAffinity) {
            available.domainAffinity = domainAffinity;
            available.visitedDomains.add(domainAffinity);
          }
          resolve(available);
        }
      }, 200);
    });
  }

  private async launchBrowser(domainAffinity?: string): Promise<PooledBrowser> {
    const id = `wu-browser-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const fingerprintId = `fp-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

    logger.info({ browserId: id, poolSize: this.browserPool.length + 1, domainAffinity }, 'Launching browser');

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-component-update',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--metrics-recording-only',
        '--safebrowsing-disable-auto-update',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
        '--js-flags=--max-old-space-size=256',
        '--disable-features=site-per-process',
        '--disable-web-security',
        '--disable-features=IsolateOrigins',
        '--window-size=1920,1080',
      ],
    });

    const pooled: PooledBrowser = {
      id,
      browser,
      requestCount: 0,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isBusy: false,
      fingerprintId,
      domainAffinity: domainAffinity || null,
      visitedDomains: new Set(),
      healthScore: 1.0,
      consecutiveFailures: 0,
      successCount: 0,
    };

    this.browserPool.push(pooled);
    return pooled;
  }

  private async maintainPool(): Promise<void> {
    const now = Date.now();
    const toRemove: PooledBrowser[] = [];

    for (const pooled of this.browserPool) {
      // Recycle browsers that exceeded max requests (faster recycling at 20)
      if (pooled.requestCount >= MAX_REQUESTS_PER_BROWSER && !pooled.isBusy) {
        toRemove.push(pooled);
        continue;
      }

      // Recycle unhealthy browsers
      if (pooled.healthScore < BROWSER_HEALTH_THRESHOLD && !pooled.isBusy && pooled.consecutiveFailures >= 3) {
        toRemove.push(pooled);
        continue;
      }

      // Close idle browsers beyond minimum pool size (faster timeout at 2min)
      if (!pooled.isBusy &&
          now - pooled.lastUsed > BROWSER_IDLE_TIMEOUT_MS &&
          this.browserPool.length - toRemove.length > MIN_POOL_SIZE) {
        toRemove.push(pooled);
      }
    }

    for (const pooled of toRemove) {
      try {
        await pooled.browser.close();
        this.browserPool = this.browserPool.filter(b => b.id !== pooled.id);
        logger.info({ browserId: pooled.id, requestCount: pooled.requestCount, healthScore: pooled.healthScore }, 'Browser recycled');
      } catch (err: any) {
        logger.error({ browserId: pooled.id, error: err.message }, 'Failed to close browser');
        this.browserPool = this.browserPool.filter(b => b.id !== pooled.id);
      }
    }

    // Ensure minimum pool size
    while (this.browserPool.length < MIN_POOL_SIZE) {
      try {
        await this.launchBrowser();
      } catch (err: any) {
        logger.error({ error: err.message }, 'Failed to maintain minimum pool size');
        break;
      }
    }
  }

  // --- Proxy Integration ----------------------------------------------------

  private async getProxy(
    domain: string,
    tier?: 'residential' | 'mobile' | 'datacenter' | 'isp',
    country?: string,
    sessionId?: string,
  ): Promise<{ proxyUrl: string; proxyId: string } | null> {
    try {
      const { proxyManager } = await import('./manager');
      const selection = await proxyManager.getProxy(
        domain,
        tier || 'residential',
        country,
        'least-failures',
        { sessionId },
      );

      if (selection) {
        return { proxyUrl: selection.proxyUrl, proxyId: selection.proxyId };
      }
    } catch (err: any) {
      logger.debug({ domain, error: err.message }, 'Proxy manager not available');
    }
    return null;
  }

  // --- Cookie Management -- Smarter Cookie Jar with Domain-Specific Policies --

  /**
   * Classify a cookie by priority based on domain-specific rules.
   */
  private classifyCookie(cookie: Cookie): ClassifiedCookie {
    for (const rule of COOKIE_CLASSIFICATION_RULES) {
      if (rule.pattern.test(cookie.name)) {
        return { cookie, priority: rule.priority, reason: rule.reason };
      }
    }

    // Default classification
    return { cookie, priority: 'standard', reason: 'No matching rule' };
  }

  /**
   * Save cookies with smart classification and domain-specific policies.
   */
  private async saveCookies(domain: string, cookies: Cookie[]): Promise<void> {
    if (!cookies || cookies.length === 0) return;

    try {
      const key = `cookies:${domain}`;
      const existing = await this.loadClassifiedCookies(domain) || [];

      // Merge: new cookies overwrite existing ones with the same name+domain+path
      const merged = new Map<string, ClassifiedCookie>();

      for (const classified of [...existing, ...cookies.map(c => this.classifyCookie(c))]) {
        const mapKey = `${classified.cookie.name}:${classified.cookie.domain}:${classified.cookie.path}`;
        const current = merged.get(mapKey);

        // Never downgrade priority -- if existing is critical, keep it
        if (current) {
          const priorityOrder: Record<CookiePriority, number> = { critical: 0, important: 1, standard: 2, discard: 3 };
          if (priorityOrder[classified.priority] < priorityOrder[current.priority]) {
            merged.set(mapKey, classified);
          } else {
            // Update cookie value but keep higher priority
            merged.set(mapKey, {
              ...classified,
              priority: current.priority,
              reason: current.reason,
            });
          }
        } else {
          merged.set(mapKey, classified);
        }
      }

      // Apply domain-specific cookie policies
      const filteredCookies = this.applyCookiePolicies(domain, Array.from(merged.values()));

      await cacheSet(key, filteredCookies, COOKIE_TTL_SECONDS);
    } catch (err: any) {
      logger.debug({ domain, error: err.message }, 'Failed to save cookies');
    }
  }

  private applyCookiePolicies(domain: string, classifiedCookies: ClassifiedCookie[]): ClassifiedCookie[] {
    // Domain-specific policies
    const policies: Record<string, (c: ClassifiedCookie) => boolean> = {
      // Default: keep everything except discarded cookies that are expired
      default: (c) => c.priority !== 'discard' || (c.cookie.expires === -1 || c.cookie.expires > Date.now() / 1000),
    };

    const policy = policies[domain] || policies.default;
    return classifiedCookies.filter(policy);
  }

  private async loadCookies(domain: string): Promise<ClassifiedCookie[] | null> {
    try {
      const key = `cookies:${domain}`;
      return await this.loadClassifiedCookies(domain);
    } catch { return null; }
  }

  private async loadClassifiedCookies(domain: string): Promise<ClassifiedCookie[] | null> {
    try {
      const key = `cookies:${domain}`;
      const raw = await cacheGet<any[]>(key);
      if (!raw) return null;

      // Handle both classified and raw cookie formats for backward compatibility
      return raw.map((item: any) => {
        if (item.priority && item.cookie) {
          return item as ClassifiedCookie;
        }
        // Raw cookie format -- classify it
        return this.classifyCookie(item as Cookie);
      });
    } catch { return null; }
  }

  private async saveCookiesFromHeader(domain: string, setCookieHeader: string): Promise<void> {
    try {
      const cookies: Cookie[] = [];
      const cookieStrings = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];

      for (const cookieStr of cookieStrings) {
        const parts = cookieStr.split(';').map(p => p.trim());
        const [nameValue] = parts;
        if (!nameValue) continue;

        const eqIndex = nameValue.indexOf('=');
        if (eqIndex === -1) continue;

        const name = nameValue.substring(0, eqIndex);
        const value = nameValue.substring(eqIndex + 1);

        const cookie: Cookie = {
          name, value, domain, path: '/', expires: -1,
          httpOnly: false, secure: false, sameSite: 'Lax',
        };

        for (const part of parts.slice(1)) {
          const lower = part.toLowerCase();
          if (lower.startsWith('path=')) cookie.path = part.substring(5);
          else if (lower.startsWith('domain=')) cookie.domain = part.substring(7);
          else if (lower === 'httponly') cookie.httpOnly = true;
          else if (lower === 'secure') cookie.secure = true;
          else if (lower.startsWith('samesite=')) cookie.sameSite = part.substring(9) as any;
          else if (lower.startsWith('max-age=')) {
            const maxAge = parseInt(part.substring(8), 10);
            cookie.expires = maxAge > 0 ? Date.now() / 1000 + maxAge : -1;
          } else if (lower.startsWith('expires=')) {
            const expires = new Date(part.substring(8)).getTime() / 1000;
            if (!isNaN(expires)) cookie.expires = expires;
          }
        }

        cookies.push(cookie);
      }

      if (cookies.length > 0) await this.saveCookies(domain, cookies);
    } catch (err: any) {
      logger.debug({ domain, error: err.message }, 'Failed to save cookies from header');
    }
  }

  // --- Session Persistence -- Enhanced --------------------------------------

  private async saveSession(sessionId: string, state: SessionState): Promise<void> {
    try {
      const key = `session:${sessionId}`;
      await cacheSet(key, state, SESSION_TTL_SECONDS);
      this.sessionCache.set(sessionId, state);
    } catch (err: any) {
      logger.debug({ sessionId, error: err.message }, 'Failed to save session');
    }
  }

  private async loadSession(sessionId: string): Promise<SessionState | null> {
    // Check in-memory cache first
    const cached = this.sessionCache.get(sessionId);
    if (cached) return cached;

    try {
      const key = `session:${sessionId}`;
      const state = await cacheGet<SessionState>(key);
      if (state) {
        this.sessionCache.set(sessionId, state);
      }
      return state;
    } catch {
      return null;
    }
  }

  private async extractLocalStorage(page: Page): Promise<Record<string, string>> {
    try {
      return await page.evaluate(() => {
        const data: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) data[key] = localStorage.getItem(key) || '';
        }
        return data;
      });
    } catch {
      return {};
    }
  }

  private async extractSessionStorage(page: Page): Promise<Record<string, string>> {
    try {
      return await page.evaluate(() => {
        const data: Record<string, string> = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key) data[key] = sessionStorage.getItem(key) || '';
        }
        return data;
      });
    } catch {
      return {};
    }
  }

  // --- Unlocker Intelligence -- Enhanced with EMA ----------------------------

  private updateDomainIntelligence(
    domain: string,
    strategy: UnlockStrategy,
    stealthLevel: StealthLevel,
    result: UnlockResult,
  ): void {
    let intel = this.domainIntelligence.get(domain);

    if (!intel) {
      intel = {
        domain,
        bestStrategy: strategy,
        bestStealthLevel: stealthLevel,
        successRate: result.success ? 1 : 0,
        avgTime: result.totalTimeMs,
        sampleCount: 1,
        lastUpdated: Date.now(),
        knownChallenges: [],
        preferredProxyTier: 'residential',
        emaSuccessRate: result.success ? 1 : 0,
        recentResults: [{ success: result.success, timestamp: Date.now(), strategy, stealthLevel }],
        failedStrategies: [],
        peakRenderTimeMs: result.renderTimeMs,
        minRenderTimeMs: result.renderTimeMs,
        typicallyRequiresCaptcha: result.captchaDetected,
        typicallyRequiresSession: result.sessionUsed,
      };
      this.domainIntelligence.set(domain, intel);
      return;
    }

    intel.sampleCount++;
    intel.lastUpdated = Date.now();

    // Update EMA success rate -- more responsive to recent changes
    const alpha = INTELLIGENCE_EMA_ALPHA;
    intel.emaSuccessRate = alpha * (result.success ? 1 : 0) + (1 - alpha) * intel.emaSuccessRate;

    // Update overall success rate
    const totalSuccess = intel.successRate * (intel.sampleCount - 1) + (result.success ? 1 : 0);
    intel.successRate = totalSuccess / intel.sampleCount;

    // Update average time
    intel.avgTime = (intel.avgTime * (intel.sampleCount - 1) + result.totalTimeMs) / intel.sampleCount;

    // Update render time stats
    if (result.renderTimeMs > 0) {
      intel.peakRenderTimeMs = Math.max(intel.peakRenderTimeMs, result.renderTimeMs);
      intel.minRenderTimeMs = intel.minRenderTimeMs > 0 ? Math.min(intel.minRenderTimeMs, result.renderTimeMs) : result.renderTimeMs;
    }

    // Track recent results for EMA
    intel.recentResults.push({ success: result.success, timestamp: Date.now(), strategy, stealthLevel });
    // Trim old results beyond window
    const cutoff = Date.now() - INTELLIGENCE_RECENT_WINDOW_MS;
    intel.recentResults = intel.recentResults.filter(r => r.timestamp > cutoff);

    // Track failed strategies
    if (!result.success) {
      intel.failedStrategies.push({ strategy, stealthLevel, timestamp: Date.now() });
      // Trim old failures
      intel.failedStrategies = intel.failedStrategies.filter(f => f.timestamp > cutoff);

      // If CAPTCHA was detected, note it
      if (result.captchaDetected) {
        intel.typicallyRequiresCaptcha = true;
      }
    }

    // If session was used successfully, note it
    if (result.success && result.sessionUsed) {
      intel.typicallyRequiresSession = true;
    }

    // Track known challenges
    if (result.challengeUsed && !intel.knownChallenges.includes(result.challengeUsed)) {
      intel.knownChallenges.push(result.challengeUsed);
    }

    // Update best strategy based on recent results
    if (result.success) {
      // Find the best strategy from recent results
      const recentSuccesses = intel.recentResults.filter(r => r.success);
      if (recentSuccesses.length >= INTELLIGENCE_MIN_SAMPLES) {
        // Count strategy occurrences in recent successes
        const strategyCounts: Record<string, number> = {};
        for (const r of recentSuccesses) {
          const key = `${r.strategy}:${r.stealthLevel}`;
          strategyCounts[key] = (strategyCounts[key] || 0) + 1;
        }
        // Find the most successful strategy
        const bestKey = Object.entries(strategyCounts).sort((a, b) => b[1] - a[1])[0];
        if (bestKey) {
          const [bestStrategy, bestStealth] = bestKey[0].split(':');
          intel.bestStrategy = bestStrategy as UnlockStrategy;
          intel.bestStealthLevel = bestStealth as StealthLevel;
        }
      }

      // Determine preferred proxy tier from recent successes
      if (result.proxyUsed) {
        // If mobile proxy succeeded, prefer it for this domain
        intel.preferredProxyTier = 'residential';
      }
    }

    // Enforce max intelligence size
    if (this.domainIntelligence.size > MAX_DOMAIN_INTELLIGENCE) {
      // Remove oldest entries
      const entries = Array.from(this.domainIntelligence.entries())
        .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
      const toRemove = entries.slice(0, entries.length - MAX_DOMAIN_INTELLIGENCE);
      for (const [key] of toRemove) {
        this.domainIntelligence.delete(key);
      }
    }
  }

  /**
   * Persist domain intelligence to Redis for cross-restart survival.
   */
  private async syncIntelligenceToRedis(): Promise<void> {
    try {
      const serialized = Array.from(this.domainIntelligence.entries()).map(([domain, intel]) => ({
        domain,
        bestStrategy: intel.bestStrategy,
        bestStealthLevel: intel.bestStealthLevel,
        successRate: intel.successRate,
        avgTime: intel.avgTime,
        sampleCount: intel.sampleCount,
        lastUpdated: intel.lastUpdated,
        knownChallenges: intel.knownChallenges,
        preferredProxyTier: intel.preferredProxyTier,
        emaSuccessRate: intel.emaSuccessRate,
        typicallyRequiresCaptcha: intel.typicallyRequiresCaptcha,
        typicallyRequiresSession: intel.typicallyRequiresSession,
        peakRenderTimeMs: intel.peakRenderTimeMs,
        minRenderTimeMs: intel.minRenderTimeMs,
      }));
      await cacheSet('web-unlocker:intelligence', serialized, 3600);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Failed to sync intelligence to Redis');
    }
  }

  /**
   * Load domain intelligence from Redis.
   */
  private async loadIntelligenceFromRedis(): Promise<void> {
    try {
      const cached = await cacheGet<any[]>('web-unlocker:intelligence');
      if (!cached || !Array.isArray(cached)) return;

      for (const entry of cached) {
        this.domainIntelligence.set(entry.domain, {
          domain: entry.domain,
          bestStrategy: entry.bestStrategy,
          bestStealthLevel: entry.bestStealthLevel,
          successRate: entry.successRate,
          avgTime: entry.avgTime,
          sampleCount: entry.sampleCount,
          lastUpdated: entry.lastUpdated,
          knownChallenges: entry.knownChallenges || [],
          preferredProxyTier: entry.preferredProxyTier || 'residential',
          emaSuccessRate: entry.emaSuccessRate || entry.successRate,
          recentResults: [],
          failedStrategies: [],
          peakRenderTimeMs: entry.peakRenderTimeMs || 0,
          minRenderTimeMs: entry.minRenderTimeMs || 0,
          typicallyRequiresCaptcha: entry.typicallyRequiresCaptcha || false,
          typicallyRequiresSession: entry.typicallyRequiresSession || false,
        });
      }

      logger.info({ entries: cached.length }, 'Loaded domain intelligence from Redis');
    } catch {}
  }

  // --- Stats Recording -------------------------------------------------------

  private recordStats(
    domain: string,
    strategy: UnlockStrategy,
    stealthLevel: StealthLevel,
    result: UnlockResult,
    totalTimeMs: number,
  ): void {
    // Overall stats
    if (result.success) this.stats.successfulRequests++;
    else this.stats.failedRequests++;

    if (result.captchaDetected) this.stats.captchaDetected++;
    if (result.captchaSolved) this.stats.captchaSolved++;
    this.stats.totalRenderTimeMs += result.renderTimeMs;
    this.stats.totalTotalTimeMs += totalTimeMs;

    // By strategy
    const strategyStats = this.stats.byStrategy[strategy];
    strategyStats.count++;
    if (result.success) strategyStats.successCount++;
    strategyStats.totalTime += totalTimeMs;

    // By stealth level
    const stealthStats = this.stats.byStealthLevel[stealthLevel];
    stealthStats.count++;
    if (result.success) stealthStats.successCount++;

    // By domain
    if (!this.stats.byDomain[domain]) {
      this.stats.byDomain[domain] = {
        count: 0, successCount: 0, totalTime: 0, captchaCount: 0,
        bestStrategy: strategy, bestStealthLevel: stealthLevel,
      };
    }
    const domainStats = this.stats.byDomain[domain];
    domainStats.count++;
    if (result.success) domainStats.successCount++;
    domainStats.totalTime += totalTimeMs;
    if (result.captchaDetected) domainStats.captchaCount++;
    // Update best strategy/stealth for domain
    if (result.success && domainStats.successCount > 0) {
      const successRate = domainStats.successCount / domainStats.count;
      if (successRate > 0.7 || domainStats.count <= 3) {
        domainStats.bestStrategy = strategy;
        domainStats.bestStealthLevel = stealthLevel;
      }
    }
  }

  // --- Queue Management -------------------------------------------------------

  private processQueue(): void {
    if (this.requestQueue.length === 0) return;

    // Remove stale requests (waited too long)
    const now = Date.now();
    this.requestQueue = this.requestQueue.filter(r => now - r.enqueuedAt < QUEUE_MAX_WAIT_MS);

    // Process next request if capacity available
    while (this.requestQueue.length > 0 && this.activeRequests < MAX_CONCURRENT_BROWSERS) {
      const next = this.requestQueue.shift();
      if (next) {
        // Re-execute the queued request
        this.unlock(next.request).then(next.resolve).catch(next.reject);
      }
    }
  }

  private calculateQueuePriority(request: UnlockRequest): number {
    // Higher stealth levels get higher priority
    if (request.stealthLevel === 'maximum' || request.stealthLevel === 'high') return QUEUE_PRIORITY_HIGH;
    if (request.stealthLevel === 'medium') return QUEUE_PRIORITY_NORMAL;
    return QUEUE_PRIORITY_LOW;
  }

  // --- Data Extraction -------------------------------------------------------

  private extractDataFromHtml(html: string, selector: string): Record<string, any> {
    // Simple regex-based extraction for HTTP strategy
    const data: Record<string, any> = {};
    try {
      // Try to extract title
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) data.title = titleMatch[1].trim();

      // Try to extract meta description
      const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
      if (descMatch) data.description = descMatch[1].trim();
    } catch {}
    return data;
  }

  private async extractDataFromPage(page: Page, selector: string): Promise<Record<string, any>> {
    const data: Record<string, any> = {};
    try {
      // Extract text content from elements matching the selector
      const elements = await page.$$(selector);
      if (elements.length > 0) {
        data.count = elements.length;
        data.items = await Promise.all(
          elements.slice(0, 50).map(el => el.textContent().then(t => t?.trim() || ''))
        );
      }

      // Extract page title
      data.title = await page.title();
    } catch {}
    return data;
  }

  // --- Utility Methods -------------------------------------------------------

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  private summarizeDetection(detection: any): string {
    const parts: string[] = [];
    if (detection.cloudflare) parts.push(`CF:${detection.cloudflareVariant}`);
    if (detection.datadome) parts.push('DataDome');
    if (detection.akamai) parts.push('Akamai');
    if (detection.perimeterX) parts.push('PerimeterX');
    if (detection.imperva) parts.push('Imperva');
    if (detection.kasada) parts.push('Kasada');
    if (detection.shape) parts.push('Shape/F5');
    if (detection.hasCaptcha) parts.push(`CAPTCHA:${detection.captchaType || 'unknown'}`);
    return parts.join('+') || 'unknown';
  }

  private buildSecChUa(userAgent: string): string {
    if (userAgent.includes('Firefox')) return '';
    if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
      return '"Not A(Brand";v="99", "Safari";v="605", "ACGI";v="1"';
    }
    return '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"';
  }
}

// --- Singleton Export ---------------------------------------------------------

export const webUnlocker = new WebUnlocker();
