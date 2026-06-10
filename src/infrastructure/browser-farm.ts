/**
 * Browser Farm — ScrapeSuite Engine
 *
 * Manages a pool of pre-warmed browser instances with realistic browsing
 * histories, authenticated sessions, and full stealth configurations.
 *
 * For Netflix/Google, browser warm-up is critical because both check:
 * - How long the browser has been open (session age)
 * - Navigation history (browsing patterns before target site)
 * - Cookie state (existing cookies from previous visits)
 * - Resource loading behavior (images, fonts, analytics)
 * - JavaScript execution patterns (setTimeout/setInterval signatures)
 *
 * Architecture:
 * - Pre-warm pool of browsers with realistic histories
 * - Domain-specific browser assignment (Netflix browser, Google browser)
 * - Auto-recycling after N requests to prevent fingerprint drift
 * - Crash recovery with automatic replacement
 * - Memory monitoring and OOM protection
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type {
  BrowserInstance, BrowserInstanceStatus, BrowserType, StealthLevel,
  BrowserFarmConfig, BrowserAllocationRequest, BrowserAllocationResult,
} from './types';

const logger = createChildLogger('browser-farm');

const INSTANCE_PREFIX = 'infra:browser:instance:';
const ALLOCATION_PREFIX = 'infra:browser:allocation:';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_BROWSER_FARM_CONFIG: BrowserFarmConfig = {
  minPoolSize: 20,
  maxPoolSize: 200,
  browserDistribution: { chromium: 0.7, firefox: 0.2, webkit: 0.1 },
  defaultStealthLevel: 'high',
  maxRequestsPerInstance: 50,
  warmUpDuration: 30, // 30 seconds of realistic browsing
  warmUpTargets: [
    'https://www.wikipedia.org',
    'https://news.ycombinator.com',
    'https://www.reddit.com',
    'https://www.amazon.com',
    'https://www.youtube.com',
    'https://www.nytimes.com',
    'https://weather.com',
    'https://www.bbc.com',
  ],
  memoryLimitMB: 512,
  scaleUpThreshold: 0.8, // 80% utilization
  scaleDownThreshold: 0.3, // 30% utilization
  maxCrashCount: 3,
  headless: 'new',
  preWarm: true,
  preWarmCount: 10,
};

// ===============================================================================
// WARM-UP BROWSING PATTERNS
// ===============================================================================

/** Realistic navigation sequences for browser warm-up. */
const WARM_UP_SEQUENCES = [
  // Casual browsing
  ['https://www.wikipedia.org', 'https://en.wikipedia.org/wiki/Main_Page', 'https://news.ycombinator.com'],
  // Shopping intent
  ['https://www.amazon.com', 'https://www.amazon.com/bestsellers', 'https://www.amazon.com/gp/new-releases'],
  // News reader
  ['https://www.bbc.com', 'https://www.bbc.com/news', 'https://www.nytimes.com', 'https://www.nytimes.com/section/world'],
  // Entertainment
  ['https://www.youtube.com', 'https://www.youtube.com/feed/trending', 'https://www.reddit.com/r/all'],
  // Research
  ['https://www.wikipedia.org', 'https://scholar.google.com', 'https://stackoverflow.com'],
  // Social media warm-up (critical for fingerprint realism)
  ['https://www.facebook.com', 'https://twitter.com', 'https://www.instagram.com'],
  // Direct Netflix warm-up approach (via Google)
  ['https://www.google.com', 'https://www.google.com/search?q=best+movies+2024', 'https://www.netflix.com'],
  // Direct Google warm-up
  ['https://www.google.com', 'https://mail.google.com', 'https://www.google.com/maps'],
];

// ===============================================================================
// BROWSER FARM MANAGER
// ===============================================================================

export class BrowserFarmManager {
  private config: BrowserFarmConfig;
  private instances: Map<string, BrowserInstance> = new Map();
  private allocations: Map<string, string> = new Map(); // allocationId -> instanceId
  private warmUpQueue: string[] = [];
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(config?: Partial<BrowserFarmConfig>) {
    this.config = { ...DEFAULT_BROWSER_FARM_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Browser Farm Manager');

    if (this.config.preWarm) {
      await this.preWarmInstances(this.config.preWarmCount);
    }

    this.startHealthMonitoring();
    logger.info({ instanceCount: this.instances.size }, 'Browser Farm initialized');
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);

    // Close all browser instances
    for (const instance of this.instances.values()) {
      try {
        if (instance.browser) {
          await instance.browser.close();
        }
      } catch (err) {
        logger.debug({ instanceId: instance.id }, 'Error closing browser instance');
      }
    }

    logger.info('Browser Farm Manager shut down');
  }

  // ---------- Instance Management ----------------------------------------------

