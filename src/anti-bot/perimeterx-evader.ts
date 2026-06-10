/**
 * PerimeterX (HUMAN) Behavioral Heuristics Bypass -- ScrapeSuite Engine
 *
 * Dedicated module for defeating PerimeterX/HUMAN's behavioral anti-bot
 * protection system. PX relies heavily on behavioral fingerprinting --
 * mouse movements, keyboard patterns, scroll behavior, touch events,
 * focus/visibility changes, and device orientation -- rather than purely
 * cryptographic challenges like Kasada.
 *
 * Bypass Strategy:
 *  1. DETECT -- Identify PX challenge pages, scripts, cookies, and headers
 *  2. INJECT BEHAVIORAL DATA -- Synthesize realistic human behavioral data
 *     (mouse/keyboard/scroll/touch/focus/visibility) and inject it into
 *     the page BEFORE the PX sensor script loads
 *  3. INTERCEPT PX SCRIPT -- Modify outgoing behavioral payloads to appear
 *     human-like, sanitizing bot signals before they reach the collector
 *  4. SOLVE CAPTCHA -- If PX escalates to a CAPTCHA (own or hCaptcha),
 *     detect and attempt resolution
 *  5. EXTRACT _px3 -- Capture the _px3 cookie after successful resolution
 *  6. CACHE -- Store _px3 cookie in Redis (30min–1h lifetime)
 *  7. REPLAY -- Inject cached cookies on repeat visits
 *
 * Estimated improvement: +15-20% against PerimeterX (45-55% → 65-75%)
 */

import type { Page, BrowserContext, CDPSession, Response } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import {
  AntiBotBase,
} from './base';
import {
  type AntiBotPlatform,
  type BypassStrategy,
  type AntiBotResult,
  type BypassContext,
  type PlatformDetectionResult,
  type DetectionIndicator,
  type ManagedCookie,
  STRATEGY_ESCALATION,
  PLATFORM_NAMES,
} from './types';

const logger = createChildLogger('perimeterx-evader');

// ===============================================================================
// PERIMETERX DETECTION CONSTANTS
// ===============================================================================

/** PX cookie names to look for. */
const PX_COOKIE_NAMES = [
  '_px3',
  '_px2',
  '_pxff_cc',
  '_pxCaptcha',
  '_pxde',
  '_pxvid',
  '_px2_steps',
];

/** PX-specific HTTP headers. */
const PX_HEADERS = [
  'x-px-authorization',
  'x-px-cookie-px3',
];

/** PX script URL patterns. */
const PX_SCRIPT_PATTERNS = [
  'px-cdn.net',
  'collector.px-cdn.net',
  '/px.js',
  'px-client.js',
  'sensor.px-cdn.net',
];

/** PX DOM selectors for challenge elements. */
const PX_CHALLENGE_SELECTORS = [
  '#px-captcha',
  'iframe[src*="px-captcha"]',
  '#px-challenge',
  '#px-challenge-container',
  '.px-captcha',
  'div[id^="px"]',
  'iframe[src*="captcha"]',
];

/** PX challenge page text indicators. */
const PX_CHALLENGE_TEXTS = [
  'are you a human',
  'verify you are human',
  'please verify',
  'human verification',
  'perimeterx',
  'px-captcha',
  'challenge platform',
  'checking your browser',
  'please wait while we verify',
  'we just need to make sure',
  'not a robot',
];

/** PX script variable / property names that indicate PX is loaded. */
const PX_JS_INDICATORS = [
  'window._pxAppId',
  'window._pxParam1',
  'window._px Vid',
  'window.PX',
  'window._pxObject',
  'window._pxm',
];

/** _px3 cookie typical lifetime in ms (30min – 1h). */
const PX3_COOKIE_LIFETIME_MS = 45 * 60 * 1000;

/** Maximum time to wait for PX challenge resolution. */
const PX_CHALLENGE_TIMEOUT_MS = 25000;

/** Maximum time to wait for CAPTCHA solution. */
const PX_CAPTCHA_TIMEOUT_MS = 60000;

// ===============================================================================
// BEHAVIORAL DATA TYPES
// ===============================================================================

interface Point {
  x: number;
  y: number;
  timestamp: number;
}

interface MouseMovementData {
  points: Point[];
  velocities: number[];
  accelerations: number[];
  jerks: number[];
  curvatures: number[];
  clickDwellTimes: number[];
  clickDistances: number[];
  clickPrecisions: number[];
}

interface KeyboardTimingData {
  keyDownTimes: number[];
  keyUpTimes: number[];
  flightTimes: number[];      // time between key-up and next key-down
  holdTimes: number[];        // time between key-down and key-up for same key
}

interface ScrollPatternData {
  deltas: number[];
  timestamps: number[];
  speeds: number[];
  directions: number[];       // 1 = down, -1 = up
  pausePositions: number[];   // scroll offsets where pauses occurred
}

interface TouchPatternData {
  pressures: number[];
  durations: number[];
  radii: number[];
  touchPoints: Point[];
}

interface FocusVisibilityData {
  focusTimestamps: number[];
  blurTimestamps: number[];
  visibilityChanges: Array<{ from: string; to: string; timestamp: number }>;
  visibleRatio: number;       // ~0.95 for realistic human behavior
}

interface OrientationData {
  alpha: number;
  beta: number;
  gamma: number;
  timestamp: number;
}

interface FullBehavioralPayload {
  mouse: MouseMovementData;
  keyboard: KeyboardTimingData;
  scroll: ScrollPatternData;
  touch: TouchPatternData;
  focusVisibility: FocusVisibilityData;
  orientation: OrientationData[];
  resizeEvents: Array<{ width: number; height: number; timestamp: number }>;
  selectionEvents: Array<{ startNode: string; endNode: string; text: string; timestamp: number }>;
}

// ===============================================================================
// MATH HELPERS
// ===============================================================================

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randomInt(min: number, max: number): number {
  return Math.floor(randomBetween(min, max + 1));
}

function randomGaussian(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1 || 0.0001)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stdDev;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ===============================================================================
// BEZIER CURVE GENERATOR
// ===============================================================================

/**
 * Evaluate a cubic Bezier curve at parameter t.
 */
function cubicBezier(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y,
  };
}

/**
 * Generate random control points for a Bezier curve between start and end.
 * The curvature parameter controls how much the curve deviates from a
 * straight line (0 = straight, 1 = very curved).
 */
function generateBezierControlPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  curvature: number = 0.35,
): { cp1: { x: number; y: number }; cp2: { x: number; y: number } } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy) || 1;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;

  // Normal vector perpendicular to the line from start to end
  const nx = -dy / distance;
  const ny = dx / distance;

  const offset1 = (Math.random() - 0.5) * distance * curvature;
  const offset2 = (Math.random() - 0.5) * distance * curvature;

  return {
    cp1: {
      x: midX - dx * 0.25 + nx * offset1,
      y: midY - dy * 0.25 + ny * offset1,
    },
    cp2: {
      x: midX + dx * 0.25 + nx * offset2,
      y: midY + dy * 0.25 + ny * offset2,
    },
  };
}

/**
 * Ease-in-out cubic -- models realistic acceleration then deceleration.
 */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Generate a complete mouse movement path using cubic Bezier curves
 * with realistic velocity profiles (Fitts's Law timing).
 */
function generateMousePath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps: number = 25,
  curvature: number = 0.35,
): Point[] {
  const start: { x: number; y: number } = { x: startX, y: startY };
  const end: { x: number; y: number } = { x: endX, y: endY };
  const { cp1, cp2 } = generateBezierControlPoints(start, end, curvature);

  const distance = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
  // Fitts's Law: movement time scales with index of difficulty
  const totalDuration = 50 + 100 * Math.log2(Math.max(2 * distance / 50, 1));
  const now = Date.now();

  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const rawT = i / steps;
    const easedT = easeInOutCubic(rawT);
    const pt = cubicBezier(start, cp1, cp2, end, easedT);

    // Add jitter -- realistic hand tremor (2-5px Gaussian)
    if (i > 0 && i < steps) {
      pt.x += randomGaussian(0, 2.5);
      pt.y += randomGaussian(0, 2.5);
    }

    const timestamp = now + Math.round(rawT * totalDuration);
    points.push({ x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10, timestamp });
  }

  return points;
}

