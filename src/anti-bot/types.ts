/**
 * Anti-Bot Bypass Types -- ScrapeSuite Engine
 *
 * Shared type definitions for ALL anti-bot platform modules.
 * Each platform (Kasada, Akamai, Cloudflare, DataDome, PerimeterX)
 * uses these common types for consistency and interop.
 *
 * Architecture:
 *  +----------------------------------------------------------------------+
 *  | AntiBotPlatform -- enum of all supported anti-bot systems            |
 *  | AntiBotResult  -- unified result type for all bypass operations      |
 *  | AntiBotConfig  -- per-platform configuration with sensible defaults  |
 *  | ManagedCookie  -- tracked cookie with lifecycle management           |
 *  | ChallengePhase -- lifecycle stages for any challenge flow            |
 *  | PlatformProfile -- per-domain adaptive learning profile              |
 *  +----------------------------------------------------------------------+
 */

import type { Page, BrowserContext, CDPSession } from 'playwright';

// ===============================================================================
// PLATFORM ENUM
// ===============================================================================

/** All supported anti-bot platforms. */
export type AntiBotPlatform =
  | 'kasada'
  | 'akamai'
  | 'cloudflare'
  | 'datadome'
  | 'perimeterx'
  | 'imperva'
  | 'f5'
  | 'generic';

/** Human-readable names for logging. */
export const PLATFORM_NAMES: Record<AntiBotPlatform, string> = {
  kasada: 'Kasada (KPSDK)',
  akamai: 'Akamai Bot Manager',
  cloudflare: 'Cloudflare Turnstile',
  datadome: 'DataDome',
  perimeterx: 'PerimeterX (HUMAN)',
  imperva: 'Imperva/Incapsula',
  f5: 'F5/Shape Security',
  generic: 'Generic Anti-Bot',
};

// ===============================================================================
// CHALLENGE LIFECYCLE
// ===============================================================================

/** Phases of a challenge lifecycle. */
export type ChallengePhase =
  | 'idle'             // No active challenge
  | 'detecting'        // Scanning for anti-bot signals
  | 'challenge-found'  // Challenge page detected
  | 'executing'        // Running the challenge solver
  | 'extracting'       // Extracting tokens/cookies
  | 'validating'       // Validating extracted credentials
  | 'complete'         // Challenge solved successfully
  | 'failed'           // Challenge failed
  | 'escalating'       // Escalating to a stronger strategy
  | 'cooldown';        // Cooling down after repeated failures

/** Severity of detection signals. */
export type DetectionSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** Strategy used to bypass a challenge. */
export type BypassStrategy =
  | 'browser-execute'       // Execute challenge JS in browser, extract tokens
  | 'replay-tokens'         // Reuse previously extracted tokens/cookies
  | 'mobile-escalation'     // Switch to mobile proxy + re-solve
  | 'profile-rotation'      // Rotate fingerprint profile + re-solve
  | 'maximum-stealth'       // Apply all stealth measures + re-solve
  | 'sensor-synthesis'      // Synthesize sensor data (Akamai)
  | 'challenge-solver'      // Solve a CAPTCHA/challenge programmatically
  | 'cookie-injection'      // Inject pre-solved cookies
  | 'headless-avoid'        // Avoid headless detection vectors
  | 'fingerprint-spoof'     // Spoof specific fingerprint signals
  | 'behavioral-mimic'      // Mimic human behavioral patterns
  | 'tls-matching';         // Match TLS fingerprint to browser profile

/** Strategy escalation order per platform. */
export const STRATEGY_ESCALATION: Record<AntiBotPlatform, BypassStrategy[]> = {
  kasada: [
    'browser-execute',
    'replay-tokens',
    'profile-rotation',
    'mobile-escalation',
    'maximum-stealth',
  ],
  akamai: [
    'sensor-synthesis',
    'browser-execute',
    'profile-rotation',
    'tls-matching',
    'maximum-stealth',
  ],
  cloudflare: [
    'browser-execute',
    'challenge-solver',
    'replay-tokens',
    'profile-rotation',
    'maximum-stealth',
  ],
  datadome: [
    'fingerprint-spoof',
    'browser-execute',
    'cookie-injection',
    'profile-rotation',
    'maximum-stealth',
  ],
  perimeterx: [
    'behavioral-mimic',
    'browser-execute',
    'replay-tokens',
    'profile-rotation',
    'maximum-stealth',
  ],
  imperva: [
    'cookie-injection',
    'browser-execute',
    'profile-rotation',
    'maximum-stealth',
  ],
  f5: [
    'sensor-synthesis',
    'browser-execute',
    'behavioral-mimic',
    'maximum-stealth',
  ],
  generic: [
    'browser-execute',
    'profile-rotation',
    'maximum-stealth',
  ],
};

