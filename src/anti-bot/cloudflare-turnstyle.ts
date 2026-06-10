/**
 * Cloudflare Turnstile Challenge Solver -- ScrapeSuite Engine
 *
 * Dedicated Cloudflare Turnstile challenge solver that extends the AntiBotBase
 * framework to handle Cloudflare's challenge system. This module covers:
 *
 *  1. CHALLENGE DETECTION -- Identifies Cloudflare challenge pages with high
 *     confidence using DOM selectors, HTTP headers, cookies, and text patterns.
 *
 *  2. CHALLENGE TYPE IDENTIFICATION -- Classifies the Turnstile challenge as
 *     Managed, Non-Interactive, Interactive, or Force Interactive, each
 *     requiring a different bypass approach.
 *
 *  3. MANAGED / NON-INTERACTIVE AUTO-RESOLUTION -- Waits for invisible
 *     challenges to auto-resolve with proper timing, monitoring DOM changes
 *     and cookie appearance to detect success.
 *
 *  4. INTERACTIVE CHALLENGE SOLVER -- Locates the Turnstile checkbox widget
 *     inside the challenge iframe and clicks it with human-like timing,
 *     movement, and interaction patterns.
 *
 *  5. CF_CLEARANCE EXTRACTION & CACHING -- Captures the cf_clearance cookie
 *     after challenge resolution, caches it in Redis with its ~30 minute
 *     lifetime, and reuses it across sessions.
 *
 *  6. PROFILE ROTATION FALLBACK -- When a challenge fails or a domain enters
 *     cooldown, the module escalates to profile rotation, switching browser
 *     fingerprints and proxy configurations for a fresh attempt.
 *
 *  7. ANTI-DETECTION -- Injects Cloudflare-specific countermeasures against
 *     navigator.webdriver, chrome runtime, and other CF detection vectors.
 *
 * Bypass success rate target: 85-95% on managed/non-interactive, 60-75% on
 * interactive challenges.
 */

import type { Page, BrowserContext, CDPSession, ElementHandle, Frame } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import {
  type AntiBotPlatform,
  type BypassStrategy,
  type ChallengePhase,
  type AntiBotResult,
  type BypassContext,
  type PlatformDetectionResult,
  type DetectionIndicator,
  type ManagedCookie,
  type PlatformProfile,
  type DetectionSeverity,
  DEFAULT_PLATFORM_CONFIGS,
  STRATEGY_ESCALATION,
} from './types';
import { AntiBotBase } from './base';

const logger = createChildLogger('cloudflare-turnstile');

// ===============================================================================
// TURNSTILE CHALLENGE TYPES
// ===============================================================================

/** Cloudflare Turnstile challenge classification. */
export type TurnstileChallengeType =
  | 'managed'            // Invisible, auto-solves if browser is clean
  | 'non-interactive'    // No user action, just wait for JS execution
  | 'interactive'        // Requires clicking a checkbox widget
  | 'force-interactive'  // Always requires interaction (rare, aggressive)
  | 'unknown';           // Cannot determine challenge type

/** Result of classifying a Turnstile challenge. */
export interface TurnstileClassification {
  /** The identified challenge type. */
  challengeType: TurnstileChallengeType;
  /** How confident we are in this classification (0-1). */
  confidence: number;
  /** DOM / header evidence that led to this classification. */
  evidence: string[];
}

/** State of a Turnstile challenge resolution attempt. */
export interface TurnstileResolutionState {
  /** Whether the challenge has been detected. */
  detected: boolean;
  /** Classified challenge type. */
  challengeType: TurnstileChallengeType;
  /** Current phase of resolution. */
  phase: ChallengePhase;
  /** How many resolution attempts have been made. */
  attempts: number;
  /** Timestamp when detection began. */
  startedAt: number;
  /** Timestamp when resolution completed (0 if ongoing). */
  completedAt: number;
  /** Any errors encountered. */
  errors: string[];
}

// ===============================================================================
// CLOUDFLARE DETECTION CONSTANTS
// ===============================================================================

/** DOM selectors that indicate a Cloudflare challenge page. */
const CF_DOM_SELECTORS = [
  '#challenge-running',
  '#challenge-stage',
  '#challenge-success',
  '#challenge-error',
  '#challenge-form',
  '.challenge-platform',
  '#cf-please-wait',
  '#cf-spinner-allow-5-secs',
  '#cf-challenge-running',
  '#turnstile-wrapper',
  '.cf-turnstile',
  '[data-sitekey]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="cdn-cgi/challenge-platform"]',
  '#cf-chl-widget',
  '#cf-chl-progress',
];

/** HTTP response headers that indicate Cloudflare is present. */
const CF_INDICATIVE_HEADERS: Record<string, boolean> = {
  'cf-ray': true,
  'cf-cache-status': true,
  'server': true, // checked for value "cloudflare"
  'cf-mitigated': true,
  'cf-chl-bypass': true,
  'cf-chl-out': true,
};

/** Cookie names associated with Cloudflare challenges. */
const CF_COOKIE_NAMES = [
  'cf_clearance',
  '__cf_bm',
  'cf_chl_rc',
  'cf_chl_2',
  'cf_chl_prog',
  'cf_use_ob',
];

/** Title text patterns found on Cloudflare challenge pages. */
const CF_TITLE_PATTERNS = [
  'just a moment',
  'checking your browser',
  'attention required',
  'please wait',
  'verifying you are human',
  'enable javascript and cookies to continue',
];

/** Body text patterns found on Cloudflare challenge pages. */
const CF_BODY_PATTERNS = [
  'please wait... | cloudflare',
  'enable javascript and cookies to continue',
  'checking if the site connection is secure',
  'needs to review the security of your connection',
  'verify you are human',
  'this process is automatic',
  'cloudflare ray id',
  'performance & security by cloudflare',
  'challenges.cloudflare.com',
  'challenge-platform',
  'turnstile/v0/api.js',
  'orchestrate-chl',
];

/** Script URL patterns that indicate Cloudflare challenge execution. */
const CF_SCRIPT_PATTERNS = [
  'challenge-platform/h/b/orchestrate-chl/',
  'turnstile/v0/api.js',
  'cdn-cgi/challenge-platform/',
  'challenges.cloudflare.com/cdn-cgi/challenge-platform',
  'cdn-cgi/scripts/',
  'cf-beacon.min.js',
];

// ===============================================================================
// TIMING & THRESHOLD CONSTANTS
// ===============================================================================

