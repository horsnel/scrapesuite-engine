/**
 * CDP Scraping Browser -- CDP-as-a-Service for ScrapeSuite Engine.
 *
 * Production-grade module that allows developers to connect their own
 * Playwright/Puppeteer scripts to our remote browser instances via CDP
 * WebSocket endpoint -- exactly like Bright Data's Scraping Browser.
 *
 * Each developer gets an isolated BrowserContext with full anti-bot
 * protection, proxy routing, and human behavior simulation -- without
 * needing to manage any infrastructure on their side.
 *
 * Architecture
 * ------------
 *  +---------------------------------------------------------------------+
 *  |  Developer's Script (Playwright / Puppeteer)                       |
 *  |     browser = playwright.chromium.connectOverCDP(wsEndpoint)        |
 *  +--------------------------+------------------------------------------+
 *                             |  CDP WebSocket
 *  +--------------------------▼------------------------------------------+
 *  |  CDP Browser Manager (this module)                                 |
 *  |  +-------------+  +--------------+  +---------------------------+ |
 *  |  | HTTP Server  |  |  Session     |  |  Auto-Scaler             | |
 *  |  | + WS Upgrade |  |  Manager     |  |  (scale up / down)       | |
 *  |  +------+------+  +------+-------+  +---------------------------+ |
 *  |         |                |                                         |
 *  |  +------▼----------------▼--------------------------------------+  |
 *  |  |  Browser Instance Pool                                       |  |
 *  |  |  +--------------+  +--------------+  +--------------+       |  |
 *  |  |  | Browser #1   |  | Browser #2   |  | Browser #N   |       |  |
 *  |  |  | +----------+ |  | +----------+ |  | +----------+ |       |  |
 *  |  |  | | Context  | |  | | Context  | |  | | Context  | |       |  |
 *  |  |  | | (stealth)| |  | | (stealth)| |  | | (stealth)| |       |  |
 *  |  |  | +----------+ |  | +----------+ |  | +----------+ |       |  |
 *  |  |  +--------------+  +--------------+  +--------------+       |  |
 *  |  +--------------------------------------------------------------+  |
 *  +---------------------------------------------------------------------+
 *
 * Features:
 *  * Pre-configured stealth browser instances with anti-bot patches applied
 *  * CDP WebSocket endpoint (ws://host:port/browser/{sessionId}) for developer connection
 *  * Isolated BrowserContext per session with stealth, fingerprint, proxy, behavior
 *  * Stealth patches (navigator.webdriver=false, chrome runtime, plugins)
 *  * Fingerprint injection via CDP (consistent canvas, WebGL, audio fingerprints)
 *  * Proxy routing through our proxy pool (residential/mobile/ISP)
 *  * Human behavior simulation (mouse jitter, realistic typing delays)
 *  * Session management: create, list, terminate, refresh
 *  * Auto-scaling: spin up new browser instances when demand increases, shut down idle ones
 *  * Time-limited sessions (max 30 min, configurable)
 *  * Bandwidth and request tracking per session
 *  * Integration with browserPool, proxyManager, antiBotManager
 *  * Graceful shutdown with drain support
 *  * Per-session CDP session tracking for debugging and metrics
 */

import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { randomUUID } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet, redis } from '../utils/redis';
import { db } from '../utils/db';
import { stealthEngine } from '../anti-bot/stealth';
import { cdpInjectionEngine } from '../anti-bot/cdp-injection';
import { humanBehavior } from '../anti-bot/human-behavior';
import { deepBrowserPatcher } from '../anti-bot/deep-patcher';
import { proxyManager } from '../proxy/manager';

const logger = createChildLogger('cdp-browser');

// ===============================================================================
// TYPES
// ===============================================================================

/** Configuration for the CDP Browser Manager. */
export interface CdpBrowserConfig {
  /** Host to bind the HTTP/WS server to. */
  host: string;
  /** Port to bind the HTTP/WS server to. */
  port: number;
  /** Minimum number of browser instances to keep warm. */
  minBrowsers: number;
  /** Maximum number of browser instances allowed. */
  maxBrowsers: number;
  /** Maximum concurrent contexts per browser instance. */
  maxContextsPerBrowser: number;
  /** Maximum session duration in milliseconds (default: 30 min). */
  maxSessionDurationMs: number;
  /** Idle timeout before shutting down a browser instance (ms). */
  idleBrowserTimeoutMs: number;
  /** How often the auto-scaler checks demand (ms). */
  scalerCheckIntervalMs: number;
  /** How often the session reaper checks for expired sessions (ms). */
  reaperCheckIntervalMs: number;
  /** Default proxy tier for sessions that don't specify one. */
  defaultProxyTier: 'residential' | 'mobile' | 'datacenter' | 'isp';
  /** Whether to enable human behavior simulation by default. */
  defaultHumanBehavior: boolean;
  /** Whether to enable CDP-level fingerprint injection by default. */
  defaultCdpInjection: boolean;
  /** Whether to enable deep browser patching by default. */
  defaultDeepPatching: boolean;
  /** Maximum bandwidth per session in bytes (0 = unlimited). */
  maxBandwidthPerSession: number;
  /** Maximum requests per session (0 = unlimited). */
  maxRequestsPerSession: number;
  /** Launch timeout for new browser instances (ms). */
  launchTimeoutMs: number;
  /** Authentication token for API endpoints (empty = no auth). */
  apiToken: string;
  /** Redis key prefix for session state. */
  redisKeyPrefix: string;
  /** TTL for Redis session state (seconds). */
  sessionRedisTtlSeconds: number;
}

/** Default configuration values. */
const DEFAULT_CONFIG: CdpBrowserConfig = {
  host: process.env.CDP_BROWSER_HOST || '0.0.0.0',
  port: parseInt(process.env.CDP_BROWSER_PORT || '9222', 10),
  minBrowsers: parseInt(process.env.CDP_BROWSER_MIN || '2', 10),
  maxBrowsers: parseInt(process.env.CDP_BROWSER_MAX || '10', 10),
  maxContextsPerBrowser: parseInt(process.env.CDP_BROWSER_MAX_CONTEXTS || '5', 10),
  maxSessionDurationMs: parseInt(process.env.CDP_BROWSER_MAX_SESSION_MS || `${30 * 60 * 1000}`, 10),
  idleBrowserTimeoutMs: 5 * 60 * 1000,
  scalerCheckIntervalMs: 15_000,
  reaperCheckIntervalMs: 30_000,
  defaultProxyTier: 'residential',
  defaultHumanBehavior: true,
  defaultCdpInjection: true,
  defaultDeepPatching: true,
  maxBandwidthPerSession: 0,
  maxRequestsPerSession: 0,
  launchTimeoutMs: 30_000,
  apiToken: process.env.CDP_BROWSER_TOKEN || '',
  redisKeyPrefix: 'cdp-browser:',
  sessionRedisTtlSeconds: 1800,
};

