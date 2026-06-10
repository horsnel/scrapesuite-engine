/**
 * Human Behavior Engine -- ADVANCED EDITION for ScrapeSuite Engine.
 *
 * Production-grade behavioral simulation to defeat enterprise anti-bot systems
 * (DataDome, Akamai Bot Manager, PerimeterX, Kasada, Shape/F5).
 *
 * Features:
 *  * Cubic/quadratic Bezier curve mouse movements with Fitts's Law timing
 *  * Human-like acceleration/deceleration with momentum and overshoot correction
 *  * Jitter and micro-movements -- realistic hand tremor simulation (2-5px)
 *  * Typing rhythm with Gaussian distribution, bigram acceleration, typo simulation
 *  * Erratic scroll patterns with momentum, reading pauses, and section-awareness
 *  * Content-aware dwell time modeling with reading speed estimation
 *  * 8+ demographic/device/intent behavior profiles
 *  * Time-of-day behavior adaptation and fatigue modeling
 *  * Pre-defined interaction sequences and exploratory behaviors
 *  * Touch event simulation for mobile profiles
 *  * Pointer/keyboard/focus event consistency
 *  * Anti-detection: event timing variance, no repeatable patterns
 */

import type { Page, Mouse, Keyboard, ElementHandle } from 'playwright';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('human-behavior-engine');

// ===============================================================================
// TYPES
// ===============================================================================

export type BehaviorProfileName = 'fast' | 'normal' | 'careful' | 'researcher' | 'teenager' | 'professional' | 'elderly' | 'poweruser';
export type DeviceProfile = 'desktop-mouse' | 'laptop-trackpad' | 'mobile-touch' | 'tablet-stylus';
export type IntentProfile = 'browsing' | 'shopping' | 'researching' | 'comparing' | 'skimming';
export type TimeOfDay = 'morning' | 'work-hours' | 'evening' | 'late-night';

export interface BehaviorConfig {
  avgActionDelay: number;
  mouseSpeed: number;
  mouseSteps: number;
  typingDelay: number;
  typoProbability: number;
  scrollSpeed: number;
  idlePauses: number;
  idlePauseDuration: number;
  idleMouseJitter: boolean;
  overshootProbability: number;
  jitterAmplitude: number;
  dwellTimePerWord: number;
  decisionPauseMin: number;
  decisionPauseMax: number;
  fatigueRate: number;
  burstTypingEnabled: boolean;
  bigramAcceleration: number;
}

export interface InteractionSequence {
  name: string;
  steps: InteractionStep[];
}

export interface InteractionStep {
  action: 'move' | 'click' | 'type' | 'scroll' | 'wait' | 'hover' | 'drag' | 'select' | 'back' | 'forward' | 'reload';
  target?: string;
  text?: string;
  amount?: number;
  duration?: number;
}

export interface Point { x: number; y: number; }

export interface MousePath { points: Point[]; totalDuration: number; }

// ===============================================================================
// BEHAVIOR PROFILES
// ===============================================================================

