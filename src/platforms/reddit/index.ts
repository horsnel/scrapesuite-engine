/**
 * Reddit Platform Module -- ScrapeSuite Engine
 *
 * Complete anti-bot counter-measures for Reddit scraping.
 * Handles rate limit evasion, behavioral simulation, OAuth2 API access,
 * and Cloudflare + Reddit-specific detection bypass.
 *
 * Components:
 *   - RateLimiterEvader: Adaptive pacing based on x-ratelimit-* headers
 *   - ScrollVoter: Realistic browsing simulation (scroll, vote, navigate)
 *   - RedditApiAdapter: OAuth2 authentication and request building
 *   - RedditManager: Unified orchestration of all sub-engines
 *
 * Usage:
 *   import { redditManager } from './platforms/reddit';
 *   await redditManager.initialize();
 *   const session = await redditManager.prepareSession();
 *   const data = await redditManager.scrapeListing('https://www.reddit.com/r/programming/hot');
 */

// Classes and singletons
export { RedditManager, redditManager } from './manager';
export { RateLimiterEvader, rateLimiterEvader } from './rate-limiter-evader';
export { ScrollVoter, scrollVoter } from './scroll-voter';
export { RedditApiAdapter, redditApiAdapter } from './api-adapter';

// Type exports
export type {
  RedditScrapeTarget,
  RedditSessionProfile,
  RedditRateLimitConfig,
  RedditRateLimitState,
  RedditInteractionConfig,
  RedditApiConfig,
  RedditManagerConfig,
  RedditManagerStats,
  PlaywrightAction,
  PlaywrightSequence,
  RedditListingParseResult,
  RedditBrowsingSession,
  RedditAuthResult,
} from './types';

// Constant exports
export { DEFAULT_REDDIT_CONFIG, DEFAULT_REDDIT_STATS } from './types';