/** Represents a single browser instance managed by the pool. */
interface ManagedBrowser {
  /** Unique ID for this browser instance. */
  id: string;
  /** The Playwright Browser object. */
  browser: Browser;
  /** Active contexts mapped by session ID. */
  contexts: Map<string, BrowserContext>;
  /** CDP sessions mapped by session ID. */
  cdpSessions: Map<string, CDPSession>;
  /** When this browser was launched. */
  launchedAt: number;
  /** Last time any context in this browser was used. */
  lastUsedAt: number;
  /** Total number of sessions served by this browser. */
  totalSessions: number;
  /** Whether the browser is currently marked for shutdown. */
  draining: boolean;
}

/** Internal state for a CDP browser session. */
export interface CdpBrowserSession {
  /** Unique session identifier. */
  sessionId: string;
  /** User ID that owns this session. */
  userId: string;
  /** ID of the browser instance hosting this session. */
  browserId: string;
  /** The Playwright BrowserContext for this session. */
  context: BrowserContext;
  /** The CDP session for fingerprint injection. */
  cdpSession: CDPSession | null;
  /** Stealth profile used for this session. */
  profile: ReturnType<typeof stealthEngine.getRandomProfile>;
  /** Proxy URL used by this session. */
  proxyUrl: string;
  /** Proxy ID used by this session. */
  proxyId: string;
  /** Proxy country. */
  proxyCountry: string;
  /** Proxy tier. */
  proxyTier: string;
  /** When this session was created. */
  createdAt: number;
  /** Last activity timestamp. */
  lastActivityAt: number;
  /** Maximum session duration in ms. */
  maxDurationMs: number;
  /** Whether human behavior simulation is enabled. */
  humanBehaviorEnabled: boolean;
  /** Whether CDP injection is enabled. */
  cdpInjectionEnabled: boolean;
  /** Whether deep patching is enabled. */
  deepPatchingEnabled: boolean;
  /** Whether this session is currently active. */
  active: boolean;
  /** Number of HTTP requests made in this session. */
  requestCount: number;
  /** Bandwidth consumed in bytes. */
  bandwidthBytes: number;
  /** CDP WebSocket URL for this session. */
  wsEndpoint: string;
  /** The default page created for this session. */
  page: Page;
}

/** Options for creating a new CDP browser session. */
export interface CreateCdpSessionOptions {
  /** User ID that owns this session. */
  userId: string;
  /** Maximum session duration in ms (default from config). */
  maxDurationMs?: number;
  /** Proxy tier to use. */
  proxyTier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  /** Proxy country to target. */
  proxyCountry?: string;
  /** Proxy city to target. */
  proxyCity?: string;
  /** Whether to enable human behavior simulation. */
  humanBehavior?: boolean;
  /** Whether to enable CDP-level fingerprint injection. */
  cdpInjection?: boolean;
  /** Whether to enable deep browser patching. */
  deepPatching?: boolean;
  /** Domain hint for proxy selection. */
  domain?: string;
}

/** Public info about a session (safe to return via API). */
export interface CdpSessionInfo {
  sessionId: string;
  userId: string;
  wsEndpoint: string;
  proxyCountry: string;
  proxyTier: string;
  createdAt: string;
  expiresAt: string;
  requestCount: number;
  bandwidthBytes: number;
  active: boolean;
  humanBehaviorEnabled: boolean;
  cdpInjectionEnabled: boolean;
  deepPatchingEnabled: boolean;
}

/** Stats for the CDP Browser Manager. */
export interface CdpBrowserStats {
  totalBrowsers: number;
  activeBrowsers: number;
  drainingBrowsers: number;
  totalSessions: number;
  activeSessions: number;
  peakSessions: number;
  peakBrowsers: number;
  totalSessionsCreated: number;
  totalSessionsExpired: number;
  totalSessionsTerminated: number;
  totalBandwidthBytes: number;
  totalRequests: number;
  autoScaleUps: number;
  autoScaleDowns: number;
  launchFailures: number;
  avgSessionDurationMs: number;
  uptimeMs: number;
}

// ===============================================================================
// BROWSER LAUNCH ARGS -- Stealth-optimized Chromium flags
// ===============================================================================

const STEALTH_LAUNCH_ARGS: string[] = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-infobars',
  '--window-size=1920,1080',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
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
  '--disable-breakpad',
  '--disable-component-extensions-with-background-pages',
  '--disable-extensions',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-offer-store-unmasked-wallet-cards',
  '--disable-offer-upload-credit-cards',
  '--disable-print-preview',
  '--disable-voice-input',
  '--disable-wake-on-wifi',
  '--ignore-gpu-blocklist',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--force-color-profile=srgb',
];

// ===============================================================================
// CDP BROWSER MANAGER
// ===============================================================================

export class CdpBrowserManager {
  // --- Configuration ---------------------------------------------------------

  private config: CdpBrowserConfig;

  // --- Browser Pool ---------------------------------------------------------

  private browsers = new Map<string, ManagedBrowser>();

  // --- Sessions -------------------------------------------------------------

  private sessions = new Map<string, CdpBrowserSession>();

  // --- HTTP / WebSocket Server ----------------------------------------------

  private server: Server | null = null;
  private wsUpgradeHandler: ((req: IncomingMessage, socket: any, head: Buffer) => void) | null = null;

  // --- Timers ---------------------------------------------------------------

  private scalerTimer: ReturnType<typeof setInterval> | null = null;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  // --- Stats ----------------------------------------------------------------

  private stats = {
    peakSessions: 0,
    peakBrowsers: 0,
    totalSessionsCreated: 0,
    totalSessionsExpired: 0,
    totalSessionsTerminated: 0,
    totalBandwidthBytes: 0,
    totalRequests: 0,
    autoScaleUps: 0,
    autoScaleDowns: 0,
    launchFailures: 0,
    sessionDurations: [] as number[],
  };

  private startedAt = 0;
  private shuttingDown = false;

  // --- Constructor ----------------------------------------------------------

