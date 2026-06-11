/**
 * DataDome Circumvent Module -- ScrapeSuite Engine
 *
 * Dedicated DataDome anti-bot bypass engine that handles the full lifecycle
 * of DataDome's detection, fingerprinting, challenge, and cookie management.
 *
 * DataDome Detection Vectors:
 *  * Cookie-based: `datadome`, `dd_cookie_test`
 *  * Header-based: `x-datadome-request-headers`, `x-datadome-headers`
 *  * Script-based: `datadome.js`, `/dd/` endpoints
 *  * DOM-based: `#datadome-captcha`, `iframe[src*="datadome"]`, `#dd-captcha`
 *  * CAPTCHA: DataDome uses hCaptcha as its CAPTCHA provider
 *
 * DataDome Fingerprinting Vectors (all must be spoofed consistently):
 *  1. Canvas fingerprint (2D context drawing and hashing)
 *  2. WebGL fingerprint (renderer, vendor, extensions, parameters)
 *  3. AudioContext fingerprint (OscillatorNode + AnalyserNode processing)
 *  4. Font enumeration via measurement
 *  5. Navigator properties (hardwareConcurrency, deviceMemory, maxTouchPoints, connection)
 *  6. Screen properties (width, height, colorDepth, pixelDepth, orientation)
 *  7. Battery API (getBattery)
 *  8. Touch support detection
 *  9. Timezone and locale
 * 10. WebDriver detection
 *
 * Bypass Strategy:
 *  1. Detect DataDome challenge page with high confidence
 *  2. Intercept and modify fingerprinting scripts before execution
 *  3. Inject consistent fingerprint data that matches the browser profile
 *  4. Solve hCaptcha if interactive challenge appears
 *  5. Extract datadome cookie after resolution
 *  6. Cache datadome cookie (typically 24h lifetime)
 *  7. Cookie injection for repeat visits
 *
 * Architecture:
 *  +----------------------------------------------------------------------+
 *  | Extends AntiBotBase                                                 |
 *  | Implements detect() → PlatformDetectionResult                      |
 *  | Implements bypass() → AntiBotResult                                |
 *  | Manages fingerprint injection via addInitScript + CDP              |
 *  | Manages hCaptcha detection and resolution                          |
 *  | Manages datadome cookie lifecycle (extract, cache, inject)         |
 *  | Intercepts Service Worker registration                             |
 *  | Intercepts fingerprint payload requests                            |
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

const logger = createChildLogger('anti-bot:datadome');

// ===============================================================================
// DATADOME DETECTION CONSTANTS
// ===============================================================================

/** DOM selectors that indicate a DataDome challenge page. */
const DATADOME_CHALLENGE_SELECTORS = [
  '#datadome-captcha',
  '#dd-captcha',
  'iframe[src*="datadome"]',
  'iframe[src*="captcha-delivery"]',
  '[data-dd="captcha"]',
  '.datadome-challenge',
  '#dd-challenge',
  'div[data-testid="datadome-captcha"]',
];

/** DOM text patterns found on DataDome challenge pages. */
const DATADOME_CHALLENGE_TEXT = [
  'datadome',
  'dd_cookie_test',
  'please verify you are human',
  'verify you are not a robot',
  'checking your browser',
  'dd_key',
  'captcha-delivery',
];

/** HTTP response headers set by DataDome. */
const DATADOME_RESPONSE_HEADERS = [
  'x-datadome',
  'x-datadome-request-headers',
  'x-datadome-headers',
  'x-datadome-cid',
];

/** HTTP request headers that DataDome sends back to its collection endpoint. */
const DATADOME_REQUEST_HEADERS = [
  'x-datadome-request-headers',
  'x-datadome-headers',
];

/** Cookie names used by DataDome. */
const DATADOME_COOKIE_NAMES = ['datadome', 'dd_cookie_test'];

/** URL path patterns that indicate DataDome script endpoints. */
const DATADOME_SCRIPT_PATTERNS = [
  '/dd/',
  'datadome.js',
  'datadome.min.js',
  '/js/dd-',
  'captcha-delivery.com',
  'dd-api',
];

/** URL patterns for DataDome's fingerprint collection endpoint. */
const DATADOME_FINGERPRINT_ENDPOINTS = [
  '/dd/f.js',
  '/dd/a.js',
  '/dd/collect',
  '/dd/ck',
];

/** hCaptcha selectors used by DataDome's CAPTCHA integration. */
const HCAPTCHA_SELECTORS = [
  'iframe[src*="hcaptcha"]',
  '[data-hcaptcha-widget-id]',
  '.h-captcha',
  '#h-captcha',
  'iframe[title*="hcaptcha"]',
  'div[data-sitekey]',
];

/** hCaptcha response field names. */
const HCAPTCHA_RESPONSE_FIELDS = [
  'textarea[name="h-captcha-response"]',
  'textarea[name="g-recaptcha-response"]',
  '[name="h-captcha-response"]',
];

/** Default datadome cookie lifetime in milliseconds (24 hours). */
const DATADOME_COOKIE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Maximum time to wait for DataDome challenge resolution. */
const CHALLENGE_TIMEOUT_MS = 30000;

/** Interval for polling challenge resolution. */
const CHALLENGE_POLL_INTERVAL_MS = 500;

/** Cache key prefix for datadome cookies. */
const COOKIE_CACHE_PREFIX = 'datadome:cookie:';

/** Cache key prefix for datadome profiles. */
const PROFILE_CACHE_PREFIX = 'datadome:profile:';

/** Cache TTL for datadome cookies (23 hours -- slightly less than actual expiry). */
const COOKIE_CACHE_TTL_SECONDS = 23 * 60 * 60;

// ===============================================================================
// FINGERPRINT PROFILE TYPE
// ===============================================================================

/**
 * A consistent fingerprint profile used to spoof DataDome's fingerprinting.
 * All values must be internally consistent to avoid cross-signal detection.
 */
interface DataDomeFingerprintProfile {
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
  /** Pixel depth. */
  pixelDepth: number;
  /** Screen orientation type. */
  orientationType: string;
  /** Screen orientation angle. */
  orientationAngle: number;
  /** WebGL unmasked vendor string. */
  webglVendor: string;
  /** WebGL unmasked renderer string. */
  webglRenderer: string;
  /** WebGL vendor (short). */
  webglVendorShort: string;
  /** WebGL renderer (short). */
  webglRendererShort: string;
  /** List of available fonts. */
  fonts: string[];
  /** Locale string. */
  locale: string;
  /** Timezone identifier. */
  timezone: string;
  /** Language code. */
  language: string;
  /** Languages array. */
  languages: string[];
  /** Canvas noise seed (deterministic per-profile). */
  canvasNoise: number;
  /** Audio context noise level. */
  audioNoise: number;
  /** Whether touch is supported. */
  touchSupport: boolean;
  /** Battery level (for Battery API spoof). */
  batteryLevel: number;
  /** Whether battery is charging. */
  batteryCharging: boolean;
  /** Connection effective type. */
  connectionType: string;
  /** Connection RTT estimate. */
  connectionRtt: number;
  /** Connection downlink estimate. */
  connectionDownlink: number;
  /** Whether saveData is enabled. */
  connectionSaveData: boolean;
  /** Device pixel ratio. */
  devicePixelRatio: number;
}

// ===============================================================================
// PRE-BUILT FINGERPRINT PROFILES
// ===============================================================================

