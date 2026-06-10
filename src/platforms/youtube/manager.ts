/**
 * YouTube Manager — ScrapeSuite Engine
 *
 * Top-level orchestrator for all YouTube anti-bot counter-measures.
 * Coordinates the bot detection evader, watch simulator, and API signer
 * to provide a unified interface for YouTube scraping operations.
 *
 * Key responsibilities:
 *   - Session preparation (device, headers, cookies, tokens)
 *   - Request signing with InnerTube context
 *   - Watch simulation orchestration
 *   - Bot detection evasion with adaptive strategies
 *   - Device pool management and rotation
 *   - Statistics tracking and reporting
 *
 * Usage:
 *   const session = await youtubeManager.prepareSession();
 *   // session contains: device, headers, cookies, sessionIds
 *
 *   const signed = await youtubeManager.signRequest(url, 'POST', body);
 *   // signed contains: headers, cookies, context for the request
 *
 *   const watch = youtubeManager.simulateWatch('dQw4w9WgXcQ', 212);
 *   // watch contains: playhead positions, interactions, playback stats
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import { BotDetectionEvader, botDetectionEvader } from './bot-detection-evader';
import { WatchSimulator, watchSimulator } from './watch-simulator';
import { YouTubeApiSigner, youtubeApiSigner } from './api-signer';
import type {
  YouTubeManagerConfig,
  YouTubeManagerStats,
  YouTubeDeviceProfile,
  YouTubeClientPlatform,
  YouTubeScrapeTarget,
  BotDetectionSignals,
  EvasionStrategy,
  WatchSimulationConfig,
  WatchSimulationResult,
  InnertubeSignResult,
  YouTubeSessionIds,
} from './types';
import { DEFAULT_YOUTUBE_CONFIG } from './types';

const logger = createChildLogger('youtube-manager');

// ===============================================================================
// DEVICE PROFILE GENERATOR
// ===============================================================================

/** Chrome version strings for UA generation */
const CHROME_VERSIONS = [
  '125.0.6422.113', '126.0.6478.55', '126.0.6478.62',
  '127.0.6533.72', '127.0.6533.88', '128.0.6613.84',
  '128.0.6613.113', '129.0.6668.58', '130.0.6723.48', '131.0.6778.70',
];

/** OS strings for User-Agent */
const OS_PROFILES = [
  { os: 'Windows 10', platform: 'Win32', uaPart: 'Windows NT 10.0; Win64; x64', osVersion: '10.0' },
  { os: 'Windows 11', platform: 'Win32', uaPart: 'Windows NT 11.0; Win64; x64', osVersion: '11.0' },
  { os: 'macOS Sonoma', platform: 'MacIntel', uaPart: 'Macintosh; Intel Mac OS X 14_3_1', osVersion: '14.3.1' },
  { os: 'macOS Ventura', platform: 'MacIntel', uaPart: 'Macintosh; Intel Mac OS X 13_5_2', osVersion: '13.5.2' },
  { os: 'Ubuntu Linux', platform: 'Linux x86_64', uaPart: 'X11; Linux x86_64', osVersion: '22.04' },
];

/** Common desktop resolutions */
const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1.25 },
  { width: 2560, height: 1440, dpr: 1 },
  { width: 1366, height: 768, dpr: 1 },
  { width: 1536, height: 864, dpr: 1.25 },
  { width: 1440, height: 900, dpr: 2 },
  { width: 2560, height: 1600, dpr: 2 },
  { width: 3840, height: 2160, dpr: 1 },
];

/** WebGL renderers for fingerprint diversity */
const WEBGL_RENDERERS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)' },
];

/** Timezones commonly found in the US */
const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage',
];

