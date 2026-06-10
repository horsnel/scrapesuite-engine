/**
 * YouTube Platform Module Types — ScrapeSuite Engine
 *
 * Type definitions for YouTube anti-bot counter-measures.
 * YouTube (Google) employs one of the most sophisticated anti-bot stacks:
 *   - Google "unusual traffic" detection (server-side behavioral analysis)
 *   - reCAPTCHA Enterprise (risk-analysis-based challenge)
 *   - InnerTube API signing (SAPISIDHASH, session tokens)
 *   - Visitor tracking (_visitor_key, visitorData)
 *   - Consent cookie enforcement (CONSENT, SOCS)
 *   - Watch-time validation (playhead positions, playback stats)
 *   - API quota monitoring and rate limiting
 *   - Device fingerprint correlation (TLS, UA, screen resolution)
 */

// ===============================================================================
// YOUTUBE DEVICE PROFILE TYPES
// ===============================================================================

/** Supported YouTube client platforms */
export type YouTubeClientPlatform = 'web' | 'android' | 'ios' | 'tv' | 'mweb';

/** Device profile for YouTube session impersonation */
export interface YouTubeDeviceProfile {
  /** Full User-Agent string */
  userAgent: string;
  /** Screen resolution */
  screenResolution: { width: number; height: number; dpr: number };
  /** Platform identifier (e.g. "Win32", "Linux x86_64", "MacIntel") */
  platform: string;
  /** YouTube client platform */
  clientPlatform: YouTubeClientPlatform;
  /** Browser name (e.g. "Chrome", "Firefox", "Safari") */
  browserName: string;
  /** Browser major version */
  browserVersion: string;
  /** Operating system */
  os: string;
  /** OS version */
  osVersion: string;
  /** Device memory in GB (navigator.deviceMemory) */
  deviceMemory?: number;
  /** Hardware concurrency (navigator.hardwareConcurrency) */
  hardwareConcurrency?: number;
  /** WebGL renderer string */
  webglRenderer?: string;
  /** WebGL vendor string */
  webglVendor?: string;
  /** Language */
  language: string;
  /** Region/locale */
  region: string;
  /** Timezone (e.g. "America/New_York") */
  timezone: string;
  /** Connection type */
  connectionType: 'wifi' | '4g' | '5g' | '3g' | 'ethernet';
}

// ===============================================================================
// YOUTUBE SCRAPE TARGET TYPES
// ===============================================================================

/** Types of YouTube content that can be scraped */
export type YouTubeScrapeTarget =
  | 'video'       // Video metadata + stream info
  | 'channel'     // Channel page data
  | 'search'      // Search results
  | 'comments'    // Comment thread extraction
  | 'playlist'    // Playlist metadata + items
  | 'trending'    // Trending tab content
  | 'shorts';     // Shorts feed

/** Configuration for a YouTube scrape request */
export interface YouTubeScrapeRequest {
  /** What to scrape */
  target: YouTubeScrapeTarget;
  /** Target identifier (video ID, channel ID, search query, etc.) */
  identifier: string;
  /** Optional page token for pagination */
  pageToken?: string;
  /** Language preference */
  language?: string;
  /** Region preference */
  region?: string;
  /** Whether to include watch simulation */
  simulateWatch?: boolean;
  /** Video duration in seconds (required when simulateWatch is true) */
  videoDuration?: number;
}

// ===============================================================================
// WATCH SIMULATION TYPES
// ===============================================================================

/** Configuration for a watch simulation session */
export interface WatchSimulationConfig {
  /** Total video duration in seconds */
  videoDuration: number;
  /** Minimum watch percentage (0-1, default 0.2) */
  minWatchPercentage: number;
  /** Maximum watch percentage (0-1, default 1.0) */
  maxWatchPercentage: number;
  /** Preferred video quality */
  preferredQuality: '144p' | '240p' | '360p' | '480p' | '720p' | '1080p' | '1440p' | '2160p';
  /** Whether to simulate quality changes */
  simulateQualityChanges: boolean;
  /** Number of quality changes during watch (0-5) */
  qualityChangeCount: number;
  /** Whether to simulate pause/resume events */
  simulatePauses: boolean;
  /** Number of pause events during watch (0-3) */
  pauseCount: number;
  /** Whether to simulate seek events */
  simulateSeeks: boolean;
  /** Number of seek events during watch (0-5) */
  seekCount: number;
  /** Whether to simulate volume changes */
  simulateVolumeChanges: boolean;
  /** Whether to simulate fullscreen toggle */
  simulateFullscreenToggle: boolean;
  /** Whether to simulate hover/mouse movement */
  simulateHoverEvents: boolean;
  /** Initial volume (0-100) */
  initialVolume: number;
}

