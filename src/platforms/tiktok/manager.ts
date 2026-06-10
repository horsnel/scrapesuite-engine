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
   * Prepare a complete TikTok scraping session.
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

    return { device: profile, registration, msToken, headers, cookies };
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
