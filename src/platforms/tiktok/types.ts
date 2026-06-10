/**
 * TikTok Platform Module Types -- ScrapeSuite Engine
 *
 * Type definitions for TikTok anti-bot counter-measures.
 * TikTok uses one of the most sophisticated anti-bot systems:
 *   - X-Bogus signature (custom XOR-based algorithm)
 *   - msToken (rotating session token)
 *   - Device registration + verification (ttwid, odin_tt)
 *   - _signature parameter (legacy, still used on some endpoints)
 *   - Behavioral fingerprinting (scroll patterns, interaction timing)
 *   - API request signing with multiple parameters
 */

// ===============================================================================
// TIKTOK DEVICE TYPES
// ===============================================================================

export type TikTokDeviceType = 'mobile_android' | 'mobile_ios' | 'desktop_web' | 'tablet_android' | 'tablet_ios';

export interface TikTokDeviceProfile {
  /** Device type */
  deviceType: TikTokDeviceType;
  /** User-Agent string */
  userAgent: string;
  /** Screen resolution */
  screenResolution: { width: number; height: number; dpr: number };
  /** Platform string */
  platform: string;
  /** App version */
  appVersion: string;
  /** Build number */
  buildNumber: number;
  /** Device brand */
  brand: string;
  /** Device model */
  model: string;
  /** OS version */
  osVersion: string;
  /** Carrier (for mobile) */
  carrier?: string;
  /** Connection type */
  connectionType: 'wifi' | '4g' | '5g' | '3g';
  /** Language */
  language: string;
  /** Region */
  region: string;
  /** Device ID (generated) */
  deviceId: string;
  /** Install ID (generated) */
  installId: string;
}

// ===============================================================================
// X-BOGUS SIGNATURE TYPES
// ===============================================================================

export interface XBogusParams {
  /** The URL path being signed */
  url: string;
  /** Query parameters */
  queryString: string;
  /** User-Agent string */
  userAgent: string;
  /** Current timestamp (seconds) */
  timestamp: number;
  /** Platform-specific parameters */
  platform: TikTokDeviceType;
  /** Request body (POST requests) */
  body?: string;
}

export interface XBogusResult {
  /** The generated X-Bogus parameter value */
  xBogus: string;
  /** The algorithm version used */
  version: string;
  /** Time taken to generate (ms) */
  generationTimeMs: number;
  /** Whether this signature is still valid */
  isValid: boolean;
  /** Expires at (epoch ms) */
  expiresAt: number;
}

// ===============================================================================
// MSTOKEN TYPES
// ===============================================================================

export interface MsTokenConfig {
  /** Token length (default: 107 or 128) */
  length: number;
  /** Character set for token generation */
  charset: string;
  /** Token lifetime in seconds */
  lifetimeSeconds: number;
  /** Whether to include hash component */
  includeHash: boolean;
}

export interface MsTokenResult {
  /** The generated msToken value */
  token: string;
  /** Token version */
  version: string;
  /** When this token was generated (epoch ms) */
  generatedAt: number;
  /** When this token expires (epoch ms) */
  expiresAt: number;
  /** Whether this token is currently valid */
  isValid: boolean;
}

// ===============================================================================
// DEVICE REGISTRATION TYPES
// ===============================================================================

export interface DeviceRegistrationParams {
  /** Device profile to register */
  device: TikTokDeviceProfile;
  /** msToken for this registration */
  msToken: string;
  /** Whether to verify after registration */
  verify: boolean;
}

export interface DeviceRegistrationResult {
  /** Whether registration was successful */
  success: boolean;
  /** ttwid cookie value */
  ttwid: string;
  /** odin_tt cookie value */
  odin_tt: string;
  /** msToken (refreshed) */
  msToken: string;
  /** Device ID assigned by TikTok */
  assignedDeviceId: string;
  /** Install ID assigned by TikTok */
  assignedInstallId: string;
  /** Registration timestamp */
  registeredAt: number;
  /** Verification status */
  verified: boolean;
  /** Any errors encountered */
  errors: string[];
}

// ===============================================================================
// FEED SIMULATION TYPES
// ===============================================================================

export type FeedSection = 'fyp' | 'following' | 'discover' | 'search' | 'profile' | 'video_detail' | 'comments';

