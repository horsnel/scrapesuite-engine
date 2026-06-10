/**
 * Unified Browser Rendering Pipeline -- ScrapeSuite Engine
 *
 * Provides a single cohesive API for browser-based scraping:
 *  Navigate → Detect Anti-Bot → Solve Challenge → Extract Data
 *
 * This pipeline is what the engine was missing: a unified entry point
 * that ties together the browser pool, anti-bot detection, CAPTCHA solving,
 * stealth browsing, and data extraction into a single operation.
 *
 * Architecture:
 *  +--------------------------------------------------------------------------+
 *  |                     Rendering Pipeline Orchestrator                       |
 *  |                                                                         |
 *  |  Step 1: Acquire Browser   ← BrowserPool / StealthBrowserEngine         |
 *  |  Step 2: Navigate to URL   ← Playwright Page.goto()                     |
 *  |  Step 3: Detect Anti-Bot   ← AntiBotManager.detectAll()                 |
 *  |  Step 4: Solve Challenge   ← AntiBotManager.handlePage() + CAPTCHA      |
 *  |  Step 5: Wait for Content  ← Smart wait (networkidle / domcontentloaded)|
 *  |  Step 6: Extract Data      ← CSS/XPath selectors + JavaScript eval      |
 *  |  Step 7: Clean Up          ← Release browser lease, cache results        |
 *  +--------------------------------------------------------------------------+
 *
 * Key features:
 *  - Automatic stealth mode selection based on URL analysis
 *  - Smart wait strategy: adapts based on page behavior
 *  - Anti-bot challenge auto-solving with escalation
 *  - CAPTCHA detection and solving integration
 *  - Extraction via CSS selectors, XPath, or custom JavaScript
 *  - Result caching to avoid re-scraping
 *  - Comprehensive error handling with retry logic
 */

import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { db } from '../utils/db';
import { browserPool, type BrowserLease } from '../browser-pool/index';
import { antiBotManager } from '../anti-bot/manager';
import { stealthEngine } from '../anti-bot/stealth';
import { captchaSolver } from '../captcha/index';
import { stealthBrowserEngine } from '../anti-bot/stealth-browser';

const logger = createChildLogger('rendering-pipeline');

// ===============================================================================
// TYPES
// ===============================================================================

export interface RenderRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;

  // Extraction config
  extract?: {
    selectors?: Record<string, string>;    // name -> CSS selector
    xpaths?: Record<string, string>;       // name -> XPath expression
    javascript?: string;                    // JS to evaluate, should return JSON
    waitForSelector?: string;              // Wait for this selector before extracting
    waitForTimeout?: number;               // Fixed wait in ms
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  };

  // Pipeline config
  stealthMode?: 'none' | 'basic' | 'stealth' | 'maximum';
  useBotBrowser?: boolean;
  proxyUrl?: string;
  timeout?: number;
  maxRetries?: number;
  solveCaptcha?: boolean;
  cacheResults?: boolean;
  cacheTTL?: number;  // seconds
}

export interface RenderResult {
  success: boolean;
  url: string;
  finalUrl: string;        // After any redirects
  statusCode: number;
  headers: Record<string, string>;
  html: string;
  text: string;
  extracted: Record<string, any>;
  antiBotDetected: string[];  // Names of detected anti-bot platforms
  captchaSolved: boolean;
  captchaType?: string;
  renderTimeMs: number;
  retries: number;
  errors: string[];
}

/** Unified internal handle for browser resources regardless of acquisition mode. */
interface BrowserHandle {
  page: Page;
  context: BrowserContext;
  mode: string;
  cleanup: () => Promise<void>;
}

// ===============================================================================
// STEALTH MODE ESCALATION ORDER
// ===============================================================================

const STEALTH_ESCALATION: Record<string, 'none' | 'basic' | 'stealth' | 'maximum'> = {
  none: 'basic',
  basic: 'stealth',
  stealth: 'maximum',
  maximum: 'maximum',
};

// ===============================================================================
// URL PATTERN → STEALTH MODE MAPPING
// ===============================================================================

interface StealthRule {
  pattern: RegExp;
  mode: 'none' | 'basic' | 'stealth' | 'maximum';
}

