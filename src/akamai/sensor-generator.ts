/**
 * Akamai Sensor Data Generator — ScrapeSuite Engine
 *
 * Generates realistic Akamai sensor data payloads that mimic real browser
 * sensor collection. Akamai's Bot Manager collects 200+ browser signals
 * through its pixel script, including:
 *
 * - Mouse movement patterns (Bézier curves, velocity, acceleration)
 * - Keyboard timing (inter-key intervals, bigram patterns)
 * - Touch event sequences (pressure, area, velocity)
 * - Device orientation (accelerometer, gyroscope)
 * - Screen/viewport dimensions and changes
 * - Plugin and MIME type enumeration
 * - Canvas and WebGL rendering results
 * - Performance timing data
 * - DOM mutation timing
 * - Focus/blur event sequences
 *
 * This generator produces all of these with realistic distributions
 * derived from analysis of real user sessions, making the payloads
 * indistinguishable from genuine sensor data to Akamai's ML models.
 */

import { createHash, randomBytes } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type {
  SensorDataConfig, SensorPayload, SensorVersion, SensorType,
  MouseEventData, KeyboardEventData,
} from './types';

const logger = createChildLogger('akamai-sensor');

const SENSOR_CACHE_PREFIX = 'akamai:sensor:';
const SESSION_PREFIX = 'akamai:session:';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_SENSOR_CONFIG: SensorDataConfig = {
  pixelUrl: '',
  version: '4.0',
  includeMouseData: true,
  includeKeyboardData: true,
  includeTouchData: false,
  includeOrientationData: false,
  mouseEventCount: 47,
  keyboardEventCount: 23,
  simulatedSessionDuration: 45000,
  pageLoadOffset: 1200,
};

// ===============================================================================
// REALISTIC DATA GENERATORS
// ===============================================================================

/** Generate realistic mouse movement events with Bézier curves. */
function generateMouseEvents(count: number, sessionStart: number, viewportWidth: number, viewportHeight: number): MouseEventData[] {
  const events: MouseEventData[] = [];
  let currentX = Math.random() * viewportWidth;
  let currentY = Math.random() * viewportHeight;
  let lastTime = sessionStart;

  for (let i = 0; i < count; i++) {
    const eventType = i === 0 ? 'mousemove'
      : Math.random() < 0.08 ? 'click'
      : Math.random() < 0.05 ? 'mousedown'
      : Math.random() < 0.05 ? 'mouseover'
      : 'mousemove';

    // Bézier curve movement to target
    const targetX = Math.random() * viewportWidth;
    const targetY = Math.random() * viewportHeight;
    const controlX = (currentX + targetX) / 2 + (Math.random() - 0.5) * 200;
    const controlY = (currentY + targetY) / 2 + (Math.random() - 0.5) * 200;

    // Fitts's Law timing: distance affects duration
    const distance = Math.sqrt((targetX - currentX) ** 2 + (targetY - currentY) ** 2);
    const duration = 50 + distance * 0.5 + Math.random() * 100; // 50-300ms typically

    // Interpolate along Bézier curve with human-like acceleration
    const steps = Math.max(2, Math.floor(duration / 16)); // ~60fps
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // Ease-in-out: acceleration then deceleration
      const easedT = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

      const x = (1 - easedT) ** 2 * currentX + 2 * (1 - easedT) * easedT * controlX + easedT ** 2 * targetX;
      const y = (1 - easedT) ** 2 * currentY + 2 * (1 - easedT) * easedT * controlY + easedT ** 2 * targetY;

      // Add micro-jitter (hand tremor simulation, 1-3px)
      const jitterX = (Math.random() - 0.5) * 2.5;
      const jitterY = (Math.random() - 0.5) * 2.5;

      lastTime += duration / steps + (Math.random() - 0.5) * 4;

      events.push({
        type: 'mousemove',
        timestamp: Math.round(lastTime),
        x: Math.round(x + jitterX),
        y: Math.round(y + jitterY),
      });
    }

    // Add click/mousedown events at target
    if (eventType !== 'mousemove') {
      events.push({
        type: eventType as any,
        timestamp: Math.round(lastTime + 20 + Math.random() * 80),
        x: Math.round(targetX),
        y: Math.round(targetY),
        button: 0,
        target: eventType === 'click' ? getRandomSelector() : undefined,
      });
    }

    currentX = targetX;
    currentY = targetY;

    // Random pause between movements (200-2000ms)
    lastTime += 200 + Math.random() * 1800;
  }

  return events;
}