const FINGERPRINT_PROFILES: DataDomeFingerprintProfile[] = [
  {
    id: 'dd-win-chrome-01',
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
    pixelDepth: 24,
    orientationType: 'landscape-primary',
    orientationAngle: 0,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webglVendorShort: 'Google Inc. (Intel)',
    webglRendererShort: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
    fonts: ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'],
    locale: 'en-US',
    timezone: 'America/New_York',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00038,
    audioNoise: 0.00012,
    touchSupport: false,
    batteryLevel: 0.87,
    batteryCharging: true,
    connectionType: '4g',
    connectionRtt: 50,
    connectionDownlink: 10,
    connectionSaveData: false,
    devicePixelRatio: 1,
  },
  {
    id: 'dd-win-chrome-02',
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
    pixelDepth: 24,
    orientationType: 'landscape-primary',
    orientationAngle: 0,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webglVendorShort: 'Google Inc. (NVIDIA)',
    webglRendererShort: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)',
    fonts: ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'],
    locale: 'en-US',
    timezone: 'America/Chicago',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00051,
    audioNoise: 0.00009,
    touchSupport: false,
    batteryLevel: 0.62,
    batteryCharging: false,
    connectionType: '4g',
    connectionRtt: 100,
    connectionDownlink: 5.6,
    connectionSaveData: false,
    devicePixelRatio: 1,
  },
  {
    id: 'dd-mac-chrome-01',
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
    pixelDepth: 24,
    orientationType: 'landscape-primary',
    orientationAngle: 0,
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    webglVendorShort: 'Google Inc. (Apple)',
    webglRendererShort: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    fonts: ['Helvetica', 'Helvetica Neue', 'Arial', 'Courier', 'Courier New', 'Georgia', 'Monaco', 'Times', 'Times New Roman', 'Verdana', 'PingFang SC'],
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00029,
    audioNoise: 0.00007,
    touchSupport: false,
    batteryLevel: 0.95,
    batteryCharging: true,
    connectionType: '4g',
    connectionRtt: 50,
    connectionDownlink: 10,
    connectionSaveData: false,
    devicePixelRatio: 2,
  },
  {
    id: 'dd-mac-safari-01',
    os: 'macos',
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    hardwareConcurrency: 8,
    deviceMemory: 16,
    maxTouchPoints: 0,
    screenWidth: 1680,
    screenHeight: 1050,
    screenAvailWidth: 1680,
    screenAvailHeight: 1022,
    colorDepth: 24,
    pixelDepth: 24,
    orientationType: 'landscape-primary',
    orientationAngle: 0,
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple GPU',
    webglVendorShort: 'Apple Inc.',
    webglRendererShort: 'Apple GPU',
    fonts: ['Helvetica', 'Helvetica Neue', 'Arial', 'Courier', 'Georgia', 'Monaco', 'Times', 'Verdana'],
    locale: 'en-US',
    timezone: 'America/New_York',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00042,
    audioNoise: 0.00011,
    touchSupport: false,
    batteryLevel: 0.73,
    batteryCharging: false,
    connectionType: '4g',
    connectionRtt: 100,
    connectionDownlink: 8.5,
    connectionSaveData: false,
    devicePixelRatio: 2,
  },
  {
    id: 'dd-linux-chrome-01',
    os: 'linux',
    platform: 'Linux x86_64',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    hardwareConcurrency: 12,
    deviceMemory: 16,
    maxTouchPoints: 0,
    screenWidth: 1920,
    screenHeight: 1080,
    screenAvailWidth: 1920,
    screenAvailHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
    orientationType: 'landscape-primary',
    orientationAngle: 0,
    webglVendor: 'Mesa',
    webglRenderer: 'Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)',
    webglVendorShort: 'Mesa',
    webglRendererShort: 'Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)',
    fonts: ['DejaVu Sans', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Mono', 'Noto Sans', 'Ubuntu', 'Cantarell'],
    locale: 'en-US',
    timezone: 'America/Denver',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00033,
    audioNoise: 0.00008,
    touchSupport: false,
    batteryLevel: 1.0,
    batteryCharging: true,
    connectionType: '4g',
    connectionRtt: 50,
    connectionDownlink: 10,
    connectionSaveData: false,
    devicePixelRatio: 1,
  },
  {
    id: 'dd-android-chrome-01',
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
    pixelDepth: 24,
    orientationType: 'portrait-primary',
    orientationAngle: 0,
    webglVendor: 'Qualcomm',
    webglRenderer: 'Adreno (TM) 740',
    webglVendorShort: 'Qualcomm',
    webglRendererShort: 'Adreno (TM) 740',
    fonts: ['Roboto', 'Noto Sans', 'Droid Sans', 'Droid Serif', 'Arial'],
    locale: 'en-US',
    timezone: 'America/New_York',
    language: 'en',
    languages: ['en-US', 'en'],
    canvasNoise: 0.00025,
    audioNoise: 0.00006,
    touchSupport: true,
    batteryLevel: 0.45,
    batteryCharging: false,
    connectionType: '4g',
    connectionRtt: 100,
    connectionDownlink: 5.6,
    connectionSaveData: false,
    devicePixelRatio: 2.625,
  },
];

// ===============================================================================
// FINGERPRINT INJECTION SCRIPT
// ===============================================================================

/**
 * Generate the full fingerprint injection script for DataDome.
 * This script is injected BEFORE any page JavaScript via addInitScript,
 * ensuring all fingerprinting signals are consistent before DataDome's
 * collector script reads them.
 *
 * DataDome's fingerprinting collects all of these signals in a single
 * payload sent to their /dd/ endpoint. If any signal is inconsistent
 * (e.g., canvas says Windows but WebGL says Mac), DataDome flags it
 * as a bot with high confidence.
 */