// ===============================================================================
// BEHAVIORAL DATA SYNTHESIS ENGINE
// ===============================================================================

/**
 * Synthesize realistic mouse movement data including velocity, acceleration,
 * jerk, and curvature -- the key metrics PX uses for behavioral classification.
 */
function synthesizeMouseBehavior(viewportWidth: number, viewportHeight: number): MouseMovementData {
  const points: Point[] = [];
  const numMovements = randomInt(8, 20);
  const now = Date.now();
  let currentX = randomBetween(viewportWidth * 0.1, viewportWidth * 0.9);
  let currentY = randomBetween(viewportHeight * 0.1, viewportHeight * 0.9);
  let currentTime = now;

  // Generate multiple mouse path segments
  for (let m = 0; m < numMovements; m++) {
    const targetX = randomBetween(viewportWidth * 0.05, viewportWidth * 0.95);
    const targetY = randomBetween(viewportHeight * 0.05, viewportHeight * 0.95);
    const steps = randomInt(12, 35);
    const path = generateMousePath(currentX, currentY, targetX, targetY, steps);

    // Offset timestamps to be sequential
    for (const pt of path) {
      pt.timestamp = currentTime + (pt.timestamp - path[0].timestamp);
      points.push(pt);
    }

    currentX = targetX;
    currentY = targetY;
    currentTime = points[points.length - 1].timestamp;

    // Add a pause between movements (150-800ms)
    currentTime += randomInt(150, 800);
  }

  // Compute derivatives: velocity, acceleration, jerk, curvature
  const velocities: number[] = [];
  const accelerations: number[] = [];
  const jerks: number[] = [];
  const curvatures: number[] = [];

  for (let i = 1; i < points.length; i++) {
    const dt = Math.max(points[i].timestamp - points[i - 1].timestamp, 1);
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const v = dist / dt; // px/ms
    velocities.push(v);

    if (velocities.length >= 2) {
      const dv = velocities[velocities.length - 1] - velocities[velocities.length - 2];
      const a = dv / dt;
      accelerations.push(a);

      if (accelerations.length >= 2) {
        const da = accelerations[accelerations.length - 1] - accelerations[accelerations.length - 2];
        const j = da / dt;
        jerks.push(j);
      }
    }

    // Curvature: based on angle change between consecutive segments
    if (i >= 2) {
      const v1x = points[i - 1].x - points[i - 2].x;
      const v1y = points[i - 1].y - points[i - 2].y;
      const v2x = points[i].x - points[i - 1].x;
      const v2y = points[i].y - points[i - 1].y;
      const dot = v1x * v2x + v1y * v2y;
      const mag1 = Math.sqrt(v1x * v1x + v1y * v1y) || 1;
      const mag2 = Math.sqrt(v2x * v2x + v2y * v2y) || 1;
      const cosAngle = clamp(dot / (mag1 * mag2), -1, 1);
      curvatures.push(Math.acos(cosAngle));
    }
  }

  // Click patterns
  const clickDwellTimes: number[] = [];
  const clickDistances: number[] = [];
  const clickPrecisions: number[] = [];
  const numClicks = randomInt(3, 10);
  let lastClickX = 0;
  let lastClickY = 0;

  for (let c = 0; c < numClicks; c++) {
    // Dwell time: 80-600ms (time mouse is stationary before clicking)
    clickDwellTimes.push(randomGaussian(250, 100));
    // Distance between consecutive clicks
    const clickX = randomBetween(0, viewportWidth);
    const clickY = randomBetween(0, viewportHeight);
    if (c > 0) {
      clickDistances.push(
        Math.sqrt((clickX - lastClickX) ** 2 + (clickY - lastClickY) ** 2),
      );
    }
    // Click precision: offset from target center (0 = perfect, higher = less precise)
    clickPrecisions.push(Math.abs(randomGaussian(0, 3)));
    lastClickX = clickX;
    lastClickY = clickY;
  }

  return {
    points,
    velocities,
    accelerations,
    jerks,
    curvatures,
    clickDwellTimes,
    clickDistances,
    clickPrecisions,
  };
}

/**
 * Generate human-like keyboard timing data.
 * Key timing follows normal distribution: 40-200ms between keys.
 * Flight time (between key-up and next key-down): 30-180ms.
 * Hold time (key-down to key-up): 40-120ms.
 */
function synthesizeKeyboardBehavior(numKeys: number = 50): KeyboardTimingData {
  const keyDownTimes: number[] = [];
  const keyUpTimes: number[] = [];
  const flightTimes: number[] = [];
  const holdTimes: number[] = [];

  const now = Date.now();
  let currentTime = now;

  for (let i = 0; i < numKeys; i++) {
    const holdTime = clamp(randomGaussian(75, 25), 40, 120);
    const flightTime = i > 0 ? clamp(randomGaussian(90, 40), 30, 180) : 0;

    const downTime = currentTime + (i > 0 ? flightTime : 0);
    const upTime = downTime + holdTime;

    keyDownTimes.push(downTime);
    keyUpTimes.push(upTime);
    holdTimes.push(holdTime);
    if (i > 0) flightTimes.push(flightTime);

    currentTime = upTime;
  }

  return { keyDownTimes, keyUpTimes, flightTimes, holdTimes };
}

/**
 * Generate natural scroll pattern data with pauses and direction changes.
 */
function synthesizeScrollBehavior(totalScrollDistance: number = 3000): ScrollPatternData {
  const deltas: number[] = [];
  const timestamps: number[] = [];
  const speeds: number[] = [];
  const directions: number[] = [];
  const pausePositions: number[] = [];

  const now = Date.now();
  let currentTime = now;
  let scrollOffset = 0;

  while (scrollOffset < totalScrollDistance) {
    // Natural scroll segment: 50-300px
    const segDistance = randomBetween(50, 250);
    const duration = randomBetween(150, 600);
    const speed = segDistance / duration;

    // Occasionally scroll up (10% chance)
    const direction = Math.random() < 0.1 ? -1 : 1;
    const delta = direction * segDistance;

    deltas.push(delta);
    timestamps.push(currentTime);
    speeds.push(speed);
    directions.push(direction);

    scrollOffset += segDistance;
    currentTime += duration;

    // Pause after scrolling (60% chance)
    if (Math.random() < 0.6) {
      const pauseDuration = randomGaussian(1500, 800);
      pausePositions.push(scrollOffset);
      currentTime += clamp(pauseDuration, 300, 5000);
    }
  }

  return { deltas, timestamps, speeds, directions, pausePositions };
}

/**
 * Generate realistic touch pattern data (for mobile device profiles).
 * Pressure: 0.3-0.9, radius variations, realistic durations.
 */
function synthesizeTouchBehavior(numTouches: number = 15): TouchPatternData {
  const pressures: number[] = [];
  const durations: number[] = [];
  const radii: number[] = [];
  const touchPoints: Point[] = [];

  const now = Date.now();
  let currentTime = now;

  for (let i = 0; i < numTouches; i++) {
    // Pressure follows a beta-like distribution centered around 0.5-0.7
    pressures.push(clamp(randomGaussian(0.55, 0.15), 0.3, 0.9));

    // Touch duration: 50-400ms for taps, up to 800ms for long-press
    durations.push(clamp(randomGaussian(150, 80), 50, 800));

    // Touch radius: 2-12px (finger size variation)
    radii.push(clamp(randomGaussian(5, 2), 2, 12));

    touchPoints.push({
      x: randomBetween(50, 400),
      y: randomBetween(50, 800),
      timestamp: currentTime,
    });

    currentTime += durations[i] + randomInt(200, 1500);
  }

  return { pressures, durations, radii, touchPoints };
}

