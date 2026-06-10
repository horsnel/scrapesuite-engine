/**
 * Self-Improving Engine Types — ScrapeSuite Engine
 *
 * Type definitions for the self-improving AI system that learns
 * from every scraping attempt — both successes and failures.
 * This is the "brain" of the engine that makes it progressively
 * better at bypassing anti-bot defenses over time.
 *
 * Core concept: The Feedback Loop
 * 1. Attempt → Scrape a URL with specific strategies
 * 2. Observe → Record success/failure and all context
 * 3. Analyze → Identify what worked and what didn't
 * 4. Learn → Update strategy weights and rules
 * 5. Adapt → Apply learned knowledge to next attempts
 * 6. Validate → Test adapted strategies to confirm improvement
 *
 * The system maintains separate learning models per domain and
 * anti-bot platform, since Netflix's Akamai requires different
 * strategies than Google's reCAPTCHA Enterprise.
 */

// ===============================================================================
// OBSERVATION TYPES
// ===============================================================================

export type Outcome = 'success' | 'blocked' | 'captcha' | 'timeout' | 'rate_limited' | 'fingerprint_detected' | 'session_expired' | 'proxy_blocked' | 'tls_rejected' | 'behavioral_flag';
export type AntiBotPlatform = 'akamai' | 'cloudflare' | 'google_bot_detection' | 'recaptcha_enterprise' | 'datadome' | 'kasada' | 'perimeterx' | 'imperva' | 'f5_shape' | 'generic';
export type StrategyCategory = 'proxy' | 'fingerprint' | 'behavior' | 'tls' | 'header' | 'cookie' | 'timing' | 'session' | 'captcha' | 'sensor' | 'account';
export type LearningMode = 'conservative' | 'balanced' | 'aggressive';
export type AdaptationStatus = 'proposed' | 'testing' | 'validated' | 'deployed' | 'rejected' | 'rolled_back';

export interface ScrapingObservation {
  /** Unique observation ID */
  id: string;
  /** The URL that was scraped */
  url: string;
  /** The domain */
  domain: string;
  /** Timestamp of the attempt */
  timestamp: number;
  /** Outcome of the attempt */
  outcome: Outcome;
  /** Anti-bot platform that was detected (if any) */
  detectedPlatform: AntiBotPlatform | null;
  /** Strategies that were applied */
  strategiesApplied: AppliedStrategy[];
  /** Context of the attempt */
  context: ScrapingContext;
  /** Response details */
  response: ResponseDetails;
  /** Whether the observation has been analyzed */
  analyzed: boolean;
  /** Time taken for the attempt (ms) */
  durationMs: number;
}

export interface AppliedStrategy {
  /** Strategy category */
  category: StrategyCategory;
  /** Specific strategy name (e.g., "residential_proxy", "chrome_120_tls", "bezier_mouse") */
  name: string;
  /** Parameters used */
  parameters: Record<string, any>;
  /** Whether this strategy was effective */
  effective: boolean | null;
  /** Confidence in effectiveness assessment (0-1) */
  confidence: number;
}

export interface ScrapingContext {
  /** Proxy tier used */
  proxyTier: string;
  /** Proxy country */
  proxyCountry: string;
  /** Proxy ASN */
  proxyAsn: string;
  /** TLS profile used */
  tlsProfile: string;
  /** Device fingerprint ID */
  fingerprintId: string;
  /** Account ID used (if authenticated) */
  accountId: string | null;
  /** Session ID */
  sessionId: string;
  /** Request rate at time of attempt (RPM) */
  requestRate: number;
  /** Time since last request to this domain */
  timeSinceLastRequestMs: number;
  /** Number of previous requests to this domain from this IP */
  previousRequestCount: number;
  /** Browser type used */
  browserType: string;
  /** Whether headless mode was used */
  headless: boolean;
  /** Page URL before navigation (referrer) */
  referrerUrl: string | null;
}

