/**
 * ScrapeSuite Node.js SDK -- Official Client Library
 *
 * The official Node.js/TypeScript SDK for the ScrapeSuite API.
 * Provides a high-level, Promise-based interface for web scraping,
 * data extraction, SERP queries, session management, monitoring,
 * webhooks, and the scraping browser (CDP).
 *
 * @packageDocumentation
 * @version 1.0.0
 *
 * @example
 * ```typescript
 * import { ScrapeSuiteClient } from '@scrapesuite/nodejs';
 *
 * const client = new ScrapeSuiteClient('ss_live_...');
 *
 * // Scrape a single URL
 * const job = await client.scrape('https://example.com', {
 *   strategy: 'browser',
 *   outputFormat: 'markdown',
 * });
 *
 * // Wait for result
 * const result = await client.waitForResult(job.id);
 * console.log(result.result);
 *
 * // NL extraction
 * const extracted = await client.extract('<html>...', 'extract all product prices');
 *
 * // SERP query
 * const serp = await client.serp('best web scraping tools');
 *
 * // Sticky session
 * const session = await client.createSession({ proxyCountry: 'US' });
 * ```
 */

import type {
  ScrapeSuiteClientOptions,
  ScrapeOptions,
  ScrapeResponse,
  ScrapeResult,
  ScrapeBatchOptions,
  BatchScrapeResponse,
  BatchStatus,
  ScreenshotOptions,
  ScreenshotResponse,
  CrawlOptions,
  CrawlResponse,
  ExtractOptions,
  ExtractResponse,
  StructuredParser,
  ParseStructuredOptions,
  ParseStructuredResponse,
  SerpOptions,
  SerpResponse,
  CreateSessionOptions,
  SessionResponse,
  SessionDetail,
  SessionSummary,
  CreateMonitorOptions,
  MonitorResponse,
  MonitorDetail,
  MonitorListItem,
  CreateWebhookOptions,
  WebhookEvent,
  WebhookResponse,
  WebhookListItem,
  WebhookTestResponse,
  ScrapingBrowserOptions,
  ApiResponse,
  PaginationParams,
  PaginatedResult,
  RateLimitInfo,
  UsageStats,
  DomainProfile,
  ScrapeSuiteError,
  AuthenticationError,
  RateLimitError,
  QuotaExceededError,
} from './types';

// Re-export all types and error classes so consumers can import them
export {
  ScrapeSuiteError,
  AuthenticationError,
  RateLimitError,
  QuotaExceededError,
} from './types';