// ===============================================================================
// DETECTION RESULTS
// ===============================================================================

/** A single detection signal/indicator. */
export interface DetectionIndicator {
  /** Category of the signal. */
  category: 'header' | 'cookie' | 'dom' | 'url' | 'script' | 'network' | 'behavioral' | 'fingerprint';
  /** Human-readable description. */
  description: string;
  /** How strong this signal is (0-1). */
  weight: number;
  /** Raw value that triggered the detection. */
  rawValue?: string;
}

/** Result of detecting which anti-bot platform is in use. */
export interface PlatformDetectionResult {
  /** Which platform was detected. */
  platform: AntiBotPlatform;
  /** Confidence level (0-1). */
  confidence: number;
  /** Severity of the detection (how aggressive the anti-bot is). */
  severity: DetectionSeverity;
  /** Individual signals that contributed to detection. */
  indicators: DetectionIndicator[];
  /** Specific challenge type detected. */
  challengeType: string;
  /** Whether this is a re-challenge (second+ encounter). */
  isRechallenge: boolean;
  /** Recommended strategy for bypass. */
  recommendedStrategy: BypassStrategy;
}

// ===============================================================================
// COOKIE MANAGEMENT
// ===============================================================================

/** A tracked cookie with lifecycle management. */
export interface ManagedCookie {
  /** Cookie name. */
  name: string;
  /** Cookie value. */
  value: string;
  /** Cookie domain. */
  domain: string;
  /** Cookie path. */
  path: string;
  /** Whether the cookie is HTTP-only. */
  httpOnly: boolean;
  /** Whether the cookie requires HTTPS. */
  secure: boolean;
  /** SameSite policy. */
  sameSite: 'Strict' | 'Lax' | 'None';
  /** When this cookie was first set (epoch ms). */
  setAt: number;
  /** When this cookie was last refreshed (epoch ms). */
  refreshedAt: number;
  /** When this cookie expires (epoch ms). 0 = session cookie. */
  expiresAt: number;
  /** Which platform set this cookie. */
  platform: AntiBotPlatform;
  /** Whether this cookie is currently valid. */
  isValid: boolean;
  /** How many times this cookie has been used. */
  useCount: number;
}

// ===============================================================================
// BYPASS RESULT
// ===============================================================================

/** Unified result type for all bypass operations. */
export interface AntiBotResult {
  /** Whether the bypass was successful. */
  success: boolean;
  /** Which platform was targeted. */
  platform: AntiBotPlatform;
  /** Which strategy was used. */
  strategy: BypassStrategy;
  /** Current phase of the challenge lifecycle. */
  phase: ChallengePhase;
  /** How long the bypass took (ms). */
  durationMs: number;
  /** Cookies obtained from the bypass. */
  cookies: ManagedCookie[];
  /** Extra headers to inject into subsequent requests. */
  extraHeaders: Record<string, string>;
  /** Detection signals that were found. */
  detectionSignals: DetectionIndicator[];
  /** Whether a re-challenge is expected. */
  rechallengeExpected: boolean;
  /** Time until re-challenge is expected (ms). 0 = unknown. */
  rechallengeInMs: number;
  /** Errors encountered during bypass. */
  errors: string[];
  /** Warnings (non-fatal issues). */
  warnings: string[];
  /** Arbitrary metadata from platform-specific modules. */
  metadata: Record<string, unknown>;
}

// ===============================================================================
// PLATFORM PROFILE (ADAPTIVE LEARNING)
// ===============================================================================

