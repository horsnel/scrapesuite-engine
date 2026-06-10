/**
 * Fusion Reactor Types -- ScrapeSuite Engine
 *
 * Nuclear Fusion Chain Reaction System for Real-Time Anti-Bot Counter-Measures.
 *
 * Architecture (ULTRA-OPTIMIZED v2):
 *  +----------------------------------------------------------------------+
 *  |                    FUSION REACTOR CORE                                |
 *  |                                                                      |
 *  |  SIGNAL DETECTOR ──► FUSION CELL ──► CHAIN PROPAGATOR               |
 *  |       │                   │                   │                       |
 *  |       │  DETECT <0.3ms   │  REACT <0.5ms    │  CASCADE <15ms       |
 *  |       │                   │                   │                       |
 *  |       ▼                   ▼                   ▼                       |
 *  |  DetectionEvent    ReactionResult    PropagationWave                 |
 *  |       │                   │                   │                       |
 *  |       └───────────────────┼───────────────────┘                       |
 *  |                           ▼                                          |
 *  |                  REACTION ENGINE                                      |
 *  |          (composite index: category:platform → rules)                |
 *  |                           │                                          |
 *  |                           ▼                                          |
 *  |                  PLASMA STATE MANAGER                                 |
 *  |          (pre-compiled Sets, bitfield severity, ID pools)            |
 *  +----------------------------------------------------------------------+
 *
 * Performance Budgets (v2 ULTRA-OPTIMIZED):
 *  - Signal Detection:   <0.3ms  (was <2ms)   — 6.7x faster
 *  - Reaction Generation: <0.5ms (was <3ms)   — 6x faster
 *  - First Reaction:     <1ms    (was <5ms)   — 5x faster
 *  - Full Cascade:       <15ms   (was <50ms)  — 3.3x faster
 *  - Learning:           <0.1ms  (was <1ms)   — 10x faster
 *
 * Key Concepts:
 *  - Fusion Cell: Atomic unit that detects a signal and reacts in <1ms
 *  - Chain Reaction: When one reaction triggers related reactions (cascade)
 *  - Plasma State: Hot in-memory rule set with pre-compiled composite indexes
 *  - Critical Mass: When enough signals fire simultaneously → maximum response
 *  - Neutron Economy: Each successful reaction fuels future reactions
 *  - Containment: Failed reactions are contained to prevent cascade failures
 */

// ===============================================================================
// CORE SIGNAL TYPES
// ===============================================================================

/** Categories of anti-bot signals that can be detected in real-time */
export type SignalCategory =
  | 'response_header'      // Anti-bot headers in HTTP response (cf-ray, x-akamai, etc.)
  | 'response_status'      // HTTP status codes (403, 429, 503 challenge pages)
  | 'response_body'        // Challenge page HTML/JS content
  | 'response_cookie'      // Anti-bot cookie set (__cf_bm, _abck, etc.)
  | 'response_timing'      // Unusual response timing patterns
  | 'javascript_challenge' // JS challenge execution required
  | 'captcha_present'      // CAPTCHA widget detected on page
  | 'fingerprint_probe'    // Browser fingerprinting script detected
  | 'behavioral_monitor'   // Behavioral analysis script (mouse/keyboard tracking)
  | 'rate_limit'           // Rate limiting triggered
  | 'ip_block'             // IP blocked or flagged
  | 'session_invalid'      // Session cookies/tokens invalidated
  | 'tls_mismatch'         // TLS fingerprint doesn't match claimed browser
  | 'dns_redirection'      // DNS-level challenge or redirect
  | 'websocket_challenge'  // WebSocket-based verification
  | 'api_signature_fail'   // API request signature rejected (X-Bogus, etc.)
  | 'device_registration'  // Device registration required
  | 'token_expired'        // Session/token expired mid-request
  | 'behavioral_anomaly'   // Behavioral ML model flagged activity
  | 'sensor_validation';   // Sensor data rejected (Akamai, etc.)

/** Severity of a detected signal */
export type SignalSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** Confidence of signal detection (0-1) */
export type SignalConfidence = number;

