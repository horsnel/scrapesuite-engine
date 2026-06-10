/**
 * Reddit Platform Module Types -- ScrapeSuite Engine
 *
 * Type definitions for Reddit anti-bot counter-measures.
 * Reddit employs a multi-layered detection system:
 *
 *   - Rate limiting via x-ratelimit-* headers (60/min OAuth, 10/min unauthenticated)
 *   - Cloudflare Turnstile + Reddit-specific behavioral checks
 *   - OAuth2 API authentication with token rotation
 *   - old.reddit.com vs new.reddit.com detection vectors
 *   - JSON API (.json suffix) vs HTML rendering
 *   - Vote & scroll pattern analysis (behavioral fingerprinting)
 *   - ADBLDR / tracking pixel injection
 *   - Session consistency checks (cookies, localStorage, fingerprint)
 */

// ===============================================================================
// REDDIT SCRAPE TARGET
// ===============================================================================

/**
 * Types of content that can be scraped from Reddit.
 * Each target has different anti-bot characteristics and rate limits.
 */
export type RedditScrapeTarget =
  | 'post'        /** Individual post with metadata & content */
  | 'comments'    /** Comment tree for a specific post */
  | 'subreddit'   /** Subreddit listing (hot, new, rising, top, controversial) */
  | 'user'        /** User profile, posts, comments, overview */
  | 'search'      /** Reddit search results */
  | 'listing'     /** Paginated listing (multi, popular, all) */
  | 'wiki';       /** Subreddit wiki pages */

// ===============================================================================
// REDDIT SESSION PROFILE
// ===============================================================================

/**
 * Complete session profile for simulating a realistic Reddit user.
 * Maintains consistency across all requests in a session to avoid
 * detection via fingerprint correlation.
 */
export interface RedditSessionProfile {
  /** User-Agent string (must be consistent across session) */
  userAgent: string;
  /** Screen resolution reported to the browser */
  screenResolution: {
    width: number;
    height: number;
    dpr: number;
  };
  /** Browser platform string (e.g. 'Win32', 'MacIntel') */
  platform: string;
  /** Language preferences */
  language: string;
  /** Regional setting */
  region: string;
  /** Timezone offset in minutes */
  timezoneOffset: number;
  /** Whether this is a logged-in session */
  isLoggedIn: boolean;
  /** Reddit username (if logged in) */
  username?: string;
  /** Account age in days (for warming simulation) */
  accountAgeDays?: number;
  /** Link karma (cosmetic, for profile realism) */
  linkKarma?: number;
  /** Comment karma (cosmetic, for profile realism) */
  commentKarma?: number;
  /** Preferred Reddit variant */
  redditVariant: 'new' | 'old' | 'compact' | 'sh';
  /** Whether to use the JSON API (.json suffix) */
  useJsonApi: boolean;
  /** Subreddit subscriptions (for realism in navigation) */
  subscribedSubreddits: string[];
  /** Session cookies */
  cookies: Record<string, string>;
  /** Session start timestamp (epoch ms) */
  sessionStart: number;
  /** Unique session identifier */
  sessionId: string;
}

// ===============================================================================
// REDDIT RATE LIMIT CONFIG
// ===============================================================================

/**
 * Rate limit configuration for Reddit scraping.
 * Reddit enforces different rate limits based on authentication status:
 *   - OAuth (authenticated): 60 requests/minute
 *   - Unauthenticated: 10 requests/minute
 *   - Search: more aggressively limited (~3-5/min unauthenticated)
 *
 * This config allows fine-tuning evasion behavior.
 */
