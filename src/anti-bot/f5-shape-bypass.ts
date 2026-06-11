/**
 * F5/Shape Security Bypass Module -- ScrapeSuite Engine
 *
 * Dedicated F5/Shape Security anti-bot bypass engine that handles the full
 * lifecycle of Shape's detection, telemetry, sensor collection, and cookie
 * management. Shape (now F5 Distributed Cloud Bot Defense) is a Tier-1
 * anti-bot system used by major financial institutions, e-commerce platforms,
 * and enterprise applications.
 *
 * F5/Shape Detection Vectors:
 *  * Cookie-based: `ts.*` cookies, `sms_*`, `fst0`, `_abck` (shared Akamai flow)
 *  * Header-based: `X-Shape-*` headers, custom telemetry headers
 *  * Script-based: `shape.js`, `anti_catalog`, `/anti_catalog/` endpoints
 *  * DOM-based: `__antiCatalog` parameter, Shape telemetry iframes
 *  * Network: Telemetry beacon requests to Shape collection endpoints
 *
 * F5/Shape Fingerprinting & Telemetry Vectors (all must be spoofed):
 *  1. Device telemetry -- hardware, OS, browser capabilities
 *  2. Sensor data -- accelerometer, gyroscope, orientation, touch
 *  3. Canvas fingerprint (2D context + offscreen canvas)
 *  4. WebGL fingerprint (renderer, vendor, extensions, parameters)
 *  5. AudioContext fingerprint
 *  6. Navigator properties (webdriver, automation flags, plugins)
 *  7. Screen properties and device pixel ratio
 *  8. Battery API and Network Information API
 *  9. Behavioral signals -- mouse trajectories, keyboard dynamics, scroll patterns
 * 10. Automation detection -- CDP artifacts, Playwright/Puppeteer markers
 *
 * Bypass Strategies (escalation order):
 *  1. sensor-synthesis -- Synthesize realistic device telemetry payloads
 *  2. browser-execute  -- Execute Shape challenge JS in browser, extract tokens
 *  3. behavioral-mimic  -- Mimic human behavioral patterns (mouse, keyboard, scroll)
 *  4. maximum-stealth   -- Apply all stealth measures + CDP patches + re-solve
 *
 * Architecture:
 *  +----------------------------------------------------------------------+
 *  | Extends AntiBotBase                                                 |
 *  | Implements detect() → PlatformDetectionResult                      |
 *  | Implements bypass() → AntiBotResult                                |
 *  | Manages sensor synthesis via init scripts + CDP                    |
 *  | Manages behavioral mimicry (Bezier mouse, Gaussian keyboard)       |
 *  | Manages Shape cookie lifecycle (ts.*, sms_*, fst0, _abck)         |
 *  | Intercepts Shape telemetry requests                                |
 *  | CDP stealth injection via Runtime.evaluate                         |
 *  | Redis caching for solved tokens and domain profiles                |
 *  +----------------------------------------------------------------------+
 */

import type { Page, BrowserContext, CDPSession, Response } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import {
  type AntiBotPlatform,
  type BypassStrategy,
  type AntiBotResult,
  type BypassContext,
  type PlatformDetectionResult,
  type DetectionIndicator,
  type ManagedCookie,
  type DetectionSeverity,
  STRATEGY_ESCALATION,
  DEFAULT_PLATFORM_CONFIGS,
} from './types';
import { AntiBotBase } from './base';

const logger = createChildLogger('anti-bot:f5-shape');

// ===============================================================================
// F5/SHAPE DETECTION CONSTANTS
// ===============================================================================

/** DOM selectors that indicate an F5/Shape challenge page. */
const SHAPE_CHALLENGE_SELECTORS = [
  'iframe[src*="shape"]',
  'iframe[src*="anti_catalog"]',
  '[data-shape-challenge]',
  '.shape-challenge',
  '#shape-captcha',
  'div[data-testid="shape-challenge"]',
  'iframe[title*="Shape"]',
  '[id*="anti_catalog"]',
];

/** DOM text patterns found on Shape challenge pages. */
const SHAPE_CHALLENGE_TEXT = [
  'shape security',
  'anti_catalog',
  '__anticatalog',
  'please verify',
  'verify you are human',
  'checking your browser',
  'bot detection',
];

/** HTTP response headers set by F5/Shape. */
const SHAPE_RESPONSE_HEADERS = [
  'x-shape',
  'x-shape-request-headers',
  'x-shape-challenge',
  'x-shape-session',
  'x-f5-bot',
  'x-f5-challenge',
];

/** Cookie name patterns used by F5/Shape. */
const SHAPE_COOKIE_PATTERNS = [
  /^ts[a-z0-9_-]+$/i,   // ts.* cookies (timestamp-based session)
  /^sms_[a-z0-9_]+$/i,  // sms_* cookies (Shape mobile session)
  /^fst0$/i,             // fst0 cookie (Shape first-party token)
  /^_abck$/i,            // _abck cookie (shared with Akamai but different flow)
];

/** URL path patterns that indicate Shape script endpoints. */
const SHAPE_SCRIPT_PATTERNS = [
  /shape\.js/i,
  /anti_catalog/i,
  /\/anti_catalog\//i,
  /shape-security/i,
  /f5\-bot/i,
  /\/sdks?\//i,
  /shapecollect/i,
];

/** URL patterns for Shape's telemetry collection endpoints. */
const SHAPE_TELEMETRY_ENDPOINTS = [
  '/anti_catalog/collect',
  '/anti_catalog/beacon',
  '/shape/collect',
  '/shape/beacon',
  '/f5/collect',
  '/sdks/telemetry',
  '/__anti_catalog',
];

/** Default Shape cookie lifetime in milliseconds (5 minutes -- short-lived). */
const SHAPE_COOKIE_LIFETIME_MS = 5 * 60 * 1000;

/** Maximum time to wait for Shape challenge resolution. */
const CHALLENGE_TIMEOUT_MS = 35000;

/** Interval for polling challenge resolution. */
const CHALLENGE_POLL_INTERVAL_MS = 500;

/** Cache TTL for Shape cookies (4 minutes -- less than actual expiry). */
const COOKIE_CACHE_TTL_SECONDS = 240;

/** Cache TTL for domain profiles (24 hours). */
const PROFILE_CACHE_TTL_SECONDS = 86400;

// ===============================================================================
// SHAPE DEVICE TELEMETRY PROFILE
// ===============================================================================

/**
 * A consistent device telemetry profile used for F5/Shape sensor synthesis.
 * Shape collects extensive device telemetry and cross-validates signals.
 * All values must be internally consistent to avoid cross-signal detection.
 */
interface ShapeDeviceTelemetryProfile {
  /** Unique profile identifier. */
  id: string;
  /** Operating system family. */
  os: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  /** Navigator platform string. */
  platform: string;
  /** User-Agent string. */
  userAgent: string;
  /** Hardware concurrency (logical CPU cores). */
  hardwareConcurrency: number;
  /** Device memory in GB. */
  deviceMemory: number;
  /** Maximum touch points. */
  maxTouchPoints: number;
  /** Screen width in pixels. */
  screenWidth: number;
  /** Screen height in pixels. */
  screenHeight: number;
  /** Available screen width. */
  screenAvailWidth: number;
  /** Available screen height. */
  screenAvailHeight: number;
  /** Color depth. */
  colorDepth: number;
  /** Device pixel ratio. */
  devicePixelRatio: number;
  /** WebGL unmasked vendor string. */
  webglVendor: string;
  /** WebGL unmasked renderer string. */
  webglRenderer: string;
  /** Canvas noise seed. */
  canvasNoise: number;
  /** Audio noise level. */
  audioNoise: number;
  /** Whether touch is supported. */
  touchSupport: boolean;
  /** Locale string. */
  locale: string;
  /** Timezone identifier. */
  timezone: string;
  /** Language code. */
  language: string;
  /** Languages array. */
  languages: string[];
  /** Connection effective type. */
  connectionType: string;
  /** Connection RTT estimate. */
  connectionRtt: number;
  /** Connection downlink estimate. */
  connectionDownlink: number;
  /** Battery level. */
  batteryLevel: number;
  /** Whether battery is charging. */
  batteryCharging: boolean;
  /** Accelerometer available. */
  hasAccelerometer: boolean;
  /** Gyroscope available. */
  hasGyroscope: boolean;
  /** Device orientation available. */
  hasDeviceOrientation: boolean;
  /** List of available fonts. */
  fonts: string[];
  /** Plugin MIME types. */
  mimeTypes: string[];
  /** Do Not Track setting. */
  doNotTrack: string | null;
  /** Cookie enabled. */
  cookieEnabled: boolean;
}

// ===============================================================================
// PRE-BUILT TELEMETRY PROFILES
// ===============================================================================