/**
 * Generate focus/blur and visibility change data.
 * Periodic tab switching every 30-120 seconds.
 * Document visible ~95% of the time.
 */
function synthesizeFocusVisibilityBehavior(
  sessionDurationMs: number = 120000,
): FocusVisibilityData {
  const focusTimestamps: number[] = [];
  const blurTimestamps: number[] = [];
  const visibilityChanges: Array<{ from: string; to: string; timestamp: number }> = [];
  const visibleRatio = 0.95;

  const now = Date.now();
  let currentTime = now;

  // Start with focus
  focusTimestamps.push(currentTime);
  visibilityChanges.push({ from: 'hidden', to: 'visible', timestamp: currentTime });

  while (currentTime < now + sessionDurationMs) {
    // Time until next blur: 30-120 seconds
    const timeUntilBlur = randomBetween(30000, 120000);
    const blurTime = currentTime + timeUntilBlur;

    if (blurTime > now + sessionDurationMs) break;

    blurTimestamps.push(blurTime);
    visibilityChanges.push({ from: 'visible', to: 'hidden', timestamp: blurTime });

    // Time until refocus: 1-10 seconds (brief switch)
    const timeUntilRefocus = randomBetween(1000, 10000);
    const focusTime = blurTime + timeUntilRefocus;

    if (focusTime > now + sessionDurationMs) break;

    focusTimestamps.push(focusTime);
    visibilityChanges.push({ from: 'hidden', to: 'visible', timestamp: focusTime });

    currentTime = focusTime;
  }

  return { focusTimestamps, blurTimestamps, visibilityChanges, visibleRatio };
}

/**
 * Generate device orientation data (for mobile).
 */
function synthesizeOrientationData(numSamples: number = 20): OrientationData[] {
  const data: OrientationData[] = [];
  const now = Date.now();
  let currentAlpha = randomBetween(0, 360);
  let currentBeta = randomGaussian(30, 10);
  let currentGamma = randomGaussian(0, 8);

  for (let i = 0; i < numSamples; i++) {
    // Small incremental changes -- phones don't rotate wildly
    currentAlpha += randomGaussian(0, 5);
    currentBeta = clamp(currentBeta + randomGaussian(0, 3), -180, 180);
    currentGamma = clamp(currentGamma + randomGaussian(0, 2), -90, 90);

    data.push({
      alpha: currentAlpha,
      beta: currentBeta,
      gamma: currentGamma,
      timestamp: now + i * randomInt(2000, 8000),
    });
  }

  return data;
}

/**
 * Build the complete behavioral payload for injection.
 */
function synthesizeFullBehavioralPayload(
  viewportWidth: number,
  viewportHeight: number,
): FullBehavioralPayload {
  return {
    mouse: synthesizeMouseBehavior(viewportWidth, viewportHeight),
    keyboard: synthesizeKeyboardBehavior(randomInt(30, 80)),
    scroll: synthesizeScrollBehavior(randomInt(1500, 5000)),
    touch: synthesizeTouchBehavior(randomInt(5, 20)),
    focusVisibility: synthesizeFocusVisibilityBehavior(randomInt(60000, 180000)),
    orientation: synthesizeOrientationData(randomInt(10, 30)),
    resizeEvents: generateResizeEvents(),
    selectionEvents: generateSelectionEvents(),
  };
}

/**
 * Generate window resize events -- humans occasionally resize, but rarely.
 */
function generateResizeEvents(): Array<{ width: number; height: number; timestamp: number }> {
  const events: Array<{ width: number; height: number; timestamp: number }> = [];
  const now = Date.now();

  // 0-2 resize events per session
  const count = Math.random() < 0.3 ? randomInt(0, 2) : 0;
  for (let i = 0; i < count; i++) {
    events.push({
      width: randomInt(800, 1920),
      height: randomInt(600, 1080),
      timestamp: now + randomInt(5000, 60000),
    });
  }

  return events;
}

/**
 * Generate text selection events -- humans sometimes select text while reading.
 */
function generateSelectionEvents(): Array<{ startNode: string; endNode: string; text: string; timestamp: number }> {
  const events: Array<{ startNode: string; endNode: string; text: string; timestamp: number }> = [];
  const now = Date.now();

  // 0-3 selection events per session
  const count = Math.random() < 0.4 ? randomInt(0, 3) : 0;
  const sampleTexts = [
    'important content',
    'read more',
    'details here',
    'click to continue',
    'learn more about this',
  ];

  for (let i = 0; i < count; i++) {
    events.push({
      startNode: `p:nth-child(${randomInt(1, 5)})`,
      endNode: `p:nth-child(${randomInt(1, 5)})`,
      text: sampleTexts[randomInt(0, sampleTexts.length - 1)],
      timestamp: now + randomInt(10000, 120000),
    });
  }

  return events;
}

// ===============================================================================
// PX SCRIPT INTERCEPTION INJECTOR
// ===============================================================================

/**
 * JavaScript to inject BEFORE PX scripts load. This script:
 *
 * 1. Intercepts the PX sensor data collection and modifies behavioral
 *    payloads to appear human-like
 * 2. Overrides navigator properties that PX checks for headless detection
 * 3. Hooks event listeners to sanitize bot-like patterns
 * 4. Injects synthesized behavioral history into the PX data pipeline
 */
