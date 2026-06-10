/**
 * Scroll Behavior Engine -- ScrapeSuite Engine
 *
 * Generates human-like scroll behavior parameters.
 */

import { createChildLogger } from '../utils/logger';
import type { ScrollConfig } from './types';
const logger = createChildLogger('scroll-behavior');

interface BehaviorProfile { baseScrollAmount: number; scrollVariance: number; baseWaitMs: number; waitVariance: number; readingPauseChance: number; scrollUpChance: number; maxUpScroll: number; }

const PROFILES: Record<string, BehaviorProfile> = {
  fast: { baseScrollAmount: 800, scrollVariance: 200, baseWaitMs: 400, waitVariance: 200, readingPauseChance: 0, scrollUpChance: 0, maxUpScroll: 0 },
  normal: { baseScrollAmount: 500, scrollVariance: 150, baseWaitMs: 1200, waitVariance: 600, readingPauseChance: 0.15, scrollUpChance: 0.08, maxUpScroll: 200 },
  careful: { baseScrollAmount: 300, scrollVariance: 80, baseWaitMs: 2500, waitVariance: 1000, readingPauseChance: 0.3, scrollUpChance: 0.12, maxUpScroll: 150 },
  researcher: { baseScrollAmount: 200, scrollVariance: 60, baseWaitMs: 4000, waitVariance: 2000, readingPauseChance: 0.45, scrollUpChance: 0.2, maxUpScroll: 180 },
};

export function getBehaviorProfile(profile: string): BehaviorProfile { return PROFILES[profile] || PROFILES.normal; }

export function generateScrollAmount(config: ScrollConfig): number {
  const strategy = config.strategy || 'human-like';
  if (strategy === 'jump') return 99999;
  if (strategy === 'smooth') return applyJitter(config.scrollAmount || 400, config.scrollJitterPercent || 5);
  const profile = getBehaviorProfile(config.behaviorProfile || 'normal');
  const base = config.scrollAmount || profile.baseScrollAmount;
  return Math.max(50, Math.round(applyJitter(base + (Math.random() * 2 - 1) * profile.scrollVariance, config.scrollJitterPercent || 20)));
}

export function generateWaitTime(config: ScrollConfig): number {
  const strategy = config.strategy || 'human-like';
  if (strategy === 'jump') return config.waitBetweenScrolls || 1000;
  const profile = getBehaviorProfile(config.behaviorProfile || 'normal');
  let wait = Math.max(100, Math.round((config.waitBetweenScrolls || profile.baseWaitMs) + (Math.random() * 2 - 1) * profile.waitVariance));
  if (config.readingPauses !== false) {
    const chance = config.readingPauseProbability ?? profile.readingPauseChance;
    if (Math.random() < chance) wait += Math.round((config.minReadingPauseMs || 1500) + Math.random() * ((config.maxReadingPauseMs || 5000) - (config.minReadingPauseMs || 1500)));
  }
  return wait;
}

export function shouldScrollUp(config: ScrollConfig): boolean {
  if (config.occasionalScrollUp === false || (config.strategy || 'human-like') !== 'human-like') return false;
  return Math.random() < (config.scrollUpProbability ?? getBehaviorProfile(config.behaviorProfile || 'normal').scrollUpChance);
}

export function generateUpScrollAmount(config: ScrollConfig): number { return Math.round(Math.random() * (config.maxUpScrollPixels || getBehaviorProfile(config.behaviorProfile || 'normal').maxUpScroll)); }

export function applyJitter(value: number, jitterPercent: number): number { return Math.round(value + value * (jitterPercent / 100) * (Math.random() * 2 - 1)); }

export function generateBezierScrollPoints(startY: number, endY: number, steps: number): number[] {
  if (steps <= 0) return [endY];
  const points: number[] = [], delta = endY - startY, offset = delta * 0.1 * (Math.random() * 2 - 1);
  for (let i = 1; i <= steps; i++) { const t = i / steps; points.push(Math.round((1 - t) * (1 - t) * startY + 2 * (1 - t) * t * (startY + delta * 0.5 + offset) + t * t * endY)); }
  return points;
}