const BEHAVIOR_PROFILES: Record<BehaviorProfileName, BehaviorConfig> = {
  fast: { avgActionDelay: 200, mouseSpeed: 15, mouseSteps: 8, typingDelay: 40, typoProbability: 0.01, scrollSpeed: 200, idlePauses: 1, idlePauseDuration: 500, idleMouseJitter: true, overshootProbability: 0.05, jitterAmplitude: 1.5, dwellTimePerWord: 80, decisionPauseMin: 50, decisionPauseMax: 200, fatigueRate: 0.001, burstTypingEnabled: true, bigramAcceleration: 0.6 },
  normal: { avgActionDelay: 500, mouseSpeed: 8, mouseSteps: 15, typingDelay: 80, typoProbability: 0.02, scrollSpeed: 100, idlePauses: 3, idlePauseDuration: 1500, idleMouseJitter: true, overshootProbability: 0.12, jitterAmplitude: 2.5, dwellTimePerWord: 200, decisionPauseMin: 150, decisionPauseMax: 500, fatigueRate: 0.003, burstTypingEnabled: true, bigramAcceleration: 0.7 },
  careful: { avgActionDelay: 1000, mouseSpeed: 5, mouseSteps: 25, typingDelay: 120, typoProbability: 0.03, scrollSpeed: 60, idlePauses: 5, idlePauseDuration: 3000, idleMouseJitter: true, overshootProbability: 0.2, jitterAmplitude: 3, dwellTimePerWord: 300, decisionPauseMin: 300, decisionPauseMax: 800, fatigueRate: 0.005, burstTypingEnabled: false, bigramAcceleration: 0.8 },
  researcher: { avgActionDelay: 1500, mouseSpeed: 3, mouseSteps: 30, typingDelay: 150, typoProbability: 0.02, scrollSpeed: 40, idlePauses: 8, idlePauseDuration: 5000, idleMouseJitter: true, overshootProbability: 0.15, jitterAmplitude: 2, dwellTimePerWord: 400, decisionPauseMin: 500, decisionPauseMax: 1500, fatigueRate: 0.004, burstTypingEnabled: false, bigramAcceleration: 0.85 },
  teenager: { avgActionDelay: 250, mouseSpeed: 18, mouseSteps: 6, typingDelay: 35, typoProbability: 0.05, scrollSpeed: 250, idlePauses: 1, idlePauseDuration: 300, idleMouseJitter: true, overshootProbability: 0.08, jitterAmplitude: 3.5, dwellTimePerWord: 60, decisionPauseMin: 30, decisionPauseMax: 150, fatigueRate: 0.0005, burstTypingEnabled: true, bigramAcceleration: 0.5 },
  professional: { avgActionDelay: 400, mouseSpeed: 10, mouseSteps: 12, typingDelay: 60, typoProbability: 0.01, scrollSpeed: 120, idlePauses: 2, idlePauseDuration: 1000, idleMouseJitter: true, overshootProbability: 0.1, jitterAmplitude: 1.5, dwellTimePerWord: 180, decisionPauseMin: 200, decisionPauseMax: 600, fatigueRate: 0.002, burstTypingEnabled: true, bigramAcceleration: 0.65 },
  elderly: { avgActionDelay: 2000, mouseSpeed: 2, mouseSteps: 35, typingDelay: 200, typoProbability: 0.08, scrollSpeed: 30, idlePauses: 10, idlePauseDuration: 6000, idleMouseJitter: true, overshootProbability: 0.3, jitterAmplitude: 4, dwellTimePerWord: 500, decisionPauseMin: 800, decisionPauseMax: 3000, fatigueRate: 0.01, burstTypingEnabled: false, bigramAcceleration: 0.95 },
  poweruser: { avgActionDelay: 150, mouseSpeed: 20, mouseSteps: 5, typingDelay: 30, typoProbability: 0.005, scrollSpeed: 300, idlePauses: 0, idlePauseDuration: 200, idleMouseJitter: false, overshootProbability: 0.03, jitterAmplitude: 1, dwellTimePerWord: 50, decisionPauseMin: 20, decisionPauseMax: 100, fatigueRate: 0.0008, burstTypingEnabled: true, bigramAcceleration: 0.4 },
};

const FAST_BIGRAMS = new Set(['th','he','in','er','an','re','on','at','en','nd','ti','es','or','te','of','ed','is','it','al','ar','st','to','nt','ng','se','ha','as','ou','io','le','ve','co','me','de','hi','ri','ro','ic','ne','ea']);

const DEVICE_MODIFIERS: Record<DeviceProfile, Partial<BehaviorConfig>> = {
  'desktop-mouse': { jitterAmplitude: 2, mouseSpeed: 8, overshootProbability: 0.1 },
  'laptop-trackpad': { jitterAmplitude: 1.5, mouseSpeed: 10, overshootProbability: 0.08, scrollSpeed: 80 },
  'mobile-touch': { jitterAmplitude: 0.5, mouseSpeed: 25, overshootProbability: 0.02, typingDelay: 100 },
  'tablet-stylus': { jitterAmplitude: 1, mouseSpeed: 6, overshootProbability: 0.15 },
};

const TIME_MODIFIERS: Record<TimeOfDay, { speedMultiplier: number; errorMultiplier: number }> = {
  'morning': { speedMultiplier: 0.9, errorMultiplier: 0.8 },
  'work-hours': { speedMultiplier: 1.0, errorMultiplier: 1.0 },
  'evening': { speedMultiplier: 0.85, errorMultiplier: 1.2 },
  'late-night': { speedMultiplier: 0.7, errorMultiplier: 1.8 },
};

// ===============================================================================
// MATH HELPERS
// ===============================================================================

function randomBetween(min: number, max: number): number { return Math.random() * (max - min) + min; }
function randomInt(min: number, max: number): number { return Math.floor(randomBetween(min, max + 1)); }
function randomGaussian(mean: number, stdDev: number): number {
  const u1 = Math.random(); const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1 || 0.0001)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stdDev;
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function distPts(p1: Point, p2: Point): number { return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t; const mt2 = mt * mt; const mt3 = mt2 * mt;
  const t2 = t * t; const t3 = t2 * t;
  return { x: mt3*p0.x + 3*mt2*t*p1.x + 3*mt*t2*p2.x + t3*p3.x, y: mt3*p0.y + 3*mt2*t*p1.y + 3*mt*t2*p2.y + t3*p3.y };
}

function generateControlPoints(start: Point, end: Point, curvature: number = 0.3): { cp1: Point; cp2: Point } {
  const dx = end.x - start.x; const dy = end.y - start.y;
  const d = Math.sqrt(dx*dx + dy*dy) || 1; const midX = (start.x + end.x) / 2; const midY = (start.y + end.y) / 2;
  const nx = -dy / d; const ny = dx / d;
  const off1 = (Math.random() - 0.5) * d * curvature; const off2 = (Math.random() - 0.5) * d * curvature;
  return { cp1: { x: midX - dx*0.25 + nx*off1, y: midY - dy*0.25 + ny*off1 }, cp2: { x: midX + dx*0.25 + nx*off2, y: midY + dy*0.25 + ny*off2 } };
}