/** A single detected anti-bot signal */
export interface DetectionSignal {
  /** Unique signal ID */
  id: string;
  /** Category of the signal */
  category: SignalCategory;
  /** Which anti-bot platform generated this signal */
  platform: AntiBotPlatform;
  /** Domain where signal was detected */
  domain: string;
  /** URL where signal was detected */
  url: string;
  /** Severity level */
  severity: SignalSeverity;
  /** Detection confidence (0-1) */
  confidence: SignalConfidence;
  /** Human-readable description */
  description: string;
  /** Raw data that triggered the signal */
  rawData?: Record<string, unknown>;
  /** Timestamp of detection (epoch ms) */
  timestamp: number;
  /** Request ID this signal belongs to */
  requestId: string;
  /** Session ID this signal belongs to */
  sessionId?: string;
}

// ===============================================================================
// REACTION TYPES
// ===============================================================================

/** Types of reactions the fusion reactor can produce */
export type ReactionType =
  | 'rotate_proxy'           // Switch to a different proxy immediately
  | 'rotate_fingerprint'     // Switch browser fingerprint profile
  | 'rotate_tls_profile'     // Switch TLS fingerprint profile
  | 'inject_headers'         // Inject/modify HTTP headers
  | 'inject_cookies'         // Inject/modify cookies
  | 'solve_challenge'        // Solve JS/CAPTCHA challenge
  | 'adjust_timing'          // Adjust request timing (slow down/speed up)
  | 'simulate_behavior'      // Trigger behavioral simulation
  | 'generate_sensor'        // Generate anti-bot sensor data
  | 'sign_request'           // Apply platform-specific request signature
  | 'refresh_token'          // Refresh expired session/token
  | 'register_device'        // Register new device identity
  | 'escalate_stealth'       // Increase stealth level
  | 'switch_session'         // Switch to a different session
  | 'modify_user_agent'      // Change User-Agent string
  | 'clear_traces'           // Clear browser traces (localStorage, etc.)
  | 'simulate_human_wait'    // Add human-like wait before retry
  | 'generate_proof_of_work' // Generate proof-of-work response
  | 'replay_interaction'     // Replay a previous successful interaction sequence
  | 'activate_maximum_stealth'; // Activate all stealth measures simultaneously

/** Priority of a reaction (higher = execute first) */
export type ReactionPriority = 'low' | 'normal' | 'high' | 'critical' | 'nuclear';

/** Status of a reaction */
export type ReactionStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'skipped' | 'contained';

/** A reaction produced by the fusion reactor */
export interface Reaction {
  /** Unique reaction ID */
  id: string;
  /** Type of reaction */
  type: ReactionType;
  /** Priority level */
  priority: ReactionPriority;
  /** Which signal triggered this reaction */
  triggeredBy: string; // DetectionSignal.id
  /** Target domain */
  domain: string;
  /** Target platform */
  platform: AntiBotPlatform;
  /** Reaction parameters (type-specific) */
  params: ReactionParams;
  /** Execution status */
  status: ReactionStatus;
  /** Time to execute this reaction (ms from now) */
  executeInMs: number;
  /** How long the reaction took (ms) */
  executionTimeMs?: number;
  /** Whether this reaction should trigger cascade reactions */
  shouldCascade: boolean;
  /** Cascade delay (ms after this reaction completes) */
  cascadeDelayMs: number;
  /** Confidence this reaction will help (0-1) */
  confidence: number;
  /** Estimated effectiveness based on historical data (0-1) */
  estimatedEffectiveness: number;
  /** Errors encountered during execution */
  errors: string[];
  /** Timestamp when reaction was created */
  createdAt: number;
  /** Timestamp when reaction was executed */
  executedAt?: number;
}

/** Parameters for different reaction types */
export interface ReactionParams {
  /** Proxy rotation parameters */
  proxy?: {
    tier?: 'datacenter' | 'residential' | 'mobile' | 'isp';
    country?: string;
    avoidCurrentIp?: boolean;
  };
  /** Fingerprint rotation parameters */
  fingerprint?: {
    profileName?: string;
    domain?: string;
    forceNew?: boolean;
  };
  /** TLS profile parameters */
  tls?: {
    profileName?: string;
    matchBrowser?: string;
  };
  /** Header injection parameters */
  headers?: Record<string, string>;
  /** Cookie injection parameters */
  cookies?: Array<{ name: string; value: string; domain: string }>;
  /** Challenge solving parameters */
  challenge?: {
    type: 'js' | 'captcha' | 'turnstile' | 'hydra' | 'proof_of_work';
    timeout?: number;
    maxRetries?: number;
  };
  /** Timing adjustment parameters */
  timing?: {
    action: 'slow_down' | 'speed_up' | 'pause' | 'burst';
    factor?: number; // multiplier
    durationMs?: number;
  };
  /** Behavior simulation parameters */
  behavior?: {
    type: 'mouse_move' | 'typing' | 'scroll' | 'click' | 'full_browse';
    intensity: 'minimal' | 'normal' | 'heavy';
    durationMs?: number;
  };
  /** Sensor data parameters */
  sensor?: {
    platform: 'akamai' | 'perimeterx' | 'generic';
    domain: string;
  };
  /** Request signing parameters */
  signature?: {
    platform: 'tiktok' | 'youtube' | 'reddit' | 'generic';
    algorithm: string;
    endpoint?: string;
  };
  /** Token refresh parameters */
  token?: {
    type: 'session' | 'api_key' | 'jwt' | 'platform_token';
    refreshEndpoint?: string;
  };
  /** Stealth escalation parameters */
  stealth?: {
    level: 'basic' | 'enhanced' | 'maximum' | 'nuclear';
    measures: string[];
  };
  /** Wait parameters */
  wait?: {
    minMs: number;
    maxMs: number;
    simulateReading?: boolean;
  };
}