const PX_PRE_SCRIPT = `
(function() {
  'use strict';

  // --- Anti-headless detection --------------------------------------------
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

  // Override plugins and mimeTypes for realistic browser profile
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        arr.item = (i) => arr[i];
        arr.namedItem = (name) => arr.find(p => p.name === name);
        arr.refresh = () => {};
        return arr;
      },
      configurable: true,
    });
  }

  // --- Behavioral data injection ------------------------------------------
  // PX collects data via event listeners. We pre-populate realistic
  // behavioral history by dispatching synthesized events before PX loads.

  const __pxViewport = { w: window.innerWidth || 1280, h: window.innerHeight || 800 };

  // Inject mouse movement history via synthetic mousemove events
  function injectMouseHistory() {
    const numPoints = Math.floor(Math.random() * 15) + 8;
    let x = Math.random() * __pxViewport.w;
    let y = Math.random() * __pxViewport.h;
    const now = Date.now();

    for (let i = 0; i < numPoints; i++) {
      const targetX = Math.random() * __pxViewport.w;
      const targetY = Math.random() * __pxViewport.h;
      const steps = Math.floor(Math.random() * 15) + 8;

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        // Ease-in-out cubic
        const eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
        const px = x + (targetX - x) * eased;
        const py = y + (targetY - y) * eased;

        const evt = new MouseEvent('mousemove', {
          clientX: px + (Math.random() - 0.5) * 4,
          clientY: py + (Math.random() - 0.5) * 4,
          movementX: (targetX - x) / steps,
          movementY: (targetY - y) / steps,
          bubbles: true,
          cancelable: true,
        });
        // Use a past timestamp so PX thinks these events already happened
        Object.defineProperty(evt, 'timeStamp', { value: now - (numPoints - i) * 2000 + s * 50 });
        document.dispatchEvent(evt);
      }

      x = targetX;
      y = targetY;
    }
  }

  // Inject scroll history
  function injectScrollHistory() {
    const now = Date.now();
    const numScrolls = Math.floor(Math.random() * 6) + 3;
    let offset = 0;

    for (let i = 0; i < numScrolls; i++) {
      const delta = Math.floor(Math.random() * 200) + 50;
      offset += delta;
      const evt = new WheelEvent('wheel', {
        deltaY: delta,
        deltaMode: 0,
        clientX: Math.random() * __pxViewport.w,
        clientY: Math.random() * __pxViewport.h,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(evt, 'timeStamp', { value: now - (numScrolls - i) * 3000 });
      document.dispatchEvent(evt);
    }
  }

  // Inject keyboard events with realistic timing
  function injectKeyboardHistory() {
    const now = Date.now();
    const numKeys = Math.floor(Math.random() * 20) + 10;
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';

    for (let i = 0; i < numKeys; i++) {
      const char = chars[Math.floor(Math.random() * chars.length)];

      const downEvt = new KeyboardEvent('keydown', {
        key: char,
        code: 'Key' + char.toUpperCase(),
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(downEvt, 'timeStamp', { value: now - (numKeys - i) * 150 });

      const upEvt = new KeyboardEvent('keyup', {
        key: char,
        code: 'Key' + char.toUpperCase(),
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(upEvt, 'timeStamp', { value: now - (numKeys - i) * 150 + 75 });

      document.dispatchEvent(downEvt);
      document.dispatchEvent(upEvt);
    }
  }

  // Inject focus/blur events
  function injectFocusHistory() {
    const now = Date.now();
    // Document is visible ~95% of the time
    // Occasional tab-away every 30-120 seconds
    const numBlurs = Math.floor(Math.random() * 3) + 1;

    for (let i = 0; i < numBlurs; i++) {
      const blurTime = now - (numBlurs - i) * 60000;
      const focusTime = blurTime + Math.floor(Math.random() * 5000) + 1000;

      const blurEvt = new Event('blur');
      Object.defineProperty(blurEvt, 'timeStamp', { value: blurTime });
      window.dispatchEvent(blurEvt);

      const visHiddenEvt = new Event('visibilitychange');
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(visHiddenEvt);

      setTimeout(() => {
        const focusEvt = new Event('focus');
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        window.dispatchEvent(focusEvt);

        const visVisibleEvt = new Event('visibilitychange');
        document.dispatchEvent(visVisibleEvt);
      }, focusTime - blurTime);
    }
  }

  // --- PX network interception --------------------------------------------
  // Intercept XHR/fetch to the PX collector and sanitize behavioral data

  const PX_COLLECTOR_URLS = ['collector.px-cdn.net', 'sensor.px-cdn.net'];

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._pxUrl = url;
    this._pxIsCollector = PX_COLLECTOR_URLS.some(c => typeof url === 'string' && url.includes(c));
    return origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this._pxIsCollector && body && typeof body === 'string') {
      try {
        // Modify the sensor payload to remove bot indicators
        let payload = body;

        // Remove webdriver traces
        payload = payload.replace(/webdriver[^"']*/gi, 'false');
        // Remove headless indicators
        payload = payload.replace(/headless/gi, '');

        return origXHRSend.apply(this, [payload]);
      } catch (e) {
        // If we can't modify, send original
      }
    }
    return origXHRSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
    const isCollector = PX_COLLECTOR_URLS.some(c => url.includes(c));

    if (isCollector && init && init.body && typeof init.body === 'string') {
      try {
        let payload = init.body;
        payload = payload.replace(/webdriver[^"']*/gi, 'false');
        payload = payload.replace(/headless/gi, '');
        init = { ...init, body: payload };
      } catch (e) {}
    }

    return origFetch.apply(this, [input, init]);
  };

  // --- Inject behavioral history on DOMContentLoaded ----------------------
  function injectAll() {
    try { injectMouseHistory(); } catch(e) {}
    try { injectScrollHistory(); } catch(e) {}
    try { injectKeyboardHistory(); } catch(e) {}
    try { injectFocusHistory(); } catch(e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAll);
  } else {
    injectAll();
  }

  // Mark that we have injected PX pre-script
  window.__pxPreScriptInjected = true;
})();
`;

/**
 * JavaScript to inject AFTER the PX script has loaded. This monitors
 * for cookie changes and extracts the _px3 cookie when it appears.
 */
const PX_POST_SCRIPT = `
(function() {
  'use strict';

  // Monitor for _px3 cookie being set
  const __pxCookieMonitor = setInterval(function() {
    const cookies = document.cookie;
    const px3Match = cookies.match(/_px3=([^;]+)/);
    const pxCaptchaMatch = cookies.match(/_pxCaptcha=([^;]+)/);

    if (px3Match) {
      document.documentElement.setAttribute('data-px3-cookie', px3Match[1]);
      document.documentElement.setAttribute('data-px3-found', 'true');
    }

    if (pxCaptchaMatch) {
      document.documentElement.setAttribute('data-px-captcha-cookie', pxCaptchaMatch[1]);
    }

    // Also extract all PX cookies
    const allPxCookies = {};
    const pxCookieNames = ['_px3', '_px2', '_pxff_cc', '_pxCaptcha', '_pxde', '_pxvid'];
    for (const name of pxCookieNames) {
      const match = cookies.match(new RegExp(name + '=([^;]+)'));
      if (match) allPxCookies[name] = match[1];
    }

    if (Object.keys(allPxCookies).length > 0) {
      document.documentElement.setAttribute('data-px-cookies', JSON.stringify(allPxCookies));
    }
  }, 500);

  // Stop monitoring after 60 seconds
  setTimeout(function() {
    clearInterval(__pxCookieMonitor);
  }, 60000);

  // Monitor for PX CAPTCHA iframe
  const __pxCaptchaObserver = new MutationObserver(function(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          const element = node;
          if (element.id && element.id.includes('px')) {
            document.documentElement.setAttribute('data-px-element', element.id);
          }
          // Check for PX captcha iframes
          if (element.tagName === 'IFRAME') {
            const src = element.src || '';
            if (src.includes('px-captcha') || src.includes('captcha')) {
              document.documentElement.setAttribute('data-px-captcha-iframe', src);
            }
          }
          // Recursively check children
          const iframes = element.querySelectorAll ? element.querySelectorAll('iframe[src*="captcha"], iframe[src*="px-captcha"]') : [];
          for (const iframe of iframes) {
            document.documentElement.setAttribute('data-px-captcha-iframe', iframe.src || '');
          }
        }
      }
    }
  });

  __pxCaptchaObserver.observe(document.documentElement, { childList: true, subtree: true });

  window.__pxPostScriptInjected = true;
})();
`;

// ===============================================================================
// PERIMETERX EVADER CLASS
// ===============================================================================

class PerimeterXEvader extends AntiBotBase {
  readonly platform: AntiBotPlatform = 'perimeterx';

  // Track active challenge sessions
  private activeChallenges = new Map<string, { startTime: number; strategy: BypassStrategy }>();
  // Behavioral data cache per domain
  private behavioralCache = new Map<string, FullBehavioralPayload>();

  constructor(configOverride?: Partial<import('./types').AntiBotPlatformConfig>) {
    super(configOverride);
  }

  protected platformOverride(): AntiBotPlatform {
    return 'perimeterx';
  }

  // --- Detection ---------------------------------------------------------