/** Result of a watch simulation session */
export interface WatchSimulationResult {
  /** Video ID that was "watched" */
  videoId: string;
  /** Total simulated watch duration in seconds */
  totalWatchDuration: number;
  /** Actual percentage of video watched (0-1) */
  watchPercentage: number;
  /** Playhead position timeline */
  playheadPositions: PlayheadPosition[];
  /** Playback statistics reported to YouTube */
  playbackStats: PlaybackStats;
  /** Interaction events (pause, seek, quality change, etc.) */
  interactions: WatchInteraction[];
  /** Session start time (epoch ms) */
  startedAt: number;
  /** Session end time (epoch ms) */
  endedAt: number;
  /** Whether the watch session appears human-like */
  appearsHuman: boolean;
}

/** A single playhead position report */
export interface PlayheadPosition {
  /** Time in video (seconds) */
  currentTime: number;
  /** Timestamp of this report (epoch ms) */
  reportedAt: number;
  /** Playback state */
  state: 'playing' | 'paused' | 'buffering' | 'ended';
  /** Video quality at this position */
  quality: string;
}

/** Playback statistics reported to YouTube */
export interface PlaybackStats {
  /** Video ID */
  videoId: string;
  /** Whether the video was played in fullscreen */
  fullscreen: boolean;
  /** Final video quality */
  quality: string;
  /** Playback type */
  playbackType: 'inline' | 'embed' | 'detailpage';
  /** Whether annotations were shown */
  showAnnotations: boolean;
  /** Whether auto-play was used */
  autoPlay: boolean;
  /** Audio volume (0-100) */
  volume: number;
  /** Whether subtitles were enabled */
  captionsEnabled: boolean;
  /** Total frames dropped */
  framesDropped: number;
  /** Buffering count */
  bufferingCount: number;
  /** Average playback rate */
  playbackRate: number;
  /** Whether the video ad was watched (if any) */
  adWatched: boolean;
  /** Cpn (canonical playback nonce) — unique per watch */
  cpn: string;
}

/** A watch interaction event */
export interface WatchInteraction {
  /** Interaction type */
  type: 'pause' | 'resume' | 'seek' | 'quality_change' | 'volume_change' | 'fullscreen_enter' | 'fullscreen_exit' | 'hover' | 'click';
  /** Time in video when the interaction occurred (seconds) */
  videoTime: number;
  /** Timestamp of the interaction (epoch ms) */
  timestamp: number;
  /** Additional data for the interaction */
  data?: Record<string, unknown>;
}

// ===============================================================================
// BOT DETECTION EVADER TYPES
// ===============================================================================

/** Signals detected from a YouTube/Google response indicating bot detection */
export interface BotDetectionSignals {
  /** Whether an "unusual traffic" page was returned */
  unusualTrafficPage: boolean;
  /** Whether a reCAPTCHA challenge was detected */
  captchaDetected: boolean;
  /** reCAPTCHA type (if detected) */
  captchaType?: 'v2' | 'v3' | 'enterprise';
  /** Whether rate limiting headers were detected */
  rateLimited: boolean;
  /** Rate limit details */
  rateLimitDetails?: {
    remaining?: number;
    resetAt?: number;
    retryAfter?: number;
  };
  /** Whether consent/cookie wall was triggered */
  consentWall: boolean;
  /** Whether a login wall was triggered */
  loginWall: boolean;
  /** Whether the response indicates a bot classification */
  botClassification?: 'none' | 'suspicious' | 'bot' | 'confirmed_bot';
  /** HTTP status code */
  statusCode: number;
  /** Whether the response contains a redirect to a verification page */
  verificationRedirect: boolean;
  /** Response time anomalies (faster than expected = possible bot detection) */
  responseTimeAnomaly: boolean;
  /** Timestamp when signals were detected */
  detectedAt: number;
}