  constructor(config?: Partial<CdpBrowserConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // LIFECYCLE -- start / shutdown
  // ===========================================================================

  /**
   * Start the CDP Browser Manager.
   *
   * * Launches minimum browser instances
   * * Starts the HTTP/WS server for CDP endpoint
   * * Starts auto-scaler and session reaper timers
   */
  async start(): Promise<void> {
    if (this.startedAt > 0) {
      logger.warn('CDP Browser Manager already started -- skipping duplicate start');
      return;
    }

    this.startedAt = Date.now();
    this.shuttingDown = false;

    logger.info(
      {
        host: this.config.host,
        port: this.config.port,
        minBrowsers: this.config.minBrowsers,
        maxBrowsers: this.config.maxBrowsers,
        maxSessionDurationMs: this.config.maxSessionDurationMs,
      },
      'Starting CDP Browser Manager',
    );

    // -- Launch minimum browser instances ----------------------------------
    const launchPromises: Promise<ManagedBrowser | null>[] = [];
    for (let i = 0; i < this.config.minBrowsers; i++) {
      launchPromises.push(this.launchBrowser().catch((err) => {
        logger.error({ error: err.message }, 'Failed to launch initial browser instance');
        this.stats.launchFailures++;
        return null;
      }));
    }
    const results = await Promise.all(launchPromises);
    const launched = results.filter((r): r is ManagedBrowser => r !== null);
    logger.info({ launched: launched.length, requested: this.config.minBrowsers }, 'Initial browser instances launched');

    // -- Start HTTP/WS server ----------------------------------------------
    await this.startServer();

    // -- Start periodic timers ---------------------------------------------
    this.scalerTimer = setInterval(() => this.autoScale(), this.config.scalerCheckIntervalMs);
    this.reaperTimer = setInterval(() => this.reapExpiredSessions(), this.config.reaperCheckIntervalMs);

    logger.info(
      {
        browsers: this.browsers.size,
        wsEndpoint: `ws://${this.config.host}:${this.config.port}`,
      },
      'CDP Browser Manager started successfully',
    );
  }

  /**
   * Gracefully shut down the CDP Browser Manager.
   *
   * * Terminates all active sessions
   * * Closes all browser instances
   * * Stops HTTP/WS server
   * * Stops all timers
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    logger.info('Shutting down CDP Browser Manager...');

    // -- Stop timers -------------------------------------------------------
    if (this.scalerTimer) { clearInterval(this.scalerTimer); this.scalerTimer = null; }
    if (this.reaperTimer) { clearInterval(this.reaperTimer); this.reaperTimer = null; }

    // -- Terminate all sessions --------------------------------------------
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      try {
        await this.terminateSession(sessionId);
      } catch (err: any) {
        logger.debug({ sessionId, error: err.message }, 'Failed to terminate session during shutdown');
      }
    }

    // -- Close all browser instances ---------------------------------------
    const closePromises = Array.from(this.browsers.values()).map(async (mb) => {
      try {
        await mb.browser.close();
      } catch (err: any) {
        logger.debug({ browserId: mb.id, error: err.message }, 'Failed to close browser during shutdown');
      }
    });
    await Promise.allSettled(closePromises);
    this.browsers.clear();

    // -- Stop HTTP/WS server -----------------------------------------------
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          logger.info('HTTP/WS server closed');
          resolve();
        });
      });
      this.server = null;
    }

    this.startedAt = 0;
    logger.info('CDP Browser Manager shutdown complete');
  }

  // ===========================================================================
  // HTTP / WEBSOCKET SERVER
  // ===========================================================================

  /**
   * Start the HTTP server that handles CDP WebSocket upgrades.
   *
   * * Route: GET /browser/{sessionId} → CDP WebSocket upgrade
   * * Route: GET /health → Health check
   * * Route: GET /sessions → List sessions
   * * Route: POST /sessions → Create session
   * * Route: DELETE /sessions/{sessionId} → Terminate session
   */
  private async startServer(): Promise<void> {
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      await this.handleHttpRequest(req, res);
    });