// ===============================================================================
// CHAIN REACTION / CASCADE TYPES
// ===============================================================================

/** A cascade wave that propagates reactions */
export interface PropagationWave {
  /** Unique wave ID */
  id: string;
  /** The initial signal that started this wave */
  rootSignalId: string;
  /** Domain this wave is propagating on */
  domain: string;
  /** Platform being countered */
  platform: AntiBotPlatform;
  /** Current wave depth (0 = initial reaction, 1 = first cascade, etc.) */
  depth: number;
  /** Maximum cascade depth allowed */
  maxDepth: number;
  /** All reactions in this wave, in execution order */
  reactions: Reaction[];
  /** Currently executing reaction index */
  currentReactionIndex: number;
  /** Wave status */
  status: 'propagating' | 'completed' | 'failed' | 'contained';
  /** Total wave execution time so far (ms) */
  totalExecutionTimeMs: number;
  /** Whether the wave achieved its goal (request succeeded) */
  goalAchieved: boolean;
  /** Wave started at */
  startedAt: number;
  /** Wave completed at */
  completedAt?: number;
}

/** Chain reaction rule that defines when reactions should cascade */
export interface ChainReactionRule {
  /** Rule ID */
  id: string;
  /** Name of the rule */
  name: string;
  /** Description */
  description: string;
  /** Signal categories that trigger this rule */
  triggerCategories: SignalCategory[];
  /** Minimum severity to trigger */
  minSeverity: SignalSeverity;
  /** Reaction types to produce */
  reactionTypes: ReactionType[];
  /** Cascade rules: what additional reactions to trigger */
  cascades: CascadeRule[];
  /** Platforms this rule applies to */
  applicablePlatforms: AntiBotPlatform[];
  /** Domains this rule applies to (empty = all) */
  applicableDomains: string[];
  /** Priority of this rule */
  priority: ReactionPriority;
  /** Whether this rule is enabled */
  enabled: boolean;
  /** Historical success rate of this rule (0-1) */
  successRate: number;
  /** How many times this rule has been triggered */
  triggerCount: number;
  /** How many times this rule led to a successful bypass */
  successCount: number;
  /** Last time this rule was triggered */
  lastTriggeredAt?: number;
}

/** Cascade rule within a chain reaction rule */
export interface CascadeRule {
  /** Reaction type to cascade into */
  reactionType: ReactionType;
  /** Delay after parent reaction completes (ms) */
  delayMs: number;
  /** Condition for cascade to trigger */
  condition: 'always' | 'on_success' | 'on_failure' | 'on_critical';
  /** Priority of the cascaded reaction */
  priority: ReactionPriority;
  /** Additional cascade rules from this reaction */
  subCascades: CascadeRule[];
}

// ===============================================================================
// PLASMA STATE (HOT RULES)
// ===============================================================================

/** A hot rule in the plasma state, ready for instant matching */
export interface PlasmaRule {
  /** The chain reaction rule */
  rule: ChainReactionRule;
  /** Pre-computed signal category lookup key */
  signalKey: string;
  /** Last time this rule was matched */
  lastMatchedAt: number;
  /** How many times matched in current plasma session */
  matchCount: number;
  /** Average reaction time for this rule (ms) */
  avgReactionTimeMs: number;
  /** Temperature of this rule (hot = frequently used) */
  temperature: 'hot' | 'warm' | 'cold';
  /** Whether this rule is currently loaded in plasma state */
  active: boolean;
}