/** Per-domain adaptive learning profile for a specific platform. */
export interface PlatformProfile {
  /** The domain this profile covers. */
  domain: string;
  /** Which anti-bot platform this profile is for. */
  platform: AntiBotPlatform;
  /** Number of successful bypasses. */
  successCount: number;
  /** Number of failed bypasses. */
  failCount: number;
  /** Running success rate (0-1). */
  successRate: number;
  /** Average solve time in ms. */
  avgSolveTimeMs: number;
  /** The strategy that worked best for this domain. */
  preferredStrategy: BypassStrategy;
  /** Last time this domain was successfully bypassed. */
  lastSuccessAt: number;
  /** Last time a bypass was attempted. */
  lastAttemptAt: number;
  /** Consecutive failures -- used for cooldown decisions. */
  consecutiveFailures: number;
  /** Current cooldown until next attempt (epoch ms). */
  cooldownUntil: number;
  /** Platform-specific challenge version detected. */
  challengeVersion: string;
  /** Known cookie names for this domain/platform. */
  knownCookieNames: string[];
  /** Known header names for this domain/platform. */
  knownHeaderNames: string[];
  /** Average token lifetime in ms. */
  avgTokenLifetimeMs: number;
  /** Arbitrary platform-specific data. */
  extra: Record<string, unknown>;
}

// ===============================================================================
// CONFIGURATION
// ===============================================================================

/** Per-platform configuration. */
export interface AntiBotPlatformConfig {
  /** Whether this platform module is enabled. */
  enabled: boolean;
  /** Maximum number of solve attempts before escalation. */
  maxAttempts: number;
  /** Timeout for each solve attempt (ms). */
  solveTimeoutMs: number;
  /** Token freshness threshold (ms). Tokens older than this are refreshed. */
  tokenFreshnessMs: number;
  /** Cooldown after consecutive failures (ms). */
  failureCooldownMs: number;
  /** Maximum consecutive failures before entering deep cooldown. */
  maxConsecutiveFailures: number;
  /** Deep cooldown duration after max failures (ms). */
  deepCooldownMs: number;
  /** Whether to cache tokens in Redis. */
  cacheTokens: boolean;
  /** Redis TTL for cached tokens (seconds). */
  cacheTtlSeconds: number;
  /** Whether to track per-domain profiles. */
  trackProfiles: boolean;
  /** Minimum confidence level to trigger bypass (0-1). */
  detectionThreshold: number;
}

/** Default configs per platform. */
export const DEFAULT_PLATFORM_CONFIGS: Record<AntiBotPlatform, AntiBotPlatformConfig> = {
  kasada: {
    enabled: true,
    maxAttempts: 3,
    solveTimeoutMs: 30000,
    tokenFreshnessMs: 300000,
    failureCooldownMs: 10000,
    maxConsecutiveFailures: 5,
    deepCooldownMs: 60000,
    cacheTokens: true,
    cacheTtlSeconds: 300,
    trackProfiles: true,
    detectionThreshold: 0.4,
  },
  akamai: {
    enabled: true,
    maxAttempts: 3,
    solveTimeoutMs: 25000,
    tokenFreshnessMs: 600000,
    failureCooldownMs: 15000,
    maxConsecutiveFailures: 4,
    deepCooldownMs: 120000,
    cacheTokens: true,
    cacheTtlSeconds: 600,
    trackProfiles: true,
    detectionThreshold: 0.5,
  },
  cloudflare: {
    enabled: true,
    maxAttempts: 3,
    solveTimeoutMs: 20000,
    tokenFreshnessMs: 1800000,
    failureCooldownMs: 8000,
    maxConsecutiveFailures: 3,
    deepCooldownMs: 60000,
    cacheTokens: true,
    cacheTtlSeconds: 1800,
    trackProfiles: true,
    detectionThreshold: 0.3,
  },
  datadome: {
    enabled: true,
    maxAttempts: 3,
    solveTimeoutMs: 20000,
    tokenFreshnessMs: 600000,
    failureCooldownMs: 12000,
    maxConsecutiveFailures: 4,
    deepCooldownMs: 90000,
    cacheTokens: true,
    cacheTtlSeconds: 600,
    trackProfiles: true,
    detectionThreshold: 0.4,
  },
  perimeterx: {
    enabled: true,
    maxAttempts: 3,
    solveTimeoutMs: 25000,
    tokenFreshnessMs: 300000,
    failureCooldownMs: 10000,
    maxConsecutiveFailures: 5,
    deepCooldownMs: 90000,
    cacheTokens: true,
    cacheTtlSeconds: 300,
    trackProfiles: true,
    detectionThreshold: 0.4,
  },
  imperva: {
    enabled: true,
    maxAttempts: 3,
    solveTimeoutMs: 30000,
    tokenFreshnessMs: 600000,
    failureCooldownMs: 12000,
    maxConsecutiveFailures: 4,
    deepCooldownMs: 90000,
    cacheTokens: true,
    cacheTtlSeconds: 600,
    trackProfiles: true,
    detectionThreshold: 0.4,
  },
  f5: {
    enabled: true,
    maxAttempts: 3,
    solveTimeoutMs: 35000,
    tokenFreshnessMs: 300000,
    failureCooldownMs: 15000,
    maxConsecutiveFailures: 4,
    deepCooldownMs: 120000,
    cacheTokens: true,
    cacheTtlSeconds: 300,
    trackProfiles: true,
    detectionThreshold: 0.45,
  },
  generic: {
    enabled: true,
    maxAttempts: 2,
    solveTimeoutMs: 15000,
    tokenFreshnessMs: 300000,
    failureCooldownMs: 5000,
    maxConsecutiveFailures: 3,
    deepCooldownMs: 30000,
    cacheTokens: false,
    cacheTtlSeconds: 0,
    trackProfiles: false,
    detectionThreshold: 0.5,
  },
};

