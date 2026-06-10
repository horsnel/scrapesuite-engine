/**
 * Google Account Warmer Types — ScrapeSuite Engine
 *
 * Type definitions for the Google account warming system.
 * Google's anti-bot detection heavily relies on account reputation —
 * aged accounts with real browsing history get higher reCAPTCHA scores
 * and face fewer challenges. This system manages the lifecycle of
 * Google accounts from creation through warming to operational use.
 *
 * Key concepts:
 * - Account Age: Older accounts are more trusted
 * - Behavioral History: Accounts with realistic browsing patterns score higher
 * - reCAPTCHA Scores: Aged accounts typically get 0.9+ vs new accounts getting 0.3-0.5
 * - Session Depth: Accounts that have navigated multiple Google services are more trusted
 * - Geographic Consistency: Accounts should consistently appear from the same region
 */

// ===============================================================================
// ACCOUNT TYPES
// ===============================================================================

export type AccountStatus = 'created' | 'warming' | 'ready' | 'active' | 'cooling' | 'flagged' | 'suspended' | 'expired';
export type AccountTier = 'basic' | 'aged' | 'premium' | 'enterprise';
export type WarmupPhase = 'creation' | 'verification' | 'initial_browsing' | 'service_onboarding' | 'depth_building' | 'trust_earning' | 'operational';
export type ServiceType = 'search' | 'gmail' | 'youtube' | 'maps' | 'shopping' | 'scholar' | 'news' | 'drive' | 'photos' | 'translate' | 'play_store';
export type ActivityType = 'search_query' | 'page_visit' | 'video_watch' | 'map_search' | 'email_read' | 'file_upload' | 'app_install' | 'review_post' | 'account_setting';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface GoogleAccount {
  /** Unique account ID */
  id: string;
  /** Google email address */
  email: string;
  /** Encrypted password hash (never stored in plaintext) */
  passwordHash: string;
  /** Account creation timestamp */
  createdAt: number;
  /** Current account status */
  status: AccountStatus;
  /** Account tier based on age and reputation */
  tier: AccountTier;
  /** Current warmup phase */
  warmupPhase: WarmupPhase;
  /** Assigned geographic region (for consistency) */
  geoRegion: string;
  /** Assigned proxy endpoint ID */
  proxyEndpointId: string;
  /** Device fingerprint ID assigned to this account */
  fingerprintId: string;
  /** Last time this account was used */
  lastUsedAt: number;
  /** Total number of sessions */
  totalSessions: number;
  /** Total browsing time in ms */
  totalBrowsingTimeMs: number;
  /** reCAPTCHA score achieved (0-1) */
  recaptchaScore: number;
  /** Health score (0-100) */
  healthScore: number;
  /** Risk level based on recent activity */
  riskLevel: RiskLevel;
  /** Services this account has interacted with */
  servicesUsed: ServiceType[];
  /** Number of Google services deeply used (5+ interactions) */
  deepServiceCount: number;
  /** Whether the account has completed email verification */
  emailVerified: boolean;
  /** Whether the account has a phone number attached */
  hasPhoneNumber: boolean;
  /** Account age in days */
  ageDays: number;
  /** Session history summary */
  sessionHistory: AccountSession[];
  /** Activity log for the last 30 days */
  recentActivity: ActivityRecord[];
  /** Custom metadata */
  metadata: Record<string, any>;
}

export interface AccountSession {
  /** Session ID */
  id: string;
  /** When the session started */
  startedAt: number;
  /** When the session ended */
  endedAt: number | null;
  /** Duration in ms */
  durationMs: number;
  /** Services visited during this session */
  servicesVisited: ServiceType[];
  /** Pages visited */
  pagesVisited: number;
  /** Searches performed */
  searchesPerformed: number;
  /** Whether reCAPTCHA was encountered */
  recaptchaEncountered: boolean;
  /** reCAPTCHA score if encountered */
  recaptchaScore: number | null;
  /** Whether the session was flagged */
  flagged: boolean;
  /** Proxy IP used for this session */
  proxyIp: string;
}

export interface ActivityRecord {
  /** Activity type */
  type: ActivityType;
  /** Timestamp */
  timestamp: number;
  /** Service the activity was on */
  service: ServiceType;
  /** Duration of activity in ms */
  durationMs: number;
  /** Whether this activity was successful (no bot detection) */
  success: boolean;
  /** Any error or flag message */
  message?: string;
}

// ===============================================================================
// WARMUP STRATEGY TYPES
// ===============================================================================

export interface WarmupSchedule {
  /** Phase of the warmup */
  phase: WarmupPhase;
  /** Day in the warmup timeline (0-indexed) */
  startDay: number;
  /** Duration of this phase in days */
  durationDays: number;
  /** Activities to perform during this phase */
  activities: WarmupActivity[];
  /** Minimum time between activities (ms) */
  minActivityGap: number;
  /** Maximum number of activities per day */
  maxActivitiesPerDay: number;
  /** Target session duration range (ms) */
  sessionDurationRange: [number, number];
  /** Whether to include CAPTCHA-prone activities */
  includeCaptchaRisk: boolean;
}

