/**
 * TikTok Feed Simulator -- ScrapeSuite Engine
 *
 * Simulates realistic TikTok browsing behavior to maintain session validity
 * and avoid detection. Generates human-like For You Page (FYP) browsing
 * patterns with realistic watch times, scroll behaviors, and interactions.
 */

import { createChildLogger } from '../../utils/logger';
import type {
  FeedSimulationConfig,
  FeedSimulationResult,
  FeedSection,
} from './types';

const logger = createChildLogger('tiktok-feed-simulator');

// ===============================================================================
// DEFAULT FEED SIMULATION CONFIG
// ===============================================================================

const DEFAULT_FEED_CONFIG: FeedSimulationConfig = {
  sections: ['fyp', 'discover', 'search'],
  videosPerSection: 5,
  watchTimeRange: { min: 5, max: 30 },
  simulateScrolling: true,
  simulateInteractions: true,
  interactionProbability: 0.15,
  simulateSearch: true,
  searchQueries: ['funny cats', 'cooking recipes', 'travel', 'music', 'fitness'],
};

// ===============================================================================
// FEED SIMULATOR ENGINE
// ===============================================================================

export class FeedSimulatorEngine {
  private config: FeedSimulationConfig;
  private stats = {
    totalSimulations: 0,
    totalVideosWatched: 0,
    totalInteractions: 0,
    totalTokensRefreshed: 0,
    detections: 0,
  };

  constructor(config?: Partial<FeedSimulationConfig>) {
    this.config = { ...DEFAULT_FEED_CONFIG, ...config };
  }

  /**
   * Generate a simulated feed browsing session.
   * Returns interaction data that can be used to drive Playwright automation.
   */
  generateSession(): FeedSimulationResult {
    const result: FeedSimulationResult = {
      sectionsSimulated: [],
      totalVideosWatched: 0,
      totalTimeMs: 0,
      interactions: [],
      tokensRefreshed: 0,
      undetected: true,
    };

    const startTime = Date.now();

    for (const section of this.config.sections) {
      result.sectionsSimulated.push(section);

      // Simulate browsing this section
      const videosInSection = this.config.videosPerSection + Math.floor(Math.random() * 3);

      for (let i = 0; i < videosInSection; i++) {
        const videoId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Simulate watch time (weighted toward shorter times)
        const watchTimeSeconds = this.weightedWatchTime();
        result.totalVideosWatched++;

        // Add scroll interaction
        if (this.config.simulateScrolling) {
          result.interactions.push({
            type: 'scroll',
            videoId,
            timestamp: Date.now(),
          });
        }

        // Simulate pause (reading comments)
        if (Math.random() < 0.2) {
          result.interactions.push({
            type: 'pause',
            videoId,
            timestamp: Date.now(),
          });
        }

        // Simulate interaction (like, share, etc.)
        if (this.config.simulateInteractions && Math.random() < this.config.interactionProbability) {
          const interactionTypes: Array<'like' | 'share' | 'follow' | 'comment'> = ['like', 'share', 'follow', 'comment'];
          const weights = [0.6, 0.2, 0.15, 0.05]; // Likes most common
          const interaction = this.weightedRandom(interactionTypes, weights);

          result.interactions.push({
            type: interaction,
            videoId,
            timestamp: Date.now(),
          });
        }

        // Add watch time
        result.totalTimeMs += watchTimeSeconds * 1000;
      }

      // Section transition delay
      result.totalTimeMs += this.randomBetween(1000, 3000);
    }

    // Simulate search if configured
    if (this.config.simulateSearch && this.config.searchQueries.length > 0) {
      const query = this.config.searchQueries[Math.floor(Math.random() * this.config.searchQueries.length)];
      result.interactions.push({
        type: 'scroll', // search interaction
        timestamp: Date.now(),
      });
      result.totalTimeMs += this.randomBetween(3000, 8000);
    }

    this.stats.totalSimulations++;
    this.stats.totalVideosWatched += result.totalVideosWatched;
    this.stats.totalInteractions += result.interactions.length;

    return result;
  }

  /**
   * Generate a Playwright-compatible interaction sequence for a feed simulation.
   */
  generatePlaywrightSequence(): Array<{
    action: 'scroll' | 'click' | 'wait' | 'type' | 'hover';
    selector?: string;
    value?: string;
    durationMs: number;
  }> {
    const sequence: Array<{
      action: 'scroll' | 'click' | 'wait' | 'type' | 'hover';
      selector?: string;
      value?: string;
      durationMs: number;
    }> = [];

    // Initial page load
    sequence.push({ action: 'wait', durationMs: this.randomBetween(2000, 4000) });

    for (const section of this.config.sections) {
      // Navigate to section
      if (section === 'fyp') {
        sequence.push({ action: 'wait', durationMs: this.randomBetween(1000, 3000) });
      } else if (section === 'search') {
        sequence.push({ action: 'click', selector: '[data-e2e="search-icon"]', durationMs: this.randomBetween(300, 800) });
        sequence.push({ action: 'wait', durationMs: this.randomBetween(500, 1500) });
        const query = this.config.searchQueries[Math.floor(Math.random() * this.config.searchQueries.length)];
        sequence.push({ action: 'type', selector: 'input[type="search"]', value: query, durationMs: this.randomBetween(1000, 3000) });
        sequence.push({ action: 'wait', durationMs: this.randomBetween(2000, 4000) });
      }

      // Watch videos in this section
      for (let i = 0; i < this.config.videosPerSection; i++) {
        // Watch time
        const watchTime = this.weightedWatchTime() * 1000;
        sequence.push({ action: 'wait', durationMs: watchTime });

        // Scroll to next video
        sequence.push({ action: 'scroll', durationMs: this.randomBetween(200, 600) });

        // Random interaction
        if (Math.random() < this.config.interactionProbability) {
          const interactionType = Math.random();
          if (interactionType < 0.6) {
            // Like
            sequence.push({ action: 'click', selector: '[data-e2e="like-icon"]', durationMs: this.randomBetween(100, 300) });
          } else if (interactionType < 0.8) {
            // Hover to see more
            sequence.push({ action: 'hover', selector: '[data-e2e="user-post-item"]', durationMs: this.randomBetween(500, 2000) });
          }
        }

        // Random pause (simulating reading comments)
        if (Math.random() < 0.15) {
          sequence.push({ action: 'wait', durationMs: this.randomBetween(2000, 5000) });
        }
      }
    }

    return sequence;
  }

  // --- Private helpers ---

  private weightedWatchTime(): number {
    // Most videos get short watch times, some get longer
    const rand = Math.random();
    if (rand < 0.3) return this.randomBetween(this.config.watchTimeRange.min, 8); // Quick scroll
    if (rand < 0.7) return this.randomBetween(8, 15); // Partial watch
    if (rand < 0.9) return this.randomBetween(15, this.config.watchTimeRange.max); // Full watch
    return this.randomBetween(this.config.watchTimeRange.max, this.config.watchTimeRange.max * 2); // Rewatch
  }

  private weightedRandom<T>(items: T[], weights: number[]): T {
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;
    for (let i = 0; i < items.length; i++) {
      random -= weights[i];
      if (random <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Get simulator statistics.
   */
  getStats(): Record<string, unknown> {
    return { ...this.stats };
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const feedSimulator = new FeedSimulatorEngine();