export interface FeedSimulationConfig {
  /** Sections to simulate browsing */
  sections: FeedSection[];
  /** Number of videos to "watch" per section */
  videosPerSection: number;
  /** Watch time range (seconds) */
  watchTimeRange: { min: number; max: number };
  /** Whether to simulate scrolling */
  simulateScrolling: boolean;
  /** Whether to simulate interactions (like, comment, share) */
  simulateInteractions: boolean;
  /** Interaction probability (0-1) */
  interactionProbability: number;
  /** Whether to simulate search */
  simulateSearch: boolean;
  /** Search queries to simulate */
  searchQueries: string[];
}

export interface FeedSimulationResult {
  /** Sections simulated */
  sectionsSimulated: FeedSection[];
  /** Total videos "watched" */
  totalVideosWatched: number;
  /** Total simulation time (ms) */
  totalTimeMs: number;
  /** Interactions performed */
  interactions: Array<{
    type: 'like' | 'comment' | 'share' | 'follow' | 'scroll' | 'pause';
    videoId?: string;
    timestamp: number;
  }>;
  /** Tokens refreshed during simulation */
  tokensRefreshed: number;
  /** Whether the simulation completed without detection */
  undetected: boolean;
}

// ===============================================================================
// SIGNATURE ENGINE TYPES
// ===============================================================================

export type TikTokSignatureAlgorithm = 'x-bogus' | 'a-bogus' | '_signature' | 'msToken' | 'ttwid';

export interface SignatureRequest {
  /** URL to sign */
  url: string;
  /** HTTP method */
  method: 'GET' | 'POST';
  /** Request body (for POST) */
  body?: string;
  /** Device profile */
  device: TikTokDeviceProfile;
  /** Current msToken */
  msToken: string;
  /** Current ttwid */
  ttwid?: string;
  /** Which algorithms to apply */
  algorithms: TikTokSignatureAlgorithm[];
}

export interface SignatureResult {
  /** Signed URL (with all signature parameters appended) */
  signedUrl: string;
  /** X-Bogus value */
  xBogus?: string;
  /** A-Bogus value */
  aBogus?: string;
  /** _signature value */
  signature?: string;
  /** msToken (refreshed if needed) */
  msToken: string;
  /** Additional headers needed */
  headers: Record<string, string>;
  /** Additional cookies needed */
  cookies: Record<string, string>;
  /** Time taken to generate all signatures (ms) */
  generationTimeMs: number;
}

// ===============================================================================
// TIKTOK MANAGER CONFIG
// ===============================================================================

export interface TikTokManagerConfig {
  /** Device profiles to maintain */
  devicePoolSize: number;
  /** msToken rotation interval (seconds) */
  msTokenRotationSeconds: number;
  /** Whether to auto-register devices */
  autoRegisterDevices: boolean;
  /** Maximum requests per device before rotation */
  maxRequestsPerDevice: number;
  /** Feed simulation interval (seconds) */
  feedSimulationIntervalSeconds: number;
  /** Preferred device type */
  preferredDeviceType: TikTokDeviceType;
  /** Region for device profiles */
  region: string;
  /** Language for device profiles */
  language: string;
}

export const DEFAULT_TIKTOK_CONFIG: TikTokManagerConfig = {
  devicePoolSize: 10,
  msTokenRotationSeconds: 300,
  autoRegisterDevices: true,
  maxRequestsPerDevice: 50,
  feedSimulationIntervalSeconds: 600,
  preferredDeviceType: 'mobile_android',
  region: 'US',
  language: 'en',
};

// ===============================================================================
// TIKTOK MANAGER STATS
// ===============================================================================

export interface TikTokManagerStats {
  /** Total signatures generated */
  totalSignatures: number;
  /** Total msToken rotations */
  totalMsTokenRotations: number;
  /** Total device registrations */
  totalDeviceRegistrations: number;
  /** Total feed simulations */
  totalFeedSimulations: number;
  /** Active device count */
  activeDevices: number;
  /** Signature success rate */
  signatureSuccessRate: number;
  /** Average signature generation time (ms) */
  avgSignatureTimeMs: number;
  /** msToken pool size */
  msTokenPoolSize: number;
  /** Detection encounters */
  detectionEncounters: number;
  /** Last detection at */
  lastDetectionAt?: number;
}