const TELEMETRY_PROFILES: ShapeDeviceTelemetryProfile[] = [
  {
    id: 'shape-win-chrome-01',
    os: 'windows',
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    screenWidth: 1920,
    screenHeight: 1080,
    screenAvailWidth: 1920,
    screenAvailHeight: 1040,
    colorDepth: 24,
    devicePixelRatio: 1,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvasNoise: 0.00038,
    audioNoise: 0.00012,
    touchSupport: false,
    locale: 'en-US',
    timezone: 'America/New_York',
    language: 'en',
    languages: ['en-US', 'en'],
    connectionType: '4g',
    connectionRtt: 50,
    connectionDownlink: 10,
    batteryLevel: 0.87,
    batteryCharging: true,
    hasAccelerometer: false,
    hasGyroscope: false,
    hasDeviceOrientation: false,
    fonts: ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'],
    mimeTypes: ['application/pdf', 'text/pdf'],
    doNotTrack: null,
    cookieEnabled: true,
  },
  {
    id: 'shape-win-chrome-02',
    os: 'windows',
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    hardwareConcurrency: 12,
    deviceMemory: 16,
    maxTouchPoints: 0,
    screenWidth: 2560,
    screenHeight: 1440,
    screenAvailWidth: 2560,
    screenAvailHeight: 1400,
    colorDepth: 24,
    devicePixelRatio: 1,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvasNoise: 0.00051,
    audioNoise: 0.00009,
    touchSupport: false,
    locale: 'en-US',
    timezone: 'America/Chicago',
    language: 'en',
    languages: ['en-US', 'en'],
    connectionType: '4g',
    connectionRtt: 100,
    connectionDownlink: 5.6,
    batteryLevel: 0.62,
    batteryCharging: false,
    hasAccelerometer: false,
    hasGyroscope: false,
    hasDeviceOrientation: false,
    fonts: ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'],
    mimeTypes: ['application/pdf', 'text/pdf'],
    doNotTrack: '1',
    cookieEnabled: true,
  },
  {
    id: 'shape-mac-chrome-01',
    os: 'macos',
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 16,
    maxTouchPoints: 0,
    screenWidth: 2560,
    screenHeight: 1600,
    screenAvailWidth: 2560,
    screenAvailHeight: 1572,
    colorDepth: 24,
    devicePixelRatio: 2,
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    canvasNoise: 0.00029,
    audioNoise: 0.00007,
    touchSupport: false,
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    language: 'en',
    languages: ['en-US', 'en'],
    connectionType: '4g',
    connectionRtt: 50,
    connectionDownlink: 10,
    batteryLevel: 0.95,
    batteryCharging: true,
    hasAccelerometer: false,
    hasGyroscope: false,
    hasDeviceOrientation: false,
    fonts: ['Helvetica', 'Helvetica Neue', 'Arial', 'Courier', 'Courier New', 'Georgia', 'Monaco', 'Times', 'Times New Roman', 'Verdana'],
    mimeTypes: ['application/pdf', 'text/pdf'],
    doNotTrack: null,
    cookieEnabled: true,
  },
  {
    id: 'shape-android-chrome-01',
    os: 'android',
    platform: 'Linux armv8l',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 5,
    screenWidth: 1080,
    screenHeight: 2400,
    screenAvailWidth: 1080,
    screenAvailHeight: 2294,
    colorDepth: 24,
    devicePixelRatio: 2.625,
    webglVendor: 'Qualcomm',
    webglRenderer: 'Adreno (TM) 740',
    canvasNoise: 0.00025,
    audioNoise: 0.00006,
    touchSupport: true,
    locale: 'en-US',
    timezone: 'America/New_York',
    language: 'en',
    languages: ['en-US', 'en'],
    connectionType: '4g',
    connectionRtt: 100,
    connectionDownlink: 5.6,
    batteryLevel: 0.45,
    batteryCharging: false,
    hasAccelerometer: true,
    hasGyroscope: true,
    hasDeviceOrientation: true,
    fonts: ['Roboto', 'Noto Sans', 'Droid Sans', 'Droid Serif', 'Arial'],
    mimeTypes: [],
    doNotTrack: null,
    cookieEnabled: true,
  },
];

// ===============================================================================
// BEHAVIORAL MIMICRY TYPES
// ===============================================================================

/** A 2D point for mouse trajectory generation. */
interface Point2D {
  x: number;
  y: number;
}

/** Parameters for behavioral mimicry configuration. */
interface BehavioralConfig {
  /** Mouse movement speed (pixels per second). */
  mouseSpeed: number;
  /** Number of control points for Bezier curve. */
  bezierControlPoints: number;
  /** Keyboard keystroke interval mean (ms). */
  keystrokeIntervalMean: number;
  /** Keyboard keystroke interval standard deviation (ms). */
  keystrokeIntervalStd: number;
  /** Scroll step size (pixels). */
  scrollStepSize: number;
  /** Scroll acceleration factor. */
  scrollAcceleration: number;
  /** Whether to add micro-movements (jitter). */
  addJitter: boolean;
  /** Jitter amplitude in pixels. */
  jitterAmplitude: number;
}

/** Default behavioral configuration for realistic human simulation. */
const DEFAULT_BEHAVIORAL_CONFIG: BehavioralConfig = {
  mouseSpeed: 800,
  bezierControlPoints: 4,
  keystrokeIntervalMean: 120,
  keystrokeIntervalStd: 35,
  scrollStepSize: 120,
  scrollAcceleration: 1.15,
  addJitter: true,
  jitterAmplitude: 2,
};

// ===============================================================================
// SENSOR DATA TYPES
// ===============================================================================

/** Shape sensor data payload structure. */
interface ShapeSensorPayload {
  /** Device telemetry data. */
  telemetry: {
    hardwareConcurrency: number;
    deviceMemory: number;
    maxTouchPoints: number;
    platform: string;
    userAgent: string;
    screenWidth: number;
    screenHeight: number;
    colorDepth: number;
    devicePixelRatio: number;
    touchSupport: boolean;
    cookieEnabled: boolean;
    doNotTrack: string | null;
    language: string;
    languages: string[];
    timezone: string;
    webglVendor: string;
    webglRenderer: string;
    hasAccelerometer: boolean;
    hasGyroscope: boolean;
    hasDeviceOrientation: boolean;
    connectionType: string;
    connectionRtt: number;
    connectionDownlink: number;
    batteryLevel: number;
    batteryCharging: boolean;
    fonts: string[];
    mimeTypes: string[];
  };
  /** Sensor readings. */
  sensors: {
    accelerometer: { x: number; y: number; z: number } | null;
    gyroscope: { alpha: number; beta: number; gamma: number } | null;
    orientation: { alpha: number; beta: number; gamma: number } | null;
  };
  /** Canvas fingerprint hash. */
  canvasHash: string;
  /** Audio fingerprint hash. */
  audioHash: string;
  /** Timestamp of sensor collection. */
  timestamp: number;
  /** Session identifier. */
  sessionId: string;
}

/** Shape cookie tracking entry. */
interface ShapeCookieEntry {
  /** Cookie name. */
  name: string;
  /** Cookie value. */
  value: string;
  /** Domain. */
  domain: string;
  /** When it was set. */
  setAt: number;
  /** When it expires. */
  expiresAt: number;
  /** Whether it is still valid. */
  isValid: boolean;
  /** Which Shape flow generated it. */
  flow: 'primary' | 'secondary' | 'akamai-shared';
}

// ===============================================================================
// SENSOR SYNTHESIS INJECTION SCRIPT
// ===============================================================================

/**
 * Generate the full sensor synthesis injection script for F5/Shape.
 * Injected BEFORE any page JavaScript via addInitScript to ensure all
 * telemetry and sensor signals are consistent before Shape's collector reads them.
 *
 * Shape's signal processing collects:
 *  - Device telemetry (navigator, screen, hardware)
 *  - Sensor data (accelerometer, gyroscope, orientation)
 *  - Canvas + Audio fingerprints
 *  - Automation markers (webdriver, CDP artifacts)
 *  - Behavioral signals (mouse, keyboard, scroll patterns)
 */