export interface RedditRateLimitConfig {
  /** Maximum requests per minute for OAuth endpoints */
  oauthRequestsPerMinute: number;
  /** Maximum requests per minute for unauthenticated endpoints */
  unauthenticatedRequestsPerMinute: number;
  /** Maximum requests per minute for search endpoints */
  searchRequestsPerMinute: number;
  /** Maximum concurrent requests per domain */
  maxConcurrentRequests: number;
  /** Burst size (max requests before enforced delay) */
  burstSize: number;
  /** Cooldown after hitting rate limit (ms) */
  cooldownMs: number;
  /** Maximum exponential backoff delay (ms) */
  maxBackoffMs: number;
  /** Base delay between requests (ms) — before jitter */
  baseDelayMs: number;
  /** Jitter range (ms) — added to base delay for humanization */
  jitterRangeMs: number;
  /** Whether to adapt based on x-ratelimit-* headers */
  adaptiveMode: boolean;
  /** Minimum remaining requests before proactive throttle */
  throttleThreshold: number;
  /** Multiplier for search vs regular requests */
  searchDelayMultiplier: number;
  /** Whether to distribute requests across time windows */
  distributeAcrossWindow: boolean;
  /** Window size for distribution (ms) */
  distributionWindowMs: number;
}

/**
 * Rate limit state tracked per domain.
 */
export interface RedditRateLimitState {
  /** Current domain (e.g. 'www.reddit.com', 'old.reddit.com', 'oauth.reddit.com') */
  domain: string;
  /** Remaining requests per x-ratelimit-remaining */
  remaining: number;
  /** Requests used per x-ratelimit-used */
  used: number;
  /** Reset timestamp per x-ratelimit-reset (epoch seconds) */
  resetAt: number;
  /** Requests made in current tracking window */
  recentRequests: Array<{
    timestamp: number;
    endpoint: string;
    method: string;
  }>;
  /** Current backoff level (0 = none, increments on 429) */
  backoffLevel: number;
  /** Current cooldown end time (epoch ms) */
  cooldownUntil: number;
  /** Burst detection counter */
  burstCounter: number;
  /** Last burst detection timestamp */
  lastBurstAt: number;
  /** Whether the domain is currently in rate-limit cooldown */
  isThrottled: boolean;
}

// ===============================================================================
// REDDIT INTERACTION CONFIG
// ===============================================================================

/**
 * Configuration for simulating realistic Reddit browsing interactions.
 * Includes scroll patterns, vote behavior, and comment reading simulation.
 */
export interface RedditInteractionConfig {
  /** Scroll patterns for different sections */
  scrollPatterns: {
    /** Scroll speed range (px per scroll event) */
    scrollSpeedRange: { min: number; max: number };
    /** Scroll interval range (ms between scroll events) */
    scrollIntervalRange: { min: number; max: number };
    /** Probability of a "reading pause" during scroll */
    pauseProbability: number;
    /** Duration range for reading pauses (ms) */
    pauseDurationRange: { min: number; max: number };
    /** Probability of scrolling back up */
    scrollBackProbability: number;
  };
  /** Vote behavior configuration */
  voteBehavior: {
    /** Probability of upvoting a post (0-1) */
    upvoteProbability: number;
    /** Probability of downvoting a post (0-1) */
    downvoteProbability: number;
    /** Probability of skipping a vote (0-1) */
    skipProbability: number;
    /** Minimum time viewing post before voting (ms) */
    minViewTimeBeforeVote: number;
    /** Maximum time viewing post before voting (ms) */
    maxViewTimeBeforeVote: number;
    /** Whether to occasionally undo votes */
    undoVoteProbability: number;
    /** Probability of voting on comments vs posts */
    commentVoteProbability: number;
  };
  /** Comment reading configuration */
  commentReading: {
    /** Base reading speed (words per minute) */
    readingSpeedWpm: number;
    /** Probability of expanding collapsed comments */
    expandCollapsedProbability: number;
    /** Maximum depth of comment tree to read */
    maxReadDepth: number;
    /** Probability of reading a reply chain */
    replyChainReadProbability: number;
    /** Time to spend per comment (base, ms) */
    baseCommentReadTimeMs: number;
    /** Multiplier for top-level vs nested comments */
    depthTimeMultiplier: number;
  };
  /** Navigation behavior */
  navigation: {
    /** Probability of clicking into a post from listing */
    clickIntoPostProbability: number;
    /** Probability of visiting user profile from post */
    visitProfileProbability: number;
    /** Probability of visiting a subreddit from link */
    visitSubredditProbability: number;
    /** Probability of using the search bar */
    searchProbability: number;
    /** Time range between navigation actions (ms) */
    navigationDelayRange: { min: number; max: number };
  };
  /** Session timing */
  sessionTiming: {
    /** Minimum session duration (ms) */
    minSessionDurationMs: number;
    /** Maximum session duration (ms) */
    maxSessionDurationMs: number;
    /** Probability of a "break" during session */
    breakProbability: number;
    /** Break duration range (ms) */
    breakDurationRange: { min: number; max: number };
  };
}