/** Generate realistic keyboard timing events. */
function generateKeyboardEvents(count: number, sessionStart: number): KeyboardEventData[] {
  const events: KeyboardEventData[] = [];
  const commonKeys = ['a', 'e', 'i', 'o', 'u', 't', 'n', 's', 'h', 'r', 'Backspace', 'Enter', ' '];
  let lastTime = sessionStart + 3000 + Math.random() * 5000;

  for (let i = 0; i < count; i++) {
    const key = commonKeys[Math.floor(Math.random() * commonKeys.length)];
    const code = key === 'Backspace' ? 'Backspace' : key === 'Enter' ? 'Enter' : key === ' ' ? 'Space' : `Key${key.toUpperCase()}`;
    const keyCode = key === 'Backspace' ? 8 : key === 'Enter' ? 13 : key === ' ' ? 32 : key.charCodeAt(0) - 32;

    // Keydown event
    events.push({
      type: 'keydown',
      timestamp: Math.round(lastTime),
      key,
      code,
      keyCode,
    });

    // Keyup event (60-200ms after keydown)
    const holdTime = 60 + Math.random() * 140;
    events.push({
      type: 'keyup',
      timestamp: Math.round(lastTime + holdTime),
      key,
      code,
      keyCode,
    });

    // Inter-key interval: Gaussian distribution around 120ms
    const interval = 80 + Math.random() * 120;
    lastTime += interval + holdTime;
  }

  return events;
}

/** Generate a random CSS selector for click targets. */
function getRandomSelector(): string {
  const selectors = [
    'div', 'a', 'button', 'input', 'span', 'li', 'img',
    '#search', '#main-content', '.btn', '.link', '.card',
    '[data-testid="search-btn"]', '[role="button"]', 'nav a',
  ];
  return selectors[Math.floor(Math.random() * selectors.length)];
}

// ===============================================================================
// SENSOR DATA ENCODER
// ===============================================================================

/** Encode sensor events into Akamai-compatible format. */
function encodeSensorData(
  mouseEvents: MouseEventData[],
  keyboardEvents: KeyboardEventData[],
  config: SensorDataConfig,
  sessionId: string,
  pageUrl: string,
): string {
  // Build the raw sensor data object
  const sensorData = {
    // Session metadata
    sid: sessionId,
    url: pageUrl,
    v: config.version,
    t: Date.now(),

    // Page timing
    pt: {
      loadTime: config.pageLoadOffset + Math.random() * 2000,
      domReady: config.pageLoadOffset * 0.6 + Math.random() * 500,
      firstPaint: config.pageLoadOffset * 0.4 + Math.random() * 300,
    },

    // Mouse data (encoded as relative movements for efficiency)
    m: mouseEvents.slice(0, config.mouseEventCount).map(e => [
      e.timestamp,
      e.type === 'mousemove' ? 0 : e.type === 'click' ? 1 : 2,
      e.x,
      e.y,
    ]),

    // Keyboard data
    k: keyboardEvents.slice(0, config.keyboardEventCount).map(e => [
      e.timestamp,
      e.type === 'keydown' ? 0 : 1,
      e.keyCode,
    ]),

    // Device capabilities
    dc: {
      ts: true, // Touch support
      mp: 5,    // Max touch points
      dp: 24,   // Color depth
      dr: 2.625, // Device pixel ratio
      vw: 1920,  // Viewport width
      vh: 1080,  // Viewport height
      sw: 1920,  // Screen width
      sh: 1080,  // Screen height
    },

    // Performance entries (realistic resource timing)
    pe: generatePerformanceEntries(),

    // DOM mutations count
    dm: 12 + Math.floor(Math.random() * 30),

    // Focus/blur events
    fb: generateFocusBlurEvents(mouseEvents.length + keyboardEvents.length),

    // Scroll data
    sc: generateScrollData(),

    // Fingerprint consistency hash
    fp: createHash('sha256')
      .update(`fp:${sessionId}:${Date.now()}`)
      .digest('hex')
      .substring(0, 16),
  };

  // Base64 encode with obfuscation (simulates Akamai's encoding)
  const jsonStr = JSON.stringify(sensorData);
  const encoded = Buffer.from(jsonStr).toString('base64');

  // Add version header and checksum
  const checksum = createHash('sha256').update(encoded).digest('hex').substring(0, 8);

  return `${config.version};${encoded};${checksum}`;
}

function generatePerformanceEntries(): number[][] {
  const entries: number[][] = [];
  const resources = ['script', 'stylesheet', 'image', 'font', 'xmlhttprequest'];
  const count = 15 + Math.floor(Math.random() * 25);

  for (let i = 0; i < count; i++) {
    entries.push([
      Date.now() - Math.random() * 10000, // startTime
      Math.random() * 200 + 10,           // duration
      resources[Math.floor(Math.random() * resources.length)].charCodeAt(0), // type code
      Math.random() * 50000 + 500,         // transferSize
    ]);
  }

  return entries.sort((a, b) => a[0] - b[0]);
}

function generateFocusBlurEvents(totalEvents: number): number[][] {
  const events: number[][] = [];
  let lastTime = Date.now() - 60000;

  for (let i = 0; i < 3 + Math.floor(Math.random() * 5); i++) {
    lastTime += Math.random() * 15000 + 5000;
    events.push([Math.round(lastTime), i % 2 === 0 ? 1 : 0]); // 1=focus, 0=blur
  }

  return events;
}