  /**
   * Detect if PerimeterX/HUMAN protection is active on the page.
   * Checks cookies, headers, DOM elements, scripts, and JS globals.
   */
  async detect(ctx: BypassContext): Promise<PlatformDetectionResult> {
    const indicators: DetectionIndicator[] = [];
    let confidence = 0;
    let challengeType = 'none';
    let isRechallenge = false;

    try {
      // 1. Check PX cookies
      const cookies = await ctx.context.cookies();
      for (const cookie of cookies) {
        if (PX_COOKIE_NAMES.includes(cookie.name)) {
          indicators.push({
            category: 'cookie',
            description: `PerimeterX cookie detected: ${cookie.name}`,
            weight: cookie.name === '_px3' ? 0.35 : 0.2,
            rawValue: `${cookie.name}=${cookie.value.substring(0, 20)}...`,
          });
          confidence += cookie.name === '_px3' ? 0.35 : 0.2;

          // If _pxCaptcha is present, this might be a re-challenge
          if (cookie.name === '_pxCaptcha') {
            isRechallenge = true;
          }
        }
      }

      // 2. Check DOM selectors
      for (const selector of PX_CHALLENGE_SELECTORS) {
        try {
          const element = await ctx.page.$(selector);
          if (element) {
            indicators.push({
              category: 'dom',
              description: `PerimeterX challenge element found: ${selector}`,
              weight: 0.3,
              rawValue: selector,
            });
            confidence += 0.3;
            challengeType = 'interactive-challenge';
          }
        } catch { /* selector evaluation failed */ }
      }

      // 3. Check page content for PX challenge text
      try {
        const bodyText = await ctx.page.evaluate(() => document.body?.innerText?.toLowerCase() || '');
        for (const text of PX_CHALLENGE_TEXTS) {
          if (bodyText.includes(text.toLowerCase())) {
            indicators.push({
              category: 'dom',
              description: `PerimeterX challenge text found: "${text}"`,
              weight: 0.15,
              rawValue: text,
            });
            confidence += 0.15;
            if (challengeType === 'none') challengeType = 'challenge-page';
          }
        }
      } catch { /* page evaluate failed */ }

      // 4. Check for PX scripts
      try {
        const scriptSrcs = await ctx.page.evaluate(() =>
          Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src') || '')
        );
        for (const src of scriptSrcs) {
          if (PX_SCRIPT_PATTERNS.some(pattern => src.includes(pattern))) {
            indicators.push({
              category: 'script',
              description: `PerimeterX script detected: ${src.substring(0, 80)}`,
              weight: 0.3,
              rawValue: src,
            });
            confidence += 0.3;
            break; // Only count once
          }
        }
      } catch { /* script evaluation failed */ }

      // 5. Check for PX JS globals
      try {
        const hasPxGlobals = await ctx.page.evaluate((indicators) => {
          for (const indicator of indicators) {
            try {
              // eslint-disable-next-line no-eval
              if (eval(indicator)) return true;
            } catch { /* global doesn't exist */ }
          }
          return false;
        }, PX_JS_INDICATORS);

        if (hasPxGlobals) {
          indicators.push({
            category: 'script',
            description: 'PerimeterX JavaScript globals detected',
            weight: 0.25,
          });
          confidence += 0.25;
        }
      } catch { /* JS evaluation failed */ }

      // 6. Check HTTP response headers (if available via previous response)
      try {
        const pageUrl = ctx.page.url();
        // Check if the page itself set any PX headers
        const pxHeaderFound = await ctx.page.evaluate((headers) => {
          // Can't directly access response headers from page context,
          // but we can check for meta tags or other indicators
          const metas = document.querySelectorAll('meta[http-equiv]');
          for (const meta of metas) {
            const name = meta.getAttribute('http-equiv')?.toLowerCase() || '';
            if (headers.some(h => name.includes(h.toLowerCase().replace('x-px-', '')))) {
              return true;
            }
          }
          return false;
        }, PX_HEADERS);

        if (pxHeaderFound) {
          indicators.push({
            category: 'header',
            description: 'PerimeterX HTTP header detected',
            weight: 0.25,
          });
          confidence += 0.25;
        }
      } catch { /* header check failed */ }

      // Clamp confidence
      confidence = clamp(confidence, 0, 1);

      // Determine severity
      let severity: import('./types').DetectionSeverity = 'none';
      if (confidence > 0.7) severity = 'high';
      else if (confidence > 0.5) severity = 'medium';
      else if (confidence > 0.3) severity = 'low';

      // Determine recommended strategy
      const strategies = STRATEGY_ESCALATION.perimeterx;
      let recommendedStrategy: BypassStrategy = strategies[0];

      // If we have valid cached cookies, prefer cookie injection
      if (this.hasValidTokens(ctx.domain)) {
        recommendedStrategy = 'cookie-injection';
      } else if (challengeType === 'interactive-challenge') {
        recommendedStrategy = 'challenge-solver';
      }

      // Check if this is a re-challenge
      if (ctx.previousResult || ctx.isRechallenge) {
        isRechallenge = true;
      }

      logger.info(
        {
          domain: ctx.domain,
          confidence: confidence.toFixed(2),
          severity,
          challengeType,
          indicators: indicators.length,
          isRechallenge,
          recommendedStrategy,
        },
        'PerimeterX detection complete',
      );

      return {
        platform: 'perimeterx',
        confidence,
        severity,
        indicators,
        challengeType,
        isRechallenge,
        recommendedStrategy,
      };
    } catch (err: any) {
      logger.error({ err: err.message, domain: ctx.domain }, 'PerimeterX detection failed');
      return {
        platform: 'perimeterx',
        confidence: 0,
        severity: 'none',
        indicators: [],
        challengeType: 'none',
        isRechallenge: false,
        recommendedStrategy: 'behavioral-mimic',
      };
    }
  }

  // --- Bypass ------------------------------------------------------------

  /**
   * Attempt to bypass PerimeterX anti-bot challenge.
   *
   * Strategy flow:
   *  1. Check for cached cookies → cookie-injection
   *  2. Inject behavioral pre-script + post-script
   *  3. Perform human-like interactions on the page
   *  4. Wait for challenge resolution / _px3 cookie
   *  5. If CAPTCHA detected, attempt resolution
   *  6. Extract and cache cookies
   */
  async bypass(ctx: BypassContext, strategy?: BypassStrategy): Promise<AntiBotResult> {
    const startTime = Date.now();
    this.stats.totalAttempts++;
    const domain = ctx.domain;
    const activeStrategy = strategy || STRATEGY_ESCALATION.perimeterx[0];

    // Check cooldown
    if (this.isInCooldown(domain)) {
      return this.buildFailureResult({
        strategy: activeStrategy,
        durationMs: Date.now() - startTime,
        phase: 'cooldown',
        errors: [`Domain ${domain} is in cooldown period`],
      });
    }

    logger.info(
      { domain, strategy: activeStrategy, isRechallenge: ctx.isRechallenge },
      'Starting PerimeterX bypass',
    );

    // --- Strategy: Cookie Injection (cached tokens) ---------------------
    if (activeStrategy === 'cookie-injection' || activeStrategy === 'replay-tokens') {
      const cookieResult = await this.tryCookieInjection(ctx);
      if (cookieResult) {
        this.recordResult(domain, true, Date.now() - startTime, activeStrategy);
        return cookieResult;
      }
      // Fall through to behavioral mimic if cookie injection fails
    }

    // --- Strategy: Behavioral Mimic (primary PX strategy) ---------------
    if (activeStrategy === 'behavioral-mimic') {
      const result = await this.executeBehavioralMimicBypass(ctx);
      this.recordResult(domain, result.success, Date.now() - startTime, activeStrategy);
      return result;
    }

    // --- Strategy: Browser Execute --------------------------------------
    if (activeStrategy === 'browser-execute') {
      const result = await this.executeBrowserBypass(ctx);
      this.recordResult(domain, result.success, Date.now() - startTime, activeStrategy);
      return result;
    }

    // --- Strategy: Challenge Solver (CAPTCHA) ---------------------------
    if (activeStrategy === 'challenge-solver') {
      const result = await this.executeChallengeSolver(ctx);
      this.recordResult(domain, result.success, Date.now() - startTime, activeStrategy);
      return result;
    }

    // --- Strategy: Profile Rotation -------------------------------------
    if (activeStrategy === 'profile-rotation') {
      // Rotate behavioral profile and retry with behavioral-mimic
      this.behavioralCache.delete(domain);
      const result = await this.executeBehavioralMimicBypass(ctx);
      this.recordResult(domain, result.success, Date.now() - startTime, activeStrategy);
      return result;
    }

    // --- Strategy: Maximum Stealth --------------------------------------
    if (activeStrategy === 'maximum-stealth') {
      const result = await this.executeMaximumStealthBypass(ctx);
      this.recordResult(domain, result.success, Date.now() - startTime, activeStrategy);
      return result;
    }

    // Fallback: try behavioral mimic
    const fallbackResult = await this.executeBehavioralMimicBypass(ctx);
    this.recordResult(domain, fallbackResult.success, Date.now() - startTime, activeStrategy);
    return fallbackResult;
  }