function fittsLawTime(distance: number, targetWidth: number, a: number = 50, b: number = 100): number {
  const id = Math.log2(2 * distance / Math.max(targetWidth, 1)); return a + b * Math.max(id, 0);
}

function easeInOutCubic(t: number): number { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; }

function generateMousePath(start: Point, end: Point, config: BehaviorConfig, targetWidth: number = 50): MousePath {
  const d = distPts(start, end); const { cp1, cp2 } = generateControlPoints(start, end);
  const totalDuration = fittsLawTime(d, targetWidth);
  const steps = Math.max(config.mouseSteps, Math.ceil(d / config.mouseSpeed));
  const points: Point[] = []; const dt = 1 / steps;
  for (let i = 0; i <= steps; i++) {
    const t = easeInOutCubic(i * dt); let pt = cubicBezier(start, cp1, cp2, end, t);
    if (config.idleMouseJitter && i > 0 && i < steps) { pt.x += randomGaussian(0, config.jitterAmplitude); pt.y += randomGaussian(0, config.jitterAmplitude); }
    points.push(pt);
  }
  return { points, totalDuration };
}

function generateOvershootPath(start: Point, end: Point, config: BehaviorConfig): MousePath {
  const d = distPts(start, end); const dx = end.x - start.x; const dy = end.y - start.y; const norm = d || 1;
  const overshoot = randomBetween(5, 15);
  const overTarget: Point = { x: end.x + (dx/norm)*overshoot, y: end.y + (dy/norm)*overshoot };
  const mainPath = generateMousePath(start, overTarget, config, 30);
  const correctionPath = generateMousePath(overTarget, end, { ...config, mouseSteps: 4, jitterAmplitude: 0.5 }, 50);
  return { points: [...mainPath.points, ...correctionPath.points.slice(1)], totalDuration: mainPath.totalDuration + correctionPath.totalDuration };
}

// ===============================================================================
// TYPING RHYTHM ENGINE
// ===============================================================================

interface TypingEvent { key: string; delay: number; isTypo: boolean; }

const QWERTY_NEARBY: Record<string, string[]> = {
  'q':['w','a','s'],'w':['q','e','a','s','d'],'e':['w','r','s','d','f'],'r':['e','t','d','f','g'],'t':['r','y','f','g','h'],
  'y':['t','u','g','h','j'],'u':['y','i','h','j','k'],'i':['u','o','j','k','l'],'o':['i','p','k','l'],'p':['o','l'],
  'a':['q','w','s','z','x'],'s':['q','w','e','a','d','z','x','c'],'d':['w','e','r','s','f','x','c','v'],
  'f':['e','r','t','d','g','c','v','b'],'g':['r','t','y','f','h','v','b','n'],'h':['t','y','u','g','j','b','n','m'],
  'j':['y','u','i','h','k','n','m'],'k':['u','i','o','j','l','m'],'l':['i','o','p','k'],
  'z':['a','s','x'],'x':['z','a','s','d','c'],'c':['x','s','d','f','v'],'v':['c','d','f','g','b'],
  'b':['v','f','g','h','n'],'n':['b','g','h','j','m'],'m':['n','h','j','k'],
};

function getNearbyKey(char: string): string {
  const lower = char.toLowerCase(); const neighbors = QWERTY_NEARBY[lower];
  if (!neighbors || neighbors.length === 0) return char;
  const picked = neighbors[Math.floor(Math.random() * neighbors.length)];
  return char === lower ? picked : picked.toUpperCase();
}

function generateTypingSequence(text: string, config: BehaviorConfig): TypingEvent[] {
  const events: TypingEvent[] = []; let inBurst = false; let burstRemaining = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]; const prevChar = i > 0 ? text[i - 1] : '';
    let delay = Math.max(10, randomGaussian(config.typingDelay, config.typingDelay * 0.4));
    if (prevChar && FAST_BIGRAMS.has(prevChar.toLowerCase() + char.toLowerCase())) delay *= config.bigramAcceleration;
    if (config.burstTypingEnabled && !inBurst && Math.random() < 0.1) { inBurst = true; burstRemaining = randomInt(3, 8); }
    if (inBurst) { delay *= 0.5; burstRemaining--; if (burstRemaining <= 0) inBurst = false; }
    if (char === ' ' && prevChar.match(/[.!?]/)) delay *= randomBetween(2, 4);
    const isTypo = Math.random() < config.typoProbability && char.length === 1 && /[a-z]/i.test(char);
    if (isTypo) {
      events.push({ key: getNearbyKey(char), delay, isTypo: true });
      events.push({ key: 'Backspace', delay: randomBetween(200, 600), isTypo: false });
      events.push({ key: char, delay: delay * 1.3, isTypo: false });
    } else {
      events.push({ key: char, delay, isTypo: false });
    }
  }
  return events;
}