const STEALTH_RULES: StealthRule[] = [
  // Maximum stealth: aggressive anti-bot platforms
  { pattern: /tiktok\.com/i, mode: 'maximum' },
  { pattern: /instagram\.com/i, mode: 'maximum' },
  { pattern: /facebook\.com/i, mode: 'maximum' },
  { pattern: /linkedin\.com/i, mode: 'maximum' },
  { pattern: /nike\.com/i, mode: 'maximum' },
  { pattern: /adidas\.com/i, mode: 'maximum' },
  { pattern: /ticketmaster\.com/i, mode: 'maximum' },

  // Stealth: Cloudflare-protected sites with JS challenges
  { pattern: /stripe\.com/i, mode: 'stealth' },
  { pattern: /airbnb\.com/i, mode: 'stealth' },
  { pattern: /zillow\.com/i, mode: 'stealth' },
  { pattern: /glassdoor\.com/i, mode: 'stealth' },
  { pattern: /crunchbase\.com/i, mode: 'stealth' },

  // Basic: sites with mild bot detection
  { pattern: /reddit\.com/i, mode: 'basic' },
  { pattern: /youtube\.com/i, mode: 'basic' },
  { pattern: /twitter\.com/i, mode: 'basic' },
  { pattern: /x\.com/i, mode: 'basic' },
  { pattern: /amazon\./i, mode: 'basic' },
  { pattern: /wikipedia\.org/i, mode: 'basic' },
];

// ===============================================================================
// CAPTCHA DETECTION PATTERNS
// ===============================================================================

interface CaptchaSignature {
  type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile';
  pattern: RegExp;
  siteKeyExtractor: RegExp;
}