export type {
  ScrapeSuiteClientOptions,
  ScrapeOptions,
  ScrapeResponse,
  ScrapeResult,
  ScrapeBatchOptions,
  BatchScrapeResponse,
  BatchStatus,
  ScreenshotOptions,
  ScreenshotResponse,
  CrawlOptions,
  CrawlResponse,
  ExtractOptions,
  ExtractResponse,
  StructuredParser,
  ParseStructuredOptions,
  ParseStructuredResponse,
  SerpOptions,
  SerpResponse,
  CreateSessionOptions,
  SessionResponse,
  SessionDetail,
  SessionSummary,
  CreateMonitorOptions,
  MonitorResponse,
  MonitorDetail,
  MonitorListItem,
  CreateWebhookOptions,
  WebhookEvent,
  WebhookResponse,
  WebhookListItem,
  WebhookTestResponse,
  ScrapingBrowserOptions,
  ApiResponse,
  PaginationParams,
  PaginatedResult,
  RateLimitInfo,
  UsageStats,
  DomainProfile,
  ScrapeStrategy,
  ProxyTier,
  OutputFormat,
  JobStatus,
  PlanTier,
  SearchEngine,
  AlertThreshold,
  WebhookBatchConfig,
  WebhookHealth,
  SessionMetrics,
  OrganicResult,
  AdResult,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_BASE_URL = 'https://api.scrapesuite.dev';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const SDK_VERSION = '1.0.0';
const DEFAULT_USER_AGENT = `scrapesuite-node/${SDK_VERSION}`;

/** Status codes that are retryable (transient errors). */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/** Default backoff multiplier (exponential with jitter). */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_JITTER = 0.25;

// ═══════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter.
 *
 * @param attempt - Zero-indexed retry attempt number.
 * @returns Delay in milliseconds before the next retry.
 */
function calculateBackoff(attempt: number): number {
  const exponentialDelay = BACKOFF_BASE_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, BACKOFF_MAX_MS);
  const jitterRange = cappedDelay * BACKOFF_JITTER;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Parse rate limit headers from a Fetch API Response.
 */
function parseRateLimitHeaders(response: Response): RateLimitInfo | null {
  const limit = response.headers.get('x-ratelimit-limit');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');

  if (limit && remaining && reset) {
    return {
      limit: parseInt(limit, 10),
      remaining: parseInt(remaining, 10),
      reset: parseInt(reset, 10),
    };
  }

  return null;
}

/**
 * Build a query string from an object, omitting undefined values.
 */
function buildQueryString(params: Record<string, any>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.set(key, String(value));
    }
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ScrapeSuiteClient
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The main ScrapeSuite API client.
 *
 * Provides methods for all ScrapeSuite API endpoints: scraping,
 * extraction, SERP, sessions, monitors, webhooks, and the
 * scraping browser (CDP).
 *
 * All methods return Promises and support automatic retry with
 * exponential backoff and rate limit awareness.
 *
 * @example
 * ```typescript
 * const client = new ScrapeSuiteClient('ss_live_your_api_key');
 *
 * // Simple scrape
 * const result = await client.scrape('https://example.com');
 *
 * // With options
 * const result = await client.scrape('https://example.com', {
 *   strategy: 'stealth-browser',
 *   proxyCountry: 'US',
 *   renderJs: true,
 *   outputFormat: 'markdown',
 *   extract: 'get the main article content',
 * });
 * ```
 */
export class ScrapeSuiteClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly userAgent: string;

  /** Last observed rate limit info. */
  private _rateLimitInfo: RateLimitInfo | null = null;

  /**
   * Create a new ScrapeSuite client.
   *
   * @param apiKey - Your ScrapeSuite API key (starts with `ss_live_` or `ss_test_`).
   * @param options - Optional client configuration.
   *
   * @example
   * ```typescript
   * const client = new ScrapeSuiteClient('ss_live_abc123', {
   *   baseUrl: 'http://localhost:3001',
   *   timeout: 60000,
   *   retries: 5,
   * });
   * ```
   */
  constructor(apiKey: string, options: ScrapeSuiteClientOptions = {}) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('ScrapeSuite API key is required. Pass it as the first argument.');
    }

    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Properties
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the most recently observed rate limit information from API headers.
   * Returns `null` if no request has been made yet or headers were not present.
   */
  get rateLimitInfo(): RateLimitInfo | null {
    return this._rateLimitInfo;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Scraping Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Scrape a single URL.
   *
   * Submits a scrape job and returns the job ID and status. The job
   * runs asynchronously. Use `getJob()` or `waitForResult()` to
   * retrieve the result.
   *
   * @param url - The URL to scrape.
   * @param options - Scraping options.
   * @returns The submitted job info.
   *
   * @example
   * ```typescript
   * const job = await client.scrape('https://example.com', {
   *   strategy: 'browser',
   *   outputFormat: 'markdown',
   *   proxyCountry: 'US',
   * });
   * const result = await client.waitForResult(job.id);
   * console.log(result.result); // The markdown content
   * ```
   */
  async scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeResponse> {
    const body: Record<string, any> = { url, ...options };
    const response = await this.request<{ data: ScrapeResponse }>('POST', '/v1/scrape', body);
    return response.data;
  }

  /**
   * Batch scrape multiple URLs.
   *
   * Submits up to 100 URLs for scraping in a single request.
   * All URLs share the same scraping options.
   *
   * @param urls - Array of URLs to scrape (max 100).
   * @param options - Scraping options applied to all URLs.
   * @returns The batch job info.
   *
   * @example
   * ```typescript
   * const batch = await client.scrapeBatch(
   *   ['https://example.com/page1', 'https://example.com/page2'],
   *   { strategy: 'http', outputFormat: 'markdown' },
   * );
   * const status = await client.getBatchStatus(batch.id);
   * ```
   */
  async scrapeBatch(urls: string[], options: ScrapeBatchOptions = {}): Promise<BatchScrapeResponse> {
    const body: Record<string, any> = { urls, ...options };
    const response = await this.request<{ data: BatchScrapeResponse }>('POST', '/v1/scrape/batch', body);
    return response.data;
  }

  /**
   * Take a screenshot of a URL.
   *
   * Captures a screenshot of the specified URL using a headless browser
   * with stealth mode and proxy support.
   *
   * @param url - The URL to screenshot.
   * @param options - Screenshot options.
   * @returns Screenshot data (base64-encoded PNG).
   *
   * @example
   * ```typescript
   * const screenshot = await client.screenshot('https://example.com', {
   *   fullPage: true,
   *   proxyCountry: 'US',
   * });
   * // Save to file
   * fs.writeFileSync('screenshot.png', Buffer.from(screenshot.screenshot, 'base64'));
   * ```
   */
  async screenshot(url: string, options: ScreenshotOptions = {}): Promise<ScreenshotResponse> {
    const body: Record<string, any> = { url, ...options };
    const response = await this.request<{ data: ScreenshotResponse }>('POST', '/v1/screenshot', body);
    return response.data;
  }

  /**
   * Crawl a website starting from a seed URL.
   *
   * Discovers and scrapes pages by following links within the same
   * domain. Supports depth limits, URL patterns, and concurrency control.
   *
   * @param url - The seed URL to start crawling from.
   * @param options - Crawl options.
   * @returns Crawl job info.
   *
   * @example
   * ```typescript
   * const crawl = await client.crawl('https://example.com', {
   *   maxPages: 50,
   *   maxDepth: 3,
   *   includePatterns: ['/blog/*'],
   *   outputFormat: 'markdown',
   * });
   * ```
   */
  async crawl(url: string, options: CrawlOptions = {}): Promise<CrawlResponse> {
    const body: Record<string, any> = { url, ...options };
    const response = await this.request<{ data: CrawlResponse }>('POST', '/v1/crawl', body);
    return response.data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Job Status & Results
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the status of a scrape job.
   *
   * @param jobId - The job ID returned by `scrape()`.
   * @returns Job status and metadata.
   */
  async getJob(jobId: string): Promise<ScrapeResult> {
    const response = await this.request<{ data: ScrapeResult }>('GET', `/v1/jobs/${jobId}`);
    return response.data;
  }

  /**
   * Get the result of a completed scrape job.
   *
   * Only returns data for jobs with status `'done'`. Returns an error
   * if the job is still running or has failed.
   *
   * @param jobId - The job ID.
   * @returns Full scrape result including content.
   */
  async getResult(jobId: string): Promise<ScrapeResult> {
    const response = await this.request<{ data: ScrapeResult }>('GET', `/v1/results/${jobId}`);
    return response.data;
  }

  /**
   * Get the status of a batch scrape job.
   *
   * @param batchId - The batch ID returned by `scrapeBatch()`.
   * @returns Batch status including individual job statuses.
   */
  async getBatchStatus(batchId: string): Promise<BatchStatus> {
    const response = await this.request<{ data: BatchStatus }>('GET', `/v1/batch/${batchId}`);
    return response.data;
  }

  /**
   * Wait for a scrape job to complete, polling at a regular interval.
   *
   * Resolves when the job status becomes `'done'` or `'failed'`.
   * Rejects if the timeout is exceeded.
   *
   * @param jobId - The job ID to wait for.
   * @param options - Wait options.
   * @param options.pollInterval - Polling interval in ms. Default: 2000
   * @param options.timeout - Maximum time to wait in ms. Default: 300000 (5 min)
   * @returns The completed scrape result.
   *
   * @example
   * ```typescript
   * const job = await client.scrape('https://example.com');
   * const result = await client.waitForResult(job.id, { pollInterval: 1000 });
   * if (result.status === 'done') {
   *   console.log(result.result);
   * }
   * ```
   */
  async waitForResult(
    jobId: string,
    options: { pollInterval?: number; timeout?: number } = {},
  ): Promise<ScrapeResult> {
    const pollInterval = options.pollInterval ?? 2000;
    const timeoutMs = options.timeout ?? 300_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const job = await this.getJob(jobId);

      if (job.status === 'done') {
        // Try to get the full result with content
        try {
          return await this.getResult(jobId);
        } catch {
          return job;
        }
      }

      if (job.status === 'failed') {
        return job;
      }

      await sleep(pollInterval);
    }

    throw new ScrapeSuiteError(
      `Timed out waiting for job ${jobId} after ${timeoutMs}ms`,
      0,
      {},
      true,
    );
  }

  /**
   * Wait for a batch scrape to complete, polling at a regular interval.
   *
   * @param batchId - The batch ID to wait for.
   * @param options - Wait options.
   * @param options.pollInterval - Polling interval in ms. Default: 3000
   * @param options.timeout - Maximum time to wait in ms. Default: 600000 (10 min)
   * @returns The completed batch status.
   */
  async waitForBatch(
    batchId: string,
    options: { pollInterval?: number; timeout?: number } = {},
  ): Promise<BatchStatus> {
    const pollInterval = options.pollInterval ?? 3000;
    const timeoutMs = options.timeout ?? 600_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const batch = await this.getBatchStatus(batchId);

      if (batch.status === 'completed' || batch.status === 'failed') {
        return batch;
      }

      await sleep(pollInterval);
    }

    throw new ScrapeSuiteError(
      `Timed out waiting for batch ${batchId} after ${timeoutMs}ms`,
      0,
      {},
      true,
    );
  }

  /**
   * List recent scrape jobs.
   *
   * @param params - Pagination and filter parameters.
   * @returns Paginated list of jobs.
   */
  async listJobs(params: PaginationParams & { status?: string } = {}): Promise<PaginatedResult<ScrapeResult>> {
    const qs = buildQueryString(params);
    const response = await this.request<PaginatedResult<ScrapeResult>>('GET', `/v1/jobs${qs}`);
    return response;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Data Extraction Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Extract structured data from HTML using a natural language instruction.
   *
   * Powered by AI, this method takes raw HTML and an instruction like
   * "extract all product prices and names" and returns structured JSON.
   *
   * @param html - The HTML content to extract from.
   * @param instruction - Natural language extraction instruction.
   * @param options - Extraction options.
   * @returns Extracted data with confidence score.
   *
   * @example
   * ```typescript
   * const result = await client.extract(
   *   htmlContent,
   *   'extract all product names, prices, and ratings',
   *   { url: 'https://store.example.com/products' },
   * );
   * console.log(result.data);  // { products: [...] }
   * console.log(result.confidence);  // 0.92
   * ```
   */
  async extract(
    html: string,
    instruction: string,
    options: ExtractOptions = {},
  ): Promise<ExtractResponse> {
    const body: Record<string, any> = { html, instruction, ...options };
    const response = await this.request<ExtractResponse>('POST', '/v1/extract', body);
    return response;
  }

  /**
   * Parse structured data from HTML using schema.org, Open Graph, or
   * pre-built parsers.
   *
   * @param html - The HTML content to parse.
   * @param parser - Parser to use. Default: 'auto'
   * @param options - Parse options.
   * @returns Structured data keyed by parser name.
   *
   * @example
   * ```typescript
   * // Auto-detect parser from URL
   * const result = await client.parseStructured(html, 'auto', {
   *   url: 'https://www.amazon.com/dp/B0...',
   * });
   * console.log(result.data.amazon);  // Amazon product data
   * console.log(result.data.generic); // Schema.org / OG data
   * ```
   */
  async parseStructured(
    html: string,
    parser: StructuredParser = 'auto',
    options: ParseStructuredOptions = {},
  ): Promise<ParseStructuredResponse> {
    const body: Record<string, any> = { html, parser, ...options };
    const response = await this.request<ParseStructuredResponse>('POST', '/v1/structured', body);
    return response;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SERP API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute a search engine results page (SERP) query.
   *
   * Supports Google, Bing, Yahoo, and DuckDuckGo with automatic
   * parsing and geo-targeting.
   *
   * @param query - The search query string.
   * @param options - SERP query options.
   * @returns Parsed search results.
   *
   * @example
   * ```typescript
   * const results = await client.serp('web scraping tools', {
   *   engine: 'google',
   *   country: 'us',
   *   numResults: 20,
   * });
   * for (const result of results.organic) {
   *   console.log(`${result.position}. ${result.title} -- ${result.url}`);
   * }
   * ```
   */
  async serp(query: string, options: SerpOptions = {}): Promise<SerpResponse> {
    const body: Record<string, any> = { query, ...options };
    const response = await this.request<{ data: SerpResponse; creditsUsed: number; creditsRemaining: number }>(
      'POST',
      '/v1/serp',
      body,
    );
    return response.data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Session Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a sticky session with a persistent proxy and fingerprint.
   *
   * Sessions ensure all requests use the same exit IP and browser
   * fingerprint, which is essential for scraping sites that track
   * session consistency.
   *
   * @param options - Session configuration.
   * @returns The created session info.
   *
   * @example
   * ```typescript
   * const session = await client.createSession({
   *   proxyTier: 'residential',
   *   proxyCountry: 'US',
   *   ttlMinutes: 30,
   * });
   *
   * // Use the session ID in subsequent scrape requests
   * await client.scrape('https://protected-site.com', {
   *   sessionId: session.sessionId,
   * });
   * ```
   */
  async createSession(options: CreateSessionOptions = {}): Promise<SessionResponse> {
    const body: Record<string, any> = { ...options };
    const response = await this.request<{ data: SessionResponse }>('POST', '/v1/sessions', body);
    return response.data;
  }

  /**
   * List all active sessions for the authenticated user.
   *
   * @returns Array of session summaries.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const response = await this.request<{ data: SessionSummary[]; total: number }>('GET', '/v1/sessions');
    return response.data;
  }

  /**
   * Get detailed information about a specific session.
   *
   * @param sessionId - The session ID.
   * @returns Detailed session info with metrics.
   */
  async getSession(sessionId: string): Promise<SessionDetail> {
    const response = await this.request<{ data: SessionDetail }>('GET', `/v1/sessions/${sessionId}`);
    return response.data;
  }

  /**
   * Terminate a sticky session.
   *
   * @param sessionId - The session ID to terminate.
   * @returns Confirmation of termination.
   */
  async deleteSession(sessionId: string): Promise<{ sessionId: string; terminated: boolean }> {
    const response = await this.request<{ data: { sessionId: string; terminated: boolean } }>(
      'DELETE',
      `/v1/sessions/${sessionId}`,
    );
    return response.data;
  }

  /**
   * Refresh a session's TTL, extending its expiration time.
   *
   * @param sessionId - The session ID to refresh.
   * @returns Updated session info.
   */
  async refreshSession(sessionId: string): Promise<SessionResponse> {
    const response = await this.request<{ data: SessionResponse }>(
      'POST',
      `/v1/sessions/${sessionId}/refresh`,
    );
    return response.data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Monitoring
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a monitor that periodically scrapes a URL and tracks changes.
   *
   * @param url - The URL to monitor.
   * @param fields - Fields/elements to extract and track.
   * @param schedule - Cron expression for the monitoring schedule.
   * @param options - Monitor options (alerts, webhook).
   * @returns The created monitor info.
   *
   * @example
   * ```typescript
   * const monitor = await client.createMonitor(
   *   'https://competitor.com/pricing',
   *   ['price', 'plan_name'],
   *   '0 0/6 * * *',  // Every 6 hours
   *   {
   *     alertThresholds: [
   *       { field: 'price', operator: 'change' },
   *     ],
   *     webhookUrl: 'https://myapp.com/webhook',
   *   },
   * );
   * ```
   */
  async createMonitor(
    url: string,
    fields: string[],
    schedule: string,
    options: CreateMonitorOptions = {},
  ): Promise<MonitorResponse> {
    const body: Record<string, any> = { url, fields, schedule, ...options };
    const response = await this.request<{ data: MonitorResponse }>('POST', '/v1/monitor', body);
    return response.data;
  }

  /**
   * List all monitors for the authenticated user.
   *
   * @param params - Pagination and filter parameters.
   * @returns Paginated list of monitors.
   */
  async listMonitors(
    params: PaginationParams & { active?: boolean } = {},
  ): Promise<PaginatedResult<MonitorListItem>> {
    const qs = buildQueryString(params);
    const response = await this.request<PaginatedResult<MonitorListItem>>('GET', `/v1/monitors${qs}`);
    return response;
  }

  /**
   * Get detailed information about a specific monitor.
   *
   * @param monitorId - The monitor ID.
   * @returns Detailed monitor info with recent snapshots.
   */
  async getMonitor(monitorId: string): Promise<MonitorDetail> {
    const response = await this.request<{ data: MonitorDetail }>('GET', `/v1/monitor/${monitorId}`);
    return response.data;
  }

  /**
   * Update an existing monitor.
   *
   * @param monitorId - The monitor ID.
   * @param updates - Fields to update.
   * @returns Updated monitor info.
   */
  async updateMonitor(
    monitorId: string,
    updates: {
      active?: boolean;
      schedule?: string;
      fields?: string[];
      alertThresholds?: Array<{ field: string; operator: string; value?: number | string }>;
      webhookUrl?: string | null;
    },
  ): Promise<MonitorResponse> {
    const response = await this.request<{ data: MonitorResponse }>(
      'PATCH',
      `/v1/monitor/${monitorId}`,
      updates,
    );
    return response.data;
  }

  /**
   * Delete a monitor.
   *
   * @param monitorId - The monitor ID.
   */
  async deleteMonitor(monitorId: string): Promise<void> {
    await this.request('DELETE', `/v1/monitor/${monitorId}`);
  }

  /**
   * Get snapshots for a monitor.
   *
   * @param monitorId - The monitor ID.
   * @param params - Pagination parameters.
   * @returns Paginated list of snapshots.
   */
  async getMonitorSnapshots(
    monitorId: string,
    params: PaginationParams = {},
  ): Promise<PaginatedResult<{ id: string; data: Record<string, any>; capturedAt: string }>> {
    const qs = buildQueryString(params);
    const response = await this.request<
      PaginatedResult<{ id: string; data: Record<string, any>; capturedAt: string }>
    >('GET', `/v1/monitor/${monitorId}/snapshots${qs}`);
    return response;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Webhooks
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a webhook endpoint for receiving event notifications.
   *
   * @param url - The URL to receive webhook POST requests.
   * @param events - Array of event types to subscribe to.
   * @param options - Webhook options (secret, batch config).
   * @returns The created webhook info.
   *
   * @example
   * ```typescript
   * const webhook = await client.createWebhook(
   *   'https://myapp.com/scrapesuite-webhook',
   *   ['job_completed', 'monitor_change'],
   *   {
   *     secret: 'whsec_my_secret',
   *     batch: { enabled: true, batchSize: 25, intervalSeconds: 120 },
   *   },
   * );
   * ```
   */
  async createWebhook(
    url: string,
    events: WebhookEvent[],
    options: CreateWebhookOptions = {},
  ): Promise<WebhookResponse> {
    const body: Record<string, any> = { url, events, ...options };
    const response = await this.request<{ data: WebhookResponse }>('POST', '/v1/webhooks', body);
    return response.data;
  }

  /**
   * List all webhooks for the authenticated user.
   *
   * @returns Array of webhook summaries with health data.
   */
  async listWebhooks(): Promise<WebhookListItem[]> {
    const response = await this.request<{ data: WebhookListItem[] }>('GET', '/v1/webhooks');
    return response.data;
  }

  /**
   * Test a webhook by sending a test payload to its URL.
   *
   * @param webhookId - The webhook ID to test.
   * @returns Test result with delivery status and latency.
   */
  async testWebhook(webhookId: string): Promise<WebhookTestResponse> {
    const response = await this.request<{ data: WebhookTestResponse }>(
      'POST',
      `/v1/webhooks/${webhookId}/test`,
    );
    return response.data;
  }

  /**
   * Get detailed information about a specific webhook.
   *
   * @param webhookId - The webhook ID.
   * @returns Detailed webhook info with recent delivery logs.
   */
  async getWebhook(webhookId: string): Promise<WebhookResponse & {
    recentLogs?: any[];
    health?: { successRate: number; avgLatencyMs: number; consecutiveFailures: number };
  }> {
    const response = await this.request<{ data: any }>('GET', `/v1/webhooks/${webhookId}`);
    return response.data;
  }

  /**
   * Update a webhook's configuration.
   *
   * @param webhookId - The webhook ID.
   * @param updates - Fields to update.
   * @returns Updated webhook info.
   */
  async updateWebhook(
    webhookId: string,
    updates: {
      url?: string;
      events?: WebhookEvent[];
      active?: boolean;
      secret?: string;
      batch?: { enabled?: boolean; batchSize?: number; intervalSeconds?: number };
    },
  ): Promise<WebhookResponse> {
    const response = await this.request<{ data: WebhookResponse }>(
      'PATCH',
      `/v1/webhooks/${webhookId}`,
      updates,
    );
    return response.data;
  }

  /**
   * Delete a webhook.
   *
   * @param webhookId - The webhook ID.
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request('DELETE', `/v1/webhooks/${webhookId}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Scraping Browser (CDP)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get a Playwright Browser instance connected to ScrapeSuite via CDP.
   *
   * This method connects to a remote browser instance managed by
   * ScrapeSuite, providing full browser automation capabilities with
   * built-in proxy rotation and anti-bot evasion.
   *
   * Requires the `playwright` package to be installed.
   *
   * @param options - Browser connection options.
   * @returns A Playwright Browser instance.
   *
   * @example
   * ```typescript
   * const browser = await client.scrapingBrowser({
   *   proxyCountry: 'US',
   *   stealth: true,
   * });
   *
   * const page = await browser.newPage();
   * await page.goto('https://example.com');
   * const title = await page.title();
   * console.log(title);
   *
   * await browser.close();
   * ```
   */
  async scrapingBrowser(options: ScrapingBrowserOptions = {}): Promise<any> {
    try {
      // Dynamically import playwright -- will throw if not installed
      const { chromium } = await import('playwright');
    } catch {
      throw new Error(
        'The `playwright` package is required for scrapingBrowser(). ' +
        'Install it with: npm install playwright',
      );
    }

    const { chromium } = await import('playwright');

    // Request a CDP endpoint from the API
    const body: Record<string, any> = { ...options };
    const response = await this.request<{ data: { wsEndpoint: string; sessionId?: string } }>(
      'POST',
      '/v1/browser/connect',
      body,
    );

    const { wsEndpoint } = response.data;

    // Connect to the remote browser via CDP WebSocket
    const browser = await chromium.connectOverCDP(wsEndpoint, {
      timeout: this.timeout,
    });

    return browser;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Analytics & Usage
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get usage statistics for the authenticated user.
   *
   * @param params - Query parameters.
   * @returns Usage statistics.
   */
  async getUsage(params: { period?: string } = {}): Promise<UsageStats> {
    const qs = buildQueryString(params);
    const response = await this.request<{ data: UsageStats }>('GET', `/v1/analytics/usage${qs}`);
    return response.data;
  }

  /**
   * Get domain intelligence data.
   *
   * @param params - Query parameters.
   * @returns Domain profiles.
   */
  async getDomains(params: PaginationParams = {}): Promise<PaginatedResult<DomainProfile>> {
    const qs = buildQueryString(params);
    const response = await this.request<PaginatedResult<DomainProfile>>(
      'GET',
      `/v1/analytics/domains${qs}`,
    );
    return response;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Templates
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * List all available extraction templates.
   *
   * @returns Array of template descriptors.
   */
  async listTemplates(): Promise<Array<{
    id: string;
    name: string;
    description: string;
    domains: string[];
    cost: number;
  }>> {
    const response = await this.request<{ data: any[] }>('GET', '/v1/templates');
    return response.data;
  }

  /**
   * Get details about a specific extraction template.
   *
   * @param templateId - The template ID.
   * @returns Template details.
   */
  async getTemplate(templateId: string): Promise<{
    id: string;
    name: string;
    description: string;
    domains: string[];
    fields: string[];
    cost: number;
  }> {
    const response = await this.request<{ data: any }>('GET', `/v1/templates/${templateId}`);
    return response.data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Proxy & Infrastructure
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get proxy pool statistics.
   *
   * @returns Proxy pool stats.
   */
  async getProxyStats(): Promise<Record<string, any>> {
    const response = await this.request<{ data: Record<string, any> }>('GET', '/v1/proxy/stats');
    return response.data;
  }

  /**
   * Get available proxy countries.
   *
   * @returns List of available countries.
   */
  async getProxyCountries(): Promise<string[]> {
    const response = await this.request<{ data: string[] }>('GET', '/v1/proxy/countries');
    return response.data;
  }

  /**
   * Estimate the cost of a scrape request.
   *
   * @param params - Cost estimation parameters.
   * @returns Cost estimate.
   */
  async estimateCost(params: {
    strategy?: string;
    extract?: boolean;
    structured?: boolean;
    solveCaptcha?: boolean;
  }): Promise<{ credits: number; breakdown: Record<string, number> }> {
    const qs = buildQueryString(params);
    const response = await this.request<{ data: { credits: number; breakdown: Record<string, number> } }>(
      'GET',
      `/v1/cost-estimate${qs}`,
    );
    return response.data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Health Check
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check the health of the ScrapeSuite API.
   *
   * @returns Health status info.
   */
  async health(): Promise<{
    status: string;
    timestamp: string;
    uptime: number;
  }> {
    const response = await this.request<{ status: string; timestamp: string; uptime: number }>(
      'GET',
      '/health',
    );
    return response;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Internal: HTTP Request with Retry & Rate Limit Awareness
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Make an authenticated HTTP request to the ScrapeSuite API.
   *
   * Features:
   * - Bearer token authentication
   * - Automatic retry with exponential backoff on transient errors
   * - Rate limit header awareness (respects Retry-After)
   * - Quota/credit exceeded error detection
   * - Timeout handling
   *
   * @internal
   */
  private async request<T = any>(
    method: string,
    path: string,
    body?: Record<string, any>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
      ...this.defaultHeaders,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      // If this is a retry, apply backoff delay
      if (attempt > 0) {
        const delay = calculateBackoff(attempt - 1);
        await sleep(delay);
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };

        if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
          fetchOptions.body = JSON.stringify(body);
        }

        const response = await this.fetchFn(url, fetchOptions);
        clearTimeout(timeoutId);

        // Track rate limit info from response headers
        const rateLimitInfo = parseRateLimitHeaders(response);
        if (rateLimitInfo) {
          this._rateLimitInfo = rateLimitInfo;
        }

        // ── Success ──────────────────────────────────────────────────────────
        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const json = await response.json();
            return json as T;
          }
          // Non-JSON success response (unlikely but handle gracefully)
          return {} as T;
        }

        // ── Error Responses ──────────────────────────────────────────────────
        const errorBody = await this.safeParseJson(response);

        // 401 Unauthorized -- not retryable
        if (response.status === 401) {
          throw new AuthenticationError(
            errorBody?.error || 'Invalid or missing API key',
            errorBody,
          );
        }

        // 402 Payment Required -- quota exceeded
        if (response.status === 402) {
          throw new QuotaExceededError(
            errorBody?.error || 'Insufficient credits',
            errorBody,
            errorBody?.creditsRequired,
            errorBody?.creditsRemaining,
          );
        }

        // 429 Too Many Requests -- rate limited (retryable with Retry-After)
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfter = retryAfterHeader
            ? parseInt(retryAfterHeader, 10) * 1000
            : calculateBackoff(attempt);

          lastError = new RateLimitError(
            errorBody?.error || 'Rate limit exceeded',
            Math.ceil(retryAfter / 1000),
            errorBody,
          );

          // If we have retries left, respect the Retry-After header and retry
          if (attempt < this.retries) {
            await sleep(retryAfter);
            continue;
          }

          throw lastError;
        }

        // Other retryable status codes (5xx, 408)
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.retries) {
          lastError = new ScrapeSuiteError(
            errorBody?.error || `HTTP ${response.status}`,
            response.status,
            errorBody,
            true,
          );
          continue;
        }

        // Non-retryable error
        throw new ScrapeSuiteError(
          errorBody?.error || `HTTP ${response.status}`,
          response.status,
          errorBody,
          false,
        );

      } catch (error) {
        // Re-throw our own error classes
        if (
          error instanceof ScrapeSuiteError ||
          error instanceof AuthenticationError ||
          error instanceof RateLimitError ||
          error instanceof QuotaExceededError
        ) {
          // If it's a retryable error and we have retries left, continue
          if (
            'retryable' in error &&
            (error as any).retryable === true &&
            attempt < this.retries
          ) {
            lastError = error as Error;
            continue;
          }
          throw error;
        }

        // AbortError from timeout
        if ((error as any).name === 'AbortError') {
          lastError = new ScrapeSuiteError(
            `Request timed out after ${this.timeout}ms`,
            0,
            {},
            true,
          );

          if (attempt < this.retries) {
            continue;
          }

          throw lastError;
        }

        // Network errors (fetch failed entirely)
        if (error instanceof TypeError && attempt < this.retries) {
          lastError = new ScrapeSuiteError(
            `Network error: ${(error as Error).message}`,
            0,
            {},
            true,
          );
          continue;
        }

        // Unknown errors -- wrap in ScrapeSuiteError
        throw new ScrapeSuiteError(
          (error as Error).message || 'Unknown error',
          0,
          {},
          false,
        );
      }
    }

    // All retries exhausted
    throw lastError || new ScrapeSuiteError('All retries exhausted', 0, {}, false);
  }

  /**
   * Safely parse a JSON response body, returning an empty object on failure.
   *
   * @internal
   */
  private async safeParseJson(response: Response): Promise<Record<string, any>> {
    try {
      const text = await response.text();
      if (!text) return {};
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Convenience: Default Export
// ═══════════════════════════════════════════════════════════════════════════════

export default ScrapeSuiteClient;
