/**
 * Kasada-Specific Behavioral Engine -- ScrapeSuite Engine
 *
 * Extends the generic HumanBehaviorEngine with Kasada-specific behavioral
 * patterns that Kasada's monitoring specifically checks for. Without these
 * patterns, even a perfectly fingerprinted browser will fail Kasada's
 * behavioral analysis.
 *
 * Features:
 *  * Focus/blur/visibility state transitions
 *  * Event listener registration patterns (Kasada counts listeners)
 *  * Touch event chains for mobile emulation
 *  * Pointer event sequences (pointerdown -> pointermove -> pointerup)
 *  * Scroll momentum patterns (deceleration curves, not linear)
 *  * Keyboard event chains (beforeinput -> input -> keydown -> keyup ordering)
 *  * Page lifecycle events (DOMContentLoaded, load, visibilitychange)
 *  * Adaptive timing based on Kasada's expected thresholds
 *
 * Estimated improvement: +3-5% against Kasada (behavioral score fix)
 */

import type { Page } from 'playwright';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('kasada-behavior');

// ===============================================================================
// EXPORTED TYPES
// ===============================================================================

export type KasadaDeviceType = 'desktop-chrome' | 'desktop-firefox' | 'mobile-android' | 'mobile-ios' | 'tablet';

export interface KasadaBehaviorConfig {
  deviceType: KasadaDeviceType;
  focusEvents: boolean;
  visibilityEvents: boolean;
  pointerEvents: boolean;
  touchEvents: boolean;
  keyboardChains: boolean;
  scrollMomentum: boolean;
  registerExtraListeners: boolean;
  speedMultiplier: number;
}

export interface FocusEventSequence {
  type: 'focus' | 'blur' | 'visibilitychange';
  target: 'window' | 'document' | 'element';
  visibilityState?: 'visible' | 'hidden' | 'prerender';
  timestamp: number;
}

export interface TouchEventChain {
  touchstart: { x: number; y: number; pressure: number; timestamp: number };
  touchmove: Array<{ x: number; y: number; pressure: number; timestamp: number }>;
  touchend: { x: number; y: number; timestamp: number };
  totalDurationMs: number;
}

export interface PointerSequence {
  pointerdown: { x: number; y: number; pressure: number; pointerType: string; timestamp: number };
  pointermove: Array<{ x: number; y: number; pressure: number; timestamp: number }>;
  pointerup: { x: number; y: number; pressure: number; timestamp: number };
}

export interface KeyboardEventChain {
  beforeinput?: { inputType: string; data: string; timestamp: number };
  keydown: { key: string; code: string; timestamp: number };
  input: { inputType: string; data: string; timestamp: number };
  keyup: { key: string; code: string; timestamp: number };
}

export interface ScrollMomentumCurve {
  segments: Array<{ velocity: number; duration: number; distance: number }>;
  totalDistance: number;
  totalDuration: number;
}

// ===============================================================================
// CONSTANTS
// ===============================================================================

const DEFAULT_BEHAVIOR_CONFIG: KasadaBehaviorConfig = {
  deviceType: 'desktop-chrome',
  focusEvents: true,
  visibilityEvents: true,
  pointerEvents: true,
  touchEvents: false,
  keyboardChains: true,
  scrollMomentum: true,
  registerExtraListeners: true,
  speedMultiplier: 1.0,
};

// ===============================================================================
// KASADA BEHAVIOR INIT SCRIPT
// ===============================================================================

/**
 * JavaScript init script that sets up event listeners, patches, and
 * behavioral patterns specifically for Kasada's monitoring.
 * Must be injected BEFORE any page JavaScript runs.
 */