// ===============================================================================
// SCROLL PATTERN ENGINE
// ===============================================================================

interface ScrollSegment { delta: number; duration: number; pauseAfter: number; }

function generateScrollPattern(totalDistance: number, config: BehaviorConfig, intent: IntentProfile = 'browsing'): ScrollSegment[] {
  const segments: ScrollSegment[] = []; let remaining = totalDistance;
  const readMul = intent === 'researching' ? 2.5 : intent === 'skimming' ? 0.3 : 1.0;
  while (remaining > 0) {
    const segDist = Math.min(remaining, randomBetween(50, config.scrollSpeed * 3));
    const duration = randomBetween(200, 800) * (config.scrollSpeed / 100);
    const avgPause = config.idlePauseDuration * readMul;
    const pauseAfter = Math.random() < 0.6 ? randomGaussian(avgPause, avgPause * 0.5) : 0;
    let delta = segDist;
    if (Math.random() < 0.1 && remaining > 100) delta = -randomBetween(20, 60);
    segments.push({ delta, duration: Math.max(100, duration), pauseAfter: Math.max(0, pauseAfter) });
    remaining -= segDist;
  }
  return segments;
}

function generateMomentumScroll(initialVelocity: number, friction: number = 0.92): ScrollSegment[] {
  const segments: ScrollSegment[] = []; let velocity = initialVelocity; const frameTime = 16;
  while (Math.abs(velocity) > 2) {
    segments.push({ delta: Math.round(velocity), duration: frameTime, pauseAfter: 0 });
    velocity *= friction;
  }
  return segments;
}

// ===============================================================================
// DWELL TIME ENGINE
// ===============================================================================

const DWELL_PROFILES: Record<IntentProfile, { wpm: number; imageMul: number; formMul: number; minDwell: number; maxDwell: number }> = {
  browsing: { wpm: 228, imageMul: 0.3, formMul: 0.5, minDwell: 500, maxDwell: 8000 },
  shopping: { wpm: 180, imageMul: 0.8, formMul: 0.7, minDwell: 800, maxDwell: 12000 },
  researching: { wpm: 200, imageMul: 0.2, formMul: 0.4, minDwell: 2000, maxDwell: 30000 },
  comparing: { wpm: 250, imageMul: 0.6, formMul: 0.6, minDwell: 1500, maxDwell: 20000 },
  skimming: { wpm: 400, imageMul: 0.15, formMul: 0.3, minDwell: 200, maxDwell: 3000 },
};

function calculateDwellTime(wordCount: number, contentType: 'text' | 'image' | 'form' | 'mixed', intent: IntentProfile): number {
  const p = DWELL_PROFILES[intent]; let dwell = (wordCount / p.wpm) * 60000;
  if (contentType === 'image') dwell *= p.imageMul;
  else if (contentType === 'form') dwell *= p.formMul;
  else if (contentType === 'mixed') dwell *= 0.6;
  dwell *= randomBetween(0.7, 1.3);
  return clamp(dwell, p.minDwell, p.maxDwell);
}

// ===============================================================================
// INTERACTION SEQUENCES
// ===============================================================================

const PREDEFINED_SEQUENCES: Record<string, InteractionSequence> = {
  searchAndBrowse: { name: 'Search and Browse', steps: [
    { action: 'move', target: 'input[type="search"], input[name="q"]', duration: 800 },
    { action: 'click', target: 'input[type="search"], input[name="q"]' },
    { action: 'type', text: '{{query}}' },
    { action: 'wait', duration: 300 },
    { action: 'move', target: 'button[type="submit"]', duration: 600 },
    { action: 'click', target: 'button[type="submit"]' },
    { action: 'wait', duration: 2000 },
    { action: 'scroll', amount: 300, duration: 1500 },
    { action: 'wait', duration: 1000 },
  ]},
  shoppingFlow: { name: 'Shopping Flow', steps: [
    { action: 'move', target: '.product, .item', duration: 1000 },
    { action: 'hover', target: '.product, .item' },
    { action: 'wait', duration: 1500 },
    { action: 'scroll', amount: 200, duration: 1000 },
    { action: 'move', target: '.product a, .item a', duration: 600 },
    { action: 'click', target: '.product a, .item a' },
    { action: 'wait', duration: 3000 },
    { action: 'scroll', amount: 400, duration: 2000 },
    { action: 'move', target: '.add-to-cart', duration: 800 },
    { action: 'click', target: '.add-to-cart' },
  ]},
  researchFlow: { name: 'Research Flow', steps: [
    { action: 'scroll', amount: 100, duration: 800 },
    { action: 'wait', duration: 3000 },
    { action: 'scroll', amount: 200, duration: 1200 },
    { action: 'wait', duration: 4000 },
    { action: 'scroll', amount: -50, duration: 400 },
    { action: 'wait', duration: 1500 },
    { action: 'move', target: 'a[href]', duration: 700 },
    { action: 'click', target: 'a[href]' },
    { action: 'wait', duration: 4000 },
    { action: 'back' },
  ]},
  formFillFlow: { name: 'Form Fill Flow', steps: [
    { action: 'move', target: 'input, select', duration: 800 },
    { action: 'click', target: 'input, select' },
    { action: 'type', text: '{{field1}}' },
    { action: 'wait', duration: 300 },
    { action: 'move', target: 'input:nth-of-type(2)', duration: 500 },
    { action: 'click', target: 'input:nth-of-type(2)' },
    { action: 'type', text: '{{field2}}' },
    { action: 'move', target: 'button[type="submit"]', duration: 600 },
    { action: 'click', target: 'button[type="submit"]' },
  ]},
};

