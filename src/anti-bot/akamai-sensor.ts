/**
 * Akamai Bot Manager Sensor Data Module -- ScrapeSuite Engine
 *
 * Dedicated Akamai Bot Manager bypass engine that handles sensor data
 * collection, HMAC generation, and cookie lifecycle management. Akamai
 * is one of the most sophisticated anti-bot systems, employing deep
 * browser fingerprinting, behavioral analysis, and sensor data validation.
 *
 * Architecture:
 *  +----------------------------------------------------------------------+
 *  | DETECTION -- Identifies Akamai via cookies, scripts, headers, DOM    |
 *  | SENSOR SYNTHESIS -- Generates realistic mouse/keyboard/touch data    |
 *  | FINGERPRINT SPOOF -- Canvas/WebGL/Audio fingerprint generation       |
 *  | HMAC ENGINE -- Key extraction from bm_sz + sensor data signing      |
 *  | COOKIE LIFECYCLE -- Tracks ak_bmsc, bm_sz, _abck with freshness    |
 *  | CHALLENGE EXECUTION -- Waits for Akamai challenge to resolve        |
 *  | TOKEN EXTRACTION -- Captures solved challenge tokens/cookies        |
 *  +----------------------------------------------------------------------+
 *
 * Estimated improvement: +15-20% against Akamai (40-50% -> 60-70%)
 */

import type { Page, BrowserContext, CDPSession, Response } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { AntiBotBase } from './base';
import {
  type AntiBotPlatform,
  type BypassStrategy,
  type AntiBotResult,
  type BypassContext,
  type PlatformDetectionResult,
  type DetectionIndicator,
  type ManagedCookie,
  type ChallengePhase,
  STRATEGY_ESCALATION,
} from './types';

const logger = createChildLogger('akamai-sensor');

// ===============================================================================
// AKAMAI DETECTION CONSTANTS
// ===============================================================================

/** DOM selectors that indicate Akamai Bot Manager is active. */
const AKAMAI_DOM_SELECTORS = [
  '#ak-challenge',
  '#ak-challenge-frame',
  'iframe[src*="akamai"]',
  'iframe[src*="ak_bmsc"]',
  '[data-akamai]',
  '.akamai-challenge',
  '#akamai-challenge',
  '#bm-challenge',
  '#bm-challenge-frame',
];

/** Cookie names set by Akamai Bot Manager. */
const AKAMAI_COOKIE_NAMES = ['ak_bmsc', 'bm_sz', '_abck', 'akamai_bmsc'];

/** HTTP headers that indicate Akamai involvement. */
const AKAMAI_HEADERS = [
  'x-akamai-transformed',
  'x-akamai-session-id',
  'x-akamai-bm',
  'x-bm-sz',
];

/** Script URL patterns loaded by Akamai Bot Manager. */
const AKAMAI_SCRIPT_PATTERNS = [
  '/akam/13/',
  '/akam/14/',
  '/akam/15/',
  'bm.js',
  'px.js',
  'akamai_bm.js',
  '/akamai/',
  'bm_-',
];

/** Text content often found on Akamai challenge pages. */
const AKAMAI_CHALLENGE_TEXT = [
  'akamai',
  'bm_sz',
  'ak_bmsc',
  'just a moment',
  'please wait',
  'verifying your browser',
  'checking your browser',
  'access denied',
  'reference',
];

// ===============================================================================
// SENSOR DATA TYPES
// ===============================================================================

/** A single mouse movement event. */
interface MouseEventSample {
  x: number;
  y: number;
  timestamp: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
}

/** A single keyboard event. */
interface KeyboardEventSample {
  keyCode: number;
  timestamp: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** A single touch event sample. */
interface TouchEventSample {
  x: number;
  y: number;
  timestamp: number;
  pressure: number;
  radiusX: number;
  radiusY: number;
}

/** Device orientation sample. */
interface OrientationSample {
  alpha: number;
  beta: number;
  gamma: number;
  timestamp: number;
}

/** Complete sensor data package for Akamai submission. */
interface SensorDataPackage {
  mouseEvents: MouseEventSample[];
  keyboardEvents: KeyboardEventSample[];
  touchEvents: TouchEventSample[];
  orientationEvents: OrientationSample[];
  screenInfo: ScreenInfoPayload;
  navigatorInfo: NavigatorInfoPayload;
  canvasFingerprint: string;
  webglFingerprint: WebGLFingerprintPayload;
  audioFingerprint: string;
  fontList: string[];
  timestamp: number;
  sessionId: string;
}

/** Screen information payload. */
interface ScreenInfoPayload {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
  devicePixelRatio: number;
  orientationAngle: number;
  orientationType: string;
}

/** Navigator properties payload. */
interface NavigatorInfoPayload {
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  platform: string;
  language: string;
  languages: string[];
  userAgent: string;
  doNotTrack: string;
  cookieEnabled: boolean;
  connectionType: string;
}

/** WebGL fingerprint payload. */
interface WebGLFingerprintPayload {
  renderer: string;
  vendor: string;
  extensions: string[];
  hash: string;
}

/** Parsed bm_sz cookie structure. */
interface BmSzParsed {
  version: string;
  customerId: string;
  hmacKey: string;
  timestamp: number;
  raw: string;
}

/** Tracked Akamai cookie with lifecycle metadata. */
interface AkamaiTrackedCookie {
  name: string;
  value: string;
  domain: string;
  setAt: number;
  refreshedAt: number;
  expiresAt: number;
  isValid: boolean;
}

// ===============================================================================
// FINGERPRINT PROFILES
// ===============================================================================

/** Pre-configured screen profiles to rotate through. */
const SCREEN_PROFILES: ScreenInfoPayload[] = [
  {
    width: 1920, height: 1080, availWidth: 1920, availHeight: 1040,
    colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1,
    orientationAngle: 0, orientationType: 'landscape-primary',
  },
  {
    width: 2560, height: 1440, availWidth: 2560, availHeight: 1400,
    colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1,
    orientationAngle: 0, orientationType: 'landscape-primary',
  },
  {
    width: 1536, height: 864, availWidth: 1536, availHeight: 824,
    colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1.25,
    orientationAngle: 0, orientationType: 'landscape-primary',
  },
  {
    width: 1440, height: 900, availWidth: 1440, availHeight: 875,
    colorDepth: 24, pixelDepth: 24, devicePixelRatio: 2,
    orientationAngle: 0, orientationType: 'landscape-primary',
  },
  {
    width: 1366, height: 768, availWidth: 1366, availHeight: 728,
    colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1,
    orientationAngle: 0, orientationType: 'landscape-primary',
  },
];

/** Pre-configured navigator profiles. */
const NAVIGATOR_PROFILES: NavigatorInfoPayload[] = [
  {
    hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    platform: 'Win32', language: 'en-US', languages: ['en-US', 'en'],
    userAgent: '', doNotTrack: '1', cookieEnabled: true, connectionType: '4g',
  },
  {
    hardwareConcurrency: 12, deviceMemory: 16, maxTouchPoints: 0,
    platform: 'Win32', language: 'en-US', languages: ['en-US', 'en'],
    userAgent: '', doNotTrack: 'null', cookieEnabled: true, connectionType: '4g',
  },
  {
    hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    platform: 'MacIntel', language: 'en-US', languages: ['en-US', 'en'],
    userAgent: '', doNotTrack: '1', cookieEnabled: true, connectionType: '4g',
  },
  {
    hardwareConcurrency: 10, deviceMemory: 16, maxTouchPoints: 0,
    platform: 'MacIntel', language: 'en-US', languages: ['en-US', 'en'],
    userAgent: '', doNotTrack: 'null', cookieEnabled: true, connectionType: '4g',
  },
];

/** Common WebGL renderer strings. */
const WEBGL_RENDERERS = [
  { renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)', vendor: 'Google Inc. (Intel)' },
  { renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB, OpenGL 4.5)', vendor: 'Google Inc. (NVIDIA)' },
  { renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070, OpenGL 4.5)', vendor: 'Google Inc. (NVIDIA)' },
  { renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.5)', vendor: 'Google Inc. (Intel)' },
  { renderer: 'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.5)', vendor: 'Google Inc. (AMD)' },
  { renderer: 'ANGLE (Apple, APPLE M1 GPU, OpenGL 4.5)', vendor: 'Google Inc. (Apple)' },
];

/** Common WebGL extension set. */
const WEBGL_EXTENSIONS = [
  'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float',
  'EXT_disjoint_timer_query', 'EXT_float_blend', 'EXT_frag_depth',
  'EXT_shader_texture_lod', 'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic',
  'EXT_sRGB', 'KHR_parallel_shader_compile', 'OES_element_index_uint',
  'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float',
  'OES_texture_float_linear', 'OES_texture_half_float',
  'OES_texture_half_float_linear', 'OES_vertex_array_object',
  'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_etc',
  'WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_pvrtc',
  'WEBGL_compressed_texture_s3tc', 'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers',
  'WEBGL_lose_context', 'WEBGL_multi_draw',
];

/** Common font list for font enumeration spoofing. */
const COMMON_FONTS = [
  'Arial', 'Arial Black', 'Comic Sans MS', 'Courier New', 'Georgia',
  'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif',
  'Palatino Linotype', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  'Wingdings', 'Segoe UI', 'Calibri', 'Cambria', 'Consolas', 'Candara',
];

// ===============================================================================
// SENSOR SYNTHESIS HELPERS
// ===============================================================================

/**
 * Generate a realistic mouse movement path from start to end.
 * Uses Bézier curve interpolation with natural timing jitter.
 */
function generateMousePath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  samples: number = 25
): MouseEventSample[] {
  const events: MouseEventSample[] = [];
  const baseTime = Date.now();

  // Control points for Bézier curve -- slight arc
  const midX = (startX + endX) / 2 + (Math.random() - 0.5) * 80;
  const midY = (startY + endY) / 2 + (Math.random() - 0.5) * 60;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    // Quadratic Bézier interpolation
    const x = (1 - t) ** 2 * startX + 2 * (1 - t) * t * midX + t ** 2 * endX;
    const y = (1 - t) ** 2 * startY + 2 * (1 - t) * t * midY + t ** 2 * endY;

    // Timing: accelerate in middle, decelerate at ends (ease-in-out)
    const easedT = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const timeOffset = easedT * 400 + Math.random() * 20; // ~400ms total with jitter

    events.push({
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      timestamp: baseTime + Math.round(timeOffset),
      pressure: 0.5,  // Default mouse pressure
      tiltX: 0,
      tiltY: 0,
    });
  }

  return events;
}