const KASADA_BEHAVIOR_INIT_SCRIPT = `
  (function() {
    // --- Event Listener Registration ----------------------------------
    // Kasada counts the number of event listeners. A real browser has many.
    // Register listeners for all the events Kasada expects to see.
    var kasadaExpectedEvents = [
      'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick',
      'keydown', 'keyup', 'keypress',
      'focus', 'blur', 'focusin', 'focusout',
      'scroll', 'wheel', 'touchstart', 'touchmove', 'touchend',
      'pointerdown', 'pointermove', 'pointerup',
      'beforeinput', 'input', 'change',
      'visibilitychange', 'resize',
      'DOMContentLoaded', 'load', 'beforeunload'
    ];

    // Register listeners that do nothing but exist (Kasada checks listener count)
    for (var i = 0; i < kasadaExpectedEvents.length; i++) {
      try {
        document.addEventListener(kasadaExpectedEvents[i], function() {}, { passive: true, capture: true });
        window.addEventListener(kasadaExpectedEvents[i], function() {}, { passive: true, capture: true });
      } catch(e) {}
    }

    // --- Visibility State Management ---------------------------------
    Object.defineProperty(document, 'visibilityState', {
      get: function() { return 'visible'; },
      configurable: true
    });
    Object.defineProperty(document, 'hidden', {
      get: function() { return false; },
      configurable: true
    });

    // --- hasFocus Patch ----------------------------------------------
    var origHasFocus = document.hasFocus ? document.hasFocus.bind(document) : null;
    document.hasFocus = function() { return true; };

    // --- Pointer Events Patch ----------------------------------------
    document.addEventListener('pointerdown', function(e) {
      try {
        Object.defineProperty(e, 'pressure', { get: function() { return 0.5 + Math.random() * 0.3; }, configurable: true });
        Object.defineProperty(e, 'width', { get: function() { return 1 + Math.random() * 0.5; }, configurable: true });
        Object.defineProperty(e, 'height', { get: function() { return 1 + Math.random() * 0.5; }, configurable: true });
        Object.defineProperty(e, 'tiltX', { get: function() { return 0; }, configurable: true });
        Object.defineProperty(e, 'tiltY', { get: function() { return 0; }, configurable: true });
        Object.defineProperty(e, 'isPrimary', { get: function() { return true; }, configurable: true });
      } catch(ex) {}
    }, true);

    // --- Performance.now Consistency ---------------------------------
    var perfNow = performance.now.bind(performance);
    var timeOrigin = performance.timeOrigin || (Date.now() - perfNow());
    performance.now = function() {
      return Date.now() - timeOrigin + (Math.random() - 0.5) * 0.01;
    };

    // --- Event.isTrusted Patch ---------------------------------------
    try {
      var origIsTrusted = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');
      if (origIsTrusted) {
        Object.defineProperty(Event.prototype, 'isTrusted', {
          get: function() { return true; },
          configurable: true
        });
      }
    } catch(e) {}

    // --- Keyboard Event Consistency ----------------------------------
    // Ensure input events fire in correct order with proper data
    document.addEventListener('keydown', function(e) {
      try {
        Object.defineProperty(e, 'isComposing', { get: function() { return false; }, configurable: true });
        Object.defineProperty(e, 'location', { get: function() { return 0; }, configurable: true });
      } catch(ex) {}
    }, true);

    // --- Wheel Event Consistency -------------------------------------
    document.addEventListener('wheel', function(e) {
      try {
        Object.defineProperty(e, 'deltaMode', { get: function() { return 1; }, configurable: true });
        Object.defineProperty(e, 'isTrusted', { get: function() { return true; }, configurable: true });
      } catch(ex) {}
    }, true);
  })();
`;

// ===============================================================================
// KASADA BEHAVIOR ENGINE
// ===============================================================================

class KasadaBehaviorEngine {
  private config: KasadaBehaviorConfig;
  private initialized = false;
  private stats = {
    focusSequences: 0,
    touchChains: 0,
    pointerSequences: 0,
    keyboardChains: 0,
    scrollMomentumEvents: 0,
    pageLifecycleEvents: 0,
    listenerRegistrations: 0,
    greetingsPerformed: 0,
  };

  constructor(config?: Partial<KasadaBehaviorConfig>) {
    this.config = { ...DEFAULT_BEHAVIOR_CONFIG, ...config };
  }

  // --- Initialization ------------------------------------------------------

  initialize(config?: Partial<KasadaBehaviorConfig>): void {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    this.initialized = true;
    logger.info(
      { deviceType: this.config.deviceType, speedMultiplier: this.config.speedMultiplier },
      'Kasada Behavior Engine initialized'
    );
  }