  // --- Cookie Injection --------------------------------------------------

  /**
   * Attempt to inject cached PX cookies for repeat visits.
   */
  private async tryCookieInjection(ctx: BypassContext): Promise<AntiBotResult | null> {
    const validTokens = this.getValidTokens(ctx.domain);
    if (validTokens.length === 0) return null;

    const startTime = Date.now();
    logger.info({ domain: ctx.domain, tokenCount: validTokens.length }, 'Injecting cached PX cookies');

    try {
      // Inject cookies into the browser context
      const cookiesToAdd = validTokens.map(t => ({
        name: t.name,
        value: t.value,
        domain: t.domain,
        path: t.path,
        httpOnly: t.httpOnly,
        secure: t.secure,
        sameSite: t.sameSite as 'Strict' | 'Lax' | 'None',
      }));

      await ctx.context.addCookies(cookiesToAdd);

      // Reload the page with injected cookies
      await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });

      // Wait a moment for PX to validate the cookies
      await this.sleep(2000);

      // Check if the challenge is gone
      const challengeGone = await this.isChallengeGone(ctx.page);
      if (challengeGone) {
        this.stats.tokenReuses++;
        logger.info({ domain: ctx.domain }, 'Cached PX cookies successfully bypassed challenge');

        return this.buildSuccessResult({
          strategy: 'cookie-injection',
          durationMs: Date.now() - startTime,
          cookies: validTokens,
          rechallengeExpected: true,
          rechallengeInMs: PX3_COOKIE_LIFETIME_MS,
          metadata: { source: 'cache' },
        });
      }