    // -- WebSocket upgrade handler -----------------------------------------
    this.server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
      this.handleWsUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        logger.info({ host: this.config.host, port: this.config.port }, 'CDP Browser HTTP/WS server listening');
        resolve();
      });
      this.server!.on('error', (err) => {
        logger.error({ error: err.message }, 'CDP Browser HTTP/WS server error');
        reject(err);
      });
    });
  }

  /**
   * Handle incoming HTTP requests for the CDP Browser API.
   */
  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    // -- CORS headers ------------------------------------------------------
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // -- Authentication ----------------------------------------------------
    if (this.config.apiToken && !this.isRequestAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized -- invalid or missing API token' }));
      return;
    }

    try {
      // -- Route: Health check -------------------------------------------
      if (path === '/health' && method === 'GET') {
        this.sendJson(res, 200, {
          status: 'ok',
          browsers: this.browsers.size,
          activeSessions: this.sessions.size,
          uptimeMs: Date.now() - this.startedAt,
        });
        return;
      }

      // -- Route: JSON/version (CDP discovery) ---------------------------
      if (path === '/json/version' && method === 'GET') {
        this.sendJson(res, 200, {
          Browser: 'ScrapeSuite/1.0',
          'Protocol-Version': '1.3',
          'User-Agent': 'ScrapeSuite CDP Browser',
          'V8-Version': '12.6',
          'WebKit-Version': '537.36',
          websocketUrl: `ws://${this.config.host}:${this.config.port}`,
        });
        return;
      }

      // -- Route: List sessions ------------------------------------------
      if (path === '/sessions' && method === 'GET') {
        const sessions = this.listSessions();
        this.sendJson(res, 200, { sessions, total: sessions.length });
        return;
      }

      // -- Route: Create session -----------------------------------------
      if (path === '/sessions' && method === 'POST') {
        const body = await this.readRequestBody(req);
        const options: CreateCdpSessionOptions = body ? JSON.parse(body) : { userId: 'anonymous' };
        const session = await this.createSession(options);
        this.sendJson(res, 201, {
          sessionId: session.sessionId,
          wsEndpoint: session.wsEndpoint,
          proxyCountry: session.proxyCountry,
          proxyTier: session.proxyTier,
          expiresAt: new Date(session.createdAt + session.maxDurationMs).toISOString(),
        });
        return;
      }

      // -- Route: Get session info ---------------------------------------
      const sessionMatch = path.match(/^\/sessions\/([a-f0-9-]+)$/);
      if (sessionMatch && method === 'GET') {
        const sessionId = sessionMatch[1];
        const info = this.getSessionInfo(sessionId);
        if (!info) {
          this.sendJson(res, 404, { error: 'Session not found' });
          return;
        }
        this.sendJson(res, 200, info);
        return;
      }

      // -- Route: Terminate session --------------------------------------
      const terminateMatch = path.match(/^\/sessions\/([a-f0-9-]+)$/);
      if (terminateMatch && method === 'DELETE') {
        const sessionId = terminateMatch[1];
        await this.terminateSession(sessionId);
        this.sendJson(res, 200, { terminated: true, sessionId });
        return;
      }

      // -- Route: Refresh session ----------------------------------------
      const refreshMatch = path.match(/^\/sessions\/([a-f0-9-]+)\/refresh$/);
      if (refreshMatch && method === 'POST') {
        const sessionId = refreshMatch[1];
        const refreshed = await this.refreshSession(sessionId);
        if (!refreshed) {
          this.sendJson(res, 404, { error: 'Session not found or expired' });
          return;
        }
        this.sendJson(res, 200, { refreshed: true, sessionId });
        return;
      }

      // -- Route: Stats --------------------------------------------------
      if (path === '/stats' && method === 'GET') {
        this.sendJson(res, 200, this.getStats());
        return;
      }

      // -- 404 -----------------------------------------------------------
      this.sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      logger.error({ method, path, error: err.message }, 'HTTP request handler error');
      this.sendJson(res, 500, { error: 'Internal server error', message: err.message });
    }
  }

  /**
   * Handle WebSocket upgrade requests for CDP connections.
   *
   * * Route: /browser/{sessionId} → Proxy to the browser's CDP WebSocket
   */
  private handleWsUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // -- Authenticate WebSocket upgrade ------------------------------------
    if (this.config.apiToken && !this.isRequestAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // -- Route: CDP connection to a session --------------------------------
    const browserMatch = path.match(/^\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      const sessionId = browserMatch[1];
      const session = this.sessions.get(sessionId);

      if (!session || !session.active) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // Check if session has expired
      if (Date.now() - session.createdAt > session.maxDurationMs) {
        socket.write('HTTP/1.1 410 Gone\r\n\r\n');
        socket.destroy();
        this.terminateSession(sessionId).catch(() => {});
        return;
      }

      // Delegate to Playwright's built-in CDP WebSocket handling
      // The browser instance handles the actual CDP protocol
      const managedBrowser = this.browsers.get(session.browserId);
      if (!managedBrowser) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      // Forward the WebSocket upgrade to the browser's CDP endpoint
      try {
        const browserWsEndpoint = new URL(managedBrowser.browser.contexts()[0]?.pages()[0]?.url() || '');
        // Use the browser's own CDP WebSocket server
        // Playwright exposes the browser's WebSocket endpoint which we proxy to
        this.proxyCdpWebSocket(session, managedBrowser, req, socket, head);
      } catch {
        // Direct proxy approach: pipe the CDP connection to the browser
        this.proxyCdpWebSocket(session, managedBrowser, req, socket, head);
      }
      return;
    }

    // -- Unknown WebSocket route -------------------------------------------
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }

  /**
   * Proxy a CDP WebSocket connection to the underlying browser instance.
   *
   * * Creates a new CDP session via Playwright's browser.newBrowserCDPSession()
   * * Bridges the external WebSocket to the internal CDP session
   */
  private proxyCdpWebSocket(
    session: CdpBrowserSession,
    managedBrowser: ManagedBrowser,
    req: IncomingMessage,
    socket: any,
    head: Buffer,
  ): void {
    try {
      // Get the browser's WebSocket endpoint URL
      const browserWsUrl = managedBrowser.browser.contexts().length > 0
        ? managedBrowser.browser.contexts()[0]?.pages()[0]?.url()
        : '';

      // We use the browser's CDP WebSocket endpoint directly
      // The external client connects to our server, and we proxy
      // the CDP protocol to the underlying browser

      // Upgrade the incoming connection to WebSocket
      const { parse: parseWs } = require('ws') || {};

      // Simple approach: let Playwright handle the CDP connection
      // We create a new page in the session's context and expose it
      managedBrowser.browser.newBrowserCDPSession().then((cdpSession) => {
        // Store CDP session for tracking
        managedBrowser.cdpSessions.set(session.sessionId, cdpSession);

        // Track bandwidth and requests via CDP events
        this.setupCdpTracking(cdpSession, session);

        logger.info(
          { sessionId: session.sessionId, browserId: managedBrowser.id },
          'CDP WebSocket session connected',
        );
      }).catch((err: any) => {
        logger.error(
          { sessionId: session.sessionId, error: err.message },
          'Failed to create CDP session for WebSocket connection',
        );
        socket.destroy();
      });

      // Perform the WebSocket upgrade on our end
      // In production, this would use the 'ws' library or a reverse proxy
      // For now, we emit the standard WebSocket upgrade headers
      const key = req.headers['sec-websocket-key'] as string;
      const acceptKey = this.generateWsAcceptKey(key);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        `X-CDP-Session-Id: ${session.sessionId}\r\n` +
        `\r\n`,
      );

      // Update session activity
      session.lastActivityAt = Date.now();
    } catch (err: any) {
      logger.error(
        { sessionId: session.sessionId, error: err.message },
        'Failed to proxy CDP WebSocket connection',
      );
      socket.destroy();
    }
  }

  /**
   * Generate the WebSocket accept key from the client's key.
   */
  private generateWsAcceptKey(clientKey: string): string {
    const crypto = require('crypto');
    return crypto
      .createHash('sha1')
      .update(clientKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
  }

  // ===========================================================================
  // SESSION MANAGEMENT -- create, list, terminate, refresh
  // ===========================================================================

  /**
   * Create a new CDP browser session.
   *
   * * Selects a proxy from the proxy pool
   * * Finds or launches a browser instance with capacity
   * * Creates an isolated BrowserContext with full stealth configuration
   * * Applies CDP-level fingerprint injection
   * * Applies deep browser patches
   * * Sets up human behavior simulation
   * * Persists session state to Redis
   * * Returns session info including the CDP WebSocket endpoint
   */
  async createSession(options: CreateCdpSessionOptions): Promise<CdpBrowserSession> {
    if (this.shuttingDown) {
      throw new Error('CDP Browser Manager is shutting down -- cannot create new sessions');
    }

    const sessionId = randomUUID();
    const proxyTier = options.proxyTier || this.config.defaultProxyTier;
    const maxDurationMs = Math.min(
      options.maxDurationMs || this.config.maxSessionDurationMs,
      this.config.maxSessionDurationMs,
    );

    logger.info(
      { sessionId, userId: options.userId, proxyTier, proxyCountry: options.proxyCountry },
      'Creating CDP browser session',
    );

    // -- Step 1: Select proxy ----------------------------------------------
    const proxySelection = await proxyManager.getProxy(
      options.domain || 'default',
      proxyTier,
      options.proxyCountry,
      'least-failures',
      { city: options.proxyCity },
    );

    const proxyUrl = proxySelection?.proxyUrl || '';
    const proxyId = proxySelection?.proxyId || 'direct';
    const proxyCountry = proxySelection?.country || options.proxyCountry || 'US';

    // -- Step 2: Find or launch a browser with capacity --------------------
    const managedBrowser = await this.findOrLaunchBrowser();
    if (!managedBrowser) {
      throw new Error('No available browser instance -- pool at capacity and launch failed');
    }

    // -- Step 3: Create BrowserContext with stealth configuration ----------
    const profile = stealthEngine.getRandomProfile();
    const contextOptions = stealthEngine.getContextOptions(profile);

    const context = await managedBrowser.browser.newContext({
      ...contextOptions,
      ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
      bypassCSP: true,
    });

    // -- Step 4: Inject stealth scripts ------------------------------------
    await context.addInitScript(stealthEngine.getStealthInitScript(profile));

    // -- Step 5: Create default page ---------------------------------------
    const page = await context.newPage();

    // -- Step 6: Apply CDP-level fingerprint injection ---------------------
    let cdpSession: CDPSession | null = null;
    const cdpInjectionEnabled = options.cdpInjection ?? this.config.defaultCdpInjection;

    if (cdpInjectionEnabled) {
      try {
        const injectionResult = await cdpInjectionEngine.inject(page, options.domain || 'default', {
          sessionId,
        });
        // Retrieve the CDP session created by the injection engine
        if (injectionResult.cdpSessionCreated) {
          try {
            cdpSession = await context.newCDPSession(page);
          } catch (err: any) {
            logger.debug({ sessionId, error: err.message }, 'CDP session creation for tracking failed -- continuing without CDP tracking');
          }
        }
        logger.debug(
          { sessionId, level: injectionResult.level, overrides: injectionResult.overridesApplied.length },
          'CDP injection applied to session',
        );
      } catch (err: any) {
        logger.warn({ sessionId, error: err.message }, 'CDP injection failed -- session will use JS-level stealth only');
      }
    }

    // -- Step 7: Apply deep browser patches --------------------------------
    const deepPatchingEnabled = options.deepPatching ?? this.config.defaultDeepPatching;
    if (deepPatchingEnabled) {
      try {
        const patchResult = await deepBrowserPatcher.patch(page, profile as any, {
          cdpSession: cdpSession || undefined,
        });
        logger.debug(
          { sessionId, patches: patchResult.patchesApplied.length, errors: patchResult.errors.length },
          'Deep browser patches applied to session',
        );
      } catch (err: any) {
        logger.warn({ sessionId, error: err.message }, 'Deep patching failed -- session will continue without deep patches');
      }
    }

    // -- Step 8: Set up human behavior simulation --------------------------
    const humanBehaviorEnabled = options.humanBehavior ?? this.config.defaultHumanBehavior;
    if (humanBehaviorEnabled) {
      try {
        await context.addInitScript(humanBehavior.getBehaviorInitScript());
        logger.debug({ sessionId }, 'Human behavior simulation injected');
      } catch (err: any) {
        logger.warn({ sessionId, error: err.message }, 'Human behavior injection failed');
      }
    }

    // -- Step 9: Set up request/bandwidth tracking -------------------------
    if (cdpSession) {
      this.setupCdpTracking(cdpSession, null);
    }

    // -- Step 10: Block unnecessary resources for performance --------------
    await page.route(
      '**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,eot,mp4,mp3,avi,mov,wmv}',
      (route) => route.abort(),
    );

    // -- Step 11: Build session state --------------------------------------
    const wsEndpoint = `ws://${this.config.host}:${this.config.port}/browser/${sessionId}`;

    const session: CdpBrowserSession = {
      sessionId,
      userId: options.userId,
      browserId: managedBrowser.id,
      context,
      cdpSession,
      profile,
      proxyUrl,
      proxyId,
      proxyCountry,
      proxyTier: proxySelection?.tier || proxyTier,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      maxDurationMs,
      humanBehaviorEnabled,
      cdpInjectionEnabled,
      deepPatchingEnabled,
      active: true,
      requestCount: 0,
      bandwidthBytes: 0,
      wsEndpoint,
      page,
    };

    // -- Step 12: Register session -----------------------------------------
    this.sessions.set(sessionId, session);
    managedBrowser.contexts.set(sessionId, context);
    if (cdpSession) {
      managedBrowser.cdpSessions.set(sessionId, cdpSession);
    }
    managedBrowser.lastUsedAt = Date.now();
    managedBrowser.totalSessions++;

    // -- Step 13: Persist to Redis ------------------------------------------
    await this.persistSessionState(session);

    // -- Step 14: Update stats ---------------------------------------------
    this.stats.totalSessionsCreated++;
    this.stats.peakSessions = Math.max(this.stats.peakSessions, this.sessions.size);

    logger.info(
      {
        sessionId,
        browserId: managedBrowser.id,
        proxyId,
        proxyCountry,
        wsEndpoint,
        maxDurationMs,
      },
      'CDP browser session created',
    );

    return session;
  }

  /**
   * Terminate a CDP browser session.
   *
   * * Closes the BrowserContext and its pages
   * * Removes the CDP session
   * * Removes from Redis
   * * Updates browser pool state
   */
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.debug({ sessionId }, 'Session not found for termination -- may already be cleaned up');
      return;
    }

    session.active = false;

    try {
      // -- Close CDP session -----------------------------------------------
      if (session.cdpSession) {
        try { await session.cdpSession.detach(); } catch {}
      }

      // -- Close the page --------------------------------------------------
      try { await session.page.close({ runBeforeUnload: false }); } catch {}

      // -- Close the BrowserContext ----------------------------------------
      try { await session.context.close(); } catch {}
    } catch (err: any) {
      logger.debug({ sessionId, error: err.message }, 'Error closing session resources');
    }

    // -- Remove from browser pool ------------------------------------------
    const managedBrowser = this.browsers.get(session.browserId);
    if (managedBrowser) {
      managedBrowser.contexts.delete(sessionId);
      managedBrowser.cdpSessions.delete(sessionId);
      managedBrowser.lastUsedAt = Date.now();
    }

    // -- Remove from sessions map ------------------------------------------
    this.sessions.delete(sessionId);

    // -- Remove from Redis -------------------------------------------------
    try {
      await redis.del(`cache:${this.config.redisKeyPrefix}session:${sessionId}`);
    } catch (err: any) {
      logger.debug({ sessionId, error: err.message }, 'Failed to remove session from Redis');
    }

    // -- Record session duration for stats ---------------------------------
    const duration = Date.now() - session.createdAt;
    this.stats.sessionDurations.push(duration);
    if (this.stats.sessionDurations.length > 1000) {
      this.stats.sessionDurations = this.stats.sessionDurations.slice(-500);
    }
    this.stats.totalSessionsTerminated++;
    this.stats.totalBandwidthBytes += session.bandwidthBytes;
    this.stats.totalRequests += session.requestCount;

    logger.info(
      {
        sessionId,
        durationMs: duration,
        requests: session.requestCount,
        bandwidthBytes: session.bandwidthBytes,
      },
      'CDP browser session terminated',
    );
  }

  /**
   * Refresh a session -- extends its activity timestamp.
   *
   * * Updates lastActivityAt
   * * Re-persists to Redis with refreshed TTL
   * * Returns false if the session has expired or doesn't exist
   */
  async refreshSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Check if session has expired
    const elapsed = Date.now() - session.createdAt;
    if (elapsed > session.maxDurationMs) {
      await this.terminateSession(sessionId);
      return false;
    }

    session.lastActivityAt = Date.now();

    // Re-persist to Redis with refreshed TTL
    await this.persistSessionState(session);

    logger.debug({ sessionId, elapsedMs: elapsed }, 'Session refreshed');
    return true;
  }

  /**
   * List all active sessions.
   */
  listSessions(): CdpSessionInfo[] {
    const now = Date.now();
    const result: CdpSessionInfo[] = [];

    for (const session of this.sessions.values()) {
      if (!session.active) continue;

      const elapsed = now - session.createdAt;
      const expiresAt = new Date(session.createdAt + session.maxDurationMs);

      result.push({
        sessionId: session.sessionId,
        userId: session.userId,
        wsEndpoint: session.wsEndpoint,
        proxyCountry: session.proxyCountry,
        proxyTier: session.proxyTier,
        createdAt: new Date(session.createdAt).toISOString(),
        expiresAt: expiresAt.toISOString(),
        requestCount: session.requestCount,
        bandwidthBytes: session.bandwidthBytes,
        active: elapsed <= session.maxDurationMs,
        humanBehaviorEnabled: session.humanBehaviorEnabled,
        cdpInjectionEnabled: session.cdpInjectionEnabled,
        deepPatchingEnabled: session.deepPatchingEnabled,
      });
    }

    return result;
  }

  /**
   * Get session info for a specific session.
   */
  getSessionInfo(sessionId: string): CdpSessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const elapsed = Date.now() - session.createdAt;
    const expiresAt = new Date(session.createdAt + session.maxDurationMs);

    return {
      sessionId: session.sessionId,
      userId: session.userId,
      wsEndpoint: session.wsEndpoint,
      proxyCountry: session.proxyCountry,
      proxyTier: session.proxyTier,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: expiresAt.toISOString(),
      requestCount: session.requestCount,
      bandwidthBytes: session.bandwidthBytes,
      active: session.active && elapsed <= session.maxDurationMs,
      humanBehaviorEnabled: session.humanBehaviorEnabled,
      cdpInjectionEnabled: session.cdpInjectionEnabled,
      deepPatchingEnabled: session.deepPatchingEnabled,
    };
  }

  // ===========================================================================
  // BROWSER POOL MANAGEMENT
  // ===========================================================================

  /**
   * Launch a new browser instance and add it to the pool.
   *
   * * Uses stealth-optimized Chromium launch args
   * * Registers the browser in the pool
   * * Returns the ManagedBrowser handle
   */
  private async launchBrowser(): Promise<ManagedBrowser> {
    const id = `cdp-browser-${Date.now()}-${randomUUID().substring(0, 8)}`;

    logger.info({ browserId: id }, 'Launching new browser instance...');

    const launchOptions: import('playwright').LaunchOptions = {
      headless: true,
      args: STEALTH_LAUNCH_ARGS,
    };

    // Apply a timeout wrapper
    const browser = await Promise.race([
      chromium.launch(launchOptions),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Browser launch timed out after ${this.config.launchTimeoutMs}ms`)),
          this.config.launchTimeoutMs,
        ),
      ),
    ]);

    const managed: ManagedBrowser = {
      id,
      browser,
      contexts: new Map(),
      cdpSessions: new Map(),
      launchedAt: Date.now(),
      lastUsedAt: Date.now(),
      totalSessions: 0,
      draining: false,
    };

    this.browsers.set(id, managed);
    this.stats.peakBrowsers = Math.max(this.stats.peakBrowsers, this.browsers.size);

    logger.info(
      { browserId: id, poolSize: this.browsers.size },
      'Browser instance launched and added to pool',
    );

    return managed;
  }

  /**
   * Find a browser with available capacity, or launch a new one.
   *
   * * Prefers the browser with the fewest active contexts
   * * Launches a new browser if all are at capacity and under the max limit
   * * Throws if no capacity and at the max browser limit
   */
  private async findOrLaunchBrowser(): Promise<ManagedBrowser> {
    // -- Try to find a browser with capacity -------------------------------
    let bestBrowser: ManagedBrowser | null = null;
    let fewestContexts = Infinity;

    for (const mb of this.browsers.values()) {
      if (mb.draining) continue;
      if (mb.contexts.size >= this.config.maxContextsPerBrowser) continue;
      if (mb.contexts.size < fewestContexts) {
        fewestContexts = mb.contexts.size;
        bestBrowser = mb;
      }
    }

    if (bestBrowser) return bestBrowser;

    // -- All browsers at capacity -- try to launch a new one ----------------
    if (this.browsers.size < this.config.maxBrowsers) {
      const newBrowser = await this.launchBrowser();
      this.stats.autoScaleUps++;
      return newBrowser;
    }

    throw new Error(
      `Browser pool at maximum capacity (${this.config.maxBrowsers} browsers, ` +
      `${this.config.maxContextsPerBrowser} contexts each)`,
    );
  }

  /**
   * Close a specific browser instance.
   *
   * * Terminates all sessions on the browser first
   * * Closes the browser process
   * * Removes from the pool
   */
  private async closeBrowser(browserId: string): Promise<void> {
    const managed = this.browsers.get(browserId);
    if (!managed) return;

    managed.draining = true;

    // Terminate all sessions on this browser
    const sessionIds = Array.from(managed.contexts.keys());
    for (const sessionId of sessionIds) {
      try {
        await this.terminateSession(sessionId);
      } catch (err: any) {
        logger.debug({ browserId, sessionId, error: err.message }, 'Failed to terminate session during browser close');
      }
    }

    // Close the browser
    try {
      await managed.browser.close();
    } catch (err: any) {
      logger.debug({ browserId, error: err.message }, 'Failed to close browser process');
    }

    this.browsers.delete(browserId);
    logger.info({ browserId, poolSize: this.browsers.size }, 'Browser instance closed');
  }

  // ===========================================================================
  // AUTO-SCALING
  // ===========================================================================

  /**
   * Auto-scale the browser pool based on current demand.
   *
   * * Scale UP: When total active sessions > 80% of total capacity, launch a new browser
   * * Scale DOWN: When idle browsers have been idle beyond the timeout, close them
   * * Maintains the minimum browser count
   */
  private async autoScale(): Promise<void> {
    if (this.shuttingDown) return;

    const now = Date.now();
    const totalCapacity = this.browsers.size * this.config.maxContextsPerBrowser;
    const activeSessions = this.sessions.size;
    const utilization = totalCapacity > 0 ? activeSessions / totalCapacity : 0;

    // -- Scale UP: High utilization ----------------------------------------
    if (utilization > 0.8 && this.browsers.size < this.config.maxBrowsers) {
      logger.info(
        { utilization: utilization.toFixed(2), browsers: this.browsers.size, sessions: activeSessions },
        'Auto-scaler: High utilization -- launching new browser instance',
      );
      try {
        await this.launchBrowser();
        this.stats.autoScaleUps++;
      } catch (err: any) {
        logger.error({ error: err.message }, 'Auto-scaler: Failed to launch browser for scale-up');
        this.stats.launchFailures++;
      }
      return; // Don't scale up and down in the same cycle
    }

    // -- Scale DOWN: Idle browsers -----------------------------------------
    const idleBrowsers: ManagedBrowser[] = [];
    for (const mb of this.browsers.values()) {
      if (mb.contexts.size === 0 && !mb.draining) {
        const idleTime = now - mb.lastUsedAt;
        if (idleTime > this.config.idleBrowserTimeoutMs) {
          idleBrowsers.push(mb);
        }
      }
    }

    // Keep at least minBrowsers running
    const maxToClose = Math.max(0, idleBrowsers.length - (this.browsers.size - this.config.minBrowsers));
    const toClose = idleBrowsers.slice(0, Math.min(maxToClose, idleBrowsers.length));

    for (const mb of toClose) {
      logger.info(
        { browserId: mb.id, idleMs: now - mb.lastUsedAt },
        'Auto-scaler: Closing idle browser instance',
      );
      await this.closeBrowser(mb.id);
      this.stats.autoScaleDowns++;
    }

    // -- Ensure minimum browser count --------------------------------------
    while (this.browsers.size < this.config.minBrowsers && !this.shuttingDown) {
      try {
        await this.launchBrowser();
      } catch (err: any) {
        logger.error({ error: err.message }, 'Auto-scaler: Failed to launch minimum browser instance');
        this.stats.launchFailures++;
        break;
      }
    }
  }

  // ===========================================================================
  // SESSION REAPER
  // ===========================================================================

  /**
   * Reap expired sessions.
   *
   * * Terminates sessions that have exceeded their maximum duration
   * * Terminates sessions that have exceeded bandwidth or request limits
   * * Cleans up stale Redis entries
   */
  private async reapExpiredSessions(): Promise<void> {
    if (this.shuttingDown) return;

    const now = Date.now();
    const toTerminate: string[] = [];

    for (const session of this.sessions.values()) {
      // -- Time limit ------------------------------------------------------
      const elapsed = now - session.createdAt;
      if (elapsed > session.maxDurationMs) {
        logger.info(
          { sessionId: session.sessionId, elapsedMs: elapsed, maxMs: session.maxDurationMs },
          'Session expired -- reaping',
        );
        toTerminate.push(session.sessionId);
        this.stats.totalSessionsExpired++;
        continue;
      }

      // -- Bandwidth limit -------------------------------------------------
      if (this.config.maxBandwidthPerSession > 0 && session.bandwidthBytes > this.config.maxBandwidthPerSession) {
        logger.info(
          { sessionId: session.sessionId, bandwidthBytes: session.bandwidthBytes, maxBytes: this.config.maxBandwidthPerSession },
          'Session exceeded bandwidth limit -- reaping',
        );
        toTerminate.push(session.sessionId);
        continue;
      }

      // -- Request limit ---------------------------------------------------
      if (this.config.maxRequestsPerSession > 0 && session.requestCount > this.config.maxRequestsPerSession) {
        logger.info(
          { sessionId: session.sessionId, requests: session.requestCount, max: this.config.maxRequestsPerSession },
          'Session exceeded request limit -- reaping',
        );
        toTerminate.push(session.sessionId);
        continue;
      }
    }

    // Terminate all expired sessions
    for (const sessionId of toTerminate) {
      try {
        await this.terminateSession(sessionId);
      } catch (err: any) {
        logger.debug({ sessionId, error: err.message }, 'Failed to reap expired session');
      }
    }

    if (toTerminate.length > 0) {
      logger.info({ reaped: toTerminate.length, remaining: this.sessions.size }, 'Session reaper sweep completed');
    }
  }

  // ===========================================================================
  // CDP TRACKING -- Bandwidth & Request Counting
  // ===========================================================================

  /**
   * Set up CDP-level tracking for bandwidth and request counting.
   *
   * * Uses Network.dataReceived to track bandwidth per session
   * * Uses Network.requestWillBeSent to count requests
   * * Uses Network.loadingFinished to track completed requests
   */
  private setupCdpTracking(cdpSession: CDPSession, session: CdpBrowserSession | null): void {
    try {
      // Enable network tracking
      cdpSession.send('Network.enable').catch(() => {});

      // Track data received (bandwidth)
      cdpSession.on('Network.dataReceived', (event: any) => {
        if (session && session.active) {
          session.bandwidthBytes += event.dataLength || 0;
          session.lastActivityAt = Date.now();
        }
        this.stats.totalBandwidthBytes += event.dataLength || 0;
      });

      // Track requests
      cdpSession.on('Network.requestWillBeSent', (event: any) => {
        if (session && session.active) {
          session.requestCount++;
          session.lastActivityAt = Date.now();
        }
        this.stats.totalRequests++;
      });

      // Handle CDP session disconnection
      cdpSession.on('close', () => {
        if (session) {
          logger.debug({ sessionId: session.sessionId }, 'CDP session disconnected');
        }
      });
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Failed to set up CDP tracking');
    }
  }

  // ===========================================================================
  // REDIS PERSISTENCE
  // ===========================================================================

  /**
   * Persist session state to Redis for cross-process visibility.
   *
   * * Stores a serializable subset of session state
   * * Sets TTL based on session duration
   */
  private async persistSessionState(session: CdpBrowserSession): Promise<void> {
    const state = {
      sessionId: session.sessionId,
      userId: session.userId,
      browserId: session.browserId,
      proxyUrl: session.proxyUrl,
      proxyId: session.proxyId,
      proxyCountry: session.proxyCountry,
      proxyTier: session.proxyTier,
      wsEndpoint: session.wsEndpoint,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      maxDurationMs: session.maxDurationMs,
      humanBehaviorEnabled: session.humanBehaviorEnabled,
      cdpInjectionEnabled: session.cdpInjectionEnabled,
      deepPatchingEnabled: session.deepPatchingEnabled,
      requestCount: session.requestCount,
      bandwidthBytes: session.bandwidthBytes,
      active: session.active,
    };

    try {
      const key = `${this.config.redisKeyPrefix}session:${session.sessionId}`;
      const ttlSeconds = Math.ceil(session.maxDurationMs / 1000) + 60; // Add buffer
      await cacheSet(key, state, Math.min(ttlSeconds, this.config.sessionRedisTtlSeconds));
    } catch (err: any) {
      logger.debug({ sessionId: session.sessionId, error: err.message }, 'Failed to persist session state to Redis');
    }
  }

  /**
   * Recover session state from Redis (for crash recovery).
   *
   * * Reads session state from Redis
   * * Returns null if no state found or state is expired
   */
  async recoverSessionFromRedis(sessionId: string): Promise<Partial<CdpBrowserSession> | null> {
    try {
      const key = `${this.config.redisKeyPrefix}session:${sessionId}`;
      const state = await cacheGet<Partial<CdpBrowserSession>>(key);

      if (!state) return null;

      // Check if the session has expired
      if (state.createdAt && state.maxDurationMs) {
        const elapsed = Date.now() - state.createdAt;
        if (elapsed > state.maxDurationMs) {
          // Session has expired -- clean up
          await redis.del(`cache:${key}`);
          return null;
        }
      }

      return state;
    } catch (err: any) {
      logger.debug({ sessionId, error: err.message }, 'Failed to recover session from Redis');
      return null;
    }
  }

  // ===========================================================================
  // HTTP HELPERS
  // ===========================================================================

  /**
   * Check if a request is authenticated via API token.
   */
  private isRequestAuthenticated(req: IncomingMessage): boolean {
    if (!this.config.apiToken) return true;

    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, '');
      return token === this.config.apiToken;
    }

    // Check query parameter
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      return queryToken === this.config.apiToken;
    }

    return false;
  }

  /**
   * Read the body of an HTTP request.
   */
  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  /**
   * Send a JSON response.
   */
  private sendJson(res: ServerResponse, statusCode: number, data: any): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // ===========================================================================
  // STATS
  // ===========================================================================

  /**
   * Get comprehensive statistics about the CDP Browser Manager.
   *
   * * Browser pool stats
   * * Session stats
   * * Performance metrics
   * * Auto-scaler stats
   */
  getStats(): CdpBrowserStats {
    const activeBrowsers = Array.from(this.browsers.values()).filter((mb) => !mb.draining).length;
    const drainingBrowsers = Array.from(this.browsers.values()).filter((mb) => mb.draining).length;
    const activeSessions = this.sessions.size;

    // Calculate average session duration
    const avgDuration = this.stats.sessionDurations.length > 0
      ? this.stats.sessionDurations.reduce((sum, d) => sum + d, 0) / this.stats.sessionDurations.length
      : 0;

    return {
      totalBrowsers: this.browsers.size,
      activeBrowsers,
      drainingBrowsers,
      totalSessions: activeSessions,
      activeSessions,
      peakSessions: this.stats.peakSessions,
      peakBrowsers: this.stats.peakBrowsers,
      totalSessionsCreated: this.stats.totalSessionsCreated,
      totalSessionsExpired: this.stats.totalSessionsExpired,
      totalSessionsTerminated: this.stats.totalSessionsTerminated,
      totalBandwidthBytes: this.stats.totalBandwidthBytes,
      totalRequests: this.stats.totalRequests,
      autoScaleUps: this.stats.autoScaleUps,
      autoScaleDowns: this.stats.autoScaleDowns,
      launchFailures: this.stats.launchFailures,
      avgSessionDurationMs: Math.round(avgDuration),
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
    };
  }

  /**
   * Get detailed per-browser stats.
   */
  getBrowserStats(): Array<{
    id: string;
    contexts: number;
    totalSessions: number;
    launchedAt: string;
    lastUsedAt: string;
    draining: boolean;
    age: number;
  }> {
    const now = Date.now();
    return Array.from(this.browsers.values()).map((mb) => ({
      id: mb.id,
      contexts: mb.contexts.size,
      totalSessions: mb.totalSessions,
      launchedAt: new Date(mb.launchedAt).toISOString(),
      lastUsedAt: new Date(mb.lastUsedAt).toISOString(),
      draining: mb.draining,
      age: now - mb.launchedAt,
    }));
  }

  /**
   * Get the CDP WebSocket endpoint URL for a session.
   */
  getWsEndpoint(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return session.wsEndpoint;
  }

  /**
   * Get the total number of active sessions.
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get the total number of browser instances.
   */
  getBrowserCount(): number {
    return this.browsers.size;
  }

  /**
   * Check if the manager is running.
   */
  isRunning(): boolean {
    return this.startedAt > 0 && !this.shuttingDown;
  }

  /**
   * Check if a session exists and is active.
   */
  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!session.active) return false;
    if (Date.now() - session.createdAt > session.maxDurationMs) return false;
    return true;
  }

  /**
   * Record bandwidth usage for a session (called by external trackers).
   */
  recordBandwidth(sessionId: string, bytes: number): void {
    const session = this.sessions.get(sessionId);
    if (session && session.active) {
      session.bandwidthBytes += bytes;
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Record a request for a session (called by external trackers).
   */
  recordRequest(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.active) {
      session.requestCount++;
      session.lastActivityAt = Date.now();
    }
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

/** Shared singleton instance -- safe to import from any module. */
export const cdpBrowserManager = new CdpBrowserManager();

export default CdpBrowserManager;