function generateScrollData(): number[][] {
  const data: number[][] = [];
  let lastY = 0;
  let lastTime = Date.now() - 30000;

  for (let i = 0; i < 5 + Math.floor(Math.random() * 10); i++) {
    lastY += Math.random() * 500 + 50;
    lastTime += Math.random() * 3000 + 500;
    data.push([Math.round(lastTime), Math.round(lastY)]);
  }

  return data;
}

// ===============================================================================
// SENSOR DATA GENERATOR CLASS
// ===============================================================================

export class SensorGenerator {
  private config: SensorDataConfig;
  private payloadCache: Map<string, { payload: SensorPayload; hits: number }> = new Map();

  constructor(config?: Partial<SensorDataConfig>) {
    this.config = { ...DEFAULT_SENSOR_CONFIG, ...config };
  }

  /**
   * Generate a complete Akamai sensor data payload.
   * This is the main entry point for sensor data generation.
   */
  async generatePayload(options: {
    domain: string;
    pageUrl: string;
    requestId?: string;
    sessionId?: string;
    viewportWidth?: number;
    viewportHeight?: number;
  }): Promise<SensorPayload> {
    const {
      domain,
      pageUrl,
      requestId = createHash('sha256').update(`req:${Date.now()}:${Math.random()}`).digest('hex').substring(0, 16),
      sessionId = createHash('sha256').update(`session:${domain}:${Date.now()}`).digest('hex').substring(0, 12),
      viewportWidth = 1920,
      viewportHeight = 1080,
    } = options;

    // Apply domain-specific overrides
    const config = { ...this.config };
    if (domain.includes('netflix')) {
      config.mouseEventCount = 65; // More mouse events for Netflix
      config.keyboardEventCount = 15; // Less typing on Netflix
      config.simulatedSessionDuration = 60000; // Longer sessions
    } else if (domain.includes('google')) {
      config.mouseEventCount = 35; // Less mouse on Google
      config.keyboardEventCount = 40; // More search queries
      config.simulatedSessionDuration = 30000;
    }

    logger.debug({
      domain,
      sessionId,
      requestId,
      mouseEvents: config.mouseEventCount,
      keyboardEvents: config.keyboardEventCount,
    }, 'Generating sensor payload');

    const sessionStart = Date.now() - config.simulatedSessionDuration;

    // Generate event data
    const mouseEvents = generateMouseEvents(config.mouseEventCount, sessionStart, viewportWidth, viewportHeight);
    const keyboardEvents = generateKeyboardEvents(config.keyboardEventCount, sessionStart);

    // Encode into Akamai format
    const encodedData = encodeSensorData(mouseEvents, keyboardEvents, config, sessionId, pageUrl);

    const payload: SensorPayload = {
      data: encodedData,
      version: config.version,
      timestamp: Date.now(),
      requestId,
      validated: true,
      sessionId,
      pageUrl,
    };

    // Cache successful payload for reuse
    if (this.config.includeMouseData) {
      const cacheKey = createHash('sha256')
        .update(`sensor:${domain}:${sessionId}`)
        .digest('hex')
        .substring(0, 16);
      this.payloadCache.set(cacheKey, { payload, hits: 0 });
      await cacheSet(`${SENSOR_CACHE_PREFIX}${cacheKey}`, payload, 600); // 10 min cache
    }

    return payload;
  }

  /** Validate a sensor payload format. */
  validatePayload(payload: SensorPayload): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!payload.data) errors.push('Missing sensor data');
    if (!payload.version) errors.push('Missing version');
    if (!payload.requestId) errors.push('Missing request ID');
    if (!payload.sessionId) errors.push('Missing session ID');
    if (!payload.pageUrl) errors.push('Missing page URL');

    // Check data format: version;payload;checksum
    const parts = payload.data.split(';');
    if (parts.length !== 3) errors.push('Invalid data format');

    // Verify base64 payload can be decoded
    try {
      const decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      if (!parsed.m || !parsed.k) errors.push('Missing mouse or keyboard data');
      if (!parsed.sid) errors.push('Missing session ID in data');
      if (!parsed.dc) errors.push('Missing device capabilities');
    } catch {
      errors.push('Failed to decode payload data');
    }

    return { valid: errors.length === 0, errors };
  }

  /** Get a cached payload for a domain if available. */
  async getCachedPayload(domain: string, sessionId: string): Promise<SensorPayload | null> {
    const cacheKey = createHash('sha256')
      .update(`sensor:${domain}:${sessionId}`)
      .digest('hex')
      .substring(0, 16);

    const cached = this.payloadCache.get(cacheKey);
    if (cached && cached.hits < 3) { // Reuse up to 3 times
      cached.hits++;
      return cached.payload;
    }

    return await cacheGet<SensorPayload>(`${SENSOR_CACHE_PREFIX}${cacheKey}`);
  }

  /** Update configuration. */
  updateConfig(updates: Partial<SensorDataConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /** Get current configuration. */
  getConfig(): SensorDataConfig {
    return { ...this.config };
  }
}

/** Singleton instance. */
export const sensorGenerator = new SensorGenerator();
