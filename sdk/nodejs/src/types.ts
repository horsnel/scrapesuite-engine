/**
 * ScrapeSuite Node.js SDK -- TypeScript Type Definitions
 *
 * Comprehensive type definitions for all ScrapeSuite API request
 * and response types, error classes, and client configuration.
 *
 * @module scrapesuite/types
 * @version 1.0.0
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Client Configuration
// ═══════════════════════════════════════════════════════════════════════════════

/** Options for configuring the ScrapeSuite client. */
export interface ScrapeSuiteClientOptions {
  /** Base URL of the ScrapeSuite API. Default: https://api.scrapesuite.dev */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default: 30000 */
  timeout?: number;
  /** Number of automatic retries on transient errors. Default: 3 */
  retries?: number;
  /** Custom HTTP headers to include with every request. */
  defaultHeaders?: Record<string, string>;
  /** Custom fetch implementation (useful for testing or edge runtimes). */
  fetch?: typeof globalThis.fetch;
  /** User agent string for the SDK. Default: scrapesuite-node/1.0.0 */
  userAgent?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scraping -- Enums & Shared Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Strategy to use when scraping a URL. */
export type ScrapeStrategy = 'auto' | 'cache' | 'http' | 'browser' | 'stealth-browser';

/** Proxy tier for routing requests. */
export type ProxyTier = 'residential' | 'mobile' | 'datacenter' | 'isp';

/** Output format for scraped content. */
export type OutputFormat = 'raw' | 'markdown' | 'cleaned' | 'text' | 'parsed';

/** Job status values. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** Plan tier values. */
export type PlanTier = 'starter' | 'pro' | 'business';

// ═══════════════════════════════════════════════════════════════════════════════
// Scraping -- Request Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Options for the `scrape()` method. */
export interface ScrapeOptions {
  /** Scraping strategy. Default: 'auto' */
  strategy?: ScrapeStrategy;
  /** Proxy tier to use. */
  proxyTier?: ProxyTier;
  /** Two-letter country code for proxy geotargeting. */
  proxyCountry?: string;
  /** City-level proxy targeting (Business plan). */
  proxyCity?: string;
  /** ASN-level proxy targeting (Business plan). */
  proxyAsn?: string;
  /** Render JavaScript before extracting content. Default: false */
  renderJs?: boolean;
  /** Automatically solve CAPTCHAs. Default: false */
  solveCaptcha?: boolean;
  /** Output format for the scraped content. */
  outputFormat?: OutputFormat;
  /** CSS selector to wait for before extracting. */
  waitForSelector?: string;
  /** Per-request timeout in milliseconds (1000–120000). Default: 30000 */
  timeout?: number;
  /** Natural language extraction instruction. */
  extract?: string;
  /** Pre-built extraction template ID. */
  templateId?: string;
  /** Sticky session ID for persistent proxy/fingerprint. */
  sessionId?: string;
  /** Custom HTTP headers to send with the request. */
  headers?: Record<string, string>;
  /** Cache TTL in seconds (0–86400). */
  cacheTtl?: number;
  /** Respect robots.txt rules. Default: true */
  respectRobotsTxt?: boolean;
  /** Also parse structured data (schema.org, OG). Default: false */
  structured?: boolean;
}

/** Options for the `scrapeBatch()` method. */
export interface ScrapeBatchOptions extends Omit<ScrapeOptions, 'extract'> {
  /** Natural language extraction instruction applied to all URLs. */
  extract?: string;
  /** Max concurrent requests within the batch (1–10). Default: 3 */
  concurrency?: number;
}

/** Options for the `screenshot()` method. */
export interface ScreenshotOptions {
  /** Proxy tier to use. */
  proxyTier?: ProxyTier;
  /** Two-letter country code for proxy geotargeting. */
  proxyCountry?: string;
  /** Capture the full scrollable page. Default: false */
  fullPage?: boolean;
  /** CSS selector to wait for before capturing. */
  waitForSelector?: string;
  /** Per-request timeout in milliseconds (5000–60000). Default: 30000 */
  timeout?: number;
}

/** Options for the `crawl()` method. */
export interface CrawlOptions extends ScrapeOptions {
  /** Maximum number of pages to crawl. Default: 10 */
  maxPages?: number;
  /** Maximum crawl depth from the seed URL. Default: 3 */
  maxDepth?: number;
  /** Only follow links matching this glob pattern. */
  includePatterns?: string[];
  /** Skip links matching this glob pattern. */
  excludePatterns?: string[];
  /** Delay between requests in milliseconds. Default: 1000 */
  delayMs?: number;
  /** Concurrency for crawling. Default: 2 */
  concurrency?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scraping -- Response Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Response from the `scrape()` method (job submitted). */
export interface ScrapeResponse {
  /** Unique job ID. */
  id: string;
  /** Current job status. */
  status: JobStatus;
  /** The scraped URL. */
  url: string;
  /** Domain extracted from the URL. */
  domain: string;
  /** Strategy used. */
  strategy: ScrapeStrategy;
  /** Estimated credits for this job. */
  creditsEstimated: number;
  /** Proxy tier used. */
  proxyTier?: ProxyTier;
  /** Proxy country used. */
  proxyCountry?: string;
}

/** Full scrape result from `getJob()` / `getResult()`. */
export interface ScrapeResult {
  /** Unique job ID. */
  id: string;
  /** The scraped URL. */
  url: string;
  /** Domain extracted from the URL. */
  domain: string;
  /** Final job status. */
  status: JobStatus;
  /** Strategy used for scraping. */
  strategy: ScrapeStrategy;
  /** Credits consumed (total). */
  creditsUsed: number;
  /** Credits actually charged (only on success). */
  creditsCharged: number;
  /** HTTP status code of the response. */
  statusCode?: number;
  /** Response time in milliseconds. */
  responseMs: number;
  /** The scraped content (HTML, markdown, etc. based on outputFormat). */
  result?: string;
  /** Extracted data from NL instruction. */
  extractedData?: Record<string, any>;
  /** Structured data from schema.org / OG parsers. */
  structuredData?: Record<string, any>;
  /** Error message if the job failed. */
  error?: string;
  /** Whether the result was served from cache. */
  cached: boolean;
  /** Proxy ID used. */
  proxyId?: string;
  /** Country of the proxy used. */
  proxyCountry?: string;
  /** Whether a CAPTCHA was solved. */
  captchaSolved?: boolean;
  /** Bandwidth consumed in bytes. */
  bandwidthBytes?: number;
  /** Final URL after redirects. */
  finalUrl?: string;
  /** Completion timestamp. */
  completedAt?: string;
  /** Applied output format. */
  outputFormat?: OutputFormat;
}

/** Response from `scrapeBatch()`. */
export interface BatchScrapeResponse {
  /** Unique batch ID. */
  id: string;
  /** Total number of URLs in the batch. */
  totalJobs: number;
  /** Number of jobs successfully enqueued. */
  enqueued: number;
  /** Number of jobs that failed to enqueue. */
  failed: number;
  /** Individual job IDs and their statuses. */
  jobs: Array<{ id: string; status: JobStatus }>;
  /** Estimated total credits for the batch. */
  creditsEstimated: number;
}

/** Batch status from `getBatchStatus()`. */
export interface BatchStatus {
  /** Batch ID. */
  id: string;
  /** Total URLs in the batch. */
  totalJobs: number;
  /** Number of completed jobs. */
  completedJobs: number;
  /** Number of failed jobs. */
  failedJobs: number;
  /** Overall batch status. */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Total credits consumed. */
  creditsUsed: number;
  /** Individual job results. */
  jobs: Array<{
    id: string;
    url: string;
    status: JobStatus;
    strategy: ScrapeStrategy;
    creditsUsed: number;
    statusCode?: number;
    responseMs: number;
    error?: string;
    completedAt?: string;
  }>;
  /** When the batch was created. */
  createdAt: string;
  /** When the batch completed. */
  completedAt?: string;
}

/** Response from `screenshot()`. */
export interface ScreenshotResponse {
  /** The screenshot URL. */
  url: string;
  /** HTTP status code of the page. */
  statusCode: number;
  /** Response time in milliseconds. */
  responseMs: number;
  /** Base64-encoded PNG screenshot data. */
  screenshot: string;
  /** Image format (always 'png'). */
  format: 'png';
  /** Whether a full-page screenshot was taken. */
  fullPage: boolean;
  /** Credits charged for this screenshot. */
  creditsUsed: number;
}

/** Response from `crawl()`. */
export interface CrawlResponse {
  /** Crawl job ID. */
  id: string;
  /** Seed URL. */
  url: string;
  /** Current status of the crawl. */
  status: JobStatus;
  /** Number of pages discovered. */
  pagesDiscovered: number;
  /** Number of pages scraped. */
  pagesScraped: number;
  /** Pages data. */
  pages?: Array<ScrapeResult>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Data Extraction -- Request & Response Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Options for the `extract()` method. */
export interface ExtractOptions {
  /** Optional URL context for the extraction. */
  url?: string;
}

/** Response from the `extract()` method. */
export interface ExtractResponse {
  /** Extracted structured data. */
  data: Record<string, any> | null;
  /** Confidence score (0–1). */
  confidence: number;
  /** Whether the output matches a known schema. */
  schemaMatch: boolean;
  /** Number of AI tokens consumed. */
  tokensUsed: number;
  /** Credits charged. */
  creditsUsed: number;
  /** Remaining credits. */
  creditsRemaining: number;
}

/** Available structured data parsers. */
export type StructuredParser = 'auto' | 'article' | 'product' | 'amazon' | 'google' | 'generic';

/** Options for the `parseStructured()` method. */
export interface ParseStructuredOptions {
  /** Optional URL context for parser auto-detection. */
  url?: string;
}

/** Response from the `parseStructured()` method. */
export interface ParseStructuredResponse {
  /** Parsed structured data keyed by parser name. */
  data: Record<string, any>;
  /** Credits charged. */
  creditsUsed: number;
  /** Remaining credits. */
  creditsRemaining: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERP API -- Request & Response Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Search engine options. */
export type SearchEngine = 'google' | 'bing' | 'yahoo' | 'duckduckgo';

/** Options for the `serp()` method. */
export interface SerpOptions {
  /** Search engine to use. Default: 'google' */
  engine?: SearchEngine;
  /** Two-letter country code. Default: 'us' */
  country?: string;
  /** Language code. Default: 'en' */
  language?: string;
  /** Page number (1–10). Default: 1 */
  page?: number;
  /** Number of results per page (1–100). Default: 10 */
  numResults?: number;
  /** Proxy tier to use. */
  proxyTier?: ProxyTier;
  /** Proxy country for geotargeting. */
  proxyCountry?: string;
  /** Parse SERP results into structured data. Default: true */
  parse?: boolean;
}

/** A single organic search result. */
export interface OrganicResult {
  /** Position in the results. */
  position: number;
  /** Result title. */
  title: string;
  /** Result URL. */
  url: string;
  /** Result snippet/description. */
  snippet: string;
  /** Displayed URL. */
  displayedUrl?: string;
  /** Sitelinks if present. */
  sitelinks?: Array<{ title: string; url: string }>;
}

/** A paid ad result. */
export interface AdResult {
  /** Position in ads. */
  position: number;
  /** Ad title. */
  title: string;
  /** Ad URL. */
  url: string;
  /** Ad description. */
  snippet: string;
  /** Displayed URL. */
  displayedUrl?: string;
}

/** Response from the `serp()` method. */
export interface SerpResponse {
  /** The search query. */
  query: string;
  /** Engine used. */
  engine: SearchEngine;
  /** Organic search results. */
  organic: OrganicResult[];
  /** Paid advertisement results. */
  ads: AdResult[];
  /** Knowledge panel data if present. */
  knowledgePanel?: Record<string, any>;
  /** "People Also Ask" results. */
  peopleAlsoAsk?: string[];
  /** Related search queries. */
  relatedSearches?: string[];
  /** Total number of results reported by the engine. */
  totalResults?: number;
  /** Time taken for the query in seconds. */
  searchTime?: number;
  /** Whether the result was served from cache. */
  cached: boolean;
  /** Credits charged. */
  creditsUsed: number;
  /** Remaining credits. */
  creditsRemaining: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session Management -- Request & Response Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Options for the `createSession()` method. */
export interface CreateSessionOptions {
  /** Proxy tier for the session. Default: 'residential' */
  proxyTier?: ProxyTier;
  /** Two-letter country code for geo-consistent proxy. */
  proxyCountry?: string;
  /** City-level targeting. */
  proxyCity?: string;
  /** ASN-level targeting. */
  proxyAsn?: string;
  /** Domain to optimize the session for. */
  domain?: string;
  /** Session TTL in minutes (1–60). Default: 10 */
  ttlMinutes?: number;
}

/** Response from `createSession()`. */
export interface SessionResponse {
  /** Unique session ID. */
  sessionId: string;
  /** Proxy ID assigned to the session. */
  proxyId: string;
  /** Country of the proxy. */
  proxyCountry?: string;
  /** City of the proxy. */
  proxyCity?: string;
  /** ASN of the proxy. */
  proxyAsn?: string;
  /** Proxy tier. */
  proxyTier: ProxyTier;
  /** Browser fingerprint profile used. */
  fingerprintProfile: Record<string, any>;
  /** Session TTL in milliseconds. */
  ttlMs: number;
  /** When the session was created. */
  createdAt: string;
  /** When the session expires. */
  expiresAt: string;
}

/** Session metrics. */
export interface SessionMetrics {
  /** Total requests made. */
  requestCount: number;
  /** Successful requests. */
  successCount: number;
  /** Failed requests. */
  failureCount: number;
  /** Success rate (0–1). */
  successRate: number;
  /** Average response time in ms. */
  avgResponseMs: number;
  /** Total bandwidth consumed in bytes. */
  bandwidthBytes: number;
  /** Credits consumed by this session. */
  creditsConsumed: number;
}

/** Detailed session information from `getSession()`. */
export interface SessionDetail extends SessionResponse {
  /** Session metrics. */
  metrics: SessionMetrics;
  /** When the session was last accessed. */
  lastAccessedAt: string;
  /** Whether the session is currently active. */
  isActive: boolean;
}

/** Session summary from `listSessions()`. */
export interface SessionSummary {
  sessionId: string;
  proxyId: string;
  proxyCountry?: string;
  proxyTier: ProxyTier;
  requestCount: number;
  successRate: number;
  isActive: boolean;
  createdAt: string;
  expiresAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Monitoring -- Request & Response Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Alert threshold for a monitor. */
export interface AlertThreshold {
  /** Field name to monitor. */
  field: string;
  /** Comparison operator. */
  operator: 'gt' | 'lt' | 'eq' | 'neq' | 'change';
  /** Value to compare against (omitted for 'change'). */
  value?: number | string;
}

/** Options for the `createMonitor()` method. */
export interface CreateMonitorOptions {
  /** Alert thresholds for notifications. */
  alertThresholds?: AlertThreshold[];
  /** Webhook URL for notifications. */
  webhookUrl?: string;
}

/** Response from `createMonitor()`. */
export interface MonitorResponse {
  /** Unique monitor ID. */
  id: string;
  /** Monitored URL. */
  url: string;
  /** Fields being monitored. */
  fields: string[];
  /** Cron schedule expression. */
  schedule: string;
  /** Alert thresholds. */
  alertThresholds?: AlertThreshold[];
  /** Webhook URL for alerts. */
  webhookUrl?: string;
  /** Whether the monitor is active. */
  active: boolean;
  /** When the monitor was created. */
  createdAt: string;
}

/** Detailed monitor from `getMonitor()`. */
export interface MonitorDetail extends MonitorResponse {
  /** Last time the monitor ran. */
  lastRun?: string;
  /** Recent snapshots. */
  recentSnapshots?: Array<{
    id: string;
    data: Record<string, any>;
    capturedAt: string;
  }>;
}

/** Monitor list item from `listMonitors()`. */
export interface MonitorListItem {
  id: string;
  url: string;
  fields: string[];
  schedule: string;
  active: boolean;
  lastRun?: string;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Webhooks -- Request & Response Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Webhook event types. */
export type WebhookEvent =
  | 'job_completed'
  | 'job_failed'
  | 'monitor_change'
  | 'alert_triggered'
  | 'credits_low';

/** Batch configuration for webhook delivery. */
export interface WebhookBatchConfig {
  /** Enable batch delivery. Default: false */
  enabled?: boolean;
  /** Number of events per batch (1–100). Default: 10 */
  batchSize?: number;
  /** Interval between batch deliveries in seconds (5–3600). Default: 60 */
  intervalSeconds?: number;
}

/** Options for the `createWebhook()` method. */
export interface CreateWebhookOptions {
  /** Webhook signing secret (auto-generated if omitted). */
  secret?: string;
  /** Batch delivery configuration. */
  batch?: WebhookBatchConfig;
}

/** Webhook health metrics. */
export interface WebhookHealth {
  /** Success rate (0–1). */
  successRate: number;
  /** Average delivery latency in ms. */
  avgLatencyMs: number;
  /** Number of consecutive delivery failures. */
  consecutiveFailures: number;
}

/** Response from `createWebhook()`. */
export interface WebhookResponse {
  /** Unique webhook ID. */
  id: string;
  /** Webhook endpoint URL. */
  url: string;
  /** Subscribed event types. */
  events: WebhookEvent[];
  /** Webhook signing secret. */
  secret: string;
  /** Whether the webhook is active. */
  active: boolean;
  /** Batch configuration. */
  batch: WebhookBatchConfig;
  /** When the webhook was created. */
  createdAt: string;
}

/** Webhook list item from `listWebhooks()`. */
export interface WebhookListItem {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  lastSent?: string;
  failCount: number;
  health?: WebhookHealth;
  createdAt: string;
}

/** Response from `testWebhook()`. */
export interface WebhookTestResponse {
  /** Whether the test delivery succeeded. */
  success: boolean;
  /** HTTP status code from the endpoint. */
  statusCode?: number;
  /** Latency of the test delivery in ms. */
  latencyMs?: number;
  /** Error message if the test failed. */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scraping Browser (CDP) -- Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Options for the `scrapingBrowser()` method. */
export interface ScrapingBrowserOptions {
  /** Proxy tier for the browser session. Default: 'residential' */
  proxyTier?: ProxyTier;
  /** Proxy country for geotargeting. */
  proxyCountry?: string;
  /** Use stealth mode (anti-bot evasion). Default: true */
  stealth?: boolean;
  /** Session ID for sticky proxy/fingerprint. */
  sessionId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Analytics -- Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Usage statistics. */
export interface UsageStats {
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
  topDomains: Array<{ domain: string; requests: number; successRate: number }>;
}

/** Domain intelligence profile. */
export interface DomainProfile {
  domain: string;
  requiresBrowser: boolean;
  browserConfidence: number;
  optimalProxyTier: ProxyTier;
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

// ═══════════════════════════════════════════════════════════════════════════════
// Pagination Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Pagination parameters. */
export interface PaginationParams {
  /** Maximum number of items to return. */
  limit?: number;
  /** Number of items to skip. */
  offset?: number;
}

/** Paginated response wrapper. */
export interface PaginatedResult<T> {
  /** Result items. */
  data: T[];
  /** Total number of items. */
  total: number;
  /** Applied limit. */
  limit: number;
  /** Applied offset. */
  offset: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API Response Wrapper
// ═══════════════════════════════════════════════════════════════════════════════

/** Standard API response envelope. */
export interface ApiResponse<T = any> {
  /** Whether the request was successful. */
  success: boolean;
  /** Response payload (present on success). */
  data?: T;
  /** Error message (present on failure). */
  error?: string;
  /** Credits used by this request. */
  creditsUsed?: number;
  /** Remaining credits. */
  creditsRemaining?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Error Classes
// ═══════════════════════════════════════════════════════════════════════════════

/** Base error class for all ScrapeSuite SDK errors. */
export class ScrapeSuiteError extends Error {
  /** HTTP status code from the API response. */
  public readonly statusCode: number;
  /** Raw API response body. */
  public readonly body: Record<string, any>;
  /** Whether this request can be retried. */
  public readonly retryable: boolean;

