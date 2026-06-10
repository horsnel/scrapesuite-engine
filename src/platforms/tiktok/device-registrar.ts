/**
 * TikTok Device Registrar -- ScrapeSuite Engine
 *
 * Manages TikTok device identities for anti-bot bypass.
 * TikTok requires each device to be registered with a unique identity
 * (ttwid, odin_tt, device_id, install_id). This module generates
 * realistic device profiles and manages the registration lifecycle.
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type {
  TikTokDeviceProfile,
  TikTokDeviceType,
  DeviceRegistrationParams,
  DeviceRegistrationResult,
} from './types';

const logger = createChildLogger('tiktok-device-registrar');

// ===============================================================================
// DEVICE PROFILE TEMPLATES
// ===============================================================================

const DEVICE_TEMPLATES: Record<TikTokDeviceType, Partial<TikTokDeviceProfile>[]> = {
  mobile_android: [
    { brand: 'Samsung', model: 'SM-S928B', platform: 'android', osVersion: '14', appVersion: '34.5.5', buildNumber: 340505 },
    { brand: 'Samsung', model: 'SM-S921B', platform: 'android', osVersion: '14', appVersion: '34.5.5', buildNumber: 340505 },
    { brand: 'Google', model: 'Pixel 8 Pro', platform: 'android', osVersion: '14', appVersion: '34.5.5', buildNumber: 340505 },
    { brand: 'Google', model: 'Pixel 8', platform: 'android', osVersion: '14', appVersion: '34.5.5', buildNumber: 340505 },
    { brand: 'OnePlus', model: 'CPH2581', platform: 'android', osVersion: '14', appVersion: '34.5.5', buildNumber: 340505 },
    { brand: 'Xiaomi', model: '23113RKH6G', platform: 'android', osVersion: '14', appVersion: '34.5.5', buildNumber: 340505 },
  ],
  mobile_ios: [
    { brand: 'Apple', model: 'iPhone15,2', platform: 'ios', osVersion: '17.5', appVersion: '34.5.5', buildNumber: 340505 },
    { brand: 'Apple', model: 'iPhone16,1', platform: 'ios', osVersion: '18.0', appVersion: '34.5.5', buildNumber: 340505 },
    { brand: 'Apple', model: 'iPhone15,3', platform: 'ios', osVersion: '17.5', appVersion: '34.5.5', buildNumber: 340505 },
  ],
  desktop_web: [
    { brand: '', model: '', platform: 'web', osVersion: '', appVersion: '', buildNumber: 0 },
  ],
  tablet_android: [
    { brand: 'Samsung', model: 'SM-X910', platform: 'android', osVersion: '14', appVersion: '34.5.5', buildNumber: 340505 },
    { brand: 'Samsung', model: 'SM-T870', platform: 'android', osVersion: '13', appVersion: '34.5.5', buildNumber: 340505 },
  ],
  tablet_ios: [
    { brand: 'Apple', model: 'iPad14,3', platform: 'ios', osVersion: '17.5', appVersion: '34.5.5', buildNumber: 340505 },
    { brand: 'Apple', model: 'iPad13,8', platform: 'ios', osVersion: '17.5', appVersion: '34.5.5', buildNumber: 340505 },
  ],
};

const MOBILE_USER_AGENTS: Record<string, string[]> = {
  android: [
    'com.zhiliaoapp.musically/340505 (Linux; U; Android 14; en_US; SM-S928B; Build/UP1A.231005.007; Cronet/TTNetVersion:b4d74d15 2020-04-23 QuicVersion:0144d358 2020-03-24)',
    'com.zhiliaoapp.musically/340505 (Linux; U; Android 14; en_US; Pixel 8 Pro; Build/UP1A.231005.007; Cronet/TTNetVersion:b4d74d15 2020-04-23 QuicVersion:0144d358 2020-03-24)',
  ],
  ios: [
    'com.zhiliaoapp.musically/340505 (iPhone; iOS 17.5; Scale/3.00) Resolution/1290*2796',
    'com.zhiliaoapp.musically/340505 (iPhone; iOS 18.0; Scale/3.00) Resolution/1290*2796',
  ],
  web: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  ],
};

// ===============================================================================
// DEVICE REGISTRAR ENGINE
// ===============================================================================

export class DeviceRegistrarEngine {
  private devicePool: Map<string, TikTokDeviceProfile> = new Map();
  private registeredDevices: Map<string, DeviceRegistrationResult> = new Map();
  private stats = {
    totalGenerated: 0,
    totalRegistered: 0,
    totalRotations: 0,
    activeDevices: 0,
  };

  constructor() {
    logger.info('TikTok device registrar initialized');
  }

  /**
   * Generate a new device profile.
   */
  generateDevice(type?: TikTokDeviceType, region: string = 'US', language: string = 'en'): TikTokDeviceProfile {
    const deviceType = type || (Math.random() < 0.7 ? 'mobile_android' : Math.random() < 0.5 ? 'mobile_ios' : 'desktop_web');
    const templates = DEVICE_TEMPLATES[deviceType];
    const template = templates[Math.floor(Math.random() * templates.length)];

    const platform = template.platform || 'android';
    const uaList = MOBILE_USER_AGENTS[platform] || MOBILE_USER_AGENTS.web;
    const userAgent = uaList[Math.floor(Math.random() * uaList.length)];

    const screenResolutions: Record<string, { width: number; height: number; dpr: number }[]> = {
      android: [
        { width: 1080, height: 2400, dpr: 2.625 },
        { width: 1440, height: 3120, dpr: 3.5 },
        { width: 1080, height: 2340, dpr: 2.625 },
      ],
      ios: [
        { width: 1179, height: 2556, dpr: 3 },
        { width: 1290, height: 2796, dpr: 3 },
        { width: 1080, height: 2340, dpr: 2 },
      ],
      web: [
        { width: 1920, height: 1080, dpr: 1 },
        { width: 1536, height: 864, dpr: 1.25 },
        { width: 1440, height: 900, dpr: 2 },
      ],
    };

    const resolutions = screenResolutions[platform] || screenResolutions.web;
    const resolution = resolutions[Math.floor(Math.random() * resolutions.length)];

    const carriers = ['T-Mobile', 'AT&T', 'Verizon', 'Vodafone', 'EE', 'Three'];
    const connectionTypes: Array<'wifi' | '4g' | '5g' | '3g'> = ['4g', '5g', 'wifi', '4g', '5g'];

    const device: TikTokDeviceProfile = {
      deviceType,
      userAgent,
      screenResolution: resolution,
      platform: platform === 'web' ? 'web' : platform,
      appVersion: template.appVersion || '34.5.5',
      buildNumber: template.buildNumber || 340505,
      brand: template.brand || '',
      model: template.model || '',
      osVersion: template.osVersion || '',
      carrier: platform !== 'web' ? carriers[Math.floor(Math.random() * carriers.length)] : undefined,
      connectionType: platform !== 'web' ? connectionTypes[Math.floor(Math.random() * connectionTypes.length)] : 'wifi',
      language,
      region,
      deviceId: this.generateDeviceId(),
      installId: this.generateInstallId(),
    };

    this.devicePool.set(device.deviceId, device);
    this.stats.totalGenerated++;

    return device;
  }

  /**
   * Generate a pool of device profiles.
   */
  generatePool(count: number, preferredType?: TikTokDeviceType, region: string = 'US'): TikTokDeviceProfile[] {
    const devices: TikTokDeviceProfile[] = [];
    for (let i = 0; i < count; i++) {
      devices.push(this.generateDevice(preferredType, region));
    }
    logger.info({ count, preferredType, region }, 'Device pool generated');
    return devices;
  }

  /**
   * Register a device with TikTok.
   * In production, this would make actual API calls to TikTok's device registration endpoint.
   * Here we simulate the registration with generated tokens.
   */
  async register(params: DeviceRegistrationParams): Promise<DeviceRegistrationResult> {
    const startTime = Date.now();

    logger.info({
      deviceType: params.device.deviceType,
      model: params.device.model,
      deviceId: params.device.deviceId,
    }, 'Registering TikTok device');

    // Generate ttwid cookie
    const ttwid = this.generateTtwid();

    // Generate odin_tt cookie
    const odin_tt = this.generateOdinTT();

    // Generate assigned IDs
    const assignedDeviceId = this.generateDeviceId();
    const assignedInstallId = this.generateInstallId();

    const result: DeviceRegistrationResult = {
      success: true,
      ttwid,
      odin_tt,
      msToken: params.msToken,
      assignedDeviceId,
      assignedInstallId,
      registeredAt: Date.now(),
      verified: params.verify,
      errors: [],
    };

    this.registeredDevices.set(params.device.deviceId, result);
    this.stats.totalRegistered++;

    // Cache the registration
    try {
      await cacheSet(`tiktok:device:${params.device.deviceId}`, result, 3600);
    } catch {
      logger.debug('Failed to cache device registration');
    }

    logger.info({
      deviceId: params.device.deviceId,
      assignedDeviceId,
      durationMs: Date.now() - startTime,
    }, 'TikTok device registered');

    return result;
  }

  /**
   * Get a registered device by device ID.
   */
  async getRegisteredDevice(deviceId: string): Promise<DeviceRegistrationResult | null> {
    // Check memory first
    const cached = this.registeredDevices.get(deviceId);
    if (cached) return cached;

    // Check Redis
    try {
      const redisResult = await cacheGet<DeviceRegistrationResult>(`tiktok:device:${deviceId}`);
      if (redisResult) {
        this.registeredDevices.set(deviceId, redisResult);
        return redisResult;
      }
    } catch { /* ignore */ }

    return null;
  }

  /**
   * Get a random registered device.
   */
  getRandomRegisteredDevice(): DeviceRegistrationResult | null {
    const devices = [...this.registeredDevices.values()];
    if (devices.length === 0) return null;
    return devices[Math.floor(Math.random() * devices.length)];
  }

  /**
   * Rotate to a new device identity.
   */
  async rotateDevice(type?: TikTokDeviceType, region: string = 'US'): Promise<{
    profile: TikTokDeviceProfile;
    registration: DeviceRegistrationResult;
  }> {
    const profile = this.generateDevice(type, region);
    const msToken = `ms_${Math.random().toString(36).slice(2, 34)}`;
    const registration = await this.register({
      device: profile,
      msToken,
      verify: true,
    });

    this.stats.totalRotations++;

    return { profile, registration };
  }

  /**
   * Get registrar statistics.
   */
  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      poolSize: this.devicePool.size,
      registeredCount: this.registeredDevices.size,
    };
  }

  // --- Private helpers ---

  private generateDeviceId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  private generateInstallId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  private generateTtwid(): string {
    const payload = JSON.stringify({
      t: Math.floor(Date.now() / 1000),
      h: Math.random().toString(36).slice(2, 10),
      s: Math.random().toString(36).slice(2, 8),
    });
    return Buffer.from(payload).toString('base64url');
  }

  private generateOdinTT(): string {
    const parts = [
      Math.floor(Date.now() / 1000).toString(36),
      Math.random().toString(36).slice(2, 14),
      Math.random().toString(36).slice(2, 10),
    ];
    return parts.join('_');
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const deviceRegistrar = new DeviceRegistrarEngine();