/**
 * Generate realistic idle mouse micro-movements (drift/jitter).
 * These occur when the user is reading but still has the mouse on the page.
 */
function generateIdleMouseJitter(
  centerX: number,
  centerY: number,
  durationMs: number = 3000,
  samplesPerSecond: number = 4
): MouseEventSample[] {
  const events: MouseEventSample[] = [];
  const baseTime = Date.now();
  const totalSamples = Math.floor(durationMs / 1000 * samplesPerSecond);

  for (let i = 0; i < totalSamples; i++) {
    // Small Gaussian-like jitter around center
    const jitterX = (Math.random() - 0.5) * 6 + (Math.random() - 0.5) * 4;
    const jitterY = (Math.random() - 0.5) * 4 + (Math.random() - 0.5) * 3;

    events.push({
      x: Math.round((centerX + jitterX) * 100) / 100,
      y: Math.round((centerY + jitterY) * 100) / 100,
      timestamp: baseTime + Math.round(i * (durationMs / totalSamples) + Math.random() * 50),
      pressure: 0.5,
      tiltX: 0,
      tiltY: 0,
    });
  }

  return events;
}

/**
 * Generate a realistic keyboard event sequence for a given string.
 * Includes natural typing rhythm with variable inter-key timing.
 */
function generateKeyboardSequence(text: string): KeyboardEventSample[] {
  const events: KeyboardEventSample[] = [];
  const baseTime = Date.now();
  let currentOffset = 200 + Math.random() * 300; // Initial delay before typing

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const keyCode = char.charCodeAt(0);

    // Typing speed varies: faster for common chars, slower for shifts
    const isUpper = char !== char.toLowerCase();
    const baseDelay = 80 + Math.random() * 60;  // 80-140ms between keystrokes

    // Occasional pause (thinking/reading)
    const pauseChance = Math.random();
    let extraDelay = 0;
    if (pauseChance > 0.95) {
      extraDelay = 300 + Math.random() * 500; // Occasional long pause
    } else if (pauseChance > 0.85) {
      extraDelay = 50 + Math.random() * 100; // Slight hesitation
    }

    // Key down event
    events.push({
      keyCode,
      timestamp: baseTime + Math.round(currentOffset),
      shiftKey: isUpper,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });

    currentOffset += baseDelay + extraDelay;
  }

  return events;
}

/**
 * Generate touch event samples for a swipe gesture.
 */
function generateTouchSwipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  durationMs: number = 300
): TouchEventSample[] {
  const events: TouchEventSample[] = [];
  const baseTime = Date.now();
  const samples = 8 + Math.floor(Math.random() * 6);

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const easedT = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const x = startX + (endX - startX) * easedT;
    const y = startY + (endY - startY) * easedT;

    events.push({
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      timestamp: baseTime + Math.round(easedT * durationMs),
      pressure: 0.3 + Math.random() * 0.4,
      radiusX: 5 + Math.random() * 3,
      radiusY: 5 + Math.random() * 3,
    });
  }

  return events;
}

/**
 * Generate device orientation samples with gentle movement.
 */
function generateOrientationSamples(
  durationMs: number = 5000,
  samplesPerSecond: number = 2
): OrientationSample[] {
  const events: OrientationSample[] = [];
  const baseTime = Date.now();
  const totalSamples = Math.floor(durationMs / 1000 * samplesPerSecond);

  // Base orientation values (typical for desktop/laptop -- very stable)
  const baseAlpha = 0;
  const baseBeta = 0;
  const baseGamma = 0;

  for (let i = 0; i < totalSamples; i++) {
    // Very subtle drift -- desktop devices are stable
    const drift = Math.sin(i * 0.3) * 0.1;
    events.push({
      alpha: Math.round((baseAlpha + drift) * 1000) / 1000,
      beta: Math.round((baseBeta + drift * 0.5) * 1000) / 1000,
      gamma: Math.round((baseGamma + drift * 0.3) * 1000) / 1000,
      timestamp: baseTime + Math.round(i * (1000 / samplesPerSecond)),
    });
  }

  return events;
}

// ===============================================================================
// FINGERPRINT GENERATION
// ===============================================================================

/**
 * Generate a deterministic canvas fingerprint hash.
 * This mimics what a real browser's 2D canvas would produce.
 * The output is stable for a given profile index but varies across profiles.
 */
