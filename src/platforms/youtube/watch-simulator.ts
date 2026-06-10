/**
 * Watch Simulator — ScrapeSuite Engine
 *
 * Simulates realistic YouTube video watching behavior to maintain
 * session validity and avoid bot detection. YouTube validates watch
 * sessions by tracking:
 *   - Playhead positions reported at regular intervals
 *   - Playback statistics (quality, buffering, frame drops)
 *   - User interactions (pause, seek, quality changes, volume)
 *   - Watch duration relative to video length
 *   - Canonical playback nonce (cpn) per watch session
 *   - Playback rate and fullscreen state
 *
 * Realistic watch simulation is critical because YouTube's backend
 * cross-references reported watch data against expected patterns.
 * Bots that report impossible or unlikely watch patterns (e.g.
 * constant playhead advancement, zero interactions, perfect streaming)
 * are flagged and potentially blocked.
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type {
  WatchSimulationConfig,
  WatchSimulationResult,
  WatchInteraction,
  PlayheadPosition,
  PlaybackStats,
} from './types';

const logger = createChildLogger('youtube-watch-simulator');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Default watch simulation configuration */
const DEFAULT_WATCH_CONFIG: Omit<WatchSimulationConfig, 'videoDuration'> = {
  minWatchPercentage: 0.2,
  maxWatchPercentage: 1.0,
  preferredQuality: '720p',
  simulateQualityChanges: true,
  qualityChangeCount: 2,
  simulatePauses: true,
  pauseCount: 1,
  simulateSeeks: true,
  seekCount: 2,
  simulateVolumeChanges: true,
  simulateFullscreenToggle: false,
  simulateHoverEvents: true,
  initialVolume: 75,
};

/** Available video quality levels in ascending order */
const QUALITY_LEVELS = [
  '144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p',
];

/** Playhead report interval in seconds (YouTube reports ~every 1-5 seconds) */
const PLAYHEAD_REPORT_INTERVAL_SECONDS = 2;

/** Maximum playhead jitter in seconds (simulates network micro-buffering) */
const MAX_PLAYHEAD_JITTER_SECONDS = 0.5;

/** Character set for generating canonical playback nonce (cpn) */
const CPN_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// ===============================================================================
// HELPER FUNCTIONS
// ===============================================================================

/**
 * Generate a random alphanumeric string of given length.
 */
function randomString(length: number, charset: string = CPN_CHARSET): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[Math.floor(Math.random() * charset.length)];
  }
  return result;
}

/**
 * Generate a random number between min and max (inclusive).
 */
function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Generate a random integer between min and max (inclusive).
 */
function randomIntBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Weighted random selection — most users watch 40-80% of a video.
 * Returns a watch percentage between 0 and 1.
 */
function weightedWatchPercentage(min: number, max: number): number {
  const r = Math.random();
  let percentage: number;

  if (r < 0.1) {
    // 10%: Quick bounce (5-15% of video)
    percentage = randomBetween(0.05, 0.15);
  } else if (r < 0.3) {
    // 20%: Short watch (15-40% of video)
    percentage = randomBetween(0.15, 0.40);
  } else if (r < 0.7) {
    // 40%: Moderate watch (40-80% of video)
    percentage = randomBetween(0.40, 0.80);
  } else if (r < 0.9) {
    // 20%: Long watch (80-95% of video)
    percentage = randomBetween(0.80, 0.95);
  } else {
    // 10%: Full watch (95-100% of video)
    percentage = randomBetween(0.95, 1.0);
  }

  return Math.min(max, Math.max(min, percentage));
}

/**
 * Get the index of a quality level in the QUALITY_LEVELS array.
 */
function qualityIndex(quality: string): number {
  const idx = QUALITY_LEVELS.indexOf(quality);
  return idx >= 0 ? idx : 4; // Default to 720p
}

// ===============================================================================
// WATCH SIMULATOR CLASS
// ===============================================================================

export class WatchSimulator {
  private stats = {
    totalSimulations: 0,
    totalWatchTimeSeconds: 0,
    totalInteractions: 0,
    averageWatchPercentage: 0,
    averageDurationMs: 0,
  };

  constructor() {
    logger.info('YouTube watch simulator initialized');
  }