// ===============================================================================
// HELPER FUNCTIONS
// ===============================================================================

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomAlphanumeric(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// ===============================================================================
// YOUTUBE MANAGER CLASS
// ===============================================================================

export class YouTubeManager {
  private config: YouTubeManagerConfig;
  private evader: BotDetectionEvader;
  private simulator: WatchSimulator;
  private signer: YouTubeApiSigner;
  private initialized = false;
  private devicePool: YouTubeDeviceProfile[] = [];
  private currentDeviceIndex = 0;
  private requestCounts = new Map<string, number>();
  private stats: YouTubeManagerStats;
  private cooldownEnd = 0;

  constructor(config?: Partial<YouTubeManagerConfig>) {
    this.config = { ...DEFAULT_YOUTUBE_CONFIG, ...config };
    this.evader = botDetectionEvader;
    this.simulator = watchSimulator;
    this.signer = youtubeApiSigner;
    this.stats = this.createEmptyStats();
  }

  // ---------------------------------------------------------------------------
  // INITIALIZATION
  // ---------------------------------------------------------------------------

  /**
   * Initialize the YouTube manager and all sub-engines.
   *
   * Sets up the device pool, pre-generates session data, and warms
   * up the API signer. Must be called before any other methods.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing YouTube Platform Manager...');

    // Generate device pool
    this.devicePool = this.generateDevicePool(this.config.devicePoolSize);
    logger.info({ devicePoolSize: this.devicePool.length }, 'Device pool generated');

    // Try to load cached state from Redis
    try {
      const cachedStats = await cacheGet<YouTubeManagerStats>('youtube:manager:stats');
      if (cachedStats) {
        this.stats = { ...this.stats, ...cachedStats };
        logger.info('Loaded cached YouTube manager stats');
      }
    } catch {
      logger.debug('No cached YouTube manager stats found');
    }

    this.initialized = true;
    logger.info({
      devicePoolSize: this.devicePool.length,
      defaultPlatform: this.config.defaultPlatform,
      region: this.config.region,
      language: this.config.language,
    }, 'YouTube Platform Manager initialized');
  }

  // ---------------------------------------------------------------------------
  // SESSION PREPARATION
  // ---------------------------------------------------------------------------

  /**
   * Prepare a complete YouTube scraping session.
   *
   * Generates or rotates a device profile, creates realistic headers
   * and cookies, generates session IDs, and returns everything needed
   * to make authenticated YouTube requests.
   *
   * @param options - Optional session configuration
   * @returns Complete session with device, headers, cookies, and tokens
   */
  async prepareSession(options?: {
    platform?: YouTubeClientPlatform;
    target?: YouTubeScrapeTarget;
    proxyTier?: 'residential' | 'mobile' | 'datacenter';
    sapisid?: string;
  }): Promise<{
    device: YouTubeDeviceProfile;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    sessionIds: YouTubeSessionIds;
    signResult: InnertubeSignResult;
  }> {
    this.ensureInitialized();

    // Check cooldown
    const cooldown = this.getRemainingCooldown();
    if (cooldown > 0) {
      logger.warn({ cooldownSeconds: cooldown }, 'In cooldown period, session may be rate-limited');
    }

    // Get or rotate device
    const device = this.getNextDevice(options?.platform);

    // Track request count per device
    const deviceKey = device.userAgent.substring(0, 30);
    const requestCount = (this.requestCounts.get(deviceKey) || 0) + 1;
    this.requestCounts.set(deviceKey, requestCount);

    // Rotate device if it has exceeded max requests
    if (requestCount > this.config.maxRequestsPerDevice) {
      logger.info({ requestCount }, 'Device exceeded max requests, rotating');
      this.rotateDevice();
      return this.prepareSession(options);
    }

    // Build headers using the evader
    const headers = this.evader.buildEvadeHeaders({
      clientName: this.config.apiSigner.defaultClientName,
      clientVersion: this.config.apiSigner.defaultClientVersion,
      referer: `${this.config.apiSigner.origin}/`,
      origin: this.config.apiSigner.origin,
      language: this.config.language,
      region: this.config.region,
    });

    // Build consent cookies using the evader
    const consentCookies = this.evader.buildConsentCookies();

    // Generate visitor data using the evader
    const visitorData = this.evader.generateYouTubeVisitorData();

    // Generate session IDs using the signer
    const sessionIds = this.signer.generateSessionIds();
    sessionIds.visitorData = visitorData.visitorData;
    sessionIds.visitorKey = visitorData.visitorKey;

    // Sign a base request to get the context
    const signResult = await this.signer.signInnertubeRequest({
      endpoint: 'browse',
      method: 'POST',
      sapisid: options?.sapisid,
      visitorData: visitorData.visitorData,
    });

    // Merge cookies
    const cookies: Record<string, string> = {
      ...consentCookies,
      ...signResult.cookies,
      'VISITOR_INFO1_LIVE': visitorData.visitorKey,
    };

    // Update stats
    this.stats.totalSessions++;

    // Cache session data
    try {
      await cacheSet('youtube:last-session', {
        deviceId: device.userAgent.substring(0, 20),
        sessionIds: { visitorKey: sessionIds.visitorKey, cpn: sessionIds.cpn },
        createdAt: Date.now(),
      }, 300);
    } catch {
      // Non-critical
    }

    logger.info({
      platform: device.clientPlatform,
      region: device.region,
      visitorKey: sessionIds.visitorKey.substring(0, 6) + '...',
    }, 'YouTube session prepared');

    return {
      device,
      headers: { ...headers, ...signResult.headers },
      cookies,
      sessionIds,
      signResult,
    };
  }

  // ---------------------------------------------------------------------------
  // REQUEST SIGNING
  // ---------------------------------------------------------------------------

  /**
   * Sign a YouTube API request with InnerTube context and SAPISIDHASH.
   *
   * Takes a URL and optional body, signs the request with all required
   * YouTube authentication parameters, and returns the signed result
   * with headers, cookies, and context object.
   *
   * @param url - The YouTube API URL to sign
   * @param method - HTTP method (GET or POST)
   * @param body - Optional request body for POST requests
   * @returns Signed request details
   */
  async signRequest(
    url: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<InnertubeSignResult> {
    this.ensureInitialized();

    // Extract endpoint from URL
    const endpoint = this.extractEndpoint(url);

    const result = await this.signer.signInnertubeRequest({
      endpoint,
      method,
      body,
    });

    this.stats.totalRequestsSigned++;

    // Track by target if determinable
    const target = this.inferTargetFromUrl(url);
    if (target) {
      this.stats.requestsByTarget[target] = (this.stats.requestsByTarget[target] || 0) + 1;
    }

    logger.debug({
      endpoint,
      method,
      signingTimeMs: result.signingTimeMs.toFixed(2),
    }, 'YouTube request signed');

    return result;
  }

  // ---------------------------------------------------------------------------
  // WATCH SIMULATION
  // ---------------------------------------------------------------------------

  /**
   * Simulate watching a YouTube video.
   *
   * Generates a complete watch simulation including playhead positions,
   * interaction events, and playback statistics. This data can be used
   * to report realistic watch metrics to YouTube's analytics backend.
   *
   * @param videoId - The YouTube video ID
   * @param duration - Video duration in seconds
   * @returns Watch simulation result
   */
  simulateWatch(videoId: string, duration: number): WatchSimulationResult {
    this.ensureInitialized();

    const config: WatchSimulationConfig = {
      videoDuration: duration,
      ...this.config.watchSimulation,
    };

    const result = this.simulator.generateWatchSession(config);

    // Override the generated videoId with the actual one
    const finalResult: WatchSimulationResult = {
      ...result,
      videoId,
    };

    this.stats.totalWatchSimulations++;

    logger.info({
      videoId,
      duration,
      watchPercentage: (result.watchPercentage * 100).toFixed(1) + '%',
      interactions: result.interactions.length,
      appearsHuman: result.appearsHuman,
    }, 'Watch simulation completed');

    return finalResult;
  }

  // ---------------------------------------------------------------------------
  // BOT DETECTION EVASION
  // ---------------------------------------------------------------------------

  /**
   * Evade detected bot signals from a YouTube response.
   *
   * Analyzes the response for bot detection signals, generates an
   * evasion strategy, and applies it. If auto-evade is enabled in
   * the config, this will automatically rotate identities and cookies.
   *
   * @param response - The HTTP response to analyze
   * @returns The evasion strategy that was applied
   */
  evadeDetection(response: {
    status: number;
    headers: Record<string, string>;
    body?: string;
    url?: string;
    responseTimeMs?: number;
  }): { signals: BotDetectionSignals; strategy: EvasionStrategy } {
    this.ensureInitialized();

    // Detect signals
    const signals = this.evader.detectBotSignals(response);

    // Generate strategy
    const strategy = this.evader.generateEvadeStrategy(signals);

    // Update stats
    this.stats.detectionEncounters++;
    this.stats.lastDetectionAt = Date.now();

    if (signals.unusualTrafficPage || signals.captchaDetected || signals.rateLimited) {
      this.stats.totalEvasions++;
    }

    if (signals.captchaDetected) {
      this.stats.totalCaptchasSolved++;
    }

    // Apply evasion if auto-evade is enabled
    if (this.config.autoEvade) {
      this.applyEvasionStrategy(strategy);
    }

    // Update cooldown
    if (strategy.requiresCooldown) {
      this.cooldownEnd = Date.now() + strategy.cooldownDurationSeconds * 1000;
      this.stats.currentCooldownSeconds = strategy.cooldownDurationSeconds;
    }

    // Update evasion success rate
    const totalEvasions = this.stats.totalEvasions;
    if (totalEvasions > 0) {
      this.stats.evasionSuccessRate =
        (this.stats.evasionSuccessRate * (totalEvasions - 1) + (signals.botClassification === 'none' ? 1 : 0)) /
        totalEvasions;
    }

    logger.info({
      classification: signals.botClassification,
      strategy: strategy.description,
      priority: strategy.priority,
      cooldown: strategy.cooldownDurationSeconds,
    }, 'Bot detection evasion applied');

    return { signals, strategy };
  }

  // ---------------------------------------------------------------------------
  // STATISTICS
  // ---------------------------------------------------------------------------

  /**
   * Get YouTube manager statistics.
   *
   * @returns Current statistics snapshot
   */
  getStats(): YouTubeManagerStats {
    return {
      ...this.stats,
      activeDevices: this.devicePool.length,
      currentCooldownSeconds: this.getRemainingCooldown(),
    };
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Ensure the manager has been initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      logger.warn('YouTube manager not initialized, auto-initializing...');
      this.initialize().catch(err => {
        logger.error({ err }, 'Auto-initialization failed');
      });
    }
  }

  /**
   * Create an empty stats object with zeroed values.
   */
  private createEmptyStats(): YouTubeManagerStats {
    return {
      totalSessions: 0,
      totalRequestsSigned: 0,
      totalWatchSimulations: 0,
      totalEvasions: 0,
      totalCaptchasSolved: 0,
      activeDevices: 0,
      avgSigningTimeMs: 0,
      avgWatchSimulationTimeMs: 0,
      detectionEncounters: 0,
      lastDetectionAt: undefined,
      evasionSuccessRate: 1.0,
      currentCooldownSeconds: 0,
      requestsByTarget: {
        video: 0,
        channel: 0,
        search: 0,
        comments: 0,
        playlist: 0,
        trending: 0,
        shorts: 0,
      },
    };
  }

  /**
   * Get remaining cooldown in seconds.
   */
  private getRemainingCooldown(): number {
    if (this.cooldownEnd <= Date.now()) {
      this.stats.currentCooldownSeconds = 0;
      return 0;
    }
    return Math.ceil((this.cooldownEnd - Date.now()) / 1000);
  }

  /**
   * Get the next device profile from the pool.
   * Rotates through the pool sequentially, wrapping around.
   */
  private getNextDevice(platform?: YouTubeClientPlatform): YouTubeDeviceProfile {
    // If a specific platform is requested, find a matching device
    if (platform) {
      const match = this.devicePool.find(d => d.clientPlatform === platform);
      if (match) return match;
      // Generate a new device if none matches
      return this.generateDeviceProfile(platform);
    }

    // Get next device in pool
    const device = this.devicePool[this.currentDeviceIndex];
    this.currentDeviceIndex = (this.currentDeviceIndex + 1) % this.devicePool.length;
    return device;
  }

  /**
   * Rotate to a new device identity.
   */
  private rotateDevice(): void {
    const newDevice = this.generateDeviceProfile(this.config.defaultPlatform);

    // Replace the current device in the pool
    const replaceIndex = this.currentDeviceIndex > 0
      ? this.currentDeviceIndex - 1
      : 0;
    this.devicePool[replaceIndex] = newDevice;

    // Reset request count
    const deviceKey = newDevice.userAgent.substring(0, 30);
    this.requestCounts.set(deviceKey, 0);

    logger.info({
      platform: newDevice.clientPlatform,
      browser: newDevice.browserName,
      os: newDevice.os,
    }, 'Rotated to new device identity');
  }

  /**
   * Apply an evasion strategy.
   */
  private applyEvasionStrategy(strategy: EvasionStrategy): void {
    if (strategy.rotateDevice) {
      this.rotateDevice();
    }

    if (strategy.rotateCookies) {
      // Cookies will be regenerated on next prepareSession call
      logger.info('Cookie rotation scheduled for next session');
    }

    if (strategy.rotateProxy) {
      // Proxy rotation is handled by the proxy manager
      logger.info('Proxy rotation requested');
    }

    logger.info({
      strategy: strategy.description,
      priority: strategy.priority,
    }, 'Evasion strategy applied');
  }

  /**
   * Extract the InnerTube endpoint from a URL.
   */
  private extractEndpoint(url: string): string {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;

      // Match patterns like /youtubei/v1/browse → browse
      const match = path.match(/\/youtubei\/v1\/(.+)$/);
      if (match) return match[1];

      // Match patterns like /api/youtubei/v1/browse → browse
      const apiMatch = path.match(/\/api\/youtubei\/v1\/(.+)$/);
      if (apiMatch) return apiMatch[1];

      // Fallback: use last path segment
      const segments = path.split('/').filter(Boolean);
      return segments[segments.length - 1] || 'browse';
    } catch {
      return 'browse';
    }
  }

  /**
   * Infer the scrape target from a URL.
   */
  private inferTargetFromUrl(url: string): YouTubeScrapeTarget | null {
    const lower = url.toLowerCase();

    if (lower.includes('/watch') || lower.includes('endpoint=player')) return 'video';
    if (lower.includes('/channel/') || lower.includes('/c/') || lower.includes('/@')) return 'channel';
    if (lower.includes('search') || lower.includes('endpoint=search')) return 'search';
    if (lower.includes('comment') || lower.includes('endpoint=comment')) return 'comments';
    if (lower.includes('/playlist') || lower.includes('endpoint=playlist')) return 'playlist';
    if (lower.includes('/feed/trending')) return 'trending';
    if (lower.includes('/shorts/')) return 'shorts';

    return null;
  }

  // ---------------------------------------------------------------------------
  // DEVICE PROFILE GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate a pool of device profiles.
   */
  private generateDevicePool(size: number): YouTubeDeviceProfile[] {
    const pool: YouTubeDeviceProfile[] = [];
    for (let i = 0; i < size; i++) {
      pool.push(this.generateDeviceProfile(this.config.defaultPlatform));
    }
    return pool;
  }

  /**
   * Generate a single device profile with realistic browser fingerprint data.
   */
  private generateDeviceProfile(platform?: YouTubeClientPlatform): YouTubeDeviceProfile {
    const effectivePlatform = platform || this.config.defaultPlatform;
    const osProfile = randomPick(OS_PROFILES);
    const chromeVersion = randomPick(CHROME_VERSIONS);
    const majorVersion = chromeVersion.split('.')[0];
    const resolution = randomPick(SCREEN_RESOLUTIONS);
    const webgl = randomPick(WEBGL_RENDERERS);

    const userAgent = `Mozilla/5.0 (${osProfile.uaPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

    return {
      userAgent,
      screenResolution: resolution,
      platform: osProfile.platform,
      clientPlatform: effectivePlatform,
      browserName: 'Chrome',
      browserVersion: majorVersion,
      os: osProfile.os,
      osVersion: osProfile.osVersion,
      deviceMemory: randomPick([2, 4, 8, 16, 32]),
      hardwareConcurrency: randomPick([2, 4, 6, 8, 12, 16]),
      webglRenderer: webgl.renderer,
      webglVendor: webgl.vendor,
      language: this.config.language,
      region: this.config.region,
      timezone: randomPick(TIMEZONES),
      connectionType: randomPick(['wifi', 'ethernet', '4g', '5g']),
    };
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const youtubeManager = new YouTubeManager();