export interface ResponseDetails {
  /** HTTP status code */
  statusCode: number;
  /** Response headers that indicate bot detection */
  detectionHeaders: Record<string, string>;
  /** Whether a CAPTCHA was present in the response */
  captchaPresent: boolean;
  /** CAPTCHA type detected */
  captchaType: string | null;
  /** Response body length */
  bodyLength: number;
  /** Whether the response contained the expected data */
  dataExtracted: boolean;
  /** Error message if failed */
  errorMessage: string | null;
  /** Akamai sensor version detected (if applicable) */
  akamaiSensorVersion: string | null;
  /** reCAPTCHA score received (if applicable) */
  recaptchaScore: number | null;
}

// ===============================================================================
// ANALYSIS TYPES
// ===============================================================================

export interface FailureAnalysis {
  /** Unique analysis ID */
  id: string;
  /** Observation that triggered this analysis */
  observationId: string;
  /** Domain analyzed */
  domain: string;
  /** Root cause category */
  rootCause: StrategyCategory;
  /** Specific root cause description */
  rootCauseDetail: string;
  /** Confidence in root cause identification (0-1) */
  confidence: number;
  /** Strategies that contributed to failure */
  failingStrategies: Array<{
    category: StrategyCategory;
    name: string;
    contributionScore: number; // 0-1, how much this strategy contributed to failure
    reason: string;
  }>;
  /** Strategies that helped mitigate */
  helpingStrategies: Array<{
    category: StrategyCategory;
    name: string;
    mitigationScore: number; // 0-1, how much this strategy helped
    reason: string;
  }>;
  /** Patterns identified across similar failures */
  patterns: FailurePattern[];
  /** Recommended adaptations */
  recommendations: AdaptationRecommendation[];
  /** Analysis timestamp */
  analyzedAt: number;
}

export interface FailurePattern {
  /** Pattern description */
  description: string;
  /** Number of times this pattern has been observed */
  occurrenceCount: number;
  /** Domains where this pattern appears */
  domains: string[];
  /** Anti-bot platforms associated with this pattern */
  platforms: AntiBotPlatform[];
  /** Statistical significance (0-1) */
  significance: number;
  /** When this pattern was first identified */
  firstIdentified: number;
  /** Whether this pattern is currently active */
  active: boolean;
}

export interface AdaptationRecommendation {
  /** Strategy category to modify */
  category: StrategyCategory;
  /** Current strategy */
  currentStrategy: string;
  /** Recommended new strategy */
  recommendedStrategy: string;
  /** Parameters to change */
  parameterChanges: Record<string, { from: any; to: any }>;
  /** Expected improvement (0-1) */
  expectedImprovement: number;
  /** Confidence in this recommendation (0-1) */
  confidence: number;
  /** Rationale */
  rationale: string;
  /** Risk level of this adaptation */
  riskLevel: 'low' | 'medium' | 'high';
}

// ===============================================================================
// LEARNING MODEL TYPES
// ===============================================================================

export interface StrategyWeight {
  /** Strategy category + name */
  strategyKey: string;
  /** Current effectiveness weight (0-1) */
  weight: number;
  /** Number of observations used to compute this weight */
  observationCount: number;
  /** Last time this weight was updated */
  lastUpdated: number;
  /** Success rate with this strategy */
  successRate: number;
  /** Domain this weight applies to (or '*' for global) */
  domain: string;
  /** Anti-bot platform this weight applies to (or '*' for all) */
  platform: string;
  /** Trend direction: improving, stable, or degrading */
  trend: 'improving' | 'stable' | 'degrading';
  /** Rate of change */
  trendRate: number;
}

export interface DomainModel {
  /** Domain name */
  domain: string;
  /** Known anti-bot platforms on this domain */
  platforms: AntiBotPlatform[];
  /** Strategy weights for this domain */
  strategyWeights: StrategyWeight[];
  /** Best-known strategy combination */
  bestStrategyCombo: AppliedStrategy[];
  /** Best-known success rate */
  bestSuccessRate: number;
  /** Known failure patterns for this domain */
  knownPatterns: FailurePattern[];
  /** Domain-specific rules */
  rules: DomainRule[];
  /** Last time this model was updated */
  lastUpdated: number;
  /** Total observations for this domain */
  totalObservations: number;
  /** Recent success rate (last 100 observations) */
  recentSuccessRate: number;
}

