// ===== Job Types =====
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type JobStrategy = 'cache' | 'http' | 'browser' | 'auto' | 'stealth-browser';
export type PlanTier = 'starter' | 'pro' | 'business';

export interface ScrapeRequest {
  url: string;
  extract?: string;
  strategy?: JobStrategy;
  cacheTtl?: number;
  proxyTier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  proxyCountry?: string;
  proxyCity?: string;
  proxyAsn?: string;
  sessionId?: string;         // Sticky session ID
  waitForSelector?: string;
  headers?: Record<string, string>;
  timeout?: number;
  respectRobotsTxt?: boolean;
  structured?: boolean;
  renderJs?: boolean;
  solveCaptcha?: boolean;     // Auto-solve CAPTCHAs
  templateId?: string;        // Pre-built extraction template ID
  outputFormat?: 'raw' | 'markdown' | 'cleaned' | 'text' | 'parsed';  // Output format
}

export interface ScrapeResult {
  id: string;
  url: string;
  domain: string;
  status: JobStatus;
  strategy: JobStrategy;
  creditsUsed: number;
  creditsCharged: number;
  statusCode?: number;
  responseMs: number;
  html?: string;
  extracted?: Record<string, any>;
  structuredData?: Record<string, any>;
  error?: string;
  cached: boolean;
  proxyId?: string;
  proxyCountry?: string;
  captchaSolved?: boolean;
  bandwidthBytes?: number;
  finalUrl?: string;
  timestamp: string;
  outputFormat?: 'raw' | 'markdown' | 'cleaned' | 'text' | 'parsed';  // Applied output format
  outputCompressionRatio?: number;  // Compression ratio from output pipeline
}

export interface BatchScrapeRequest {
  urls: string[];
  extract?: string;
  strategy?: JobStrategy;
  cacheTtl?: number;
  proxyTier?: 'residential' | 'mobile' | 'datacenter' | 'isp';
  proxyCountry?: string;
  proxyCity?: string;
  waitForSelector?: string;
  headers?: Record<string, string>;
  timeout?: number;
  respectRobotsTxt?: boolean;
  structured?: boolean;
  concurrency?: number;
  templateId?: string;        // Pre-built extraction template ID
  outputFormat?: 'raw' | 'markdown' | 'cleaned' | 'text' | 'parsed';  // Output format
}

export interface ExtractRequest {
  html: string;
  url?: string;
  instruction: string;
}

export interface ExtractResult {
  data: Record<string, any> | null;
  confidence: number;
  schemaMatch: boolean;
  tokensUsed: number;
  error?: string;
}

// ===== Schema Learning Types =====

export interface LearnedSchema {
  id: string;
  domain: string;
  instructionHash: string;
  schema: Record<string, any>;
  exampleOutput: Record<string, any> | null;
  uses: number;
  lastSuccess: string | null;
  createdAt: string;
}

// ===== Monitor Types =====

export interface MonitorRequest {
  url: string;
  fields: string[];
  schedule: string;
  alertThresholds?: {
    field: string;
    operator: 'gt' | 'lt' | 'eq' | 'neq' | 'change';
    value?: number | string;
  }[];
  webhookUrl?: string;
}

export interface MonitorResult {
  id: string;
  url: string;
  active: boolean;
  lastRun: string | null;
  schedule: string;
  fields: string[];
}

export interface SnapshotData {
  [field: string]: any;
}

// ===== Domain Intelligence Types =====

export interface DomainProfile {
  domain: string;
  requiresBrowser: boolean;
  browserConfidence: number;
  optimalProxyTier: 'residential' | 'mobile' | 'datacenter' | 'isp';
  safeRps: number;
  avgResponseMs: number;
  successRate: number;
  sampleCount: number;
  hasCloudflare: boolean;
  hasDatadome: boolean;
  hasAkamai: boolean;
  hasPerimeterX: boolean;
  hasImperva: boolean;
  requiresJs: boolean;
  requiresCaptcha: boolean;
  avgPageSizeKb: number;
  cacheTtlSeconds: number;
  robotsTxtAllowed: boolean;
  lastUpdated: string;
}

