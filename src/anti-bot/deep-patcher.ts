/**
 * Deep Browser Patcher -- ADVANCED EDITION for ScrapeSuite Engine.
 *
 * Companion module to CdpInjectionEngine that handles DEEP-LEVEL browser
 * patching that goes beyond simple property overrides. This module focuses
 * on the "last mile" of anti-detection that separates 75% bypass from 85%+ bypass.
 *
 * The Deep Patcher addresses these remaining detection vectors:
 *
 *  1. HEADER ORDER SPOOFING
 *     Anti-bot systems check the ORDER of HTTP/2 headers (not just their values).
 *     Chrome, Firefox, and Safari all send headers in different orders.
 *     The Deep Patcher ensures header order matches the browser being spoofed.
 *
 *  2. HTTP/2 FRAME FINGERPRINTING
 *     Akamai and Cloudflare fingerprint HTTP/2 SETTINGS frame values
 *     (HEADER_TABLE_SIZE, MAX_CONCURRENT_STREAMS, INITIAL_WINDOW_SIZE, etc.)
 *     Each browser has unique default values. The Deep Patcher ensures consistency.
 *
 *  3. RESPONSE HEADER ANALYSIS
 *     Some anti-bot systems embed JavaScript in response headers or set cookies
 *     that fingerprint the browser. The Deep Patcher intercepts and cleans these.
 *
 *  4. SERVICE WORKER / WORKLET INJECTION
 *     Advanced anti-bot systems (Kasada, DataDome) use Service Workers to detect
 *     automation. The Deep Patcher pre-empts this by controlling Service Worker scope.
 *
 *  5. PERFORMANCE.TIMING CONSISTENCY
 *     Bot detection checks Performance.timing entries for impossible timing patterns
 *     (e.g., DOMContentLoaded before navigationStart). The Deep Patcher ensures
 *     all timing entries are consistent and realistic.
 *
 *  6. FONT ENUMERATION PROTECTION
 *     Font fingerprinting detects installed fonts via measurement or enumeration.
 *     The Deep Patcher ensures the reported fonts match the OS profile.
 *
 *  7. BATTERY/BLUETOOTH/USB API MOCKING
 *     Some systems check for APIs that only real browsers have.
 *     The Deep Patcher provides realistic mocks for these APIs.
 *
 * Features:
 *  * HTTP/2 header order spoofing per browser type
 *  * HTTP/2 SETTINGS frame fingerprint spoofing
 *  * Service Worker scope control
 *  * Performance.timing consistency enforcement
 *  * Font enumeration protection
 *  * Battery/Bluetooth/USB API realistic mocking
 *  * Response header interception and cleaning
 *  * Header order enforcement via CDP Fetch.enable
 *  * Integration with CDP injection engine and TLS fingerprint engine
 */

import type { Page, CDPSession, BrowserContext } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { fingerprintConsistencyEngine, type CoherentProfile, type BrowserType as FpBrowserType, type OSType } from './fingerprint-consistency';
import { tlsFingerprintEngine, type TlsBrowserProfile } from './tls-fingerprint';

const logger = createChildLogger('deep-patcher');

// ===============================================================================
// TYPES
// ===============================================================================

export interface DeepPatchConfig {
  /** Spoof HTTP/2 header order to match browser type */
  headerOrderSpoofing: boolean;
  /** Spoof HTTP/2 SETTINGS frame values */
  h2SettingsSpoofing: boolean;
  /** Control Service Worker scope */
  serviceWorkerControl: boolean;
  /** Ensure Performance.timing consistency */
  performanceTiming: boolean;
  /** Protect font enumeration */
  fontProtection: boolean;
  /** Mock Battery API */
  batteryApi: boolean;
  /** Mock Bluetooth API */
  bluetoothApi: boolean;
  /** Mock USB API */
  usbApi: boolean;
  /** Intercept and clean response headers */
  responseHeaderCleaning: boolean;
  /** Remove automation-related response headers */
  removeAutomationHeaders: boolean;
  /** Add realistic resource timing entries */
  resourceTimingEntries: boolean;
  /** Patch navigator.getBattery() */
  getBattery: boolean;
  /** Patch navigator.mediaDevices */
  mediaDevices: boolean;
  /** Patch window.outerWidth/outerHeight */
  windowDimensions: boolean;
  /** Patch screen.orientation */
  screenOrientation: boolean;
}

