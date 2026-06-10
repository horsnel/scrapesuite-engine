/**
 * Akamai Types — ScrapeSuite Engine
 *
 * Type definitions for the Akamai Enterprise bypass module.
 * Netflix uses Akamai Bot Manager which collects sensor data,
 * performs behavioral analysis, and uses ML models to detect bots.
 */

// ===============================================================================
// SENSOR DATA TYPES
// ===============================================================================

export type SensorType = '1st_party_pixel' | '2nd_party_pixel' | '3rd_party_script' | 'hydra';
export type SensorVersion = '2.0' | '3.0' | '4.0' | '5.0';

export interface SensorDataConfig {
  /** Akamai pixel script URL for the target domain */
  pixelUrl: string;
  /** Sensor data version to generate */
  version: SensorVersion;
  /** Whether to include mouse movement data */
  includeMouseData: boolean;
  /** Whether to include keyboard timing data */
  includeKeyboardData: boolean;
  /** Whether to include touch event data */
  includeTouchData: boolean;
  /** Whether to include device orientation data */
  includeOrientationData: boolean;
  /** Mouse event count to simulate */
  mouseEventCount: number;
  /** Keyboard event count to simulate */
  keyboardEventCount: number;
  /** Session duration to simulate (ms) */
  simulatedSessionDuration: number;
  /** Page load timestamp offset (ms) */
  pageLoadOffset: number;
}

export interface SensorPayload {
  /** Encoded sensor data string */
  data: string;
  /** Sensor version used */
  version: SensorVersion;
  /** Timestamp of generation */
  timestamp: number;
  /** Request ID this payload is for */
  requestId: string;
  /** Whether this payload passed local validation */
  validated: boolean;
  /** Session identifier */
  sessionId: string;
  /** Page URL where sensor was "collected" */
  pageUrl: string;
}

export interface MouseEventData {
  type: 'mousemove' | 'click' | 'mousedown' | 'mouseup' | 'mouseover' | 'mouseout';
  timestamp: number;
  x: number;
  y: number;
  button?: number;
  target?: string;
}

export interface KeyboardEventData {
  type: 'keydown' | 'keyup' | 'keypress';
  timestamp: number;
  key: string;
  code: string;
  keyCode: number;
}

// ===============================================================================
// HYDRA CHALLENGE TYPES
// ===============================================================================

export type HydraChallengeType = 'script_generation' | 'image_classification' | 'proof_of_work' | 'behavioral';
export type HydraPhase = 'detection' | 'challenge' | 'validation' | 'completion';

export interface HydraChallenge {
  id: string;
  type: HydraChallengeType;
  phase: HydraPhase;
  /** Challenge script URL */
  scriptUrl?: string;
  /** Challenge parameters (varies by type) */
  parameters: Record<string, any>;
  /** Timestamp when challenge was received */
  receivedAt: number;
  /** Time limit in ms */
  timeLimit: number;
  /** Number of attempts remaining */
  attemptsRemaining: number;
  /** Domain that issued the challenge */
  domain: string;
}

export interface HydraSolution {
  challengeId: string;
  /** Solution data (format depends on challenge type) */
  solution: string | Record<string, any>;
  /** Time taken to solve in ms */
  solveTimeMs: number;
  /** Whether the solution was validated */
  validated: boolean;
  /** Result cookie or token if successful */
  resultToken?: string;
}

export interface HydraConfig {
  /** Maximum time to spend on a single challenge (ms) */
  maxSolveTime: number;
  /** Maximum retry attempts per challenge */
  maxRetries: number;
  /** Whether to use AI-assisted solving */
  aiAssisted: boolean;
  /** Challenge type success rates (for adaptive strategy) */
  challengeSuccessRates: Record<HydraChallengeType, number>;
  /** Whether to fall back to browser-based solving on failure */
  fallbackToBrowser: boolean;
}

// ===============================================================================
// BOT MANAGER EVADER TYPES
// ===============================================================================

export type BotDetectionMethod = 'sensor_analysis' | 'behavioral_ml' | 'fingerprint_mismatch' | 'tls_analysis' | 'header_analysis' | 'cookie_analysis' | 'rate_limiting' | 'ip_reputation';
export type EvasionStrategy = 'sensor_spoofing' | 'behavior_mimicry' | 'fingerprint_consistency' | 'tls_matching' | 'header_normalization' | 'cookie_simulation' | 'rate_adaptation' | 'ip_rotation';

export interface BotDetection {
  method: BotDetectionMethod;
  confidence: number; // 0-1
  indicators: string[];
  timestamp: number;
  domain: string;
}

export interface EvasionResult {
  strategy: EvasionStrategy;
  applied: boolean;
  effectiveness: number; // 0-1
  details: string;
}

export interface BotManagerEvaderConfig {
  /** Detection methods to prioritize evading */
  priorityMethods: BotDetectionMethod[];
  /** Minimum confidence threshold before taking evasive action */
  detectionConfidenceThreshold: number;
  /** Whether to proactively apply evasions or only react */
  proactiveEvasion: boolean;
  /** Maximum evasion actions per request */
  maxEvasionsPerRequest: number;
  /** Learning mode: track which evasions work for which domains */
  learningMode: boolean;
  /** Domain-specific evasion profiles */
  domainProfiles: Record<string, EvasionStrategy[]>;
}

// ===============================================================================
// AKAMAI MANAGER TYPES
// ===============================================================================

export interface AkamaiConfig {
  sensorData: SensorDataConfig;
  hydra: HydraConfig;
  evader: BotManagerEvaderConfig;
  /** Whether to cache successful sensor payloads */
  cachePayloads: boolean;
  /** Cache TTL for successful payloads (seconds) */
  payloadCacheTTL: number;
  /** Whether to log detailed sensor data for debugging */
  debugMode: boolean;
  /** Netflix-specific sensor configuration overrides */
  netflixOverrides?: Partial<SensorDataConfig>;
  /** Google-specific sensor configuration overrides */
  googleOverrides?: Partial<SensorDataConfig>;
}

export interface AkamaiStats {
  sensorPayloadsGenerated: number;
  sensorPayloadsSucceeded: number;
  hydraChallengesReceived: number;
  hydraChallengesSolved: number;
  hydraChallengesFailed: number;
  evasionsApplied: number;
  evasionsSucceeded: number;
  detectionAvoided: number;
  detectionEncountered: number;
  byDomain: Record<string, {
    successRate: number;
    avgSolveTime: number;
    challengeTypes: Record<HydraChallengeType, number>;
  }>;
}