// ===============================================================================
// REDDIT API CONFIG
// ===============================================================================

/**
 * Reddit API configuration for OAuth2 authentication and request building.
 * Reddit's API requires proper OAuth2 credentials with specific user-agent
 * formatting to avoid rate limiting and shadow-banning.
 */
export interface RedditApiConfig {
  /** OAuth2 client ID (from reddit.com/prefs/apps) */
  clientId: string;
  /** OAuth2 client secret (for "script" type apps) */
  clientSecret?: string;
  /** OAuth2 access token (current) */
  accessToken?: string;
  /** OAuth2 refresh token */
  refreshToken?: string;
  /** OAuth2 redirect URI */
  redirectUri?: string;
  /** User-Agent format string (must follow Reddit's guidelines) */
  userAgentFormat: string;
  /** Default subreddit for API calls */
  defaultSubreddit: string;
  /** Whether to use old.reddit.com endpoints */
  preferOldReddit: boolean;
  /** Whether to use .json API suffix */
  useJsonApi: boolean;
  /** API version to target */
  apiVersion: string;
  /** Token refresh interval (seconds) */
  tokenRefreshIntervalSeconds: number;
  /** Whether to auto-refresh tokens */
  autoRefreshTokens: boolean;
  /** Scopes to request during authentication */
  scopes: string[];
}

// ===============================================================================
// REDDIT MANAGER CONFIG
// ===============================================================================

/**
 * Top-level configuration for the Reddit Platform Manager.
 * Aggregates all sub-engine configurations with sensible defaults.
 */
export interface RedditManagerConfig {
  /** Rate limit configuration */
  rateLimit: RedditRateLimitConfig;
  /** Interaction simulation configuration */
  interaction: RedditInteractionConfig;
  /** API authentication configuration */
  api: RedditApiConfig;
  /** Number of session profiles to maintain in the pool */
  sessionPoolSize: number;
  /** Whether to auto-warm sessions */
  autoWarmSessions: boolean;
  /** Maximum requests per session before rotation */
  maxRequestsPerSession: number;
  /** Whether to use Cloudflare bypass */
  enableCloudflareBypass: boolean;
  /** Whether to log detailed request/response data */
  verboseLogging: boolean;
  /** Cache TTL for Reddit responses (seconds) */
  responseCacheTtlSeconds: number;
  /** Whether to use the stealth browser for rendering */
  useStealthBrowser: boolean;
  /** Preferred proxy tier for Reddit */
  proxyTier: 'residential' | 'datacenter' | 'mobile';
}

/**
 * Default configuration values for the Reddit Platform Manager.
 * Based on Reddit's current rate limits and API specifications.
 */