  // --- Init Script ---------------------------------------------------------

  /**
   * Return the JS init script for Kasada-specific behavioral patches.
   * Should be injected via context.addInitScript() BEFORE page JS runs.
   */
  getKasadaInitScript(): string {
    return KASADA_BEHAVIOR_INIT_SCRIPT;
  }

  // --- Focus/Blur/Visibility Simulation ------------------------------------

  /**
   * Simulate focus/blur/visibility events that Kasada expects to see.
   * Real browsers go through visibility transitions; bots never do.
   */
  async simulateFocusSequence(page: Page): Promise<void> {
    if (!this.config.focusEvents && !this.config.visibilityEvents) return;

    try {
      // Simulate window gaining focus
      await page.evaluate(() => {
        window.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      });
      await this.sleep(this.gaussianRandom(300, 100));

      // Simulate a brief blur (user clicked away momentarily)
      if (Math.random() < 0.3) {
        await page.evaluate(() => {
          window.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        });
        await this.sleep(this.gaussianRandom(500, 200));
        await page.evaluate(() => {
          window.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        });
      }

      // Simulate focus on a form element
      const focusableElements = await page.$$('input, textarea, select, button, a[href]');
      if (focusableElements.length > 0) {
        const targetIdx = Math.floor(Math.random() * Math.min(focusableElements.length, 5));
        try {
          await focusableElements[targetIdx].focus();
          await this.sleep(this.gaussianRandom(200, 80));
        } catch { /* focus failed */ }
      }

      this.stats.focusSequences++;
      logger.debug('Focus/visibility sequence simulated');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Focus sequence simulation failed');
    }
  }

  // --- Touch Event Chain Simulation ----------------------------------------

  /**
   * Simulate a complete touch event chain for mobile emulation.
   * Kasada expects: touchstart -> touchmove(s) -> touchend with realistic timing.
   */
  async simulateTouchChain(
    page: Page,
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ): Promise<void> {
    if (!this.config.touchEvents) return;

    try {
      const chain = this.generateTouchChain(startX, startY, endX, endY);

      // Dispatch touchstart
      await page.evaluate((data: { x: number; y: number; pressure: number }) => {
        document.dispatchEvent(new TouchEvent('touchstart', {
          touches: [new Touch({ identifier: 0, target: document, clientX: data.x, clientY: data.y, pageX: data.x, pageY: data.y, screenX: 0, screenY: 0, radiusX: 5, radiusY: 5, rotationAngle: 0, force: data.pressure })],
          bubbles: true,
          cancelable: true,
        }));
      }, { x: chain.touchstart.x, y: chain.touchstart.y, pressure: chain.touchstart.pressure });

      await this.sleep(16); // One frame

      // Dispatch touchmove events
      for (const move of chain.touchmove) {
        await page.evaluate((data: { x: number; y: number; pressure: number }) => {
          document.dispatchEvent(new TouchEvent('touchmove', {
            touches: [new Touch({ identifier: 0, target: document, clientX: data.x, clientY: data.y, pageX: data.x, pageY: data.y, screenX: 0, screenY: 0, radiusX: 5, radiusY: 5, rotationAngle: 0, force: data.pressure })],
            bubbles: true,
            cancelable: true,
          }));
        }, { x: move.x, y: move.y, pressure: move.pressure });
        await this.sleep(16);
      }

      // Dispatch touchend
      await page.evaluate((data: { x: number; y: number }) => {
        document.dispatchEvent(new TouchEvent('touchend', {
          changedTouches: [new Touch({ identifier: 0, target: document, clientX: data.x, clientY: data.y, pageX: data.x, pageY: data.y, screenX: 0, screenY: 0, radiusX: 5, radiusY: 5, rotationAngle: 0, force: 0 })],
          touches: [],
          bubbles: true,
          cancelable: true,
        }));
      }, { x: chain.touchend.x, y: chain.touchend.y });

      this.stats.touchChains++;
      logger.debug({ startX, startY, endX, endY }, 'Touch chain simulated');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Touch chain simulation failed');
    }
  }