/** Approximate lifetime of cf_clearance cookie (30 minutes). */
const CF_CLEARANCE_LIFETIME_MS = 30 * 60 * 1000;

/** Approximate lifetime of __cf_bm cookie (30 minutes). */
const CF_BM_LIFETIME_MS = 30 * 60 * 1000;

/** Maximum time to wait for a managed challenge to auto-resolve. */
const MANAGED_CHALLENGE_TIMEOUT_MS = 15000;

/** Maximum time to wait for an interactive challenge to resolve after click. */
const INTERACTIVE_CHALLENGE_TIMEOUT_MS = 20000;

/** Maximum time to wait for any challenge page to load. */
const CHALLENGE_PAGE_LOAD_TIMEOUT_MS = 10000;

/** Polling interval when monitoring challenge resolution. */
const RESOLUTION_POLL_INTERVAL_MS = 400;

/** Minimum delay before clicking the Turnstile checkbox (human-like). */
const CHECKBOX_MIN_DELAY_MS = 800;

/** Maximum delay before clicking the Turnstile checkbox (human-like). */
const CHECKBOX_MAX_DELAY_MS = 2500;

/** Maximum number of consecutive solve failures before profile rotation. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Detection confidence threshold to trigger bypass. */
const DETECTION_CONFIDENCE_THRESHOLD = 0.3;

// ===============================================================================
// ANTI-DETECTION INJECTION SCRIPT
// ===============================================================================

/**
 * JavaScript injected into Cloudflare challenge pages to defeat common
 * bot-detection signals. Covers navigator.webdriver, chrome runtime,
 * automation markers, and permission API inconsistencies.
 */
const CF_ANTI_DETECTION_SCRIPT = `
  (function() {
    'use strict';

    // --- navigator.webdriver ---------------------------------
    // Cloudflare checks navigator.webdriver -- must be undefined
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    // --- navigator.plugins (non-empty = real browser) --------
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

    // --- navigator.mimeTypes ---------------------------------
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const mimes = [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ];
        mimes.length = 2;
        return mimes;
      },
      configurable: true,
    });

    // --- navigator.languages ---------------------------------
    if (navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });
    }

    // --- chrome runtime (CF checks window.chrome) -----------
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function() {},
        sendMessage: function() {},
        onMessage: { addListener: function() {} },
      };
    }

    // --- Remove automation markers --------------------------
    delete window.__playwright;
    delete window.__pw_manual;
    delete window.__PW_inspect;
    delete window._selenium;
    delete window.__webdriver_evaluate;
    delete window.__selenium_evaluate;
    delete window.__fxdriver_evaluate;
    delete window.__driver_unwrapped;
    delete window.__webdriver_unwrapped;
    delete window.__driver_evaluate;
    delete window.__selenium_unwrapped;
    delete window.__fxdriver_unwrapped;
    delete window.callPhantom;
    delete window._phantom;
    delete window.phantom;
    delete window.__nightmare;

    // --- Permissions API (CF sometimes probes this) ---------
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );

    // --- Connection API rtt (some CF checks) ----------------
    if (navigator.connection && navigator.connection.rtt === 0) {
      Object.defineProperty(navigator.connection, 'rtt', {
        get: () => 100,
        configurable: true,
      });
    }

    // --- Storage estimate (CF checks localStorage) ----------
    try {
      localStorage.setItem('__cf_test', '1');
      localStorage.removeItem('__cf_test');
    } catch(e) {
      // Storage is blocked -- CF will detect this
    }

    // --- Expose detection state for our module --------------
    window.__cf_challenge_state = {
      turnstileWidgetPresent: false,
      checkboxPresent: false,
      challengePhase: 'unknown',
      timestamp: Date.now(),
    };

    // Monitor for Turnstile widget
    const checkTurnstile = setInterval(function() {
      try {
        // Check for Turnstile iframe
        var iframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
        if (iframes.length > 0) {
          window.__cf_challenge_state.turnstileWidgetPresent = true;
        }

        // Check for challenge-running
        var runningEl = document.querySelector('#challenge-running');
        if (runningEl) {
          window.__cf_challenge_state.challengePhase = 'running';
        }

        // Check for challenge-success
        var successEl = document.querySelector('#challenge-success');
        if (successEl) {
          window.__cf_challenge_state.challengePhase = 'success';
          clearInterval(checkTurnstile);
        }

        // Check for challenge-error
        var errorEl = document.querySelector('#challenge-error');
        if (errorEl) {
          window.__cf_challenge_state.challengePhase = 'error';
          clearInterval(checkTurnstile);
        }
      } catch(e) {}
    }, 300);

    // Stop monitoring after 60 seconds
    setTimeout(function() { clearInterval(checkTurnstile); }, 60000);
  })();
`;

// ===============================================================================
// CLOUDFLARE TURNSTILE SOLVER CLASS
// ===============================================================================

class CloudflareTurnstileSolver extends AntiBotBase {
  readonly platform: AntiBotPlatform = 'cloudflare';

  /** Per-domain challenge type memory. */
  private challengeTypeMemory = new Map<string, TurnstileChallengeType>();

  /** Active resolution states keyed by domain. */
  private activeResolutions = new Map<string, TurnstileResolutionState>();

  /** Last observed cf_clearance value per domain (for change detection). */
  private lastCfClearanceValue = new Map<string, string>();

  constructor(configOverride?: Partial<import('./types').AntiBotPlatformConfig>) {
    super(configOverride);
  }

  // --- Platform Override --------------------------------------------------

  protected platformOverride(): AntiBotPlatform {
    return 'cloudflare';
  }

  // --- Detection ----------------------------------------------------------