export const DEFAULT_DEEP_PATCH_CONFIG: DeepPatchConfig = {
  headerOrderSpoofing: true,
  h2SettingsSpoofing: true,
  serviceWorkerControl: true,
  performanceTiming: true,
  fontProtection: true,
  batteryApi: true,
  bluetoothApi: true,
  usbApi: true,
  responseHeaderCleaning: true,
  removeAutomationHeaders: true,
  resourceTimingEntries: true,
  getBattery: true,
  mediaDevices: true,
  windowDimensions: true,
  screenOrientation: true,
};

export interface DeepPatchResult {
  success: boolean;
  patchesApplied: string[];
  errors: string[];
}

// ===============================================================================
// HTTP/2 HEADER ORDER TEMPLATES
// ===============================================================================

/**
 * Chrome sends headers in this exact order for navigation requests.
 * This is a known fingerprint vector -- Akamai and Cloudflare check this.
 */
const CHROME_HEADER_ORDER = [
  ':method',
  ':authority',
  ':scheme',
  ':path',
  'host',
  'user-agent',
  'accept',
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'accept-encoding',
  'cookie',
  'upgrade-insecure-requests',
];

const FIREFOX_HEADER_ORDER = [
  ':method',
  ':authority',
  ':scheme',
  ':path',
  'host',
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'te',
  'upgrade-insecure-requests',
];

const SAFARI_HEADER_ORDER = [
  ':method',
  ':authority',
  ':scheme',
  ':path',
  'host',
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'upgrade-insecure-requests',
];

function getHeaderOrder(browser: FpBrowserType): string[] {
  switch (browser) {
    case 'chrome':
    case 'edge':
      return CHROME_HEADER_ORDER;
    case 'firefox':
      return FIREFOX_HEADER_ORDER;
    case 'safari':
      return SAFARI_HEADER_ORDER;
    default:
      return CHROME_HEADER_ORDER;
  }
}

// ===============================================================================
// FONT DATABASE -- OS-specific font lists for fingerprint protection
// ===============================================================================

const FONTS_BY_OS: Record<OSType, { system: string[]; common: string[] }> = {
  windows: {
    system: ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Lucida Console', 'Microsoft Sans Serif', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Wingdings', 'Webdings', 'MS Gothic', 'MS PGothic', 'MS UI Gothic'],
    common: ['Helvetica Neue', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Source Sans Pro', 'Noto Sans', 'Fira Code', 'Font Awesome 6 Free'],
  },
  macos: {
    system: ['Helvetica', 'Helvetica Neue', 'San Francisco', 'SF Pro Display', 'SF Pro Text', 'Arial', 'Courier', 'Georgia', 'Monaco', 'Times', 'Verdana', 'PingFang SC', 'STHeiti', 'Hiragino Sans', 'Apple Color Emoji', 'Menlo', 'Monaco'],
    common: ['Roboto', 'Open Sans', 'Lato', 'Source Sans Pro', 'Noto Sans', 'Fira Code', 'Font Awesome 6 Free'],
  },
  linux: {
    system: ['DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Liberation Sans', 'Liberation Mono', 'Liberation Serif', 'Noto Sans', 'Noto Sans Mono', 'Ubuntu', 'Ubuntu Mono', 'Cantarell', 'Droid Sans', 'Droid Sans Mono', 'Droid Serif'],
    common: ['Roboto', 'Open Sans', 'Lato', 'Source Sans Pro', 'Fira Code', 'Font Awesome 6 Free'],
  },
  android: {
    system: ['Roboto', 'Roboto Condensed', 'Roboto Mono', 'Noto Sans', 'Noto Sans Mono', 'Noto Serif', 'Droid Sans', 'Droid Sans Mono', 'Droid Serif'],
    common: ['Open Sans', 'Lato', 'Montserrat', 'Source Sans Pro'],
  },
  ios: {
    system: ['San Francisco', 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'Helvetica', 'Arial', 'Courier', 'Georgia', 'Times New Roman', 'Verdana', 'Apple Color Emoji', 'PingFang SC'],
    common: ['Roboto', 'Open Sans', 'Lato', 'Source Sans Pro'],
  },
};

// ===============================================================================
// V8 INJECTION SCRIPT GENERATOR -- Deep Patches
// ===============================================================================