  /**
   * Generate a realistic touch event chain.
   */
  generateTouchChain(startX: number, startY: number, endX: number, endY: number): TouchEventChain {
    const now = Date.now();
    const totalDurationMs = this.gaussianRandom(300, 100);
    const moveCount = Math.floor(Math.random() * 6) + 2;
    const touchmove: TouchEventChain['touchmove'] = [];

    for (let i = 1; i <= moveCount; i++) {
      const t = i / (moveCount + 1);
      // Deceleration: fast at start, slow at end
      const eased = 1 - Math.pow(1 - t, 2);
      touchmove.push({
        x: Math.round(startX + (endX - startX) * eased),
        y: Math.round(startY + (endY - startY) * eased),
        pressure: 0.3 + Math.random() * 0.3 * (1 - t),
        timestamp: now + Math.round(t * totalDurationMs),
      });
    }

    return {
      touchstart: {
        x: Math.round(startX),
        y: Math.round(startY),
        pressure: 0.3 + Math.random() * 0.4,
        timestamp: now,
      },
      touchmove,
      touchend: {
        x: Math.round(endX),
        y: Math.round(endY),
        timestamp: now + Math.round(totalDurationMs),
      },
      totalDurationMs,
    };
  }

  // --- Pointer Event Sequence Simulation -----------------------------------