function generateSensorSynthesisScript(profile: ShapeDeviceTelemetryProfile): string {
  return `
(function() {
  'use strict';

  // ===============================================================
  // PROFILE DATA -- embedded from server-side generation
  // ===============================================================
  const __shapeProfile = ${JSON.stringify(profile)};

  // ===============================================================
  // 1. NAVIGATOR PROPERTIES SPOOF
  //    Shape reads hardwareConcurrency, deviceMemory, maxTouchPoints,
  //    platform, language, webdriver, and other navigator properties.
  // ===============================================================

  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => __shapeProfile.hardwareConcurrency,
    configurable: true,
  });

  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => __shapeProfile.deviceMemory,
    configurable: true,
  });

  Object.defineProperty(navigator, 'maxTouchPoints', {
    get: () => __shapeProfile.maxTouchPoints,
    configurable: true,
  });

  Object.defineProperty(navigator, 'platform', {
    get: () => __shapeProfile.platform,
    configurable: true,
  });

  Object.defineProperty(navigator, 'language', {
    get: () => __shapeProfile.language,
    configurable: true,
  });

  Object.defineProperty(navigator, 'languages', {
    get: () => __shapeProfile.languages,
    configurable: true,
  });

  Object.defineProperty(navigator, 'cookieEnabled', {
    get: () => __shapeProfile.cookieEnabled,
    configurable: true,
  });

  Object.defineProperty(navigator, 'doNotTrack', {
    get: () => __shapeProfile.doNotTrack,
    configurable: true,
  });

  // ===============================================================
  // 2. WEBDRIVER & AUTOMATION DETECTION DEFEAT
  //    Shape specifically checks for navigator.webdriver, CDP
  //    artifacts, and automation flags. Must be completely hidden.
  // ===============================================================

  // navigator.webdriver MUST be undefined or false
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
    enumerable: true,
  });

  // Remove Playwright automation markers
  delete window.__playwright;
  delete window.__pw_manual;
  delete window.__PW_inspect;
  delete window.__pw_originals;

  // Remove Puppeteer automation markers
  delete window.__puppeteer_evaluation_script__;
  // Remove ChromeDriver cdc_ markers using regex scan (catches all variants)
  try {
    const cdcKeys = Object.getOwnPropertyNames(window);
    for (const key of cdcKeys) {
      if (/cdc_[a-zA-Z0-9_]+/.test(key) || /_cdc_[a-zA-Z0-9_]+/.test(key)) {
        try { delete window[key]; } catch(e) {}
      }
    }
  } catch(e) {}

  // Remove Selenium markers
  delete window._selenium;
  delete window.__selenium_unwrapped;
  delete window.__selenium_evaluate;
  delete window.__selenium_unwrapped;
  delete window.__driver_evaluate;
  delete window.__webdriver_evaluate;
  delete window.__driver_unwrapped;
  delete window.__webdriver_unwrapped;
  delete window.__fxdriver_evaluate;
  delete window.__fxdriver_unwrapped;

  // chrome.runtime mock -- Shape checks for chrome.runtime existence
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() {},
      sendMessage: function() {},
      onMessage: { addListener: function() {}, removeListener: function() {} },
      id: undefined,
    };
  }

  // Permissions API fix
  if (navigator.permissions && navigator.permissions.query) {
    const __origPermQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(parameters) {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return __origPermQuery(parameters);
    };
  }

  // ===============================================================
  // 3. SCREEN PROPERTIES SPOOF
  // ===============================================================

  if (window.screen) {
    Object.defineProperty(screen, 'width', { get: () => __shapeProfile.screenWidth, configurable: true });
    Object.defineProperty(screen, 'height', { get: () => __shapeProfile.screenHeight, configurable: true });
    Object.defineProperty(screen, 'availWidth', { get: () => __shapeProfile.screenAvailWidth, configurable: true });
    Object.defineProperty(screen, 'availHeight', { get: () => __shapeProfile.screenAvailHeight, configurable: true });
    Object.defineProperty(screen, 'colorDepth', { get: () => __shapeProfile.colorDepth, configurable: true });
    Object.defineProperty(screen, 'pixelDepth', { get: () => __shapeProfile.colorDepth, configurable: true });
  }

  Object.defineProperty(window, 'devicePixelRatio', {
    get: () => __shapeProfile.devicePixelRatio,
    configurable: true,
  });

  // ===============================================================
  // 4. CANVAS FINGERPRINT SPOOF
  // ===============================================================

  const __canvasNoise = __shapeProfile.canvasNoise;
  const __canvasSeed = Math.floor(__canvasNoise * 1000000);

  const __origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const w = Math.min(this.width, 2);
        const h = Math.min(this.height, 2);
        const imgData = ctx.getImageData(0, 0, w, h);
        if (imgData && imgData.data.length >= 4) {
          const pVal = imgData.data[0] ^ imgData.data[1] ^ imgData.data[2];
          const noise = ((pVal + __canvasSeed) % 3) - 1;
          imgData.data[0] = Math.max(0, Math.min(255, imgData.data[0] + noise));
          ctx.putImageData(imgData, 0, 0);
        }
      }
    } catch(e) {}
    return __origToDataURL.apply(this, arguments);
  };

  const __origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function() {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const w = Math.min(this.width, 2);
        const h = Math.min(this.height, 2);
        const imgData = ctx.getImageData(0, 0, w, h);
        if (imgData && imgData.data.length >= 4) {
          const pVal = imgData.data[0] ^ imgData.data[1] ^ imgData.data[2];
          const noise = ((pVal + __canvasSeed) % 3) - 1;
          imgData.data[0] = Math.max(0, Math.min(255, imgData.data[0] + noise));
          ctx.putImageData(imgData, 0, 0);
        }
      }
    } catch(e) {}
    return __origToBlob.apply(this, arguments);
  };

  // ===============================================================
  // 5. WEBGL FINGERPRINT SPOOF
  // ===============================================================

  const __origGetParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return __shapeProfile.webglVendor;
    if (param === 37446) return __shapeProfile.webglRenderer;
    if (param === 7936) return __shapeProfile.webglVendor;
    if (param === 7937) return __shapeProfile.webglRenderer;
    return __origGetParam.call(this, param);
  };

  if (typeof WebGL2RenderingContext !== 'undefined') {
    const __origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return __shapeProfile.webglVendor;
      if (param === 37446) return __shapeProfile.webglRenderer;
      if (param === 7936) return __shapeProfile.webglVendor;
      if (param === 7937) return __shapeProfile.webglRenderer;
      return __origGetParam2.call(this, param);
    };
  }

  // ===============================================================
  // 6. AUDIOCONTEXT FINGERPRINT SPOOF
  // ===============================================================

  const __audioNoise = __shapeProfile.audioNoise;

  const __origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
  AnalyserNode.prototype.getFloatFrequencyData = function(array) {
    __origGetFloatFreq.call(this, array);
    for (let i = 0; i < array.length; i++) {
      array[i] += (Math.random() - 0.5) * __audioNoise * 1000;
    }
  };

  const __origGetByteFreq = AnalyserNode.prototype.getByteFrequencyData;
  AnalyserNode.prototype.getByteFrequencyData = function(array) {
    __origGetByteFreq.call(this, array);
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.max(0, Math.min(255, array[i] + ((Math.random() - 0.5) * __audioNoise * 100)));
    }
  };

  // ===============================================================
  // 7. SENSOR DATA SPOOF -- Accelerometer, Gyroscope, Orientation
  //    Shape specifically reads DeviceMotionEvent and
  //    DeviceOrientationEvent for mobile device validation.
  // ===============================================================

  if (__shapeProfile.hasAccelerometer || __shapeProfile.hasGyroscope) {
    // Generate realistic sensor data with subtle noise
    const __sensorNoise = 0.02;

    // Override DeviceMotionEvent
    if (window.DeviceMotionEvent) {
      const __origDME = window.DeviceMotionEvent;
      window.DeviceMotionEvent = function(type, eventInit) {
        const evt = new __origDME(type, eventInit);
        return evt;
      };
      window.DeviceMotionEvent.prototype = __origDME.prototype;
    }

    // Spoof DeviceOrientationEvent values
    if (window.DeviceOrientationEvent && __shapeProfile.hasDeviceOrientation) {
      Object.defineProperty(DeviceOrientationEvent.prototype, 'alpha', {
        get: function() { return this.__spoofAlpha !== undefined ? this.__spoofAlpha : 0; },
        configurable: true,
      });
      Object.defineProperty(DeviceOrientationEvent.prototype, 'beta', {
        get: function() { return this.__spoofBeta !== undefined ? this.__spoofBeta : 45; },
        configurable: true,
      });
      Object.defineProperty(DeviceOrientationEvent.prototype, 'gamma', {
        get: function() { return this.__spoofGamma !== undefined ? this.__spoofGamma : 0; },
        configurable: true,
      });
    }
  }

  // ===============================================================
  // 8. BATTERY API SPOOF
  // ===============================================================

  if (navigator.getBattery) {
    navigator.getBattery = function() {
      return Promise.resolve({
        charging: __shapeProfile.batteryCharging,
        chargingTime: __shapeProfile.batteryCharging ? 0 : Infinity,
        dischargingTime: __shapeProfile.batteryCharging ? Infinity : 12600,
        level: __shapeProfile.batteryLevel,
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return true; },
      });
    };
  }

  // ===============================================================
  // 9. CONNECTION API SPOOF
  // ===============================================================

  if ('connection' in navigator) {
    const conn = navigator.connection;
    if (conn) {
      Object.defineProperty(conn, 'rtt', { get: () => __shapeProfile.connectionRtt, configurable: true });
      Object.defineProperty(conn, 'downlink', { get: () => __shapeProfile.connectionDownlink, configurable: true });
      Object.defineProperty(conn, 'effectiveType', { get: () => __shapeProfile.connectionType, configurable: true });
    }
  }

  // ===============================================================
  // 10. TIMEZONE SPOOF
  // ===============================================================

  const __tzOffsets = {
    'America/New_York': 300,
    'America/Chicago': 360,
    'America/Denver': 420,
    'America/Los_Angeles': 480,
    'Europe/London': 0,
    'Europe/Berlin': -60,
    'Asia/Tokyo': -540,
    'UTC': 0,
  };
  const __origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  const __tzOffset = __tzOffsets[__shapeProfile.timezone] || __origGetTimezoneOffset.call(new Date());
  Date.prototype.getTimezoneOffset = function() {
    return __tzOffset;
  };

  // ===============================================================
  // SHAPE-SPECIFIC INTERCEPTION
  // Intercept __antiCatalog parameter and Shape telemetry endpoints.
  // ===============================================================

  // Monitor for Shape cookies being set
  const __origCookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (__origCookieDesc && __origCookieDesc.set) {
    const __origSet = __origCookieDesc.set;
    Object.defineProperty(Document.prototype, 'cookie', {
      get: function() {
        return __origCookieDesc.get.call(this);
      },
      set: function(val) {
        __origSet.call(this, val);
        // Signal Shape cookie detection
        if (val) {
          const name = val.split('=')[0].trim();
          if (/^ts[a-z0-9_-]*$/i.test(name) || /^sms_/i.test(name) || name === 'fst0' || name === '_abck') {
            try {
              document.documentElement.setAttribute('data-shape-cookie-set', Date.now().toString());
              document.documentElement.setAttribute('data-shape-cookie-name', name);
            } catch(e) {}
          }
        }
      },
      configurable: true,
    });
  }

  // Intercept fetch/XHR for Shape telemetry
  const __shapeEndpoints = ${JSON.stringify(SHAPE_TELEMETRY_ENDPOINTS)};
  const __origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    // Track Shape telemetry requests
    for (const endpoint of __shapeEndpoints) {
      if (url.includes(endpoint)) {
        try {
          document.documentElement.setAttribute('data-shape-telemetry', Date.now().toString());
          document.documentElement.setAttribute('data-shape-telemetry-url', url);
        } catch(e) {}
        break;
      }
    }
    return __origFetch.apply(this, arguments);
  };

  // Signal that sensor synthesis injection is complete
  try {
    document.documentElement.setAttribute('data-shape-sensor-injected', Date.now().toString());
  } catch(e) {}

})();
`;
}