export interface DomainRule {
  /** Rule ID */
  id: string;
  /** Rule type */
  type: 'avoid' | 'prefer' | 'require' | 'limit' | 'schedule';
  /** Strategy category this rule applies to */
  category: StrategyCategory;
  /** Rule description */
  description: string;
  /** Rule parameters */
  parameters: Record<string, any>;
  /** Confidence in this rule (0-1) */
  confidence: number;
  /** How this rule was derived */
  derivedFrom: 'observation' | 'pattern' | 'analysis' | 'manual';
  /** When this rule was created */
  createdAt: number;
}

export interface Adaptation {
  /** Unique adaptation ID */
  id: string;
  /** Status of this adaptation */
  status: AdaptationStatus;
  /** Domain this adaptation targets */
  domain: string;
  /** Platform this adaptation targets */
  platform: AntiBotPlatform | null;
  /** Recommendation that triggered this adaptation */
  recommendationId: string;
  /** Changes to apply */
  changes: AdaptationChange[];
  /** Expected improvement */
  expectedImprovement: number;
  /** Actual improvement (measured after testing) */
  actualImprovement: number | null;
  /** Test results */
  testResults: AdaptationTestResult[];
  /** When this adaptation was proposed */
  proposedAt: number;
  /** When this adaptation was deployed */
  deployedAt: number | null;
}

export interface AdaptationChange {
  /** Strategy category */
  category: StrategyCategory;
  /** Previous value */
  previousValue: string;
  /** New value */
  newValue: string;
  /** Parameters changed */
  parameters: Record<string, { from: any; to: any }>;
}

export interface AdaptationTestResult {
  /** Test observation */
  observation: ScrapingObservation;
  /** Whether the test was a success */
  success: boolean;
  /** Improvement over baseline */
  improvement: number;
  /** Timestamp */
  timestamp: number;
}

// ===============================================================================
// SELF-IMPROVER CONFIG & STATS
// ===============================================================================

export interface SelfImproverConfig {
  /** Learning mode: conservative (slow, safe), balanced, aggressive (fast, risky) */
  learningMode: LearningMode;
  /** Minimum observations before making adaptations */
  minObservationsForAdaptation: number;
  /** Minimum confidence to deploy an adaptation */
  minConfidenceForDeploy: number;
  /** How many recent observations to consider for trend analysis */
  trendWindowSize: number;
  /** Weight decay factor (how quickly old observations lose influence) */
  weightDecay: number;
  /** Whether to auto-deploy validated adaptations */
  autoDeploy: boolean;
  /** Maximum number of adaptations per domain per day */
  maxAdaptationsPerDay: number;
  /** Domains to focus learning on */
  priorityDomains: string[];
  /** Whether to share learning across similar domains */
  crossDomainLearning: boolean;
  /** Minimum improvement to keep an adaptation */
  minImprovementThreshold: number;
  /** Observation retention period (days) */
  observationRetentionDays: number;
  /** Whether to export learned models */
  exportModels: boolean;
  /** Debug mode */
  debugMode: boolean;
}

export interface SelfImproverStats {
  totalObservations: number;
  observationsByOutcome: Record<Outcome, number>;
  totalAnalyses: number;
  totalAdaptations: number;
  adaptationsByStatus: Record<AdaptationStatus, number>;
  domainModelCount: number;
  averageSuccessRate: number;
  averageSuccessRateChange: number;
  recentAdaptationCount: number;
  recentImprovementRate: number;
  topImprovingDomains: Array<{ domain: string; improvement: number }>;
  topDegradingsDomains: Array<{ domain: string; degradation: number }>;
  learningVelocity: number; // Observations per hour
  modelAccuracy: number; // How well our predictions match reality
}
