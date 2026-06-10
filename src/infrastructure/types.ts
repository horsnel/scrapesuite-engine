/**
 * Infrastructure Types — ScrapeSuite Engine
 *
 * Core type definitions for the infrastructure layer that powers
 * Netflix and Google scraping at scale. This module provides types
 * for proxy farms, IP reputation, browser farms, session management,
 * and mobile emulation — the backbone of enterprise-grade scraping.
 */

// ===============================================================================
// PROXY FARM TYPES
// ===============================================================================

export type ProxyTier = 'datacenter' | 'residential' | 'mobile' | 'isp';
export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';
export type ProxyProvider = 'brightdata' | 'oxylabs' | 'smartproxy' | 'iproyal' | 'webshare' | 'packetstream' | 'geonode' | 'custom';
export type ProxyHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'blacklisted' | 'cooldown' | 'retired';

export interface ProxyEndpoint {
  id: string;
  url: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol: ProxyProtocol;
  tier: ProxyTier;
  provider: ProxyProvider;
  countryCode: string;
  city?: string;
  asn?: string;
  isp?: string;
  health: ProxyHealthStatus;
  /** Number of consecutive successes */
  successStreak: number;
  /** Number of consecutive failures */
  failureStreak: number;
  /** Lifetime success count */
  totalSuccesses: number;
  /** Lifetime failure count */
  totalFailures: number;
  /** Average response time in ms */
  avgResponseMs: number;
  /** Last health check timestamp */
  lastHealthCheck: number;
  /** Last successful request timestamp */
  lastSuccess: number;
  /** Last failure timestamp */
  lastFailure: number;
  /** Current active connections */
  activeConnections: number;
  /** Maximum concurrent connections allowed */
  maxConnections: number;
  /** Cost per GB of traffic */
  costPerGb: number;
  /** Total GB consumed */
  totalGbConsumed: number;
  /** Sticky session ID if assigned */
  sessionId?: string;
  /** Session expiry timestamp */
  sessionExpiry?: number;
  /** Whether this IP is currently flagged by any target */
  flaggedBy: string[];
  /** Cooldown until timestamp */
  cooldownUntil?: number;
  /** IP reputation score 0-100 */
  reputationScore: number;
  /** Created timestamp */
  createdAt: number;
}

export interface ProxyFarmConfig {
  /** Minimum pool size per tier */
  minPoolSize: Record<ProxyTier, number>;
  /** Maximum pool size per tier */
  maxPoolSize: Record<ProxyTier, number>;
  /** Health check interval in seconds */
  healthCheckInterval: number;
  /** Maximum failure streak before marking unhealthy */
  maxFailureStreak: number;
  /** Minimum success streak to restore from degraded */
  minSuccessStreak: number;
  /** Cooldown duration in seconds after failure streak */
  cooldownDuration: number;
  /** Maximum cost per day in USD */
  maxDailyCost: number;
  /** Preferred providers in priority order */
  providerPriority: ProxyProvider[];
  /** Geographic distribution targets: countryCode -> percentage */
  geoDistribution: Record<string, number>;
  /** Enable auto-provisioning to maintain pool sizes */
  autoProvisioning: boolean;
  /** Rotation strategy for default selection */
  defaultRotation: 'round-robin' | 'least-connections' | 'random' | 'weighted-reputation' | 'geo-targeted';
  /** Sticky session duration in seconds */
  stickySessionDuration: number;
}

export interface ProxyAllocationRequest {
  /** Target domain for domain-specific selection */
  domain?: string;
  /** Required tier */
  tier?: ProxyTier;
  /** Required country code */
  countryCode?: string;
  /** Required city */
  city?: string;
  /** Required ASN */
  asn?: string;
  /** Whether to use sticky session */
  stickySession?: boolean;
  /** Maximum response time acceptable in ms */
  maxResponseMs?: number;
  /** Minimum reputation score required */
  minReputation?: number;
  /** Exclude specific proxy IDs */
  excludeIds?: string[];
  /** Maximum cost per GB acceptable */
  maxCostPerGb?: number;
}

export interface ProxyAllocationResult {
  proxy: ProxyEndpoint;
  stickySessionId?: string;
  expiresAt?: number;
  allocationId: string;
}

// ===============================================================================
// IP REPUTATION TYPES
// ===============================================================================

export type IPReputationLevel = 'pristine' | 'clean' | 'acceptable' | 'suspicious' | 'flagged' | 'blacklisted';