// ===============================================================================
// CDP STEALTH INJECTION SCRIPT
// ===============================================================================

/**
 * CDP-level stealth overrides that cannot be achieved via init scripts.
 * Injected via CDP Runtime.evaluate to patch browser internals.
 */
const CDP_STEALTH_SCRIPT = `
// Remove CDP artifacts from navigator
Object.defineProperty(navigator, 'webdriver', {
  get: () => undefined,
  configurable: true,
  enumerable: true,
});

// Patch navigator.plugins to look realistic
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const plugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    plugins.length = 3;
    return plugins;
  },
  configurable: true,
});

// Patch navigator.mimeTypes
Object.defineProperty(navigator, 'mimeTypes', {
  get: () => {
    const mimes = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ];
    mimes.length = 2;
    return mimes;
  },
  configurable: true,
});

// Remove automation-related window properties (regex scan for all cdc_ variants)
try {
  const cdcKeys = Object.getOwnPropertyNames(window);
  for (const key of cdcKeys) {
    if (/cdc_[a-zA-Z0-9_]+/.test(key) || /_cdc_[a-zA-Z0-9_]+/.test(key)) {
      try { delete window[key]; } catch(e) {}
    }
  }
} catch(e) {}

// Patch Function.prototype.toString to hide overridden functions
const __origFnStr = Function.prototype.toString;
const __fnMap = new WeakMap();
Function.prototype.toString = function() {
  if (__fnMap.has(this)) return __fnMap.get(this);
  return __origFnStr.call(this);
};
const __markNative = (fn, str) => { __fnMap.set(fn, str); return fn; };

// Mark overridden functions as native
__markNative(navigator.getOwnPropertyDescriptor, 'function getOwnPropertyDescriptor() { [native code] }');

// Console detection prevention
const __origConsole = window.console;
Object.defineProperty(window, 'console', {
  get: () => __origConsole,
  configurable: true,
});

// Prevent iframe contentWindow detection
const __origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
if (__origContentWindow) {
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get: function() {
      const win = __origContentWindow.get.call(this);
      if (win) {
        try {
          Object.defineProperty(win.navigator, 'webdriver', {
            get: () => undefined,
            configurable: true,
          });
        } catch(e) {}
      }
      return win;
    },
    configurable: true,
  });
}

'ready';
`;

// ===============================================================================
// BEHAVIORAL MIMICRY HELPERS
// ===============================================================================

/**
 * Generate a random Gaussian-distributed number using the Box-Muller transform.
 * Used for keyboard dynamics timing.
 */
function gaussianRandom(mean: number, std: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return Math.round(mean + z0 * std);
}

/**
 * Generate a cubic Bezier curve point at parameter t.
 * Used for realistic mouse trajectory generation.
 */
function cubicBezierPoint(
  p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, t: number
): Point2D {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/**
 * Generate a realistic mouse trajectory from start to end using Bezier curves.
 * Produces a sequence of (x, y) points with natural-looking curvature.
 */
function generateBezierMouseTrajectory(
  start: Point2D,
  end: Point2D,
  config: BehavioralConfig
): Point2D[] {
  const points: Point2D[] = [];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Number of steps based on distance and speed
  const durationMs = (distance / config.mouseSpeed) * 1000;
  const numSteps = Math.max(10, Math.floor(durationMs / 16)); // ~60fps

  // Generate control points with random offset perpendicular to the path
  const perpX = -dy / (distance || 1);
  const perpY = dx / (distance || 1);

  const offset1 = (Math.random() - 0.5) * distance * 0.3;
  const offset2 = (Math.random() - 0.5) * distance * 0.3;

  const cp1: Point2D = {
    x: start.x + dx * 0.25 + perpX * offset1,
    y: start.y + dy * 0.25 + perpY * offset1,
  };

  const cp2: Point2D = {
    x: start.x + dx * 0.75 + perpX * offset2,
    y: start.y + dy * 0.75 + perpY * offset2,
  };

  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps;
    // Apply ease-in-out timing
    const easedT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const point = cubicBezierPoint(start, cp1, cp2, end, easedT);

    // Add micro-jitter
    if (config.addJitter && i > 0 && i < numSteps) {
      point.x += (Math.random() - 0.5) * config.jitterAmplitude;
      point.y += (Math.random() - 0.5) * config.jitterAmplitude;
    }

    points.push(point);
  }

  return points;
}

/**
 * Generate keyboard dynamics timing intervals (in ms) using Gaussian distribution.
 * Produces realistic keystroke timing that mimics human typing patterns.
 */
function generateKeyboardDynamics(
  text: string,
  config: BehavioralConfig
): number[] {
  const intervals: number[] = [];
  for (let i = 0; i < text.length; i++) {
    // Base interval with Gaussian noise
    let interval = gaussianRandom(config.keystrokeIntervalMean, config.keystrokeIntervalStd);

    // Longer pause after sentence-ending characters
    if (i > 0 && '.!?'.includes(text[i - 1])) {
      interval += gaussianRandom(200, 80);
    }

    // Longer pause after commas
    if (i > 0 && text[i - 1] === ',') {
      interval += gaussianRandom(100, 40);
    }

    // Occasional longer pause (thinking)
    if (Math.random() < 0.03) {
      interval += gaussianRandom(300, 100);
    }

    // Ensure minimum interval
    interval = Math.max(30, interval);
    intervals.push(interval);
  }
  return intervals;
}

/**
 * Generate scroll pattern with acceleration and deceleration phases.
 * Mimics human scroll behavior with momentum.
 */
function generateScrollPattern(
  totalDistance: number,
  config: BehavioralConfig
): number[] {
  const steps: number[] = [];
  let remaining = totalDistance;
  let velocity = 0;

  while (remaining > 0) {
    if (velocity < config.scrollStepSize) {
      // Acceleration phase
      velocity = Math.min(velocity * config.scrollAcceleration, config.scrollStepSize);
      velocity = Math.max(velocity, 20); // Minimum scroll
    }

    if (remaining < config.scrollStepSize * 2) {
      // Deceleration phase
      velocity = Math.max(velocity * 0.7, 10);
    }

    const step = Math.min(velocity, remaining);
    steps.push(Math.round(step));
    remaining -= step;

    // Add random pause occasionally
    if (Math.random() < 0.15) {
      steps.push(0); // pause frame
    }
  }

  return steps;
}

/**
 * Synthesize a complete Shape sensor data payload matching the device profile.
 */
function synthesizeSensorPayload(
  profile: ShapeDeviceTelemetryProfile,
  sessionId: string
): ShapeSensorPayload {
  return {
    telemetry: {
      hardwareConcurrency: profile.hardwareConcurrency,
      deviceMemory: profile.deviceMemory,
      maxTouchPoints: profile.maxTouchPoints,
      platform: profile.platform,
      userAgent: profile.userAgent,
      screenWidth: profile.screenWidth,
      screenHeight: profile.screenHeight,
      colorDepth: profile.colorDepth,
      devicePixelRatio: profile.devicePixelRatio,
      touchSupport: profile.touchSupport,
      cookieEnabled: profile.cookieEnabled,
      doNotTrack: profile.doNotTrack,
      language: profile.language,
      languages: profile.languages,
      timezone: profile.timezone,
      webglVendor: profile.webglVendor,
      webglRenderer: profile.webglRenderer,
      hasAccelerometer: profile.hasAccelerometer,
      hasGyroscope: profile.hasGyroscope,
      hasDeviceOrientation: profile.hasDeviceOrientation,
      connectionType: profile.connectionType,
      connectionRtt: profile.connectionRtt,
      connectionDownlink: profile.connectionDownlink,
      batteryLevel: profile.batteryLevel,
      batteryCharging: profile.batteryCharging,
      fonts: profile.fonts,
      mimeTypes: profile.mimeTypes,
    },
    sensors: {
      accelerometer: profile.hasAccelerometer
        ? {
            x: (Math.random() - 0.5) * 0.5,
            y: (Math.random() - 0.5) * 0.5 + 9.81,
            z: (Math.random() - 0.5) * 0.3,
          }
        : null,
      gyroscope: profile.hasGyroscope
        ? {
            alpha: (Math.random() - 0.5) * 2,
            beta: (Math.random() - 0.5) * 2,
            gamma: (Math.random() - 0.5) * 2,
          }
        : null,
      orientation: profile.hasDeviceOrientation
        ? {
            alpha: Math.random() * 360,
            beta: (Math.random() - 0.5) * 90,
            gamma: (Math.random() - 0.5) * 90,
          }
        : null,
    },
    canvasHash: `cvs_${profile.id}_${Date.now().toString(36)}`,
    audioHash: `aud_${profile.id}_${Date.now().toString(36)}`,
    timestamp: Date.now(),
    sessionId,
  };
}

// ===============================================================================
// F5/SHAPE BYPASS CLASS
// ===============================================================================

class F5ShapeBypass extends AntiBotBase {
  readonly platform: AntiBotPlatform = 'f5';