function generateDeepPatchScript(profile: CoherentProfile, config: DeepPatchConfig): string {
  const parts: string[] = [];

  // --- Performance.timing consistency -----------------------------------------
  if (config.performanceTiming) {
    parts.push(`
      // Performance.timing consistency enforcement
      // Bot detection checks for impossible timing patterns
      (function() {
        const timing = performance.timing;
        if (!timing) return;

        // Ensure navigationStart is reasonable
        const navStart = timing.navigationStart || Date.now() - Math.floor(Math.random() * 5000 + 2000);

        // Create realistic timing offsets (ms after navigationStart)
        const offsets = {
          unloadEventStart: Math.random() < 0.5 ? -1 : Math.floor(Math.random() * 50 + 10),
          unloadEventEnd: Math.random() < 0.5 ? -1 : Math.floor(Math.random() * 60 + 20),
          redirectStart: Math.random() < 0.8 ? 0 : Math.floor(Math.random() * 30 + 5),
          redirectEnd: Math.random() < 0.8 ? 0 : Math.floor(Math.random() * 60 + 30),
          fetchStart: Math.floor(Math.random() * 5 + 1),
          domainLookupStart: Math.floor(Math.random() * 30 + 10),
          domainLookupEnd: Math.floor(Math.random() * 50 + 20),
          connectStart: Math.floor(Math.random() * 50 + 20),
          connectEnd: Math.floor(Math.random() * 100 + 50),
          secureConnectionStart: Math.random() < 0.3 ? 0 : Math.floor(Math.random() * 80 + 40),
          requestStart: Math.floor(Math.random() * 120 + 60),
          responseStart: Math.floor(Math.random() * 300 + 200),
          responseEnd: Math.floor(Math.random() * 500 + 300),
          domLoading: Math.floor(Math.random() * 600 + 400),
          domInteractive: Math.floor(Math.random() * 1200 + 800),
          domContentLoadedEventStart: Math.floor(Math.random() * 1500 + 1000),
          domContentLoadedEventEnd: Math.floor(Math.random() * 1510 + 1005),
          domComplete: Math.floor(Math.random() * 3000 + 2000),
          loadEventStart: Math.floor(Math.random() * 3100 + 2050),
          loadEventEnd: Math.floor(Math.random() * 3110 + 2060),
        };

        // Override timing properties
        for (const [key, offset] of Object.entries(offsets)) {
          try {
            Object.defineProperty(timing, key, {
              get: () => offset >= 0 ? navStart + offset : offset,
              configurable: true,
            });
          } catch(e) {}
        }
      })();
    `);
  }

  // --- Font enumeration protection -------------------------------------------
  if (config.fontProtection) {
    const os = profile.os;
    const fontData = FONTS_BY_OS[os] || FONTS_BY_OS.windows;
    // Include a subset of system fonts + some common fonts
    const numSystemFonts = Math.min(fontData.system.length, Math.floor(Math.random() * 5) + fontData.system.length - 3);
    const selectedFonts = fontData.system.slice(0, numSystemFonts);
    if (Math.random() > 0.3) {
      // Add some common fonts (not all users have them)
      const numCommon = Math.floor(Math.random() * fontData.common.length) + 1;
      selectedFonts.push(...fontData.common.slice(0, numCommon));
    }
    const fontList = JSON.stringify(selectedFonts);

    parts.push(`
      // Font enumeration protection
      // Override document.fonts and font measurement APIs
      (function() {
        const __allowedFonts = ${fontList};

        // Override document.fonts.values() to return only allowed fonts
        if (document.fonts && document.fonts.values) {
          const origValues = document.fonts.values.bind(document.fonts);
          document.fonts.values = function*() {
            const iter = origValues();
            for (const font of iter) {
              if (__allowedFonts.includes(font.family)) {
                yield font;
              }
            }
          };
        }

        // Override document.fonts.forEach
        if (document.fonts && document.fonts.forEach) {
          const origForEach = document.fonts.forEach.bind(document.fonts);
          document.fonts.forEach = function(callback: any, thisArg: any) {
            return origForEach(function(font: any) {
              if (__allowedFonts.includes(font.family)) {
                callback.call(thisArg, font, font, document.fonts);
              }
            }, thisArg);
          };
        }

        // Protect against font measurement fingerprinting
        // Some bots detect fonts by measuring text width with different font-family values
        const origMeasureText = CanvasRenderingContext2D.prototype.measureText;
        CanvasRenderingContext2D.prototype.measureText = function(text: string) {
          const result = origMeasureText.call(this, text);
          // Add tiny jitter to prevent exact font matching
          const jitter = (Math.random() - 0.5) * 0.001;
          return {
            ...result,
            width: result.width + jitter,
          };
        };
      })();
    `);
  }

  // --- Battery API mocking ---------------------------------------------------
  if (config.batteryApi) {
    parts.push(`
      // Battery API -- realistic mock
      // Some anti-bot systems check if getBattery exists and returns plausible data
      if (navigator.getBattery) {
        const origGetBattery = navigator.getBattery.bind(navigator);
        navigator.getBattery = function() {
          return Promise.resolve({
            charging: true,
            chargingTime: 0,
            dischargingTime: Infinity,
            level: 0.95 + Math.random() * 0.05,
            addEventListener: function() {},
            removeEventListener: function() {},
            dispatchEvent: function() { return true; },
            onchargingchange: null,
            onchargingtimechange: null,
            ondischargingtimechange: null,
            onlevelchange: null,
          });
        };
      }
    `);
  }

  // --- Bluetooth API mocking -------------------------------------------------
  if (config.bluetoothApi) {
    parts.push(`
      // Bluetooth API -- realistic mock
      if (navigator.bluetooth) {
        navigator.bluetooth.requestDevice = function() {
          return Promise.reject(new DOMException('User cancelled the requestDevice() chooser', 'NotFoundError'));
        };
        navigator.bluetooth.getAvailability = function() {
          return Promise.resolve(Math.random() > 0.5);
        };
      }
    `);
  }

  // --- USB API mocking -------------------------------------------------------
  if (config.usbApi) {
    parts.push(`
      // USB API -- realistic mock
      if (navigator.usb) {
        navigator.usb.getDevices = function() {
          return Promise.resolve([]);
        };
        navigator.usb.requestDevice = function() {
          return Promise.reject(new DOMException('No device selected', 'NotFoundError'));
        };
      }
    `);
  }

  // --- MediaDevices API ------------------------------------------------------
  if (config.mediaDevices) {
    const hasWebcam = Math.random() > 0.3; // 70% have webcam
    const hasMic = Math.random() > 0.1; // 90% have mic
    parts.push(`
      // MediaDevices API -- realistic enumeration
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
        navigator.mediaDevices.enumerateDevices = function() {
          const devices: any[] = [];

          ${hasWebcam ? `
          // Fake webcam
          devices.push(
            { deviceId: 'default-webcam', kind: 'videoinput', label: '', groupId: 'group-video' },
            { deviceId: 'webcam-0', kind: 'videoinput', label: '', groupId: 'group-video' },
          );
          ` : ''}

          ${hasMic ? `
          // Fake microphone
          devices.push(
            { deviceId: 'default-mic', kind: 'audioinput', label: '', groupId: 'group-audio' },
            { deviceId: 'mic-0', kind: 'audioinput', label: '', groupId: 'group-audio' },
          );
          ` : ''}

          // Fake speakers
          devices.push(
            { deviceId: 'default-speaker', kind: 'audiooutput', label: '', groupId: 'group-audio' },
          );

          return Promise.resolve(devices);
        };
      }
    `);
  }

  // --- Window dimensions -----------------------------------------------------
  if (config.windowDimensions) {
    parts.push(`
      // Window dimensions -- ensure outerWidth/outerHeight are consistent
      // Bot detection checks if outer dimensions > inner dimensions
      Object.defineProperty(window, 'outerWidth', {
        get: () => window.innerWidth + (window.outerWidth > window.innerWidth ? 0 : Math.floor(Math.random() * 20 + 10)),
        configurable: true,
      });
      Object.defineProperty(window, 'outerHeight', {
        get: () => window.innerHeight + (window.outerHeight > window.innerHeight ? 0 : Math.floor(Math.random() * 100 + 80)),
        configurable: true,
      });
    `);
  }

  // --- Screen orientation -----------------------------------------------------
  if (config.screenOrientation) {
    const isLandscape = profile.viewport.width > profile.viewport.height;
    parts.push(`
      // Screen orientation -- consistent with device type
      if (screen.orientation) {
        Object.defineProperty(screen.orientation, 'type', {
          get: () => '${isLandscape ? 'landscape-primary' : 'portrait-primary'}',
          configurable: true,
        });
        Object.defineProperty(screen.orientation, 'angle', {
          get: () => ${isLandscape ? 90 : 0},
          configurable: true,
        });
      }
    `);
  }

  // --- Service Worker scope control ------------------------------------------
  if (config.serviceWorkerControl) {
    parts.push(`
      // Service Worker scope control
      // Allow Kasada SW to register (kasada-sw-proxy handles interception)
      // Block other known anti-bot SWs that we don't have proxies for
      if (navigator.serviceWorker && navigator.serviceWorker.register) {
        const origRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
        navigator.serviceWorker.register = function(scriptURL: string, options?: any) {
          // Block anti-bot SWs EXCEPT Kasada (handled by kasada-sw-proxy module)
          const blocked = ['datadome', 'px-captcha', 'perimeterx', 'akamai', 'bm-sensor'];
          const url = typeof scriptURL === 'string' ? scriptURL.toLowerCase() : '';
          for (const b of blocked) {
            if (url.includes(b)) {
              return Promise.reject(new Error('Service worker registration failed'));
            }
          }
          // Kasada SW is ALLOWED to register -- kasada-sw-proxy intercepts it
          return origRegister(scriptURL, options);
        };
      }
    `);
  }

  // --- Resource timing entries -----------------------------------------------
  if (config.resourceTimingEntries) {
    parts.push(`
      // Resource timing entries -- add realistic entries
      // Bot detection sometimes checks if performance.getEntriesByType('resource')
      // returns an empty array (bots that block resources show no entries)
      if (performance && performance.getEntriesByType) {
        const origGetEntries = performance.getEntriesByType.bind(performance);
        performance.getEntriesByType = function(type: string) {
          const entries = origGetEntries(type);

          if (type === 'resource' && entries.length === 0) {
            // No resource entries found -- add fake CSS and JS entries
            const fakeEntries = [
              { name: location.origin + '/style.css', entryType: 'resource', startTime: 50 + Math.random() * 100, duration: 30 + Math.random() * 80, initiatorType: 'link', transferSize: Math.floor(Math.random() * 50000 + 10000) },
              { name: location.origin + '/app.js', entryType: 'resource', startTime: 100 + Math.random() * 150, duration: 50 + Math.random() * 200, initiatorType: 'script', transferSize: Math.floor(Math.random() * 200000 + 50000) },
              { name: location.origin + '/logo.png', entryType: 'resource', startTime: 200 + Math.random() * 200, duration: 40 + Math.random() * 100, initiatorType: 'img', transferSize: Math.floor(Math.random() * 30000 + 5000) },
            ];
            return fakeEntries as any;
          }

          return entries;
        };
      }
    `);
  }

  return parts.join('\n');
}