export interface IPReputationRecord {
  ip: string;
  reputationLevel: IPReputationLevel;
  reputationScore: number; // 0-100
  /** Which domains have flagged this IP */
  flaggedByDomains: Record<string, { timestamp: number; reason: string }>;
  /** Block rate per domain (0-1) */
  blockRateByDomain: Record<string, number>;
  /** Overall block rate (0-1) */
  overallBlockRate: number;
  /** Success rate per domain (0-1) */
  successRateByDomain: Record<string, number>;
  /** Total requests made from this IP */
  totalRequests: number;
  /** DNS leak test passed */
  dnsLeakSafe: boolean;
  /** WebRTC leak test passed */
  webrtcLeakSafe: boolean;
  /** Whether IP is a known datacenter IP */
  isDatacenter: boolean;
  /** Whether IP is a known proxy/VPN IP */
  isProxy: boolean;
  /** Geographic data */
  geoData: IPGeoData;
  /** First seen timestamp */
  firstSeen: number;
  /** Last used timestamp */
  lastUsed: number;
  /** Burn rate: requests per minute that triggered blocks */
  burnRate: number;
  /** Maximum safe requests per minute before block risk increases */
  maxSafeRPM: number;
  /** Recovery time needed after block (seconds) */
  recoveryTime: number;
  /** Last block timestamp */
  lastBlock?: number;
  /** Auto-retirement: whether this IP should be avoided */
  shouldRetire: boolean;
}

export interface IPGeoData {
  ip: string;
  countryCode: string;
  countryName: string;
  city: string;
  region: string;
  latitude: number;
  longitude: number;
  timezone: string;
  isp: string;
  org: string;
  asn: string;
  asName: string;
  connectionType: 'dialup' | 'cable' | 'fiber' | 'mobile' | 'satellite' | 'corporate' | 'unknown';
}

export interface IPReputationConfig {
  /** Minimum reputation score to use an IP */
  minReputationScore: number;
  /** Block rate threshold for flagging (0-1) */
  blockRateThreshold: number;
  /** Number of blocks before auto-retirement */
  blocksBeforeRetirement: number;
  /** Cooldown after a block in seconds */
  blockCooldown: number;
  /** Whether to test DNS leaks */
  testDnsLeaks: boolean;
  /** Whether to test WebRTC leaks */
  testWebrtcLeaks: boolean;
  /** Auto-provision replacements for retired IPs */
  autoReplaceRetired: boolean;
  /** Maximum requests per minute per IP globally */
  globalMaxRPM: number;
  /** Domain-specific RPM limits */
  domainRPMLimits: Record<string, number>;
  /** Netflix-specific RPM limit */
  netflixRPM: number;
  /** Google-specific RPM limit */
  googleRPM: number;
}

export interface IPReputationReport {
  totalIPs: number;
  byReputationLevel: Record<IPReputationLevel, number>;
  byTier: Record<ProxyTier, number>;
  averageReputation: number;
  averageBlockRate: number;
  retiredIPs: number;
  flaggedIPs: number;
  domainSpecific: Record<string, { blockRate: number; avgReputation: number }>;
  recommendations: string[];
}

// ===============================================================================
// BROWSER FARM TYPES
// ===============================================================================

export type BrowserInstanceStatus = 'warming' | 'ready' | 'busy' | 'recycling' | 'crashed' | 'retired';
export type BrowserType = 'chromium' | 'firefox' | 'webkit';
export type StealthLevel = 'basic' | 'light' | 'medium' | 'high' | 'maximum';

export interface BrowserInstance {
  id: string;
  browserType: BrowserType;
  status: BrowserInstanceStatus;
  stealthLevel: StealthLevel;
  /** Playwright Browser object reference (not serialized) */
  browser?: any;
  /** Active context */
  context?: any;
  /** Active page */
  page?: any;
  /** Assigned proxy endpoint */
  proxyId?: string;
  /** Assigned fingerprint ID */
  fingerprintId?: string;
  /** Assigned profile name */
  profileName?: string;
  /** Request count on this instance */
  requestCount: number;
  /** Maximum requests before recycling */
  maxRequests: number;
  /** Crash count */
  crashCount: number;
  /** Memory usage in MB */
  memoryUsage: number;
  /** Created timestamp */
  createdAt: number;
  /** Last used timestamp */
  lastUsed: number;
  /** Warm-up completion timestamp */
  warmedUpAt?: number;
  /** Browsing history URLs (for warm-up realism) */
  browsingHistory: string[];
  /** Cookie jar state */
  hasCookies: boolean;
  /** Whether session is authenticated on any domain */
  authenticatedDomains: string[];
  /** Resource usage stats */
  cpuUsage: number;
  /** Network bytes sent */
  bytesSent: number;
  /** Network bytes received */
  bytesReceived: number;
}