      logger.info({ domain: ctx.domain }, 'Cached PX cookies rejected -- need fresh solve');
      this.invalidateTokens(ctx.domain);
      return null;
    } catch (err: any) {
      logger.warn({ err: err.message, domain: ctx.domain }, 'Cookie injection failed');
      return null;
    }
  }

  // --- Behavioral Mimic Bypass -------------------------------------------

  /**
   * Primary bypass strategy: synthesize behavioral data, inject pre/post
   * scripts, and perform human-like interactions on the page.
   */
  private async executeBehavioralMimicBypass(ctx: BypassContext): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;
    const errors: string[] = [];
    const warnings: string[] = [];
    const detectionSignals: DetectionIndicator[] = [];

    try {
      // Step 1: Get or synthesize behavioral data for this domain
      let behavioralData = this.behavioralCache.get(domain);
      if (!behavioralData) {
        const viewport = ctx.page.viewportSize() || { width: 1280, height: 800 };
        behavioralData = synthesizeFullBehavioralPayload(viewport.width, viewport.height);
        this.behavioralCache.set(domain, behavioralData);
      }

      // Step 2: Inject PX pre-script BEFORE PX loads
      try {
        await ctx.context.addInitScript(PX_PRE_SCRIPT);
        logger.debug({ domain }, 'PX pre-script registered as init script');
      } catch (err: any) {
        warnings.push(`Pre-script injection warning: ${err.message}`);
        // Try direct injection as fallback
        try {
          await ctx.page.evaluate(PX_PRE_SCRIPT);
        } catch (evalErr: any) {
          warnings.push(`Pre-script direct eval failed: ${evalErr.message}`);
        }
      }

      // Step 3: Inject post-script to monitor for cookies and CAPTCHA
      try {
        await ctx.page.evaluate(PX_POST_SCRIPT);
      } catch (err: any) {
        warnings.push(`Post-script injection failed: ${err.message}`);
      }

      // Step 4: Perform human-like interactions on the page
      await this.performHumanInteractions(ctx);

      // Step 5: Wait for challenge resolution
      const resolved = await this.waitForChallengeResolution(ctx.page, PX_CHALLENGE_TIMEOUT_MS);

      if (resolved) {
        // Step 6: Extract _px3 cookie
        const extractedCookies = await this.extractPxCookies(ctx);

        if (extractedCookies.length > 0) {
          // Store cookies for future use
          await this.storeTokens(domain, extractedCookies);

          logger.info(
            { domain, cookiesFound: extractedCookies.length, durationMs: Date.now() - startTime },
            'PerimeterX bypass successful via behavioral mimic',
          );

          return this.buildSuccessResult({
            strategy: 'behavioral-mimic',
            durationMs: Date.now() - startTime,
            cookies: extractedCookies,
            detectionSignals,
            rechallengeExpected: true,
            rechallengeInMs: PX3_COOKIE_LIFETIME_MS,
            warnings,
            metadata: { behavioralPoints: behavioralData.mouse.points.length },
          });
        } else {
          errors.push('Challenge resolved but no _px3 cookie extracted');
        }
      } else {
        errors.push('Challenge did not resolve within timeout');

        // Check if CAPTCHA was presented (PX escalated)
        const hasCaptcha = await this.detectCaptcha(ctx.page);
        if (hasCaptcha) {
          detectionSignals.push({
            category: 'dom',
            description: 'PerimeterX escalated to CAPTCHA -- behavioral data was insufficient',
            weight: 0.8,
          });

          // Try solving the CAPTCHA
          const captchaResult = await this.solveCaptcha(ctx);
          if (captchaResult.length > 0) {
            await this.storeTokens(domain, captchaResult);
            return this.buildSuccessResult({
              strategy: 'behavioral-mimic',
              durationMs: Date.now() - startTime,
              cookies: captchaResult,
              detectionSignals,
              rechallengeExpected: true,
              rechallengeInMs: PX3_COOKIE_LIFETIME_MS,
              warnings: [...warnings, 'CAPTCHA was required and solved'],
              metadata: { captchaRequired: true },
            });
          }

          errors.push('CAPTCHA was presented but could not be solved');
        }
      }

      return this.buildFailureResult({
        strategy: 'behavioral-mimic',
        durationMs: Date.now() - startTime,
        errors,
        detectionSignals,
        warnings,
        metadata: { resolved, behavioralDataGenerated: true },
      });
    } catch (err: any) {
      logger.error({ err: err.message, domain }, 'Behavioral mimic bypass failed');
      return this.buildFailureResult({
        strategy: 'behavioral-mimic',
        durationMs: Date.now() - startTime,
        errors: [err.message],
        warnings,
      });
    }
  }

  // --- Browser Execute Bypass --------------------------------------------

  /**
   * Let the browser execute the PX challenge naturally, only injecting
   * the monitoring post-script to capture cookies.
   */
  private async executeBrowserBypass(ctx: BypassContext): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;

    try {
      // Inject monitoring script
      await ctx.page.evaluate(PX_POST_SCRIPT);

      // Wait for the challenge to resolve naturally
      const resolved = await this.waitForChallengeResolution(ctx.page, PX_CHALLENGE_TIMEOUT_MS);

      if (resolved) {
        const cookies = await this.extractPxCookies(ctx);
        if (cookies.length > 0) {
          await this.storeTokens(domain, cookies);
          return this.buildSuccessResult({
            strategy: 'browser-execute',
            durationMs: Date.now() - startTime,
            cookies,
            rechallengeExpected: true,
            rechallengeInMs: PX3_COOKIE_LIFETIME_MS,
          });
        }
      }

      return this.buildFailureResult({
        strategy: 'browser-execute',
        durationMs: Date.now() - startTime,
        errors: ['Browser execute did not produce _px3 cookie'],
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'browser-execute',
        durationMs: Date.now() - startTime,
        errors: [err.message],
      });
    }
  }

  // --- Challenge Solver --------------------------------------------------

  /**
   * Attempt to solve a PX CAPTCHA (own CAPTCHA or hCaptcha).
   */
  private async executeChallengeSolver(ctx: BypassContext): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;

    try {
      const hasCaptcha = await this.detectCaptcha(ctx.page);
      if (!hasCaptcha) {
        return this.buildFailureResult({
          strategy: 'challenge-solver',
          durationMs: Date.now() - startTime,
          errors: ['No CAPTCHA detected to solve'],
        });
      }

      logger.info({ domain }, 'Attempting to solve PerimeterX CAPTCHA');

      // Try to interact with the CAPTCHA
      const solved = await this.solveCaptcha(ctx);

      if (solved.length > 0) {
        await this.storeTokens(domain, solved);
        return this.buildSuccessResult({
          strategy: 'challenge-solver',
          durationMs: Date.now() - startTime,
          cookies: solved,
          rechallengeExpected: true,
          rechallengeInMs: PX3_COOKIE_LIFETIME_MS,
          warnings: ['CAPTCHA solve requires human-like interaction timing'],
        });
      }

      // Wait for resolution after CAPTCHA interaction
      const resolved = await this.waitForChallengeResolution(ctx.page, PX_CAPTCHA_TIMEOUT_MS);
      if (resolved) {
        const cookies = await this.extractPxCookies(ctx);
        if (cookies.length > 0) {
          await this.storeTokens(domain, cookies);
          return this.buildSuccessResult({
            strategy: 'challenge-solver',
            durationMs: Date.now() - startTime,
            cookies,
            rechallengeExpected: true,
            rechallengeInMs: PX3_COOKIE_LIFETIME_MS,
          });
        }
      }

      return this.buildFailureResult({
        strategy: 'challenge-solver',
        durationMs: Date.now() - startTime,
        errors: ['CAPTCHA could not be solved'],
      });
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'challenge-solver',
        durationMs: Date.now() - startTime,
        errors: [err.message],
      });
    }
  }

  // --- Maximum Stealth Bypass --------------------------------------------

  /**
   * Apply all stealth measures + behavioral mimic for the hardest PX sites.
   */
  private async executeMaximumStealthBypass(ctx: BypassContext): Promise<AntiBotResult> {
    const startTime = Date.now();
    const domain = ctx.domain;

    try {
      // Use CDP session to apply deep stealth if available
      if (ctx.cdpSession) {
        await this.applyCdpStealth(ctx.cdpSession);
      }

      // Re-inject all scripts
      await ctx.context.addInitScript(PX_PRE_SCRIPT);

      // Reset behavioral data for fresh synthesis
      this.behavioralCache.delete(domain);

      // Execute behavioral mimic with full stealth
      const result = await this.executeBehavioralMimicBypass(ctx);

      // Override the strategy name in the result
      return {
        ...result,
        strategy: 'maximum-stealth',
      };
    } catch (err: any) {
      return this.buildFailureResult({
        strategy: 'maximum-stealth',
        durationMs: Date.now() - startTime,
        errors: [err.message],
      });
    }
  }

  // --- Human Interactions ------------------------------------------------

  /**
   * Perform realistic human-like interactions on the page:
   * mouse movements, clicks, scrolls, and typing.
   */
  private async performHumanInteractions(ctx: BypassContext): Promise<void> {
    try {
      const viewport = ctx.page.viewportSize() || { width: 1280, height: 800 };

      // 1. Initial mouse movements -- explore the page
      for (let i = 0; i < randomInt(3, 6); i++) {
        const targetX = randomBetween(viewport.width * 0.1, viewport.width * 0.9);
        const targetY = randomBetween(viewport.height * 0.1, viewport.height * 0.9);
        const path = generateMousePath(
          randomBetween(viewport.width * 0.2, viewport.width * 0.8),
          randomBetween(viewport.height * 0.2, viewport.height * 0.8),
          targetX,
          targetY,
          randomInt(10, 25),
        );

        for (const point of path) {
          await ctx.page.mouse.move(point.x, point.y);
          await this.sleep(randomBetween(5, 20));
        }

        await this.sleep(randomBetween(100, 500));
      }

      // 2. Scroll down naturally
      const scrollSegments = randomInt(2, 5);
      for (let s = 0; s < scrollSegments; s++) {
        const scrollAmount = randomBetween(100, 350);
        await ctx.page.mouse.wheel(0, scrollAmount);
        await this.sleep(randomBetween(500, 2000));
      }

      // 3. Click on a non-threatening area of the page
      try {
        await ctx.page.mouse.click(
          randomBetween(viewport.width * 0.3, viewport.width * 0.7),
          randomBetween(viewport.height * 0.3, viewport.height * 0.7),
        );
        await this.sleep(randomBetween(200, 800));
      } catch { /* click failed, non-critical */ }

      // 4. More scrolling with direction changes
      if (Math.random() < 0.5) {
        await ctx.page.mouse.wheel(0, -randomBetween(30, 100));
        await this.sleep(randomBetween(300, 1000));
      }

      // 5. Move mouse to a different area
      const finalX = randomBetween(viewport.width * 0.1, viewport.width * 0.9);
      const finalY = randomBetween(viewport.height * 0.1, viewport.height * 0.9);
      await ctx.page.mouse.move(finalX, finalY, { steps: randomInt(8, 20) });
      await this.sleep(randomBetween(500, 1500));

      // 6. Simulate a brief keyboard interaction (Tab key)
      if (Math.random() < 0.3) {
        await ctx.page.keyboard.press('Tab');
        await this.sleep(randomBetween(200, 500));
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Human interaction simulation had errors (non-critical)');
    }
  }

  // --- CAPTCHA Detection & Solving ---------------------------------------

  /**
   * Detect if PX has presented a CAPTCHA on the page.
   */
  private async detectCaptcha(page: Page): Promise<boolean> {
    try {
      // Check DOM for CAPTCHA elements
      for (const selector of PX_CHALLENGE_SELECTORS) {
        try {
          const element = await page.$(selector);
          if (element) {
            const isVisible = await element.isVisible().catch(() => false);
            if (isVisible) return true;
          }
        } catch { /* selector check failed */ }
      }

      // Check for hCaptcha iframe (PX sometimes uses hCaptcha)
      const hcaptchaFrame = await page.$('iframe[src*="hcaptcha"]');
      if (hcaptchaFrame) return true;

      // Check for reCAPTCHA iframe (less common with PX)
      const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
      if (recaptchaFrame) return true;

      // Check the DOM attribute set by our post-script
      const captchaIframe = await page.evaluate(() =>
        document.documentElement.getAttribute('data-px-captcha-iframe'),
      );
      if (captchaIframe) return true;

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Attempt to solve the PX CAPTCHA by clicking the checkbox
   * and waiting for resolution.
   */
  private async solveCaptcha(ctx: BypassContext): Promise<ManagedCookie[]> {
    try {
      // Look for PX's own CAPTCHA checkbox
      const pxCaptchaCheckbox = await ctx.page.$('#px-captcha input[type="checkbox"], .px-captcha input[type="checkbox"]');

      if (pxCaptchaCheckbox) {
        const box = await pxCaptchaCheckbox.boundingBox();
        if (box) {
          // Move to the checkbox with human-like movement
          const path = generateMousePath(
            box.x + box.width / 2 + randomBetween(-50, 50),
            box.y + box.height / 2 + randomBetween(-50, 50),
            box.x + randomBetween(box.width * 0.3, box.width * 0.7),
            box.y + randomBetween(box.height * 0.3, box.height * 0.7),
            randomInt(10, 20),
          );

          for (const point of path) {
            await ctx.page.mouse.move(point.x, point.y);
            await this.sleep(randomBetween(5, 15));
          }

          // Pause before clicking (decision time)
          await this.sleep(randomBetween(300, 800));

          // Click the checkbox
          await ctx.page.mouse.click(
            box.x + randomBetween(box.width * 0.3, box.width * 0.7),
            box.y + randomBetween(box.height * 0.3, box.height * 0.7),
          );

          // Wait for CAPTCHA processing
          await this.sleep(randomBetween(2000, 5000));
        }
      }

      // Handle hCaptcha if present
      const hcaptchaFrame = await ctx.page.$('iframe[src*="hcaptcha"]');
      if (hcaptchaFrame) {
        const frame = await hcaptchaFrame.contentFrame();
        if (frame) {
          const checkbox = await frame.$('#checkbox');
          if (checkbox) {
            const box = await checkbox.boundingBox();
            if (box) {
              await ctx.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              await this.sleep(randomBetween(2000, 4000));
            }
          }
        }
      }

      // Extract cookies after CAPTCHA interaction
      return this.extractPxCookies(ctx);
    } catch (err: any) {
      logger.debug({ err: err.message }, 'CAPTCHA solving attempt failed');
      return [];
    }
  }

  // --- Challenge Resolution Monitoring ------------------------------------

  /**
   * Check if the PX challenge has been resolved (challenge elements gone,
   * page navigated away, or _px3 cookie is present).
   */
  private async isChallengeGone(page: Page): Promise<boolean> {
    try {
      // Check if challenge elements are still visible
      for (const selector of PX_CHALLENGE_SELECTORS) {
        try {
          const element = await page.$(selector);
          if (element) {
            const isVisible = await element.isVisible().catch(() => false);
            if (isVisible) return false;
          }
        } catch { /* selector check failed */ }
      }

      // Check for _px3 cookie
      const cookies = await page.context().cookies();
      const hasPx3 = cookies.some(c => c.name === '_px3');
      if (hasPx3) return true;

      // Check if we navigated away from the challenge page
      const bodyText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || '');
      const hasChallengeText = PX_CHALLENGE_TEXTS.some(t => bodyText.includes(t.toLowerCase()));
      if (!hasChallengeText) return true;

      return false;
    } catch {
      // If we can't evaluate, the page might have navigated -- assume resolved
      return true;
    }
  }

  /**
   * Wait for the PX challenge to resolve, polling periodically.
   */
  private async waitForChallengeResolution(
    page: Page,
    timeout: number,
  ): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 500;

    logger.debug({ timeout }, 'Waiting for PerimeterX challenge resolution');

    while (Date.now() - startTime < timeout) {
      try {
        const resolved = await this.isChallengeGone(page);
        if (resolved) {
          logger.info(
            { durationMs: Date.now() - startTime },
            'PerimeterX challenge resolved',
          );
          return true;
        }

        await this.sleep(checkInterval);
      } catch {
        // Page might have navigated -- check if we can still access it
        try {
          await page.evaluate(() => document.title);
        } catch {
          // Page navigated away -- likely challenge resolved
          logger.info('Page navigated away -- assuming PX challenge resolved');
          return true;
        }
      }
    }

    logger.warn({ timeout }, 'PerimeterX challenge resolution timed out');
    return false;
  }

  // --- Cookie Extraction -------------------------------------------------

  /**
   * Extract PX cookies from the browser context and from the DOM
   * (our post-script stores them in data attributes).
   */
  private async extractPxCookies(ctx: BypassContext): Promise<ManagedCookie[]> {
    const cookies: ManagedCookie[] = [];
    const domain = ctx.domain;

    try {
      // Method 1: Extract from Playwright's cookie API
      const browserCookies = await ctx.context.cookies();
      for (const cookie of browserCookies) {
        if (PX_COOKIE_NAMES.includes(cookie.name)) {
          cookies.push(
            this.createManagedCookie(
              {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                httpOnly: cookie.httpOnly,
                secure: cookie.secure,
                sameSite: (cookie.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
              },
              PX3_COOKIE_LIFETIME_MS,
            ),
          );
        }
      }

      // Method 2: Extract from DOM attributes set by our post-script
      try {
        const pxCookieJson = await ctx.page.evaluate(() =>
          document.documentElement.getAttribute('data-px-cookies'),
        );
        if (pxCookieJson) {
          const pxCookies = JSON.parse(pxCookieJson) as Record<string, string>;
          for (const [name, value] of Object.entries(pxCookies)) {
            // Don't duplicate cookies already extracted
            if (!cookies.some(c => c.name === name)) {
              cookies.push(
                this.createManagedCookie(
                  {
                    name,
                    value,
                    domain,
                    path: '/',
                    httpOnly: name === '_px3',
                    secure: true,
                    sameSite: 'Lax',
                  },
                  PX3_COOKIE_LIFETIME_MS,
                ),
              );
            }
          }
        }
      } catch { /* DOM cookie extraction failed */ }

      // Method 3: Extract _px3 specifically from the dedicated attribute
      if (!cookies.some(c => c.name === '_px3')) {
        try {
          const px3Value = await ctx.page.evaluate(() =>
            document.documentElement.getAttribute('data-px3-cookie'),
          );
          if (px3Value) {
            cookies.push(
              this.createManagedCookie(
                {
                  name: '_px3',
                  value: px3Value,
                  domain,
                  path: '/',
                  httpOnly: true,
                  secure: true,
                  sameSite: 'Lax',
                },
                PX3_COOKIE_LIFETIME_MS,
              ),
            );
          }
        } catch { /* _px3 extraction failed */ }
      }

      logger.info(
        { domain, cookiesFound: cookies.length, cookieNames: cookies.map(c => c.name) },
        'PX cookies extracted',
      );
    } catch (err: any) {
      logger.error({ err: err.message, domain }, 'PX cookie extraction failed');
    }

    return cookies;
  }

  // --- CDP Stealth -------------------------------------------------------

  /**
   * Apply CDP-level stealth patches to further evade PX detection.
   */
  private async applyCdpStealth(cdpSession: CDPSession): Promise<void> {
    try {
      // Override navigator.webdriver
      await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
          Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });

          // Override chrome runtime check (PX checks this)
          window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };

          // Override permissions query
          const originalQuery = window.navigator.permissions.query;
          window.navigator.permissions.query = (parameters) =>
            parameters.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : originalQuery(parameters);

          // Override connection info
          if (navigator.connection) {
            Object.defineProperty(navigator.connection, 'rtt', { get: () => 50, configurable: true });
          }

          // Fix iframe contentWindow check
          Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
            get: function() {
              return window;
            },
            configurable: true,
          });
        `,
      });

      logger.debug('CDP stealth patches applied for PerimeterX');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'CDP stealth patch failed (non-critical)');
    }
  }

  // --- Statistics --------------------------------------------------------

  getStats(): Record<string, unknown> {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      behavioralCacheSize: this.behavioralCache.size,
      activeChallenges: this.activeChallenges.size,
      pxSpecificMetrics: {
        avgBehavioralPoints: Array.from(this.behavioralCache.values())
          .reduce((sum, b) => sum + b.mouse.points.length, 0) /
          (this.behavioralCache.size || 1),
      },
    };
  }
}

// ===============================================================================
// SINGLETON EXPORT
// ===============================================================================

export const perimeterxEvader = new PerimeterXEvader();
export default PerimeterXEvader;