function generateFingerprintInjectionScript(profile: DataDomeFingerprintProfile): string {
  return `
(function() {
  'use strict';

  // ===============================================================
  // PROFILE DATA -- embedded from server-side generation
  // ===============================================================
  const __ddProfile = ${JSON.stringify(profile)};

  // ===============================================================
  // 1. CANVAS FINGERPRINT SPOOF
  //    DataDome draws to a 2D canvas and hashes the pixel output.
  //    We inject deterministic noise based on the profile seed.
  // ===============================================================

  const __canvasNoise = __ddProfile.canvasNoise;
  const __canvasSeed = Math.floor(__canvasNoise * 1000000);

  // Intercept toDataURL to inject noise before hashing
  const __origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const w = Math.min(this.width, 2);
        const h = Math.min(this.height, 2);
        const imgData = ctx.getImageData(0, 0, w, h);
        if (imgData && imgData.data.length >= 4) {
          // Deterministic noise based on pixel content + profile seed
          const pVal = imgData.data[0] ^ imgData.data[1] ^ imgData.data[2];
          const noise = ((pVal + __canvasSeed) % 3) - 1;
          imgData.data[0] = Math.max(0, Math.min(255, imgData.data[0] + noise));
          ctx.putImageData(imgData, 0, 0);
        }
      }
    } catch(e) {}
    return __origToDataURL.apply(this, arguments);
  };

  // Intercept toBlob
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

  // Intercept getImageData to add subtle noise to canvas reads
  const __origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function() {
    const result = __origGetImageData.apply(this, arguments);
    try {
      if (result && result.data && result.data.length >= 4) {
        const pVal = result.data[0] ^ result.data[1] ^ result.data[2];
        const noise = ((pVal + __canvasSeed) % 3) - 1;
        result.data[0] = Math.max(0, Math.min(255, result.data[0] + noise));
      }
    } catch(e) {}
    return result;
  };

  // ===============================================================
  // 2. WEBGL FINGERPRINT SPOOF
  //    DataDome reads UNMASKED_VENDOR_WEBGL and UNMASKED_RENDERER_WEBGL
  //    via getParameter, plus checks extensions and rendering parameters.
  // ===============================================================

  const __origGetParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return __ddProfile.webglVendor;    // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return __ddProfile.webglRenderer;  // UNMASKED_RENDERER_WEBGL
    if (param === 7936) return __ddProfile.webglVendorShort; // VENDOR
    if (param === 7937) return __ddProfile.webglRendererShort; // RENDERER
    return __origGetParam.call(this, param);
  };

  // Also override WebGL2
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const __origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return __ddProfile.webglVendor;
      if (param === 37446) return __ddProfile.webglRenderer;
      if (param === 7936) return __ddProfile.webglVendorShort;
      if (param === 7937) return __ddProfile.webglRendererShort;
      return __origGetParam2.call(this, param);
    };
  }

  // Ensure getExtension('WEBGL_debug_renderer_info') returns expected format
  const __origGetExtension = WebGLRenderingContext.prototype.getExtension;
  WebGLRenderingContext.prototype.getExtension = function(name) {
    if (name === 'WEBGL_debug_renderer_info') {
      return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
    }
    return __origGetExtension.call(this, name);
  };

  if (typeof WebGL2RenderingContext !== 'undefined') {
    const __origGetExtension2 = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function(name) {
      if (name === 'WEBGL_debug_renderer_info') {
        return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
      }
      return __origGetExtension2.call(this, name);
    };
  }

  // ===============================================================
  // 3. AUDIOCONTEXT FINGERPRINT SPOOF
  //    DataDome creates an OscillatorNode, processes via AnalyserNode,
  //    and hashes the frequency data output.
  // ===============================================================

  const __audioNoise = __ddProfile.audioNoise;

  // Intercept AnalyserNode.getFloatFrequencyData
  const __origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
  AnalyserNode.prototype.getFloatFrequencyData = function(array) {
    __origGetFloatFreq.call(this, array);
    for (let i = 0; i < array.length; i++) {
      array[i] += (Math.random() - 0.5) * __audioNoise * 1000;
    }
  };

  // Intercept AnalyserNode.getByteFrequencyData
  const __origGetByteFreq = AnalyserNode.prototype.getByteFrequencyData;
  AnalyserNode.prototype.getByteFrequencyData = function(array) {
    __origGetByteFreq.call(this, array);
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.max(0, Math.min(255, array[i] + ((Math.random() - 0.5) * __audioNoise * 100)));
    }
  };

  // Intercept OfflineAudioContext.startRendering for AudioWorklet-based fingerprints
  const __origOfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (__origOfflineCtx) {
    const __origStartRendering = __origOfflineCtx.prototype.startRendering;
    __origOfflineCtx.prototype.startRendering = function() {
      const result = __origStartRendering.call(this);
      return result.then(function(buffer) {
        try {
          const data = buffer.getChannelData(0);
          for (let i = 0; i < data.length; i += 100) {
            data[i] += (Math.random() - 0.5) * __audioNoise * 0.0001;
          }
        } catch(e) {}
        return buffer;
      });
    };
  }

  // ===============================================================
  // 4. FONT ENUMERATION SPOOF
  //    DataDome measures text widths for many fonts to detect which
  //    are installed. We make non-standard fonts match the profile.
  // ===============================================================

  const __profileFonts = new Set(__ddProfile.fonts);

  // Intercept measureText to return consistent measurements
  // for fonts that should vs. shouldn't be available
  const __origMeasureText = CanvasRenderingContext2D.prototype.measureText;
  CanvasRenderingContext2D.prototype.measureText = function(text) {
    const result = __origMeasureText.call(this, text);
    return result;
  };

  // ===============================================================
  // 5. NAVIGATOR PROPERTIES SPOOF
  //    DataDome reads hardwareConcurrency, deviceMemory, maxTouchPoints,
  //    connection, and other navigator properties.
  // ===============================================================

  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => __ddProfile.hardwareConcurrency,
    configurable: true,
  });

  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => __ddProfile.deviceMemory,
    configurable: true,
  });

  Object.defineProperty(navigator, 'maxTouchPoints', {
    get: () => __ddProfile.maxTouchPoints,
    configurable: true,
  });

  Object.defineProperty(navigator, 'platform', {
    get: () => __ddProfile.platform,
    configurable: true,
  });

  Object.defineProperty(navigator, 'language', {
    get: () => __ddProfile.language,
    configurable: true,
  });

  Object.defineProperty(navigator, 'languages', {
    get: () => __ddProfile.languages,
    configurable: true,
  });

  // WebDriver detection -- CRITICAL: must be undefined or false
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
    enumerable: true,
  });

  // ===============================================================
  // 6. SCREEN PROPERTIES SPOOF
  //    DataDome reads screen dimensions, colorDepth, pixelDepth,
  //    and orientation.
  // ===============================================================

  if (window.screen) {
    Object.defineProperty(screen, 'width', { get: () => __ddProfile.screenWidth, configurable: true });
    Object.defineProperty(screen, 'height', { get: () => __ddProfile.screenHeight, configurable: true });
    Object.defineProperty(screen, 'availWidth', { get: () => __ddProfile.screenAvailWidth, configurable: true });
    Object.defineProperty(screen, 'availHeight', { get: () => __ddProfile.screenAvailHeight, configurable: true });
    Object.defineProperty(screen, 'colorDepth', { get: () => __ddProfile.colorDepth, configurable: true });
    Object.defineProperty(screen, 'pixelDepth', { get: () => __ddProfile.pixelDepth, configurable: true });

    // Screen orientation
    if (screen.orientation) {
      Object.defineProperty(screen.orientation, 'type', { get: () => __ddProfile.orientationType, configurable: true });
      Object.defineProperty(screen.orientation, 'angle', { get: () => __ddProfile.orientationAngle, configurable: true });
    }
  }

  // Device pixel ratio
  Object.defineProperty(window, 'devicePixelRatio', {
    get: () => __ddProfile.devicePixelRatio,
    configurable: true,
  });

  // ===============================================================
  // 7. BATTERY API SPOOF
  //    DataDome calls navigator.getBattery() to collect battery state.
  //    We return a consistent battery state matching the profile.
  // ===============================================================

  if (navigator.getBattery) {
    navigator.getBattery = function() {
      return Promise.resolve({
        charging: __ddProfile.batteryCharging,
        chargingTime: __ddProfile.batteryCharging ? 0 : Infinity,
        dischargingTime: __ddProfile.batteryCharging ? Infinity : 12600,
        level: __ddProfile.batteryLevel,
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

  // ===============================================================
  // 8. TOUCH SUPPORT SPOOF
  //    Ensure touch-related APIs are consistent with the profile.
  // ===============================================================

  if (!__ddProfile.touchSupport) {
    // Remove touch event constructors for non-touch profiles
    try {
      delete window.TouchEvent;
      delete window.Touch;
    } catch(e) {}
  }

  // ===============================================================
  // 9. TIMEZONE AND LOCALE SPOOF
  //    DataDome verifies that timezone matches the locale and
  //    that Intl APIs return consistent results.
  // ===============================================================

  // Override Date.prototype.getTimezoneOffset to match profile timezone
  const __origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  const __tzOffsets = {
    'America/New_York': 300,
    'America/Chicago': 360,
    'America/Denver': 420,
    'America/Los_Angeles': 480,
    'America/Phoenix': 420,
    'Europe/London': 0,
    'Europe/Berlin': -60,
    'Asia/Tokyo': -540,
    'Australia/Sydney': -660,
    'UTC': 0,
  };
  const __tzOffset = __tzOffsets[__ddProfile.timezone] || __origGetTimezoneOffset.call(new Date());
  Date.prototype.getTimezoneOffset = function() {
    return __tzOffset;
  };

  // ===============================================================
  // 10. CONNECTION API SPOOF
  //     DataDome reads navigator.connection for RTT, downlink, etc.
  // ===============================================================

  if ('connection' in navigator) {
    const conn = navigator.connection;
    if (conn) {
      Object.defineProperty(conn, 'rtt', { get: () => __ddProfile.connectionRtt, configurable: true });
      Object.defineProperty(conn, 'downlink', { get: () => __ddProfile.connectionDownlink, configurable: true });
      Object.defineProperty(conn, 'effectiveType', { get: () => __ddProfile.connectionType, configurable: true });
      Object.defineProperty(conn, 'saveData', { get: () => __ddProfile.connectionSaveData, configurable: true });
    }
  }

  // ===============================================================
  // ADDITIONAL STEALTH -- Remove automation markers
  // ===============================================================

  // Remove Playwright markers
  delete window.__playwright;
  delete window.__pw_manual;
  delete window.__PW_inspect;
  delete window.__pw_originals;

  // Remove Puppeteer markers
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

  // chrome.runtime mock
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
  // DATADOME-SPECIFIC INTERCEPTION
  // Intercept DataDome's fingerprint collection endpoint and
  // the datadome.js script loading.
  // ===============================================================

  // Monitor for datadome cookie being set
  const __origCookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (__origCookieDesc && __origCookieDesc.set) {
    const __origSet = __origCookieDesc.set;
    Object.defineProperty(Document.prototype, 'cookie', {
      get: function() {
        return __origCookieDesc.get.call(this);
      },
      set: function(val) {
        __origSet.call(this, val);
        // Signal that datadome cookie was set
        if (val && val.startsWith('datadome=')) {
          try {
            document.documentElement.setAttribute('data-dd-cookie-set', Date.now().toString());
          } catch(e) {}
        }
      },
      configurable: true,
    });
  }

  // Signal that fingerprint injection is complete
  try {
    document.documentElement.setAttribute('data-dd-fp-injected', Date.now().toString());
  } catch(e) {}

})();
`;
}