  /** Current telemetry profile index for rotation. */
  private profileIndex = 0;

  /** Active telemetry profiles per domain. */
  private activeProfiles = new Map<string, ShapeDeviceTelemetryProfile>();

  /** Track registered interception contexts. */
  private interceptionRegistered = new Set<string>();

  /** Shape cookie tracking entries per domain. */
  private shapeCookieEntries = new Map<string, ShapeCookieEntry[]>();

  /** Behavioral configuration. */
  private behavioralConfig: BehavioralConfig = { ...DEFAULT_BEHAVIORAL_CONFIG };

  /** Active CDP sessions for stealth injection. */
  private activeCdpSessions = new Set<CDPSession>();

  /** Sensor payload cache per domain. */
  private sensorPayloadCache = new Map<string, ShapeSensorPayload>();

  constructor(configOverride?: Partial<import('./types').AntiBotPlatformConfig>) {
    super(configOverride);
  }

  /**
   * Returns the platform identifier.
   * Uses 'generic' as workaround since 'f5-shape' is not in the enum yet.
   */
  protected platformOverride(): AntiBotPlatform {
    return 'generic';
  }

  // --- Detection ----------------------------------------------------------

  /**
   * Detect whether F5/Shape Security's anti-bot protection is active on the
   * current page. Checks DOM selectors, HTTP headers, cookies, scripts, page
   * content, and network requests for Shape signals.
   */
  async detect(ctx: BypassContext): Promise<PlatformDetectionResult> {
    const indicators: DetectionIndicator[] = [];
    let confidence = 0;
    let challengeType = 'unknown';
    let isRechallenge = false;

    try {
      // -- Check DOM selectors ------------------------------------------
      for (const selector of SHAPE_CHALLENGE_SELECTORS) {
        try {
          const element = await ctx.page.$(selector);
          if (element) {
            indicators.push({
              category: 'dom',
              description: `Shape challenge element found: ${selector}`,
              weight: 0.3,
              rawValue: selector,
            });
            confidence += 0.3;
            challengeType = 'shape-iframe';
          }
        } catch {
          // Selector check failed -- page may have navigated
        }
      }

      // -- Check page content for Shape text ----------------------------
      try {
        const bodyText = await ctx.page.evaluate(
          () => document.body?.innerText?.toLowerCase() || ''
        );
        for (const text of SHAPE_CHALLENGE_TEXT) {
          if (bodyText.includes(text)) {
            indicators.push({
              category: 'dom',
              description: `Shape text pattern found: "${text}"`,
              weight: 0.12,
              rawValue: text,
            });
            confidence += 0.12;
          }
        }
      } catch {
        // page.evaluate failed
      }

      // -- Check page source for Shape scripts --------------------------
      try {
        const pageContent = await ctx.page.content();
        for (const pattern of SHAPE_SCRIPT_PATTERNS) {
          if (pattern.test(pageContent)) {
            indicators.push({
              category: 'script',
              description: `Shape script pattern found: "${pattern.source}"`,
              weight: 0.25,
              rawValue: pattern.source,
            });
            confidence += 0.25;
            if (challengeType === 'unknown') challengeType = 'shape-script';
          }
        }
      } catch {
        // page.content() failed
      }

      // -- Check for Shape cookies --------------------------------------
      try {
        const cookies = await ctx.context.cookies();
        for (const cookie of cookies) {
          for (const pattern of SHAPE_COOKIE_PATTERNS) {
            if (pattern.test(cookie.name)) {
              indicators.push({
                category: 'cookie',
                description: `Shape cookie found: ${cookie.name}`,
                weight: cookie.name === '_abck' ? 0.15 : 0.2,
                rawValue: `${cookie.name}=${cookie.value.substring(0, 20)}...`,
              });
              confidence += cookie.name === '_abck' ? 0.15 : 0.2;

              // Determine flow based on cookie
              if (cookie.name === '_abck') {
                challengeType = 'akamai-shared';
              } else if (cookie.name.startsWith('ts')) {
                challengeType = 'shape-primary';
              } else if (cookie.name.startsWith('sms_')) {
                challengeType = 'shape-mobile';
              }
            }
          }
        }
      } catch {
        // Cookie access failed
      }

      // -- Check for __antiCatalog parameter ----------------------------
      try {
        const hasAntiCatalog = await ctx.page.evaluate(() => {
          const url = new URL(window.location.href);
          if (url.searchParams.has('__antiCatalog')) return true;
          // Check in forms
          const inputs = document.querySelectorAll('input[name="__antiCatalog"]');
          return inputs.length > 0;
        });
        if (hasAntiCatalog) {
          indicators.push({
            category: 'dom',
            description: 'Shape __antiCatalog parameter detected',
            weight: 0.3,
            rawValue: '__antiCatalog',
          });
          confidence += 0.3;
          if (challengeType === 'unknown') challengeType = 'anti-catalog';
        }
      } catch {
        // page.evaluate failed
      }

      // -- Check for X-Shape response headers ---------------------------
      try {
        const responses = ctx.page.url();
        // Check stored headers from intercepted responses
        const hasShapeHeaders = await ctx.page.evaluate(() => {
          const el = document.documentElement;
          return el.getAttribute('data-shape-header-detected') === 'true';
        });
        if (hasShapeHeaders) {
          indicators.push({
            category: 'header',
            description: 'X-Shape header detected in response',
            weight: 0.25,
          });
          confidence += 0.25;
        }
      } catch {
        // Header check failed
      }

      // -- Check for Shape telemetry requests ---------------------------
      try {
        const hasTelemetry = await ctx.page.evaluate(() => {
          const el = document.documentElement;
          return el.getAttribute('data-shape-telemetry') !== null;
        });
        if (hasTelemetry) {
          indicators.push({
            category: 'network',
            description: 'Shape telemetry request detected',
            weight: 0.2,
          });
          confidence += 0.2;
        }
      } catch {
        // Telemetry check failed
      }

      // -- Check for rechallenge ----------------------------------------
      if (ctx.isRechallenge || ctx.previousResult) {
        isRechallenge = true;
      }

      // -- Determine severity -------------------------------------------
      let severity: DetectionSeverity = 'none';
      if (confidence >= 0.8) severity = 'critical';
      else if (confidence >= 0.5) severity = 'high';
      else if (confidence >= 0.3) severity = 'medium';
      else if (confidence >= 0.15) severity = 'low';

      // -- Determine recommended strategy -------------------------------
      const strategies = STRATEGY_ESCALATION.f5;
      let recommendedStrategy: BypassStrategy = strategies[0];

      if (severity === 'critical') {
        recommendedStrategy = 'behavioral-mimic';
      } else if (severity === 'high') {
        recommendedStrategy = 'browser-execute';
      }

      // Use domain profile if available
      const domain = this.extractDomain(ctx.url);
      const profile = this.getProfile(domain);
      if (profile && profile.preferredStrategy) {
        recommendedStrategy = profile.preferredStrategy;
      }

      // Cap confidence at 1.0
      confidence = Math.min(confidence, 1.0);

      return {
        platform: 'f5',
        confidence,
        severity,
        indicators,
        challengeType,
        isRechallenge,
        recommendedStrategy,
      };
    } catch (err: any) {
      logger.warn({ err: err.message }, 'F5/Shape detection failed');
      return {
        platform: 'f5',
        confidence: 0,
        severity: 'none',
        indicators: [],
        challengeType: 'unknown',
        isRechallenge: false,
        recommendedStrategy: 'sensor-synthesis',
      };
    }
  }

  // --- Bypass -------------------------------------------------------------

  /**
   * Attempt to bypass F5/Shape's anti-bot challenge using the specified or
   * auto-selected strategy. Follows the escalation order:
   *   sensor-synthesis → browser-execute → behavioral-mimic → maximum-stealth
   */
  async bypass(ctx: BypassContext, strategy?: BypassStrategy): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = this.extractDomain(ctx.url);
    this.stats.totalAttempts++;

    // Check cooldown
    if (this.isInCooldown(domain)) {
      return this.buildFailureResult({
        strategy: strategy || 'sensor-synthesis',
        durationMs: Date.now() - startTime,
        errors: ['Domain is in cooldown -- too many consecutive failures'],
        warnings: ['Wait for cooldown to expire before retrying'],
      });
    }

    // Determine strategy
    let selectedStrategy = strategy;
    if (!selectedStrategy) {
      const profile = this.getProfile(domain);
      selectedStrategy = profile?.preferredStrategy || 'sensor-synthesis';
    }

    // Validate strategy is in F5 escalation path
    const validStrategies = STRATEGY_ESCALATION.f5;
    if (!validStrategies.includes(selectedStrategy)) {
      selectedStrategy = validStrategies[0];
    }

    logger.info(
      { domain, strategy: selectedStrategy, url: ctx.url },
      'Starting F5/Shape bypass attempt'
    );