const CAPTCHA_SIGNATURES: CaptchaSignature[] = [
  {
    type: 'recaptcha_v2',
    pattern: /g-recaptcha|recaptcha.*api\.google|data-sitekey/i,
    siteKeyExtractor: /data-sitekey=["']([a-zA-Z0-9_-]+)["']/i,
  },
  {
    type: 'recaptcha_v3',
    pattern: /grecaptcha.*execute|recaptcha.*enterprise/i,
    siteKeyExtractor: /data-sitekey=["']([a-zA-Z0-9_-]+)["']/i,
  },
  {
    type: 'hcaptcha',
    pattern: /h-captcha|hcaptcha\.com/i,
    siteKeyExtractor: /data-sitekey=["']([a-zA-Z0-9_-]+)["']/i,
  },
  {
    type: 'turnstile',
    pattern: /cf-turnstile|challenges\.cloudflare\.com\/turnstile/i,
    siteKeyExtractor: /data-sitekey=["']([a-zA-Z0-9_-]+)["']/i,
  },
];

// ===============================================================================
// RENDERING PIPELINE
// ===============================================================================

export class RenderingPipeline {
  private initialized = false;

  private stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    antiBotDetections: 0,
    captchasSolved: 0,
    avgRenderTimeMs: 0,
    byStealthMode: {} as Record<string, { attempts: number; successes: number }>,
  };

  // --- Initialization --------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Rendering Pipeline');

    // Ensure dependencies are initialized
    try {
      await browserPool.initialize();
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Browser pool init failed -- will launch on demand');
    }

    try {
      await antiBotManager.initialize();
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Anti-bot manager init failed -- detection unavailable');
    }

    try {
      await stealthBrowserEngine.initialize();
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Stealth browser engine init failed -- BotBrowser unavailable');
    }

    this.initialized = true;
    logger.info('Rendering Pipeline initialized');
  }

  // --- Main Entry Point ------------------------------------------------------

  /**
   * Render a URL and extract data. This is the primary API.
   *
   * Flow: Acquire Browser → Navigate → Detect Anti-Bot → Solve Challenges →
   *       Wait for Content → Extract Data → Clean Up
   */
  async render(request: RenderRequest): Promise<RenderResult> {
    if (!this.initialized) await this.initialize();

    const startTime = Date.now();
    const maxRetries = request.maxRetries ?? 1;
    const timeout = request.timeout ?? 30_000;
    let stealthMode = this.selectStealthMode(request.url, request.stealthMode);

    this.stats.totalRequests++;
    this.ensureStealthModeStats(stealthMode);
    this.stats.byStealthMode[stealthMode].attempts++;

    const errors: string[] = [];
    let retries = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        retries = attempt;
        logger.info(
          { url: request.url, attempt, stealthMode },
          'Retrying render with escalated stealth',
        );
      }

      let handle: BrowserHandle | null = null;

      try {
        // Step 0: Check cache
        if (request.cacheResults !== false) {
          const cached = await this.getCachedResult(request);
          if (cached) {
            logger.info({ url: request.url }, 'Cache hit for render request');
            return cached;
          }
        }

        // Step 1: Acquire browser
        handle = await this.acquireBrowser({ ...request, stealthMode });

        // Step 2: Navigate to URL
        const navResult = await this.navigateToUrl(handle.page, request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          timeout,
          waitUntil: request.extract?.waitUntil,
        });

        // Step 3 & 4: Detect and solve anti-bot challenges
        const challengeResult = await this.detectAndSolveChallenges(
          handle.page,
          handle.context,
          request.url,
          { ...request, stealthMode },
        );

        if (challengeResult.platforms.length > 0) {
          this.stats.antiBotDetections++;
        }

        if (challengeResult.captchaSolved) {
          this.stats.captchasSolved++;
        }

        // If anti-bot bypass failed, escalate stealth and retry
        if (challengeResult.platforms.length > 0 && !challengeResult.captchaSolved) {
          const html = await handle.page.content();
          const detection = stealthEngine.detectAntiBot(html, navResult.statusCode);
          if (detection.confidenceScore > 0.7) {
            const escalated = STEALTH_ESCALATION[stealthMode];
            if (escalated !== stealthMode) {
              stealthMode = escalated;
              logger.info(
                { url: request.url, newStealthMode: stealthMode },
                'Anti-bot bypass failed, escalating stealth mode for retry',
              );
              await handle.cleanup();
              handle = null;
              continue;
            }
          }
        }

        // Step 5: Wait for content
        await this.waitForContent(handle.page, request);

        // Step 6: Extract data
        const extracted = await this.extractData(handle.page, request);

        // Collect final page state
        const finalUrl = handle.page.url();
        const html = await handle.page.content();
        const text = await handle.page.evaluate(() => document.body?.innerText || '');

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        try {
          // Try to get headers from the main frame's response
          const resp = await handle.page.evaluate(() => {
            const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
            return entries.length > 0 ? entries[0] : null;
          });
          // Performance entries don't have response headers, so we use what we have
          void resp;
        } catch {}
        // Use navigation result headers if available
        if (navResult.headers) {
          Object.assign(responseHeaders, navResult.headers);
        }

        const renderTimeMs = Date.now() - startTime;

        const result: RenderResult = {
          success: true,
          url: request.url,
          finalUrl,
          statusCode: navResult.statusCode,
          headers: responseHeaders,
          html,
          text,
          extracted,
          antiBotDetected: challengeResult.platforms,
          captchaSolved: challengeResult.captchaSolved,
          captchaType: challengeResult.captchaType,
          renderTimeMs,
          retries,
          errors: [],
        };

        // Update stats
        this.stats.successfulRequests++;
        this.stats.byStealthMode[stealthMode].successes++;
        this.updateAvgRenderTime(renderTimeMs);

        // Cache result
        if (request.cacheResults !== false) {
          await this.cacheResult(request, result);
        }

        // Log to database
        await this.logRender(request, result);

        return result;
      } catch (err: any) {
        const errorMsg = err.message || String(err);
        errors.push(`Attempt ${attempt + 1}: ${errorMsg}`);
        logger.warn(
          { url: request.url, attempt: attempt + 1, error: errorMsg },
          'Render attempt failed',
        );

        // On navigation timeout, escalate stealth and retry with longer timeout
        if (errorMsg.includes('Timeout') || errorMsg.includes('timeout')) {
          stealthMode = STEALTH_ESCALATION[stealthMode];
          logger.info(
            { url: request.url, newStealthMode: stealthMode },
            'Navigation timeout, escalating stealth for retry',
          );
        }
      } finally {
        if (handle) {
          await handle.cleanup();
        }
      }
    }

    // All attempts exhausted
    this.stats.failedRequests++;
    this.stats.byStealthMode[stealthMode].attempts++;

    const renderTimeMs = Date.now() - startTime;

    return {
      success: false,
      url: request.url,
      finalUrl: request.url,
      statusCode: 0,
      headers: {},
      html: '',
      text: '',
      extracted: {},
      antiBotDetected: [],
      captchaSolved: false,
      renderTimeMs,
      retries,
      errors,
    };
  }

  // --- Batch Rendering -------------------------------------------------------

  /**
   * Render multiple URLs in parallel with concurrency control.
   * Default concurrency: 3.
   */
  async renderBatch(
    requests: RenderRequest[],
    concurrency: number = 3,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<RenderResult[]> {
    const results: RenderResult[] = new Array(requests.length);
    let completed = 0;

    // Simple semaphore for concurrency control
    let running = 0;
    let index = 0;
    const waitQueue: Array<{ resolve: () => void }> = [];

    const acquireSlot = (): Promise<void> => {
      if (running < concurrency) {
        running++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waitQueue.push({ resolve });
      });
    };

    const releaseSlot = (): void => {
      running--;
      if (waitQueue.length > 0) {
        running++;
        const next = waitQueue.shift()!;
        next.resolve();
      }
    };

    const tasks = requests.map(async (request, i) => {
      await acquireSlot();
      try {
        results[i] = await this.render(request);
      } catch (err: any) {
        results[i] = {
          success: false,
          url: request.url,
          finalUrl: request.url,
          statusCode: 0,
          headers: {},
          html: '',
          text: '',
          extracted: {},
          antiBotDetected: [],
          captchaSolved: false,
          renderTimeMs: 0,
          retries: 0,
          errors: [err.message || String(err)],
        };
      } finally {
        completed++;
        releaseSlot();
        if (onProgress) {
          onProgress(completed, requests.length);
        }
      }
    });

    await Promise.allSettled(tasks);
    return results;
  }

  // --- Private Pipeline Steps ------------------------------------------------

  /**
   * Step 1: Acquire a browser based on the requested stealth mode.
   *
   * - maximum → stealthBrowserEngine.launchStealthBrowser() (BotBrowser binary)
   * - stealth → browserPool.acquire(proxyUrl, true) with stealth init scripts
   * - basic   → browserPool.acquire(proxyUrl, false) with minimal patches
   * - none    → browserPool.acquire() raw, no patches
   */
  private async acquireBrowser(request: RenderRequest & { stealthMode: string }): Promise<BrowserHandle> {
    const mode = request.stealthMode as 'none' | 'basic' | 'stealth' | 'maximum';

    if (mode === 'maximum') {
      logger.info({ url: request.url }, 'Acquiring maximum-stealth browser (BotBrowser)');

      const result = await stealthBrowserEngine.launchStealthBrowser({
        useBotBrowser: request.useBotBrowser ?? true,
        fallbackToNodriver: true,
        proxyServer: request.proxyUrl,
        headless: true,
        disableGpu: true,
      });

      const page = result.context.pages()[0] || await result.context.newPage();

      return {
        page,
        context: result.context,
        mode: `maximum:${result.mode}`,
        cleanup: async () => {
          try {
            await page.close({ runBeforeUnload: false }).catch(() => {});
          } catch {}
          try {
            await result.context.close().catch(() => {});
          } catch {}
          try {
            await result.browser.close().catch(() => {});
          } catch {}
        },
      };
    }

    if (mode === 'stealth') {
      logger.info({ url: request.url }, 'Acquiring stealth browser from pool');

      const lease = await browserPool.acquire(request.proxyUrl, true);

      return {
        page: lease.page,
        context: lease.context,
        mode: 'stealth',
        cleanup: async () => {
          try {
            await browserPool.release(lease);
          } catch (err: any) {
            logger.warn({ error: err.message }, 'Failed to release browser lease');
          }
        },
      };
    }

    if (mode === 'basic') {
      logger.info({ url: request.url }, 'Acquiring basic-stealth browser from pool');

      const lease = await browserPool.acquire(request.proxyUrl, false);

      return {
        page: lease.page,
        context: lease.context,
        mode: 'basic',
        cleanup: async () => {
          try {
            await browserPool.release(lease);
          } catch (err: any) {
            logger.warn({ error: err.message }, 'Failed to release browser lease');
          }
        },
      };
    }

    // mode === 'none'
    logger.info({ url: request.url }, 'Acquiring raw browser from pool');

    const lease = await browserPool.acquire(request.proxyUrl, false);

    return {
      page: lease.page,
      context: lease.context,
      mode: 'none',
      cleanup: async () => {
        try {
          await browserPool.release(lease);
        } catch (err: any) {
          logger.warn({ error: err.message }, 'Failed to release browser lease');
        }
      },
    };
  }

  /**
   * Step 2: Navigate to the target URL.
   * Returns the status code and final URL after any redirects.
   */
  private async navigateToUrl(
    page: Page,
    url: string,
    options: {
      method?: 'GET' | 'POST';
      headers?: Record<string, string>;
      body?: string;
      timeout: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    },
  ): Promise<{ statusCode: number; finalUrl: string; headers: Record<string, string> }> {
    const waitUntil = options.waitUntil || 'domcontentloaded';

    logger.info({ url, waitUntil, timeout: options.timeout }, 'Navigating to URL');

    // Set extra headers if provided
    if (options.headers) {
      await page.setExtraHTTPHeaders(options.headers);
    }

    let response: Response | null = null;

    try {
      response = await page.goto(url, {
        timeout: options.timeout,
        waitUntil,
      });
    } catch (navErr: any) {
      // If networkidle times out, fall back to domcontentloaded
      if (
        waitUntil === 'networkidle' &&
        (navErr.message?.includes('Timeout') || navErr.message?.includes('timeout'))
      ) {
        logger.info({ url }, 'networkidle timeout, falling back to domcontentloaded');
        response = await page.goto(url, {
          timeout: options.timeout,
          waitUntil: 'domcontentloaded',
        });
      } else {
        throw navErr;
      }
    }

    const statusCode = response?.status() ?? 0;
    const finalUrl = page.url();

    // Extract response headers
    const headers: Record<string, string> = {};
    if (response) {
      try {
        const rawHeaders = response.headers();
        for (const [key, value] of Object.entries(rawHeaders)) {
          headers[key] = value;
        }
      } catch {}
    }

    logger.info({ url, finalUrl, statusCode }, 'Navigation complete');

    return { statusCode, finalUrl, headers };
  }

  /**
   * Steps 3 & 4: Detect anti-bot protections and solve challenges.
   *
   * - Runs quick detection for anti-bot platforms
   * - If detected, delegates to antiBotManager.handlePage()
   * - Checks for CAPTCHAs in the page HTML
   * - If CAPTCHA found and solveCaptcha is enabled, uses captchaSolver
   */
  private async detectAndSolveChallenges(
    page: Page,
    context: BrowserContext,
    url: string,
    request: RenderRequest & { stealthMode: string },
  ): Promise<{ platforms: string[]; captchaSolved: boolean; captchaType?: string }> {
    const platforms: string[] = [];
    let captchaSolved = false;
    let captchaType: string | undefined;

    // Step 3: Quick anti-bot detection
    try {
      const detection = await antiBotManager.quickDetect(url, page, context);

      if (detection) {
        platforms.push(detection.platform);
        logger.info(
          { url, platform: detection.platform, confidence: detection.confidence.toFixed(2) },
          'Anti-bot platform detected',
        );

        // Step 3b: Attempt to bypass using the manager
        try {
          const bypassResult = await antiBotManager.handlePage(url, page, context);

          if (bypassResult.success) {
            logger.info(
              { url, platform: detection.platform, strategy: bypassResult.strategy },
              'Anti-bot bypass successful',
            );
          } else {
            logger.warn(
              { url, platform: detection.platform, errors: bypassResult.errors },
              'Anti-bot bypass failed',
            );
          }
        } catch (bypassErr: any) {
          logger.warn(
            { url, error: bypassErr.message },
            'Anti-bot bypass threw an error',
          );
        }
      }
    } catch (detectErr: any) {
      logger.debug({ url, error: detectErr.message }, 'Anti-bot quick detection failed');
    }

    // Step 4: Check for CAPTCHAs
    try {
      const html = await page.content();
      const captchaInfo = this.detectCaptcha(html);

      if (captchaInfo) {
        captchaType = captchaInfo.type;
        logger.info({ url, captchaType: captchaInfo.type }, 'CAPTCHA detected on page');

        if (request.solveCaptcha !== false && captchaSolver.isConfigured) {
          try {
            // Extract the site key from the page
            const siteKey = await this.extractCaptchaSiteKey(page, captchaInfo);

            if (siteKey) {
              const solveResult = await captchaSolver.solve({
                url,
                siteKey,
                type: captchaInfo.type,
                proxyUrl: request.proxyUrl,
              });

              if (solveResult.success) {
                captchaSolved = true;
                logger.info(
                  { url, captchaType: captchaInfo.type, solveTimeMs: solveResult.solveTimeMs },
                  'CAPTCHA solved successfully',
                );

                // Inject the CAPTCHA token into the page
                await this.injectCaptchaToken(page, captchaInfo.type, solveResult.token);

                // Wait a moment for the page to process the token
                await page.waitForTimeout(1000);
              }
            } else {
              logger.warn({ url, captchaType: captchaInfo.type }, 'Could not extract CAPTCHA site key');
            }
          } catch (solveErr: any) {
            logger.warn(
              { url, captchaType: captchaInfo.type, error: solveErr.message },
              'CAPTCHA solving failed',
            );
          }
        } else {
          logger.info(
            { url, captchaType: captchaInfo.type, solveEnabled: request.solveCaptcha !== false },
            'CAPTCHA detected but solving disabled or no provider configured',
          );
        }
      }
    } catch (captchaErr: any) {
      logger.debug({ url, error: captchaErr.message }, 'CAPTCHA detection check failed');
    }

    return { platforms, captchaSolved, captchaType };
  }

  /**
   * Step 5: Wait for content to load based on the extraction config.
   *
   * Priority:
   *  1. waitForSelector -- wait for a specific element
   *  2. waitForTimeout -- fixed delay
   *  3. waitUntil -- Playwright navigation wait strategy
   *  4. Default: networkidle with 10s timeout, fallback to domcontentloaded
   */
  private async waitForContent(page: Page, request: RenderRequest): Promise<void> {
    const extract = request.extract;
    const timeout = request.timeout ?? 30_000;

    // 1. Wait for specific selector
    if (extract?.waitForSelector) {
      try {
        await page.waitForSelector(extract.waitForSelector, { timeout });
        logger.info({ selector: extract.waitForSelector }, 'Wait for selector satisfied');
        return;
      } catch (err: any) {
        logger.warn(
          { selector: extract.waitForSelector, error: err.message },
          'Wait for selector timed out, continuing anyway',
        );
        return;
      }
    }

    // 2. Fixed timeout wait
    if (extract?.waitForTimeout) {
      await page.waitForTimeout(extract.waitForTimeout);
      logger.info({ ms: extract.waitForTimeout }, 'Fixed wait complete');
      return;
    }

    // 3. Playwright waitUntil strategy was already applied during navigation
    //    If it was specified, content is already ready.
    if (extract?.waitUntil) {
      logger.info({ waitUntil: extract.waitUntil }, 'Content wait satisfied by navigation waitUntil');
      return;
    }

    // 4. Default smart wait: try networkidle, fall back to domcontentloaded
    try {
      await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 10_000) });
      logger.info('Smart wait: networkidle satisfied');
    } catch {
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
        logger.info('Smart wait: fell back to domcontentloaded');
      } catch {
        logger.warn('Smart wait: both networkidle and domcontentloaded timed out, proceeding');
      }
    }
  }

  /**
   * Step 6: Extract data from the page using CSS selectors, XPath, or JavaScript.
   * Returns a merged result object with all extracted values.
   */
  private async extractData(page: Page, request: RenderRequest): Promise<Record<string, any>> {
    const extract = request.extract;
    if (!extract) return {};

    const result: Record<string, any> = {};

    // CSS selectors
    if (extract.selectors) {
      for (const [name, selector] of Object.entries(extract.selectors)) {
        try {
          result[name] = await this.extractBySelector(page, selector);
        } catch (err: any) {
          result[name] = { error: err.message, selector };
          logger.debug({ name, selector, error: err.message }, 'CSS selector extraction failed');
        }
      }
    }

    // XPath expressions
    if (extract.xpaths) {
      for (const [name, xpath] of Object.entries(extract.xpaths)) {
        try {
          result[name] = await this.extractByXPath(page, xpath);
        } catch (err: any) {
          result[name] = { error: err.message, xpath };
          logger.debug({ name, xpath, error: err.message }, 'XPath extraction failed');
        }
      }
    }

    // Custom JavaScript
    if (extract.javascript) {
      try {
        result._javascript = await this.extractByJavaScript(page, extract.javascript);
      } catch (err: any) {
        result._javascript = { error: err.message };
        logger.debug({ error: err.message }, 'JavaScript extraction failed');
      }
    }

    return result;
  }

  /**
   * Extract text content using a CSS selector.
   * Returns a string for single matches or string[] for multiple matches.
   */
  private async extractBySelector(page: Page, selector: string): Promise<string | string[]> {
    const elements = await page.$$eval(selector, (els) =>
      els.map((el) => el.textContent?.trim() || ''),
    );

    if (elements.length === 0) return '';
    if (elements.length === 1) return elements[0];
    return elements;
  }

  /**
   * Extract text content using an XPath expression.
   */
  private async extractByXPath(page: Page, xpath: string): Promise<string | string[]> {
    const locator = page.locator(`xpath=${xpath}`);
    const count = await locator.count();

    if (count === 0) return '';

    const texts = await locator.allTextContents();
    const trimmed = texts.map((t) => t.trim()).filter(Boolean);

    if (trimmed.length === 0) return '';
    if (trimmed.length === 1) return trimmed[0];
    return trimmed;
  }

  /**
   * Extract data by evaluating custom JavaScript in the page context.
   */
  private async extractByJavaScript(page: Page, js: string): Promise<any> {
    const result = await page.evaluate(js);
    return result;
  }

  /**
   * Auto-select stealth mode based on URL patterns.
   * Can be overridden by the request's stealthMode field.
   */
  private selectStealthMode(
    url: string,
    requestedMode?: string,
  ): 'none' | 'basic' | 'stealth' | 'maximum' {
    if (requestedMode) return requestedMode as 'none' | 'basic' | 'stealth' | 'maximum';

    for (const rule of STEALTH_RULES) {
      if (rule.pattern.test(url)) {
        return rule.mode;
      }
    }

    // Default: basic stealth for unknown sites
    return 'basic';
  }

  // --- Caching ---------------------------------------------------------------

  private async cacheResult(request: RenderRequest, result: RenderResult): Promise<void> {
    try {
      const key = this.buildCacheKey(request);
      const ttl = request.cacheTTL ?? 300; // 5 minutes default
      await cacheSet(key, result, ttl);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Failed to cache render result');
    }
  }

  private async getCachedResult(request: RenderRequest): Promise<RenderResult | null> {
    try {
      const key = this.buildCacheKey(request);
      return await cacheGet<RenderResult>(key);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Failed to get cached render result');
      return null;
    }
  }

  private buildCacheKey(request: RenderRequest): string {
    const extractKey = request.extract
      ? JSON.stringify(request.extract)
      : 'none';
    return `render:${request.url}:${extractKey}`;
  }

  // --- CAPTCHA Helpers -------------------------------------------------------

  /**
   * Detect if the page HTML contains a CAPTCHA.
   */
  private detectCaptcha(
    html: string,
  ): { type: CaptchaSignature['type']; signature: CaptchaSignature } | null {
    for (const sig of CAPTCHA_SIGNATURES) {
      if (sig.pattern.test(html)) {
        return { type: sig.type, signature: sig };
      }
    }
    return null;
  }

  /**
   * Extract the CAPTCHA site key from the page.
   */
  private async extractCaptchaSiteKey(
    page: Page,
    captchaInfo: { type: CaptchaSignature['type']; signature: CaptchaSignature },
  ): Promise<string | null> {
    try {
      const html = await page.content();
      const match = html.match(captchaInfo.signature.siteKeyExtractor);
      if (match?.[1]) return match[1];
    } catch {}

    // Fallback: try to find it via JavaScript evaluation
    try {
      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        return el?.getAttribute('data-sitekey') || null;
      });
      if (siteKey) return siteKey;
    } catch {}

    return null;
  }

  /**
   * Inject a solved CAPTCHA token into the page.
   */
  private async injectCaptchaToken(
    page: Page,
    type: CaptchaSignature['type'],
    token: string,
  ): Promise<void> {
    try {
      switch (type) {
        case 'recaptcha_v2':
        case 'recaptcha_v3':
          // Set the reCAPTCHA response textarea and trigger the callback
          await page.evaluate((tkn) => {
            const textarea = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement;
            if (textarea) textarea.value = tkn;

            // Try to trigger the callback
            if (typeof (window as any).___grecaptcha_cfg !== 'undefined') {
              const cfg = (window as any).___grecaptcha_cfg;
              const clients = cfg.clients || {};
              for (const client of Object.values(clients) as any[]) {
                if (client?.callback) {
                  if (typeof client.callback === 'string') {
                    (window as any)[client.callback](tkn);
                  } else if (typeof client.callback === 'function') {
                    client.callback(tkn);
                  }
                }
              }
            }
          }, token);
          break;

        case 'hcaptcha':
          await page.evaluate((tkn) => {
            const textarea = document.querySelector('[name="h-captcha-response"]') as HTMLTextAreaElement;
            if (textarea) textarea.value = tkn;

            if (typeof (window as any).hcaptcha !== 'undefined') {
              (window as any).hcaptcha.setResponse(tkn);
            }
          }, token);
          break;

        case 'turnstile':
          await page.evaluate((tkn) => {
            const inputs = document.querySelectorAll('input[name="cf-turnstile-response"]');
            inputs.forEach((input) => {
              (input as HTMLInputElement).value = tkn;
            });

            // Try to trigger callback
            if (typeof (window as any).turnstile !== 'undefined') {
              (window as any).turnstile.getResponse = () => tkn;
            }
          }, token);
          break;
      }
    } catch (err: any) {
      logger.debug({ type, error: err.message }, 'CAPTCHA token injection failed');
    }
  }

  // --- Statistics Helpers -----------------------------------------------------

  private ensureStealthModeStats(mode: string): void {
    if (!this.stats.byStealthMode[mode]) {
      this.stats.byStealthMode[mode] = { attempts: 0, successes: 0 };
    }
  }

  private updateAvgRenderTime(renderTimeMs: number): void {
    const total = this.stats.successfulRequests;
    this.stats.avgRenderTimeMs =
      total > 1
        ? Math.round((this.stats.avgRenderTimeMs * (total - 1) + renderTimeMs) / total)
        : renderTimeMs;
  }

  private async logRender(request: RenderRequest, result: RenderResult): Promise<void> {
    try {
      // Log to database via AuditLog for analytics (non-blocking, ignore errors)
      await db.auditLog.create({
        data: {
          id: crypto.randomUUID(),
          action: result.success ? 'render_success' : 'render_failure',
          resource: 'rendering_pipeline',
          category: 'scraping',
          severity: result.success ? 'info' : 'warn',
          url: request.url,
          domain: new URL(request.url).hostname,
          details: {
            finalUrl: result.finalUrl,
            statusCode: result.statusCode,
            stealthMode: request.stealthMode || 'auto',
            antiBotDetected: result.antiBotDetected,
            captchaSolved: result.captchaSolved,
            captchaType: result.captchaType || null,
            renderTimeMs: result.renderTimeMs,
            retries: result.retries,
            extractedKeys: Object.keys(result.extracted),
          },
        },
      });
    } catch (err: any) {
      // Table might not exist yet; log at debug level only
      logger.debug({ error: err.message }, 'Failed to log render to database');
    }
  }

  // --- Public Stats -----------------------------------------------------------

  getStats(): Record<string, unknown> {
    return {
      totalRequests: this.stats.totalRequests,
      successfulRequests: this.stats.successfulRequests,
      failedRequests: this.stats.failedRequests,
      antiBotDetections: this.stats.antiBotDetections,
      captchasSolved: this.stats.captchasSolved,
      avgRenderTimeMs: this.stats.avgRenderTimeMs,
      successRate:
        this.stats.totalRequests > 0
          ? this.stats.successfulRequests / this.stats.totalRequests
          : 0,
      byStealthMode: { ...this.stats.byStealthMode },
    };
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const renderingPipeline = new RenderingPipeline();
export default RenderingPipeline;