export const DEFAULT_REDDIT_CONFIG: RedditManagerConfig = {
  rateLimit: {
    oauthRequestsPerMinute: 60,
    unauthenticatedRequestsPerMinute: 10,
    searchRequestsPerMinute: 4,
    maxConcurrentRequests: 3,
    burstSize: 5,
    cooldownMs: 60000,
    maxBackoffMs: 300000,
    baseDelayMs: 1500,
    jitterRangeMs: 800,
    adaptiveMode: true,
    throttleThreshold: 5,
    searchDelayMultiplier: 2.5,
    distributeAcrossWindow: true,
    distributionWindowMs: 60000,
  },
  interaction: {
    scrollPatterns: {
      scrollSpeedRange: { min: 100, max: 400 },
      scrollIntervalRange: { min: 800, max: 2500 },
      pauseProbability: 0.3,
      pauseDurationRange: { min: 1500, max: 5000 },
      scrollBackProbability: 0.08,
    },
    voteBehavior: {
      upvoteProbability: 0.80,
      downvoteProbability: 0.10,
      skipProbability: 0.10,
      minViewTimeBeforeVote: 2000,
      maxViewTimeBeforeVote: 15000,
      undoVoteProbability: 0.02,
      commentVoteProbability: 0.25,
    },
    commentReading: {
      readingSpeedWpm: 200,
      expandCollapsedProbability: 0.15,
      maxReadDepth: 5,
      replyChainReadProbability: 0.4,
      baseCommentReadTimeMs: 800,
      depthTimeMultiplier: 0.7,
    },
    navigation: {
      clickIntoPostProbability: 0.6,
      visitProfileProbability: 0.05,
      visitSubredditProbability: 0.1,
      searchProbability: 0.08,
      navigationDelayRange: { min: 2000, max: 6000 },
    },
    sessionTiming: {
      minSessionDurationMs: 120000,
      maxSessionDurationMs: 1800000,
      breakProbability: 0.15,
      breakDurationRange: { min: 10000, max: 60000 },
    },
  },
  api: {
    clientId: '',
    clientSecret: '',
    accessToken: '',
    refreshToken: '',
    redirectUri: 'http://localhost:8080/callback',
    userAgentFormat: 'ScrapeSuite:v1.0.0 (by /u/ScrapeSuite)',
    defaultSubreddit: 'popular',
    preferOldReddit: false,
    useJsonApi: true,
    apiVersion: 'v1',
    tokenRefreshIntervalSeconds: 3300, // 55 minutes (tokens last 1 hour)
    autoRefreshTokens: true,
    scopes: ['read', 'history', 'identity'],
  },
  sessionPoolSize: 5,
  autoWarmSessions: true,
  maxRequestsPerSession: 100,
  enableCloudflareBypass: true,
  verboseLogging: false,
  responseCacheTtlSeconds: 300,
  useStealthBrowser: false,
  proxyTier: 'residential',
};

// ===============================================================================
// REDDIT MANAGER STATS
// ===============================================================================

/**
 * Runtime statistics for the Reddit Platform Manager.
 * Tracks all sub-engine metrics for monitoring and adaptive learning.
 */
export interface RedditManagerStats {
  /** Total requests made */
  totalRequests: number;
  /** Total successful requests (2xx status) */
  successfulRequests: number;
  /** Total failed requests */
  failedRequests: number;
  /** Total rate limit encounters (429 status) */
  rateLimitEncounters: number;
  /** Total Cloudflare challenge encounters */
  cloudflareEncounters: number;
  /** Total API authentication successes */
  authSuccesses: number;
  /** Total API authentication failures */
  authFailures: number;
  /** Total OAuth token refreshes */
  tokenRefreshes: number;
  /** Total browsing simulations executed */
  browsingSimulations: number;
  /** Total votes simulated */
  votesSimulated: number;
  /** Total scroll sequences generated */
  scrollSequencesGenerated: number;
  /** Active session count */
  activeSessions: number;
  /** Average delay between requests (ms) */
  avgDelayMs: number;
  /** Current average requests per minute */
  currentRpm: number;
  /** Detection encounter count */
  detectionEncounters: number;
  /** Last detection timestamp (epoch ms) */
  lastDetectionAt: number | null;
  /** Rate limit evasions (successful recoveries from 429) */
  rateLimitEvasions: number;
  /** Subreddit pages scraped */
  subredditsScraped: number;
  /** Posts scraped */
  postsScraped: number;
  /** Comments scraped */
  commentsScraped: number;
  /** Search queries executed */
  searchesExecuted: number;
}

/**
 * Default stats (zero-initialized).
 */
export const DEFAULT_REDDIT_STATS: RedditManagerStats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  rateLimitEncounters: 0,
  cloudflareEncounters: 0,
  authSuccesses: 0,
  authFailures: 0,
  tokenRefreshes: 0,
  browsingSimulations: 0,
  votesSimulated: 0,
  scrollSequencesGenerated: 0,
  activeSessions: 0,
  avgDelayMs: 0,
  currentRpm: 0,
  detectionEncounters: 0,
  lastDetectionAt: null,
  rateLimitEvasions: 0,
  subredditsScraped: 0,
  postsScraped: 0,
  commentsScraped: 0,
  searchesExecuted: 0,
};

// ===============================================================================
// PLAYWRIGHT SEQUENCE TYPES
// ===============================================================================