/** Evasion strategy generated based on detected bot signals */
export interface EvasionStrategy {
  /** Whether a cooldown period is recommended */
  requiresCooldown: boolean;
  /** Suggested cooldown duration in seconds */
  cooldownDurationSeconds: number;
  /** Whether cookies should be rotated */
  rotateCookies: boolean;
  /** Whether the device profile should be rotated */
  rotateDevice: boolean;
  /** Whether the IP/proxy should be rotated */
  rotateProxy: boolean;
  /** Whether CAPTCHA solving is needed */
  requiresCaptchaSolve: boolean;
  /** Suggested headers to add or modify */
  headerModifications: Record<string, string>;
  /** Suggested cookie modifications */
  cookieModifications: Record<string, string>;
  /** Priority of this evasion (1 = critical, 5 = low) */
  priority: 1 | 2 | 3 | 4 | 5;
  /** Human-readable description of the strategy */
  description: string;
}

/** Configuration for the bot detection evader */
export interface BotDetectionEvaderConfig {
  /** Minimum cooldown in seconds when detection is triggered */
  minCooldownSeconds: number;
  /** Maximum cooldown in seconds when detection is triggered */
  maxCooldownSeconds: number;
  /** Cooldown multiplier for repeated detections */
  cooldownMultiplier: number;
  /** Maximum cooldown cap in seconds */
  maxCooldownCapSeconds: number;
  /** Whether to automatically solve CAPTCHAs */
  autoSolveCaptcha: boolean;
  /** Whether to rotate device on detection */
  autoRotateDevice: boolean;
  /** Whether to rotate proxy on detection */
  autoRotateProxy: boolean;
  /** Patterns that indicate "unusual traffic" pages */
  unusualTrafficPatterns: string[];
  /** Response time threshold in ms below which is anomalous */
  fastResponseThresholdMs: number;
}

// ===============================================================================
// YOUTUBE API SIGNER TYPES
// ===============================================================================

/** Configuration for the YouTube API signer */
export interface YouTubeApiSignerConfig {
  /** Default InnerTube client name */
  defaultClientName: string;
  /** Default InnerTube client version */
  defaultClientVersion: string;
  /** Default InnerTube client screen */
  defaultClientScreen: string;
  /** API key used for YouTube InnerTube requests */
  apiKey: string;
  /** Origin header value */
  origin: string;
  /** Whether to generate SAPISIDHASH */
  generateSapisidhash: boolean;
  /** Whether to include visitor data in context */
  includeVisitorData: boolean;
  /** Whether to include session IDs */
  includeSessionIds: boolean;
  /** SAPISID cookie value (required for SAPISIDHASH) */
  sapisid?: string;
}

/** Parameters for signing an InnerTube API request */
export interface InnertubeSignParams {
  /** API endpoint path (e.g. "browse", "player", "search") */
  endpoint: string;
  /** HTTP method */
  method: 'GET' | 'POST';
  /** Request body (for POST) */
  body?: Record<string, unknown>;
  /** SAPISID cookie value */
  sapisid?: string;
  /** Client name override */
  clientName?: string;
  /** Client version override */
  clientVersion?: string;
  /** Visitor data string */
  visitorData?: string;
  /** Session index */
  sessionIndex?: number;
}

/** Result of signing an InnerTube API request */
export interface InnertubeSignResult {
  /** Signed URL with all required query parameters */
  signedUrl: string;
  /** Required headers */
  headers: Record<string, string>;
  /** Required cookies */
  cookies: Record<string, string>;
  /** The InnerTube context object (for body) */
  context: Record<string, unknown>;
  /** SAPISIDHASH value (if generated) */
  sapisidhash?: string;
  /** Session IDs generated */
  sessionIds: YouTubeSessionIds;
  /** Time taken to sign (ms) */
  signingTimeMs: number;
}