  constructor(
    message: string,
    statusCode: number,
    body: Record<string, any> = {},
    retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ScrapeSuiteError';
    this.statusCode = statusCode;
    this.body = body;
    this.retryable = retryable;
  }
}

/** Thrown when the API key is invalid or missing. */
export class AuthenticationError extends ScrapeSuiteError {
  constructor(message: string = 'Invalid or missing API key', body: Record<string, any> = {}) {
    super(message, 401, body, false);
    this.name = 'AuthenticationError';
  }
}

/** Thrown when the rate limit has been exceeded. */
export class RateLimitError extends ScrapeSuiteError {
  /** Number of seconds until the rate limit resets. */
  public readonly retryAfter: number;

  constructor(
    message: string = 'Rate limit exceeded',
    retryAfter: number = 60,
    body: Record<string, any> = {},
  ) {
    super(message, 429, body, true);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/** Thrown when the account credits have been exhausted. */
export class QuotaExceededError extends ScrapeSuiteError {
  /** Credits required for the request. */
  public readonly creditsRequired?: number;
  /** Credits remaining on the account. */
  public readonly creditsRemaining?: number;

  constructor(
    message: string = 'Quota exceeded -- insufficient credits',
    body: Record<string, any> = {},
    creditsRequired?: number,
    creditsRemaining?: number,
  ) {
    super(message, 402, body, false);
    this.name = 'QuotaExceededError';
    this.creditsRequired = creditsRequired;
    this.creditsRemaining = creditsRemaining;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal Types (not exported to consumers)
// ═══════════════════════════════════════════════════════════════════════════════

/** Rate limit info extracted from response headers. */
export interface RateLimitInfo {
  /** Maximum requests per window. */
  limit: number;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Timestamp when the rate limit window resets. */
  reset: number;
}