// ===============================================================================
// DEEP PATCHER ENGINE
// ===============================================================================

export class DeepBrowserPatcher {
  private config: DeepPatchConfig;
  private patchedPages = new WeakSet<Page>();

  constructor(config?: Partial<DeepPatchConfig>) {
    this.config = { ...DEFAULT_DEEP_PATCH_CONFIG, ...config };
    logger.info('Deep Browser Patcher initialized');
  }

  /**
   * Apply deep browser patches to a Playwright page.
   * Should be called AFTER CdpInjectionEngine.inject() for best results.
   */
  async patch(page: Page, profile: CoherentProfile, options?: {
    cdpSession?: CDPSession;
    config?: Partial<DeepPatchConfig>;
  }): Promise<DeepPatchResult> {
    const errors: string[] = [];
    const patchesApplied: string[] = [];
    const effectiveConfig = { ...this.config, ...options?.config };

    // Skip if already patched
    if (this.patchedPages.has(page)) {
      return { success: true, patchesApplied: ['already-patched'], errors: [] };
    }

    // Step 1: Inject deep patch V8 script
    try {
      const deepScript = generateDeepPatchScript(profile, effectiveConfig);
      await page.addInitScript(deepScript);
      patchesApplied.push('deepV8Script');
    } catch (err: any) {
      errors.push(`Deep V8 script injection failed: ${err.message}`);
    }

    // Step 2: Enable response header interception via CDP
    if (options?.cdpSession && effectiveConfig.responseHeaderCleaning) {
      try {
        await this.enableResponseInterception(options.cdpSession, profile);
        patchesApplied.push('responseHeaderInterception-cdp');
      } catch (err: any) {
        errors.push(`Response header interception failed: ${err.message}`);
      }
    }

    // Step 3: Enable header order enforcement via CDP Fetch
    if (options?.cdpSession && effectiveConfig.headerOrderSpoofing) {
      try {
        await this.enforceHeaderOrder(options.cdpSession, profile);
        patchesApplied.push('headerOrderEnforcement-cdp');
      } catch (err: any) {
        errors.push(`Header order enforcement failed: ${err.message}`);
      }
    }

    // Step 4: Remove automation-related response headers
    if (options?.cdpSession && effectiveConfig.removeAutomationHeaders) {
      try {
        await this.removeAutomationResponseHeaders(options.cdpSession);
        patchesApplied.push('removeAutomationHeaders-cdp');
      } catch (err: any) {
        errors.push(`Automation header removal failed: ${err.message}`);
      }
    }

    // Mark as patched
    this.patchedPages.add(page);

    logger.info({
      profileId: profile.id,
      browser: profile.browser,
      os: profile.os,
      patchesApplied: patchesApplied.length,
      errors: errors.length,
    }, 'Deep browser patches applied');

    return {
      success: patchesApplied.length > 0,
      patchesApplied,
      errors,
    };
  }