/** YouTube session identifiers */
export interface YouTubeSessionIds {
  /** Visitor data string */
  visitorData: string;
  /** Visitor key (used for _visitor_key param) */
  visitorKey: string;
  /** Session ID (U value) */
  sessionId: string;
  /** Playback nonce (cpn) for watch sessions */
  cpn: string;
  /** Delegated session ID */
  delegatedSessionId?: string;
  /** Click tracking parameters */
  clickTrackingParams?: string;
}

// ===============================================================================
// YOUTUBE MANAGER CONFIG & STATS
// ===============================================================================

/** Configuration for the YouTube Manager */
export interface YouTubeManagerConfig {
  /** Number of device profiles to maintain in the pool */
  devicePoolSize: number;
  /** Default client platform for new sessions */
  defaultPlatform: YouTubeClientPlatform;
  /** Default region */
  region: string;
  /** Default language */
  language: string;
  /** Whether to auto-evade detected bot signals */
  autoEvade: boolean;
  /** Whether to simulate watches by default */
  defaultSimulateWatch: boolean;
  /** Maximum requests per device before rotation */
  maxRequestsPerDevice: number;
  /** Watch simulation config defaults */
  watchSimulation: Omit<WatchSimulationConfig, 'videoDuration'>;
  /** Bot detection evader config */
  botDetection: BotDetectionEvaderConfig;
  /** API signer config */
  apiSigner: YouTubeApiSignerConfig;
  /** Request throttle in ms between requests */
  requestThrottleMs: number;
  /** Whether to cache signed contexts */
  cacheContexts: boolean;
  /** Cache TTL in seconds for signed contexts */
  contextCacheTtlSeconds: number;
}

/** Default YouTube Manager configuration */
export const DEFAULT_YOUTUBE_CONFIG: YouTubeManagerConfig = {
  devicePoolSize: 15,
  defaultPlatform: 'web',
  region: 'US',
  language: 'en',
  autoEvade: true,
  defaultSimulateWatch: true,
  maxRequestsPerDevice: 80,
  watchSimulation: {
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
  },
  botDetection: {
    minCooldownSeconds: 30,
    maxCooldownSeconds: 300,
    cooldownMultiplier: 1.5,
    maxCooldownCapSeconds: 3600,
    autoSolveCaptcha: true,
    autoRotateDevice: true,
    autoRotateProxy: true,
    unusualTrafficPatterns: [
      'unusual traffic',
      'not a robot',
      'verify you are human',
      'captcha',
      'sorry, we just need to make sure',
      'our systems have detected',
      'automated requests',
    ],
    fastResponseThresholdMs: 50,
  },
  apiSigner: {
    defaultClientName: 'WEB',
    defaultClientVersion: '2.20260603.00.00',
    defaultClientScreen: 'WATCH_FULL_SCREEN',
    apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    origin: 'https://www.youtube.com',
    generateSapisidhash: true,
    includeVisitorData: true,
    includeSessionIds: true,
  },
  requestThrottleMs: 1500,
  cacheContexts: true,
  contextCacheTtlSeconds: 600,
};

/** Statistics for the YouTube Manager */
export interface YouTubeManagerStats {
  /** Total sessions prepared */
  totalSessions: number;
  /** Total requests signed */
  totalRequestsSigned: number;
  /** Total watch simulations */
  totalWatchSimulations: number;
  /** Total evasion actions taken */
  totalEvasions: number;
  /** Total CAPTCHAs solved */
  totalCaptchasSolved: number;
  /** Active device profiles in the pool */
  activeDevices: number;
  /** Average request signing time (ms) */
  avgSigningTimeMs: number;
  /** Average watch simulation time (ms) */
  avgWatchSimulationTimeMs: number;
  /** Detection encounter count */
  detectionEncounters: number;
  /** Last detection timestamp */
  lastDetectionAt?: number;
  /** Evasion success rate (0-1) */
  evasionSuccessRate: number;
  /** Current cooldown remaining (seconds, 0 if not cooling down) */
  currentCooldownSeconds: number;
  /** Breakdown of requests by scrape target */
  requestsByTarget: Record<YouTubeScrapeTarget, number>;
}