export interface BrowserFarmConfig {
  /** Minimum pool size */
  minPoolSize: number;
  /** Maximum pool size */
  maxPoolSize: number;
  /** Browser type distribution */
  browserDistribution: Record<BrowserType, number>;
  /** Stealth level for new instances */
  defaultStealthLevel: StealthLevel;
  /** Maximum requests per instance before recycling */
  maxRequestsPerInstance: number;
  /** Warm-up duration in seconds */
  warmUpDuration: number;
  /** Warm-up browsing targets for realistic history */
  warmUpTargets: string[];
  /** Memory limit per instance in MB */
  memoryLimitMB: number;
  /** Auto-scale when pool utilization exceeds this percentage */
  scaleUpThreshold: number;
  /** Auto-scale down when pool utilization drops below this percentage */
  scaleDownThreshold: number;
  /** Maximum crash count before instance retirement */
  maxCrashCount: number;
  /** Headless mode */
  headless: boolean | 'new';
  /** Pre-warm instances on startup */
  preWarm: boolean;
  /** Number of pre-warmed instances to maintain */
  preWarmCount: number;
}

export interface BrowserAllocationRequest {
  /** Required browser type */
  browserType?: BrowserType;
  /** Required stealth level */
  stealthLevel?: StealthLevel;
  /** Target domain for domain-specific assignment */
  domain?: string;
  /** Whether the browser needs to be pre-authenticated */
  requiresAuth?: boolean;
  /** Required proxy tier */
  proxyTier?: ProxyTier;
  /** Required country */
  countryCode?: string;
  /** Maximum wait time in ms for a ready browser */
  maxWaitMs?: number;
  /** Specific fingerprint to assign */
  fingerprintId?: string;
}

export interface BrowserAllocationResult {
  instance: BrowserInstance;
  allocationId: string;
}

// ===============================================================================
// SESSION FARM TYPES
// ===============================================================================

export type SessionStatus = 'initializing' | 'active' | 'paused' | 'expired' | 'failed' | 'blocked';
export type SessionType = 'anonymous' | 'authenticated' | 'premium';

export interface SessionRecord {
  id: string;
  status: SessionStatus;
  type: SessionType;
  /** Target domain */
  domain: string;
  /** Assigned proxy ID */
  proxyId: string;
  /** Assigned browser instance ID */
  browserInstanceId: string;
  /** Assigned fingerprint ID */
  fingerprintId: string;
  /** Cookies for this session (serialized) */
  cookies: Record<string, string>;
  /** localStorage snapshot */
  localStorage: Record<string, string>;
  /** Session-specific headers */
  customHeaders: Record<string, string>;
  /** User agent used for this session */
  userAgent: string;
  /** Referrer chain for this session */
  referrerChain: string[];
  /** Pages visited in this session */
  pagesVisited: string[];
  /** Total requests made in this session */
  requestCount: number;
  /** Session start timestamp */
  startedAt: number;
  /** Last activity timestamp */
  lastActivity: number;
  /** Session expiry timestamp */
  expiresAt: number;
  /** Authentication credentials (encrypted reference) */
  authRef?: string;
  /** Session health score 0-100 */
  healthScore: number;
  /** Whether any block was detected in this session */
  wasBlocked: boolean;
  /** Session duration in seconds */
  duration: number;
  /** Metadata */
  metadata: Record<string, any>;
}

export interface SessionFarmConfig {
  /** Maximum concurrent sessions */
  maxConcurrentSessions: number;
  /** Default session duration in seconds */
  defaultSessionDuration: number;
  /** Netflix-specific session duration */
  netflixSessionDuration: number;
  /** Google-specific session duration */
  googleSessionDuration: number;
  /** Session health check interval in seconds */
  healthCheckInterval: number;
  /** Whether to persist sessions across restarts */
  persistSessions: boolean;
  /** Maximum requests per session before rotation */
  maxRequestsPerSession: number;
  /** Netflix-specific max requests per session */
  netflixMaxRequests: number;
  /** Google-specific max requests per session */
  googleMaxRequests: number;
  /** Auto-rotate sessions that show signs of detection */
  autoRotate: boolean;
  /** Referrer chain templates per domain */
  referrerTemplates: Record<string, string[][]>;
  /** Whether to warm up new sessions with realistic browsing */
  warmUpSessions: boolean;
  /** Warm-up page count for new sessions */
  warmUpPageCount: number;
}