  // ---------------------------------------------------------------------------
  // SESSION GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate a complete watch session with realistic timing and interactions.
   *
   * Produces a full simulation of a human watching a YouTube video,
   * including playhead positions, interaction events, and playback stats.
   * The simulation accounts for:
   *   - Variable watch duration (most users don't watch 100%)
   *   - Quality adaptation (starting lower, ramping up)
   *   - Periodic pauses (reading comments, checking description)
   *   - Seek events (rewinding, skipping ahead)
   *   - Volume adjustments
   *   - Mouse hover/click events
   *
   * @param config - Watch simulation configuration
   * @returns Complete watch simulation result
   */
  generateWatchSession(config: WatchSimulationConfig): WatchSimulationResult {
    const startTime = Date.now();
    const videoId = `vid_${randomString(11)}`;

    // Determine watch duration based on weighted percentage
    const watchPercentage = weightedWatchPercentage(
      config.minWatchPercentage,
      config.maxWatchPercentage,
    );
    const totalWatchDuration = config.videoDuration * watchPercentage;

    // Generate playhead positions
    const playheadPositions = this.generatePlayheadPositions(config, totalWatchDuration);

    // Generate interactions
    const interactions = this.generateInteractionSequence(config, totalWatchDuration);

    // Generate playback stats
    const playbackStats = this.generatePlaybackStats(config, videoId, totalWatchDuration);

    const endTime = startTime + Math.round(totalWatchDuration * 1000);

    // Determine if the session appears human-like
    // A human session should have: some variance in playhead, at least 1 interaction,
    // watch duration between 20-100%, and reasonable quality changes
    const appearsHuman =
      playheadPositions.length > 5 &&
      interactions.length > 0 &&
      watchPercentage >= 0.2 &&
      watchPercentage <= 1.0;

    // Update stats
    this.stats.totalSimulations++;
    this.stats.totalWatchTimeSeconds += totalWatchDuration;
    this.stats.totalInteractions += interactions.length;
    this.stats.averageWatchPercentage =
      (this.stats.averageWatchPercentage * (this.stats.totalSimulations - 1) + watchPercentage) /
      this.stats.totalSimulations;
    this.stats.averageDurationMs =
      (this.stats.averageDurationMs * (this.stats.totalSimulations - 1) + totalWatchDuration * 1000) /
      this.stats.totalSimulations;

    const result: WatchSimulationResult = {
      videoId,
      totalWatchDuration: Math.round(totalWatchDuration * 100) / 100,
      watchPercentage: Math.round(watchPercentage * 1000) / 1000,
      playheadPositions,
      playbackStats,
      interactions,
      startedAt: startTime,
      endedAt: endTime,
      appearsHuman,
    };

    logger.debug({
      videoId,
      watchPercentage: (watchPercentage * 100).toFixed(1) + '%',
      totalWatchDuration: totalWatchDuration.toFixed(1) + 's',
      interactions: interactions.length,
      appearsHuman,
    }, 'Watch session generated');

    return result;
  }

  // ---------------------------------------------------------------------------
  // PLAYHEAD POSITION GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate realistic playhead positions for a watch session.
   *
   * YouTube clients report playhead positions at regular intervals
   * (typically every 1-5 seconds). Real playhead positions include:
   *   - Slight jitter from network buffering
   *   - Pauses that halt playhead advancement
   *   - Seek events that jump the playhead
   *   - Quality transitions that may cause brief buffering
   *
   * @param duration - Total watch duration in seconds
   * @returns Array of playhead position reports
   */
  generatePlayheadPositions(
    config: WatchSimulationConfig,
    duration: number,
  ): PlayheadPosition[] {
    const positions: PlayheadPosition[] = [];
    const startTime = Date.now();
    let currentTime = 0;
    let isPaused = false;
    let pauseEndTime = 0;
    let currentQuality = this.getStartingQuality(config.preferredQuality);

    // Build a timeline of events that affect playhead
    const pauseEvents = this.generateEventTimes(
      config.simulatePauses ? config.pauseCount : 0,
      duration,
    );
    const seekEvents = this.generateEventTimes(
      config.simulateSeeks ? config.seekCount : 0,
      duration,
    );
    const qualityEvents = this.generateEventTimes(
      config.simulateQualityChanges ? config.qualityChangeCount : 0,
      duration,
    );

    // Track which pauses and seeks have been applied
    const appliedPauses = new Set<number>();
    const appliedSeeks = new Set<number>();
    const appliedQualityChanges = new Set<number>();

    while (currentTime < duration) {
      const reportTime = startTime + Math.round(currentTime * 1000);

      // Check for pause events
      for (const pauseStart of pauseEvents) {
        if (!appliedPauses.has(pauseStart) && currentTime >= pauseStart) {
          appliedPauses.add(pauseStart);
          isPaused = true;
          pauseEndTime = pauseStart + randomBetween(2, 8); // Pause for 2-8 seconds
        }
      }

      // Check if pause should end
      if (isPaused && currentTime >= pauseEndTime) {
        isPaused = false;
      }

      // Check for seek events
      for (const seekTime of seekEvents) {
        if (!appliedSeeks.has(seekTime) && currentTime >= seekTime) {
          appliedSeeks.add(seekTime);
          // Seek backward (more common) or forward
          const seekDirection = Math.random() < 0.6 ? -1 : 1;
          const seekAmount = randomBetween(5, Math.min(30, duration * 0.2));
          currentTime = Math.max(0, Math.min(duration, currentTime + seekDirection * seekAmount));
        }
      }

      // Check for quality change events
      for (const qualityTime of qualityEvents) {
        if (!appliedQualityChanges.has(qualityTime) && currentTime >= qualityTime) {
          appliedQualityChanges.add(qualityTime);
          currentQuality = this.getNextQuality(currentQuality);
        }
      }

      // Add jitter to playhead (simulates micro-buffering)
      const jitter = isPaused ? 0 : (Math.random() - 0.5) * MAX_PLAYHEAD_JITTER_SECONDS;
      const reportedTime = Math.max(0, Math.min(duration, currentTime + jitter));

      positions.push({
        currentTime: Math.round(reportedTime * 1000) / 1000,
        reportedAt: reportTime,
        state: isPaused ? 'paused' : (jitter > 0.3 ? 'buffering' : 'playing'),
        quality: currentQuality,
      });

      // Advance time
      if (!isPaused) {
        currentTime += PLAYHEAD_REPORT_INTERVAL_SECONDS;
      } else {
        currentTime += 0.5; // Slow advancement during pause
      }
    }

    // Add final position
    positions.push({
      currentTime: duration,
      reportedAt: startTime + Math.round(duration * 1000),
      state: 'ended',
      quality: currentQuality,
    });

    return positions;
  }

  // ---------------------------------------------------------------------------
  // PLAYBACK STATS GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate realistic playback statistics for YouTube reporting.
   *
   * These stats mirror what a real YouTube client would report to
   * YouTube's playback statistics endpoint. They include quality,
   * buffering count, frame drops, playback rate, and other signals.
   *
   * @returns Playback statistics object
   */
  generatePlaybackStats(
    config: WatchSimulationConfig,
    videoId: string,
    watchDuration: number,
  ): PlaybackStats {
    // Generate canonical playback nonce (cpn) — 16-character unique ID per watch
    const cpn = randomString(16, CPN_CHARSET);

    // Buffering count: longer videos with more quality changes = more buffering
    const baseBuffering = Math.floor(watchDuration / 60);
    const qualityBuffering = config.simulateQualityChanges ? config.qualityChangeCount : 0;
    const bufferingCount = baseBuffering + qualityBuffering + randomIntBetween(0, 3);

    // Frame drops: rare on good connections, more common on lower quality
    const framesDropped = randomIntBetween(0, Math.ceil(watchDuration / 120));

    // Volume: slightly varied from initial
    const volume = config.simulateVolumeChanges
      ? Math.max(0, Math.min(100, config.initialVolume + randomIntBetween(-10, 10)))
      : config.initialVolume;

    // Playback rate: most users watch at 1x, some at 1.25x or 1.5x
    let playbackRate = 1.0;
    const rateRoll = Math.random();
    if (rateRoll < 0.05) playbackRate = 1.25;
    else if (rateRoll < 0.08) playbackRate = 1.5;
    else if (rateRoll < 0.10) playbackRate = 0.75;

    // Whether ad was watched (30% probability for videos with ads)
    const adWatched = Math.random() < 0.3;

    return {
      videoId,
      fullscreen: config.simulateFullscreenToggle ? Math.random() < 0.3 : false,
      quality: config.preferredQuality,
      playbackType: 'detailpage', // Most common for direct video visits
      showAnnotations: Math.random() < 0.1, // Annotations mostly disabled
      autoPlay: Math.random() < 0.6, // Auto-play is common
      volume,
      captionsEnabled: Math.random() < 0.08, // ~8% of users enable captions
      framesDropped,
      bufferingCount,
      playbackRate,
      adWatched,
      cpn,
    };
  }

  // ---------------------------------------------------------------------------
  // INTERACTION SEQUENCE GENERATION
  // ---------------------------------------------------------------------------

  /**
   * Generate a sequence of realistic user interactions during video watching.
   *
   * Produces interaction events that mimic how a real user would interact
   * with the YouTube player: pausing, seeking, changing quality, adjusting
   * volume, and hovering over UI elements.
   *
   * @returns Array of interaction events
   */
  generateInteractionSequence(
    config?: Partial<WatchSimulationConfig>,
    duration?: number,
  ): WatchInteraction[] {
    const effectiveConfig: WatchSimulationConfig = {
      videoDuration: duration || 300,
      minWatchPercentage: config?.minWatchPercentage ?? 0.2,
      maxWatchPercentage: config?.maxWatchPercentage ?? 1.0,
      preferredQuality: config?.preferredQuality ?? '720p',
      simulateQualityChanges: config?.simulateQualityChanges ?? true,
      qualityChangeCount: config?.qualityChangeCount ?? 2,
      simulatePauses: config?.simulatePauses ?? true,
      pauseCount: config?.pauseCount ?? 1,
      simulateSeeks: config?.simulateSeeks ?? true,
      seekCount: config?.seekCount ?? 2,
      simulateVolumeChanges: config?.simulateVolumeChanges ?? true,
      simulateFullscreenToggle: config?.simulateFullscreenToggle ?? false,
      simulateHoverEvents: config?.simulateHoverEvents ?? true,
      initialVolume: config?.initialVolume ?? 75,
    };

    const watchDuration = duration || effectiveConfig.videoDuration;
    const interactions: WatchInteraction[] = [];
    const startTime = Date.now();

    // --- Initial click to play (0-2 seconds in) ---
    interactions.push({
      type: 'click',
      videoTime: randomBetween(0, 2),
      timestamp: startTime + randomIntBetween(500, 2000),
      data: { target: 'play-button' },
    });

    // --- Pause/resume events ---
    if (effectiveConfig.simulatePauses && effectiveConfig.pauseCount > 0) {
      const pauseTimes = this.generateEventTimes(effectiveConfig.pauseCount, watchDuration * 0.8);
      for (const pauseTime of pauseTimes) {
        // Pause event
        interactions.push({
          type: 'pause',
          videoTime: pauseTime,
          timestamp: startTime + Math.round(pauseTime * 1000),
          data: { reason: 'user' },
        });

        // Resume event (2-8 seconds later)
        const resumeTime = pauseTime + randomBetween(2, 8);
        if (resumeTime < watchDuration) {
          interactions.push({
            type: 'resume',
            videoTime: resumeTime,
            timestamp: startTime + Math.round(resumeTime * 1000),
            data: { reason: 'user' },
          });
        }
      }
    }

    // --- Seek events ---
    if (effectiveConfig.simulateSeeks && effectiveConfig.seekCount > 0) {
      const seekTimes = this.generateEventTimes(effectiveConfig.seekCount, watchDuration * 0.7);
      for (const seekTime of seekTimes) {
        // Determine seek direction and amount
        const seekBackward = Math.random() < 0.6; // More users seek backward
        const seekAmount = randomBetween(5, 30);
        const targetTime = seekBackward
          ? Math.max(0, seekTime - seekAmount)
          : Math.min(watchDuration, seekTime + seekAmount);

        interactions.push({
          type: 'seek',
          videoTime: seekTime,
          timestamp: startTime + Math.round(seekTime * 1000),
          data: {
            fromTime: seekTime,
            toTime: targetTime,
            direction: seekBackward ? 'backward' : 'forward',
          },
        });
      }
    }

    // --- Quality change events ---
    if (effectiveConfig.simulateQualityChanges && effectiveConfig.qualityChangeCount > 0) {
      const qualityTimes = this.generateEventTimes(
        effectiveConfig.qualityChangeCount,
        watchDuration * 0.6,
      );
      let currentQuality: string = effectiveConfig.preferredQuality;

      for (const qTime of qualityTimes) {
        const newQuality = this.getNextQuality(currentQuality);
        interactions.push({
          type: 'quality_change',
          videoTime: qTime,
          timestamp: startTime + Math.round(qTime * 1000),
          data: {
            fromQuality: currentQuality,
            toQuality: newQuality,
            reason: Math.random() < 0.7 ? 'auto' : 'user',
          },
        });
        currentQuality = newQuality;
      }
    }

    // --- Volume change events ---
    if (effectiveConfig.simulateVolumeChanges) {
      const volumeChangeCount = randomIntBetween(1, 3);
      const volumeTimes = this.generateEventTimes(volumeChangeCount, watchDuration * 0.8);
      for (const vTime of volumeTimes) {
        const volumeChange = randomIntBetween(-20, 20);
        const newVolume = Math.max(0, Math.min(100, effectiveConfig.initialVolume + volumeChange));
        interactions.push({
          type: 'volume_change',
          videoTime: vTime,
          timestamp: startTime + Math.round(vTime * 1000),
          data: {
            fromVolume: effectiveConfig.initialVolume,
            toVolume: newVolume,
          },
        });
      }
    }

    // --- Fullscreen toggle events ---
    if (effectiveConfig.simulateFullscreenToggle && Math.random() < 0.3) {
      const enterTime = randomBetween(watchDuration * 0.1, watchDuration * 0.4);
      interactions.push({
        type: 'fullscreen_enter',
        videoTime: enterTime,
        timestamp: startTime + Math.round(enterTime * 1000),
      });

      // May exit fullscreen before video ends
      if (Math.random() < 0.6) {
        const exitTime = randomBetween(enterTime + 5, watchDuration * 0.9);
        interactions.push({
          type: 'fullscreen_exit',
          videoTime: exitTime,
          timestamp: startTime + Math.round(exitTime * 1000),
        });
      }
    }

    // --- Hover events (mouse movement over the player) ---
    if (effectiveConfig.simulateHoverEvents) {
      const hoverCount = randomIntBetween(3, 10);
      for (let i = 0; i < hoverCount; i++) {
        const hoverTime = randomBetween(0, watchDuration);
        interactions.push({
          type: 'hover',
          videoTime: hoverTime,
          timestamp: startTime + Math.round(hoverTime * 1000),
          data: {
            target: randomPick(['player-controls', 'progress-bar', 'video-title', 'channel-name']),
          },
        });
      }
    }

    // Sort interactions by timestamp
    interactions.sort((a, b) => a.timestamp - b.timestamp);

    this.stats.totalInteractions += interactions.length;

    return interactions;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Generate evenly-distributed event times within a duration,
   * with some randomization to avoid perfectly spaced patterns.
   */
  private generateEventTimes(count: number, duration: number): number[] {
    if (count <= 0 || duration <= 0) return [];

    const times: number[] = [];
    const segmentSize = duration / (count + 1);

    for (let i = 1; i <= count; i++) {
      const baseTime = segmentSize * i;
      // Add jitter: ±30% of segment size
      const jitter = segmentSize * 0.3 * (Math.random() * 2 - 1);
      const eventTime = Math.max(1, Math.min(duration - 1, baseTime + jitter));
      times.push(Math.round(eventTime * 100) / 100);
    }

    // Sort and deduplicate
    times.sort((a, b) => a - b);
    return times;
  }

  /**
   * Get the starting quality for a watch session.
   * YouTube typically starts at a lower quality and ramps up.
   */
  private getStartingQuality(preferred: string): string {
    const preferredIdx = qualityIndex(preferred);
    // Start 1-2 quality levels below preferred (simulates adaptive streaming)
    const startIdx = Math.max(0, preferredIdx - randomIntBetween(1, 2));
    return QUALITY_LEVELS[startIdx] as WatchSimulationConfig['preferredQuality'];
  }

  /**
   * Get the next quality level (simulates adaptive quality changes).
   * Usually goes up, sometimes drops.
   */
  private getNextQuality(current: string): string {
    const currentIdx = qualityIndex(current);

    // 70% chance to go up, 20% stay same, 10% go down
    const roll = Math.random();
    if (roll < 0.7) {
      return QUALITY_LEVELS[Math.min(QUALITY_LEVELS.length - 1, currentIdx + 1)] as WatchSimulationConfig['preferredQuality'];
    } else if (roll < 0.9) {
      return current;
    } else {
      return QUALITY_LEVELS[Math.max(0, currentIdx - 1)] as WatchSimulationConfig['preferredQuality'];
    }
  }

  /**
   * Get simulator statistics.
   */
  getStats(): Record<string, unknown> {
    return { ...this.stats };
  }
}

/**
 * Pick a random element from an array.
 */
function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const watchSimulator = new WatchSimulator();
