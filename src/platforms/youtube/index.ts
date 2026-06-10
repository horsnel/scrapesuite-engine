/**
 * YouTube Platform Module — ScrapeSuite Engine
 *
 * Complete anti-bot counter-measures for YouTube scraping.
 * Handles bot detection evasion, watch simulation, and InnerTube API signing.
 *
 * Components:
 *   - BotDetectionEvader: Detects and evades Google's bot detection
 *   - WatchSimulator: Simulates realistic video watching behavior
 *   - YouTubeApiSigner: Signs YouTube InnerTube API requests
 *   - YouTubeManager: Orchestrates all counter-measures
 *
 * Usage:
 *   import { youtubeManager } from './platforms/youtube';
 *
 *   // Initialize
 *   await youtubeManager.initialize();
 *
 *   // Prepare a scraping session
 *   const session = await youtubeManager.prepareSession();
 *
 *   // Sign a request
 *   const signed = await youtubeManager.signRequest(url, 'POST', body);
 *
 *   // Simulate watching a video
 *   const watch = youtubeManager.simulateWatch('dQw4w9WgXcQ', 212);
 *
 *   // Evade detected bot signals
 *   const { signals, strategy } = youtubeManager.evadeDetection(response);
 */

// ===============================================================================
// CLASS EXPORTS
// ===============================================================================

export { YouTubeManager, youtubeManager } from './manager';
export { BotDetectionEvader, botDetectionEvader } from './bot-detection-evader';
export { WatchSimulator, watchSimulator } from './watch-simulator';
export { YouTubeApiSigner, youtubeApiSigner } from './api-signer';

// ===============================================================================
// TYPE EXPORTS
// ===============================================================================

export type {
  // Device profile types
  YouTubeClientPlatform,
  YouTubeDeviceProfile,

  // Scrape target types
  YouTubeScrapeTarget,
  YouTubeScrapeRequest,

  // Watch simulation types
  WatchSimulationConfig,
  WatchSimulationResult,
  PlayheadPosition,
  PlaybackStats,
  WatchInteraction,

  // Bot detection types
  BotDetectionSignals,
  BotDetectionEvaderConfig,
  EvasionStrategy,

  // API signer types
  YouTubeApiSignerConfig,
  InnertubeSignParams,
  InnertubeSignResult,
  YouTubeSessionIds,

  // Manager types
  YouTubeManagerConfig,
  YouTubeManagerStats,
} from './types';

// ===============================================================================
// VALUE EXPORTS
// ===============================================================================

export { DEFAULT_YOUTUBE_CONFIG } from './types';