export interface StrategyRecommendation {
  strategy: 'http' | 'browser' | 'stealth-browser';
  proxyTier: 'residential' | 'mobile' | 'datacenter' | 'isp';
  cacheTtl: number;
  safeRps: number;
  confidence: number;
}

// ===== Proxy Types =====

export interface ProxyInfo {
  id: string;
  url: string;
  tier: 'residential' | 'mobile' | 'datacenter' | 'isp';
  country: string;
  city?: string;
  asn?: string;
  isp?: string;
  provider: string;
  successRate: number;
  p95Latency: number;
}

export interface ProxyOutcome {
  proxyId: string;
  domain: string;
  success: boolean;
  statusCode?: number;
  latencyMs: number;
}

// ===== Anti-Bot Types =====

export interface AntiBotDetection {
  cloudflare: boolean;
  cloudflareVariant: 'challenge' | 'turnstile' | 'managed' | 'none';
  datadome: boolean;
  akamai: boolean;
  perimeterX: boolean;
  imperva: boolean;
  reCaptcha: boolean;
  hCaptcha: boolean;
  confidenceScore: number;
}

// ===== Credit Types =====

export const CREDIT_COSTS = {
  CACHE_HIT: 0,
  HTTP_SCRAPE: 1,
  BROWSER_RENDER: 5,
  STEALTH_BROWSER: 8,
  NL_EXTRACTION: 3,
  STRUCTURED_PARSE: 2,
  LEAD_ENRICHMENT: 10,
  MONITOR_CHECK: 1,
  BATCH_PER_URL: 1,
  SERP_API: 5,
  CAPTCHA_SOLVE: 3,
} as const;

export const PLAN_CREDITS = {
  starter: 10000,
  pro: 500000,
  business: 5000000,
} as const;

export const PLAN_PRICES = {
  starter: 0,
  pro: 49,
  business: 249,
} as const;

// ===== Queue Types =====

export const QUEUE_NAMES = {
  SCRAPE: 'scrape',
  MONITOR: 'monitor',
  ENRICH: 'enrich',
} as const;

export interface ScrapeJobData {
  jobId: string;
  url: string;
  domain: string;
  userId: string;
  apiKeyId: string;
  extract?: string;
  strategy?: JobStrategy;
  proxyTier?: string;
  proxyCountry?: string;
  proxyCity?: string;
  proxyAsn?: string;
  sessionId?: string;
  waitForSelector?: string;
  headers?: Record<string, string>;
  timeout?: number;
  cacheTtl?: number;
  respectRobotsTxt?: boolean;
  structured?: boolean;
  renderJs?: boolean;
  solveCaptcha?: boolean;
  batchId?: string;
  priority: number;
  templateId?: string;        // Pre-built extraction template ID
  outputFormat?: 'raw' | 'markdown' | 'cleaned' | 'text' | 'parsed';  // Output format
}

export interface ScrapeJobResult {
  jobId: string;
  status: JobStatus;
  strategy: JobStrategy;
  html?: string;
  extracted?: Record<string, any>;
  structuredData?: Record<string, any>;
  statusCode?: number;
  responseMs: number;
  error?: string;
  creditsUsed: number;
  creditsCharged: number;
  proxyId?: string;
  proxyCountry?: string;
  captchaSolved?: boolean;
  cached: boolean;
  bandwidthBytes?: number;
  finalUrl?: string;
  outputFormat?: 'raw' | 'markdown' | 'cleaned' | 'text' | 'parsed';  // Applied output format
  outputCompressionRatio?: number;  // Compression ratio from output pipeline
}

// ===== API Response Types =====

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  creditsUsed?: number;
  creditsRemaining?: number;
}

export interface PaginatedResponse<T = any> extends ApiResponse<T> {
  total: number;
  page: number;
  pageSize: number;
}

// ===== Analytics Types =====

export interface UsageSummary {
  period: string;
  httpRequests: number;
  browserRequests: number;
  cacheHits: number;
  nlExtractions: number;
  structuredRequests: number;
  monitorChecks: number;
  serpRequests: number;
  captchaSolves: number;
  creditsUsed: number;
  creditsCharged: number;
  successRate: number;
  avgResponseMs: number;
  uniqueDomains: number;
  topDomains: { domain: string; requests: number; successRate: number }[];
}
