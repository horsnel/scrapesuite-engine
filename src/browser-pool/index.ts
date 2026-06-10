import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { stealthEngine } from '../anti-bot/stealth';
import { humanBehavior } from '../anti-bot/human-behavior';

const logger = createChildLogger('browser-pool');

// --- Types --------------------------------------------------------------------

interface PooledBrowser {
  id: string;
  browser: Browser;
  contexts: Map<string, BrowserContext>;
  createdAt: number;
  lastUsed: number;
  requestCount: number;
  isIdle: boolean;
  maxContexts: number;
}

export interface BrowserLease {
  id: string;
  browserId: string;
  context: BrowserContext;
  page: Page;
  profile: ReturnType<typeof stealthEngine.getRandomProfile>;
  released: boolean;
}

interface PoolConfig {
  minBrowsers: number;
  maxBrowsers: number;
  maxContextsPerBrowser: number;
  idleTimeoutMs: number;
  maxRequestsPerBrowser: number;  // Max requests before recycling a browser
  launchTimeoutMs: number;
}

// --- Defaults -----------------------------------------------------------------

const DEFAULT_CONFIG: PoolConfig = {
  minBrowsers: 1,
  maxBrowsers: parseInt(process.env.BROWSER_POOL_MAX || '5', 10),
  maxContextsPerBrowser: parseInt(process.env.BROWSER_MAX_CONTEXTS || '10', 10),
  idleTimeoutMs: 5 * 60 * 1000,
  maxRequestsPerBrowser: parseInt(process.env.BROWSER_MAX_REQUESTS || '200', 10),
  launchTimeoutMs: 30_000,
};

// --- Browser Pool Manager -----------------------------------------------------

export class BrowserPool {
  private pool = new Map<string, PooledBrowser>();
  private config: PoolConfig;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private waitingQueue: Array<{
    resolve: (lease: BrowserLease) => void;
    reject: (error: Error) => void;
  }> = [];
  private activeLeases = new Map<string, BrowserLease>();
  private stats = {
    totalAcquires: 0,
    totalReleases: 0,
    totalLaunches: 0,
    totalRecycles: 0,
    totalTimeouts: 0,
    peakPoolSize: 0,
  };

  constructor(config?: Partial<PoolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- Public API ------------------------------------------------------------

  async initialize(): Promise<void> {
    logger.info(
      { minBrowsers: this.config.minBrowsers, maxBrowsers: this.config.maxBrowsers },
      'Initializing browser pool',
    );

    for (let i = 0; i < this.config.minBrowsers; i++) {
      try {
        await this.launchBrowser();
      } catch (err: any) {
        logger.error({ error: err.message }, 'Failed to launch initial browser');
      }
    }

    this.maintenanceTimer = setInterval(() => this.maintain(), 60_000);
  }

  async acquire(proxyUrl?: string, stealthMode: boolean = false): Promise<BrowserLease> {
    this.stats.totalAcquires++;

    const pooled = this.findAvailableBrowser();
    if (pooled) {
      return this.createLease(pooled, proxyUrl, stealthMode);
    }

    if (this.pool.size < this.config.maxBrowsers) {
      try {
        const newBrowser = await this.launchBrowser(proxyUrl);
        return this.createLease(newBrowser, proxyUrl, stealthMode);
      } catch (err: any) {
        logger.error({ error: err.message }, 'Failed to launch new browser for acquire');
      }
    }

    logger.info({ queueSize: this.waitingQueue.length }, 'All browsers busy, queuing request');

    return new Promise<BrowserLease>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.waitingQueue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waitingQueue.splice(idx, 1);
        this.stats.totalTimeouts++;
        reject(new Error('Browser pool acquire timeout -- all browsers busy'));
      }, this.config.launchTimeoutMs);

      const originalResolve = resolve;
      const originalReject = reject;

