/**
 * TikTok Platform Manager -- ScrapeSuite Engine
 *
 * Orchestrates all TikTok anti-bot counter-measures:
 *   - X-Bogus signature generation
 *   - msToken rotation
 *   - Device registration
 *   - Feed simulation
 *   - Unified request signing
 */

import { createChildLogger } from '../../utils/logger';
import { XBogusSignerEngine, xbogusSigner } from './xbogus-signer';
import { MsTokenRotatorEngine, msTokenRotator } from './mstoken-rotator';
import { DeviceRegistrarEngine, deviceRegistrar } from './device-registrar';
import { TikTokSignatureEngine, tiktokSignatureEngine } from './signature-engine';
import { FeedSimulatorEngine, feedSimulator } from './feed-simulator';
import { tiktokBrowserHarvester } from './browser-harvester';
import type { TikTokBrowserSession } from './browser-harvester';
import { depositSession, lendSession, reportSessionOutcome } from './session-farm';
import {
  DEFAULT_TIKTOK_CONFIG,
} from './types';
import type {
  TikTokManagerConfig,
  TikTokManagerStats,
  TikTokDeviceType,
  TikTokDeviceProfile,
  SignatureRequest,
  SignatureResult,
  DeviceRegistrationResult,
  FeedSimulationResult,
} from './types';

const logger = createChildLogger('tiktok-manager');

// ===============================================================================
// TIKTOK PLATFORM MANAGER
// ===============================================================================

export class TikTokManager {
  private config: TikTokManagerConfig;
  private signatureEngine: TikTokSignatureEngine;
  private msTokenRotator: MsTokenRotatorEngine;
  private deviceRegistrar: DeviceRegistrarEngine;
  private feedSimulator: FeedSimulatorEngine;
  private initialized = false;
  private harvestedSession: TikTokBrowserSession | null = null;
  /** Farm id of the session currently borrowed via prepareSession(), if any. */
  private currentFarmSessionId: string | null = null;
  private stats: TikTokManagerStats = {
    totalSignatures: 0,
    totalMsTokenRotations: 0,
    totalDeviceRegistrations: 0,
    totalFeedSimulations: 0,
    activeDevices: 0,
    signatureSuccessRate: 1.0,
    avgSignatureTimeMs: 0,
    msTokenPoolSize: 0,
    detectionEncounters: 0,
  };

  constructor(config?: Partial<TikTokManagerConfig>) {
    this.config = { ...DEFAULT_TIKTOK_CONFIG, ...config };
    this.signatureEngine = tiktokSignatureEngine;
    this.msTokenRotator = msTokenRotator;
    this.deviceRegistrar = deviceRegistrar;
    this.feedSimulator = feedSimulator;
  }

  /**
   * Initialize the TikTok manager.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing TikTok Platform Manager...');

    // Initialize signature engine (which initializes msToken rotator)
    await this.signatureEngine.initialize();

    // Pre-generate device pool
    const devices = this.deviceRegistrar.generatePool(
      this.config.devicePoolSize,
      this.config.preferredDeviceType,
      this.config.region,
    );

    // Register devices
    for (const device of devices) {
      const msToken = this.msTokenRotator.getActiveToken().token;
      await this.deviceRegistrar.register({
        device,
        msToken,
        verify: true,
      });
    }

    this.stats.activeDevices = devices.length;
    this.stats.msTokenPoolSize = this.config.devicePoolSize;
    this.initialized = true;

    logger.info({
      devicePoolSize: devices.length,
      preferredDeviceType: this.config.preferredDeviceType,
    }, 'TikTok Platform Manager initialized');
  }

  /**
   * Sign a TikTok API request with all required signatures.
   */
  async signRequest(request: SignatureRequest): Promise<SignatureResult> {
    const result = await this.signatureEngine.sign(request);
    this.stats.totalSignatures++;
    this.stats.avgSignatureTimeMs = result.generationTimeMs;
    return result;
  }

  /**
   * Quick-sign a URL with X-Bogus and msToken.
   */
  async quickSign(url: string, deviceType?: TikTokDeviceType): Promise<SignatureResult> {
    return this.signatureEngine.quickSign(url, deviceType || this.config.preferredDeviceType);
  }

  /**
   * Get a fresh msToken.
   */
  getMsToken(): string {
    return this.msTokenRotator.getActiveToken().token;
  }

  /**
   * Rotate the current msToken.
   */
  rotateMsToken(): string {
    this.stats.totalMsTokenRotations++;
    return this.msTokenRotator.rotate().token;
  }

  /**
   * Get a registered device profile.
   */
  async getDevice(deviceId?: string): Promise<{
    profile: TikTokDeviceProfile | null;
    registration: DeviceRegistrationResult | null;
  }> {
    if (deviceId) {
      const profile = null; // Would look up from pool
      const registration = await this.deviceRegistrar.getRegisteredDevice(deviceId);
      return { profile, registration };
    }

    // Return random registered device
    const registration = this.deviceRegistrar.getRandomRegisteredDevice();
    return { profile: null, registration };
  }

  /**
   * Rotate to a new device identity.
   */
  async rotateDevice(type?: TikTokDeviceType): Promise<{
    profile: TikTokDeviceProfile;
    registration: DeviceRegistrationResult;
  }> {
    this.stats.totalDeviceRegistrations++;
    return this.deviceRegistrar.rotateDevice(type || this.config.preferredDeviceType, this.config.region);
  }

