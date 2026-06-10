/**
 * X-Bogus CDN Extractor -- ScrapeSuite Engine
 *
 * Extracts the real X-Bogus algorithm from TikTok's CDN JavaScript and executes
 * it in a controlled browser context to generate authentic signatures.
 *
 * Architecture:
 *  1. Fetch TikTok's main page HTML
 *  2. Extract script URLs containing the X-Bogus algorithm
 *  3. Download and cache the algorithm JS
 *  4. Execute the algorithm in a sandboxed Playwright context
 *  5. Return the generated X-Bogus signature
 *
 * This replaces the custom murmur-hash approach with the REAL TikTok algorithm,
 * ensuring signatures pass server-side validation.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import { db } from '../../utils/db';
import { xbogusSigner } from './xbogus-signer';
import type { XBogusParams, XBogusResult, TikTokDeviceType } from './types';

const logger = createChildLogger('xbogus-cdn-extractor');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Patterns that identify X-Bogus algorithm code inside a JS bundle */
const XBOGUS_SIGNATURE_PATTERNS: RegExp[] = [
  /X-Bogus/i,
  /Dkdpgh4ZKsQB80\/Mfvw36XI1R25-WtUVEGayPuHJOjcLNqiz9mCeTFS/,
  /DFSzswVO/,
  /function\s*\w*\s*\([^)]*\)\s*\{[^}]*xor/i,
  /\b0x5BD1E995\b/,
];

/** Known TikTok CDN hostname prefixes for algorithm bundles */
const TIKTOK_CDN_HOSTS = [
  'sf16-ies-middleware.bytetos.com',
  'sf16-shortev.bytetos.com',
  'sf16-muse-va.bytetos.com',
  'p16-sign-sg.tiktokcdn.com',
  'sf19-ies-middleware.bytetos.com',
];

/** Version prefix patterns used to detect the algorithm version */
const VERSION_PATTERNS: RegExp[] = [
  /DFSzswVO/,
  /DFSzswV[0-9]/,
  /"[A-Za-z0-9]{8}"/,
];

/** Default User-Agent for extraction browser context */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Signature validity window (5 minutes, matching TikTok server-side check) */
const SIGNATURE_VALIDITY_MS = 5 * 60 * 1000;

// ===============================================================================
// INTERFACE: Cached Algorithm Entry
// ===============================================================================

interface CachedAlgorithm {
  /** The raw JavaScript containing the X-Bogus algorithm */
  js: string;
  /** Timestamp when this was extracted from CDN */
  extractedAt: number;
  /** Detected algorithm version string (e.g. "DFSzswVO") */
  version: string;
}

// ===============================================================================
// X-BOGUS CDN EXTRACTOR
// ===============================================================================

export class XBogusCDNExtractor {
  // --- In-memory algorithm cache keyed by version ----------------------------
  private algorithmCache = new Map<string, CachedAlgorithm>();

  // --- Lifecycle state -------------------------------------------------------
  private initialized = false;
  private browserPage: Page | null = null;
  private browser: Browser | null = null;

  // --- Cache durations -------------------------------------------------------
  /** Algorithm cache duration: 2 hours (TikTok updates frequently) */
  private static ALGORITHM_CACHE_MS = 2 * 60 * 60 * 1000;
  /** Redis cache key for persisted algorithm JS */
  private static ALGORITHM_REDIS_KEY = 'tiktok:xbogus:algorithm';

