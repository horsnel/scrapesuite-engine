/**
 * TikTok Browser Harvester — ScrapeSuite Engine
 *
 * Harvests a REAL TikTok browser session using headless Chromium (Playwright):
 *   - session cookies (ttwid, msToken, odin_tt, tt-target-idc, ...)
 *   - the browser's exact User-Agent (X-Bogus is UA-bound, so every signed
 *     request made with the session MUST reuse this UA)
 *   - the `__UNIVERSAL_DATA_FOR_REHYDRATION__` payload (user / video data
 *     embedded in profile pages)
 *   - msToken values observed on live /api/ requests made by the page
 *
 * Why this exists (live findings, 2026-09): TikTok's data planes are gated
 * behind browser credibility. From a flagged IP, the API serves the web-app
 * HTML shell and profile HTML is a byte-identical bot wall. A real browser
 * session passes that credibility layer wherever the IP itself is accepted;
 * on flagged datacenter IPs, route the browser through a residential proxy
 * (playwright proxy option) — the harvested session then works for the
 * engine's signed requests from ANY IP for the session's lifetime.
 *
 * Usage:
 *   const harvester = new TikTokBrowserHarvester();
 *   const session = await harvester.harvestSession({
 *     targetUrl: 'https://www.tiktok.com/@username',
 *     proxyUrl: 'http://user:pass@residential-gw:8080', // optional
 *   });
 *   tiktokManager.importBrowserSession(session);
 *   const { headers, cookies } = await tiktokManager.prepareSession();
 */

import { createChildLogger } from '../../utils/logger';
import type { Browser, BrowserContext, Page } from 'playwright';

const logger = createChildLogger('tiktok-browser-harvester');

// ===============================================================================
// TYPES
// ===============================================================================

export interface TikTokBrowserSession {
  /** Cookie name → value harvested from the browser context */
  cookies: Record<string, string>;
  /** Exact UA of the harvesting browser — required for X-Bogus consistency */
  userAgent: string;
  /** Page the session was harvested on */
  pageUrl: string;
  /** Epoch ms of the harvest */
  harvestedAt: number;
  /** Extraction engine */
  source: 'playwright';
  /** __UNIVERSAL_DATA_FOR_REHYDRATION__ payload when present */
  universalData?: Record<string, unknown>;
  /** SIGI_STATE payload fallback when present */
  sigiState?: Record<string, unknown>;
  /** msToken values observed on live /api/ requests by the page */
  observedMsTokens: string[];
  /** URLs of API calls the page itself made (up to a small cap) */
  observedApiUrls: string[];
}

export interface HarvestOptions {
  /** Page to load for harvesting (default https://www.tiktok.com/) */
  targetUrl?: string;
  /** Chromium/Chrome executable override (skips playwright's registry lookup) */
  executablePath?: string;
  /** Proxy for the BROWSER session (http://user:pass@host:port) */
  proxyUrl?: string;
  /** Headless mode (default true) */
  headless?: boolean;
  /** How long to observe page network traffic for /api/ calls (default 8000ms) */
  networkCaptureMs?: number;
  /** Navigation timeout (default 45000ms) */
  timeoutMs?: number;
  /** Custom UA (default: playwright's bundled browser UA) */
  userAgent?: string;
  /** Viewport (default 1920x1080) */
  viewport?: { width: number; height: number };
}

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Cookies worth keeping — everything else is noise but harmless to keep */
const VALUABLE_COOKIE_PATTERNS = [
  'ttwid', 'msToken', 'odin_tt', 'tt-target-idc', 'sid_tt', 'sid_guard',
  'sessionid', 'ui_area', 'store-idc', 'store-country-code', 'tt-encrypt-token',
  'csrf_session_id', 'TikTok_page_view_time', 'tt_scid',
];