/** The complete plasma state of the fusion reactor */
export interface PlasmaState {
  /** All hot rules currently loaded */
  rules: PlasmaRule[];
  /** Signal category → plasma rule index (for O(1) lookup) */
  signalIndex: Map<string, PlasmaRule[]>;
  /** Domain → plasma rules (for domain-specific fast path) */
  domainIndex: Map<string, PlasmaRule[]>;
  /** Platform → plasma rules (for platform-specific fast path) */
  platformIndex: Map<string, PlasmaRule[]>;
  /** Total plasma state size in bytes (approximate) */
  sizeBytes: number;
  /** Last time plasma state was refreshed */
  lastRefreshedAt: number;
  /** Plasma temperature (overall system activity) */
  coreTemperature: number; // 0-100
  /** Whether critical mass has been reached */
  criticalMass: boolean;
}

// ===============================================================================
// FUSION REACTOR STATUS
// ===============================================================================

/** Anti-bot platforms the fusion reactor can counter */
export type AntiBotPlatform =
  | 'akamai'
  | 'cloudflare'
  | 'datadome'
  | 'perimeterx'
  | 'imperva'
  | 'f5_shape'
  | 'kasada'
  | 'google'
  | 'recaptcha'
  | 'tiktok_anti'
  | 'reddit_anti'
  | 'generic';

/** Overall fusion reactor status */
export interface FusionReactorStatus {
  /** Whether the reactor is running */
  running: boolean;
  /** Current core temperature (0-100) */
  coreTemperature: number;
  /** Whether critical mass has been reached */
  criticalMass: boolean;
  /** Number of active propagation waves */
  activeWaves: number;
  /** Number of plasma rules loaded */
  plasmaRuleCount: number;
  /** Total signals detected */
  totalSignalsDetected: number;
  /** Total reactions executed */
  totalReactionsExecuted: number;
  /** Total cascade waves triggered */
  totalCascadeWaves: number;
  /** Average reaction time (ms) */
  avgReactionTimeMs: number;
  /** Average cascade completion time (ms) */
  avgCascadeTimeMs: number;
  /** Overall reaction success rate */
  reactionSuccessRate: number;
  /** Neutron economy */
  neutronEconomy: NeutronEconomy;
  /** Last signal detected at */
  lastSignalAt?: number;
  /** Uptime in ms */
  uptimeMs: number;
}

/** Neutron economy tracks the energy flow of the fusion reactor */
export interface NeutronEconomy {
  /** Total neutrons produced (successful reactions) */
  totalProduced: number;
  /** Total neutrons consumed (reactions attempted) */
  totalConsumed: number;
  /** Active neutrons available for cascading */
  active: number;
  /** Neutron multiplier (amplification factor) */
  multiplier: number;
  /** Whether the reaction is self-sustaining */
  selfSustaining: boolean;
  /** Energy output rate (reactions per second) */
  energyOutput: number;
}

/** Configuration for the fusion reactor */
export interface FusionReactorConfig {
  /** Maximum cascade depth */
  maxCascadeDepth: number;
  /** Reaction timeout (ms) */
  reactionTimeoutMs: number;
  /** Plasma state refresh interval (ms) */
  plasmaRefreshIntervalMs: number;
  /** Signal deduplication window (ms) */
  signalDedupeWindowMs: number;
  /** Maximum concurrent waves per domain */
  maxConcurrentWavesPerDomain: number;
  /** Critical mass threshold (active waves) */
  criticalMassThreshold: number;
  /** Neutron multiplier base */
  neutronMultiplierBase: number;
  /** Whether to auto-escalate on repeated failures */
  autoEscalate: boolean;
  /** Minimum time between reactions of same type on same domain (ms) */
  reactionCooldownMs: number;
  /** Learning mode: conservative, balanced, aggressive */
  learningMode: 'conservative' | 'balanced' | 'aggressive';
}

/** Default configuration */
export const DEFAULT_FUSION_REACTOR_CONFIG: FusionReactorConfig = {
  maxCascadeDepth: 5,
  reactionTimeoutMs: 5000,
  plasmaRefreshIntervalMs: 60000,
  signalDedupeWindowMs: 1000,
  maxConcurrentWavesPerDomain: 3,
  criticalMassThreshold: 10,
  neutronMultiplierBase: 2.0,
  autoEscalate: true,
  reactionCooldownMs: 500,
  learningMode: 'balanced',
};