  // --- Operational stats -----------------------------------------------------
  private stats = {
    extractionAttempts: 0,
    extractionSuccesses: 0,
    extractionFailures: 0,
    cacheHits: 0,
    cacheMisses: 0,
    fallbackUsed: 0,
    algorithmVersion: 'unknown',
    lastExtractionAt: 0 as number,
    lastExtractionDurationMs: 0 as number,
    sandboxExecutions: 0,
    sandboxFailures: 0,
    totalSignaturesGenerated: 0,
  };

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Initialize the extractor -- launch a headless Chromium instance and prepare
   * the sandbox page used for algorithm execution.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.debug('XBogusCDNExtractor already initialized -- skipping');
      return;
    }

    try {
      logger.info('Initializing XBogusCDNExtractor -- launching headless browser');

      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-gpu',
        ],
      });

      this.initialized = true;
      logger.info('XBogusCDNExtractor initialized successfully');

      // Attempt an initial algorithm extraction in the background
      this.refreshAlgorithm().catch((err) => {
        logger.warn({ error: (err as Error).message }, 'Initial algorithm extraction failed -- will retry on demand');
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'Failed to initialize XBogusCDNExtractor browser');
      throw err;
    }
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Extract the real X-Bogus algorithm from TikTok's CDN (if not cached) and
   * execute it in a sandboxed Playwright context to sign the given parameters.
   *
   * Falls back to the custom murmur-hash {@link XBogusSignerEngine} when CDN
   * extraction is unavailable or fails.
   */
  async extractAndExecute(params: XBogusParams): Promise<XBogusResult> {
    const startTime = performance.now();
    this.stats.totalSignaturesGenerated++;

    try {
      // Ensure browser is initialized
      if (!this.initialized || !this.browser) {
        await this.initialize();
      }

      // Step 1: Get the algorithm JS (from cache or CDN)
      const algorithm = await this.getAlgorithm();
      if (!algorithm) {
        logger.warn('No algorithm available from CDN -- falling back to murmur signer');
        this.stats.fallbackUsed++;
        return xbogusSigner.generate(params);
      }

      // Step 2: Execute in sandbox
      const xBogus = await this.executeInSandbox(algorithm.js, params);

      const generationTimeMs = performance.now() - startTime;

      return {
        xBogus,
        version: algorithm.version,
        generationTimeMs,
        isValid: true,
        expiresAt: Date.now() + SIGNATURE_VALIDITY_MS,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'CDN extraction + execution failed -- falling back to murmur signer');
      this.stats.fallbackUsed++;
      return xbogusSigner.generate(params);
    }
  }

  /**
   * Force a fresh extraction of the X-Bogus algorithm from TikTok's CDN.
   * Invalidates all caches (in-memory and Redis).
   */
  async refreshAlgorithm(): Promise<void> {
    this.stats.extractionAttempts++;
    const extractStart = performance.now();

    try {
      logger.info('Refreshing X-Bogus algorithm from TikTok CDN');

      // Step 1: Discover script URLs from TikTok's main page
      const scriptUrls = await this.fetchAlgorithmScripts();
      if (scriptUrls.length === 0) {
        throw new Error('No algorithm script URLs discovered from TikTok page');
      }

      logger.info({ scriptCount: scriptUrls.length }, 'Discovered candidate script URLs');

      // Step 2: Download and identify the algorithm JS
      const algorithmJS = await this.downloadAlgorithmJS(scriptUrls);
      if (!algorithmJS) {
        throw new Error('Downloaded scripts did not contain X-Bogus algorithm');
      }

      // Step 3: Detect version
      const version = await this.detectAlgorithmVersion(algorithmJS);

      // Step 4: Cache in-memory
      const cached: CachedAlgorithm = {
        js: algorithmJS,
        extractedAt: Date.now(),
        version,
      };
      this.algorithmCache.set(version, cached);
      this.stats.algorithmVersion = version;
      this.stats.lastExtractionAt = Date.now();
      this.stats.lastExtractionDurationMs = performance.now() - extractStart;
      this.stats.extractionSuccesses++;

      // Step 5: Persist to Redis with 2-hour TTL
      try {
        await cacheSet(
          XBogusCDNExtractor.ALGORITHM_REDIS_KEY,
          { js: algorithmJS, version, extractedAt: cached.extractedAt },
          Math.floor(XBogusCDNExtractor.ALGORITHM_CACHE_MS / 1000),
        );
      } catch (redisErr: unknown) {
        logger.debug({ error: (redisErr as Error).message }, 'Redis cache write failed -- continuing with in-memory cache only');
      }

      logger.info(
        { version, jsSize: algorithmJS.length, durationMs: this.stats.lastExtractionDurationMs.toFixed(0) },
        'X-Bogus algorithm extracted and cached',
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.extractionFailures++;
      logger.error({ error: message }, 'Failed to refresh X-Bogus algorithm from CDN');
    }
  }

  /**
   * Return operational statistics for monitoring / diagnostics.
   */
  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      initialized: this.initialized,
      algorithmCacheSize: this.algorithmCache.size,
      algorithmCacheEntries: Array.from(this.algorithmCache.entries()).map(([version, entry]) => ({
        version,
        jsSize: entry.js.length,
        ageMs: Date.now() - entry.extractedAt,
      })),
    };
  }

  // ===========================================================================
  // ALGORITHM DISCOVERY
  // ===========================================================================

  /**
   * Navigate to TikTok's main page in a Playwright context, intercept loaded
   * script resources, and return URLs for scripts that may contain the X-Bogus
   * signing algorithm.
   *
   * Strategy:
   *  - Create an incognito browser context with realistic headers
   *  - Intercept network responses for JS content-type
   *  - Filter URLs against known CDN hostname patterns
   *  - Also parse the initial HTML for `<script src="...">` tags
   */
  private async fetchAlgorithmScripts(): Promise<string[]> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const collectedUrls = new Set<string>();
    let context: BrowserContext | null = null;

    try {
      context = await this.browser.newContext({
        userAgent: DEFAULT_UA,
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-CH-UA-Mobile': '?0',
          'Sec-CH-UA-Platform': '"Windows"',
        },
      });

      // Mask Playwright automation signals
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        const w = globalThis as Record<string, unknown>;
        delete w.__playwright;
        delete w.__pw_manual;
        delete w.__PW_inspect;
      });

      const page = await context.newPage();

      // Intercept JS responses and collect their URLs
      page.on('response', (response) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        if (
          contentType.includes('javascript') ||
          url.endsWith('.js') ||
          url.includes('.js?') ||
          TIKTOK_CDN_HOSTS.some((host) => url.includes(host))
        ) {
          collectedUrls.add(url);
        }
      });

      // Navigate to TikTok main page (tolerate non-200; we still collect scripts)
      try {
        await page.goto('https://www.tiktok.com', {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      } catch (navErr: unknown) {
        logger.debug({ error: (navErr as Error).message }, 'TikTok page navigation issue -- collected scripts anyway');
      }

      // Wait a moment for lazy-loaded scripts
      await page.waitForTimeout(3000);

      // Also parse the initial HTML for <script src> tags as a fallback
      const htmlScriptUrls = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        return scripts.map((s) => s.getAttribute('src') || '');
      });

      for (const url of htmlScriptUrls) {
        if (url) collectedUrls.add(url);
      }

      await page.close();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'Error while fetching algorithm script URLs from TikTok');
    } finally {
      if (context) {
        try { await context.close(); } catch {}
      }
    }

    return Array.from(collectedUrls);
  }

  // ===========================================================================
  // ALGORITHM DOWNLOAD
  // ===========================================================================

  /**
   * Download each candidate script, inspect its content for X-Bogus algorithm
   * signatures, and return the concatenated matching JS.
   *
   * Checks the Redis cache first before downloading.
   */
  private async downloadAlgorithmJS(scriptUrls: string[]): Promise<string | null> {
    // Check Redis cache first
    try {
      const cached = await cacheGet<{ js: string; version: string; extractedAt: number }>(
        XBogusCDNExtractor.ALGORITHM_REDIS_KEY,
      );
      if (cached && cached.js && Date.now() - cached.extractedAt < XBogusCDNExtractor.ALGORITHM_CACHE_MS) {
        this.stats.cacheHits++;
        logger.info({ version: cached.version }, 'Algorithm cache hit (Redis)');
        const version = await this.detectAlgorithmVersion(cached.js);
        this.algorithmCache.set(version, {
          js: cached.js,
          extractedAt: cached.extractedAt,
          version,
        });
        return cached.js;
      }
    } catch (err: unknown) {
      logger.debug({ error: (err as Error).message }, 'Redis cache read failed -- proceeding to download');
    }

    // Check in-memory cache
    for (const [version, entry] of this.algorithmCache.entries()) {
      if (Date.now() - entry.extractedAt < XBogusCDNExtractor.ALGORITHM_CACHE_MS) {
        this.stats.cacheHits++;
        logger.info({ version }, 'Algorithm cache hit (memory)');
        return entry.js;
      }
    }

    this.stats.cacheMisses++;

    // Download and scan each candidate script
    const algorithmChunks: string[] = [];

    for (const url of scriptUrls) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': DEFAULT_UA,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://www.tiktok.com/',
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) continue;

        const js = await response.text();

        // Test if this script contains X-Bogus algorithm indicators
        if (this.containsAlgorithm(js)) {
          algorithmChunks.push(js);
          logger.debug({ url: url.substring(0, 120), size: js.length }, 'Identified X-Bogus algorithm script');
        }
      } catch (err: unknown) {
        logger.debug({ url: url.substring(0, 120), error: (err as Error).message }, 'Failed to download candidate script');
      }
    }

    if (algorithmChunks.length === 0) {
      logger.warn({ urlCount: scriptUrls.length }, 'No algorithm scripts found among candidates');
      return null;
    }

    return algorithmChunks.join('\n;//---SEPARATOR---;\n');
  }

  /**
   * Check whether a JS string contains patterns consistent with the X-Bogus
   * signing algorithm.
   */
  private containsAlgorithm(js: string): boolean {
    // Must match at least two distinct patterns to reduce false positives
    let matchCount = 0;
    for (const pattern of XBOGUS_SIGNATURE_PATTERNS) {
      if (pattern.test(js)) {
        matchCount++;
        if (matchCount >= 2) return true;
      }
    }
    return false;
  }

  // ===========================================================================
  // SANDBOX EXECUTION
  // ===========================================================================

  /**
   * Execute the extracted X-Bogus algorithm inside a fresh Playwright
   * incognito context and return the generated signature.
   *
   * Security model:
   *  - A brand-new incognito context is created per call
   *  - Realistic TikTok headers and cookies (ttwid, msToken) are set
   *  - The algorithm JS is injected via page.addScriptTag
   *  - The signing function is invoked via page.evaluate()
   *  - The context is destroyed after extracting the result
   */
  private async executeInSandbox(algorithmJS: string, params: XBogusParams): Promise<string> {
    if (!this.browser) {
      throw new Error('Browser not initialized -- cannot execute in sandbox');
    }

    this.stats.sandboxExecutions++;
    let context: BrowserContext | null = null;

    try {
      // Step 1: Create incognito context with realistic TikTok headers
      context = await this.browser.newContext({
        userAgent: params.userAgent || DEFAULT_UA,
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-CH-UA-Mobile': '?0',
          'Sec-CH-UA-Platform': '"Windows"',
        },
      });

      // Set realistic TikTok cookies
      await context.addCookies([
        {
          name: 'ttwid',
          value: this.generateTTWid(),
          domain: '.tiktok.com',
          path: '/',
        },
        {
          name: 'msToken',
          value: this.generateMsToken(),
          domain: '.tiktok.com',
          path: '/',
        },
        {
          name: 'odin_tt',
          value: this.generateOdinTT(),
          domain: '.tiktok.com',
          path: '/',
        },
      ]);

      // Mask automation indicators
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        const w = globalThis as Record<string, unknown>;
        delete w.__playwright;
        delete w.__pw_manual;
        delete w.__PW_inspect;
      });

      const page = await context.newPage();

      // Step 2: Navigate to a blank TikTok-origin page so the algorithm JS
      // runs in the correct origin context
      await page.goto('about:blank');

      // Step 3: Inject the algorithm JavaScript
      await page.addScriptTag({ content: algorithmJS });

      // Step 4: Attempt to call the X-Bogus signing function
      // TikTok's algorithm is typically exposed via a global function or
      // accessible through their module system. We try multiple known entry points.
      const xBogus = await page.evaluate(
        ({ url, queryString, userAgent, timestamp, body }) => {
          // Attempt 1: Direct global function (byted_acrawler.sign)
          try {
            const byted = (window as Record<string, any>).byted_acrawler;
            if (byted && typeof byted.sign === 'function') {
              const result = byted.sign({
                url: url + queryString,
                userAgent,
                timestamp,
                body: body || '',
              });
              if (typeof result === 'string' && result.length > 10) return result;
              if (result && typeof result.x_bogus === 'string') return result.x_bogus;
              if (result && typeof result['X-Bogus'] === 'string') return result['X-Bogus'];
            }
          } catch {}

          // Attempt 2: window._bytedParam via module system
          try {
            const param = (window as Record<string, any>)._bytedParam;
            if (param && typeof param.sign === 'function') {
              return param.sign(url + queryString, userAgent, timestamp, body || '');
            }
          } catch {}

          // Attempt 3: _webmssdk_env or similar entry
          try {
            const env = (window as Record<string, any>)._webmssdk_env;
            if (env && typeof env.sign === 'function') {
              return env.sign(url + queryString, body || '', userAgent);
            }
          } catch {}

          // Attempt 4: Search for the signing function in global scope
          const globalKeys = Object.keys(window);
          for (const key of globalKeys) {
            try {
              const val = (window as Record<string, any>)[key];
              if (val && typeof val === 'object' && typeof val.sign === 'function') {
                const result = val.sign({ url: url + queryString, userAgent, timestamp, body: body || '' });
                if (typeof result === 'string' && result.length > 10) return result;
                if (result && typeof result.x_bogus === 'string') return result.x_bogus;
                if (result && typeof result['X-Bogus'] === 'string') return result['X-Bogus'];
              }
            } catch {}
          }

          return null;
        },
        {
          url: params.url,
          queryString: params.queryString,
          userAgent: params.userAgent,
          timestamp: params.timestamp,
          body: params.body || '',
        },
      );

      await page.close();

      if (typeof xBogus === 'string' && xBogus.length > 10) {
        return xBogus;
      }

      throw new Error('Sandbox execution did not produce a valid X-Bogus signature');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.sandboxFailures++;
      logger.error({ error: message }, 'Sandbox execution failed');
      throw err;
    } finally {
      if (context) {
        try { await context.close(); } catch {}
      }
    }
  }

  // ===========================================================================
  // ALGORITHM VERSION DETECTION
  // ===========================================================================

  /**
   * Detect the X-Bogus algorithm version from the extracted JavaScript.
   * Looks for version prefixes like "DFSzswVO" and other identifiers.
   */
  private async detectAlgorithmVersion(js: string): Promise<string> {
    for (const pattern of VERSION_PATTERNS) {
      const match = js.match(pattern);
      if (match) {
        return match[0].replace(/"/g, '');
      }
    }

    // Fallback: hash the first 512 bytes to create a stable version id
    const sample = js.substring(0, 512);
    let hash = 0;
    for (let i = 0; i < sample.length; i++) {
      const chr = sample.charCodeAt(i);
      hash = ((hash << 5) - hash + chr) | 0;
    }
    return `custom-${Math.abs(hash).toString(16).slice(0, 8)}`;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Retrieve the algorithm JS from in-memory cache, Redis, or by performing
   * a fresh CDN extraction.
   */
  private async getAlgorithm(): Promise<CachedAlgorithm | null> {
    // Check in-memory cache (any version, as long as it's not expired)
    for (const [version, entry] of this.algorithmCache.entries()) {
      if (Date.now() - entry.extractedAt < XBogusCDNExtractor.ALGORITHM_CACHE_MS) {
        this.stats.cacheHits++;
        return entry;
      }
    }

    // Check Redis cache
    try {
      const cached = await cacheGet<{ js: string; version: string; extractedAt: number }>(
        XBogusCDNExtractor.ALGORITHM_REDIS_KEY,
      );
      if (cached && cached.js && Date.now() - cached.extractedAt < XBogusCDNExtractor.ALGORITHM_CACHE_MS) {
        this.stats.cacheHits++;
        this.algorithmCache.set(cached.version, {
          js: cached.js,
          extractedAt: cached.extractedAt,
          version: cached.version,
        });
        return this.algorithmCache.get(cached.version) ?? null;
      }
    } catch (err: unknown) {
      logger.debug({ error: (err as Error).message }, 'Redis cache read failed');
    }

    // Fresh extraction required
    this.stats.cacheMisses++;
    await this.refreshAlgorithm();

    // Return from in-memory cache after extraction
    for (const [, entry] of this.algorithmCache.entries()) {
      if (Date.now() - entry.extractedAt < XBogusCDNExtractor.ALGORITHM_CACHE_MS) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Generate a plausible ttwid cookie value.
   */
  private generateTTWid(): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 15);
    return `${ts}_${rand}`;
  }

  /**
   * Generate a plausible msToken cookie value (base64-like).
   */
  private generateMsToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    const length = 107 + Math.floor(Math.random() * 21);
    let token = '';
    for (let i = 0; i < length; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }

  /**
   * Generate a plausible odin_tt cookie value.
   */
  private generateOdinTT(): string {
    const ts = Math.floor(Date.now() / 1000);
    const rand = Math.random().toString(36).substring(2, 10);
    return `${ts}${rand}`;
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const xbogusCDNExtractor = new XBogusCDNExtractor();