  /**
   * Simulate pointer down/move/up sequence.
   * Kasada checks for pointer event consistency.
   */
  async simulatePointerSequence(page: Page, targetX: number, targetY: number): Promise<void> {
    if (!this.config.pointerEvents) return;

    try {
      const pointerType = this.config.deviceType.startsWith('mobile') ? 'touch' : 'mouse';
      const sequence = this.generatePointerSequence(targetX, targetY, pointerType);

      // pointerdown
      await page.evaluate((data: { x: number; y: number; pressure: number; pType: string }) => {
        document.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: data.x, clientY: data.y, pressure: data.pressure, pointerType: data.pType,
          button: 0, buttons: 1, bubbles: true, cancelable: true,
        }));
      }, { x: sequence.pointerdown.x, y: sequence.pointerdown.y, pressure: sequence.pointerdown.pressure, pType: sequence.pointerdown.pointerType });

      await this.sleep(16);

      // pointermove
      for (const move of sequence.pointermove) {
        await page.evaluate((data: { x: number; y: number; pressure: number }) => {
          document.dispatchEvent(new PointerEvent('pointermove', {
            clientX: data.x, clientY: data.y, pressure: data.pressure, pointerType: 'mouse',
            button: 0, buttons: 1, bubbles: true, cancelable: true,
          }));
        }, { x: move.x, y: move.y, pressure: move.pressure });
        await this.sleep(8);
      }

      // pointerup
      await page.evaluate((data: { x: number; y: number; pressure: number }) => {
        document.dispatchEvent(new PointerEvent('pointerup', {
          clientX: data.x, clientY: data.y, pressure: data.pressure, pointerType: 'mouse',
          button: 0, buttons: 0, bubbles: true, cancelable: true,
        }));
      }, { x: sequence.pointerup.x, y: sequence.pointerup.y, pressure: sequence.pointerup.pressure });

      this.stats.pointerSequences++;
      logger.debug('Pointer sequence simulated');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Pointer sequence simulation failed');
    }
  }

  /**
   * Generate a pointer event sequence.
   */
  generatePointerSequence(targetX: number, targetY: number, pointerType: string): PointerSequence {
    const now = Date.now();
    // Start slightly offset from target
    const startX = targetX + this.gaussianRandom(0, 10);
    const startY = targetY + this.gaussianRandom(0, 10);

    const pointermove: PointerSequence['pointermove'] = [];
    const moveCount = Math.floor(Math.random() * 4) + 2;
    for (let i = 1; i <= moveCount; i++) {
      const t = i / (moveCount + 1);
      pointermove.push({
        x: Math.round(startX + (targetX - startX) * t + this.gaussianRandom(0, 2)),
        y: Math.round(startY + (targetY - startY) * t + this.gaussianRandom(0, 2)),
        pressure: 0.5 + Math.random() * 0.3,
        timestamp: now + i * 8,
      });
    }

    return {
      pointerdown: {
        x: Math.round(startX),
        y: Math.round(startY),
        pressure: 0.5 + Math.random() * 0.3,
        pointerType,
        timestamp: now,
      },
      pointermove,
      pointerup: {
        x: Math.round(targetX),
        y: Math.round(targetY),
        pressure: 0,
        timestamp: now + (moveCount + 1) * 8,
      },
    };
  }

  // --- Keyboard Event Chain Simulation -------------------------------------

  /**
   * Simulate keyboard events with proper chain ordering.
   * Kasada expects: beforeinput -> keydown -> input -> keyup
   */
  async simulateKeyboardChain(page: Page, text: string): Promise<void> {
    if (!this.config.keyboardChains) return;

    try {
      for (const char of text) {
        const code = `Key${char.toUpperCase()}`;
        const inputType = 'insertText';

        // Fire the full chain for each character
        await page.evaluate((data: { ch: string; c: string; it: string }) => {
          // beforeinput
          try {
            document.dispatchEvent(new InputEvent('beforeinput', {
              data: data.ch, inputType: data.it, bubbles: true, cancelable: true,
            }));
          } catch(e) {}

          // keydown
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: data.ch, code: data.c, bubbles: true, cancelable: true,
          }));

          // input
          try {
            document.dispatchEvent(new InputEvent('input', {
              data: data.ch, inputType: data.it, bubbles: true, cancelable: true,
            }));
          } catch(e) {}

          // keyup
          document.dispatchEvent(new KeyboardEvent('keyup', {
            key: data.ch, code: data.c, bubbles: true, cancelable: true,
          }));
        }, { ch: char, c: code, it: inputType });

        // Realistic typing delay
        const delay = this.gaussianRandom(80, 30) * this.config.speedMultiplier;
        await this.sleep(delay);
      }

      this.stats.keyboardChains++;
      logger.debug({ textLength: text.length }, 'Keyboard chain simulated');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Keyboard chain simulation failed');
    }
  }

  // --- Scroll Momentum Simulation ------------------------------------------

  /**
   * Simulate momentum-based scrolling with deceleration curves.
   * Kasada distinguishes bot scrolling (linear velocity) from human (deceleration).
   */
  async simulateScrollMomentum(page: Page, initialVelocity: number): Promise<void> {
    if (!this.config.scrollMomentum) return;

    try {
      const curve = this.generateScrollMomentumCurve(initialVelocity);

      for (const segment of curve.segments) {
        await page.mouse.wheel(0, Math.round(segment.distance));
        await this.sleep(segment.duration);
      }

      this.stats.scrollMomentumEvents += curve.segments.length;
      logger.debug(
        { totalDistance: Math.round(curve.totalDistance), segments: curve.segments.length },
        'Scroll momentum simulated'
      );
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Scroll momentum simulation failed');
    }
  }

  /**
   * Generate a scroll momentum curve with realistic deceleration.
   */
  generateScrollMomentumCurve(initialVelocity: number): ScrollMomentumCurve {
    const segments: ScrollMomentumCurve['segments'] = [];
    const friction = 0.92; // Deceleration factor
    let velocity = initialVelocity;
    let totalDistance = 0;
    let totalDuration = 0;
    const frameTime = 16; // ~60fps

    while (Math.abs(velocity) > 2) {
      const distance = Math.round(velocity);
      segments.push({ velocity, duration: frameTime, distance });
      totalDistance += Math.abs(distance);
      totalDuration += frameTime;
      velocity *= friction;
    }

    return { segments, totalDistance, totalDuration };
  }

  // --- Page Lifecycle Simulation -------------------------------------------

  /**
   * Simulate page lifecycle events that Kasada monitors.
   * Fires DOMContentLoaded -> load -> visibilitychange in proper order.
   */
  async simulatePageLifecycle(page: Page): Promise<void> {
    try {
      // These events should have already fired, but Kasada checks the timing
      // and that event listeners were registered BEFORE they fired
      await page.evaluate(() => {
        // Dispatch visibilitychange to confirm the page is visible
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      });
      await this.sleep(this.gaussianRandom(100, 50));

      this.stats.pageLifecycleEvents++;
      logger.debug('Page lifecycle events simulated');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Page lifecycle simulation failed');
    }
  }

  // --- Event Listener Registration -----------------------------------------

  /**
   * Register the event listeners Kasada expects to see.
   * This is handled by the init script, but this method can add extra listeners.
   */
  async registerKasadaListeners(page: Page): Promise<void> {
    if (!this.config.registerExtraListeners) return;

    try {
      await page.evaluate(() => {
        // Additional listeners Kasada may check for
        const extraEvents = [
          'animationstart', 'animationend', 'transitionend',
          'error', 'unhandledrejection', 'message',
          'storage', 'popstate', 'hashchange',
          'copy', 'paste', 'cut', 'dragstart', 'drop',
        ];
        for (const evt of extraEvents) {
          try {
            document.addEventListener(evt, function() {}, { passive: true });
            window.addEventListener(evt, function() {}, { passive: true });
          } catch(e) {}
        }
      });

      this.stats.listenerRegistrations++;
      logger.debug('Extra Kasada event listeners registered');
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Listener registration failed');
    }
  }

  // --- Kasada Greeting -----------------------------------------------------

  /**
   * Perform the initial behavioral sequence Kasada expects on page load.
   * This is the critical "first impression" that determines whether
   * Kasada's behavioral score starts high or low.
   */
  async performKasadaGreeting(page: Page): Promise<void> {
    try {
      // 1. Wait for page to settle
      await this.sleep(this.gaussianRandom(500, 200));

      // 2. Simulate focus acquisition
      await this.simulateFocusSequence(page);

      // 3. Register extra listeners
      await this.registerKasadaListeners(page);

      // 4. Simulate page lifecycle
      await this.simulatePageLifecycle(page);

      // 5. Initial mouse movement to "wake up" the page
      const viewport = page.viewportSize();
      if (viewport) {
        const startX = this.gaussianRandom(viewport.width * 0.5, viewport.width * 0.2);
        const startY = this.gaussianRandom(viewport.height * 0.3, viewport.height * 0.15);
        await page.mouse.move(startX, startY);
        await this.sleep(this.gaussianRandom(200, 100));

        // Small exploratory mouse movement
        await page.mouse.move(
          startX + this.gaussianRandom(50, 20),
          startY + this.gaussianRandom(30, 10)
        );
        await this.sleep(this.gaussianRandom(300, 150));
      }

      // 6. If mobile, simulate initial touch
      if (this.config.deviceType.startsWith('mobile') && viewport) {
        await this.simulateTouchChain(
          page,
          viewport.width * 0.5,
          viewport.height * 0.5,
          viewport.width * 0.5,
          viewport.height * 0.3
        );
      }

      // 7. Small scroll to indicate engagement
      await this.simulateScrollMomentum(page, this.gaussianRandom(40, 20));

      this.stats.greetingsPerformed++;
      logger.info('Kasada greeting sequence completed');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Kasada greeting sequence failed (non-critical)');
    }
  }

  // --- Configuration -------------------------------------------------------

  getConfig(): KasadaBehaviorConfig {
    return { ...this.config };
  }

  setDeviceType(deviceType: KasadaDeviceType): void {
    this.config.deviceType = deviceType;
    this.config.touchEvents = deviceType.startsWith('mobile') || deviceType === 'tablet';
    logger.info({ deviceType, touchEvents: this.config.touchEvents }, 'Kasada behavior device type updated');
  }

  // --- Statistics ----------------------------------------------------------

  getStats(): Record<string, any> {
    return {
      ...this.stats,
      deviceType: this.config.deviceType,
      speedMultiplier: this.config.speedMultiplier,
      config: { ...this.config },
    };
  }

  // --- Private Helpers -----------------------------------------------------

  private gaussianRandom(mean: number, std: number): number {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u1 || 0.0001)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z * std;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Math.round(ms))));
  }
}

// ===============================================================================
// SINGLETONS & EXPORTS
// ===============================================================================

export const kasadaBehavior = new KasadaBehaviorEngine();
export default KasadaBehaviorEngine;