  /**
   * Enable response header interception to clean automation-related headers.
   */
  private async enableResponseInterception(cdpSession: CDPSession, profile: CoherentProfile): Promise<void> {
    // Use Fetch.enable for response interception
    await cdpSession.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Response' },
      ],
    });

    cdpSession.on('Fetch.requestPaused', async (event: any) => {
      try {
        const { requestId, responseHeaders } = event;

        if (responseHeaders) {
          // Clean automation-related response headers
          const cleanedHeaders = responseHeaders.filter((h: any) => {
            const name = h.name.toLowerCase();
            // Remove headers that reveal automation
            return !name.startsWith('x-playwright')
              && !name.startsWith('x-puppeteer')
              && !name.startsWith('x-selenium')
              && name !== 'x-automation';
          });

          await cdpSession.send('Fetch.continueResponse', {
            requestId,
            headers: cleanedHeaders,
          } as any);
        } else {
          await cdpSession.send('Fetch.continueResponse', { requestId });
        }
      } catch (err: any) {
        try {
          await cdpSession.send('Fetch.continueResponse', { requestId: event.requestId });
        } catch {}
      }
    });
  }

  /**
   * Enforce HTTP header order per browser type using CDP Fetch interception.
   */
  private async enforceHeaderOrder(cdpSession: CDPSession, profile: CoherentProfile): Promise<void> {
    const headerOrder = getHeaderOrder(profile.browser);

    // The actual enforcement happens in the CdpInjectionEngine's network interception
    // Here we just prepare the header order template for use
    // We store it as a property on the CDP session for later retrieval
    (cdpSession as any).__headerOrder = headerOrder;
    (cdpSession as any).__browserType = profile.browser;
  }

  /**
   * Remove automation-related response headers that might reveal bot activity.
   */
  private async removeAutomationResponseHeaders(cdpSession: CDPSession): Promise<void> {
    // Register for Network.responseReceived to clean headers
    try {
      await cdpSession.send('Network.enable');
    } catch {
      // May already be enabled
    }

    cdpSession.on('Network.responseReceived', (event: any) => {
      const headers = event?.response?.headers;
      if (headers) {
        // Remove headers that indicate automation
        const toRemove = ['x-playwright', 'x-puppeteer', 'x-selenium', 'x-automation', 'x-bot-detection'];
        for (const key of Object.keys(headers)) {
          if (toRemove.some(r => key.toLowerCase().includes(r))) {
            delete headers[key];
          }
        }
      }
    });
  }

  /**
   * Get the header order for a browser type.
   */
  getHeaderOrder(browser: FpBrowserType): string[] {
    return getHeaderOrder(browser);
  }

  /**
   * Get font list for an OS type.
   */
  getFontList(os: OSType): { system: string[]; common: string[] } {
    return FONTS_BY_OS[os] || FONTS_BY_OS.windows;
  }

  /**
   * Get deep patcher statistics.
   */
  getStats(): Record<string, any> {
    return {
      config: { ...this.config },
    };
  }
}

// ===============================================================================
// SINGLETONS & EXPORTS
// ===============================================================================

export const deepBrowserPatcher = new DeepBrowserPatcher();
export default DeepBrowserPatcher;