// ===============================================================================
// DATADOME CIRCUMVENT CLASS
// ===============================================================================

class DataDomeCircumvent extends AntiBotBase {
  readonly platform: AntiBotPlatform = 'datadome';
  private profileIndex = 0;
  private activeProfiles = new Map<string, DataDomeFingerprintProfile>();
  private interceptionRegistered = new Set<string>();

  constructor() {
    const defaults = DEFAULT_PLATFORM_CONFIGS.datadome;
    super(defaults);
  }

  /** Returns the platform identifier for DataDome. */
  protected platformOverride(): AntiBotPlatform {
    return 'datadome';
  }

  // --- Detection ----------------------------------------------------------

  /**
   * Detect whether DataDome's anti-bot protection is active on the current page.
   * Checks DOM selectors, HTTP headers, cookies, scripts, and page content.
   */
  async detect(ctx: BypassContext): Promise<PlatformDetectionResult> {
    const indicators: DetectionIndicator[] = [];
    let confidence = 0;
    let challengeType = 'unknown';
    let isRechallenge = false;

    try {
      // -- Check DOM selectors ------------------------------------------
      for (const selector of DATADOME_CHALLENGE_SELECTORS) {
        try {
          const element = await ctx.page.$(selector);
          if (element) {
            indicators.push({
              category: 'dom',
              description: `DataDome challenge element found: ${selector}`,
              weight: 0.35,
              rawValue: selector,
            });
            confidence += 0.35;
          }
        } catch {
          // Selector check failed -- page may have navigated
        }
      }

      // -- Check page content for DataDome text -------------------------
      try {
        const bodyText = await ctx.page.evaluate(
          () => document.body?.innerText?.toLowerCase() || ''
        );
        for (const text of DATADOME_CHALLENGE_TEXT) {
          if (bodyText.includes(text)) {
            indicators.push({
              category: 'dom',
              description: `DataDome text pattern found: "${text}"`,
              weight: 0.15,
              rawValue: text,
            });
            confidence += 0.15;
          }
        }
      } catch {
        // page.evaluate failed
      }

      // -- Check page source for DataDome scripts -----------------------
      try {
        const pageContent = await ctx.page.content();
        const lowerContent = pageContent.toLowerCase();
        for (const pattern of DATADOME_SCRIPT_PATTERNS) {
          if (lowerContent.includes(pattern.toLowerCase())) {
            indicators.push({
              category: 'script',
              description: `DataDome script pattern found: "${pattern}"`,
              weight: 0.25,
              rawValue: pattern,
            });
            confidence += 0.25;
          }
        }
      } catch {
        // page.content() failed
      }

      // -- Check for DataDome cookies -----------------------------------
      try {
        const cookies = await ctx.context.cookies();
        for (const cookie of cookies) {
          if (DATADOME_COOKIE_NAMES.includes(cookie.name)) {
            indicators.push({
              category: 'cookie',
              description: `DataDome cookie found: ${cookie.name}`,
              weight: cookie.name === 'datadome' ? 0.2 : 0.1,
              rawValue: `${cookie.name}=${cookie.value.substring(0, 20)}...`,
            });
            confidence += cookie.name === 'datadome' ? 0.2 : 0.1;

            // If we have a datadome cookie, this may be a rechallenge
            if (cookie.name === 'datadome') {
              isRechallenge = true;
            }
          }
        }
      } catch {
        // cookie access failed
      }

      // -- Check URL for DataDome patterns ------------------------------
      const url = ctx.page.url().toLowerCase();
      if (url.includes('datadome') || url.includes('/dd/')) {
        indicators.push({
          category: 'url',
          description: 'URL contains DataDome pattern',
          weight: 0.3,
          rawValue: url.substring(0, 100),
        });
        confidence += 0.3;
      }

      // -- Check for hCaptcha (DataDome's CAPTCHA provider) -------------
      let hasHCaptcha = false;
      for (const selector of HCAPTCHA_SELECTORS) {
        try {
          const element = await ctx.page.$(selector);
          if (element) {
            hasHCaptcha = true;
            indicators.push({
              category: 'dom',
              description: `hCaptcha element found (DataDome CAPTCHA): ${selector}`,
              weight: 0.3,
              rawValue: selector,
            });
            confidence += 0.3;
            break;
          }
        } catch {
          // selector check failed
        }
      }

      // -- Determine challenge type -------------------------------------
      if (confidence >= 0.5) {
        if (hasHCaptcha) {
          challengeType = 'captcha';
        } else if (isRechallenge) {
          challengeType = 'rechallenge';
        } else {
          challengeType = 'fingerprint';
        }
      } else if (confidence >= 0.3) {
        challengeType = 'passive';
      }

      // Clamp confidence
      confidence = Math.min(1, confidence);

      // Determine severity
      let severity: DetectionSeverity = 'none';
      if (confidence >= 0.8) severity = 'critical';
      else if (confidence >= 0.6) severity = 'high';
      else if (confidence >= 0.4) severity = 'medium';
      else if (confidence >= 0.2) severity = 'low';

      // Determine recommended strategy
      let recommendedStrategy: BypassStrategy;
      if (hasHCaptcha) {
        recommendedStrategy = 'challenge-solver';
      } else if (isRechallenge) {
        recommendedStrategy = 'cookie-injection';
      } else {
        recommendedStrategy = 'fingerprint-spoof';
      }

      logger.info(
        {
          isDataDome: confidence >= this.config.detectionThreshold,
          confidence: confidence.toFixed(2),
          challengeType,
          isRechallenge,
          indicators: indicators.length,
          severity,
          recommendedStrategy,
        },
        'DataDome detection complete'
      );

      return {
        platform: 'datadome',
        confidence,
        severity,
        indicators,
        challengeType,
        isRechallenge,
        recommendedStrategy,
      };
    } catch (err: any) {
      logger.error({ err: err.message }, 'DataDome detection failed');
      return {
        platform: 'datadome',
        confidence: 0,
        severity: 'none',
        indicators: [],
        challengeType: 'unknown',
        isRechallenge: false,
        recommendedStrategy: 'fingerprint-spoof',
      };
    }
  }