      this.waitingQueue.push({
        resolve: (lease) => {
          clearTimeout(timeout);
          originalResolve(lease);
        },
        reject: (error) => {
          clearTimeout(timeout);
          originalReject(error);
        },
      });
    });
  }

  async release(lease: BrowserLease): Promise<void> {
    if (lease.released) return;
    lease.released = true;
    this.stats.totalReleases++;

    try { await lease.page.close({ runBeforeUnload: false }); } catch {}
    try { await lease.context.close(); } catch {}

    this.activeLeases.delete(lease.id);

    const pooled = this.pool.get(lease.browserId);
    if (pooled) {
      pooled.contexts.delete(lease.id);
      pooled.isIdle = pooled.contexts.size === 0;
      pooled.lastUsed = Date.now();
    }

    if (this.waitingQueue.length > 0) {
      const next = this.waitingQueue.shift()!;
      try {
        const availableBrowser = this.findAvailableBrowser();
        if (availableBrowser) {
          const newLease = await this.createLease(availableBrowser, undefined, false);
          next.resolve(newLease);
        } else {
          this.waitingQueue.unshift(next);
        }
      } catch (err) {
        next.reject(err as Error);
      }
    }
  }

  getStats() {
    const browsers = Array.from(this.pool.values());
    return {
      poolSize: this.pool.size,
      activeLeases: this.activeLeases.size,
      idleBrowsers: browsers.filter((b) => b.isIdle).length,
      waitingRequests: this.waitingQueue.length,
      totalContexts: browsers.reduce((sum, b) => sum + b.contexts.size, 0),
      ...this.stats,
    };
  }

  async shutdown(): Promise<void> {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    for (const waiter of this.waitingQueue) {
      waiter.reject(new Error('Browser pool shutting down'));
    }
    this.waitingQueue = [];

    for (const lease of this.activeLeases.values()) {
      try { await this.release(lease); } catch {}
    }

    const closePromises = Array.from(this.pool.values()).map(async (pooled) => {
      try { await pooled.browser.close(); } catch {}
    });

    await Promise.all(closePromises);
    this.pool.clear();
    logger.info('Browser pool shutdown complete');
  }

  // --- Private Methods --------------------------------------------------------

  private async launchBrowser(proxyUrl?: string): Promise<PooledBrowser> {
    const id = `browser-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const launchOptions: import('playwright').LaunchOptions = {
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-infobars', '--window-size=1920,1080',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--no-first-run', '--no-default-browser-check',
        '--disable-component-update', '--disable-client-side-phishing-detection',
        '--disable-default-apps', '--disable-hang-monitor',
        '--disable-popup-blocking', '--disable-prompt-on-repost',
        '--disable-sync', '--metrics-recording-only',
        '--safebrowsing-disable-auto-update',
      ],
    };

    if (proxyUrl) launchOptions.proxy = { server: proxyUrl };

    const browser = await chromium.launch(launchOptions);
    this.stats.totalLaunches++;

    const pooled: PooledBrowser = {
      id,
      browser,
      contexts: new Map(),
      createdAt: Date.now(),
      lastUsed: Date.now(),
      requestCount: 0,
      isIdle: true,
      maxContexts: this.config.maxContextsPerBrowser,
    };

    this.pool.set(id, pooled);
    this.stats.peakPoolSize = Math.max(this.stats.peakPoolSize, this.pool.size);

    logger.info(
      { browserId: id, poolSize: this.pool.size, proxy: !!proxyUrl },
      'Browser launched and added to pool',
    );

    return pooled;
  }

  private findAvailableBrowser(): PooledBrowser | null {
    for (const pooled of this.pool.values()) {
      if (pooled.contexts.size < pooled.maxContexts && !this.shouldRecycle(pooled)) {
        return pooled;
      }
    }
    return null;
  }

  private async createLease(
    pooled: PooledBrowser,
    proxyUrl?: string,
    stealthMode: boolean = false,
  ): Promise<BrowserLease> {
    const leaseId = `lease-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const profile = stealthEngine.getRandomProfile();

    const contextOptions = stealthEngine.getContextOptions(profile);

    const context = await pooled.browser.newContext({
      ...contextOptions,
      ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    });

    if (stealthMode) {
      await context.addInitScript(stealthEngine.getStealthInitScript(profile));
      // Inject human behavior simulation for anti-bot evasion
      await context.addInitScript(humanBehavior.getBehaviorInitScript());
    } else {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        const w = globalThis as any;
        delete w.__playwright;
        delete w.__pw_manual;
        delete w.__PW_inspect;
      });
    }

    const page = await context.newPage();

    await page.route(
      '**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,eot,mp4,mp3,avi,mov,wmv}',
      (route) => route.abort(),
    );

    pooled.contexts.set(leaseId, context);
    pooled.isIdle = false;
    pooled.requestCount++;
    pooled.lastUsed = Date.now();

    const lease: BrowserLease = {
      id: leaseId,
      browserId: pooled.id,
      context,
      page,
      profile,
      released: false,
    };

    this.activeLeases.set(leaseId, lease);
    return lease;
  }

  private shouldRecycle(pooled: PooledBrowser): boolean {
    return pooled.requestCount >= this.config.maxRequestsPerBrowser;
  }

  private async maintain(): Promise<void> {
    const now = Date.now();
    const toRecycle: PooledBrowser[] = [];
    const toClose: PooledBrowser[] = [];

    for (const pooled of this.pool.values()) {
      if (this.shouldRecycle(pooled) && pooled.contexts.size === 0) {
        toRecycle.push(pooled);
        continue;
      }

      if (
        pooled.isIdle &&
        now - pooled.lastUsed > this.config.idleTimeoutMs &&
        this.pool.size - toClose.length > this.config.minBrowsers
      ) {
        toClose.push(pooled);
      }
    }

    for (const pooled of toRecycle) {
      try {
        await pooled.browser.close();
        this.pool.delete(pooled.id);
        this.stats.totalRecycles++;
        if (this.pool.size < this.config.minBrowsers) {
          await this.launchBrowser();
        }
      } catch (err: any) {
        logger.error({ browserId: pooled.id, error: err.message }, 'Failed to recycle browser');
      }
    }

    for (const pooled of toClose) {
      try {
        await pooled.browser.close();
        this.pool.delete(pooled.id);
        logger.info({ browserId: pooled.id }, 'Closed idle browser');
      } catch (err: any) {
        logger.error({ browserId: pooled.id, error: err.message }, 'Failed to close idle browser');
      }
    }
  }
}

export const browserPool = new BrowserPool();