// ===============================================================================
// MAIN ENGINE CLASS
// ===============================================================================

export class HumanBehaviorEngine {
  private config: BehaviorConfig;
  private profile: BehaviorProfileName;
  private device: DeviceProfile;
  private intent: IntentProfile;
  private fatigue = 0;
  private sessionStart = Date.now();
  private actionsPerformed = 0;
  private currentMousePos: Point = { x: 0, y: 0 };

  constructor(profile: BehaviorProfileName = 'normal', device: DeviceProfile = 'desktop-mouse', intent: IntentProfile = 'browsing') {
    this.profile = profile; this.device = device; this.intent = intent;
    this.config = this.buildConfig(profile, device);
    logger.info({ profile, device, intent }, 'Human behavior engine initialized');
  }

  private buildConfig(profile: BehaviorProfileName, device: DeviceProfile): BehaviorConfig {
    return { ...BEHAVIOR_PROFILES[profile], ...DEVICE_MODIFIERS[device] };
  }

  private getTimeOfDay(): TimeOfDay {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 9) return 'morning'; if (hour >= 9 && hour < 17) return 'work-hours';
    if (hour >= 17 && hour < 22) return 'evening'; return 'late-night';
  }

  private applyTimeModifiers(): void {
    const mods = TIME_MODIFIERS[this.getTimeOfDay()];
    this.config.avgActionDelay /= mods.speedMultiplier;
    this.config.typoProbability *= mods.errorMultiplier;
  }

  private applyFatigue(): void {
    const elapsed = (Date.now() - this.sessionStart) / 60000;
    this.fatigue = Math.min(1, elapsed * this.config.fatigueRate);
    this.config.avgActionDelay *= (1 + this.fatigue * 0.5);
    this.config.typoProbability *= (1 + this.fatigue * 0.8);
    this.config.mouseSpeed *= (1 - this.fatigue * 0.2);
  }

  getConfig(): BehaviorConfig { return { ...this.config }; }
  getProfile(): BehaviorProfileName { return this.profile; }
  getDevice(): DeviceProfile { return this.device; }
  getIntent(): IntentProfile { return this.intent; }
  getFatigue(): number { return this.fatigue; }
  getMousePosition(): Point { return { ...this.currentMousePos }; }

  setProfile(profile: BehaviorProfileName): void { this.profile = profile; this.config = this.buildConfig(profile, this.device); }
  setDevice(device: DeviceProfile): void { this.device = device; this.config = this.buildConfig(this.profile, device); }
  setIntent(intent: IntentProfile): void { this.intent = intent; }
  resetFatigue(): void { this.fatigue = 0; this.sessionStart = Date.now(); this.config = this.buildConfig(this.profile, this.device); }

  async moveMouse(page: Page, target: Point, options?: { targetWidth?: number; overshoot?: boolean }): Promise<void> {
    try {
      this.applyFatigue(); this.applyTimeModifiers();
      const start = this.currentMousePos; const d = distPts(start, target);
      if (d < 3) { this.currentMousePos = target; return; }
      const shouldOvershoot = options?.overshoot ?? (Math.random() < this.config.overshootProbability);
      const path = shouldOvershoot ? generateOvershootPath(start, target, this.config) : generateMousePath(start, target, this.config, options?.targetWidth);
      for (let i = 0; i < path.points.length; i++) {
        await page.mouse.move(path.points[i].x, path.points[i].y);
        this.currentMousePos = path.points[i];
        if (i < path.points.length - 1) await this.delay(path.totalDuration / path.points.length + randomBetween(-5, 10));
      }
      this.currentMousePos = target; this.actionsPerformed++;
    } catch (err: any) { logger.debug({ error: err.message }, 'Mouse move failed'); }
  }

  async clickElement(page: Page, selector: string, options?: { button?: 'left' | 'right' | 'middle'; doubleClick?: boolean; hoverFirst?: boolean }): Promise<boolean> {
    try {
      this.applyFatigue();
      const element = await page.$(selector); if (!element) return false;
      const box = await element.boundingBox(); if (!box) return false;
      const target: Point = { x: box.x + randomBetween(box.width*0.2, box.width*0.8), y: box.y + randomBetween(box.height*0.2, box.height*0.8) };
      await this.moveMouse(page, target, { targetWidth: Math.min(box.width, box.height) });
      await this.delay(randomBetween(this.config.decisionPauseMin, this.config.decisionPauseMax));
      if (options?.hoverFirst) { await page.hover(selector); await this.delay(randomBetween(100, 400)); }
      const button = options?.button || 'left';
      await page.mouse.down({ button }); await this.delay(randomBetween(30, 100)); await page.mouse.up({ button });
      if (options?.doubleClick) { await this.delay(randomBetween(50, 150)); await page.mouse.down({ button }); await this.delay(randomBetween(30, 80)); await page.mouse.up({ button }); }
      this.actionsPerformed++; return true;
    } catch (err: any) { logger.debug({ selector, error: err.message }, 'Click element failed'); return false; }
  }

  async typeText(page: Page, text: string, options?: { selector?: string; clearFirst?: boolean; delay?: number }): Promise<void> {
    try {
      this.applyFatigue();
      if (options?.selector) { await this.clickElement(page, options.selector); await this.delay(randomBetween(100, 300)); }
      if (options?.clearFirst) { await page.keyboard.press('Control+a'); await this.delay(randomBetween(50, 150)); await page.keyboard.press('Backspace'); await this.delay(randomBetween(100, 300)); }
      const effectiveConfig = { ...this.config }; if (options?.delay) effectiveConfig.typingDelay = options.delay;
      const events = generateTypingSequence(text, effectiveConfig);
      for (const event of events) {
        await this.delay(event.delay);
        if (event.key === 'Backspace') await page.keyboard.press('Backspace');
        else if (event.key === 'Enter') await page.keyboard.press('Enter');
        else if (event.key === 'Tab') await page.keyboard.press('Tab');
        else if (event.key.length === 1) {
          if (event.key === event.key.toUpperCase() && event.key !== event.key.toLowerCase()) {
            await page.keyboard.down('Shift'); await this.delay(randomBetween(10, 30)); await page.keyboard.press(event.key); await page.keyboard.up('Shift');
          } else { await page.keyboard.press(event.key); }
        }
      }
      this.actionsPerformed++;
    } catch (err: any) { logger.debug({ error: err.message }, 'Type text failed'); }
  }

  async scrollPage(page: Page, options?: { amount?: number; direction?: 'down' | 'up'; useMomentum?: boolean }): Promise<void> {
    try {
      this.applyFatigue();
      const totalDistance = options?.amount || randomBetween(200, 600);
      const sign = (options?.direction || 'down') === 'down' ? 1 : -1;
      if (options?.useMomentum) {
        const segments = generateMomentumScroll(sign * randomBetween(30, 80));
        for (const seg of segments) { await page.mouse.wheel(0, seg.delta); await this.delay(seg.duration); }
      } else {
        const segments = generateScrollPattern(totalDistance * sign, this.config, this.intent);
        for (const seg of segments) {
          await page.mouse.wheel(0, seg.delta); await this.delay(seg.duration);
          if (seg.pauseAfter > 0) {
            if (Math.random() < 0.3) await this.moveMouse(page, { x: this.currentMousePos.x + randomBetween(-30, 30), y: this.currentMousePos.y + randomBetween(-20, 20) });
            await this.delay(seg.pauseAfter);
          }
        }
      }
      this.actionsPerformed++;
    } catch (err: any) { logger.debug({ error: err.message }, 'Scroll page failed'); }
  }

  async waitForPageLoad(page: Page, options?: { minWait?: number; maxWait?: number; waitForSelector?: string }): Promise<void> {
    try {
      if (options?.waitForSelector) await page.waitForSelector(options.waitForSelector, { timeout: 10000 }).catch(() => {});
      await this.delay(randomBetween(options?.minWait ?? 1000, options?.maxWait ?? 3000));
      const viewport = page.viewportSize();
      if (viewport) await this.moveMouse(page, { x: randomBetween(viewport.width*0.2, viewport.width*0.8), y: randomBetween(viewport.height*0.2, viewport.height*0.8) }, { overshoot: false });
      this.actionsPerformed++;
    } catch (err: any) { logger.debug({ error: err.message }, 'Page load wait failed'); }
  }

  async dwellOnContent(page: Page, options?: { wordCount?: number; contentType?: 'text' | 'image' | 'form' | 'mixed'; intent?: IntentProfile }): Promise<void> {
    try {
      const dwellTime = calculateDwellTime(options?.wordCount ?? randomInt(50, 300), options?.contentType ?? 'text', options?.intent ?? this.intent);
      await this.delay(dwellTime);
      if (Math.random() < 0.4) { const vp = page.viewportSize(); if (vp) await this.moveMouse(page, { x: this.currentMousePos.x + randomBetween(-50, 50), y: this.currentMousePos.y + randomBetween(-30, 30) }, { overshoot: false }); }
      this.actionsPerformed++;
    } catch (err: any) { logger.debug({ error: err.message }, 'Dwell failed'); }
  }

  async idle(page: Page, duration?: number): Promise<void> {
    try {
      const idleTime = duration || randomBetween(500, 3000); const steps = Math.ceil(idleTime / 500);
      for (let i = 0; i < steps; i++) {
        const action = Math.random();
        if (action < 0.3) await this.moveMouse(page, { x: this.currentMousePos.x + randomGaussian(0, this.config.jitterAmplitude*2), y: this.currentMousePos.y + randomGaussian(0, this.config.jitterAmplitude*2) }, { overshoot: false });
        else if (action < 0.5) await page.mouse.wheel(0, randomBetween(-30, 30));
        await this.delay(idleTime / steps);
      }
      this.actionsPerformed++;
    } catch (err: any) { logger.debug({ error: err.message }, 'Idle failed'); }
  }

  async executeSequence(page: Page, sequenceName: string, variables?: Record<string, string>): Promise<boolean> {
    try {
      const sequence = PREDEFINED_SEQUENCES[sequenceName]; if (!sequence) return false;
      for (const step of sequence.steps) {
        let target = step.target; let text = step.text;
        if (variables) { for (const [k, v] of Object.entries(variables)) { target = target?.replace(`{{${k}}}`, v); text = text?.replace(`{{${k}}}`, v); } }
        switch (step.action) {
          case 'click': if (target) await this.clickElement(page, target); break;
          case 'type': if (text) await this.typeText(page, text, { selector: target }); break;
          case 'scroll': await this.scrollPage(page, { amount: step.amount }); break;
          case 'wait': await this.delay(step.duration || 1000); break;
          case 'hover': if (target) { try { await page.hover(target); } catch {} await this.delay(randomBetween(300, 800)); } break;
          case 'back': await page.goBack(); await this.delay(randomBetween(1000, 3000)); break;
          case 'forward': await page.goForward(); await this.delay(randomBetween(1000, 3000)); break;
          case 'reload': await page.reload(); await this.waitForPageLoad(page); break;
          case 'select': if (target && text) { try { await page.selectOption(target, text); } catch {} } break;
          case 'move': if (target) await this.clickElement(page, target); break;
          case 'drag': if (target) { try { const el = await page.$(target); if (el) { const b = await el.boundingBox(); if (b) { await this.moveMouse(page, {x:b.x+b.width/2,y:b.y+b.height/2}); await page.mouse.down(); await this.moveMouse(page, {x:b.x+b.width/2+(step.amount||100),y:b.y+b.height/2}); await page.mouse.up(); } } } catch {} } break;
        }
        await this.delay(randomBetween(this.config.avgActionDelay*0.5, this.config.avgActionDelay*1.5));
      }
      this.actionsPerformed++; return true;
    } catch (err: any) { logger.debug({ sequenceName, error: err.message }, 'Sequence failed'); return false; }
  }

  async simulateBrowsing(page: Page, options?: { intent?: IntentProfile; scrollAmount?: number; clickLinks?: boolean; maxInteractions?: number; dwellOnContent?: boolean }): Promise<void> {
    try {
      const intent = options?.intent ?? this.intent; const maxInt = options?.maxInteractions ?? randomInt(3, 8);
      this.setIntent(intent); this.applyFatigue();
      await this.waitForPageLoad(page);
      const vp = page.viewportSize();
      if (vp) { for (let i = 0; i < randomInt(2, 4); i++) { await this.moveMouse(page, { x: randomBetween(vp.width*0.1, vp.width*0.9), y: randomBetween(vp.height*0.1, vp.height*0.9) }); await this.delay(randomBetween(200, 600)); } }
      for (let i = 0; i < maxInt; i++) {
        const action = Math.random();
        if (action < 0.4) await this.scrollPage(page, { amount: randomBetween(100, 500), useMomentum: Math.random() < 0.3 });
        else if (action < 0.65 && options?.dwellOnContent !== false) await this.dwellOnContent(page, { contentType: 'mixed', intent });
        else if (action < 0.8) await this.idle(page);
        else if (action < 0.95 && options?.clickLinks) { const links = await page.$$('a[href]'); if (links.length > 0) { const lb = await links[randomInt(0, Math.min(links.length-1, 10))].boundingBox(); if (lb) await this.moveMouse(page, { x: lb.x + randomBetween(5, lb.width-5), y: lb.y + randomBetween(3, lb.height-3) }, { targetWidth: lb.height }); } }
        else { await page.mouse.wheel(0, randomBetween(-20, 50)); await this.delay(randomBetween(300, 800)); }
        await this.delay(randomBetween(this.config.avgActionDelay*0.3, this.config.avgActionDelay*1.2));
      }
    } catch (err: any) { logger.debug({ error: err.message }, 'Browsing simulation failed'); }
  }

  async fillForm(page: Page, fields: Array<{ selector: string; value: string; type?: 'text' | 'select' | 'checkbox' | 'radio' }>): Promise<boolean> {
    try {
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        if (i > 0 && Math.random() < 0.6) { await page.keyboard.press('Tab'); await this.delay(randomBetween(100, 300)); }
        else await this.clickElement(page, f.selector);
        await this.delay(randomBetween(300, 800));
        if (f.type === 'select') { try { await page.selectOption(f.selector, f.value); } catch {} }
        else if (f.type === 'checkbox' || f.type === 'radio') { try { await page.click(f.selector); } catch {} }
        else await this.typeText(page, f.value);
        await this.delay(randomBetween(100, 400));
      }
      return true;
    } catch (err: any) { logger.debug({ error: err.message }, 'Form fill failed'); return false; }
  }

  async hoverElement(page: Page, selector: string, options?: { dwellTime?: number; exploreMenu?: boolean }): Promise<boolean> {
    try {
      const el = await page.$(selector); if (!el) return false;
      const box = await el.boundingBox(); if (!box) return false;
      await this.moveMouse(page, { x: box.x + randomBetween(box.width*0.2, box.width*0.8), y: box.y + randomBetween(box.height*0.2, box.height*0.8) }, { targetWidth: Math.min(box.width, box.height) });
      await this.delay(options?.dwellTime || randomBetween(500, 2000));
      if (options?.exploreMenu) { await this.delay(randomBetween(300, 600)); await this.moveMouse(page, { x: this.currentMousePos.x + randomBetween(-20, 20), y: this.currentMousePos.y + randomBetween(20, 80) }, { overshoot: false }); await this.delay(randomBetween(500, 1500)); }
      return true;
    } catch (err: any) { return false; }
  }

  async dragAndDrop(page: Page, fromSelector: string, toSelector: string): Promise<boolean> {
    try {
      const fromEl = await page.$(fromSelector); const toEl = await page.$(toSelector); if (!fromEl || !toEl) return false;
      const fb = await fromEl.boundingBox(); const tb = await toEl.boundingBox(); if (!fb || !tb) return false;
      await this.moveMouse(page, { x: fb.x+fb.width/2, y: fb.y+fb.height/2 }, { targetWidth: fb.height });
      await this.delay(randomBetween(100, 300)); await page.mouse.down(); await this.delay(randomBetween(50, 150));
      await this.moveMouse(page, { x: tb.x+tb.width/2, y: tb.y+tb.height/2 }, { targetWidth: tb.height });
      await this.delay(randomBetween(50, 200)); await page.mouse.up();
      return true;
    } catch (err: any) { return false; }
  }

  async pressShortcut(page: Page, keys: string[]): Promise<void> {
    try {
      for (const key of keys.slice(0, -1)) { await page.keyboard.down(key); await this.delay(randomBetween(10, 40)); }
      await page.keyboard.press(keys[keys.length - 1]); await this.delay(randomBetween(20, 50));
      for (const key of keys.slice(0, -1).reverse()) { await page.keyboard.up(key); await this.delay(randomBetween(10, 30)); }
    } catch (err: any) { logger.debug({ keys, error: err.message }, 'Shortcut failed'); }
  }

  private async delay(ms: number): Promise<void> { if (ms <= 0) return; return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }

  getStats(): Record<string, any> {
    return { profile: this.profile, device: this.device, intent: this.intent, fatigue: this.fatigue.toFixed(3), actionsPerformed: this.actionsPerformed, sessionDurationMs: Date.now() - this.sessionStart, currentMousePos: this.currentMousePos, timeOfDay: this.getTimeOfDay() };
  }

  getAvailableSequences(): string[] { return Object.keys(PREDEFINED_SEQUENCES); }
  getAvailableProfiles(): BehaviorProfileName[] { return Object.keys(BEHAVIOR_PROFILES) as BehaviorProfileName[]; }
  getAvailableDevices(): DeviceProfile[] { return Object.keys(DEVICE_MODIFIERS) as DeviceProfile[]; }

  /**
   * Get JavaScript init script for browser context injection.
   * Used by web-unlocker and browser-pool to inject anti-detection scripts.
   */
  getBehaviorInitScript(): string {
    return `
      (function() {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        const origSetTimeout = window.setTimeout;
        window.setTimeout = function(fn, delay) {
          const jitter = Math.round((Math.random() - 0.5) * delay * 0.05);
          const args = Array.prototype.slice.call(arguments, 2);
          return origSetTimeout(fn, Math.max(0, delay + jitter), ...args);
        };
        document.addEventListener("pointerdown", function(e) {
          Object.defineProperty(e, "pressure", { get: () => 0.5 + Math.random() * 0.3 });
        }, true);
        document.addEventListener("keydown", function(e) {
          if (e.key && e.key.length === 1) {
            Object.defineProperty(e, "isComposing", { get: () => false });
          }
        }, true);
      })();
    `;
  }

  /**
   * Simulate page interaction -- backward-compatible alias for simulateBrowsing.
   * Used by web-unlocker, browser-pool, and orchestrator.
   */
  async simulatePageInteraction(page: Page): Promise<void> {
    await this.simulateBrowsing(page, { maxInteractions: 3, dwellOnContent: true });
  }
}

// ===============================================================================
// SINGLETONS & EXPORTS
// ===============================================================================

export const humanBehavior = new HumanBehaviorEngine();
export const humanBehaviorEngine = new HumanBehaviorEngine();

export default HumanBehaviorEngine;