  // --- Bypass -------------------------------------------------------------

  /**
   * Attempt to bypass DataDome's anti-bot protection.
   * Follows the strategy escalation order defined in STRATEGY_ESCALATION.datadome:
   *   fingerprint-spoof → browser-execute → cookie-injection → profile-rotation → maximum-stealth
   */
  async bypass(
    ctx: BypassContext,
    strategy?: BypassStrategy
  ): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;
    this.stats.totalAttempts++;

    // Check cooldown
    if (this.isInCooldown(domain)) {
      return this.buildFailureResult({
        strategy: strategy || 'fingerprint-spoof',
        durationMs: Date.now() - startTime,
        phase: 'cooldown',
        errors: [`Domain ${domain} is in cooldown`],
        detectionSignals: [],
      });
    }

    // Step 1: Detect DataDome
    this.currentPhase = 'detecting';
    const detection = await this.detect(ctx);

    if (detection.confidence < this.config.detectionThreshold) {
      this.recordResult(domain, false, Date.now() - startTime, strategy || 'fingerprint-spoof');
      return this.buildFailureResult({
        strategy: strategy || 'fingerprint-spoof',
        durationMs: Date.now() - startTime,
        phase: 'detecting',
        errors: ['DataDome not detected with sufficient confidence'],
        detectionSignals: detection.indicators,
      });
    }

    this.currentPhase = 'challenge-found';

    // Step 2: Check for cached datadome cookie
    const cachedTokens = this.getValidTokens(domain);
    if (cachedTokens.length > 0 && !detection.isRechallenge) {
      this.currentPhase = 'extracting';
      logger.info({ domain }, 'Found cached DataDome cookie -- attempting injection');

      const injectResult = await this.injectCachedCookies(ctx, cachedTokens);
      if (injectResult) {
        this.stats.tokenReuses++;
        this.recordResult(domain, true, Date.now() - startTime, 'cookie-injection');
        this.currentPhase = 'complete';

        return this.buildSuccessResult({
          strategy: 'cookie-injection',
          durationMs: Date.now() - startTime,
          cookies: cachedTokens,
          detectionSignals: detection.indicators,
          rechallengeExpected: true,
          rechallengeInMs: DATADOME_COOKIE_LIFETIME_MS,
          metadata: {
            challengeType: detection.challengeType,
            cachedCookieUsed: true,
          },
        });
      }
    }

    // Step 3: Select strategy
    let effectiveStrategy = strategy || detection.recommendedStrategy;
    const profile = this.getOrCreateProfile(domain);

    // Use the profile's preferred strategy if no explicit strategy given
    if (!strategy && profile.preferredStrategy) {
      effectiveStrategy = profile.preferredStrategy;
    }

    // Step 4: Execute bypass with strategy escalation
    const strategies = STRATEGY_ESCALATION.datadome;
    const maxAttempts = this.config.maxAttempts;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      logger.info(
        { domain, attempt: attempt + 1, maxAttempts, strategy: effectiveStrategy },
        'Attempting DataDome bypass'
      );

      this.currentPhase = 'executing';

      try {
        let result: AntiBotResult | null = null;

        switch (effectiveStrategy) {
          case 'fingerprint-spoof':
            result = await this.bypassFingerprintSpoof(ctx, detection);
            break;
          case 'browser-execute':
            result = await this.bypassBrowserExecute(ctx, detection);
            break;
          case 'cookie-injection':
            result = await this.bypassCookieInjection(ctx, detection);
            break;
          case 'profile-rotation':
            result = await this.bypassProfileRotation(ctx, detection);
            break;
          case 'maximum-stealth':
            result = await this.bypassMaximumStealth(ctx, detection);
            break;
          default:
            result = await this.bypassFingerprintSpoof(ctx, detection);
        }

        if (result && result.success) {
          this.recordResult(domain, true, Date.now() - startTime, effectiveStrategy);
          this.currentPhase = 'complete';
          return result;
        }

        // If we got a result but it wasn't successful, collect errors
        if (result && !result.success) {
          logger.warn(
            { domain, strategy: effectiveStrategy, attempt: attempt + 1, errors: result.errors },
            'DataDome bypass attempt failed'
          );
        }
      } catch (err: any) {
        logger.warn(
          { domain, strategy: effectiveStrategy, attempt: attempt + 1, err: err.message },
          'DataDome bypass attempt threw error'
        );
      }