// ===============================================================================
// MOBILE EMULATION TYPES
// ===============================================================================

export type MobilePlatform = 'ios' | 'android';
export type MobileDevice = 'iphone-15-pro' | 'iphone-15' | 'iphone-14-pro' | 'iphone-14' | 'iphone-se' |
  'samsung-s24-ultra' | 'samsung-s24' | 'samsung-s23' | 'samsung-a54' |
  'pixel-8-pro' | 'pixel-8' | 'pixel-7a' |
  'oneplus-12' | 'xiaomi-14' | 'huawei-p60';

export interface MobileProfile {
  id: string;
  device: MobileDevice;
  platform: MobilePlatform;
  /** User agent string */
  userAgent: string;
  /** Screen dimensions */
  screen: { width: number; height: number; dpr: number };
  /** CPU core count */
  cpuCores: number;
  /** Memory in GB */
  memoryGB: number;
  /** GPU renderer string */
  gpuRenderer: string;
  /** Browser version */
  browserVersion: string;
  /** OS version */
  osVersion: string;
  /** Carrier name */
  carrier: string;
  /** Mobile country code */
  mcc: string;
  /** Mobile network code */
  mnc: string;
  /** Connection type */
  connectionType: '4g' | '5g' | 'wifi' | '3g';
  /** Downlink speed in Mbps */
  downlinkMbps: number;
  /** Round-trip time in ms */
  rttMs: number;
  /** Touch support */
  touchSupport: boolean;
  /** Max touch points */
  maxTouchPoints: number;
  /** Device pixel ratio */
  devicePixelRatio: number;
  /** Color depth */
  colorDepth: number;
  /** Supported media queries */
  mediaQueries: string[];
  /** WebGL vendor */
  webglVendor: string;
  /** Platform string */
  platformString: string;
  /** Vendor string */
  vendor: string;
  /** Battery level (for realism) */
  batteryLevel: number;
  /** Language */
  language: string;
  /** Timezone */
  timezone: string;
  /** Installable plugins (usually empty on mobile) */
  plugins: string[];
}

export interface MobileEmulationConfig {
  /** Default platform */
  defaultPlatform: MobilePlatform;
  /** Device distribution for random selection */
  deviceDistribution: Record<MobileDevice, number>;
  /** Carrier configurations by country */
  carrierConfig: Record<string, { name: string; mcc: string; mnc: string }[]>;
  /** Connection type distribution */
  connectionDistribution: Record<string, number>;
  /** Whether to emulate battery API */
  emulateBattery: boolean;
  /** Whether to emulate network information API */
  emulateNetworkInfo: boolean;
  /** Whether to emulate touch events */
  emulateTouch: boolean;
  /** Screen orientation lock */
  orientation: 'portrait' | 'landscape' | 'any';
}

// ===============================================================================
// INFRASTRUCTURE STATS
// ===============================================================================

export interface InfrastructureStats {
  proxyFarm: {
    totalEndpoints: number;
    healthyEndpoints: number;
    byTier: Record<ProxyTier, number>;
    byProvider: Record<ProxyProvider, number>;
    byCountry: Record<string, number>;
    avgResponseMs: number;
    avgReputation: number;
    dailyCost: number;
  };
  ipReputation: {
    totalTracked: number;
    byLevel: Record<IPReputationLevel, number>;
    avgScore: number;
    retiredCount: number;
    flaggedCount: number;
  };
  browserFarm: {
    totalInstances: number;
    readyInstances: number;
    busyInstances: number;
    byType: Record<BrowserType, number>;
    avgMemoryMB: number;
    totalCrashes: number;
  };
  sessionFarm: {
    totalSessions: number;
    activeSessions: number;
    byDomain: Record<string, number>;
    byStatus: Record<SessionStatus, number>;
    avgHealthScore: number;
    avgSessionDuration: number;
  };
  mobileEmulation: {
    totalProfiles: number;
    byPlatform: Record<MobilePlatform, number>;
    byDevice: Record<MobileDevice, number>;
  };
}