// ===============================================================================
// BROWSER SESSION CONTEXT
// ===============================================================================

/** Context passed to all bypass operations -- wraps Playwright primitives. */
export interface BypassContext {
  /** The Playwright Page to operate on. */
  page: Page;
  /** The BrowserContext for cookie/storage operations. */
  context: BrowserContext;
  /** Optional CDP session for low-level operations. */
  cdpSession?: CDPSession;
  /** The URL being accessed. */
  url: string;
  /** The domain extracted from the URL. */
  domain: string;
  /** The platform that was detected (set by the manager). */
  detectedPlatform?: AntiBotPlatform;
  /** The detection confidence (set by the manager). */
  detectionConfidence?: number;
  /** Whether this is a re-challenge attempt. */
  isRechallenge?: boolean;
  /** Previous result (if re-challenging). */
  previousResult?: AntiBotResult;
}

// ===============================================================================
// PLATFORM MODULE INTERFACE
// ===============================================================================

/** Interface that every platform-specific module must implement. */
export interface IAntiBotModule {
  /** The platform this module handles. */
  readonly platform: AntiBotPlatform;

  /** Initialize the module (load caches, set up listeners, etc.). */
  initialize(): Promise<void>;

  /** Detect if this platform's anti-bot is active on the page. */
  detect(ctx: BypassContext): Promise<PlatformDetectionResult>;

  /** Attempt to bypass the anti-bot challenge. */
  bypass(ctx: BypassContext, strategy?: BypassStrategy): Promise<AntiBotResult>;

  /** Check if cached tokens/cookies are still valid for a domain. */
  hasValidTokens(domain: string): boolean;

  /** Invalidate all cached tokens/cookies for a domain. */
  invalidateTokens(domain: string): void;

  /** Get the adaptive profile for a domain. */
  getProfile(domain: string): PlatformProfile | null;

  /** Get module statistics. */
  getStats(): Record<string, unknown>;
}

// ===============================================================================
// MANAGER TYPES
// ===============================================================================

/** Configuration for the central Anti-Bot Manager. */
export interface AntiBotManagerConfig {
  /** Which platform modules to enable. */
  enabledPlatforms: AntiBotPlatform[];
  /** Per-platform overrides. */
  platformOverrides: Partial<Record<AntiBotPlatform, Partial<AntiBotPlatformConfig>>>;
  /** Global detection threshold. Overrides per-platform if set. */
  globalDetectionThreshold?: number;
  /** Whether to auto-escalate strategies on failure. */
  autoEscalate: boolean;
  /** Maximum number of strategy escalations before giving up. */
  maxEscalations: number;
  /** Whether to log detailed detection signals. */
  verboseLogging: boolean;
}

/** Statistics from the Anti-Bot Manager. */
export interface AntiBotManagerStats {
  totalBypassAttempts: number;
  successfulBypasses: number;
  failedBypasses: number;
  overallSuccessRate: number;
  platformStats: Record<AntiBotPlatform, {
    attempts: number;
    successes: number;
    failures: number;
    successRate: number;
    avgSolveTimeMs: number;
  }>;
  activeDomains: number;
  cachedTokens: number;
}