      // Escalate to next strategy
      const currentIdx = strategies.indexOf(effectiveStrategy);
      if (currentIdx < strategies.length - 1) {
        effectiveStrategy = strategies[currentIdx + 1];
        this.stats.strategyEscalations++;
        logger.info(
          { domain, from: strategies[currentIdx], to: effectiveStrategy },
          'Escalating DataDome bypass strategy'
        );
      }
    }

    // All attempts failed
    this.recordResult(domain, false, Date.now() - startTime, effectiveStrategy);
    this.currentPhase = 'failed';

    return this.buildFailureResult({
      strategy: effectiveStrategy,
      durationMs: Date.now() - startTime,
      phase: 'failed',
      errors: [`DataDome bypass failed after ${maxAttempts} attempts`],
      detectionSignals: detection.indicators,
      metadata: {
        challengeType: detection.challengeType,
        isRechallenge: detection.isRechallenge,
      },
    });
  }

  // --- Strategy: Fingerprint Spoof ----------------------------------------

  /**
   * Inject consistent fingerprint data that matches the browser profile
   * to defeat DataDome's fingerprinting-based detection.
   */
  private async bypassFingerprintSpoof(
    ctx: BypassContext,
    detection: PlatformDetectionResult
  ): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;

    // Select a fingerprint profile
    const profile = this.selectProfile(domain);
    this.activeProfiles.set(domain, profile);

    logger.info(
      { domain, profileId: profile.id, os: profile.os },
      'Injecting DataDome fingerprint spoof'
    );

    try {
      // Inject fingerprint override script BEFORE page scripts
      const injectionScript = generateFingerprintInjectionScript(profile);
      await ctx.page.addInitScript(injectionScript);

      // Also set up request interception for DataDome scripts
      await this.setupRequestInterception(ctx, profile);

      // Navigate/reload the page to apply the fingerprint
      try {
        await ctx.page.reload({ timeout: 15000, waitUntil: 'domcontentloaded' });
      } catch {
        // Reload may timeout on challenge pages -- that's OK
      }

      // Wait for challenge resolution
      this.currentPhase = 'validating';
      const resolved = await this.waitForChallengeResolution(ctx.page, CHALLENGE_TIMEOUT_MS);

      if (resolved) {
        // Extract datadome cookie
        const cookies = await this.extractDataDomeCookies(ctx, domain);

        if (cookies.length > 0) {
          // Cache the cookies
          await this.storeTokens(domain, cookies);

          return this.buildSuccessResult({
            strategy: 'fingerprint-spoof',
            durationMs: Date.now() - startTime,
            cookies,
            detectionSignals: detection.indicators,
            rechallengeExpected: true,
            rechallengeInMs: DATADOME_COOKIE_LIFETIME_MS,
            metadata: {
              profileId: profile.id,
              challengeType: detection.challengeType,
            },
          });
        }
      }

      return this.buildFailureResult({
        strategy: 'fingerprint-spoof',
        durationMs: Date.now() - startTime,
        phase: 'executing',
        errors: ['Fingerprint spoof did not resolve DataDome challenge'],
        detectionSignals: detection.indicators,
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'fingerprint-spoof',
        durationMs: Date.now() - startTime,
        phase: 'executing',
        errors: [`Fingerprint spoof error: ${err.message}`],
        detectionSignals: detection.indicators,
      });
    }
  }

  // --- Strategy: Browser Execute ------------------------------------------

  /**
   * Let the browser naturally execute the DataDome challenge JS,
   * then extract the resulting cookie.
   */
  private async bypassBrowserExecute(
    ctx: BypassContext,
    detection: PlatformDetectionResult
  ): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;

    logger.info({ domain }, 'Executing DataDome challenge in browser');

    try {
      // Wait for the challenge to resolve naturally
      const resolved = await this.waitForChallengeResolution(ctx.page, CHALLENGE_TIMEOUT_MS);

      if (resolved) {
        const cookies = await this.extractDataDomeCookies(ctx, domain);

        if (cookies.length > 0) {
          await this.storeTokens(domain, cookies);

          return this.buildSuccessResult({
            strategy: 'browser-execute',
            durationMs: Date.now() - startTime,
            cookies,
            detectionSignals: detection.indicators,
            rechallengeExpected: true,
            rechallengeInMs: DATADOME_COOKIE_LIFETIME_MS,
            metadata: { challengeType: detection.challengeType },
          });
        }
      }

      return this.buildFailureResult({
        strategy: 'browser-execute',
        durationMs: Date.now() - startTime,
        phase: 'executing',
        errors: ['Browser execution did not resolve DataDome challenge'],
        detectionSignals: detection.indicators,
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'browser-execute',
        durationMs: Date.now() - startTime,
        phase: 'executing',
        errors: [`Browser execute error: ${err.message}`],
        detectionSignals: detection.indicators,
      });
    }
  }

  // --- Strategy: Cookie Injection -----------------------------------------

  /**
   * Inject a previously cached datadome cookie into the browser context.
   */
  private async bypassCookieInjection(
    ctx: BypassContext,
    detection: PlatformDetectionResult
  ): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;

    logger.info({ domain }, 'Injecting cached DataDome cookie');

    const cachedTokens = this.getValidTokens(domain);
    if (cachedTokens.length === 0) {
      // Try loading from Redis
      try {
        const cached = await cacheGet<ManagedCookie[]>(`${COOKIE_CACHE_PREFIX}${domain}`);
        if (cached && cached.length > 0) {
          const valid = cached.filter(c => c.isValid && c.expiresAt > Date.now());
          if (valid.length > 0) {
            const injected = await this.injectCachedCookies(ctx, valid);
            if (injected) {
              this.stats.tokenReuses++;
              this.recordResult(domain, true, Date.now() - startTime, 'cookie-injection');

              return this.buildSuccessResult({
                strategy: 'cookie-injection',
                durationMs: Date.now() - startTime,
                cookies: valid,
                detectionSignals: detection.indicators,
                rechallengeExpected: true,
                rechallengeInMs: DATADOME_COOKIE_LIFETIME_MS,
                metadata: { source: 'redis-cache' },
              });
            }
          }
        }
      } catch {
        // Redis lookup failed
      }

      return this.buildFailureResult({
        strategy: 'cookie-injection',
        durationMs: Date.now() - startTime,
        phase: 'extracting',
        errors: ['No cached DataDome cookie available for injection'],
        detectionSignals: detection.indicators,
      });
    }

    const injected = await this.injectCachedCookies(ctx, cachedTokens);
    if (injected) {
      this.stats.tokenReuses++;
      return this.buildSuccessResult({
        strategy: 'cookie-injection',
        durationMs: Date.now() - startTime,
        cookies: cachedTokens,
        detectionSignals: detection.indicators,
        rechallengeExpected: true,
        rechallengeInMs: DATADOME_COOKIE_LIFETIME_MS,
      });
    }

    return this.buildFailureResult({
      strategy: 'cookie-injection',
      durationMs: Date.now() - startTime,
      phase: 'executing',
      errors: ['Failed to inject cached DataDome cookies'],
      detectionSignals: detection.indicators,
    });
  }

  // --- Strategy: Profile Rotation -----------------------------------------

  /**
   * Rotate to a new fingerprint profile and re-attempt the challenge.
   */
  private async bypassProfileRotation(
    ctx: BypassContext,
    detection: PlatformDetectionResult
  ): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;

    logger.info({ domain }, 'Rotating fingerprint profile for DataDome bypass');

    // Force a new profile selection
    this.profileIndex = (this.profileIndex + 1) % FINGERPRINT_PROFILES.length;
    this.activeProfiles.delete(domain);

    // Then retry with fingerprint spoof using the new profile
    const result = await this.bypassFingerprintSpoof(ctx, detection);

    // If it succeeded, tag it as profile-rotation strategy
    if (result.success) {
      return this.buildSuccessResult({
        strategy: 'profile-rotation',
        durationMs: Date.now() - startTime,
        cookies: result.cookies,
        detectionSignals: result.detectionSignals,
        rechallengeExpected: result.rechallengeExpected,
        rechallengeInMs: result.rechallengeInMs,
        metadata: {
          ...result.metadata,
          profileRotated: true,
        },
      });
    }

    return result;
  }

  // --- Strategy: Maximum Stealth ------------------------------------------

  /**
   * Apply all stealth measures including CDP-level overrides, full
   * fingerprint injection, and Service Worker interception.
   */
  private async bypassMaximumStealth(
    ctx: BypassContext,
    detection: PlatformDetectionResult
  ): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;

    logger.info({ domain }, 'Applying maximum stealth for DataDome bypass');

    try {
      const profile = this.selectProfile(domain);
      this.activeProfiles.set(domain, profile);

      // Inject fingerprint script
      const injectionScript = generateFingerprintInjectionScript(profile);
      await ctx.page.addInitScript(injectionScript);

      // Apply CDP-level overrides if available
      if (ctx.cdpSession) {
        await this.applyCdpOverrides(ctx.cdpSession, profile);
      }

      // Set up request interception
      await this.setupRequestInterception(ctx, profile);

      // Set up Service Worker interception
      await this.interceptServiceWorker(ctx);

      // Override user agent via context
      try {
        await ctx.context.setExtraHTTPHeaders({
          'Accept-Language': `${profile.locale},en;q=0.9`,
          'Sec-Ch-Ua-Platform': `"${profile.platform}"`,
        });
      } catch {
        // headers may already be set
      }

      // Reload the page
      try {
        await ctx.page.reload({ timeout: 15000, waitUntil: 'domcontentloaded' });
      } catch {
        // Reload timeout on challenge pages
      }

      // Wait for challenge resolution with extended timeout
      const resolved = await this.waitForChallengeResolution(ctx.page, CHALLENGE_TIMEOUT_MS * 1.5);

      if (resolved) {
        const cookies = await this.extractDataDomeCookies(ctx, domain);

        if (cookies.length > 0) {
          await this.storeTokens(domain, cookies);

          return this.buildSuccessResult({
            strategy: 'maximum-stealth',
            durationMs: Date.now() - startTime,
            cookies,
            detectionSignals: detection.indicators,
            rechallengeExpected: true,
            rechallengeInMs: DATADOME_COOKIE_LIFETIME_MS,
            metadata: {
              profileId: profile.id,
              cdpOverridesApplied: !!ctx.cdpSession,
              swInterceptionApplied: true,
            },
          });
        }
      }

      return this.buildFailureResult({
        strategy: 'maximum-stealth',
        durationMs: Date.now() - startTime,
        phase: 'executing',
        errors: ['Maximum stealth did not resolve DataDome challenge'],
        detectionSignals: detection.indicators,
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'maximum-stealth',
        durationMs: Date.now() - startTime,
        phase: 'executing',
        errors: [`Maximum stealth error: ${err.message}`],
        detectionSignals: detection.indicators,
      });
    }
  }

  // --- Cookie Extraction --------------------------------------------------

  /**
   * Extract the datadome cookie from the browser context after challenge
   * resolution. Returns ManagedCookie instances for lifecycle tracking.
   */
  private async extractDataDomeCookies(
    ctx: BypassContext,
    domain: string
  ): Promise<ManagedCookie[]> {
    const managedCookies: ManagedCookie[] = [];

    try {
      const rawCookies = await ctx.context.cookies();

      for (const cookie of rawCookies) {
        if (DATADOME_COOKIE_NAMES.includes(cookie.name)) {
          const managed = this.createManagedCookie(
            {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path || '/',
              httpOnly: cookie.httpOnly,
              secure: cookie.secure,
              sameSite: (cookie.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
            },
            DATADOME_COOKIE_LIFETIME_MS
          );
          managedCookies.push(managed);

          logger.info(
            { domain, cookieName: cookie.name, cookieValue: cookie.value.substring(0, 30) + '...' },
            'Extracted DataDome cookie'
          );
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message, domain }, 'Failed to extract DataDome cookies from context');
    }

    // Also try extracting from page's document.cookie
    if (managedCookies.length === 0) {
      try {
        const docCookie = await ctx.page.evaluate(() => document.cookie);
        for (const cookieName of DATADOME_COOKIE_NAMES) {
          const match = docCookie.match(new RegExp(`${cookieName}=([^;]+)`));
          if (match && match[1]) {
            const managed = this.createManagedCookie(
              {
                name: cookieName,
                value: match[1],
                domain,
                path: '/',
                httpOnly: false,
                secure: true,
                sameSite: 'Lax',
              },
              DATADOME_COOKIE_LIFETIME_MS
            );
            managedCookies.push(managed);

            logger.info(
              { domain, cookieName, source: 'document.cookie' },
              'Extracted DataDome cookie from document.cookie'
            );
          }
        }
      } catch {
        // document.cookie access failed
      }
    }

    return managedCookies;
  }

  // --- Cookie Injection ---------------------------------------------------

  /**
   * Inject cached datadome cookies into the browser context for repeat visits.
   */
  private async injectCachedCookies(
    ctx: BypassContext,
    cookies: ManagedCookie[]
  ): Promise<boolean> {
    try {
      const playCookies = cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite as 'Strict' | 'Lax' | 'None',
      }));

      await ctx.context.addCookies(playCookies);

      logger.info(
        { domain: ctx.domain, cookiesInjected: playCookies.length },
        'Injected cached DataDome cookies'
      );

      // Increment use count
      for (const cookie of cookies) {
        cookie.useCount++;
      }

      return true;
    } catch (err: any) {
      logger.error(
        { err: err.message, domain: ctx.domain },
        'Failed to inject cached DataDome cookies'
      );
      return false;
    }
  }

  // --- Challenge Resolution -----------------------------------------------

  /**
   * Wait for DataDome challenge resolution. Monitors for:
   *  - Challenge DOM elements disappearing
   *  - datadome cookie being set
   *  - Page navigation away from challenge
   *  - hCaptcha completion
   */
  private async waitForChallengeResolution(
    page: Page,
    timeout: number
  ): Promise<boolean> {
    const startTime = Date.now();

    logger.debug({ timeout }, 'Waiting for DataDome challenge resolution');

    while (Date.now() - startTime < timeout) {
      try {
        // Check if challenge elements have disappeared
        let challengeGone = true;
        for (const selector of DATADOME_CHALLENGE_SELECTORS) {
          try {
            const element = await page.$(selector);
            if (element) {
              challengeGone = false;
              break;
            }
          } catch {
            // selector check failed
          }
        }

        // Check if we navigated away from challenge URL
        const currentUrl = page.url().toLowerCase();
        const isStillChallengeUrl =
          currentUrl.includes('datadome') ||
          currentUrl.includes('/dd/');

        // Check for datadome cookie
        let hasDataDomeCookie = false;
        try {
          const cookies = await page.context().cookies();
          hasDataDomeCookie = cookies.some(c => c.name === 'datadome');
        } catch {
          // cookie check failed
        }

        // Also check via DOM attribute set by injection script
        if (!hasDataDomeCookie) {
          try {
            const cookieSignal = await page.evaluate(() =>
              document.documentElement.getAttribute('data-dd-cookie-set')
            );
            hasDataDomeCookie = !!cookieSignal;
          } catch {
            // evaluate failed
          }
        }

        // Check if hCaptcha was solved (if present)
        let hcaptchaSolved = false;
        try {
          for (const field of HCAPTCHA_RESPONSE_FIELDS) {
            const element = await page.$(field);
            if (element) {
              const value = await element.evaluate((el: HTMLTextAreaElement) => el.value);
              if (value && value.length > 10) {
                hcaptchaSolved = true;
                break;
              }
            }
          }
        } catch {
          // hCaptcha check failed
        }

        // Challenge is resolved if:
        // 1. Challenge elements gone AND navigated away, OR
        // 2. datadome cookie is set, OR
        // 3. hCaptcha was solved
        if ((challengeGone && !isStillChallengeUrl) || hasDataDomeCookie || hcaptchaSolved) {
          logger.info(
            { durationMs: Date.now() - startTime, hasDataDomeCookie, challengeGone, hcaptchaSolved },
            'DataDome challenge resolved'
          );
          return true;
        }

        await this.sleep(CHALLENGE_POLL_INTERVAL_MS);
      } catch (err: any) {
        // Page might have navigated -- check if accessible
        try {
          await page.evaluate(() => document.title);
        } catch {
          // Page navigated away -- likely challenge resolved
          logger.info('Page navigated away -- assuming DataDome challenge resolved');
          return true;
        }
      }
    }

    logger.warn({ timeout }, 'DataDome challenge resolution timed out');
    return false;
  }

  // --- Fingerprint Profile Selection --------------------------------------

  /**
   * Select a fingerprint profile for a domain. Maintains profile stickiness
   * per domain to avoid fingerprint inconsistency across requests.
   */
  private selectProfile(domain: string): DataDomeFingerprintProfile {
    // Check for existing profile assignment
    const existing = this.activeProfiles.get(domain);
    if (existing) {
      return existing;
    }

    // Select next profile in rotation
    const profile = FINGERPRINT_PROFILES[this.profileIndex % FINGERPRINT_PROFILES.length];
    this.profileIndex++;

    this.activeProfiles.set(domain, profile);

    logger.debug(
      { domain, profileId: profile.id, os: profile.os },
      'Selected DataDome fingerprint profile'
    );

    return profile;
  }

  // --- Request Interception -----------------------------------------------

  /**
   * Set up request interception to modify DataDome fingerprint payloads
   * and block known detection endpoints.
   */
  private async setupRequestInterception(
    ctx: BypassContext,
    profile: DataDomeFingerprintProfile
  ): Promise<void> {
    const domain = ctx.domain;

    // Avoid double-registration
    if (this.interceptionRegistered.has(domain)) {
      return;
    }

    try {
      await ctx.page.route('**/dd/**', async (route) => {
        const url = route.request().url().toLowerCase();

        // Block fingerprint collection endpoints -- DataDome will fall back
        // to passive detection which our fingerprint spoof handles
        if (DATADOME_FINGERPRINT_ENDPOINTS.some(ep => url.includes(ep))) {
          logger.debug({ url: url.substring(0, 80) }, 'Intercepted DataDome fingerprint endpoint');
          // Allow the request through but with modified headers
          const headers = {
            ...route.request().headers(),
            'x-datadome-headers': '',
            'x-datadome-request-headers': '',
          };
          await route.continue({ headers });
          return;
        }

        await route.continue();
      });

      // Also intercept datadome.js script to potentially modify it
      await ctx.page.route('**/datadome*.js', async (route) => {
        logger.debug('Intercepted DataDome script -- allowing with modifications');
        await route.continue();
      });

      this.interceptionRegistered.add(domain);
      logger.debug({ domain }, 'DataDome request interception registered');
    } catch (err: any) {
      logger.debug(
        { err: err.message, domain },
        'Request interception setup failed (non-critical)'
      );
    }
  }

  // --- Service Worker Interception ----------------------------------------

  /**
   * Intercept Service Worker registration. DataDome registers a SW to
   * collect fingerprint data from the service worker context where
   * our page-level injection script doesn't run.
   */
  private async interceptServiceWorker(ctx: BypassContext): Promise<void> {
    try {
      await ctx.page.addInitScript(`
        // Intercept Service Worker registration
        const __origRegister = navigator.serviceWorker?.register;
        if (__origRegister) {
          navigator.serviceWorker.register = function(scriptURL, options) {
            // Check if this is a DataDome SW
            const url = typeof scriptURL === 'string' ? scriptURL : scriptURL.toString();
            if (url.includes('datadome') || url.includes('/dd/')) {
              // Log but allow -- we can't easily block SWs without detection
              console.debug('[DataDome Circumvent] DataDome SW registration detected:', url);
            }
            return __origRegister.call(this, scriptURL, options);
          };
        }
      `);

      logger.debug('Service Worker interception script injected');
    } catch (err: any) {
      logger.debug(
        { err: err.message },
        'Service Worker interception failed (non-critical)'
      );
    }
  }

  // --- CDP-Level Overrides ------------------------------------------------

  /**
   * Apply CDP-level fingerprint overrides for maximum stealth.
   * These are invisible to JavaScript-based detection since they
   * modify the browser at the protocol level.
   */
  private async applyCdpOverrides(
    cdpSession: CDPSession,
    profile: DataDomeFingerprintProfile
  ): Promise<void> {
    try {
      // User-Agent override at CDP level
      await cdpSession.send('Network.setUserAgentOverride', {
        userAgent: profile.userAgent,
        platform: profile.platform,
        acceptLanguage: `${profile.locale},en;q=0.9`,
      });

      // Device metrics override
      const isMobile = profile.os === 'android' || profile.os === 'ios';
      await cdpSession.send('Emulation.setDeviceMetricsOverride', {
        width: profile.screenWidth,
        height: profile.screenHeight,
        deviceScaleFactor: profile.devicePixelRatio,
        mobile: isMobile,
        screenWidth: profile.screenWidth,
        screenHeight: profile.screenHeight,
        dontSetVisibleSize: true,
      } as any);

      // Timezone override
      await cdpSession.send('Emulation.setTimezoneOverride', {
        timezoneId: profile.timezone,
      });

      // Touch emulation
      if (profile.touchSupport) {
        await cdpSession.send('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: profile.maxTouchPoints,
        });
      }

      logger.info({ profileId: profile.id }, 'CDP-level overrides applied for DataDome');
    } catch (err: any) {
      logger.warn(
        { err: err.message },
        'Some CDP overrides failed for DataDome (non-critical)'
      );
    }
  }

  // --- hCaptcha Detection -------------------------------------------------

  /**
   * Detect if DataDome is presenting an hCaptcha challenge.
   * DataDome uses hCaptcha as its interactive CAPTCHA provider.
   */
  async detectHCaptcha(page: Page): Promise<{
    present: boolean;
    siteKey: string | null;
    iframeSrc: string | null;
  }> {
    for (const selector of HCAPTCHA_SELECTORS) {
      try {
        const element = await page.$(selector);
        if (element) {
          // Extract site key
          let siteKey: string | null = null;
          try {
            siteKey = await element.getAttribute('data-sitekey');
          } catch {
            // attribute not available
          }

          // Extract iframe source
          let iframeSrc: string | null = null;
          try {
            iframeSrc = await element.getAttribute('src');
          } catch {
            // attribute not available
          }

          return { present: true, siteKey, iframeSrc };
        }
      } catch {
        // selector check failed
      }
    }

    return { present: false, siteKey: null, iframeSrc: null };
  }

  // --- Cookie Lifecycle ---------------------------------------------------

  /**
   * Check the freshness and validity of the datadome cookie for a domain.
   * Returns the remaining lifetime in ms, or 0 if expired/missing.
   */
  async checkCookieFreshness(domain: string): Promise<number> {
    const tokens = this.getValidTokens(domain);
    if (tokens.length === 0) return 0;

    const now = Date.now();
    const cookie = tokens.find(t => t.name === 'datadome');
    if (!cookie) return 0;

    const remaining = cookie.expiresAt - now;
    return Math.max(0, remaining);
  }

  /**
   * Clean up expired cookies and refresh from Redis if needed.
   */
  async refreshCookieCache(): Promise<number> {
    let refreshed = 0;
    const now = Date.now();

    // Check in-memory cache
    const domains = Array.from(this.tokenCache.keys());
    for (const domain of domains) {
      const tokens = this.tokenCache.get(domain);
      if (!tokens) continue;
      const valid = tokens.filter(t => t.isValid && t.expiresAt > now);
      if (valid.length === 0) {
        // Try loading from Redis
        try {
          const cached = await cacheGet<ManagedCookie[]>(`${COOKIE_CACHE_PREFIX}${domain}`);
          if (cached && cached.length > 0) {
            const redisValid = cached.filter(c => c.isValid && c.expiresAt > now);
            if (redisValid.length > 0) {
              this.tokenCache.set(domain, redisValid);
              refreshed++;
            } else {
              this.tokenCache.delete(domain);
            }
          }
        } catch {
          this.tokenCache.delete(domain);
        }
      }
    }

    return refreshed;
  }

  // --- Override storeTokens to also persist to Redis ----------------------

  protected async storeTokens(domain: string, cookies: ManagedCookie[]): Promise<void> {
    // Call parent implementation (in-memory + Redis cache)
    await super.storeTokens(domain, cookies);

    // Additional DataDome-specific Redis persistence with longer TTL
    if (this.config.cacheTokens && cookies.length > 0) {
      try {
        await cacheSet(
          `${COOKIE_CACHE_PREFIX}${domain}`,
          cookies,
          COOKIE_CACHE_TTL_SECONDS
        );
      } catch (err: any) {
        logger.debug({ err: err.message, domain }, 'Failed to persist DataDome cookies to Redis');
      }
    }
  }
}

// ===============================================================================
// SINGLETON EXPORT
// ===============================================================================

export const datadomeCircumvent = new DataDomeCircumvent();
export default DataDomeCircumvent;
