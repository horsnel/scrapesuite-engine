/**
 * Platform Layer Barrel — ScrapeSuite Engine
 *
 * The scraping brains: platform managers, the self-learning nervous system
 * (telemetry, failure signatures, fixtures), the trust ladder, the proxy
 * pool seam, caching, batching, and the unified facade. Everything here is
 * usable as a library — the API tier is optional.
 */

// ---- Unified facade ----
export {
  getCommentsForUrl,
  searchVideos,
  getSubredditPosts,
  engineStatus,
} from './unified';
export type { UnifiedCommentsResult, UnifiedComment } from './unified';

// ---- Router ----
export { resolveUrl, describeUrl } from './router';
export type { ResolvedContent } from './router';

// ---- Self-learning nervous system ----
export {
  recordAttempt,
  toScrapingObservation,
  recentObservations,
  outcomeTally,
  telemetryStats,
} from './telemetry';
export type { PlatformObservationInput, PlatformOutcome, PlatformSurface } from './telemetry';

export {
  failureSignatures,
  lookupSignature,
  getBaseline,
  topSignatures,
  diffAgainstBaseline,
} from './failure-signatures';
export type { FailureSignature, RequestFingerprint, BaselineDiff } from './failure-signatures';

export { saveFixture, loadFixtures, tripwire } from './fixture-store';
export type { StoredFixture, TripwireResult } from './fixture-store';

export {
  runCanary,
  latestCanaryReport,
  canaryHistory,
  canaryTelemetrySnapshot,
} from './canary';
export type { CanaryReport, CanaryRow, CanaryOptions } from './canary';

export {
  startUpkeep,
  stopUpkeep,
  refreshYouTubeVersion,
  loadUpkeepConfig,
  upkeepRunning,
} from './upkeep';

// ---- Trust ladder ----
export { climbLadder, getRememberedRung } from './trust-ladder';
export type { LadderRung, LadderResult, LadderStep, RungAttempt } from './trust-ladder';

// ---- Speed ----
export {
  cachedFetch,
  invalidateCache,
  invalidateSurface,
  cacheStats,
  DEFAULT_TTLS,
} from './response-cache';
export { runBatch, batchYouTubeComments, batchRedditRss } from './batch';
export type { BatchOptions, BatchReport, BatchItemResult } from './batch';

// ---- Normalized models ----
export type { NormalizedItem, NormalizedKind, NormalizedStats, PlatformName } from './types-normalized';
export { extractBrowseVideos, extractSearchResults, extractPlayerInfo } from './youtube/extractors';
export { extractRssPosts, extractJsonPosts } from './reddit/extractors';

// ---- Platform managers (re-exported for one-stop imports) ----
export { youtubeManager } from './youtube/manager';
export { tiktokManager } from './tiktok/manager';
export { rssAdapter } from './reddit/rss-adapter';

// ---- YouTube endpoints ----
export {
  getComments,
  getMoreComments,
  getTranscript,
  parseCommentThreads,
  parseTranscriptSegments,
  extractTranscriptParams,
  extractVisitorData,
} from './youtube/innertube-endpoints';

// ---- Session farm ----
export {
  depositSession,
  lendSession,
  reportSessionOutcome,
  farmStatus,
} from './tiktok/session-farm';