  /**
   * Generate a feed simulation session.
   */
  simulateFeed(): FeedSimulationResult {
    this.stats.totalFeedSimulations++;
    return this.feedSimulator.generateSession();
  }

  /**
   * Record a detection encounter for learning.
   */
  recordDetection(type: string): void {
    this.stats.detectionEncounters++;
    this.stats.lastDetectionAt = Date.now();
    logger.warn({ type, totalEncounters: this.stats.detectionEncounters }, 'TikTok detection encounter recorded');
  }

  /**
   * Import a REAL browser session harvested by TikTokBrowserHarvester
   * (or supplied from an external browser-automation pipeline).
   *
   * The harvested msToken is seeded into the rotator as the active token,
   * and the full cookie jar + exact browser UA are stored. prepareSession()
   * then merges them into every session: cookies restore the browser's
   * credibility state, and the browser's UA is used for signing because
   * X-Bogus is UA-bound — a signed request with a different UA is
   * detectable on sight.
   *
   * @param session - Harvested session payload
   * @throws Error if the session lacks the minimum credible fields
   */
  importBrowserSession(session: TikTokBrowserSession): void {
    const check = tiktokBrowserHarvester.validateSession(session);
    if (!check.valid) {
      throw new Error(`Cannot import TikTok browser session: ${check.reason}`);
    }

    const msToken =
      session.cookies['msToken'] || session.observedMsTokens[0];
    if (msToken) {
      this.msTokenRotator.seedFromExternal(msToken, 'browser');
    }

    this.harvestedSession = session;
    this.currentFarmSessionId = null;

    // Also bank the session into the farm (fire-and-forget) so other
    // workers/processes can lend it later.
    void depositSession(session).catch(() => {});

    logger.info(
      {
        cookieNames: Object.keys(session.cookies),
        hasUniversalData: !!session.universalData,
        observedMsTokens: session.observedMsTokens.length,
        harvestedAt: new Date(session.harvestedAt).toISOString(),
      },
      'TikTok browser session imported',
    );
  }

  /**
   * Whether a real browser session is currently imported.
   */
  hasBrowserSession(): boolean {
    return this.harvestedSession !== null;
  }

  /**
   * Clear the imported browser session (e.g. after it expires or is burnt).
   */
  clearBrowserSession(): void {
    this.harvestedSession = null;
  }

  /**
   * Prepare a complete TikTok scraping session.
   *
   * When a browser session has been imported, its cookies take precedence
   * over synthetic ones and its exact UA is used for signing.
   */
  async prepareSession(options?: {
    deviceType?: TikTokDeviceType;
    proxyTier?: 'residential' | 'mobile';
  }): Promise<{
    device: TikTokDeviceProfile;
    registration: DeviceRegistrationResult;
    msToken: string;
    headers: Record<string, string>;
    cookies: Record<string, string>;
  }> {
    const { profile, registration } = await this.rotateDevice(options?.deviceType);
    const msToken = this.rotateMsToken();

    const headers: Record<string, string> = {
      'User-Agent': profile.userAgent,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': `${this.config.language}-${this.config.region},${this.config.language};q=0.9`,
      'Referer': 'https://www.tiktok.com/',
      'Origin': 'https://www.tiktok.com',
    };

    const cookies: Record<string, string> = {
      'msToken': msToken,
      'ttwid': registration.ttwid,
      'odin_tt': registration.odin_tt,
    };

    // Merge the real browser session where available: its cookies carry the
    // browser's credibility state, and its UA must win because X-Bogus is
    // computed over the exact UA string.
    //
    // Session farm: when nothing is imported locally, borrow the healthiest
    // farmed session (harvested by any worker) transparently.
    if (!this.harvestedSession) {
      try {
        const lent = await lendSession();
        if (lent) {
          this.harvestedSession = lent.session;
          this.currentFarmSessionId = lent.id;
          if (lent.session.cookies['msToken'] || lent.session.observedMsTokens[0]) {
            this.msTokenRotator.seedFromExternal(
              lent.session.cookies['msToken'] || lent.session.observedMsTokens[0],
              'browser',
            );
          }
          logger.info({ farmSessionId: lent.id }, 'Borrowed browser session from farm');
        }
      } catch {
        // Farm unavailable — synthetic path continues.
      }
    }

    if (this.harvestedSession) {
      Object.assign(cookies, this.harvestedSession.cookies);
      if (this.harvestedSession.cookies['msToken']) {
        cookies['msToken'] = this.harvestedSession.cookies['msToken'];
      }
      headers['User-Agent'] = this.harvestedSession.userAgent;
    }

    return { device: profile, registration, msToken, headers, cookies };
  }

  /**
   * Report the outcome of work done with the current (farmed or imported)
   * browser session. Feeds the farm's health model; fire-and-forget.
   */
  reportSessionOutcome(outcome: 'success' | 'bot_wall' | 'rate_limited' | 'shape_rejected' | 'network_error' | 'timeout', detail?: string): void {
    if (!this.currentFarmSessionId) return;
    void reportSessionOutcome(this.currentFarmSessionId, outcome, detail).catch(() => {});
  }

  /**
   * Get manager statistics.
   */
  getStats(): TikTokManagerStats {
    return { ...this.stats };
  }
}



// ===============================================================================
// SINGLETON
// ===============================================================================

export const tiktokManager = new TikTokManager();
