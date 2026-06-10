/**
 * Mobile Emulation Engine — ScrapeSuite Engine
 *
 * Generates realistic mobile device profiles with carrier-grade
 * fingerprinting for Netflix and Google. Both services give
 * preferential treatment to mobile traffic and have weaker
 * anti-bot checks on mobile endpoints.
 *
 * Key capabilities:
 * - 15+ mobile device profiles with accurate specifications
 * - Carrier-specific network emulation (4G/5G speeds)
 * - Mobile browser fingerprint generation (Safari/Chrome mobile)
 * - Touch event simulation parameters
 * - Mobile-specific viewport and DPR configurations
 * - Battery API and Network Information API emulation
 * - Country-specific carrier configurations
 * - Mobile vs Desktop traffic ratio management
 *
 * Why mobile matters for Netflix/Google:
 * - Netflix mobile web has fewer anti-bot checks than desktop
 * - Google's mobile SERP has less aggressive rate limiting
 * - Mobile IPs from carriers have higher reputation scores
 * - Mobile traffic patterns are harder to distinguish from bots
 * - 60%+ of real Netflix/Google traffic is mobile
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type { MobileProfile, MobileDevice, MobilePlatform, MobileEmulationConfig } from './types';

const logger = createChildLogger('mobile-emulation');

const PROFILE_PREFIX = 'infra:mobile:profile:';
const PROFILE_LIST_KEY = 'infra:mobile:profiles:list';

// ===============================================================================
// DEVICE SPECIFICATIONS DATABASE
// ===============================================================================

interface DeviceSpec {
  device: MobileDevice;
  platform: MobilePlatform;
  userAgent: string;
  screen: { width: number; height: number; dpr: number };
  cpuCores: number;
  memoryGB: number;
  gpuRenderer: string;
  browserVersion: string;
  osVersion: string;
  platformString: string;
  vendor: string;
  webglVendor: string;
  maxTouchPoints: number;
}

const DEVICE_SPECS: Record<MobileDevice, DeviceSpec> = {
  'iphone-15-pro': {
    device: 'iphone-15-pro', platform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    screen: { width: 393, height: 852, dpr: 3 },
    cpuCores: 6, memoryGB: 8, gpuRenderer: 'Apple A17 Pro GPU',
    browserVersion: '17.4', osVersion: '17.4',
    platformString: 'iPhone', vendor: 'Apple Computer, Inc.',
    webglVendor: 'Apple Inc.', maxTouchPoints: 5,
  },
  'iphone-15': {
    device: 'iphone-15', platform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    screen: { width: 390, height: 844, dpr: 3 },
    cpuCores: 6, memoryGB: 6, gpuRenderer: 'Apple A16 GPU',
    browserVersion: '17.4', osVersion: '17.4',
    platformString: 'iPhone', vendor: 'Apple Computer, Inc.',
    webglVendor: 'Apple Inc.', maxTouchPoints: 5,
  },
  'iphone-14-pro': {
    device: 'iphone-14-pro', platform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    screen: { width: 393, height: 852, dpr: 3 },
    cpuCores: 6, memoryGB: 6, gpuRenderer: 'Apple A16 GPU',
    browserVersion: '17.2', osVersion: '16.7',
    platformString: 'iPhone', vendor: 'Apple Computer, Inc.',
    webglVendor: 'Apple Inc.', maxTouchPoints: 5,
  },
  'iphone-14': {
    device: 'iphone-14', platform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    screen: { width: 390, height: 844, dpr: 3 },
    cpuCores: 6, memoryGB: 6, gpuRenderer: 'Apple A15 GPU',
    browserVersion: '17.2', osVersion: '16.7',
    platformString: 'iPhone', vendor: 'Apple Computer, Inc.',
    webglVendor: 'Apple Inc.', maxTouchPoints: 5,
  },
  'iphone-se': {
    device: 'iphone-se', platform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    screen: { width: 375, height: 667, dpr: 2 },
    cpuCores: 6, memoryGB: 4, gpuRenderer: 'Apple A15 GPU',
    browserVersion: '17.4', osVersion: '17.4',
    platformString: 'iPhone', vendor: 'Apple Computer, Inc.',
    webglVendor: 'Apple Inc.', maxTouchPoints: 5,
  },
  'samsung-s24-ultra': {
    device: 'samsung-s24-ultra', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    screen: { width: 412, height: 915, dpr: 3.5 },
    cpuCores: 8, memoryGB: 12, gpuRenderer: 'Adreno (TM) 750',
    browserVersion: '122.0.0.0', osVersion: '14',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'Qualcomm', maxTouchPoints: 5,
  },
  'samsung-s24': {
    device: 'samsung-s24', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    screen: { width: 360, height: 780, dpr: 3 },
    cpuCores: 8, memoryGB: 8, gpuRenderer: 'Adreno (TM) 750',
    browserVersion: '122.0.0.0', osVersion: '14',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'Qualcomm', maxTouchPoints: 5,
  },
  'samsung-s23': {
    device: 'samsung-s23', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
    screen: { width: 360, height: 780, dpr: 3 },
    cpuCores: 8, memoryGB: 8, gpuRenderer: 'Adreno (TM) 740',
    browserVersion: '121.0.0.0', osVersion: '14',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'Qualcomm', maxTouchPoints: 5,
  },
  'samsung-a54': {
    device: 'samsung-a54', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
    screen: { width: 360, height: 780, dpr: 2.625 },
    cpuCores: 8, memoryGB: 6, gpuRenderer: 'Mali-G68 MP5',
    browserVersion: '121.0.0.0', osVersion: '14',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'ARM', maxTouchPoints: 5,
  },
  'pixel-8-pro': {
    device: 'pixel-8-pro', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    screen: { width: 412, height: 892, dpr: 3.5 },
    cpuCores: 9, memoryGB: 12, gpuRenderer: 'Mali-G715 MC7',
    browserVersion: '122.0.0.0', osVersion: '14',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'ARM', maxTouchPoints: 5,
  },
  'pixel-8': {
    device: 'pixel-8', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    screen: { width: 412, height: 892, dpr: 2.625 },
    cpuCores: 9, memoryGB: 8, gpuRenderer: 'Mali-G715 MC7',
    browserVersion: '122.0.0.0', osVersion: '14',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'ARM', maxTouchPoints: 5,
  },
  'pixel-7a': {
    device: 'pixel-7a', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
    screen: { width: 412, height: 915, dpr: 2.625 },
    cpuCores: 8, memoryGB: 8, gpuRenderer: 'Mali-G710 MP7',
    browserVersion: '121.0.0.0', osVersion: '14',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'ARM', maxTouchPoints: 5,
  },
  'oneplus-12': {
    device: 'oneplus-12', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; PJD110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    screen: { width: 412, height: 915, dpr: 3.5 },
    cpuCores: 8, memoryGB: 16, gpuRenderer: 'Adreno (TM) 750',
    browserVersion: '122.0.0.0', osVersion: '14',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'Qualcomm', maxTouchPoints: 5,
  },
  'xiaomi-14': {
    device: 'xiaomi-14', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; 23127PN0CG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    screen: { width: 412, height: 915, dpr: 3.5 },
    cpuCores: 8, memoryGB: 12, gpuRenderer: 'Adreno (TM) 750',
    browserVersion: '122.0.0.0', osVersion: '14',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'Qualcomm', maxTouchPoints: 5,
  },
  'huawei-p60': {
    device: 'huawei-p60', platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; MNA-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    screen: { width: 360, height: 800, dpr: 3 },
    cpuCores: 8, memoryGB: 8, gpuRenderer: 'Adreno (TM) 642L',
    browserVersion: '120.0.0.0', osVersion: '13',
    platformString: 'Linux armv81', vendor: 'Google Inc.',
    webglVendor: 'Qualcomm', maxTouchPoints: 5,
  },
};

// ===============================================================================
// CARRIER DATABASE
// ===============================================================================

const CARRIER_DB: Record<string, { name: string; mcc: string; mnc: string }[]> = {
  US: [
    { name: 'T-Mobile', mcc: '310', mnc: '260' },
    { name: 'AT&T', mcc: '310', mnc: '410' },
    { name: 'Verizon', mcc: '311', mnc: '480' },
    { name: 'US Cellular', mcc: '311', mnc: '580' },
  ],
  GB: [
    { name: 'EE', mcc: '234', mnc: '30' },
    { name: 'Three', mcc: '234', mnc: '20' },
    { name: 'Vodafone UK', mcc: '234', mnc: '15' },
    { name: 'O2', mcc: '234', mnc: '10' },
  ],
  DE: [
    { name: 'T-Mobile DE', mcc: '262', mnc: '01' },
    { name: 'Vodafone DE', mcc: '262', mnc: '02' },
    { name: 'O2 DE', mcc: '262', mnc: '07' },
  ],
  JP: [
    { name: 'NTT Docomo', mcc: '440', mnc: '10' },
    { name: 'KDDI', mcc: '440', mnc: '50' },
    { name: 'SoftBank', mcc: '440', mnc: '20' },
  ],
  BR: [
    { name: 'Vivo', mcc: '724', mnc: '11' },
    { name: 'Claro', mcc: '724', mnc: '05' },
    { name: 'TIM', mcc: '724', mnc: '02' },
  ],
  IN: [
    { name: 'Jio', mcc: '405', mnc: '840' },
    { name: 'Airtel', mcc: '404', mnc: '10' },
    { name: 'Vodafone Idea', mcc: '404', mnc: '01' },
  ],
};

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_MOBILE_EMULATION_CONFIG: MobileEmulationConfig = {
  defaultPlatform: 'android',
  deviceDistribution: {
    'iphone-15-pro': 0.10, 'iphone-15': 0.10, 'iphone-14-pro': 0.08, 'iphone-14': 0.08, 'iphone-se': 0.04,
    'samsung-s24-ultra': 0.08, 'samsung-s24': 0.08, 'samsung-s23': 0.06, 'samsung-a54': 0.06,
    'pixel-8-pro': 0.06, 'pixel-8': 0.06, 'pixel-7a': 0.04,
    'oneplus-12': 0.04, 'xiaomi-14': 0.04, 'huawei-p60': 0.04,
  },
  carrierConfig: CARRIER_DB,
  connectionDistribution: { '4g': 0.45, '5g': 0.35, 'wifi': 0.15, '3g': 0.05 },
  emulateBattery: true,
  emulateNetworkInfo: true,
  emulateTouch: true,
  orientation: 'portrait',
};

// ===============================================================================
// MOBILE EMULATION MANAGER
// ===============================================================================

export class MobileEmulationManager {
  private config: MobileEmulationConfig;
  private profiles: Map<string, MobileProfile> = new Map();

  constructor(config?: Partial<MobileEmulationConfig>) {
    this.config = { ...DEFAULT_MOBILE_EMULATION_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Mobile Emulation Manager');
    // Pre-generate a set of profiles
    for (let i = 0; i < 50; i++) {
      const profile = this.generateProfile();
      this.profiles.set(profile.id, profile);
    }
    logger.info({ profileCount: this.profiles.size }, 'Mobile Emulation initialized');
  }

  // ---------- Profile Generation -----------------------------------------------

  /** Generate a realistic mobile profile. */
  generateProfile(options?: { device?: MobileDevice; countryCode?: string }): MobileProfile {
    const device = options?.device || this.selectRandomDevice();
    const spec = DEVICE_SPECS[device];
    const countryCode = options?.countryCode || 'US';
    const carrier = this.selectCarrier(countryCode);
    const connection = this.selectConnection();
    const id = createHash('sha256')
      .update(`mobile:${device}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .substring(0, 16);

    const profile: MobileProfile = {
      id,
      device,
      platform: spec.platform,
      userAgent: spec.userAgent,
      screen: spec.screen,
      cpuCores: spec.cpuCores,
      memoryGB: spec.memoryGB,
      gpuRenderer: spec.gpuRenderer,
      browserVersion: spec.browserVersion,
      osVersion: spec.osVersion,
      carrier: carrier.name,
      mcc: carrier.mcc,
      mnc: carrier.mnc,
      connectionType: connection,
      downlinkMbps: this.getConnectionSpeed(connection),
      rttMs: this.getConnectionRTT(connection),
      touchSupport: true,
      maxTouchPoints: spec.maxTouchPoints,
      devicePixelRatio: spec.screen.dpr,
      colorDepth: 24,
      mediaQueries: this.getMediaQueries(spec.screen),
      webglVendor: spec.webglVendor,
      platformString: spec.platformString,
      vendor: spec.vendor,
      batteryLevel: 40 + Math.floor(Math.random() * 55), // 40-95%
      language: this.getLanguage(countryCode),
      timezone: this.getTimezone(countryCode),
      plugins: [], // Mobile browsers typically have no plugins
    };

    this.profiles.set(id, profile);
    return profile;
  }

  /** Get a profile by ID. */
  getProfile(id: string): MobileProfile | undefined {
    return this.profiles.get(id);
  }

  /** Get a random profile matching criteria. */
  getRandomProfile(options?: { platform?: MobilePlatform; countryCode?: string }): MobileProfile {
    const candidates = Array.from(this.profiles.values()).filter(p => {
      if (options?.platform && p.platform !== options.platform) return false;
      return true;
    });

    if (candidates.length === 0) {
      return this.generateProfile({ countryCode: options?.countryCode });
    }

    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ---------- Playwright Integration -------------------------------------------

  /** Generate Playwright viewport and device parameters. */
  getPlaywrightConfig(profile: MobileProfile): {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
    userAgent: string;
    locale: string;
    timezoneId: string;
    geolocation?: { latitude: number; longitude: number };
    permissions: string[];
  } {
    return {
      viewport: { width: profile.screen.width, height: profile.screen.height },
      deviceScaleFactor: profile.screen.dpr,
      isMobile: true,
      hasTouch: profile.touchSupport,
      userAgent: profile.userAgent,
      locale: profile.language,
      timezoneId: profile.timezone,
      permissions: ['geolocation'],
    };
  }

  /** Generate JavaScript injection code for mobile emulation. */
  getInjectionScript(profile: MobileProfile): string {
    return `
      // Mobile device emulation injection
      Object.defineProperty(navigator, 'platform', { get: () => '${profile.platformString}' });
      Object.defineProperty(navigator, 'vendor', { get: () => '${profile.vendor}' });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${profile.maxTouchPoints} });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${profile.cpuCores} });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => ${profile.memoryGB} });
      Object.defineProperty(screen, 'width', { get: () => ${profile.screen.width} });
      Object.defineProperty(screen, 'height', { get: () => ${profile.screen.height} });
      Object.defineProperty(screen, 'colorDepth', { get: () => ${profile.colorDepth} });
      Object.defineProperty(screen, 'pixelDepth', { get: () => ${profile.colorDepth} });
      Object.defineProperty(window, 'devicePixelRatio', { get: () => ${profile.screen.dpr} });
      ${profile.connectionType !== 'wifi' ? `
      // Network Information API
      if (navigator.connection) {
        Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '${profile.connectionType}' });
        Object.defineProperty(navigator.connection, 'downlink', { get: () => ${profile.downlinkMbps} });
        Object.defineProperty(navigator.connection, 'rtt', { get: () => ${profile.rttMs} });
        Object.defineProperty(navigator.connection, 'type', { get: () => 'cellular' });
      }
      ` : ''}
      ${this.config.emulateBattery ? `
      // Battery API
      if (navigator.getBattery) {
        navigator.getBattery = () => Promise.resolve({
          charging: ${Math.random() > 0.3},
          chargingTime: ${Math.random() > 0.3 ? 'Infinity' : Math.floor(Math.random() * 3600)},
          dischargingTime: ${Math.floor(Math.random() * 14400)},
          level: ${profile.batteryLevel / 100},
          addEventListener: () => {},
        });
      }
      ` : ''}
      // Remove automation indicators
      delete navigator.__proto__.webdriver;
      Object.defineProperty(navigator, 'plugins', { get: () => [] });
      Object.defineProperty(navigator, 'languages', { get: () => ['${profile.language}', '${profile.language.split('-')[0]}'] });
    `;
  }

  // ---------- Statistics -------------------------------------------------------

  getStats(): {
    total: number;
    byPlatform: Record<MobilePlatform, number>;
    byDevice: Record<MobileDevice, number>;
  } {
    const byPlatform: Record<MobilePlatform, number> = { ios: 0, android: 0 };
    const byDevice: Record<MobileDevice, number> = {} as Record<MobileDevice, number>;

    for (const profile of this.profiles.values()) {
      byPlatform[profile.platform]++;
      byDevice[profile.device] = (byDevice[profile.device] || 0) + 1;
    }

    return { total: this.profiles.size, byPlatform, byDevice };
  }

  // ---------- Private Helpers --------------------------------------------------

  private selectRandomDevice(): MobileDevice {
    const rand = Math.random();
    let cumulative = 0;
    for (const [device, weight] of Object.entries(this.config.deviceDistribution)) {
      cumulative += weight;
      if (rand <= cumulative) return device as MobileDevice;
    }
    return 'samsung-s24';
  }

  private selectCarrier(countryCode: string): { name: string; mcc: string; mnc: string } {
    const carriers = this.config.carrierConfig[countryCode] || CARRIER_DB['US'] || [{ name: 'Unknown', mcc: '000', mnc: '00' }];
    return carriers[Math.floor(Math.random() * carriers.length)];
  }

  private selectConnection(): '4g' | '5g' | 'wifi' | '3g' {
    const rand = Math.random();
    let cumulative = 0;
    for (const [type, weight] of Object.entries(this.config.connectionDistribution)) {
      cumulative += weight;
      if (rand <= cumulative) return type as '4g' | '5g' | 'wifi' | '3g';
    }
    return '4g';
  }

  private getConnectionSpeed(type: string): number {
    const speeds: Record<string, [number, number]> = {
      '5g': [100, 1000], '4g': [10, 50], '3g': [1, 5], 'wifi': [20, 200],
    };
    const [min, max] = speeds[type] || [10, 50];
    return min + Math.random() * (max - min);
  }

  private getConnectionRTT(type: string): number {
    const rtts: Record<string, [number, number]> = {
      '5g': [10, 30], '4g': [30, 100], '3g': [100, 500], 'wifi': [5, 50],
    };
    const [min, max] = rtts[type] || [30, 100];
    return min + Math.random() * (max - min);
  }

  private getMediaQueries(screen: { width: number; height: number; dpr: number }): string[] {
    return [
      `(max-width: ${screen.width}px)`,
      `(max-height: ${screen.height}px)`,
      `(-webkit-min-device-pixel-ratio: ${screen.dpr})`,
      '(orientation: portrait)',
      '(hover: none)',
      '(pointer: coarse)',
    ];
  }

  private getLanguage(countryCode: string): string {
    const languages: Record<string, string> = {
      US: 'en-US', GB: 'en-GB', DE: 'de-DE', FR: 'fr-FR', JP: 'ja-JP',
      BR: 'pt-BR', IN: 'en-IN', CA: 'en-CA', AU: 'en-AU',
    };
    return languages[countryCode] || 'en-US';
  }

  private getTimezone(countryCode: string): string {
    const timezones: Record<string, string> = {
      US: 'America/New_York', GB: 'Europe/London', DE: 'Europe/Berlin',
      FR: 'Europe/Paris', JP: 'Asia/Tokyo', BR: 'America/Sao_Paulo',
      IN: 'Asia/Kolkata', CA: 'America/Toronto', AU: 'Australia/Sydney',
    };
    return timezones[countryCode] || 'America/New_York';
  }
}

/** Singleton instance. */
export const mobileEmulationManager = new MobileEmulationManager();