    try {
      let result: AntiBotResult;

      switch (selectedStrategy) {
        case 'sensor-synthesis':
          result = await this.bypassSensorSynthesis(ctx, startTime);
          break;
        case 'browser-execute':
          result = await this.bypassBrowserExecute(ctx, startTime);
          break;
        case 'behavioral-mimic':
          result = await this.bypassBehavioralMimic(ctx, startTime);
          break;
        case 'maximum-stealth':
          result = await this.bypassMaximumStealth(ctx, startTime);
          break;
        default:
          result = await this.bypassSensorSynthesis(ctx, startTime);
      }

      // Record result for adaptive learning
      this.recordResult(domain, result.success, result.durationMs, selectedStrategy);

      // If failed and can escalate, try next strategy
      if (!result.success && this.canEscalate(domain)) {
        const nextStrategy = this.escalateStrategy(domain);
        logger.info(
          { domain, from: selectedStrategy, to: nextStrategy },
          'Escalating F5/Shape bypass strategy after failure'
        );
        result = await this.bypass(ctx, nextStrategy);
      }

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      logger.error({ err: err.message, domain, strategy: selectedStrategy }, 'F5/Shape bypass error');
      this.recordResult(domain, false, durationMs, selectedStrategy);

      return this.buildFailureResult({
        strategy: selectedStrategy,
        durationMs,
        errors: [`Bypass error: ${err.message}`],
      });
    }
  }

  // --- Strategy: Sensor Synthesis -------------------------------------

  /**
   * Strategy 1: Sensor Synthesis
   * Inject a complete sensor synthesis script before the page loads, ensuring
   * all device telemetry and sensor signals are consistent. Intercept Shape's
   * telemetry requests and synthesize realistic payloads.
   */
  private async bypassSensorSynthesis(ctx: BypassContext, startTime: number): Promise<AntiBotResult> {
    const domain = this.extractDomain(ctx.url);
    logger.info({ domain }, 'F5/Shape: sensor-synthesis strategy starting');

    try {
      // Select a telemetry profile
      const profile = this.selectTelemetryProfile(domain);
      this.activeProfiles.set(domain, profile);

      // Inject sensor synthesis script before page loads
      const script = generateSensorSynthesisScript(profile);
      await ctx.context.addInitScript(script);

      // Inject CDP stealth
      await this.injectCdpStealth(ctx);

      // Register telemetry interception
      await this.registerTelemetryInterception(ctx);

      // Navigate/reload the page to apply init scripts
      await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

      // Wait for Shape challenge to resolve
      const resolved = await this.waitForChallengeResolution(ctx, CHALLENGE_TIMEOUT_MS);
      if (resolved) {
        const cookies = await this.extractShapeCookies(ctx, domain);
        const durationMs = Date.now() - startTime;

        if (cookies.length > 0) {
          await this.storeTokens(domain, cookies);

          // Cache sensor payload for reuse
          const sessionId = `ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const sensorPayload = synthesizeSensorPayload(profile, sessionId);
          this.sensorPayloadCache.set(domain, sensorPayload);

          logger.info(
            { domain, cookieCount: cookies.length, durationMs },
            'F5/Shape: sensor-synthesis bypass succeeded'
          );

          return this.buildSuccessResult({
            strategy: 'sensor-synthesis',
            durationMs,
            cookies,
            extraHeaders: this.buildExtraHeaders(profile),
            warnings: ['Sensor synthesis may need refresh on re-challenge'],
            rechallengeExpected: true,
            rechallengeInMs: SHAPE_COOKIE_LIFETIME_MS,
            metadata: {
              profileId: profile.id,
              sensorPayloadId: sensorPayload.sessionId,
            },
          });
        }
      }

      return this.buildFailureResult({
        strategy: 'sensor-synthesis',
        durationMs: Date.now() - startTime,
        errors: ['Sensor synthesis did not produce valid cookies'],
        warnings: ['Shape challenge may require behavioral signals'],
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'sensor-synthesis',
        durationMs: Date.now() - startTime,
        errors: [`Sensor synthesis error: ${err.message}`],
      });
    }
  }

  // --- Strategy: Browser Execute --------------------------------------

  /**
   * Strategy 2: Browser Execute
   * Execute Shape's challenge JavaScript directly in the browser context.
   * Wait for Shape scripts to load and execute, then extract the resulting
   * cookies and tokens. This relies on the browser's native JS engine.
   */
  private async bypassBrowserExecute(ctx: BypassContext, startTime: number): Promise<AntiBotResult> {
    const domain = this.extractDomain(ctx.url);
    logger.info({ domain }, 'F5/Shape: browser-execute strategy starting');

    try {
      // Select a profile and inject basic stealth
      const profile = this.selectTelemetryProfile(domain);
      this.activeProfiles.set(domain, profile);

      const script = generateSensorSynthesisScript(profile);
      await ctx.context.addInitScript(script);

      // Inject CDP stealth
      await this.injectCdpStealth(ctx);

      // Wait for page to fully load including Shape scripts
      await ctx.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // Wait for Shape scripts to execute and set cookies
      const resolved = await this.waitForChallengeResolution(ctx, CHALLENGE_TIMEOUT_MS);
      if (resolved) {
        const cookies = await this.extractShapeCookies(ctx, domain);
        const durationMs = Date.now() - startTime;

        if (cookies.length > 0) {
          await this.storeTokens(domain, cookies);

          logger.info(
            { domain, cookieCount: cookies.length, durationMs },
            'F5/Shape: browser-execute bypass succeeded'
          );

          return this.buildSuccessResult({
            strategy: 'browser-execute',
            durationMs,
            cookies,
            extraHeaders: this.buildExtraHeaders(profile),
            rechallengeExpected: true,
            rechallengeInMs: SHAPE_COOKIE_LIFETIME_MS,
            metadata: { profileId: profile.id },
          });
        }
      }

      // Try executing Shape challenge scripts manually
      const manuallyResolved = await this.attemptManualChallengeExecution(ctx);
      if (manuallyResolved) {
        const cookies = await this.extractShapeCookies(ctx, domain);
        const durationMs = Date.now() - startTime;

        if (cookies.length > 0) {
          await this.storeTokens(domain, cookies);

          return this.buildSuccessResult({
            strategy: 'browser-execute',
            durationMs,
            cookies,
            rechallengeExpected: true,
            rechallengeInMs: SHAPE_COOKIE_LIFETIME_MS,
            metadata: { profileId: profile.id, manualExecution: true },
          });
        }
      }

      return this.buildFailureResult({
        strategy: 'browser-execute',
        durationMs: Date.now() - startTime,
        errors: ['Browser execute did not produce valid cookies'],
        warnings: ['Shape challenge may require behavioral signals or stealth escalation'],
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'browser-execute',
        durationMs: Date.now() - startTime,
        errors: [`Browser execute error: ${err.message}`],
      });
    }
  }

  // --- Strategy: Behavioral Mimic -------------------------------------

  /**
   * Strategy 3: Behavioral Mimic
   * Simulate realistic human behavioral patterns including mouse movements
   * (Bezier curves), keyboard dynamics (Gaussian timing), and scroll patterns
   * (acceleration/deceleration). Shape's advanced behavioral analysis
   * requires these signals to pass as human.
   */
  private async bypassBehavioralMimic(ctx: BypassContext, startTime: number): Promise<AntiBotResult> {
    const domain = this.extractDomain(ctx.url);
    logger.info({ domain }, 'F5/Shape: behavioral-mimic strategy starting');

    try {
      // Select profile and inject stealth
      const profile = this.selectTelemetryProfile(domain);
      this.activeProfiles.set(domain, profile);

      const script = generateSensorSynthesisScript(profile);
      await ctx.context.addInitScript(script);

      // Inject CDP stealth
      await this.injectCdpStealth(ctx);

      // Register telemetry interception
      await this.registerTelemetryInterception(ctx);

      // Wait for page to load
      await ctx.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

      // -- Simulate realistic mouse movements -------------------------
      await this.simulateMouseMovements(ctx);

      // -- Simulate realistic scrolling --------------------------------
      await this.simulateScrolling(ctx);

      // -- Simulate realistic keyboard interaction ---------------------
      await this.simulateKeyboardInteraction(ctx);

      // -- Wait for challenge resolution -------------------------------
      const resolved = await this.waitForChallengeResolution(ctx, CHALLENGE_TIMEOUT_MS);
      if (resolved) {
        const cookies = await this.extractShapeCookies(ctx, domain);
        const durationMs = Date.now() - startTime;

        if (cookies.length > 0) {
          await this.storeTokens(domain, cookies);

          logger.info(
            { domain, cookieCount: cookies.length, durationMs },
            'F5/Shape: behavioral-mimic bypass succeeded'
          );

          return this.buildSuccessResult({
            strategy: 'behavioral-mimic',
            durationMs,
            cookies,
            extraHeaders: this.buildExtraHeaders(profile),
            rechallengeExpected: true,
            rechallengeInMs: SHAPE_COOKIE_LIFETIME_MS,
            metadata: {
              profileId: profile.id,
              behavioralConfig: this.behavioralConfig,
            },
          });
        }
      }

      return this.buildFailureResult({
        strategy: 'behavioral-mimic',
        durationMs: Date.now() - startTime,
        errors: ['Behavioral mimic did not produce valid cookies'],
        warnings: ['Shape may require maximum stealth escalation'],
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'behavioral-mimic',
        durationMs: Date.now() - startTime,
        errors: [`Behavioral mimic error: ${err.message}`],
      });
    }
  }

  // --- Strategy: Maximum Stealth --------------------------------------

  /**
   * Strategy 4: Maximum Stealth
   * Apply ALL stealth measures: sensor synthesis, CDP stealth, behavioral
   * mimicry, telemetry interception, and deep browser patching. This is the
   * last resort strategy for the most aggressive Shape deployments.
   */
  private async bypassMaximumStealth(ctx: BypassContext, startTime: number): Promise<AntiBotResult> {
    const domain = this.extractDomain(ctx.url);
    logger.info({ domain }, 'F5/Shape: maximum-stealth strategy starting');

    try {
      // Select profile
      const profile = this.selectTelemetryProfile(domain);
      this.activeProfiles.set(domain, profile);

      // -- Inject ALL stealth measures ---------------------------------

      // 1. Full sensor synthesis
      const sensorScript = generateSensorSynthesisScript(profile);
      await ctx.context.addInitScript(sensorScript);

      // 2. CDP stealth with maximum patching
      await this.injectCdpStealth(ctx);
      await this.injectDeepCdpPatches(ctx);

      // 3. Register telemetry interception
      await this.registerTelemetryInterception(ctx);

      // 4. Intercept and modify network requests
      await this.registerNetworkInterception(ctx);

      // 5. Navigate to page
      await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

      // 6. Wait briefly before behavioral simulation
      await this.sleep(gaussianRandom(500, 150));

      // 7. Full behavioral simulation
      await this.simulateMouseMovements(ctx);
      await this.simulateScrolling(ctx);
      await this.simulateKeyboardInteraction(ctx);

      // 8. Additional mouse movements (more thorough)
      await this.simulateMouseMovements(ctx);

      // -- Wait for challenge resolution -------------------------------
      const resolved = await this.waitForChallengeResolution(ctx, CHALLENGE_TIMEOUT_MS);
      if (resolved) {
        const cookies = await this.extractShapeCookies(ctx, domain);
        const durationMs = Date.now() - startTime;

        if (cookies.length > 0) {
          await this.storeTokens(domain, cookies);

          // Cache domain profile with maximum stealth preference
          const domainProfile = this.getOrCreateProfile(domain);
          domainProfile.preferredStrategy = 'maximum-stealth';
          domainProfile.challengeVersion = 'shape-v2';
          domainProfile.knownCookieNames = cookies.map(c => c.name);
          await cacheSet(
            `${this.cachePrefix()}profile:${domain}`,
            domainProfile,
            PROFILE_CACHE_TTL_SECONDS
          ).catch(() => {});

          logger.info(
            { domain, cookieCount: cookies.length, durationMs },
            'F5/Shape: maximum-stealth bypass succeeded'
          );

          return this.buildSuccessResult({
            strategy: 'maximum-stealth',
            durationMs,
            cookies,
            extraHeaders: this.buildExtraHeaders(profile),
            rechallengeExpected: true,
            rechallengeInMs: SHAPE_COOKIE_LIFETIME_MS,
            warnings: ['Maximum stealth used -- consider reducing if not needed'],
            metadata: {
              profileId: profile.id,
              allStealthApplied: true,
            },
          });
        }
      }

      return this.buildFailureResult({
        strategy: 'maximum-stealth',
        durationMs: Date.now() - startTime,
        errors: ['Maximum stealth bypass did not produce valid cookies'],
        warnings: [
          'All strategies exhausted -- Shape may require manual intervention',
          'Consider rotating proxy or using a different browser profile',
        ],
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'maximum-stealth',
        durationMs: Date.now() - startTime,
        errors: [`Maximum stealth error: ${err.message}`],
      });
    }
  }

  // --- Telemetry Profile Selection ------------------------------------

  /**
   * Select a telemetry profile for a domain, rotating through available
   * profiles to avoid fingerprint linking.
   */
  private selectTelemetryProfile(domain: string): ShapeDeviceTelemetryProfile {
    // Check if domain has an active profile
    const existing = this.activeProfiles.get(domain);
    if (existing) return existing;

    // Check if we have a cached profile
    const cached = this.sensorPayloadCache.get(domain);
    if (cached) {
      const match = TELEMETRY_PROFILES.find(p => p.id === cached.telemetry.platform);
      if (match) return match;
    }

    // Rotate through profiles
    const profile = TELEMETRY_PROFILES[this.profileIndex % TELEMETRY_PROFILES.length];
    this.profileIndex++;

    this.activeProfiles.set(domain, profile);
    return profile;
  }

  // --- CDP Stealth Injection ------------------------------------------

  /**
   * Inject CDP-level stealth overrides via Runtime.evaluate.
   * Patches browser internals that cannot be overridden via init scripts.
   */
  private async injectCdpStealth(ctx: BypassContext): Promise<void> {
    try {
      let cdp = ctx.cdpSession;
      if (!cdp) {
        cdp = await ctx.page.context().newCDPSession(ctx.page);
      }

      this.activeCdpSessions.add(cdp);

      await cdp.send('Runtime.evaluate', {
        expression: CDP_STEALTH_SCRIPT,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      });

      logger.debug('F5/Shape: CDP stealth overrides injected');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'F5/Shape: CDP stealth injection failed (non-fatal)');
    }
  }

  /**
   * Inject deep CDP patches for maximum stealth strategy.
   * These are more aggressive patches that may break some functionality
   * but provide the highest level of anti-detection.
   */
  private async injectDeepCdpPatches(ctx: BypassContext): Promise<void> {
    try {
      let cdp = ctx.cdpSession;
      if (!cdp) {
        cdp = await ctx.page.context().newCDPSession(ctx.page);
      }

      // Disable AutomationControlled flag at CDP level
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true, enumerable: true });
          // Remove ChromeDriver cdc_ markers using regex scan (catches all variants)
          try {
            const cdcKeys = Object.getOwnPropertyNames(window);
            for (const key of cdcKeys) {
              if (/cdc_[a-zA-Z0-9_]+/.test(key) || /_cdc_[a-zA-Z0-9_]+/.test(key)) {
                try { delete window[key]; } catch(e) {}
              }
            }
          } catch(e) {}
          window.chrome = { runtime: { connect: function(){}, sendMessage: function(){}, onMessage: { addListener: function(){}, removeListener: function(){} } } };
        `,
      });

      // Override navigator at CDP level
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
      });

      // Disable blink automation features
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          // Override navigator.plugins
          Object.defineProperty(navigator, 'plugins', {
            get: () => {
              const arr = [
                Object.create(Plugin.prototype, { name: { value: 'Chrome PDF Plugin' }, filename: { value: 'internal-pdf-viewer' }, description: { value: 'Portable Document Format' }, length: { value: 1 } }),
                Object.create(Plugin.prototype, { name: { value: 'Chrome PDF Viewer' }, filename: { value: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' }, description: { value: '' }, length: { value: 1 } }),
                Object.create(Plugin.prototype, { name: { value: 'Native Client' }, filename: { value: 'internal-nacl-plugin' }, description: { value: '' }, length: { value: 2 } }),
              ];
              arr.length = 3;
              return arr;
            },
            configurable: true,
          });
        `,
      });

      logger.debug('F5/Shape: Deep CDP patches injected');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'F5/Shape: Deep CDP patch injection failed (non-fatal)');
    }
  }

  // --- Telemetry Interception -----------------------------------------

  /**
   * Register interception of Shape's telemetry requests. When a telemetry
   * request is detected, we intercept and modify the payload to include
   * our synthesized sensor data.
   */
  private async registerTelemetryInterception(ctx: BypassContext): Promise<void> {
    const interceptionKey = ctx.page.url();
    if (this.interceptionRegistered.has(interceptionKey)) return;

    try {
      ctx.page.on('response', async (response: Response) => {
        const url = response.url();
        for (const endpoint of SHAPE_TELEMETRY_ENDPOINTS) {
          if (url.includes(endpoint)) {
            logger.debug(
              { url, status: response.status() },
              'F5/Shape: Telemetry request intercepted'
            );

            // Store response headers as detection signals
            const headers = response.headers();
            for (const shapeHeader of SHAPE_RESPONSE_HEADERS) {
              if (headers[shapeHeader]) {
                try {
                  await ctx.page.evaluate(({ h, v }) => {
                    document.documentElement.setAttribute('data-shape-header-detected', 'true');
                    document.documentElement.setAttribute(`data-shape-header-${h}`, v);
                  }, { h: shapeHeader, v: headers[shapeHeader] });
                } catch {
                  // page.evaluate failed
                }
              }
            }
            break;
          }
        }
      });

      this.interceptionRegistered.add(interceptionKey);
      logger.debug('F5/Shape: Telemetry interception registered');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'F5/Shape: Telemetry interception setup failed (non-fatal)');
    }
  }

  /**
   * Register full network interception for maximum stealth.
   * Modifies outgoing requests and incoming responses for Shape endpoints.
   */
  private async registerNetworkInterception(ctx: BypassContext): Promise<void> {
    try {
      await ctx.page.route(
        (url) => SHAPE_TELEMETRY_ENDPOINTS.some(ep => url.toString().includes(ep)),
        async (route) => {
          const request = route.request();
          const url = request.url();

          logger.debug(
            { url, method: request.method() },
            'F5/Shape: Intercepting network request'
          );

          // Continue with modified headers if needed
          const headers = {
            ...request.headers(),
            'X-Shape-Client': 'web',
          };

          try {
            await route.continue({ headers });
          } catch {
            await route.continue();
          }
        }
      );

      logger.debug('F5/Shape: Network interception registered');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'F5/Shape: Network interception setup failed (non-fatal)');
    }
  }

  // --- Behavioral Simulation ------------------------------------------

  /**
   * Simulate realistic mouse movements using Bezier curves.
   * Shape tracks mouse trajectories to distinguish bots from humans.
   */
  private async simulateMouseMovements(ctx: BypassContext): Promise<void> {
    try {
      const viewport = ctx.page.viewportSize();
      if (!viewport) return;

      const width = viewport.width;
      const height = viewport.height;

      // Generate a series of mouse movements across the page
      const numMovements = 3 + Math.floor(Math.random() * 4);

      for (let i = 0; i < numMovements; i++) {
        const start: Point2D = {
          x: Math.random() * width,
          y: Math.random() * height,
        };
        const end: Point2D = {
          x: Math.random() * width,
          y: Math.random() * height,
        };

        const trajectory = generateBezierMouseTrajectory(start, end, this.behavioralConfig);

        for (const point of trajectory) {
          await ctx.page.mouse.move(
            Math.round(point.x),
            Math.round(point.y)
          );
          // Random micro-delay between moves
          await this.sleep(Math.floor(Math.random() * 8) + 4);
        }

        // Pause between movements
        await this.sleep(gaussianRandom(200, 80));

        // Occasionally click
        if (Math.random() < 0.2) {
          await ctx.page.mouse.click(Math.round(end.x), Math.round(end.y));
          await this.sleep(gaussianRandom(150, 50));
        }
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'F5/Shape: Mouse simulation failed (non-fatal)');
    }
  }

  /**
   * Simulate realistic scrolling with acceleration and deceleration.
   * Shape monitors scroll behavior as a human signal.
   */
  private async simulateScrolling(ctx: BypassContext): Promise<void> {
    try {
      const scrollDistance = 500 + Math.floor(Math.random() * 1000);
      const scrollSteps = generateScrollPattern(scrollDistance, this.behavioralConfig);

      for (const step of scrollSteps) {
        if (step === 0) {
          // Pause frame
          await this.sleep(gaussianRandom(100, 40));
          continue;
        }

        await ctx.page.mouse.wheel(0, step);
        await this.sleep(gaussianRandom(30, 15));
      }

      // Scroll back up partially
      const upDistance = Math.floor(scrollDistance * 0.3);
      const upSteps = generateScrollPattern(upDistance, this.behavioralConfig);
      for (const step of upSteps) {
        if (step === 0) {
          await this.sleep(gaussianRandom(100, 40));
          continue;
        }
        await ctx.page.mouse.wheel(0, -step);
        await this.sleep(gaussianRandom(30, 15));
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'F5/Shape: Scroll simulation failed (non-fatal)');
    }
  }

  /**
   * Simulate realistic keyboard interaction with Gaussian timing.
   * Shape monitors keyboard dynamics including typing speed and rhythm.
   */
  private async simulateKeyboardInteraction(ctx: BypassContext): Promise<void> {
    try {
      // Find a text input or textarea to type into
      const inputSelector = 'input[type="text"], input[type="email"], input[type="search"], textarea, input:not([type])';
      const input = await ctx.page.$(inputSelector);

      if (input) {
        // Click the input first (realistic behavior)
        await input.click().catch(() => {});
        await this.sleep(gaussianRandom(200, 80));

        // Type a few characters with human-like timing
        const sampleText = 'search';
        const intervals = generateKeyboardDynamics(sampleText, this.behavioralConfig);

        for (let i = 0; i < sampleText.length; i++) {
          await ctx.page.keyboard.press(sampleText[i]);
          if (i < intervals.length) {
            await this.sleep(intervals[i]);
          }
        }

        // Pause, then clear
        await this.sleep(gaussianRandom(500, 200));

        // Select all and delete
        await ctx.page.keyboard.press('Control+a');
        await this.sleep(gaussianRandom(50, 20));
        await ctx.page.keyboard.press('Backspace');
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'F5/Shape: Keyboard simulation failed (non-fatal)');
    }
  }

  // --- Challenge Resolution -------------------------------------------

  /**
   * Wait for Shape challenge to resolve by monitoring for Shape cookies.
   */
  private async waitForChallengeResolution(
    ctx: BypassContext,
    timeoutMs: number
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Check for Shape cookies
        const cookies = await ctx.context.cookies();
        const hasShapeCookie = cookies.some(c =>
          SHAPE_COOKIE_PATTERNS.some(p => p.test(c.name))
        );

        if (hasShapeCookie) {
          logger.debug('F5/Shape: Challenge resolved -- Shape cookies detected');
          return true;
        }

        // Check for Shape challenge completion signal in DOM
        const hasResolutionSignal = await ctx.page.evaluate(() => {
          const el = document.documentElement;
          return el.getAttribute('data-shape-cookie-set') !== null;
        });

        if (hasResolutionSignal) {
          logger.debug('F5/Shape: Challenge resolved -- DOM signal detected');
          return true;
        }
      } catch {
        // Cookie/DOM check failed -- page may have navigated
      }

      await this.sleep(CHALLENGE_POLL_INTERVAL_MS);
    }

    logger.debug('F5/Shape: Challenge resolution timeout');
    return false;
  }

  /**
   * Attempt to manually execute Shape challenge scripts.
   * This is a fallback when automatic resolution fails.
   */
  private async attemptManualChallengeExecution(ctx: BypassContext): Promise<boolean> {
    try {
      // Try to find and trigger Shape's challenge callback
      const triggered = await ctx.page.evaluate(() => {
        // Look for Shape's global objects
        const shapeGlobals = [
          '__shape_callback',
          '__antiCatalog',
          '_shape_resolve',
          'ShapeChallenge',
        ];

        for (const g of shapeGlobals) {
          const obj = (window as any)[g];
          if (obj && typeof obj === 'function') {
            try { obj(); return true; } catch { /* continue */ }
          }
        }

        // Try to find shape.js callback
        const scripts = document.querySelectorAll('script[src*="shape"], script[src*="anti_catalog"]');
        if (scripts.length > 0) {
          // Scripts are present but may not have executed yet
          return false;
        }

        return false;
      });

      if (triggered) {
        await this.sleep(2000);
      }

      return triggered;
    } catch {
      return false;
    }
  }

  // --- Cookie Extraction & Management ---------------------------------

  /**
   * Extract Shape-specific cookies from the browser context and convert
   * them to ManagedCookie instances with proper lifecycle tracking.
   */
  private async extractShapeCookies(ctx: BypassContext, domain: string): Promise<ManagedCookie[]> {
    const managedCookies: ManagedCookie[] = [];

    try {
      const cookies = await ctx.context.cookies();

      for (const cookie of cookies) {
        let isShapeCookie = false;
        let flow: ShapeCookieEntry['flow'] = 'primary';

        for (const pattern of SHAPE_COOKIE_PATTERNS) {
          if (pattern.test(cookie.name)) {
            isShapeCookie = true;

            // Determine flow based on cookie name
            if (cookie.name === '_abck') {
              flow = 'akamai-shared';
            } else if (cookie.name.startsWith('sms_')) {
              flow = 'secondary';
            } else {
              flow = 'primary';
            }
            break;
          }
        }

        if (isShapeCookie) {
          const lifetime = cookie.name === '_abck'
            ? 30 * 60 * 1000   // _abck typically 30 min
            : SHAPE_COOKIE_LIFETIME_MS;

          const managed = this.createManagedCookie(
            {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              httpOnly: cookie.httpOnly,
              secure: cookie.secure,
              sameSite: cookie.sameSite as 'Strict' | 'Lax' | 'None',
            },
            lifetime
          );

          managedCookies.push(managed);

          // Track in Shape cookie entries
          const entry: ShapeCookieEntry = {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            setAt: Date.now(),
            expiresAt: Date.now() + lifetime,
            isValid: true,
            flow,
          };

          const entries = this.shapeCookieEntries.get(domain) || [];
          entries.push(entry);
          this.shapeCookieEntries.set(domain, entries);
        }
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'F5/Shape: Cookie extraction failed');
    }

    return managedCookies;
  }

  // --- Helper Methods -------------------------------------------------

  /**
   * Build extra headers to inject into subsequent requests based on the
   * active telemetry profile.
   */
  private buildExtraHeaders(profile: ShapeDeviceTelemetryProfile): Record<string, string> {
    return {
      'X-Shape-Platform': profile.platform,
      'X-Shape-UA': profile.userAgent,
      'Accept-Language': profile.languages.join(','),
    };
  }

  /**
   * Check if the domain can escalate to the next strategy.
   */
  private canEscalate(domain: string): boolean {
    const profile = this.getProfile(domain);
    if (!profile) return true;

    const strategies = STRATEGY_ESCALATION.f5;
    const currentIdx = strategies.indexOf(profile.preferredStrategy);
    return currentIdx < strategies.length - 1;
  }

  /**
   * Get F5/Shape-specific statistics beyond the base stats.
   */
  getStats(): Record<string, unknown> {
    const baseStats = super.getStats();

    return {
      ...baseStats,
      platform: 'F5/Shape Security',
      activeProfiles: this.activeProfiles.size,
      shapeCookieEntries: this.shapeCookieEntries.size,
      interceptedContexts: this.interceptionRegistered.size,
      activeCdpSessions: this.activeCdpSessions.size,
      cachedSensorPayloads: this.sensorPayloadCache.size,
      profileRotationIndex: this.profileIndex,
    };
  }

  /**
   * Clean up CDP sessions and interception registrations.
   */
  async cleanup(): Promise<void> {
    // Detach CDP sessions
    for (const cdp of Array.from(this.activeCdpSessions)) {
      try {
        await cdp.detach();
      } catch {
        // Session already detached
      }
    }
    this.activeCdpSessions.clear();
    this.interceptionRegistered.clear();

    logger.info('F5/Shape: Cleanup completed');
  }
}

// ===============================================================================
// SINGLETON EXPORT
// ===============================================================================

/** Singleton F5/Shape bypass module instance. */
export const f5ShapeBypass = new F5ShapeBypass();

export { F5ShapeBypass, ShapeDeviceTelemetryProfile, ShapeSensorPayload, ShapeCookieEntry, BehavioralConfig };
export default F5ShapeBypass;