  /**
   * Detect Cloudflare challenge presence on the current page.
   *
   * Scans DOM selectors, HTTP headers, cookies, page title, body text,
   * and script sources to produce a comprehensive PlatformDetectionResult.
   */
  async detect(ctx: BypassContext): Promise<PlatformDetectionResult> {
    const indicators: DetectionIndicator[] = [];
    let confidence = 0;
    let isRechallenge = false;

    const { page, context } = ctx;

    // -- 1. DOM selector detection ---------------------------------------
    for (const selector of CF_DOM_SELECTORS) {
      try {
        const element = await page.$(selector);
        if (element) {
          indicators.push({
            category: 'dom',
            description: `Cloudflare challenge element found: ${selector}`,
            weight: 0.25,
            rawValue: selector,
          });
          confidence += 0.25;
        }
      } catch {
        // selector evaluation failed -- page may have navigated
      }
    }

    // -- 2. Page title detection -----------------------------------------
    try {
      const title = (await page.title()).toLowerCase();
      for (const pattern of CF_TITLE_PATTERNS) {
        if (title.includes(pattern)) {
          indicators.push({
            category: 'dom',
            description: `Cloudflare challenge title matched: "${pattern}"`,
            weight: 0.2,
            rawValue: title,
          });
          confidence += 0.2;
          break; // one title match is enough
        }
      }
    } catch {
      // title access failed
    }

    // -- 3. Body text detection ------------------------------------------
    try {
      const bodyText = (await page.evaluate(() => document.body?.innerText?.toLowerCase() || ''));
      for (const pattern of CF_BODY_PATTERNS) {
        if (bodyText.includes(pattern.toLowerCase())) {
          indicators.push({
            category: 'dom',
            description: `Cloudflare body text matched: "${pattern}"`,
            weight: 0.15,
            rawValue: pattern,
          });
          confidence += 0.15;
        }
      }
    } catch {
      // body evaluate failed
    }

    // -- 4. Script source detection --------------------------------------
    try {
      const scriptSrcs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('script[src]')).map(s => (s as HTMLScriptElement).src)
      );
      for (const src of scriptSrcs) {
        const lowerSrc = src.toLowerCase();
        for (const pattern of CF_SCRIPT_PATTERNS) {
          if (lowerSrc.includes(pattern.toLowerCase())) {
            indicators.push({
              category: 'script',
              description: `Cloudflare challenge script detected: ${pattern}`,
              weight: 0.3,
              rawValue: src,
            });
            confidence += 0.3;
            break; // one script match per pattern is enough
          }
        }
      }
    } catch {
      // script evaluation failed
    }

    // -- 5. Cookie detection ---------------------------------------------
    try {
      const cookies = await context.cookies();
      for (const cookie of cookies) {
        if (CF_COOKIE_NAMES.includes(cookie.name)) {
          indicators.push({
            category: 'cookie',
            description: `Cloudflare cookie present: ${cookie.name}`,
            weight: cookie.name === 'cf_clearance' ? 0.15 : 0.1,
            rawValue: cookie.name,
          });
          confidence += cookie.name === 'cf_clearance' ? 0.15 : 0.1;
        }
      }

      // A cf_chl_rc cookie means this is a re-challenge
      const hasChlRc = cookies.some(c => c.name === 'cf_chl_rc');
      if (hasChlRc) {
        isRechallenge = true;
      }
    } catch {
      // cookie access failed
    }

    // -- 6. Header-based detection (check response headers via CDP) ------
    if (ctx.cdpSession) {
      try {
        const responseHeaders = await this.getResponseHeadersViaCDP(ctx.cdpSession);
        const serverHeader = responseHeaders['server']?.toLowerCase() || '';
        if (serverHeader === 'cloudflare') {
          indicators.push({
            category: 'header',
            description: 'Server header is "cloudflare"',
            weight: 0.2,
            rawValue: 'server: cloudflare',
          });
          confidence += 0.2;
        }
        for (const headerName of Object.keys(CF_INDICATIVE_HEADERS)) {
          if (responseHeaders[headerName] && headerName !== 'server') {
            indicators.push({
              category: 'header',
              description: `Cloudflare header present: ${headerName}`,
              weight: 0.15,
              rawValue: `${headerName}: ${responseHeaders[headerName]}`,
            });
            confidence += 0.15;
          }
        }
      } catch {
        // CDP header extraction failed
      }
    }

    // -- 7. Classification -----------------------------------------------
    confidence = Math.min(1, confidence);

    const classification = await this.classifyChallenge(page, confidence);
    this.challengeTypeMemory.set(ctx.domain, classification.challengeType);

    // Determine severity
    let severity: DetectionSeverity = 'none';
    if (confidence >= 0.8) severity = 'critical';
    else if (confidence >= 0.6) severity = 'high';
    else if (confidence >= 0.4) severity = 'medium';
    else if (confidence >= DETECTION_CONFIDENCE_THRESHOLD) severity = 'low';

    // Determine recommended strategy
    const recommendedStrategy = this.recommendStrategy(
      classification.challengeType,
      isRechallenge
    );

    logger.info(
      {
        domain: ctx.domain,
        confidence: confidence.toFixed(2),
        challengeType: classification.challengeType,
        severity,
        indicatorCount: indicators.length,
        isRechallenge,
      },
      'Cloudflare Turnstile detection complete'
    );

    return {
      platform: 'cloudflare',
      confidence,
      severity,
      indicators,
      challengeType: classification.challengeType,
      isRechallenge,
      recommendedStrategy,
    };
  }

  // --- Challenge Classification -------------------------------------------

  /**
   * Classify the Turnstile challenge type from DOM and page state.
   *
   * Managed challenges are invisible and auto-resolve. Non-interactive
   * show a progress spinner but need no user action. Interactive challenges
   * display a checkbox. Force-interactive always require clicks.
   */
  private async classifyChallenge(
    page: Page,
    detectionConfidence: number
  ): Promise<TurnstileClassification> {
    const evidence: string[] = [];

    if (detectionConfidence < DETECTION_CONFIDENCE_THRESHOLD) {
      return { challengeType: 'unknown', confidence: 0, evidence };
    }

    let challengeType: TurnstileChallengeType = 'managed';
    let classConfidence = 0.3;

    // Check for interactive elements -- a checkbox input or widget
    try {
      const hasCheckbox = await page.evaluate(() => {
        // Turnstile checkbox is typically inside an iframe
        const iframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
        if (iframes.length > 0) return true;

        // Some implementations embed the widget directly
        const widget = document.querySelector('.cf-turnstile, [data-sitekey], #turnstile-wrapper');
        if (widget) return true;

        // Check for explicit interactive markers
        const challengeStage = document.querySelector('#challenge-stage');
        if (challengeStage) {
          const html = challengeStage.innerHTML?.toLowerCase() || '';
          if (html.includes('checkbox') || html.includes('check')) return true;
        }
        return false;
      });

      if (hasCheckbox) {
        evidence.push('interactive-widget-detected');
        challengeType = 'interactive';
        classConfidence = 0.6;
      }
    } catch {
      // evaluation failed
    }

    // Check for force-interactive (explicit markers)
    try {
      const isForceInteractive = await page.evaluate(() => {
        const body = document.body?.innerText?.toLowerCase() || '';
        // Force interactive typically shows explicit verification prompt
        return body.includes('verify you are human') &&
               !body.includes('checking if the site connection is secure');
      });

      if (isForceInteractive && challengeType === 'interactive') {
        evidence.push('force-interactive-markers');
        challengeType = 'force-interactive';
        classConfidence = 0.75;
      }
    } catch {
      // evaluation failed
    }

    // Check for non-interactive (spinner/progress but no checkbox)
    try {
      const hasProgressOnly = await page.evaluate(() => {
        const hasRunning = !!document.querySelector('#challenge-running, #cf-chl-progress');
        const hasCheckbox = !!document.querySelector('.cf-turnstile [type="checkbox"], input[type="checkbox"]');
        return hasRunning && !hasCheckbox;
      });

      if (hasProgressOnly && challengeType === 'managed') {
        evidence.push('progress-spinner-no-checkbox');
        challengeType = 'non-interactive';
        classConfidence = 0.55;
      }
    } catch {
      // evaluation failed
    }

    // Check the Turnstile widget data attributes for mode hints
    try {
      const widgetMode = await page.evaluate(() => {
        const widget = document.querySelector('[data-sitekey]');
        if (widget) {
          return widget.getAttribute('data-mode') || 'managed';
        }
        return null;
      });

      if (widgetMode) {
        evidence.push(`widget-mode:${widgetMode}`);
        if (widgetMode === 'managed') {
          challengeType = 'managed';
          classConfidence = 0.8;
        } else if (widgetMode === 'non-interactive') {
          challengeType = 'non-interactive';
          classConfidence = 0.8;
        } else if (widgetMode === 'interactive') {
          challengeType = 'interactive';
          classConfidence = 0.8;
        }
      }
    } catch {
      // evaluation failed
    }

    logger.debug(
      { challengeType, classConfidence: classConfidence.toFixed(2), evidence },
      'Turnstile challenge classified'
    );

    return { challengeType, confidence: classConfidence, evidence };
  }

  /**
   * Recommend a bypass strategy based on challenge type and re-challenge status.
   */
  private recommendStrategy(
    challengeType: TurnstileChallengeType,
    isRechallenge: boolean
  ): BypassStrategy {
    if (isRechallenge) return 'profile-rotation';

    switch (challengeType) {
      case 'managed':
      case 'non-interactive':
        return 'browser-execute';
      case 'interactive':
      case 'force-interactive':
        return 'challenge-solver';
      default:
        return 'browser-execute';
    }
  }

  // --- Bypass -------------------------------------------------------------

  /**
   * Attempt to bypass the Cloudflare Turnstile challenge.
   *
   * Flow:
   *  1. Check for cached cf_clearance (fast path)
   *  2. Inject anti-detection script
   *  3. Classify challenge type
   *  4. Execute appropriate bypass strategy
   *  5. Extract and cache cf_clearance cookie
   *  6. If failed, escalate strategy
   */
  async bypass(ctx: BypassContext, strategy?: BypassStrategy): Promise<AntiBotResult> {
    const startTime = Date.now();
    const { page, context, domain } = ctx;
    this.stats.totalAttempts++;

    const detectionSignals: DetectionIndicator[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    // -- Fast path: check for cached cf_clearance ------------------------
    const cachedTokens = this.getValidTokens(domain);
    if (cachedTokens.length > 0 && strategy !== 'challenge-solver') {
      const cfClearance = cachedTokens.find(c => c.name === 'cf_clearance');
      if (cfClearance) {
        // Inject the cached cookie
        try {
          await context.addCookies([{
            name: cfClearance.name,
            value: cfClearance.value,
            domain: cfClearance.domain,
            path: cfClearance.path,
            httpOnly: cfClearance.httpOnly,
            secure: cfClearance.secure,
            sameSite: cfClearance.sameSite as 'Strict' | 'Lax' | 'None',
          }]);

          this.stats.tokenReuses++;
          logger.info({ domain }, 'Reused cached cf_clearance cookie');

          return this.buildSuccessResult({
            strategy: 'replay-tokens',
            durationMs: Date.now() - startTime,
            cookies: cachedTokens,
            detectionSignals,
            rechallengeExpected: true,
            rechallengeInMs: CF_CLEARANCE_LIFETIME_MS,
            warnings: ['Using cached cf_clearance -- may require re-challenge'],
            metadata: { source: 'cache', challengeType: 'cached' },
          });
        } catch (err: any) {
          warnings.push(`Cookie injection failed: ${err.message}`);
        }
      }
    }

    // -- Detect the challenge --------------------------------------------
    this.currentPhase = 'detecting';
    const detection = await this.detect(ctx);
    detectionSignals.push(...detection.indicators);

    if (detection.confidence < DETECTION_CONFIDENCE_THRESHOLD) {
      this.currentPhase = 'idle';
      return this.buildFailureResult({
        strategy: strategy || 'browser-execute',
        durationMs: Date.now() - startTime,
        phase: 'detecting',
        errors: ['Cloudflare challenge not detected with sufficient confidence'],
        detectionSignals,
        warnings,
        metadata: { confidence: detection.confidence },
      });
    }

    this.currentPhase = 'challenge-found';
    const challengeType = this.challengeTypeMemory.get(domain) || detection.challengeType as TurnstileChallengeType;

    // Initialize resolution state
    const resolutionState: TurnstileResolutionState = {
      detected: true,
      challengeType,
      phase: 'executing',
      attempts: 0,
      startedAt: startTime,
      completedAt: 0,
      errors: [],
    };
    this.activeResolutions.set(domain, resolutionState);

    logger.info(
      { domain, challengeType, isRechallenge: detection.isRechallenge, strategy: strategy || 'auto' },
      'Beginning Cloudflare Turnstile bypass'
    );

    // -- Inject anti-detection script ------------------------------------
    try {
      await page.evaluate(CF_ANTI_DETECTION_SCRIPT);
      logger.debug({ domain }, 'Cloudflare anti-detection script injected');
    } catch (err: any) {
      warnings.push(`Anti-detection injection failed: ${err.message}`);
    }

    // -- Execute bypass strategy -----------------------------------------
    const activeStrategy = strategy || detection.recommendedStrategy;
    let success = false;

    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      resolutionState.attempts = attempt + 1;
      this.currentPhase = 'executing';

      logger.info(
        { domain, challengeType, attempt: attempt + 1, maxAttempts: this.config.maxAttempts, strategy: activeStrategy },
        'Attempting Turnstile challenge bypass'
      );

      try {
        switch (activeStrategy) {
          case 'browser-execute':
            success = await this.executeManagedBypass(page, context, challengeType, domain);
            break;
          case 'challenge-solver':
            success = await this.executeInteractiveBypass(page, context, challengeType, domain);
            break;
          case 'replay-tokens':
            success = await this.executeReplayTokens(page, context, domain);
            break;
          case 'profile-rotation':
            success = await this.executeProfileRotation(page, context, domain);
            break;
          case 'maximum-stealth':
            success = await this.executeMaximumStealth(page, context, domain);
            break;
          default:
            success = await this.executeManagedBypass(page, context, challengeType, domain);
        }

        if (success) {
          break;
        }

        errors.push(`Attempt ${attempt + 1}: Challenge did not resolve with strategy ${activeStrategy}`);
      } catch (err: any) {
        errors.push(`Attempt ${attempt + 1}: ${err.message}`);
        logger.warn(
          { domain, attempt: attempt + 1, err: err.message },
          'Turnstile bypass attempt failed'
        );
      }

      // Small backoff between attempts
      if (attempt < this.config.maxAttempts - 1) {
        await this.sleep(1000 + Math.random() * 2000);
      }
    }

    // -- Extract cookies on success --------------------------------------
    this.currentPhase = 'extracting';
    const extractedCookies: ManagedCookie[] = [];

    if (success) {
      try {
        const cookies = await context.cookies();
        for (const cookie of cookies) {
          if (CF_COOKIE_NAMES.includes(cookie.name)) {
            const lifetime = cookie.name === 'cf_clearance'
              ? CF_CLEARANCE_LIFETIME_MS
              : CF_BM_LIFETIME_MS;
            extractedCookies.push(this.createManagedCookie({
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              httpOnly: cookie.httpOnly,
              secure: cookie.secure,
              sameSite: (cookie.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
            }, lifetime));

            // Track last seen cf_clearance
            if (cookie.name === 'cf_clearance') {
              this.lastCfClearanceValue.set(domain, cookie.value);
            }
          }
        }

        // Cache the cookies
        if (extractedCookies.length > 0) {
          await this.storeTokens(domain, extractedCookies);
        }
      } catch (err: any) {
        warnings.push(`Cookie extraction failed: ${err.message}`);
      }
    }

    // -- Build result ----------------------------------------------------
    const durationMs = Date.now() - startTime;
    resolutionState.completedAt = Date.now();

    if (success && extractedCookies.some(c => c.name === 'cf_clearance')) {
      this.currentPhase = 'complete';
      this.recordResult(domain, true, durationMs, activeStrategy);

      logger.info(
        { domain, challengeType, durationMs, cookieCount: extractedCookies.length, strategy: activeStrategy },
        'Cloudflare Turnstile bypass succeeded'
      );

      return this.buildSuccessResult({
        strategy: activeStrategy,
        durationMs,
        cookies: extractedCookies,
        detectionSignals,
        rechallengeExpected: true,
        rechallengeInMs: CF_CLEARANCE_LIFETIME_MS,
        warnings,
        metadata: {
          challengeType,
          attempts: resolutionState.attempts,
          cfRay: this.extractCfRay(detectionSignals),
        },
      });
    }

    // -- Failure -- try profile rotation if not already tried -------------
    this.currentPhase = 'failed';

    if (activeStrategy !== 'profile-rotation' && activeStrategy !== 'maximum-stealth') {
      this.currentPhase = 'escalating';
      const nextStrategy = this.escalateStrategy(domain);
      this.recordResult(domain, false, durationMs, activeStrategy);

      logger.info(
        { domain, fromStrategy: activeStrategy, toStrategy: nextStrategy },
        'Escalating Cloudflare bypass strategy after failure'
      );

      // Recurse with next strategy
      return this.bypass(ctx, nextStrategy);
    }

    this.recordResult(domain, false, durationMs, activeStrategy);

    logger.warn(
      { domain, challengeType, attempts: resolutionState.attempts, errors: errors.length },
      'Cloudflare Turnstile bypass failed after all attempts'
    );

    return this.buildFailureResult({
      strategy: activeStrategy,
      durationMs,
      phase: 'failed',
      errors,
      detectionSignals,
      warnings,
      metadata: {
        challengeType,
        attempts: resolutionState.attempts,
      },
    });
  }

  // --- Managed / Non-Interactive Bypass -----------------------------------

  /**
   * Wait for a managed or non-interactive challenge to auto-resolve.
   * These challenges don't require user interaction -- they complete
   * through JS execution and browser fingerprint validation.
   */
  private async executeManagedBypass(
    page: Page,
    context: BrowserContext,
    challengeType: TurnstileChallengeType,
    domain: string
  ): Promise<boolean> {
    const timeout = this.config.solveTimeoutMs || MANAGED_CHALLENGE_TIMEOUT_MS;

    logger.info({ domain, challengeType, timeout }, 'Waiting for managed challenge auto-resolution');

    // Wait a small initial delay for challenge JS to start executing
    await this.sleep(500 + Math.random() * 1000);

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // Check for cf_clearance cookie -- the primary success signal
        const cookies = await context.cookies();
        const hasClearance = cookies.some(c => c.name === 'cf_clearance');
        if (hasClearance) {
          logger.info(
            { domain, elapsedMs: Date.now() - startTime },
            'Managed challenge auto-resolved -- cf_clearance detected'
          );
          return true;
        }

        // Check if we navigated away from the challenge page
        const title = (await page.title()).toLowerCase();
        const isChallengePage = CF_TITLE_PATTERNS.some(p => title.includes(p));
        if (!isChallengePage) {
          // Verify we actually got clearance (not a redirect to another block page)
          const currentCookies = await context.cookies();
          if (currentCookies.some(c => c.name === 'cf_clearance')) {
            logger.info(
              { domain, elapsedMs: Date.now() - startTime, title },
              'Navigated away from challenge with clearance'
            );
            return true;
          }
        }

        // Check DOM for success indicators
        const challengeSucceeded = await page.evaluate(() => {
          const successEl = document.querySelector('#challenge-success');
          if (successEl) return true;

          // Check the injected state tracker
          const state = (window as any).__cf_challenge_state;
          if (state && state.challengePhase === 'success') return true;

          return false;
        });

        if (challengeSucceeded) {
          // Wait a bit more for cookies to be set
          await this.sleep(1000 + Math.random() * 500);
          const finalCookies = await context.cookies();
          return finalCookies.some(c => c.name === 'cf_clearance');
        }

        // Check for error indicators
        const challengeFailed = await page.evaluate(() => {
          const errorEl = document.querySelector('#challenge-error');
          if (errorEl) return true;
          const state = (window as any).__cf_challenge_state;
          if (state && state.challengePhase === 'error') return true;
          return false;
        });

        if (challengeFailed) {
          logger.warn({ domain }, 'Managed challenge reported error state');
          return false;
        }
      } catch (err: any) {
        // Page may have navigated -- check if it's because challenge resolved
        try {
          await page.evaluate(() => document.title);
        } catch {
          // Page is unresponsive -- likely navigated away
          try {
            const cookies = await context.cookies();
            if (cookies.some(c => c.name === 'cf_clearance')) {
              return true;
            }
          } catch {
            // Cannot access cookies either
          }
        }
      }

      await this.sleep(RESOLUTION_POLL_INTERVAL_MS);
    }

    logger.warn({ domain, timeout }, 'Managed challenge auto-resolution timed out');
    return false;
  }

  // --- Interactive Challenge Solver ---------------------------------------

  /**
   * Solve an interactive Turnstile challenge by locating and clicking the
   * checkbox widget. Uses human-like timing, mouse movement, and click
   * patterns to avoid detection.
   */
  private async executeInteractiveBypass(
    page: Page,
    context: BrowserContext,
    challengeType: TurnstileChallengeType,
    domain: string
  ): Promise<boolean> {
    const timeout = this.config.solveTimeoutMs || INTERACTIVE_CHALLENGE_TIMEOUT_MS;

    logger.info({ domain, challengeType, timeout }, 'Solving interactive Turnstile challenge');

    // Wait for the Turnstile widget to load
    const widgetReady = await this.waitForTurnstileWidget(page, CHALLENGE_PAGE_LOAD_TIMEOUT_MS);
    if (!widgetReady) {
      logger.warn({ domain }, 'Turnstile widget did not appear within load timeout');
      // Fall back to managed bypass -- it might be a non-interactive challenge misclassified
      return this.executeManagedBypass(page, context, 'non-interactive', domain);
    }

    // Find the Turnstile iframe
    const turnstileFrame = await this.findTurnstileIframe(page);
    if (!turnstileFrame) {
      logger.warn({ domain }, 'Could not locate Turnstile iframe');
      return false;
    }

    // Wait a human-like delay before interacting
    const preClickDelay = CHECKBOX_MIN_DELAY_MS + Math.random() * (CHECKBOX_MAX_DELAY_MS - CHECKBOX_MIN_DELAY_MS);
    logger.debug({ domain, delayMs: Math.round(preClickDelay) }, 'Pre-click human-like delay');
    await this.sleep(preClickDelay);

    // Find and click the checkbox
    const clicked = await this.clickTurnstileCheckbox(page, turnstileFrame, domain);
    if (!clicked) {
      logger.warn({ domain }, 'Failed to click Turnstile checkbox');
      return false;
    }

    // Wait for the challenge to resolve after the click
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        // Check for cf_clearance
        const cookies = await context.cookies();
        if (cookies.some(c => c.name === 'cf_clearance')) {
          logger.info(
            { domain, elapsedMs: Date.now() - startTime },
            'Interactive challenge resolved after checkbox click'
          );
          return true;
        }

        // Check DOM success
        const challengeDone = await page.evaluate(() => {
          const successEl = document.querySelector('#challenge-success');
          if (successEl) return true;
          const state = (window as any).__cf_challenge_state;
          if (state && state.challengePhase === 'success') return true;
          return false;
        });

        if (challengeDone) {
          await this.sleep(1000);
          const finalCookies = await context.cookies();
          return finalCookies.some(c => c.name === 'cf_clearance');
        }
      } catch {
        // Page may have navigated
        try {
          const cookies = await context.cookies();
          if (cookies.some(c => c.name === 'cf_clearance')) {
            return true;
          }
        } catch {
          // Cookie access failed
        }
      }

      await this.sleep(RESOLUTION_POLL_INTERVAL_MS);
    }

    logger.warn({ domain, timeout }, 'Interactive challenge timed out after checkbox click');
    return false;
  }

  /**
   * Wait for the Turnstile widget to appear in the DOM.
   */
  private async waitForTurnstileWidget(page: Page, timeout: number): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const widgetPresent = await page.evaluate(() => {
          // Check for Turnstile iframe
          const iframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
          if (iframes.length > 0) return true;

          // Check for embedded widget
          const widget = document.querySelector('.cf-turnstile, [data-sitekey], #turnstile-wrapper');
          if (widget) return true;

          // Check for challenge-running indicator
          const running = document.querySelector('#challenge-running');
          if (running) return true;

          return false;
        });

        if (widgetPresent) return true;
      } catch {
        // evaluation failed
      }

      await this.sleep(300);
    }

    return false;
  }

  /**
   * Locate the Turnstile challenge iframe.
   */
  private async findTurnstileIframe(page: Page): Promise<Frame | null> {
    try {
      const frames = page.frames();

      // Look for the Turnstile iframe by URL pattern
      for (const frame of frames) {
        const url = frame.url();
        if (url.includes('challenges.cloudflare.com') || url.includes('cdn-cgi/challenge-platform')) {
          logger.debug({ frameUrl: url.substring(0, 120) }, 'Found Turnstile iframe');
          return frame;
        }
      }

      // Try finding iframe element and accessing its content frame
      const iframeHandle = await page.$('iframe[src*="challenges.cloudflare.com"]');
      if (iframeHandle) {
        const contentFrame = await iframeHandle.contentFrame();
        if (contentFrame) {
          return contentFrame;
        }
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Turnstile iframe search failed');
    }

    return null;
  }

  /**
   * Click the Turnstile checkbox with human-like movement and timing.
   */
  private async clickTurnstileCheckbox(
    page: Page,
    turnstileFrame: Frame,
    domain: string
  ): Promise<boolean> {
    try {
      // Attempt to find the checkbox inside the Turnstile iframe
      const checkboxSelectors = [
        'input[type="checkbox"]',
        '.mark',            // Turnstile's checkmark container
        '#challenge-stage input',
        'label',
        '.checkbox',
        '[role="checkbox"]',
      ];

      let checkboxHandle: ElementHandle<HTMLElement | SVGElement | HTMLInputElement> | null = null;

      for (const selector of checkboxSelectors) {
        try {
          checkboxHandle = await turnstileFrame.$(selector) as ElementHandle<HTMLElement | SVGElement | HTMLInputElement> | null;
          if (checkboxHandle) {
            logger.debug({ selector, domain }, 'Found Turnstile checkbox element');
            break;
          }
        } catch {
          // selector not found in frame
        }
      }

      if (checkboxHandle) {
        // Get checkbox bounding box for human-like mouse movement
        const box = await checkboxHandle.boundingBox();
        if (box) {
          // Move mouse to checkbox with human-like curve
          const startX = Math.random() * (box.width || 50);
          const startY = Math.random() * (box.height || 50);
          const targetX = box.x + (box.width || 50) / 2 + (Math.random() - 0.5) * 10;
          const targetY = box.y + (box.height || 50) / 2 + (Math.random() - 0.5) * 10;

          // Move in steps with slight randomness
          const steps = 5 + Math.floor(Math.random() * 8);
          for (let i = 1; i <= steps; i++) {
            const progress = i / steps;
            // Apply slight bezier-like curve
            const eased = progress * progress * (3 - 2 * progress);
            const currentX = startX + (targetX - startX) * eased + (Math.random() - 0.5) * 3;
            const currentY = startY + (targetY - startY) * eased + (Math.random() - 0.5) * 3;
            await page.mouse.move(currentX, currentY);
            await this.sleep(15 + Math.random() * 35);
          }

          // Small pause before clicking (human hesitation)
          await this.sleep(50 + Math.random() * 150);

          // Click with random button hold duration
          await page.mouse.click(targetX, targetY, {
            delay: 30 + Math.random() * 80,
          });

          logger.info({ domain, x: Math.round(targetX), y: Math.round(targetY) }, 'Clicked Turnstile checkbox');
          return true;
        }

        // Fallback: click the element directly if no bounding box
        await checkboxHandle.click({ delay: 50 + Math.random() * 100 });
        logger.info({ domain }, 'Clicked Turnstile checkbox (fallback direct click)');
        return true;
      }

      // If no checkbox found inside iframe, try clicking the widget container on the main page
      logger.debug({ domain }, 'No checkbox found in iframe -- trying widget container click');

      const widgetSelectors = [
        '.cf-turnstile',
        '[data-sitekey]',
        '#turnstile-wrapper',
      ];

      for (const selector of widgetSelectors) {
        try {
          const widgetHandle = await page.$(selector);
          if (widgetHandle) {
            const box = await widgetHandle.boundingBox();
            if (box) {
              const targetX = box.x + (box.width || 50) / 2;
              const targetY = box.y + (box.height || 50) / 2;
              await page.mouse.click(targetX, targetY, {
                delay: 40 + Math.random() * 80,
              });
              logger.info({ domain, selector }, 'Clicked Turnstile widget container');
              return true;
            }
          }
        } catch {
          // widget click failed
        }
      }

      logger.warn({ domain }, 'Could not find any clickable Turnstile element');
      return false;
    } catch (err: any) {
      logger.error({ err: err.message, domain }, 'Turnstile checkbox click failed');
      return false;
    }
  }

  // --- Token Replay -------------------------------------------------------

  /**
   * Inject previously cached cookies into the browser context.
   */
  private async executeReplayTokens(
    page: Page,
    context: BrowserContext,
    domain: string
  ): Promise<boolean> {
    const tokens = this.getValidTokens(domain);
    if (tokens.length === 0) {
      logger.warn({ domain }, 'No valid tokens to replay');
      return false;
    }

    try {
      const cookiesToAdd = tokens.map(token => ({
        name: token.name,
        value: token.value,
        domain: token.domain,
        path: token.path,
        httpOnly: token.httpOnly,
        secure: token.secure,
        sameSite: token.sameSite as 'Strict' | 'Lax' | 'None',
      }));

      await context.addCookies(cookiesToAdd);

      // Reload the page to apply the cookies
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });

      // Wait briefly and check if we're past the challenge
      await this.sleep(2000);

      const title = (await page.title()).toLowerCase();
      const stillChallenged = CF_TITLE_PATTERNS.some(p => title.includes(p));

      if (!stillChallenged) {
        logger.info({ domain, cookieCount: cookiesToAdd.length }, 'Token replay succeeded');
        return true;
      }

      logger.warn({ domain }, 'Token replay failed -- still on challenge page');
      this.invalidateTokens(domain);
      return false;
    } catch (err: any) {
      logger.error({ err: err.message, domain }, 'Token replay failed');
      return false;
    }
  }

  // --- Profile Rotation ---------------------------------------------------

  /**
   * Rotate browser fingerprint profile and retry the challenge.
   * This is used as a fallback when the current profile gets blocked.
   */
  private async executeProfileRotation(
    page: Page,
    context: BrowserContext,
    domain: string
  ): Promise<boolean> {
    logger.info({ domain }, 'Executing profile rotation for Cloudflare bypass');

    try {
      // Inject fresh anti-detection with randomized parameters
      await page.evaluate(CF_ANTI_DETECTION_SCRIPT);

      // Randomize viewport slightly to change fingerprint
      const currentViewport = page.viewportSize();
      if (currentViewport) {
        const widthShift = Math.floor((Math.random() - 0.5) * 100);
        const heightShift = Math.floor((Math.random() - 0.5) * 60);
        await page.setViewportSize({
          width: Math.max(1024, currentViewport.width + widthShift),
          height: Math.max(600, currentViewport.height + heightShift),
        });
      }

      // Clear existing Cloudflare cookies to force a fresh challenge
      const cookies = await context.cookies();
      const cfCookies = cookies.filter(c => CF_COOKIE_NAMES.includes(c.name));
      if (cfCookies.length > 0) {
        await context.clearCookies();
        // Re-add non-CF cookies
        const nonCfCookies = cookies.filter(c => !CF_COOKIE_NAMES.includes(c.name));
        if (nonCfCookies.length > 0) {
          await context.addCookies(nonCfCookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: (c.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
          })));
        }
      }

      // Reload the page with the new profile
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });

      // Wait for the challenge to appear
      await this.sleep(2000 + Math.random() * 2000);

      // Try managed bypass first with the fresh profile
      const challengeType = this.challengeTypeMemory.get(domain) || 'managed';
      return this.executeManagedBypass(page, context, challengeType, domain);
    } catch (err: any) {
      logger.error({ err: err.message, domain }, 'Profile rotation failed');
      return false;
    }
  }

  // --- Maximum Stealth ----------------------------------------------------

  /**
   * Apply all available stealth measures and retry the challenge.
   * This is the last-resort strategy before giving up.
   */
  private async executeMaximumStealth(
    page: Page,
    context: BrowserContext,
    domain: string
  ): Promise<boolean> {
    logger.info({ domain }, 'Applying maximum stealth for Cloudflare bypass');

    try {
      // Inject comprehensive anti-detection
      await page.evaluate(CF_ANTI_DETECTION_SCRIPT);

      // Override additional browser APIs that CF checks
      await page.evaluate(() => {
        // Override getBoundingClientRect to add subtle randomness
        const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function() {
          const rect = originalGetBoundingClientRect.call(this);
          // Add sub-pixel noise that won't affect layout but changes fingerprint
          const noise = () => (Math.random() - 0.5) * 0.01;
          return new DOMRect(
            rect.x + noise(),
            rect.y + noise(),
            rect.width + noise(),
            rect.height + noise()
          );
        };

        // Consistent timezone
        try {
          Intl.DateTimeFormat.prototype.resolvedOptions = function() {
            const opts = Object.getPrototypeOf(this).resolvedOptions.call(this);
            opts.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
            return opts;
          };
        } catch(e) {}

        // Prevent detection via toString on native functions
        const nativeToString = Function.prototype.toString;
        const overriddenFns = new Map();

        function patchToString(fn: Function, name: string) {
          overriddenFns.set(fn, `function ${name}() { [native code] }`);
        }

        const origDefineProperty = Object.defineProperty;
        origDefineProperty(Function.prototype, 'toString', {
          value: function() {
            if (overriddenFns.has(this)) return overriddenFns.get(this);
            return nativeToString.call(this);
          },
          configurable: true,
        });

        // Mark our patches as native
        patchToString(Element.prototype.getBoundingClientRect, 'getBoundingClientRect');
      });

      // Clear all cookies and storage for a completely fresh start
      await context.clearCookies();
      try {
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
      } catch {
        // storage clear failed (may be blocked)
      }

      // Reload
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await this.sleep(3000 + Math.random() * 2000);

      // Re-inject anti-detection after reload
      await page.evaluate(CF_ANTI_DETECTION_SCRIPT);

      // Try solving as managed first, then interactive
      const challengeType = this.challengeTypeMemory.get(domain) || 'managed';
      let success = await this.executeManagedBypass(page, context, challengeType, domain);

      if (!success) {
        // Try interactive as a last resort
        success = await this.executeInteractiveBypass(page, context, 'interactive', domain);
      }

      return success;
    } catch (err: any) {
      logger.error({ err: err.message, domain }, 'Maximum stealth bypass failed');
      return false;
    }
  }

  // --- Challenge Page Waiting ---------------------------------------------

  /**
   * Wait for a Cloudflare challenge page to fully load and be ready
   * for interaction or auto-resolution.
   */
  async waitForChallengePage(page: Page, timeout: number = CHALLENGE_PAGE_LOAD_TIMEOUT_MS): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const readyState = await page.evaluate(() => {
          // Check if document is ready
          if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
            return 'loading';
          }

          // Check for challenge DOM elements
          const hasChallengeEl = !!(
            document.querySelector('#challenge-running') ||
            document.querySelector('#challenge-stage') ||
            document.querySelector('.cf-turnstile') ||
            document.querySelector('iframe[src*="challenges.cloudflare.com"]')
          );

          if (hasChallengeEl) return 'ready';
          return 'no-challenge';
        });

        if (readyState === 'ready') return true;
        if (readyState === 'no-challenge') {
          // Might have already resolved
          const title = (await page.title()).toLowerCase();
          if (!CF_TITLE_PATTERNS.some(p => title.includes(p))) {
            return true; // Not on challenge page
          }
        }
      } catch {
        // evaluation failed -- may have navigated
      }

      await this.sleep(300);
    }

    return false;
  }

  // --- cf_clearance Cookie Extraction -------------------------------------

  /**
   * Extract the cf_clearance cookie and related Cloudflare cookies from
   * the browser context, returning them as ManagedCookie instances.
   */
  async extractClearanceCookies(
    context: BrowserContext,
    domain: string
  ): Promise<ManagedCookie[]> {
    const results: ManagedCookie[] = [];

    try {
      const cookies = await context.cookies();
      for (const cookie of cookies) {
        if (CF_COOKIE_NAMES.includes(cookie.name)) {
          const lifetime = cookie.name === 'cf_clearance'
            ? CF_CLEARANCE_LIFETIME_MS
            : CF_BM_LIFETIME_MS;
          results.push(this.createManagedCookie({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: (cookie.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
          }, lifetime));
        }
      }

      if (results.length > 0) {
        await this.storeTokens(domain, results);
        logger.info({ domain, cookieCount: results.length }, 'Cloudflare cookies extracted and cached');
      }
    } catch (err: any) {
      logger.error({ err: err.message, domain }, 'Cloudflare cookie extraction failed');
    }

    return results;
  }

  // --- Helpers ------------------------------------------------------------

  /**
   * Get response headers via CDP Network layer.
   */
  private async getResponseHeadersViaCDP(cdpSession: CDPSession): Promise<Record<string, string>> {
    try {
      const { headers } = await cdpSession.send('Network.getAllCookies') as any;
      // Fallback: try getting the response from the main resource
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Extract the cf-ray value from detection signals.
   */
  private extractCfRay(signals: DetectionIndicator[]): string | undefined {
    for (const signal of signals) {
      if (signal.rawValue?.startsWith('cf-ray:')) {
        return signal.rawValue.split(':')[1]?.trim();
      }
    }
    return undefined;
  }

  /**
   * Get the current challenge type for a domain.
   */
  getChallengeType(domain: string): TurnstileChallengeType {
    return this.challengeTypeMemory.get(domain) || 'unknown';
  }

  /**
   * Get the active resolution state for a domain.
   */
  getResolutionState(domain: string): TurnstileResolutionState | null {
    return this.activeResolutions.get(domain) || null;
  }

  /**
   * Check if a domain has a valid cached cf_clearance.
   */
  hasCfClearance(domain: string): boolean {
    const tokens = this.getValidTokens(domain);
    return tokens.some(t => t.name === 'cf_clearance');
  }

  /**
   * Get module-specific statistics in addition to the base stats.
   */
  getStats(): Record<string, unknown> {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      challengeTypeMemory: Object.fromEntries(this.challengeTypeMemory),
      activeResolutions: this.activeResolutions.size,
      domainsWithClearance: Array.from(this.tokenCache.keys()),
    };
  }
}

// ===============================================================================
// SINGLETON EXPORT
// ===============================================================================

export const cloudflareTurnstileSolver = new CloudflareTurnstileSolver();
export default CloudflareTurnstileSolver;