/** Stealth init script — patch the cheapest browser-automation tells */
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
`;

// ===============================================================================
// HARVESTER
// ===============================================================================

export class TikTokBrowserHarvester {
  /**
   * Harvest a real TikTok browser session.
   *
   * @returns Session payload ready for `TikTokManager.importBrowserSession()`
   */
  async harvestSession(options?: HarvestOptions): Promise<TikTokBrowserSession> {
    const {
      targetUrl = 'https://www.tiktok.com/',
      executablePath,
      proxyUrl,
      headless = true,
      networkCaptureMs = 8_000,
      timeoutMs = 45_000,
      userAgent,
      viewport = { width: 1920, height: 1080 },
    } = options || {};

    // playwright is an optional runtime dependency — load lazily so the
    // module works in environments where it is not installed
    const { chromium } = await import('playwright');

    const launchOptions: Record<string, unknown> = { headless };
    if (executablePath) launchOptions.executablePath = executablePath;
    if (proxyUrl) launchOptions.proxy = { server: proxyUrl };

    const browser = await chromium.launch(launchOptions as any);
    let context: BrowserContext | null = null;

    try {
      context = await browser.newContext({
        viewport,
        userAgent,
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });

      // Cheap stealth patches before any page script runs
      await context.addInitScript(STEALTH_INIT_SCRIPT);

      const page = await context.newPage();

      // Observe the page's own API traffic — a REAL msToken appears here
      const observedMsTokens = new Set<string>();
      const observedApiUrls: string[] = [];
      page.on('request', (request) => {
        try {
          const url = request.url();
          if (!url.includes('/api/') && !url.includes('/aweme/')) return;
          observedApiUrls.push(url);
          if (observedApiUrls.length <= 25) {
            const u = new URL(url);
            const ms = u.searchParams.get('msToken');
            if (ms) observedMsTokens.add(ms);
          }
        } catch {
          // Ignore malformed URLs
        }
      });

      logger.info({ targetUrl, headless, proxied: !!proxyUrl }, 'Harvesting TikTok browser session');

      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // Give the SPA time to fire its API calls
      await page.waitForTimeout(networkCaptureMs);

      // Extract embedded data blobs
      const universalData = await page.evaluate(() => {
        const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (!el?.textContent) return null;
        try {
          return JSON.parse(el.textContent);
        } catch {
          return null;
        }
      }).catch(() => null);

      const sigiState = await page.evaluate(() => {
        const el = document.getElementById('SIGI_STATE');
        if (!el?.textContent) return null;
        try {
          return JSON.parse(el.textContent);
        } catch {
          return null;
        }
      }).catch(() => null);

      // Collect cookies
      const cookieList = await context.cookies('https://www.tiktok.com');
      const cookies: Record<string, string> = {};
      for (const cookie of cookieList) {
        if (
          VALUABLE_COOKIE_PATTERNS.some((p) => cookie.name === p || cookie.name.includes(p)) ||
          cookie.name.startsWith('tt_')
        ) {
          cookies[cookie.name] = cookie.value;
        }
      }

      const session: TikTokBrowserSession = {
        cookies,
        userAgent: userAgent || (await page.evaluate(() => navigator.userAgent)),
        pageUrl: page.url(),
        harvestedAt: Date.now(),
        source: 'playwright',
        universalData: universalData ?? undefined,
        sigiState: sigiState ?? undefined,
        observedMsTokens: [...observedMsTokens],
        observedApiUrls: observedApiUrls.slice(0, 25),
      };

      logger.info(
        {
          pageUrl: session.pageUrl,
          cookieNames: Object.keys(cookies),
          status: response?.status(),
          hasUniversalData: !!universalData,
          observedMsTokens: session.observedMsTokens.length,
        },
        'TikTok browser session harvested',
      );

      return session;
    } finally {
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  /**
   * Validate a harvested (or externally supplied) session before import.
   */
  validateSession(session: TikTokBrowserSession): { valid: boolean; reason?: string } {
    if (!session.cookies || typeof session.cookies !== 'object') {
      return { valid: false, reason: 'missing cookies' };
    }
    const hasTtwid = !!session.cookies['ttwid'];
    const hasMsToken =
      !!session.cookies['msToken'] || session.observedMsTokens.length > 0;
    if (!hasTtwid && !hasMsToken) {
      return {
        valid: false,
        reason: 'session has neither ttwid nor msToken — the page likely never passed the credibility gate',
      };
    }
    if (!session.userAgent) {
      return { valid: false, reason: 'missing userAgent (required for X-Bogus consistency)' };
    }
    return { valid: true };
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const tiktokBrowserHarvester = new TikTokBrowserHarvester();