/**
 * A single action in a Playwright-compatible interaction sequence.
 * Used to drive browser automation with human-like behavior.
 */
export interface PlaywrightAction {
  /** Action type */
  type: 'scroll' | 'click' | 'wait' | 'type' | 'hover' | 'navigate' | 'vote' | 'expand' | 'keyPress';
  /** CSS selector or XPath for target element */
  selector?: string;
  /** Value for type/vote actions */
  value?: string;
  /** Duration of the action (ms) */
  durationMs: number;
  /** Optional label for debugging */
  label?: string;
  /** Whether to add human-like variance to timing */
  humanize?: boolean;
}

/**
 * A complete Playwright interaction sequence representing a browsing session.
 */
export interface PlaywrightSequence {
  /** Unique sequence ID */
  sequenceId: string;
  /** Actions in order of execution */
  actions: PlaywrightAction[];
  /** Total estimated duration (ms) */
  estimatedDurationMs: number;
  /** Target Reddit section */
  targetSection: RedditScrapeTarget;
  /** Session profile to use */
  profile: RedditSessionProfile;
  /** Generated timestamp */
  generatedAt: number;
}

// ===============================================================================
// REDDIT LISTING URL PARSE RESULT
// ===============================================================================

/**
 * Parsed result from a Reddit listing URL.
 * Converts user-facing URLs into API-compatible endpoints.
 */
export interface RedditListingParseResult {
  /** Whether the URL was successfully parsed */
  valid: boolean;
  /** API endpoint URL (e.g. /r/subreddit/hot.json) */
  apiUrl: string;
  /** Subreddit name (if applicable) */
  subreddit: string | null;
  /** Listing sort (hot, new, rising, top, controversial) */
  sort: 'hot' | 'new' | 'rising' | 'top' | 'controversial' | 'relevance' | null;
  /** Time range for top/controversial sort */
  timeRange: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all' | null;
  /** Post ID (if single post URL) */
  postId: string | null;
  /** Username (if user profile URL) */
  username: string | null;
  /** Search query (if search URL) */
  searchQuery: string | null;
  /** Whether this is old.reddit.com */
  isOldReddit: boolean;
  /** Whether this uses the JSON API */
  isJsonApi: boolean;
  /** Pagination anchor (fullname of last item) */
  after: string | null;
  /** Page number estimate */
  page: number;
}

// ===============================================================================
// REDDIT BROWSING SESSION
// ===============================================================================

/**
 * A complete simulated Reddit browsing session.
 * Contains all the interactions and timing for a realistic visit.
 */
export interface RedditBrowsingSession {
  /** Session ID */
  sessionId: string;
  /** Session profile */
  profile: RedditSessionProfile;
  /** Sections visited in order */
  sectionsVisited: Array<{
    section: RedditScrapeTarget;
    subreddit?: string;
    durationMs: number;
    actionsCount: number;
  }>;
  /** Complete Playwright sequence */
  sequence: PlaywrightSequence;
  /** Vote actions performed */
  votes: Array<{
    direction: 'up' | 'down' | 'undo';
    targetId: string;
    targetType: 'post' | 'comment';
    delayMs: number;
  }>;
  /** Total session duration (ms) */
  totalDurationMs: number;
  /** Whether the session is active */
  isActive: boolean;
  /** Session start timestamp */
  startedAt: number;
  /** Session end timestamp (null if active) */
  endedAt: number | null;
}

// ===============================================================================
// REDDIT AUTHENTICATION RESULT
// ===============================================================================

/**
 * Result from a Reddit OAuth2 authentication attempt.
 */
export interface RedditAuthResult {
  /** Whether authentication was successful */
  success: boolean;
  /** OAuth2 access token */
  accessToken: string;
  /** Token type (usually 'bearer') */
  tokenType: string;
  /** Token lifetime in seconds */
  expiresIn: number;
  /** Token scope string */
  scope: string;
  /** OAuth2 refresh token (only for code grant) */
  refreshToken?: string;
  /** Timestamp when token was obtained (epoch ms) */
  obtainedAt: number;
  /** Timestamp when token expires (epoch ms) */
  expiresAt: number;
  /** Error message (if failed) */
  error?: string;
  /** Error description */
  errorDescription?: string;
}