export interface WarmupActivity {
  /** Activity type */
  type: ActivityType;
  /** Service to target */
  service: ServiceType;
  /** How often to perform this activity (per day) */
  frequency: number;
  /** Time of day range to perform (hours, 0-24) */
  timeOfDayRange: [number, number];
  /** Duration range for this activity (ms) */
  durationRange: [number, number];
  /** Whether this is a high-risk activity (might trigger detection) */
  highRisk: boolean;
  /** Specific parameters for the activity */
  parameters: Record<string, any>;
}

export interface WarmupPlan {
  /** Plan ID */
  id: string;
  /** Account tier this plan targets */
  targetTier: AccountTier;
  /** Total warmup duration in days */
  totalDays: number;
  /** Schedule phases */
  phases: WarmupSchedule[];
  /** Success criteria for warmup completion */
  completionCriteria: {
    minAgeDays: number;
    minHealthScore: number;
    minRecaptchaScore: number;
    minServicesUsed: number;
    minDeepServiceCount: number;
    minTotalSessions: number;
  };
}

// ===============================================================================
// HEALTH & RISK TYPES
// ===============================================================================

export interface HealthAssessment {
  /** Account ID */
  accountId: string;
  /** Overall health score (0-100) */
  healthScore: number;
  /** Component scores */
  components: {
    ageScore: number;        // 0-100, based on account age
    activityScore: number;   // 0-100, based on activity frequency
    diversityScore: number;  // 0-100, based on service diversity
    consistencyScore: number;// 0-100, based on geo/session consistency
    recaptchaScore: number;  // 0-100, based on reCAPTCHA scores
    riskScore: number;       // 0-100, inverse of risk (100 = no risk)
  };
  /** Risk level */
  riskLevel: RiskLevel;
  /** Issues identified */
  issues: HealthIssue[];
  /** Recommendations */
  recommendations: string[];
  /** Assessment timestamp */
  assessedAt: number;
}

export interface HealthIssue {
  /** Issue severity */
  severity: 'info' | 'warning' | 'critical';
  /** Issue category */
  category: 'age' | 'activity' | 'diversity' | 'consistency' | 'recaptcha' | 'risk';
  /** Description */
  description: string;
  /** Suggested remediation */
  remediation: string;
}

// ===============================================================================
// POOL MANAGEMENT TYPES
// ===============================================================================

export interface AccountPoolConfig {
  /** Minimum number of ready accounts to maintain */
  minReadyAccounts: number;
  /** Maximum number of accounts in the pool */
  maxAccounts: number;
  /** Minimum age for an account to be considered "ready" (days) */
  minReadyAgeDays: number;
  /** Target reCAPTCHA score for ready accounts */
  targetRecaptchaScore: number;
  /** Maximum accounts to warm in parallel */
  maxParallelWarming: number;
  /** Cool-down period after flagging (hours) */
  flagCooldownHours: number;
  /** Maximum usage per day per account */
  maxUsagePerDay: number;
  /** Account rotation strategy */
  rotationStrategy: 'round_robin' | 'least_used' | 'highest_health' | 'random';
  /** Geographic regions for account assignment */
  targetRegions: string[];
}

export interface AccountAllocation {
  /** Allocated account */
  account: GoogleAccount;
  /** Proxy endpoint to use */
  proxyEndpointId: string;
  /** Fingerprint to use */
  fingerprintId: string;
  /** Maximum session duration (ms) */
  maxSessionDuration: number;
  /** Whether this is a high-risk allocation (may encounter CAPTCHA) */
  highRisk: boolean;
  /** Allocation timestamp */
  allocatedAt: number;
}

// ===============================================================================
// CONFIG & STATS
// ===============================================================================

export interface AccountWarmerConfig {
  /** Account pool configuration */
  pool: AccountPoolConfig;
  /** Default warmup plan */
  defaultPlan: WarmupPlan;
  /** Health check interval (ms) */
  healthCheckInterval: number;
  /** Whether to auto-create new accounts when pool is low */
  autoProvision: boolean;
  /** Maximum provisioning rate (accounts per day) */
  maxProvisionRate: number;
  /** Whether to automatically retire flagged accounts */
  autoRetire: boolean;
  /** Minimum health score before retirement */
  retirementHealthThreshold: number;
  /** Notification webhook URL */
  notificationWebhook: string | null;
  /** Debug mode */
  debugMode: boolean;
}

export interface AccountWarmerStats {
  totalAccounts: number;
  byStatus: Record<AccountStatus, number>;
  byTier: Record<AccountTier, number>;
  byRegion: Record<string, number>;
  averageHealthScore: number;
  averageRecaptchaScore: number;
  averageAgeDays: number;
  accountsReady: number;
  accountsWarming: number;
  accountsFlagged: number;
  warmupCompletionRate: number;
  averageWarmupDurationDays: number;
  recentFlagRate: number;
  poolUtilization: number;
}