  /** Create a new browser instance. */
  async createInstance(request?: Partial<BrowserAllocationRequest>): Promise<BrowserInstance> {
    const browserType = request?.browserType || this.selectBrowserType();
    const stealthLevel = request?.stealthLevel || this.config.defaultStealthLevel;
    const id = createHash('sha256')
      .update(`browser:${browserType}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .substring(0, 16);

    const instance: BrowserInstance = {
      id,
      browserType,
      status: 'warming',
      stealthLevel,
      requestCount: 0,
      maxRequests: this.config.maxRequestsPerInstance,
      crashCount: 0,
      memoryUsage: 0,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      browsingHistory: [],
      hasCookies: false,
      authenticatedDomains: [],
      cpuUsage: 0,
      bytesSent: 0,
      bytesReceived: 0,
    };

    this.instances.set(id, instance);

    // Start warm-up in background
    this.warmUpInstance(id, request);

    logger.info({ instanceId: id, browserType, stealthLevel }, 'Browser instance created');
    return instance;
  }

  /** Pre-warm a specified number of instances. */
  async preWarmInstances(count: number): Promise<void> {
    logger.info({ count }, 'Pre-warming browser instances');
    const promises: Promise<void>[] = [];

    for (let i = 0; i < count; i++) {
      const instance = await this.createInstance();
      // Warm-up is started in background by createInstance
      promises.push(this.waitForWarmUp(instance.id));
    }

    await Promise.allSettled(promises);
    logger.info('Pre-warming complete');
  }

  // ---------- Allocation -------------------------------------------------------

  /** Allocate a browser for use. */
  async allocateBrowser(request: BrowserAllocationRequest): Promise<BrowserAllocationResult | null> {
    // Find a ready instance matching criteria
    const candidates = Array.from(this.instances.values()).filter(inst => {
      if (inst.status !== 'ready') return false;
      if (request.browserType && inst.browserType !== request.browserType) return false;
      if (request.stealthLevel && inst.stealthLevel !== request.stealthLevel) return false;
      if (request.requiresAuth && inst.authenticatedDomains.length === 0) return false;
      if (request.domain && !inst.authenticatedDomains.includes(request.domain)) {
        // Prefer instances already authenticated on this domain, but don't require it
      }
      return true;
    });

    let instance: BrowserInstance;

    if (candidates.length === 0) {
      // Create a new instance if under max pool size
      if (this.instances.size < this.config.maxPoolSize) {
        instance = await this.createInstance(request);
        await this.waitForWarmUp(instance.id);
      } else {
        logger.warn('Browser pool exhausted and at maximum size');
        return null;
      }
    } else {
      // Prefer instance already authenticated for domain
      if (request.domain) {
        const domainMatch = candidates.find(c => c.authenticatedDomains.includes(request.domain!));
        instance = domainMatch || candidates[0];
      } else {
        instance = candidates[0];
      }
    }

    instance.status = 'busy';
    instance.lastUsed = Date.now();

    const allocationId = createHash('sha256')
      .update(`alloc:${instance.id}:${Date.now()}`)
      .digest('hex')
      .substring(0, 16);

    this.allocations.set(allocationId, instance.id);

    logger.debug({
      allocationId,
      instanceId: instance.id,
      browserType: instance.browserType,
      stealthLevel: instance.stealthLevel,
    }, 'Browser allocated');

    return { instance, allocationId };
  }

  /** Release a browser back to the pool. */
  async releaseBrowser(allocationId: string, success: boolean): Promise<void> {
    const instanceId = this.allocations.get(allocationId);
    if (!instanceId) return;

    const instance = this.instances.get(instanceId);
    if (!instance) return;

    instance.requestCount++;
    this.allocations.delete(allocationId);

    if (!success) {
      instance.crashCount++;
    }

    // Check if instance should be recycled
    if (instance.requestCount >= instance.maxRequests || instance.crashCount >= this.config.maxCrashCount) {
      await this.recycleInstance(instanceId);
      return;
    }

    // Return to ready state
    instance.status = 'ready';
    instance.lastUsed = Date.now();
  }

  /** Get an instance by ID. */
  getInstance(id: string): BrowserInstance | undefined {
    return this.instances.get(id);
  }

  // ---------- Recycling --------------------------------------------------------

  /** Recycle a browser instance (close and create replacement). */
  async recycleInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    logger.info({ instanceId, requestCount: instance.requestCount, crashCount: instance.crashCount }, 'Recycling browser instance');

    try {
      if (instance.browser) {
        await instance.browser.close();
      }
    } catch (err) {
      logger.debug({ instanceId }, 'Error closing browser during recycle');
    }

    this.instances.delete(instanceId);

    // Create replacement if below minimum pool size
    const readyCount = Array.from(this.instances.values()).filter(i => i.status === 'ready').length;
    if (readyCount < this.config.minPoolSize) {
      await this.createInstance();
    }
  }

  // ---------- Statistics -------------------------------------------------------

  getStats(): {
    total: number;
    byStatus: Record<BrowserInstanceStatus, number>;
    byType: Record<BrowserType, number>;
    byStealthLevel: Record<StealthLevel, number>;
    avgMemoryMB: number;
    totalCrashes: number;
    readyCount: number;
  } {
    const byStatus: Record<BrowserInstanceStatus, number> = {
      warming: 0, ready: 0, busy: 0, recycling: 0, crashed: 0, retired: 0,
    };
    const byType: Record<BrowserType, number> = { chromium: 0, firefox: 0, webkit: 0 };
    const byStealthLevel: Record<StealthLevel, number> = { basic: 0, light: 0, medium: 0, high: 0, maximum: 0 };
    let totalMemory = 0;
    let totalCrashes = 0;
    let readyCount = 0;

    for (const inst of this.instances.values()) {
      byStatus[inst.status]++;
      byType[inst.browserType]++;
      byStealthLevel[inst.stealthLevel]++;
      totalMemory += inst.memoryUsage;
      totalCrashes += inst.crashCount;
      if (inst.status === 'ready') readyCount++;
    }

    return {
      total: this.instances.size,
      byStatus,
      byType,
      byStealthLevel,
      avgMemoryMB: this.instances.size > 0 ? Math.round(totalMemory / this.instances.size) : 0,
      totalCrashes,
      readyCount,
    };
  }

  // ---------- Private Helpers --------------------------------------------------

  private selectBrowserType(): BrowserType {
    const rand = Math.random();
    const dist = this.config.browserDistribution;
    if (rand < dist.chromium) return 'chromium';
    if (rand < dist.chromium + dist.firefox) return 'firefox';
    return 'webkit';
  }

  private async warmUpInstance(instanceId: string, request?: Partial<BrowserAllocationRequest>): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    try {
      // Select a warm-up sequence
      const sequence = WARM_UP_SEQUENCES[Math.floor(Math.random() * WARM_UP_SEQUENCES.length)];

      // In production, this would actually launch Playwright and navigate
      // For engine mode, we simulate the warm-up state
      instance.browsingHistory = [...sequence];
      instance.hasCookies = true; // Warm-up generates cookies
      instance.status = 'ready';
      instance.warmedUpAt = Date.now();

      logger.debug({ instanceId, historyCount: sequence.length }, 'Browser warm-up complete');
    } catch (err) {
      logger.error({ instanceId, error: String(err) }, 'Browser warm-up failed');
      instance.status = 'crashed';
      instance.crashCount++;
    }
  }

  private async waitForWarmUp(instanceId: string): Promise<void> {
    const maxWait = this.config.warmUpDuration * 1000 + 5000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const instance = this.instances.get(instanceId);
      if (instance && instance.status === 'ready') return;
      if (instance && instance.status === 'crashed') return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    logger.warn({ instanceId }, 'Browser warm-up timed out');
  }

  private startHealthMonitoring(): void {
    this.healthCheckTimer = setInterval(() => {
      this.checkInstanceHealth();
    }, 30000); // Every 30 seconds
  }

  private async checkInstanceHealth(): Promise<void> {
    for (const [id, instance] of this.instances) {
      // Check for stale instances (ready but unused for 30+ minutes)
      if (instance.status === 'ready' && Date.now() - instance.lastUsed > 1800000) {
        logger.debug({ instanceId: id }, 'Recycling stale browser instance');
        await this.recycleInstance(id);
        continue;
      }

      // Check for crashed instances
      if (instance.status === 'crashed') {
        if (instance.crashCount < this.config.maxCrashCount) {
          await this.recycleInstance(id);
          await this.createInstance();
        }
      }

      // Memory check (would use actual process.memoryUsage() in production)
      if (instance.memoryUsage > this.config.memoryLimitMB) {
        logger.warn({ instanceId: id, memoryMB: instance.memoryUsage }, 'Browser instance exceeding memory limit');
        await this.recycleInstance(id);
      }
    }

    // Auto-scale
    const readyCount = Array.from(this.instances.values()).filter(i => i.status === 'ready').length;
    const busyCount = Array.from(this.instances.values()).filter(i => i.status === 'busy').length;
    const utilization = this.instances.size > 0 ? busyCount / this.instances.size : 0;

    if (utilization > this.config.scaleUpThreshold && this.instances.size < this.config.maxPoolSize) {
      logger.info({ utilization }, 'Scaling up browser pool');
      await this.createInstance();
    } else if (utilization < this.config.scaleDownThreshold && readyCount > this.config.minPoolSize) {
      // Scale down by recycling the oldest ready instance
      const oldestReady = Array.from(this.instances.values())
        .filter(i => i.status === 'ready')
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldestReady) {
        await this.recycleInstance(oldestReady.id);
      }
    }
  }
}

/** Singleton instance. */
export const browserFarmManager = new BrowserFarmManager();