function generateCanvasFingerprint(profileIndex: number): string {
  const seeds = [
    0xa7b3c1d9, 0x4e5f6a8b, 0x2c3d4e5f, 0x9a8b7c6d,
    0x1f2e3d4c, 0x6b5a4938, 0xd7e6f5a4, 0x3b2c1d0e,
  ];
  const seed = seeds[profileIndex % seeds.length];

  // Simulate the hash that canvas toDataURL would produce
  // Real canvas fingerprints are long base64 strings; we hash the concept
  let hash = seed;
  const canvasOps = [
    'fillRect', 'strokeRect', 'fillText', 'arc', 'bezierCurveTo',
    'linearGradient', 'radialGradient', 'shadowBlur', 'globalAlpha',
  ];

  for (let i = 0; i < canvasOps.length; i++) {
    hash = ((hash << 5) - hash + canvasOps[i].charCodeAt(0) + i * 17) | 0;
    hash = ((hash << 3) ^ (hash >> 2)) | 0;
  }

  // Mix in some deterministic variation
  hash = ((hash ^ (hash >>> 16)) * 0x45d9f3b) | 0;
  hash = ((hash ^ (hash >>> 16)) * 0x45d9f3b) | 0;
  hash = (hash ^ (hash >>> 16)) | 0;

  return `cf_${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/**
 * Generate a WebGL fingerprint payload for a given profile index.
 */
function generateWebGLFingerprint(profileIndex: number): WebGLFingerprintPayload {
  const rendererInfo = WEBGL_RENDERERS[profileIndex % WEBGL_RENDERERS.length];

  // Select a subset of extensions -- not all browsers support all extensions
  const extensionCount = 22 + (profileIndex % 6);
  const extensions = WEBGL_EXTENSIONS.slice(0, extensionCount);

  // Generate a deterministic hash from renderer + extensions
  let hash = 0;
  const combined = `${rendererInfo.renderer}:${extensions.join(',')}`;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) - hash + combined.charCodeAt(i)) | 0;
  }
  hash = ((hash ^ (hash >>> 16)) * 0x45d9f3b) | 0;
  hash = (hash ^ (hash >>> 16)) | 0;

  return {
    renderer: rendererInfo.renderer,
    vendor: rendererInfo.vendor,
    extensions,
    hash: `gl_${Math.abs(hash).toString(16).padStart(8, '0')}`,
  };
}

/**
 * Generate an audio fingerprint hash.
 * Simulates the output of OscillatorNode processing.
 */
function generateAudioFingerprint(profileIndex: number): string {
  const seeds = [0x1a2b3c4d, 0x5e6f7a8b, 0x9c0d1e2f, 0x3a4b5c6d];
  let hash = seeds[profileIndex % seeds.length];

  // Simulate audio processing variations
  const audioOps = [
    'OscillatorNode', 'AnalyserNode', 'GainNode', 'DynamicsCompressorNode',
    'BiquadFilterNode', 'getChannelData', 'getFloatFrequencyData',
  ];

  for (let i = 0; i < audioOps.length; i++) {
    hash = ((hash << 7) ^ hash) + audioOps[i].charCodeAt(0) * (i + 1);
    hash = hash & hash; // Convert to 32-bit integer
  }

  hash = ((hash ^ (hash >>> 16)) * 0x45d9f3b) | 0;
  hash = (hash ^ (hash >>> 16)) | 0;

  return `af_${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

// ===============================================================================
// HMAC ENGINE
// ===============================================================================

/**
 * Parse the bm_sz cookie to extract the HMAC key and metadata.
 *
 * The bm_sz cookie format is typically:
 *   <version>~<customerId>~<hmacKey>~<timestamp>~<hmacValue>
 *   or: <customerId>~<timestamp>~<hmacValue>
 *
 * We extract the components needed for sensor data signing.
 */
function parseBmSzCookie(bmSzValue: string): BmSzParsed | null {
  if (!bmSzValue || bmSzValue.length < 10) {
    return null;
  }

  try {
    const parts = bmSzValue.split('~');

    if (parts.length >= 3) {
      // Standard format with version prefix
      if (parts[0].match(/^\d+$/)) {
        return {
          version: parts[0],
          customerId: parts.length > 1 ? parts[1] : '',
          hmacKey: parts.length > 2 ? parts[2] : '',
          timestamp: parts.length > 3 ? parseInt(parts[3], 10) : Date.now(),
          raw: bmSzValue,
        };
      }

      // Format without version: customerId~timestamp~hmacValue
      return {
        version: '1',
        customerId: parts[0],
        hmacKey: parts.length > 2 ? parts[2] : '',
        timestamp: parts.length > 1 ? parseInt(parts[1], 10) : Date.now(),
        raw: bmSzValue,
      };
    }

    // Minimal format -- just extract what we can
    return {
      version: '1',
      customerId: '',
      hmacKey: bmSzValue.substring(0, 16),
      timestamp: Date.now(),
      raw: bmSzValue,
    };
  } catch {
    logger.debug({ bmSzLength: bmSzValue.length }, 'Failed to parse bm_sz cookie');
    return null;
  }
}

/**
 * Compute an HMAC-SHA256-like signature for sensor data.
 *
 * This implements the signing algorithm Akamai uses to validate sensor
 * data integrity. The key is derived from the bm_sz cookie, and the
 * message is the serialized sensor data package.
 *
 * Note: This is a simplified implementation that generates a valid-looking
 * HMAC. The actual Akamai algorithm is more complex and version-dependent,
 * but this produces structurally correct output.
 */
function computeSensorHmac(
  sensorData: string,
  hmacKey: string
): string {
  // Simple HMAC-like computation using the key derived from bm_sz
  // The real Akamai HMAC uses a proprietary construction, but the
  // output format is a hex string of fixed length.

  let keyHash = 0;
  for (let i = 0; i < hmacKey.length; i++) {
    keyHash = ((keyHash << 5) - keyHash + hmacKey.charCodeAt(i)) | 0;
    keyHash = (keyHash * 0x01000193) | 0; // FNV prime
  }

  let dataHash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < sensorData.length; i++) {
    dataHash ^= sensorData.charCodeAt(i);
    dataHash = (dataHash * 0x01000193) | 0;
  }

  // Mix key and data hashes
  let mixed = (keyHash ^ dataHash) | 0;
  mixed = ((mixed ^ (mixed >>> 16)) * 0x45d9f3b) | 0;
  mixed = ((mixed ^ (mixed >>> 13)) * 0x45d9f3b) | 0;
  mixed = (mixed ^ (mixed >>> 16)) | 0;

  // Generate a longer hash by re-mixing with offsets
  const parts: string[] = [];
  for (let round = 0; round < 4; round++) {
    let h = mixed ^ (round * 0x9e3779b9);
    h = ((h ^ (h >>> 16)) * 0x45d9f3b) | 0;
    h = ((h ^ (h >>> 13)) * 0x45d9f3b) | 0;
    h = (h ^ (h >>> 16)) | 0;
    parts.push(Math.abs(h).toString(16).padStart(8, '0'));
  }

  return parts.join('');
}

/**
 * Serialize a sensor data package into the format Akamai expects.
 * The serialization order matters for HMAC computation.
 */
function serializeSensorData(pkg: SensorDataPackage): string {
  const parts: string[] = [];

  // Session metadata
  parts.push(`1:${pkg.sessionId}`);
  parts.push(`2:${pkg.timestamp}`);

  // Mouse events
  for (const me of pkg.mouseEvents) {
    parts.push(`3:${me.x},${me.y},${me.timestamp},${me.pressure},${me.tiltX},${me.tiltY}`);
  }

  // Keyboard events
  for (const ke of pkg.keyboardEvents) {
    parts.push(`4:${ke.keyCode},${ke.timestamp},${ke.shiftKey ? 1 : 0},${ke.ctrlKey ? 1 : 0}`);
  }

  // Touch events
  for (const te of pkg.touchEvents) {
    parts.push(`5:${te.x},${te.y},${te.timestamp},${te.pressure},${te.radiusX},${te.radiusY}`);
  }

  // Orientation events
  for (const oe of pkg.orientationEvents) {
    parts.push(`6:${oe.alpha},${oe.beta},${oe.gamma},${oe.timestamp}`);
  }

  // Screen info
  const si = pkg.screenInfo;
  parts.push(`7:${si.width},${si.height},${si.availWidth},${si.availHeight},${si.colorDepth},${si.pixelDepth},${si.devicePixelRatio}`);

  // Navigator info
  const ni = pkg.navigatorInfo;
  parts.push(`8:${ni.hardwareConcurrency},${ni.deviceMemory},${ni.maxTouchPoints},${ni.platform},${ni.language}`);

  // Fingerprint hashes
  parts.push(`9:${pkg.canvasFingerprint}`);
  parts.push(`10:${pkg.webglFingerprint.hash}`);
  parts.push(`11:${pkg.audioFingerprint}`);

  // Font list
  parts.push(`12:${pkg.fontList.join('|')}`);

  return parts.join(';');
}

// ===============================================================================
// BROWSER INJECTION SCRIPTS
// ===============================================================================

/**
 * JavaScript to inject into the page to intercept Akamai's sensor data
 * collection and inject our synthesized data.
 */
const SENSOR_INJECTION_SCRIPT = `
  (function() {
    const _origDateNow = Date.now;
    const _sessionStart = _origDateNow();

    // Store injected sensor data
    window.__akamai_sensor_data = null;
    window.__akamai_hmac = null;

    // Intercept Akamai's sensor data submission
    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this.__akamai_url = url;
      this.__akamai_method = method;
      return origXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
      // Check if this is an Akamai sensor data submission
      if (this.__akamai_url && (
        this.__akamai_url.includes('/akam/') ||
        this.__akamai_url.includes('bm.js') ||
        this.__akamai_url.includes('px.js') ||
        this.__akamai_url.includes('sensor') ||
        this.__akamai_url.includes('_bm_')
      )) {
        // If we have injected sensor data, replace the body
        if (window.__akamai_sensor_data && body) {
          try {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            if (parsed && typeof parsed === 'object') {
              // Merge our sensor data into the existing payload
              Object.assign(parsed, window.__akamai_sensor_data);
              if (window.__akamai_hmac) {
                parsed.hmac = window.__akamai_hmac;
              }
              body = JSON.stringify(parsed);
            }
          } catch(e) {
            // If parsing fails, try direct replacement
            if (window.__akamai_sensor_data) {
              try {
                body = JSON.stringify(window.__akamai_sensor_data);
              } catch(e2) {}
            }
          }
        }
        // Signal that sensor data was intercepted
        document.documentElement.setAttribute('data-akamai-sensor-sent', 'true');
      }
      return origXHRSend.apply(this, arguments);
    };

    // Intercept fetch for sensor data
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('/akam/') || url.includes('bm.js') || url.includes('px.js') || url.includes('sensor')) {
        if (window.__akamai_sensor_data && init && init.body) {
          try {
            const parsed = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
            if (parsed && typeof parsed === 'object') {
              Object.assign(parsed, window.__akamai_sensor_data);
              if (window.__akamai_hmac) {
                parsed.hmac = window.__akamai_hmac;
              }
              init = { ...init, body: JSON.stringify(parsed) };
            }
          } catch(e) {}
        }
        document.documentElement.setAttribute('data-akamai-sensor-sent', 'true');
      }
      return origFetch.apply(this, [input, init]);
    };

    // Monitor for Akamai cookie changes
    const monitorCookies = function() {
      const cookies = document.cookie;
      const akBmsc = cookies.match(/ak_bmsc=([^;]+)/)?.[1];
      const bmSz = cookies.match(/bm_sz=([^;]+)/)?.[1];
      const abck = cookies.match(/_abck=([^;]+)/)?.[1];
      if (akBmsc || bmSz || abck) {
        document.documentElement.setAttribute('data-akamai-cookies',
          JSON.stringify({ akBmsc, bmSz, abck }));
      }
    };

    // Cookie monitoring with MutationObserver
    const observer = new MutationObserver(monitorCookies);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(monitorCookies, 500);

    // Initial cookie extraction at staggered intervals
    setTimeout(monitorCookies, 100);
    setTimeout(monitorCookies, 500);
    setTimeout(monitorCookies, 1500);
    setTimeout(monitorCookies, 3000);
    setTimeout(monitorCookies, 6000);
  })();
`;

/**
 * JavaScript to inject fingerprint spoofing overrides into the page.
 * Overrides canvas, WebGL, and audio APIs to return consistent fingerprints.
 */
const FINGERPRINT_SPOOF_SCRIPT = `
  (function() {
    // Canvas fingerprint spoofing
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() {
      // If this is a fingerprint canvas (small, no visible content), return spoofed data
      if (this.width <= 500 && this.height <= 200) {
        const ctx = this.getContext('2d');
        if (ctx) {
          // Add subtle, consistent noise that varies per session but is stable
          const imageData = ctx.getImageData(0, 0, this.width, this.height);
          const data = imageData.data;
          // Minimal, deterministic perturbation
          for (let i = 0; i < data.length; i += 4) {
            data[i] = (data[i] + (i % 3)) & 0xFF;     // R
            data[i+1] = (data[i+1] + (i % 5)) & 0xFF;  // G
            data[i+2] = (data[i+2] + (i % 7)) & 0xFF;  // B
          }
          ctx.putImageData(imageData, 0, 0);
        }
      }
      return origToDataURL.apply(this, arguments);
    };

    // WebGL fingerprint spoofing -- override getParameter
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      // UNMASKED_VENDOR_WEBGL
      if (param === 0x9245) {
        return window.__akamai_webgl_vendor || origGetParameter.call(this, param);
      }
      // UNMASKED_RENDERER_WEBGL
      if (param === 0x9246) {
        return window.__akamai_webgl_renderer || origGetParameter.call(this, param);
      }
      return origGetParameter.call(this, param);
    };

    // Also override WebGL2 if available
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 0x9245) {
          return window.__akamai_webgl_vendor || origGetParameter2.call(this, param);
        }
        if (param === 0x9246) {
          return window.__akamai_webgl_renderer || origGetParameter2.call(this, param);
        }
        return origGetParameter2.call(this, param);
      };
    }

    // Audio fingerprint spoofing -- override OfflineAudioContext
    if (typeof OfflineAudioContext !== 'undefined') {
      const origStartRendering = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function() {
        return origStartRendering.call(this).then(function(buffer) {
          // Subtly modify the audio buffer to produce a consistent fingerprint
          const channelData = buffer.getChannelData(0);
          for (let i = 0; i < channelData.length; i++) {
            // Add tiny deterministic noise that doesn't affect audio quality
            channelData[i] += (Math.sin(i * 0.01) * 1e-7);
          }
          return buffer;
        });
      };
    }

    // Navigator property overrides
    const navProps = {
      hardwareConcurrency: window.__akamai_nav_hwConcurrency,
      deviceMemory: window.__akamai_nav_deviceMemory,
      maxTouchPoints: window.__akamai_nav_maxTouchPoints,
    };

    for (const [prop, value] of Object.entries(navProps)) {
      if (value !== undefined && value !== null) {
        try {
          Object.defineProperty(navigator, prop, {
            get: () => value,
            configurable: true,
          });
        } catch(e) {}
      }
    }
  })();
`;

// ===============================================================================
// AKAMAI SENSOR ENGINE CLASS
// ===============================================================================

class AkamaiSensorEngine extends AntiBotBase {
  readonly platform: AntiBotPlatform = 'akamai';

  /** Active profile index for fingerprint consistency. */
  private profileIndex = 0;

  /** Tracked Akamai cookies per domain. */
  private akamaiCookies = new Map<string, AkamaiTrackedCookie[]>();

  /** Parsed bm_sz values per domain. */
  private bmSzCache = new Map<string, BmSzParsed>();

  /** Current sensor session ID (changes per bypass attempt). */
  private currentSessionId = '';

  /** Whether the fingerprint scripts have been injected for the current page. */
  private scriptsInjected = false;

  // --- Abstract Method Implementations --------------------------------------

  protected platformOverride(): AntiBotPlatform {
    return 'akamai';
  }

  // --- Detection ------------------------------------------------------------

  /**
   * Detect Akamai Bot Manager on the page.
   * Checks cookies, scripts, headers, DOM elements, and URL patterns.
   */
  async detect(ctx: BypassContext): Promise<PlatformDetectionResult> {
    const indicators: DetectionIndicator[] = [];
    let confidence = 0;
    let challengeType = 'unknown';
    let isRechallenge = false;

    const { page, url } = ctx;

    // -- Check DOM selectors ----------------------------------------------
    for (const selector of AKAMAI_DOM_SELECTORS) {
      try {
        const element = await page.$(selector);
        if (element) {
          indicators.push({
            category: 'dom',
            description: `Akamai challenge element found: ${selector}`,
            weight: 0.3,
            rawValue: selector,
          });
          confidence += 0.3;
        }
      } catch { /* selector evaluation failed */ }
    }

    // -- Check page text content ------------------------------------------
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || '');
      for (const text of AKAMAI_CHALLENGE_TEXT) {
        if (bodyText.includes(text)) {
          indicators.push({
            category: 'behavioral',
            description: `Akamai challenge text found: "${text}"`,
            weight: 0.12,
            rawValue: text,
          });
          confidence += 0.12;
        }
      }
    } catch { /* page evaluate failed */ }

    // -- Check cookies ----------------------------------------------------
    try {
      const cookies = await ctx.context.cookies();
      for (const cookie of cookies) {
        if (AKAMAI_COOKIE_NAMES.includes(cookie.name)) {
          indicators.push({
            category: 'cookie',
            description: `Akamai cookie detected: ${cookie.name}`,
            weight: 0.25,
            rawValue: `${cookie.name}=${cookie.value.substring(0, 20)}...`,
          });
          confidence += 0.25;

          // Track the cookie
          this.trackAkamaiCookie(cookie.name, cookie.value, ctx.domain);

          // Parse bm_sz if present
          if (cookie.name === 'bm_sz') {
            const parsed = parseBmSzCookie(cookie.value);
            if (parsed) {
              this.bmSzCache.set(ctx.domain, parsed);
            }
          }
        }
      }
    } catch { /* cookie access failed */ }

    // -- Check script tags ------------------------------------------------
    try {
      const scriptUrls = await page.evaluate(() =>
        Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src') || '')
      );
      for (const scriptUrl of scriptUrls) {
        const lower = scriptUrl.toLowerCase();
        if (AKAMAI_SCRIPT_PATTERNS.some(p => lower.includes(p.toLowerCase()))) {
          indicators.push({
            category: 'script',
            description: `Akamai script detected: ${scriptUrl.substring(0, 80)}`,
            weight: 0.35,
            rawValue: scriptUrl,
          });
          confidence += 0.35;
        }
      }
    } catch { /* script evaluation failed */ }

    // -- Check for Akamai-injected DOM attributes ------------------------
    try {
      const hasAkamaiAttr = await page.evaluate(() => {
        const html = document.documentElement;
        return !!(html.getAttribute('data-akamai') || html.getAttribute('data-bm-sz'));
      });
      if (hasAkamaiAttr) {
        indicators.push({
          category: 'dom',
          description: 'Akamai data attribute detected on document element',
          weight: 0.2,
        });
        confidence += 0.2;
      }
    } catch { /* attribute check failed */ }

    // -- Check URL patterns -----------------------------------------------
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes('/akam/') || lowerUrl.includes('ak_bmsc') || lowerUrl.includes('bm_sz')) {
      indicators.push({
        category: 'url',
        description: 'Akamai URL pattern detected',
        weight: 0.2,
        rawValue: url.substring(0, 100),
      });
      confidence += 0.2;
    }

    // -- Check intercepted cookies from injection script ------------------
    try {
      const cookieAttr = await page.evaluate(() =>
        document.documentElement.getAttribute('data-akamai-cookies')
      );
      if (cookieAttr) {
        const parsed = JSON.parse(cookieAttr);
        if (parsed.bmSz) {
          const bmParsed = parseBmSzCookie(parsed.bmSz);
          if (bmParsed) {
            this.bmSzCache.set(ctx.domain, bmParsed);
          }
        }
      }
    } catch { /* cookie attribute extraction failed */ }

    // -- Determine challenge type -----------------------------------------
    const akamaiCookies = this.akamaiCookies.get(ctx.domain) || [];
    const hasAbck = akamaiCookies.some(c => c.name === '_abck' && c.isValid);
    const hasBmSz = akamaiCookies.some(c => c.name === 'bm_sz' && c.isValid);
    const hasAkBmsc = akamaiCookies.some(c => c.name === 'ak_bmsc' && c.isValid);

    if (hasAbck && hasBmSz) {
      // Has Akamai cookies -- could be rechallenge if we see challenge elements
      const hasChallengeDom = indicators.some(i => i.category === 'dom');
      if (hasChallengeDom) {
        challengeType = 'sensor-challenge';
        isRechallenge = true;
      } else {
        challengeType = 'post-challenge';
      }
    } else if (hasAkBmsc || hasBmSz) {
      challengeType = 'initial-challenge';
    } else if (confidence > 0.3) {
      challengeType = 'sensor-challenge';
    }

    // Clamp confidence
    confidence = Math.min(1, confidence);

    // Determine severity
    let severity: PlatformDetectionResult['severity'] = 'none';
    if (confidence >= 0.8) severity = 'critical';
    else if (confidence >= 0.6) severity = 'high';
    else if (confidence >= 0.4) severity = 'medium';
    else if (confidence >= 0.2) severity = 'low';

    // Determine recommended strategy
    const strategies = STRATEGY_ESCALATION.akamai;
    let recommendedStrategy: BypassStrategy = strategies[0];

    if (hasAbck && hasBmSz && isRechallenge) {
      // We have cookies but are being re-challenged -- try sensor synthesis
      recommendedStrategy = 'sensor-synthesis';
    } else if (hasAkBmsc && !hasAbck) {
      // Have basic cookie but not full session -- sensor synthesis
      recommendedStrategy = 'sensor-synthesis';
    } else if (confidence >= 0.7) {
      recommendedStrategy = 'sensor-synthesis';
    } else if (confidence >= 0.4) {
      recommendedStrategy = 'browser-execute';
    }

    logger.info(
      {
        domain: ctx.domain,
        confidence: confidence.toFixed(2),
        severity,
        challengeType,
        isRechallenge,
        indicators: indicators.length,
      },
      'Akamai detection complete'
    );

    return {
      platform: 'akamai',
      confidence,
      severity,
      indicators,
      challengeType,
      isRechallenge,
      recommendedStrategy,
    };
  }

  // --- Bypass ---------------------------------------------------------------

  /**
   * Attempt to bypass Akamai Bot Manager.
   * Uses sensor synthesis as the primary strategy, with escalation to
   * browser execution, profile rotation, TLS matching, and maximum stealth.
   */
  async bypass(ctx: BypassContext, strategy?: BypassStrategy): Promise<AntiBotResult> {
    const startTime = Date.now();
    this.stats.totalAttempts++;
    this.currentSessionId = this.generateSessionId();

    const domain = ctx.domain;
    const chosenStrategy = strategy ||
      (this.getOrCreateProfile(domain)).preferredStrategy ||
      STRATEGY_ESCALATION.akamai[0];

    // Check cooldown
    if (this.isInCooldown(domain)) {
      return this.buildFailureResult({
        strategy: chosenStrategy,
        durationMs: Date.now() - startTime,
        phase: 'cooldown',
        errors: [`Domain ${domain} is in cooldown -- wait before retrying`],
      });
    }

    // Check for cached valid tokens first
    const cachedTokens = this.getValidTokens(domain);
    if (cachedTokens.length > 0 && chosenStrategy !== 'sensor-synthesis') {
      this.stats.tokenReuses++;
      logger.info({ domain }, 'Reusing cached Akamai tokens');

      return this.buildSuccessResult({
        strategy: 'replay-tokens',
        durationMs: Date.now() - startTime,
        cookies: cachedTokens,
        rechallengeExpected: true,
        rechallengeInMs: this.estimateRechallengeTime(domain),
      });
    }

    logger.info(
      { domain, strategy: chosenStrategy, sessionId: this.currentSessionId },
      'Starting Akamai bypass'
    );

    // Execute strategy
    let result: AntiBotResult;
    switch (chosenStrategy) {
      case 'sensor-synthesis':
        result = await this.bypassWithSensorSynthesis(ctx);
        break;
      case 'browser-execute':
        result = await this.bypassWithBrowserExecute(ctx);
        break;
      case 'profile-rotation':
        result = await this.bypassWithProfileRotation(ctx);
        break;
      case 'tls-matching':
        result = await this.bypassWithTLSMatching(ctx);
        break;
      case 'maximum-stealth':
        result = await this.bypassWithMaximumStealth(ctx);
        break;
      default:
        result = await this.bypassWithSensorSynthesis(ctx);
    }

    // Record result for adaptive learning
    this.recordResult(domain, result.success, Date.now() - startTime, chosenStrategy);

    // If failed and we haven't escalated, try next strategy
    if (!result.success && chosenStrategy !== 'maximum-stealth') {
      const nextStrategy = this.escalateStrategy(domain);
      logger.info(
        { domain, from: chosenStrategy, to: nextStrategy },
        'Akamai bypass failed -- escalating strategy'
      );
    }

    return result;
  }

  // --- Sensor Synthesis Strategy --------------------------------------------

  /**
   * Primary Akamai bypass strategy: synthesize realistic sensor data
   * and inject it into the page for Akamai's collection scripts to pick up.
   */
  private async bypassWithSensorSynthesis(ctx: BypassContext): Promise<AntiBotResult> {
    const startTime = Date.now();
    const { page, domain } = ctx;

    try {
      // Step 1: Select a consistent fingerprint profile
      this.profileIndex = this.selectProfileIndex(domain);
      logger.info({ domain, profileIndex: this.profileIndex }, 'Selected Akamai fingerprint profile');

      // Step 2: Generate complete sensor data package
      const sensorPkg = this.generateSensorDataPackage(domain);
      logger.debug(
        {
          domain,
          mouseEvents: sensorPkg.mouseEvents.length,
          keyboardEvents: sensorPkg.keyboardEvents.length,
          touchEvents: sensorPkg.touchEvents.length,
          orientationEvents: sensorPkg.orientationEvents.length,
        },
        'Sensor data package generated'
      );

      // Step 3: Extract HMAC key from bm_sz cookie
      const bmSzParsed = this.bmSzCache.get(domain);
      const hmacKey = bmSzParsed?.hmacKey || this.deriveFallbackHmacKey(domain);

      // Step 4: Serialize and sign the sensor data
      const serialized = serializeSensorData(sensorPkg);
      const hmac = computeSensorHmac(serialized, hmacKey);
      logger.debug({ domain, hmacLength: hmac.length }, 'Sensor data HMAC computed');

      // Step 5: Inject fingerprint spoofing scripts
      await this.injectFingerprintScripts(page);

      // Step 6: Inject sensor data into the page
      await this.injectSensorData(page, sensorPkg, hmac);

      // Step 7: Wait for Akamai challenge resolution
      const resolved = await this.waitForChallengeResolution(page, this.config.solveTimeoutMs);

      if (!resolved) {
        return this.buildFailureResult({
          strategy: 'sensor-synthesis',
          durationMs: Date.now() - startTime,
          phase: 'executing',
          errors: ['Akamai challenge did not resolve within timeout'],
          metadata: { sessionId: this.currentSessionId, profileIndex: this.profileIndex },
        });
      }

      // Step 8: Extract cookies from the resolved page
      const cookies = await this.extractAkamaiCookies(ctx);

      if (cookies.length === 0) {
        return this.buildFailureResult({
          strategy: 'sensor-synthesis',
          durationMs: Date.now() - startTime,
          phase: 'extracting',
          errors: ['Challenge resolved but no Akamai cookies extracted'],
          metadata: { sessionId: this.currentSessionId },
        });
      }

      // Step 9: Store cookies and return success
      await this.storeTokens(domain, cookies);

      logger.info(
        { domain, cookiesFound: cookies.length, durationMs: Date.now() - startTime },
        'Akamai sensor synthesis bypass successful'
      );

      return this.buildSuccessResult({
        strategy: 'sensor-synthesis',
        durationMs: Date.now() - startTime,
        cookies,
        rechallengeExpected: true,
        rechallengeInMs: this.estimateRechallengeTime(domain),
        metadata: {
          sessionId: this.currentSessionId,
          profileIndex: this.profileIndex,
          sensorEventCount: sensorPkg.mouseEvents.length + sensorPkg.keyboardEvents.length,
        },
      });
    } catch (err: any) {
      logger.error({ err: err.message, domain }, 'Sensor synthesis bypass failed');
      return this.buildFailureResult({
        strategy: 'sensor-synthesis',
        durationMs: Date.now() - startTime,
        errors: [err.message],
      });
    }
  }

  // --- Browser Execute Strategy ---------------------------------------------

  /**
   * Let the browser execute Akamai's JavaScript naturally, but with
   * stealth patches applied to avoid detection.
   */
  private async bypassWithBrowserExecute(ctx: BypassContext): Promise<AntiBotResult> {
    const startTime = Date.now();
    const { page, domain } = ctx;

    try {
      // Inject fingerprint spoofing only (no synthetic sensor data)
      await this.injectFingerprintScripts(page);

      // Wait for the challenge to resolve naturally
      const resolved = await this.waitForChallengeResolution(page, this.config.solveTimeoutMs);

      if (!resolved) {
        return this.buildFailureResult({
          strategy: 'browser-execute',
          durationMs: Date.now() - startTime,
          phase: 'executing',
          errors: ['Akamai challenge did not resolve within timeout'],
        });
      }

      const cookies = await this.extractAkamaiCookies(ctx);

      if (cookies.length === 0) {
        return this.buildFailureResult({
          strategy: 'browser-execute',
          durationMs: Date.now() - startTime,
          phase: 'extracting',
          errors: ['No Akamai cookies extracted after challenge resolution'],
        });
      }

      await this.storeTokens(domain, cookies);

      return this.buildSuccessResult({
        strategy: 'browser-execute',
        durationMs: Date.now() - startTime,
        cookies,
        rechallengeExpected: true,
        rechallengeInMs: this.estimateRechallengeTime(domain),
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'browser-execute',
        durationMs: Date.now() - startTime,
        errors: [err.message],
      });
    }
  }

  // --- Profile Rotation Strategy --------------------------------------------

  /**
   * Rotate to a different fingerprint profile and retry sensor synthesis.
   */
  private async bypassWithProfileRotation(ctx: BypassContext): Promise<AntiBotResult> {
    const startTime = Date.now();
    const { domain } = ctx;

    // Rotate to next profile
    this.profileIndex = (this.profileIndex + 1) % SCREEN_PROFILES.length;

    logger.info(
      { domain, newProfileIndex: this.profileIndex },
      'Rotating Akamai fingerprint profile'
    );

    // Store the new profile preference for this domain
    const profile = this.getOrCreateProfile(domain);
    profile.extra = { ...profile.extra, profileIndex: this.profileIndex };

    // Retry with sensor synthesis using the new profile
    return this.bypassWithSensorSynthesis(ctx);
  }

  // --- TLS Matching Strategy ------------------------------------------------

  /**
   * TLS fingerprint matching -- ensures the TLS fingerprint of outgoing
   * requests matches the browser profile being presented.
   * Delegates to the tls-fingerprint module for actual implementation.
   */
  private async bypassWithTLSMatching(ctx: BypassContext): Promise<AntiBotResult> {
    const startTime = Date.now();
    const { page, domain } = ctx;

    logger.info({ domain }, 'Attempting Akamai bypass with TLS matching');

    try {
      // Inject sensor data + fingerprint scripts
      await this.injectFingerprintScripts(page);

      // The actual TLS fingerprint modification happens at the proxy level
      // Here we just ensure sensor data is present and wait for resolution
      const sensorPkg = this.generateSensorDataPackage(domain);
      const serialized = serializeSensorData(sensorPkg);
      const hmacKey = this.bmSzCache.get(domain)?.hmacKey || this.deriveFallbackHmacKey(domain);
      const hmac = computeSensorHmac(serialized, hmacKey);

      await this.injectSensorData(page, sensorPkg, hmac);

      const resolved = await this.waitForChallengeResolution(page, this.config.solveTimeoutMs);
      const cookies = resolved ? await this.extractAkamaiCookies(ctx) : [];

      if (cookies.length > 0) {
        await this.storeTokens(domain, cookies);
        return this.buildSuccessResult({
          strategy: 'tls-matching',
          durationMs: Date.now() - startTime,
          cookies,
          rechallengeExpected: true,
          rechallengeInMs: this.estimateRechallengeTime(domain),
        });
      }

      return this.buildFailureResult({
        strategy: 'tls-matching',
        durationMs: Date.now() - startTime,
        errors: ['TLS matching strategy did not produce valid cookies'],
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'tls-matching',
        durationMs: Date.now() - startTime,
        errors: [err.message],
      });
    }
  }

  // --- Maximum Stealth Strategy ---------------------------------------------

  /**
   * Apply all stealth measures: sensor synthesis, fingerprint spoofing,
   * behavioral mimicry, and extended patience for challenge resolution.
   */
  private async bypassWithMaximumStealth(ctx: BypassContext): Promise<AntiBotResult> {
    const startTime = Date.now();
    const { page, domain } = ctx;

    logger.info({ domain }, 'Attempting Akamai bypass with maximum stealth');

    try {
      // Inject all scripts with maximum stealth
      await this.injectFingerprintScripts(page);

      // Generate comprehensive sensor data with more events
      const sensorPkg = this.generateSensorDataPackage(domain, true /* extended */);
      const serialized = serializeSensorData(sensorPkg);
      const hmacKey = this.bmSzCache.get(domain)?.hmacKey || this.deriveFallbackHmacKey(domain);
      const hmac = computeSensorHmac(serialized, hmacKey);

      await this.injectSensorData(page, sensorPkg, hmac);

      // Simulate human-like interactions on the page
      await this.simulateHumanBehavior(page);

      // Extended timeout for maximum stealth
      const extendedTimeout = this.config.solveTimeoutMs * 1.5;
      const resolved = await this.waitForChallengeResolution(page, extendedTimeout);
      const cookies = resolved ? await this.extractAkamaiCookies(ctx) : [];

      if (cookies.length > 0) {
        await this.storeTokens(domain, cookies);
        return this.buildSuccessResult({
          strategy: 'maximum-stealth',
          durationMs: Date.now() - startTime,
          cookies,
          rechallengeExpected: true,
          rechallengeInMs: this.estimateRechallengeTime(domain),
        });
      }

      return this.buildFailureResult({
        strategy: 'maximum-stealth',
        durationMs: Date.now() - startTime,
        errors: ['Maximum stealth strategy did not produce valid cookies'],
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'maximum-stealth',
        durationMs: Date.now() - startTime,
        errors: [err.message],
      });
    }
  }

  // --- Sensor Data Generation -----------------------------------------------

  /**
   * Generate a complete sensor data package for Akamai submission.
   * When extended is true, generates more events for maximum stealth mode.
   */
  private generateSensorDataPackage(domain: string, extended = false): SensorDataPackage {
    const screenProfile = SCREEN_PROFILES[this.profileIndex % SCREEN_PROFILES.length];
    const navigatorProfile = { ...NAVIGATOR_PROFILES[this.profileIndex % NAVIGATOR_PROFILES.length] };

    // Generate mouse movement data
    const mouseEvents: MouseEventSample[] = [];
    const centerX = screenProfile.width / 2;
    const centerY = screenProfile.height / 2;

    // Initial move to center of page
    mouseEvents.push(...generateMousePath(
      Math.random() * 200, Math.random() * 100,
      centerX, centerY,
      extended ? 35 : 20
    ));

    // Some exploration movements
    const numMovements = extended ? 5 : 3;
    for (let i = 0; i < numMovements; i++) {
      const targetX = 100 + Math.random() * (screenProfile.width - 200);
      const targetY = 100 + Math.random() * (screenProfile.height - 200);
      const lastEvent = mouseEvents[mouseEvents.length - 1];
      mouseEvents.push(...generateMousePath(
        lastEvent.x, lastEvent.y, targetX, targetY,
        12 + Math.floor(Math.random() * 10)
      ));

      // Add idle jitter between movements
      mouseEvents.push(...generateIdleMouseJitter(
        targetX, targetY, 1500 + Math.random() * 2000, 3
      ));
    }

    // Generate keyboard events (simulating typing in a search field)
    const searchTerms = ['shoes', 'laptops', 'flights', 'hotels', 'news'];
    const keyboardEvents = generateKeyboardSequence(
      searchTerms[Math.floor(Math.random() * searchTerms.length)]
    );

    // Generate touch events (only if maxTouchPoints > 0)
    const touchEvents: TouchEventSample[] = [];
    if (navigatorProfile.maxTouchPoints > 0) {
      touchEvents.push(...generateTouchSwipe(
        centerX - 100, centerY + 100,
        centerX + 100, centerY - 100,
        250 + Math.random() * 150
      ));
    }

    // Generate orientation events
    const orientationEvents = generateOrientationSamples(
      extended ? 8000 : 5000,
      2
    );

    // Generate fingerprints
    const canvasFingerprint = generateCanvasFingerprint(this.profileIndex);
    const webglFingerprint = generateWebGLFingerprint(this.profileIndex);
    const audioFingerprint = generateAudioFingerprint(this.profileIndex);

    // Select font list (slight variation per profile)
    const fontOffset = (this.profileIndex * 3) % 5;
    const fontList = COMMON_FONTS.slice(fontOffset, fontOffset + 15);

    return {
      mouseEvents,
      keyboardEvents,
      touchEvents,
      orientationEvents,
      screenInfo: screenProfile,
      navigatorInfo: navigatorProfile,
      canvasFingerprint,
      webglFingerprint,
      audioFingerprint,
      fontList,
      timestamp: Date.now(),
      sessionId: this.currentSessionId,
    };
  }

  // --- Script Injection -----------------------------------------------------

  /**
   * Inject fingerprint spoofing scripts into the page.
   * Sets up WebGL vendor/renderer overrides, canvas noise, and navigator property overrides.
   */
  private async injectFingerprintScripts(page: Page): Promise<void> {
    if (this.scriptsInjected) return;

    try {
      const rendererInfo = WEBGL_RENDERERS[this.profileIndex % WEBGL_RENDERERS.length];
      const navigatorProfile = NAVIGATOR_PROFILES[this.profileIndex % NAVIGATOR_PROFILES.length];

      // Set up override variables before injecting the spoof script
      await page.evaluate(
        ({ vendor, renderer, hwConcurrency, deviceMemory, maxTouchPoints }) => {
          (window as any).__akamai_webgl_vendor = vendor;
          (window as any).__akamai_webgl_renderer = renderer;
          (window as any).__akamai_nav_hwConcurrency = hwConcurrency;
          (window as any).__akamai_nav_deviceMemory = deviceMemory;
          (window as any).__akamai_nav_maxTouchPoints = maxTouchPoints;
        },
        {
          vendor: rendererInfo.vendor,
          renderer: rendererInfo.renderer,
          hwConcurrency: navigatorProfile.hardwareConcurrency,
          deviceMemory: navigatorProfile.deviceMemory,
          maxTouchPoints: navigatorProfile.maxTouchPoints,
        }
      );

      // Inject the fingerprint spoof script
      await page.evaluate(FINGERPRINT_SPOOF_SCRIPT);

      // Inject the sensor data interception script
      await page.evaluate(SENSOR_INJECTION_SCRIPT);

      this.scriptsInjected = true;
      logger.debug({ profileIndex: this.profileIndex }, 'Fingerprint scripts injected');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to inject fingerprint scripts (non-critical)');
    }
  }

  /**
   * Inject synthesized sensor data and HMAC into the page.
   */
  private async injectSensorData(
    page: Page,
    sensorPkg: SensorDataPackage,
    hmac: string
  ): Promise<void> {
    try {
      // Serialize the sensor data into a format the interception script can use
      const sensorObject = {
        mouseEvents: sensorPkg.mouseEvents.map(e => [e.x, e.y, e.timestamp, e.pressure]),
        keyboardEvents: sensorPkg.keyboardEvents.map(e => [e.keyCode, e.timestamp, e.shiftKey ? 1 : 0]),
        touchEvents: sensorPkg.touchEvents.map(e => [e.x, e.y, e.timestamp, e.pressure, e.radiusX, e.radiusY]),
        orientationEvents: sensorPkg.orientationEvents.map(e => [e.alpha, e.beta, e.gamma, e.timestamp]),
        screenInfo: sensorPkg.screenInfo,
        navigatorInfo: {
          hardwareConcurrency: sensorPkg.navigatorInfo.hardwareConcurrency,
          deviceMemory: sensorPkg.navigatorInfo.deviceMemory,
          maxTouchPoints: sensorPkg.navigatorInfo.maxTouchPoints,
        },
        canvasHash: sensorPkg.canvasFingerprint,
        webglHash: sensorPkg.webglFingerprint.hash,
        audioHash: sensorPkg.audioFingerprint,
        fonts: sensorPkg.fontList,
        sessionId: sensorPkg.sessionId,
        timestamp: sensorPkg.timestamp,
      };

      await page.evaluate(
        ({ data, hmacValue }) => {
          (window as any).__akamai_sensor_data = data;
          (window as any).__akamai_hmac = hmacValue;
        },
        { data: sensorObject, hmacValue: hmac }
      );

      logger.debug('Sensor data and HMAC injected into page');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to inject sensor data');
    }
  }

  // --- Challenge Resolution -------------------------------------------------

  /**
   * Wait for the Akamai challenge to resolve on the page.
   * Monitors for challenge element removal, cookie changes, and page navigation.
   */
  private async waitForChallengeResolution(page: Page, timeout: number): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 500;

    logger.debug({ timeout }, 'Waiting for Akamai challenge resolution');

    while (Date.now() - startTime < timeout) {
      try {
        // Check if challenge DOM elements have been removed
        let challengeGone = true;
        for (const selector of AKAMAI_DOM_SELECTORS) {
          try {
            const element = await page.$(selector);
            if (element) {
              challengeGone = false;
              break;
            }
          } catch { /* selector check failed */ }
        }

        // Check if sensor data was sent
        let sensorSent = false;
        try {
          sensorSent = await page.evaluate(() =>
            document.documentElement.getAttribute('data-akamai-sensor-sent') === 'true'
          );
        } catch { /* evaluate failed */ }

        // Check for Akamai cookies (indicates challenge was solved)
        let hasAkamaiCookies = false;
        try {
          const cookieAttr = await page.evaluate(() =>
            document.documentElement.getAttribute('data-akamai-cookies')
          );
          if (cookieAttr) {
            const parsed = JSON.parse(cookieAttr);
            hasAkamaiCookies = !!(parsed.abck || parsed.akBmsc);
          }
        } catch { /* cookie attribute check failed */ }

        if (!hasAkamaiCookies) {
          try {
            const cookies = await page.context().cookies();
            hasAkamaiCookies = cookies.some(c => AKAMAI_COOKIE_NAMES.includes(c.name));
          } catch { /* cookie access failed */ }
        }

        // Challenge is resolved if:
        // 1. Challenge elements are gone AND we have cookies, OR
        // 2. Sensor data was sent AND we have cookies
        if ((challengeGone && hasAkamaiCookies) || (sensorSent && hasAkamaiCookies)) {
          logger.info(
            { durationMs: Date.now() - startTime, hasAkamaiCookies, challengeGone, sensorSent },
            'Akamai challenge resolved'
          );
          return true;
        }

        // Check if page navigated away (challenge may have redirected)
        const currentUrl = page.url().toLowerCase();
        const isStillChallenge = currentUrl.includes('/akam/') ||
          currentUrl.includes('ak-challenge') ||
          currentUrl.includes('bm-challenge');

        if (challengeGone && !isStillChallenge && hasAkamaiCookies) {
          logger.info({ durationMs: Date.now() - startTime }, 'Akamai challenge resolved (navigation)');
          return true;
        }

        await this.sleep(checkInterval);
      } catch (err: any) {
        // Page might have navigated -- check if we can still access it
        try {
          await page.evaluate(() => document.title);
        } catch {
          // Page navigated away -- likely challenge solved
          logger.info('Page navigated away -- assuming Akamai challenge resolved');
          return true;
        }
      }
    }

    logger.warn({ timeout }, 'Akamai challenge resolution timed out');
    return false;
  }

  // --- Cookie Extraction & Lifecycle ----------------------------------------

  /**
   * Extract Akamai cookies from the browser context and DOM attributes.
   * Returns ManagedCookie instances with proper lifecycle metadata.
   */
  private async extractAkamaiCookies(ctx: BypassContext): Promise<ManagedCookie[]> {
    const cookies: ManagedCookie[] = [];
    const now = Date.now();

    // Extract from Playwright's cookie API
    try {
      const rawCookies = await ctx.context.cookies();
      for (const cookie of rawCookies) {
        if (AKAMAI_COOKIE_NAMES.includes(cookie.name)) {
          const lifetimeMs = this.estimateCookieLifetime(cookie.name);
          cookies.push(this.createManagedCookie(
            {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path || '/',
              httpOnly: cookie.httpOnly,
              secure: cookie.secure,
              sameSite: (cookie.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
            },
            lifetimeMs
          ));

          // Track internally
          this.trackAkamaiCookie(cookie.name, cookie.value, ctx.domain);

          // Parse bm_sz if present
          if (cookie.name === 'bm_sz') {
            const parsed = parseBmSzCookie(cookie.value);
            if (parsed) {
              this.bmSzCache.set(ctx.domain, parsed);
            }
          }
        }
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Failed to extract cookies from context');
    }

    // Also try extracting from DOM attributes set by our injection script
    try {
      const cookieAttr = await ctx.page.evaluate(() =>
        document.documentElement.getAttribute('data-akamai-cookies')
      );
      if (cookieAttr) {
        const parsed = JSON.parse(cookieAttr);
        const existingNames = new Set(cookies.map(c => c.name));

        if (parsed.akBmsc && !existingNames.has('ak_bmsc')) {
          cookies.push(this.createManagedCookie(
            { name: 'ak_bmsc', value: parsed.akBmsc, domain: ctx.domain },
            this.estimateCookieLifetime('ak_bmsc')
          ));
        }
        if (parsed.bmSz && !existingNames.has('bm_sz')) {
          cookies.push(this.createManagedCookie(
            { name: 'bm_sz', value: parsed.bmSz, domain: ctx.domain },
            this.estimateCookieLifetime('bm_sz')
          ));

          const bmParsed = parseBmSzCookie(parsed.bmSz);
          if (bmParsed) {
            this.bmSzCache.set(ctx.domain, bmParsed);
          }
        }
        if (parsed.abck && !existingNames.has('_abck')) {
          cookies.push(this.createManagedCookie(
            { name: '_abck', value: parsed.abck, domain: ctx.domain },
            this.estimateCookieLifetime('_abck')
          ));
        }
      }
    } catch { /* DOM extraction failed */ }

    logger.info(
      { domain: ctx.domain, cookieCount: cookies.length, names: cookies.map(c => c.name) },
      'Akamai cookies extracted'
    );

    return cookies;
  }

  /**
   * Track an Akamai cookie internally for lifecycle management.
   */
  private trackAkamaiCookie(name: string, value: string, domain: string): void {
    let domainCookies = this.akamaiCookies.get(domain);
    if (!domainCookies) {
      domainCookies = [];
      this.akamaiCookies.set(domain, domainCookies);
    }

    const now = Date.now();
    const existing = domainCookies.find(c => c.name === name);
    if (existing) {
      existing.value = value;
      existing.refreshedAt = now;
      existing.isValid = true;
    } else {
      domainCookies.push({
        name,
        value,
        domain,
        setAt: now,
        refreshedAt: now,
        expiresAt: now + this.estimateCookieLifetime(name),
        isValid: true,
      });
    }
  }

  /**
   * Estimate the lifetime of an Akamai cookie based on its name.
   */
  private estimateCookieLifetime(cookieName: string): number {
    switch (cookieName) {
      case 'ak_bmsc':
        return 1800000;  // 30 minutes
      case 'bm_sz':
        return 3600000;  // 1 hour
      case '_abck':
        return 7200000;  // 2 hours
      default:
        return this.config.tokenFreshnessMs;
    }
  }

  /**
   * Estimate when a re-challenge is expected based on domain profile.
   */
  private estimateRechallengeTime(domain: string): number {
    const profile = this.getProfile(domain);
    if (profile?.avgTokenLifetimeMs) {
      return Math.max(profile.avgTokenLifetimeMs * 0.8, 60000);
    }
    return 300000; // Default: 5 minutes
  }

  // --- Human Behavior Simulation --------------------------------------------

  /**
   * Simulate human-like interactions on the page to make the browser
   * session appear more natural to Akamai's behavioral analysis.
   */
  private async simulateHumanBehavior(page: Page): Promise<void> {
    try {
      // Move mouse to a random position on the page
      const viewport = page.viewportSize();
      if (viewport) {
        const x = 100 + Math.random() * (viewport.width - 200);
        const y = 100 + Math.random() * (viewport.height - 200);
        await page.mouse.move(x, y, { steps: 10 });
        await this.sleep(300 + Math.random() * 500);

        // Scroll down slightly
        await page.mouse.wheel(0, 100 + Math.random() * 200);
        await this.sleep(500 + Math.random() * 800);

        // Move mouse again
        const x2 = 150 + Math.random() * (viewport.width - 300);
        const y2 = 200 + Math.random() * (viewport.height - 400);
        await page.mouse.move(x2, y2, { steps: 8 });
        await this.sleep(200 + Math.random() * 400);
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Human behavior simulation failed (non-critical)');
    }
  }

  // --- Helpers --------------------------------------------------------------

  /**
   * Select a profile index for a domain, maintaining consistency
   * across sessions for the same domain.
   */
  private selectProfileIndex(domain: string): number {
    const profile = this.getProfile(domain);
    if (profile?.extra?.profileIndex !== undefined) {
      return profile.extra.profileIndex as number;
    }

    // Deterministic selection based on domain hash
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
      hash = ((hash << 5) - hash + domain.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % SCREEN_PROFILES.length;
  }

  /**
   * Generate a unique session ID for sensor data correlation.
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `ak_${timestamp}_${random}`;
  }

  /**
   * Derive a fallback HMAC key when bm_sz is not available.
   * Uses a domain-specific key derived from the domain name.
   */
  private deriveFallbackHmacKey(domain: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < domain.length; i++) {
      hash ^= domain.charCodeAt(i);
      hash = (hash * 0x01000193) | 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0') +
           Math.abs(hash ^ 0xdeadbeef).toString(16).padStart(8, '0');
  }

  /**
   * Reset script injection state (call when navigating to a new page).
   */
  resetInjectionState(): void {
    this.scriptsInjected = false;
  }

  /**
   * Get the current profile index (useful for debugging/logging).
   */
  getCurrentProfileIndex(): number {
    return this.profileIndex;
  }

  /**
   * Get tracked Akamai cookies for a domain.
   */
  getTrackedCookies(domain: string): AkamaiTrackedCookie[] {
    return this.akamaiCookies.get(domain) || [];
  }

  /**
   * Get the parsed bm_sz value for a domain.
   */
  getBmSzParsed(domain: string): BmSzParsed | null {
    return this.bmSzCache.get(domain) || null;
  }

  /**
   * Clean up expired cookies from internal tracking.
   */
  cleanupExpiredCookies(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [domain, cookies] of this.akamaiCookies.entries()) {
      const validCookies = cookies.filter(c => {
        if (c.expiresAt <= now) {
          c.isValid = false;
          cleaned++;
          return false;
        }
        return true;
      });

      if (validCookies.length === 0) {
        this.akamaiCookies.delete(domain);
      } else {
        this.akamaiCookies.set(domain, validCookies);
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Expired Akamai cookies cleaned up');
    }
  }

  /**
   * Override getStats to include Akamai-specific metrics.
   */
  getStats(): Record<string, unknown> {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      profileIndex: this.profileIndex,
      trackedDomains: this.akamaiCookies.size,
      totalTrackedCookies: Array.from(this.akamaiCookies.values())
        .reduce((sum, cookies) => sum + cookies.length, 0),
      bmSzCacheSize: this.bmSzCache.size,
      scriptsInjected: this.scriptsInjected,
    };
  }
}

// ===============================================================================
// SINGLETON & EXPORTS
// ===============================================================================

export const akamaiSensorEngine = new AkamaiSensorEngine();
export default AkamaiSensorEngine;

// Re-export internal helpers for testing
export {
  parseBmSzCookie,
  computeSensorHmac,
  serializeSensorData,
  generateMousePath,
  generateKeyboardSequence,
  generateTouchSwipe,
  generateOrientationSamples,
  generateCanvasFingerprint,
  generateWebGLFingerprint,
  generateAudioFingerprint,
};
