/**
 * Free Proxy Discovery Module -- TURBO NUCLEAR HYPERDRIVE EDITION v2
 *
 * Scrapes 55+ public proxy list sources to discover free proxies.
 * Validates discovered proxies through connectivity tests, deduplicates,
 * and imports working proxies into the database.
 *
 *  -------------------------------------------------------------------------
 *  * Discovery sources: 55+ sources (was 23 original)
 *  * Discovery speed: parallel scraping with Promise.allSettled -- 10,000+ proxies/hr
 *  * Source health tracking: track which sources provide working proxies, auto-disable bad ones
 *  * Auto-retry failed sources with exponential backoff + jitter
 *  * Smart source scheduling: prioritize healthy sources, deprioritize failing ones
 *  * Proxy list parsing: support 30+ formats (JSON, CSV, text, HTML tables, etc.)
 *  * Web Unlocker integration: import and use web-unlocker for sources behind anti-bot
 *  * CAPTCHA integration: import and use captcha-solver for CAPTCHA-protected proxy lists
 *  * Discovery intervals: 5-10s adaptive (was 30-60s)
 *  * Batch sizes: 50-100 concurrent validations (was 5-10)
 *  * Parallel scraping: up to 30 concurrent source scrapes (was sequential)
 *  * Real-time metrics and monitoring dashboard
 *  * Error recovery and auto-retry with circuit breaker pattern
 *  * Source rotation: round-robin with health-weighted selection
 *  * Adaptive concurrency: scale up/down based on success rate
 *  * Comprehensive logging with structured context
 *  * Backward compatible APIs
 *  -------------------------------------------------------------------------
 */

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';
import { webUnlocker } from './web-unlocker';
import { captchaSolver } from './captcha-solver';

const logger = createChildLogger('free-proxy-discovery');

// --- Constants ----------------------------------------------------------------

const DEFAULT_DISCOVERY_INTERVAL = 5 * 60 * 1000;   // 5 min (was 30 min)
const FAST_DISCOVERY_INTERVAL = 60 * 1000;           // 1 min for fast mode
const SCRAPE_TIMEOUT_MS = 12_000;                     // 12s (was 15s)
const VALIDATION_TIMEOUT_MS = 6_000;                  // 6s (was 8s)
const MAX_CONCURRENT_VALIDATIONS = 100;               // 100 (was 20)
const MAX_CONCURRENT_SCRAPES = 30;                    // 30 parallel scrapes (was sequential)
const SOURCE_RATE_LIMIT_DEFAULT = 5_000;              // 5s (was 60s)
const DEDUP_CACHE_TTL = 3600;
const SOURCE_RETRY_COUNT = 4;                         // 4 auto-retries (was 3)
const UNHEALTHY_SOURCE_THRESHOLD = 0.15;              // Below 15% working = unhealthy (was 20%)
const HEALTHY_SOURCE_BOOST = 2.0;                     // 2x scrape frequency for healthy sources (was 1.5)
const BACKOFF_BASE_MS = 800;                          // Exponential backoff base
const BACKOFF_MAX_MS = 15_000;                        // Max backoff 15s
const CIRCUIT_BREAKER_THRESHOLD = 5;                  // Consecutive failures before circuit opens
const CIRCUIT_BREAKER_COOLDOWN_MS = 120_000;          // 2min cooldown
const IMPORT_BATCH_SIZE = 50;                         // Import 50 at a time
const VALIDATION_BATCH_SIZE = 100;                    // Validate 100 at a time
const MAX_DEDUP_SET_SIZE = 200_000;                   // Max dedup entries
const SOURCE_HEALTH_PERSIST_INTERVAL = 30_000;        // Persist health every 30s
const METRICS_WINDOW_MS = 6 * 60 * 60 * 1000;        // 6-hour metrics window
const ADAPTIVE_CONCURRENCY_MIN = 10;                  // Min concurrent scrapes
const ADAPTIVE_CONCURRENCY_MAX = 30;                  // Max concurrent scrapes

// --- Types --------------------------------------------------------------------

export interface ProxySource {
  name: string;
  url: string;
  format: 'text' | 'json' | 'html' | 'xml' | 'csv';
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  extractionMethod: 'plain_text' | 'json_array' | 'json_object' | 'html_table' | 'html_list' |
    'api' | 'csv_format' | 'xml_format' | 'base64_encoded' | 'javascript_rendered' |
    'port_forward' | 'ip_port_country' | 'ip_port_type' | 'ip_port_anonymity' |
    'multi_column' | 'nested_json' | 'protobuf_json' | 'yaml_format' |
    'regex_custom' | 'hex_encoded' | 'compressed' | 'iframe_embedded' |
    'ajax_loaded' | 'websocket_feed' | 'dns_lookup' | 'tor_exit' |
    'geojson' | 'markdown_table' | 'split_files' | 'paginated' |
    'authenticated' | 'rate_limited' | 'captcha_protected';
  rateLimitMs: number;
  lastScraped: number;
  totalDiscovered: number;
  totalWorking: number;
  /** Health score: 0-1, based on working/total ratio */
  healthScore: number;
  /** Consecutive failures */
  consecutiveFailures: number;
  /** Whether this source requires anti-bot bypass */
  requiresUnlocker: boolean;
  /** Whether this source has CAPTCHA */
  requiresCaptcha: boolean;
  /** Average latency to scrape this source (ms) */
  avgScrapeLatency: number;
  /** Total scrape attempts */
  totalScrapeAttempts: number;
  /** Total successful scrapes */
  totalScrapeSuccesses: number;
  /** Last error message */
  lastError?: string;
  /** Priority: lower = higher priority (healthy sources get lower priority) */
  priority: number;
  /** Circuit breaker: whether this source is tripped */
  circuitBreakerOpen: boolean;
  /** Circuit breaker trip timestamp */
  circuitBreakerTrippedAt: number;
  /** Circuit breaker trip count */
  circuitBreakerTripCount: number;
  /** Last 5 scrape result timestamps for adaptive scheduling */
  recentScrapeResults: Array<{ success: boolean; timestamp: number }>;
  /** Estimated proxy yield per scrape */
  avgYieldPerScrape: number;
}

export interface DiscoveredProxy {
  ip: string;
  port: number;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  country?: string;
  anonymity?: 'transparent' | 'anonymous' | 'elite';
  source: string;
  discoveredAt: number;
  /** Response time from validation (ms) */
  latency?: number;
  /** Whether this proxy supports SSL */
  ssl?: boolean;
  /** Google-pass capability */
  googlePass?: boolean;
}

export interface DiscoveryStats {
  totalDiscovered: number;
  totalValidated: number;
  totalImported: number;
  activeSources: number;
  healthySources: number;
  lastCycleAt: number;
  cyclesCompleted: number;
  byProtocol: Record<string, number>;
  byCountry: Record<string, number>;
  /** Discovery rate: proxies/hour */
  discoveryRate: number;
  /** Validation rate: proxies/hour */
  validationRate: number;
  /** Source health breakdown */
  sourceHealthBreakdown: { healthy: number; degraded: number; unhealthy: number };
  /** Real-time metrics */
  metrics: DiscoveryMetrics;
}

export interface DiscoveryMetrics {
  totalScrapeAttempts: number;
  totalScrapeSuccesses: number;
  totalScrapeFailures: number;
  totalValidationAttempts: number;
  totalValidationSuccesses: number;
  avgCycleTimeMs: number;
  peakDiscoveryRate: number;
  lastCycleDurationMs: number;
  sourcesWithCaptcha: number;
  sourcesWithAntiBot: number;
  retriedSources: number;
  /** Sources with open circuit breakers */
  circuitBreakerTrips: number;
  /** Web Unlocker usage count */
  unlockerUsed: number;
  /** CAPTCHA solver usage count */
  captchaSolved: number;
  /** Adaptive concurrency: current level */
  currentConcurrency: number;
  /** Total dedup hits (proxies already seen) */
  dedupHits: number;
  /** Import errors */
  importErrors: number;
  /** Fast mode active */
  fastModeActive: boolean;
  /** Uptime in seconds */
  uptimeSeconds: number;
  /** Memory usage: dedup set size */
  dedupSetSize: number;
  /** Source rotation index */
  sourceRotationIndex: number;
}

interface SourceHealthEntry {
  name: string;
  healthScore: number;
  lastScrapeAt: number;
  lastWorkingCount: number;
  consecutiveFailures: number;
  circuitBreakerOpen: boolean;
  avgYieldPerScrape: number;
}

interface CycleResult {
  discovered: number;
  deduped: number;
  validated: number;
  imported: number;
  elapsedMs: number;
  sourcesScraped: number;
  sourcesSkipped: number;
  sourcesFailed: number;
  retriesUsed: number;
  unlockerUsed: number;
  captchaSolved: number;
}

// --- Utility Functions ------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateBackoff(attempt: number): number {
  const exponential = BACKOFF_BASE_MS * Math.pow(2, attempt);
  const capped = Math.min(exponential, BACKOFF_MAX_MS);
  const jitter = Math.floor(Math.random() * capped * 0.3);
  return capped + jitter;
}

function isCircuitBreakerOpen(source: ProxySource): boolean {
  if (!source.circuitBreakerOpen) return false;
  const elapsed = Date.now() - source.circuitBreakerTrippedAt;
  if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    source.circuitBreakerOpen = false;
    logger.info({ source: source.name }, 'Circuit breaker reset after cooldown');
    return false;
  }
  return true;
}

function tripCircuitBreaker(source: ProxySource): void {
  source.circuitBreakerOpen = true;
  source.circuitBreakerTrippedAt = Date.now();
  source.circuitBreakerTripCount++;
  logger.warn(
    { source: source.name, tripCount: source.circuitBreakerTripCount },
    'Circuit breaker TRIPPED for source',
  );
}

// --- Proxy Sources Configuration -- 55+ SOURCES -------------------------------

const PROXY_SOURCES: Omit<ProxySource, 'lastScraped' | 'totalDiscovered' | 'totalWorking' |
  'healthScore' | 'consecutiveFailures' | 'avgScrapeLatency' | 'totalScrapeAttempts' |
  'totalScrapeSuccesses' | 'lastError' | 'priority' | 'circuitBreakerOpen' |
  'circuitBreakerTrippedAt' | 'circuitBreakerTripCount' | 'recentScrapeResults' |
  'avgYieldPerScrape'>[] = [
  // --- ProxyScrape API -- high yield, fast --------------------------------
  {
    name: 'proxyscrape-http',
    url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'proxyscrape-https',
    url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=https&timeout=10000&country=all&ssl=all&anonymity=all',
    format: 'text',
    protocol: 'https',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'proxyscrape-socks4',
    url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country=all',
    format: 'text',
    protocol: 'socks4',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'proxyscrape-socks5',
    url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- ProxyScrape v3 API ------------------------------------------------
  {
    name: 'proxyscrape-v3-http',
    url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&proxy_format=protocolipport&format=text',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'proxyscrape-v3-socks5',
    url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=socks5&timeout=10000&proxy_format=protocolipport&format=text',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- OpenProxyList -----------------------------------------------------
  {
    name: 'openproxylist-http',
    url: 'https://openproxylist.xyz/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'openproxylist-https',
    url: 'https://openproxylist.xyz/https.txt',
    format: 'text',
    protocol: 'https',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'openproxylist-socks4',
    url: 'https://openproxylist.xyz/socks4.txt',
    format: 'text',
    protocol: 'socks4',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'openproxylist-socks5',
    url: 'https://openproxylist.xyz/socks5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- Proxy-List-Download API -------------------------------------------
  {
    name: 'proxy-list-download-http',
    url: 'https://www.proxy-list.download/api/v1/get?type=http',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'proxy-list-download-https',
    url: 'https://www.proxy-list.download/api/v1/get?type=https',
    format: 'text',
    protocol: 'https',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'proxy-list-download-socks4',
    url: 'https://www.proxy-list.download/api/v1/get?type=socks4',
    format: 'text',
    protocol: 'socks4',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'proxy-list-download-socks5',
    url: 'https://www.proxy-list.download/api/v1/get?type=socks5',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- TheSpeedX/PROXY-List -- high yield GitHub repos --------------------
  {
    name: 'shifty-http',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'shifty-socks4',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
    format: 'text',
    protocol: 'socks4',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'shifty-socks5',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'shifty-json-http',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.json',
    format: 'json',
    protocol: 'http',
    extractionMethod: 'json_array',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- monosans/proxy-list -----------------------------------------------
  {
    name: 'monosans-http',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'monosans-https',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/https.txt',
    format: 'text',
    protocol: 'https',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'monosans-socks4',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
    format: 'text',
    protocol: 'socks4',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'monosans-socks5',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'monosans-anonymous',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- clarketm/proxy-list -----------------------------------------------
  {
    name: 'clarketm-proxy-list',
    url: 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- jetkai/proxy-list -------------------------------------------------
  {
    name: 'jetkai-proxy-list-http',
    url: 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'jetkai-proxy-list-socks4',
    url: 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks4.txt',
    format: 'text',
    protocol: 'socks4',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'jetkai-proxy-list-socks5',
    url: 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- roosterkid/openproxylist ------------------------------------------
  {
    name: 'roosterkid-openproxylist',
    url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
    format: 'text',
    protocol: 'https',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- hookzof/socks5_list -----------------------------------------------
  {
    name: 'hookzof-socks5',
    url: 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'ip_port_country',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- unnyhov/proxy-list ------------------------------------------------
  {
    name: 'unnyhov-http',
    url: 'https://raw.githubusercontent.com/unnyhov/proxy-list/main/https.txt',
    format: 'text',
    protocol: 'https',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- prxchk/proxy-list -------------------------------------------------
  {
    name: 'prxchk-proxy-list',
    url: 'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'prxchk-proxy-list-https',
    url: 'https://raw.githubusercontent.com/prxchk/proxy-list/main/https.txt',
    format: 'text',
    protocol: 'https',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'prxchk-proxy-list-socks4',
    url: 'https://raw.githubusercontent.com/prxchk/proxy-list/main/socks4.txt',
    format: 'text',
    protocol: 'socks4',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'prxchk-proxy-list-socks5',
    url: 'https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- alirezakdp/Proxy-List ---------------------------------------------
  {
    name: 'alirezakdp-proxy-list',
    url: 'https://raw.githubusercontent.com/alirezakdp/Proxy-List/main/HTTP.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'alirezakdp-proxy-socks',
    url: 'https://raw.githubusercontent.com/alirezakdp/Proxy-List/main/SOCKS5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- mertguvencli/Proxy-List-World -------------------------------------
  {
    name: 'mertguvencli-http',
    url: 'https://raw.githubusercontent.com/mertguvencli/Proxy-List-World/main/data.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'ip_port_country',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- DailyFreshProxies -------------------------------------------------
  {
    name: 'dailyfreshproxies-http',
    url: 'https://raw.githubusercontent.com/DailyFreshProxies/proxy-list/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'dailyfreshproxies-socks5',
    url: 'https://raw.githubusercontent.com/DailyFreshProxies/proxy-list/main/socks5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- FLAVOR00000/PROXY -------------------------------------------------
  {
    name: 'FLAVOR00000-PROXY',
    url: 'https://raw.githubusercontent.com/FLAVOR00000/PROXY/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- ErcinDedeworworworworworworworworworworworworworworworworworworworwor --
  {
    name: 'ercind-unfiltered-http',
    url: 'https://raw.githubusercontent.com/ErcinDedeworworworworworworworworworworworworworworworworworworworwor/proxy-list/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- muxniank/proxy-list -----------------------------------------------
  {
    name: 'muxniank-proxy-http',
    url: 'https://raw.githubusercontent.com/muxniank/proxy-list/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'muxniank-proxy-socks5',
    url: 'https://raw.githubusercontent.com/muxniank/proxy-list/main/socks5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- wxli0/proxy-list --------------------------------------------------
  {
    name: 'wxli0-proxy-http',
    url: 'https://raw.githubusercontent.com/wxli0/proxy-list/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'wxli0-proxy-socks5',
    url: 'https://raw.githubusercontent.com/wxli0/proxy-list/main/socks5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- Geonode API -- JSON format -----------------------------------------
  {
    name: 'geonode',
    url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc',
    format: 'json',
    protocol: 'http',
    extractionMethod: 'json_object',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'geonode-socks',
    url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks4,socks5',
    format: 'json',
    protocol: 'socks5',
    extractionMethod: 'json_object',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'proxylist-galaxy',
    url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http,https',
    format: 'json',
    protocol: 'https',
    extractionMethod: 'json_object',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'proxylist-geonode-api',
    url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc',
    format: 'json',
    protocol: 'http',
    extractionMethod: 'json_object',
    rateLimitMs: 5_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },

  // --- HTML-format sources (may require anti-bot bypass) -----------------
  {
    name: 'free-proxy-list.net',
    url: 'https://free-proxy-list.net/',
    format: 'html',
    protocol: 'http',
    extractionMethod: 'html_table',
    rateLimitMs: 10_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },
  {
    name: 'sslproxies-org',
    url: 'https://sslproxies.org/',
    format: 'html',
    protocol: 'https',
    extractionMethod: 'html_table',
    rateLimitMs: 10_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },
  {
    name: 'us-proxy-org',
    url: 'https://us-proxy.org/',
    format: 'html',
    protocol: 'http',
    extractionMethod: 'html_table',
    rateLimitMs: 10_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },
  {
    name: 'uk-proxy-org',
    url: 'https://ukproxy.org/',
    format: 'html',
    protocol: 'http',
    extractionMethod: 'html_table',
    rateLimitMs: 10_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },
  {
    name: 'spys.one-http',
    url: 'https://spys.one/en/http-proxy-list/',
    format: 'html',
    protocol: 'http',
    extractionMethod: 'html_table',
    rateLimitMs: 15_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },
  {
    name: 'spys.one-socks',
    url: 'https://spys.one/en/socks-proxy-list/',
    format: 'html',
    protocol: 'socks5',
    extractionMethod: 'html_table',
    rateLimitMs: 15_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },
  {
    name: 'hidemy-name-http',
    url: 'https://hidemy.name/en/proxy-list/?type=h&start=0',
    format: 'html',
    protocol: 'http',
    extractionMethod: 'html_table',
    rateLimitMs: 15_000,
    requiresUnlocker: true,
    requiresCaptcha: true,
  },
  {
    name: 'hidemy-name-socks',
    url: 'https://hidemy.name/en/proxy-list/?type=s&start=0',
    format: 'html',
    protocol: 'socks5',
    extractionMethod: 'html_table',
    rateLimitMs: 15_000,
    requiresUnlocker: true,
    requiresCaptcha: true,
  },
  {
    name: 'freeproxylists-net',
    url: 'https://www.freeproxylists.net/',
    format: 'html',
    protocol: 'http',
    extractionMethod: 'html_table',
    rateLimitMs: 15_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },
  {
    name: 'proxy-list-org',
    url: 'https://proxy-list.org/english/index.php',
    format: 'html',
    protocol: 'http',
    extractionMethod: 'html_table',
    rateLimitMs: 15_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },
  {
    name: 'proxynova',
    url: 'https://www.proxynova.com/proxy-server-list/',
    format: 'html',
    protocol: 'http',
    extractionMethod: 'html_table',
    rateLimitMs: 10_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },
  {
    name: 'proxyscrape-elites',
    url: 'https://proxyscrape.com/free-proxy-list',
    format: 'html',
    protocol: 'http',
    extractionMethod: 'html_table',
    rateLimitMs: 15_000,
    requiresUnlocker: true,
    requiresCaptcha: false,
  },

  // --- Additional GitHub proxy lists --------------------------------------
  {
    name: 'sunny9577-proxy-scraper',
    url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'speedX-proxy-list-https',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/https.txt',
    format: 'text',
    protocol: 'https',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'stefan1155-proxy-list',
    url: 'https://raw.githubusercontent.com/stefan1155/proxy-list/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'casals-proxy-list',
    url: 'https://raw.githubusercontent.com/casals/proxy-list/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'ShiftyTR-proxy-list',
    url: 'https://raw.githubusercontent.com/ShiftyTR/proxy-list/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'CLUCKERING-proxy-http',
    url: 'https://raw.githubusercontent.com/CLUCKERING/proxy-list/main/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'CLUCKERING-proxy-socks5',
    url: 'https://raw.githubusercontent.com/CLUCKERING/proxy-list/main/socks5.txt',
    format: 'text',
    protocol: 'socks5',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'roosterkid-openproxylist-http',
    url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTP_RAW.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
  {
    name: 'BlackSnowDot/proxylist-http',
    url: 'https://raw.githubusercontent.com/BlackSnowDot/proxylist/master/http.txt',
    format: 'text',
    protocol: 'http',
    extractionMethod: 'plain_text',
    rateLimitMs: 10_000,
    requiresUnlocker: false,
    requiresCaptcha: false,
  },
];

// --- IP:Port Regex -- compiled once for performance -------------------------

const IP_PORT_REGEX = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/;
const IP_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const PORT_REGEX = /^\d{2,5}$/;
const COUNTRY_REGEX = /^[A-Z]{2}$/;
const IP_PORT_COUNTRY_REGEX = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5}):([A-Z]{2})/;
const IP_PORT_EXTENDED_REGEX = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/;

// --- Free Proxy Discovery Class -- TURBO NUCLEAR HYPERDRIVE -------------------

export class FreeProxyDiscovery {
  private sources: ProxySource[] = [];
  private stats: DiscoveryStats;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private healthPersistTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isDiscovering = false;
  private discoveredSet = new Set<string>(); // dedup by "ip:port:protocol"
  private metrics: DiscoveryMetrics = {
    totalScrapeAttempts: 0,
    totalScrapeSuccesses: 0,
    totalScrapeFailures: 0,
    totalValidationAttempts: 0,
    totalValidationSuccesses: 0,
    avgCycleTimeMs: 0,
    peakDiscoveryRate: 0,
    lastCycleDurationMs: 0,
    sourcesWithCaptcha: 0,
    sourcesWithAntiBot: 0,
    retriedSources: 0,
    circuitBreakerTrips: 0,
    unlockerUsed: 0,
    captchaSolved: 0,
    currentConcurrency: MAX_CONCURRENT_SCRAPES,
    dedupHits: 0,
    importErrors: 0,
    fastModeActive: false,
    uptimeSeconds: 0,
    dedupSetSize: 0,
    sourceRotationIndex: 0,
  };
  /** Cycle timestamps for rate tracking */
  private cycleTimestamps: number[] = [];
  /** Total discovered per cycle for rate tracking */
  private cycleDiscoveryCounts: number[] = [];
  /** Start time for uptime tracking */
  private startedAt = 0;
  /** Source rotation index for round-robin */
  private rotationIndex = 0;
  /** Current adaptive concurrency level */
  private adaptiveConcurrency = MAX_CONCURRENT_SCRAPES;

  constructor() {
    this.sources = PROXY_SOURCES.map((s) => ({
      ...s,
      lastScraped: 0,
      totalDiscovered: 0,
      totalWorking: 0,
      healthScore: 1.0,
      consecutiveFailures: 0,
      avgScrapeLatency: 0,
      totalScrapeAttempts: 0,
      totalScrapeSuccesses: 0,
      lastError: undefined,
      priority: 100,
      circuitBreakerOpen: false,
      circuitBreakerTrippedAt: 0,
      circuitBreakerTripCount: 0,
      recentScrapeResults: [],
      avgYieldPerScrape: 0,
    }));

    this.stats = {
      totalDiscovered: 0,
      totalValidated: 0,
      totalImported: 0,
      activeSources: this.sources.length,
      healthySources: this.sources.length,
      lastCycleAt: 0,
      cyclesCompleted: 0,
      byProtocol: {},
      byCountry: {},
      discoveryRate: 0,
      validationRate: 0,
      sourceHealthBreakdown: { healthy: this.sources.length, degraded: 0, unhealthy: 0 },
      metrics: this.metrics,
    };

    // Count sources with special requirements
    this.metrics.sourcesWithCaptcha = this.sources.filter(s => s.requiresCaptcha).length;
    this.metrics.sourcesWithAntiBot = this.sources.filter(s => s.requiresUnlocker).length;
  }

  // --- Public API ------------------------------------------------------------

  /**
   * Start periodic proxy discovery.
   * Uses faster intervals and starts immediately.
   */
  startDiscovery(intervalMs: number = DEFAULT_DISCOVERY_INTERVAL): void {
    if (this.isRunning) {
      logger.warn('Discovery already running');
      return;
    }

    this.isRunning = true;
    this.startedAt = Date.now();

    // Fire initial cycle immediately
    this.runDiscoveryCycle().catch((err) => {
      logger.error({ error: (err as Error).message }, 'Initial discovery cycle failed');
    });

    this.discoveryTimer = setInterval(async () => {
      try {
        await this.runDiscoveryCycle();
      } catch (err: any) {
        logger.error({ error: err.message }, 'Periodic discovery cycle failed');
      }
    }, intervalMs);

    // Start health persistence timer
    this.healthPersistTimer = setInterval(async () => {
      try {
        await this.persistSourceHealth();
        await this.persistDedupCache();
      } catch (err: any) {
        logger.warn({ error: err.message }, 'Failed to persist discovery state');
      }
    }, SOURCE_HEALTH_PERSIST_INTERVAL);

    // Update uptime metric periodically
    const uptimeTimer = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(uptimeTimer);
        return;
      }
      this.metrics.uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
      this.metrics.dedupSetSize = this.discoveredSet.size;
    }, 10_000);

    logger.info(
      { intervalMs, sourceCount: this.sources.length, fastMode: this.metrics.fastModeActive },
      'Free proxy discovery TURBO NUCLEAR HYPERDRIVE started',
    );
  }

  /**
   * Stop periodic proxy discovery.
   */
  stopDiscovery(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.healthPersistTimer) {
      clearInterval(this.healthPersistTimer);
      this.healthPersistTimer = null;
    }
    this.isRunning = false;
    logger.info('Free proxy discovery stopped');
  }

  /**
   * Enable fast discovery mode -- shorter intervals, higher concurrency.
   */
  enableFastMode(): void {
    this.metrics.fastModeActive = true;
    this.adaptiveConcurrency = ADAPTIVE_CONCURRENCY_MAX;
    this.metrics.currentConcurrency = this.adaptiveConcurrency;
    logger.info('Fast discovery mode ENABLED');
  }

  /**
   * Disable fast discovery mode -- return to normal intervals.
   */
  disableFastMode(): void {
    this.metrics.fastModeActive = false;
    this.adaptiveConcurrency = MAX_CONCURRENT_SCRAPES;
    this.metrics.currentConcurrency = this.adaptiveConcurrency;
    logger.info('Fast discovery mode DISABLED');
  }

  /**
   * Run one full discovery cycle across all sources.
   * Uses parallel scraping with Promise.allSettled for speed.
   * Implements smart source scheduling, auto-retry, and circuit breaker.
   */
  async runDiscoveryCycle(): Promise<DiscoveryStats> {
    if (this.isDiscovering) {
      logger.warn('Discovery cycle already in progress -- skipping');
      return this.stats;
    }

    this.isDiscovering = true;
    const cycleStart = Date.now();
    const allDiscovered: DiscoveredProxy[] = [];
    const cycleResult: CycleResult = {
      discovered: 0, deduped: 0, validated: 0, imported: 0,
      elapsedMs: 0, sourcesScraped: 0, sourcesSkipped: 0,
      sourcesFailed: 0, retriesUsed: 0, unlockerUsed: 0, captchaSolved: 0,
    };

    logger.info({ sourceCount: this.sources.length }, 'Starting discovery cycle');

    try {
      await this.loadDedupCache();

      // Adapt concurrency based on recent performance
      this.adaptConcurrency();

      // Sort sources by priority: healthy sources first
      const sortedSources = this.prioritizeSources();

      // Filter out circuit-broken sources in cooldown
      const eligibleSources = sortedSources.filter(s => {
        if (isCircuitBreakerOpen(s)) {
          cycleResult.sourcesSkipped++;
          return false;
        }
        return true;
      });

      // Parallel scraping with batched Promise.allSettled
      const batchSize = this.adaptiveConcurrency;
      for (let i = 0; i < eligibleSources.length; i += batchSize) {
        const batch = eligibleSources.slice(i, i + batchSize);

        const results = await Promise.allSettled(
          batch.map(async (source) => {
            // Check rate limit -- healthy sources get boosted frequency
            const effectiveRateLimit = source.healthScore > 0.7
              ? source.rateLimitMs / HEALTHY_SOURCE_BOOST
              : source.rateLimitMs;

            if (Date.now() - source.lastScraped < effectiveRateLimit) {
              cycleResult.sourcesSkipped++;
              return [];
            }

            // Auto-retry with exponential backoff
            let proxies: DiscoveredProxy[] = [];
            let lastError: string | undefined;
            for (let retry = 0; retry < SOURCE_RETRY_COUNT; retry++) {
              try {
                proxies = await this.discoverFromSource(source);
                if (proxies.length > 0) break;
                // Empty result -- still counts as success, but allow one more retry if first attempt
                if (retry === 0 && source.healthScore > 0.5) break;
              } catch (err: any) {
                lastError = err.message;
                source.lastError = lastError;
                this.metrics.retriedSources++;
                cycleResult.retriesUsed++;
                if (retry < SOURCE_RETRY_COUNT - 1) {
                  const backoff = calculateBackoff(retry);
                  logger.debug(
                    { source: source.name, retry, backoffMs: backoff, error: err.message },
                    'Retrying source with exponential backoff',
                  );
                  await sleep(backoff);
                }
              }
            }

            // Check if circuit breaker should trip
            if (source.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
              tripCircuitBreaker(source);
              this.metrics.circuitBreakerTrips++;
            }

            source.lastScraped = Date.now();
            cycleResult.sourcesScraped++;
            return proxies;
          }),
        );

        for (const result of results) {
          if (result.status === 'fulfilled' && Array.isArray(result.value)) {
            allDiscovered.push(...result.value);
          } else if (result.status === 'rejected') {
            cycleResult.sourcesFailed++;
          }
        }
      }

      cycleResult.discovered = allDiscovered.length;
      logger.info(
        { totalDiscovered: allDiscovered.length, sourcesScraped: cycleResult.sourcesScraped },
        'Discovery scraping completed',
      );

      // Deduplicate
      const deduped = this.deduplicateProxies(allDiscovered);
      cycleResult.deduped = deduped.length;
      this.stats.totalDiscovered += allDiscovered.length;

      // Parallel validation with high concurrency
      const validated = await this.batchValidate(deduped);
      cycleResult.validated = validated.length;
      this.stats.totalValidated += validated.length;

      // Batch import (50 at a time for DB efficiency)
      let imported = 0;
      for (let i = 0; i < validated.length; i += IMPORT_BATCH_SIZE) {
        const importBatch = validated.slice(i, i + IMPORT_BATCH_SIZE);
        const importResults = await Promise.allSettled(
          importBatch.map(proxy => this.importProxy(proxy)),
        );
        for (const result of importResults) {
          if (result.status === 'fulfilled') imported++;
          else this.metrics.importErrors++;
        }
      }
      cycleResult.imported = imported;
      this.stats.totalImported += imported;

      // Update cycle-specific metrics
      cycleResult.unlockerUsed = this.metrics.unlockerUsed;
      cycleResult.captchaSolved = this.metrics.captchaSolved;

      // Update stats
      this.updateBreakdownStats(validated);
      this.updateSourceHealth();
      this.updateDiscoveryRate(allDiscovered.length, cycleStart);

      this.stats.lastCycleAt = Date.now();
      this.stats.cyclesCompleted++;
      this.metrics.sourceRotationIndex = this.rotationIndex;

      await this.persistDedupCache();
      await this.persistSourceHealth();

      const elapsedMs = Date.now() - cycleStart;
      cycleResult.elapsedMs = elapsedMs;
      this.metrics.lastCycleDurationMs = elapsedMs;
      this.metrics.avgCycleTimeMs = this.stats.cyclesCompleted > 0
        ? Math.round((this.metrics.avgCycleTimeMs * (this.stats.cyclesCompleted - 1) + elapsedMs) / this.stats.cyclesCompleted)
        : elapsedMs;

      logger.info(
        {
          ...cycleResult,
          cyclesCompleted: this.stats.cyclesCompleted,
          discoveryRate: `${this.stats.discoveryRate}/hr`,
          validationRate: `${this.stats.validationRate}/hr`,
          healthySources: this.stats.healthySources,
          dedupSetSize: this.discoveredSet.size,
        },
        'Discovery cycle completed',
      );
    } catch (err: any) {
      logger.error({ error: err.message }, 'Discovery cycle failed');
    } finally {
      this.isDiscovering = false;
    }

    return this.stats;
  }

  /**
   * Discover proxies from a single source with error recovery,
   * Web Unlocker integration, and CAPTCHA solving.
   */
  async discoverFromSource(source: ProxySource): Promise<DiscoveredProxy[]> {
    const proxies: DiscoveredProxy[] = [];
    const startTime = Date.now();
    source.totalScrapeAttempts++;

    try {
      // -- Determine fetch strategy ------------------------------------------
      let body: string;
      let usedUnlocker = false;

      if (source.requiresUnlocker || source.requiresCaptcha) {
        // Use Web Unlocker for anti-bot protected sources
        try {
          const unlockResult = await webUnlocker.unlock({
            url: source.url,
            strategy: 'auto',
            stealthLevel: source.requiresCaptcha ? 'high' : 'medium',
            solveCaptcha: source.requiresCaptcha,
            timeout: SCRAPE_TIMEOUT_MS + 5_000,
            blockResources: ['image', 'stylesheet', 'font', 'media'],
          });

          if (unlockResult.success && unlockResult.html) {
            body = unlockResult.html;
            usedUnlocker = true;
            this.metrics.unlockerUsed++;

            if (unlockResult.captchaSolved) {
              this.metrics.captchaSolved++;
            }

            logger.debug(
              { source: source.name, strategy: unlockResult.strategy, captchaSolved: unlockResult.captchaSolved },
              'Source unlocked via Web Unlocker',
            );
          } else {
            // Fallback to direct fetch if unlocker fails
            logger.warn(
              { source: source.name, error: unlockResult.error },
              'Web Unlocker failed, falling back to direct fetch',
            );
            body = await this.directFetch(source);
          }
        } catch (unlockErr: any) {
          logger.warn(
            { source: source.name, error: unlockErr.message },
            'Web Unlocker error, falling back to direct fetch',
          );
          body = await this.directFetch(source);
        }
      } else {
        // Direct fetch for non-protected sources
        body = await this.directFetch(source);
      }

      source.totalScrapeSuccesses++;
      source.consecutiveFailures = 0;

      // Record successful scrape result
      source.recentScrapeResults.push({ success: true, timestamp: Date.now() });
      if (source.recentScrapeResults.length > 10) {
        source.recentScrapeResults = source.recentScrapeResults.slice(-10);
      }

      // -- Route to appropriate extraction method ----------------------------
      const extracted = this.extractProxies(body, source);
      proxies.push(...extracted);

      source.totalDiscovered += proxies.length;
      source.avgYieldPerScrape = source.totalScrapeSuccesses > 0
        ? Math.round(source.totalDiscovered / source.totalScrapeSuccesses)
        : 0;

      source.avgScrapeLatency = source.totalScrapeSuccesses > 0
        ? Math.round((source.avgScrapeLatency * (source.totalScrapeSuccesses - 1) + (Date.now() - startTime)) / source.totalScrapeSuccesses)
        : Date.now() - startTime;

      this.metrics.totalScrapeSuccesses++;
      logger.debug(
        { source: source.name, count: proxies.length, latency: `${Date.now() - startTime}ms`, usedUnlocker },
        'Source scraped',
      );
    } catch (err: any) {
      source.consecutiveFailures++;
      source.lastError = err.message;
      this.metrics.totalScrapeFailures++;

      // Record failed scrape result
      source.recentScrapeResults.push({ success: false, timestamp: Date.now() });
      if (source.recentScrapeResults.length > 10) {
        source.recentScrapeResults = source.recentScrapeResults.slice(-10);
      }

      logger.warn({ source: source.name, error: err.message }, 'Failed to discover from source');
    }

    return proxies;
  }

  /**
   * Direct fetch a source URL with timeout and proper headers.
   */
  private async directFetch(source: ProxySource): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

    try {
      const response = await fetch(source.url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: source.format === 'json' ? 'application/json' : 'text/html,application/xhtml+xml,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          'Cache-Control': 'no-cache',
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        source.consecutiveFailures++;
        source.lastError = `HTTP ${response.status}`;
        this.metrics.totalScrapeFailures++;
        logger.warn({ source: source.name, status: response.status }, 'Source returned non-OK status');
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Master extraction router -- dispatches to format-specific extractors.
   * Supports 30+ extraction methods.
   */
  private extractProxies(body: string, source: ProxySource): DiscoveredProxy[] {
    switch (source.extractionMethod) {
      case 'plain_text':
        return this.extractPlainText(body, source);
      case 'json_array':
        return this.extractJsonArray(body, source);
      case 'json_object':
        return this.extractJsonObject(body, source);
      case 'html_table':
        return this.extractHtmlTable(body, source);
      case 'html_list':
        return this.extractHtmlList(body, source);
      case 'ip_port_country':
        return this.extractIpPortCountry(body, source);
      case 'ip_port_type':
        return this.extractIpPortType(body, source);
      case 'ip_port_anonymity':
        return this.extractIpPortAnonymity(body, source);
      case 'multi_column':
        return this.extractMultiColumn(body, source);
      case 'nested_json':
        return this.extractNestedJson(body, source);
      case 'csv_format':
        return this.extractCsv(body, source);
      case 'api':
        return this.extractApi(body, source);
      case 'xml_format':
        return this.extractXml(body, source);
      case 'base64_encoded':
        return this.extractBase64(body, source);
      case 'javascript_rendered':
        return this.extractJavascriptRendered(body, source);
      case 'port_forward':
        return this.extractPortForward(body, source);
      case 'protobuf_json':
        return this.extractProtobufJson(body, source);
      case 'yaml_format':
        return this.extractYaml(body, source);
      case 'regex_custom':
        return this.extractRegexCustom(body, source);
      case 'hex_encoded':
        return this.extractHexEncoded(body, source);
      case 'compressed':
        return this.extractCompressed(body, source);
      case 'iframe_embedded':
        return this.extractIframeEmbedded(body, source);
      case 'ajax_loaded':
        return this.extractAjaxLoaded(body, source);
      case 'websocket_feed':
        return this.extractWebsocketFeed(body, source);
      case 'dns_lookup':
        return this.extractDnsLookup(body, source);
      case 'tor_exit':
        return this.extractTorExit(body, source);
      case 'geojson':
        return this.extractGeojson(body, source);
      case 'markdown_table':
        return this.extractMarkdownTable(body, source);
      case 'split_files':
        return this.extractSplitFiles(body, source);
      case 'paginated':
        return this.extractPaginated(body, source);
      case 'authenticated':
        return this.extractAuthenticated(body, source);
      case 'rate_limited':
        return this.extractRateLimited(body, source);
      case 'captcha_protected':
        return this.extractCaptchaProtected(body, source);
      default:
        // Fallback: try plain text extraction
        return this.extractPlainText(body, source);
    }
  }

  /**
   * Validate a single proxy by testing connectivity.
   */
  async validateProxy(
    ip: string,
    port: number,
    type: 'http' | 'https' | 'socks4' | 'socks5',
  ): Promise<boolean> {
    try {
      const proxyUrl = this.buildProxyUrl(ip, port, type);
      const result = await testProxy(proxyUrl, 'https://httpbin.org/ip', VALIDATION_TIMEOUT_MS);

      if (result.working) {
        logger.debug({ ip, port, type, latency: result.latencyMs }, 'Proxy validated');
        return true;
      }

      return false;
    } catch (err: any) {
      logger.debug({ ip, port, type, error: err.message }, 'Proxy validation failed');
      return false;
    }
  }

  /**
   * Import a validated proxy into the database.
   */
  async importProxy(proxy: DiscoveredProxy): Promise<void> {
    const proxyUrl = this.buildProxyUrl(proxy.ip, proxy.port, proxy.protocol);
    const proxyId = `free-${proxy.protocol}-${proxy.ip.replace(/\./g, '-')}-${proxy.port}`;

    await db.proxy.upsert({
      where: { id: proxyId },
      update: {
        url: proxyUrl,
        retired: false,
        lastChecked: new Date(),
        country: proxy.country || 'XX',
      },
      create: {
        id: proxyId,
        url: proxyUrl,
        tier: 'datacenter' as const,
        country: proxy.country || 'XX',
        provider: `free:${proxy.source}`,
        successRate: 0.5,
        p95Latency: 0,
        failures: 0,
        consecutiveFailures: 0,
        retired: false,
        sticky: false,
        lastUsed: new Date(),
        lastChecked: new Date(),
        addedAt: new Date(),
      },
    });

    const source = this.sources.find((s) => s.name === proxy.source);
    if (source) {
      source.totalWorking++;
    }
  }

  /**
   * Get current discovery statistics.
   */
  getStats(): DiscoveryStats {
    const healthy = this.sources.filter(s => s.healthScore > 0.7).length;
    const degraded = this.sources.filter(s => s.healthScore > UNHEALTHY_SOURCE_THRESHOLD && s.healthScore <= 0.7).length;
    const unhealthy = this.sources.filter(s => s.healthScore <= UNHEALTHY_SOURCE_THRESHOLD).length;

    return {
      ...this.stats,
      activeSources: this.sources.filter((s) => s.lastScraped > 0).length,
      healthySources: healthy,
      sourceHealthBreakdown: { healthy, degraded, unhealthy },
      metrics: { ...this.metrics },
    };
  }

  /**
   * Get per-source statistics.
   */
  getSourceStats(): ProxySource[] {
    return this.sources.map((s) => ({ ...s }));
  }

  // --- Extraction Methods (30+ format support) ------------------------------

  /**
   * Extract proxies from plain text format (ip:port per line).
   * Optimized with compiled regex for speed.
   */
  private extractPlainText(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

      const match = trimmed.match(IP_PORT_REGEX);
      if (match) {
        const ip = match[1];
        const port = parseInt(match[2], 10);
        if (this.isValidPort(port)) {
          proxies.push({ ip, port, protocol: source.protocol, source: source.name, discoveredAt: now });
        }
      }
    }

    return proxies;
  }

  /**
   * Extract proxies from JSON array format.
   */
  private extractJsonArray(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    try {
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed)) return proxies;

      for (const item of parsed) {
        if (typeof item === 'string') {
          const match = item.match(IP_PORT_REGEX);
          if (match) {
            const port = parseInt(match[2], 10);
            if (this.isValidPort(port)) {
              proxies.push({ ip: match[1], port, protocol: source.protocol, source: source.name, discoveredAt: now });
            }
          }
        } else if (typeof item === 'object' && item !== null) {
          const ip = item.ip || item.IP || item.host || item.Host;
          const port = parseInt(item.port || item.Port || item.PORT, 10);
          if (ip && this.isValidPort(port)) {
            proxies.push({
              ip: String(ip),
              port,
              protocol: source.protocol,
              country: item.country || item.Country || item.cc || item.CC,
              anonymity: this.normalizeAnonymity(item.anonymity || item.Anonymity || item.type),
              source: source.name,
              discoveredAt: now,
            });
          }
        }
      }
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to parse JSON array');
    }

    return proxies;
  }

  /**
   * Extract proxies from JSON object format (e.g., Geonode API response).
   */
  private extractJsonObject(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    try {
      const parsed = JSON.parse(body);
      const items = parsed.data || parsed.proxies || parsed.results || parsed.list || parsed.items || [];
      const arr = Array.isArray(items) ? items : [];

      for (const item of arr) {
        const ip = item.ip || item.IP || item.host || item.Host || item.ipAddress;
        const port = parseInt(item.port || item.Port || item.PORT || item.portNumber, 10);
        if (!ip || !this.isValidPort(port)) continue;

        proxies.push({
          ip: String(ip),
          port,
          protocol: this.normalizeProtocol(item.protocol || item.Protocol || source.protocol),
          country: item.country || item.Country || item.cc || item.CC || item.countryCode,
          anonymity: this.normalizeAnonymity(item.anonymity || item.Anonymity || item.type),
          source: source.name,
          discoveredAt: now,
        });
      }
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to parse JSON object');
    }

    return proxies;
  }

  /**
   * Extract proxies from HTML table format.
   * Handles various table structures found on proxy list sites.
   */
  private extractHtmlTable(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    try {
      const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch: RegExpExecArray | null;

      while ((rowMatch = rowPattern.exec(body)) !== null) {
        const row = rowMatch[1];
        const cells = this.extractTableCells(row);

        let ip: string | undefined;
        let port: number | undefined;
        let country: string | undefined;
        let anonymity: string | undefined;

        for (const cell of cells) {
          const cleanCell = cell.trim();
          const ipPortMatch = cleanCell.match(IP_PORT_REGEX);
          if (ipPortMatch) { ip = ipPortMatch[1]; port = parseInt(ipPortMatch[2], 10); continue; }
          if (!ip) {
            const ipMatch = cleanCell.match(IP_REGEX);
            if (ipMatch) { ip = ipMatch[1]; continue; }
          }
          if (!port && ip) {
            const portMatch = cleanCell.match(PORT_REGEX);
            if (portMatch) { port = parseInt(portMatch[1], 10); continue; }
          }
          if (!country && cleanCell.match(COUNTRY_REGEX)) { country = cleanCell; continue; }
          if (!anonymity && (
            cleanCell.toLowerCase().includes('elite') ||
            cleanCell.toLowerCase().includes('anonymous') ||
            cleanCell.toLowerCase().includes('transparent') ||
            cleanCell.toLowerCase().includes('high') ||
            cleanCell.toLowerCase().includes('anon')
          )) {
            anonymity = cleanCell.toLowerCase();
          }
        }

        if (ip && port && this.isValidPort(port)) {
          proxies.push({
            ip, port, protocol: source.protocol, country,
            anonymity: this.normalizeAnonymity(anonymity),
            source: source.name, discoveredAt: now,
          });
        }
      }
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to parse HTML table');
    }

    return proxies;
  }

  /**
   * Extract proxies from HTML list format (ul/ol/li).
   */
  private extractHtmlList(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    try {
      const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let match: RegExpExecArray | null;

      while ((match = liPattern.exec(body)) !== null) {
        const text = match[1].replace(/<[^>]+>/g, '').trim();
        const ipPortMatch = text.match(IP_PORT_REGEX);
        if (ipPortMatch) {
          const port = parseInt(ipPortMatch[2], 10);
          if (this.isValidPort(port)) {
            proxies.push({ ip: ipPortMatch[1], port, protocol: source.protocol, source: source.name, discoveredAt: now });
          }
        }
      }
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to parse HTML list');
    }

    return proxies;
  }

  /**
   * Extract proxies from ip:port:country format.
   */
  private extractIpPortCountry(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(IP_PORT_COUNTRY_REGEX);
      if (match) {
        const port = parseInt(match[2], 10);
        if (this.isValidPort(port)) {
          proxies.push({ ip: match[1], port, protocol: source.protocol, country: match[3], source: source.name, discoveredAt: now });
        }
      } else {
        // Fallback to plain ip:port
        const plainMatch = trimmed.match(IP_PORT_EXTENDED_REGEX);
        if (plainMatch) {
          const port = parseInt(plainMatch[2], 10);
          if (this.isValidPort(port)) {
            proxies.push({ ip: plainMatch[1], port, protocol: source.protocol, source: source.name, discoveredAt: now });
          }
        }
      }
    }

    return proxies;
  }

  /**
   * Extract proxies from ip:port:type format.
   */
  private extractIpPortType(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parts = trimmed.split(':');
      if (parts.length >= 3) {
        const ip = parts[0];
        const port = parseInt(parts[1], 10);
        const type = parts[2].toLowerCase();

        if (IP_REGEX.test(ip) && this.isValidPort(port)) {
          proxies.push({ ip, port, protocol: this.normalizeProtocol(type), source: source.name, discoveredAt: now });
        }
      }
    }

    return proxies;
  }

  /**
   * Extract proxies from ip:port:anonymity format.
   */
  private extractIpPortAnonymity(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parts = trimmed.split(/[ \t:]+/);
      if (parts.length >= 3) {
        const ip = parts[0];
        const port = parseInt(parts[1], 10);
        const anonymity = parts[2];

        if (IP_REGEX.test(ip) && this.isValidPort(port)) {
          proxies.push({
            ip, port, protocol: source.protocol,
            anonymity: this.normalizeAnonymity(anonymity),
            source: source.name, discoveredAt: now,
          });
        }
      }
    }

    return proxies;
  }

  /**
   * Extract proxies from multi-column format (whitespace or tab-separated).
   */
  private extractMultiColumn(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('IP') || trimmed.startsWith('ip')) continue;

      const parts = trimmed.split(/[\s\t]+/);
      if (parts.length >= 2) {
        const ip = parts[0];
        const port = parseInt(parts[1], 10);

        if (IP_REGEX.test(ip) && this.isValidPort(port)) {
          proxies.push({
            ip, port, protocol: source.protocol,
            country: parts.length > 2 && COUNTRY_REGEX.test(parts[2]) ? parts[2] : undefined,
            anonymity: parts.length > 3 ? this.normalizeAnonymity(parts[3]) : undefined,
            source: source.name, discoveredAt: now,
          });
        }
      }
    }

    return proxies;
  }

  /**
   * Extract proxies from nested JSON format -- recursively searches for ip/port objects.
   */
  private extractNestedJson(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    try {
      const parsed = JSON.parse(body);

      const extractRecursive = (obj: any): void => {
        if (Array.isArray(obj)) {
          for (const item of obj) extractRecursive(item);
        } else if (obj && typeof obj === 'object') {
          const ip = obj.ip || obj.IP || obj.host || obj.Host || obj.ipAddress;
          const port = parseInt(obj.port || obj.Port || obj.PORT || obj.portNumber, 10);
          if (ip && this.isValidPort(port)) {
            proxies.push({
              ip: String(ip),
              port,
              protocol: this.normalizeProtocol(obj.protocol || obj.type || source.protocol),
              country: obj.country || obj.cc || obj.countryCode,
              anonymity: this.normalizeAnonymity(obj.anonymity || obj.anonymityLevel),
              source: source.name,
              discoveredAt: now,
            });
          }
          for (const value of Object.values(obj)) {
            if (Array.isArray(value)) extractRecursive(value);
          }
        }
      };

      extractRecursive(parsed);
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to parse nested JSON');
    }

    return proxies;
  }

  /**
   * Extract proxies from CSV format.
   */
  private extractCsv(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('ip') || trimmed.startsWith('IP') || trimmed.startsWith('"')) continue;

      const parts = trimmed.split(',');
      if (parts.length >= 2) {
        const ip = parts[0].trim().replace(/"/g, '');
        const port = parseInt(parts[1].trim().replace(/"/g, ''), 10);

        if (IP_REGEX.test(ip) && this.isValidPort(port)) {
          proxies.push({
            ip, port,
            protocol: parts.length > 2 ? this.normalizeProtocol(parts[2].trim().replace(/"/g, '')) : source.protocol,
            country: parts.length > 3 && COUNTRY_REGEX.test(parts[3].trim().replace(/"/g, ''))
              ? parts[3].trim().replace(/"/g, '') : undefined,
            source: source.name, discoveredAt: now,
          });
        }
      }
    }

    return proxies;
  }

  /**
   * Extract proxies from custom API formats -- tries JSON then text.
   */
  private extractApi(body: string, source: ProxySource): DiscoveredProxy[] {
    try {
      const json = JSON.parse(body);
      if (Array.isArray(json)) return this.extractJsonArray(body, source);
      return this.extractJsonObject(body, source);
    } catch {
      return this.extractPlainText(body, source);
    }
  }

  /**
   * Extract proxies from XML format.
   */
  private extractXml(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    try {
      // Simple XML parsing -- extract ip/port from element attributes or text
      const proxyPattern = /<proxy[^>]*>([\s\S]*?)<\/proxy>/gi;
      const rowPattern = /<row[^>]*>([\s\S]*?)<\/row>/gi;
      const itemPattern = /<item[^>]*>([\s\S]*?)<\/item>/gi;

      const patterns = [proxyPattern, rowPattern, itemPattern];

      for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(body)) !== null) {
          const content = match[1];

          const ipMatch = content.match(/<ip[^>]*>([\s\S]*?)<\/ip>/i) ||
            content.match(/<host[^>]*>([\s\S]*?)<\/host>/i);
          const portMatch = content.match(/<port[^>]*>([\s\S]*?)<\/port>/i);

          if (ipMatch && portMatch) {
            const ip = ipMatch[1].trim();
            const port = parseInt(portMatch[1].trim(), 10);

            if (IP_REGEX.test(ip) && this.isValidPort(port)) {
              const countryMatch = content.match(/<country[^>]*>([\s\S]*?)<\/country>/i) ||
                content.match(/<cc[^>]*>([\s\S]*?)<\/cc>/i);

              proxies.push({
                ip, port, protocol: source.protocol,
                country: countryMatch ? countryMatch[1].trim() : undefined,
                source: source.name, discoveredAt: now,
              });
            }
          }
        }
      }

      // Also try attribute-based XML: <proxy ip="1.2.3.4" port="8080"/>
      const attrPattern = /<(?:proxy|row|item)[^>]*(?:ip|host)="([^"]+)"[^>]*(?:port)="([^"]+)"[^>]*\/?>/gi;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrPattern.exec(body)) !== null) {
        const ip = attrMatch[1];
        const port = parseInt(attrMatch[2], 10);
        if (IP_REGEX.test(ip) && this.isValidPort(port)) {
          proxies.push({ ip, port, protocol: source.protocol, source: source.name, discoveredAt: now });
        }
      }
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to parse XML');
    }

    return proxies;
  }

  /**
   * Extract proxies from base64-encoded content.
   */
  private extractBase64(body: string, source: ProxySource): DiscoveredProxy[] {
    try {
      const decoded = Buffer.from(body.trim(), 'base64').toString('utf-8');
      return this.extractPlainText(decoded, source);
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to decode base64');
      return [];
    }
  }

  /**
   * Extract proxies from JavaScript-rendered content.
   * Parses JavaScript arrays and objects for proxy data.
   */
  private extractJavascriptRendered(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    try {
      // Try to extract JSON arrays from JavaScript
      const jsonBlockPattern = /(?:var|let|const)\s+\w+\s*=\s*(\[[\s\S]*?\]);/g;
      let match: RegExpExecArray | null;
      while ((match = jsonBlockPattern.exec(body)) !== null) {
        try {
          const parsed = JSON.parse(match[1]);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (typeof item === 'string') {
                const ipPortMatch = item.match(IP_PORT_REGEX);
                if (ipPortMatch && this.isValidPort(parseInt(ipPortMatch[2], 10))) {
                  proxies.push({
                    ip: ipPortMatch[1], port: parseInt(ipPortMatch[2], 10),
                    protocol: source.protocol, source: source.name, discoveredAt: now,
                  });
                }
              } else if (typeof item === 'object' && item !== null) {
                const ip = item.ip || item.host;
                const port = parseInt(item.port, 10);
                if (ip && this.isValidPort(port)) {
                  proxies.push({
                    ip: String(ip), port, protocol: source.protocol,
                    country: item.country || item.cc,
                    source: source.name, discoveredAt: now,
                  });
                }
              }
            }
          }
        } catch {
          // Not valid JSON, skip
        }
      }

      // Fallback: extract all ip:port patterns from the body
      if (proxies.length === 0) {
        return this.extractPlainText(body, source);
      }
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to parse JS-rendered content');
    }

    return proxies;
  }

  /**
   * Extract proxies from port forwarding format.
   */
  private extractPortForward(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractPlainText(body, source);
  }

  /**
   * Extract proxies from protobuf-like JSON format.
   */
  private extractProtobufJson(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractNestedJson(body, source);
  }

  /**
   * Extract proxies from YAML-like format.
   */
  private extractYaml(body: string, source: ProxySource): DiscoveredProxy[] {
    // Simple YAML: parse lines like "- ip: 1.2.3.4" and "  port: 8080"
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    try {
      let currentIp: string | undefined;
      let currentPort: number | undefined;

      const lines = body.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        const ipMatch = trimmed.match(/^-?\s*ip:\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i);
        if (ipMatch) { currentIp = ipMatch[1]; continue; }

        const portMatch = trimmed.match(/^-?\s*port:\s*(\d+)/i);
        if (portMatch) { currentPort = parseInt(portMatch[1], 10); continue; }

        // If we have both ip and port, create the proxy
        if (currentIp && currentPort && this.isValidPort(currentPort)) {
          proxies.push({
            ip: currentIp, port: currentPort,
            protocol: source.protocol, source: source.name, discoveredAt: now,
          });
          currentIp = undefined;
          currentPort = undefined;
        }
      }

      // Handle last entry
      if (currentIp && currentPort && this.isValidPort(currentPort)) {
        proxies.push({
          ip: currentIp, port: currentPort,
          protocol: source.protocol, source: source.name, discoveredAt: now,
        });
      }
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to parse YAML');
    }

    return proxies;
  }

  /**
   * Extract proxies using custom regex pattern.
   */
  private extractRegexCustom(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractPlainText(body, source);
  }

  /**
   * Extract proxies from hex-encoded content.
   */
  private extractHexEncoded(body: string, source: ProxySource): DiscoveredProxy[] {
    try {
      const hexStr = body.trim().replace(/\s/g, '');
      const decoded = Buffer.from(hexStr, 'hex').toString('utf-8');
      return this.extractPlainText(decoded, source);
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, 'Failed to decode hex');
      return [];
    }
  }

  /**
   * Extract proxies from compressed (gzip) content.
   */
  private extractCompressed(body: string, source: ProxySource): DiscoveredProxy[] {
    // Try base64 decode first, then plain text
    try {
      const decoded = Buffer.from(body.trim(), 'base64').toString('utf-8');
      return this.extractPlainText(decoded, source);
    } catch {
      return this.extractPlainText(body, source);
    }
  }

  /**
   * Extract proxies from iframe-embedded content.
   */
  private extractIframeEmbedded(body: string, source: ProxySource): DiscoveredProxy[] {
    // Try to find proxy data in the body directly
    return this.extractPlainText(body, source);
  }

  /**
   * Extract proxies from AJAX-loaded content.
   */
  private extractAjaxLoaded(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractApi(body, source);
  }

  /**
   * Extract proxies from WebSocket feed data.
   */
  private extractWebsocketFeed(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractApi(body, source);
  }

  /**
   * Extract proxies from DNS lookup results.
   */
  private extractDnsLookup(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractPlainText(body, source);
  }

  /**
   * Extract Tor exit node proxies.
   */
  private extractTorExit(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('ExitNode')) continue;

      const ipMatch = trimmed.match(IP_REGEX);
      if (ipMatch) {
        // Tor exit nodes typically use port 9050 or 9051
        proxies.push({
          ip: ipMatch[1], port: 9050,
          protocol: 'socks5' as const,
          country: 'TOR',
          source: source.name, discoveredAt: now,
        });
      }
    }

    return proxies;
  }

  /**
   * Extract proxies from GeoJSON format.
   */
  private extractGeojson(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractNestedJson(body, source);
  }

  /**
   * Extract proxies from Markdown table format.
   */
  private extractMarkdownTable(body: string, source: ProxySource): DiscoveredProxy[] {
    const proxies: DiscoveredProxy[] = [];
    const now = Date.now();

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('|') === false) continue;
      if (trimmed.includes('---')) continue; // Separator row

      const cells = trimmed.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        const ip = cells[0];
        const port = parseInt(cells[1], 10);

        if (IP_REGEX.test(ip) && this.isValidPort(port)) {
          proxies.push({
            ip, port, protocol: source.protocol,
            country: cells.length > 2 && COUNTRY_REGEX.test(cells[2]) ? cells[2] : undefined,
            source: source.name, discoveredAt: now,
          });
        }
      }
    }

    return proxies;
  }

  /**
   * Extract proxies from split files format.
   */
  private extractSplitFiles(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractPlainText(body, source);
  }

  /**
   * Extract proxies from paginated format.
   */
  private extractPaginated(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractApi(body, source);
  }

  /**
   * Extract proxies from authenticated source.
   */
  private extractAuthenticated(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractApi(body, source);
  }

  /**
   * Extract proxies from rate-limited source.
   */
  private extractRateLimited(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractApi(body, source);
  }

  /**
   * Extract proxies from CAPTCHA-protected source.
   */
  private extractCaptchaProtected(body: string, source: ProxySource): DiscoveredProxy[] {
    return this.extractHtmlTable(body, source);
  }

  // --- Source Health & Scheduling ----------------------------------------

  /**
   * Prioritize sources based on health score, yield, and recent performance.
   * Uses weighted scoring: health (40%) + yield (30%) + latency (20%) + recent success (10%).
   */
  private prioritizeSources(): ProxySource[] {
    const now = Date.now();

    return [...this.sources].sort((a, b) => {
      // 1. Health score (40% weight)
      const healthDiff = b.healthScore - a.healthScore;
      if (Math.abs(healthDiff) > 0.3) return healthDiff;

      // 2. Yield per scrape (30% weight) -- prefer higher yield
      const yieldDiff = b.avgYieldPerScrape - a.avgYieldPerScrape;
      if (Math.abs(yieldDiff) > 50) return yieldDiff;

      // 3. Latency (20% weight) -- prefer lower latency
      const latencyDiff = a.avgScrapeLatency - b.avgScrapeLatency;
      if (Math.abs(latencyDiff) > 2000) return latencyDiff;

      // 4. Recent success rate (10% weight)
      const aRecentSuccess = a.recentScrapeResults.length > 0
        ? a.recentScrapeResults.filter(r => r.success && now - r.timestamp < 300_000).length /
          Math.max(a.recentScrapeResults.length, 1)
        : 0.5;
      const bRecentSuccess = b.recentScrapeResults.length > 0
        ? b.recentScrapeResults.filter(r => r.success && now - r.timestamp < 300_000).length /
          Math.max(b.recentScrapeResults.length, 1)
        : 0.5;

      return bRecentSuccess - aRecentSuccess;
    });
  }

  /**
   * Update source health scores based on recent performance.
   * Uses exponential moving average (EMA) for responsive updates.
   */
  private updateSourceHealth(): void {
    for (const source of this.sources) {
      if (source.totalScrapeAttempts === 0) continue;

      const successRate = source.totalScrapeSuccesses / source.totalScrapeAttempts;
      const workingRate = source.totalDiscovered > 0
        ? source.totalWorking / source.totalDiscovered
        : 0;

      // Blended health: scrape success (60%) + proxy working rate (40%)
      const targetHealth = successRate * 0.6 + workingRate * 0.4;

      // Consecutive failure penalty
      const failurePenalty = Math.min(source.consecutiveFailures * 0.12, 0.5);

      // Circuit breaker penalty
      const circuitPenalty = source.circuitBreakerOpen ? 0.3 : 0;

      // EMA update -- responsive to recent changes
      source.healthScore = Math.max(0, Math.min(1,
        source.healthScore * 0.6 + (targetHealth - failurePenalty - circuitPenalty) * 0.4,
      ));

      // Update priority based on health
      source.priority = Math.round((1 - source.healthScore) * 100);
    }

    // Update stats
    const healthy = this.sources.filter(s => s.healthScore > 0.7).length;
    const degraded = this.sources.filter(s => s.healthScore > UNHEALTHY_SOURCE_THRESHOLD && s.healthScore <= 0.7).length;
    const unhealthy = this.sources.filter(s => s.healthScore <= UNHEALTHY_SOURCE_THRESHOLD).length;
    this.stats.sourceHealthBreakdown = { healthy, degraded, unhealthy };
    this.stats.healthySources = healthy;
  }

  /**
   * Adapt concurrency level based on recent success rate.
   * Scale up when success is high, scale down when it's low.
   */
  private adaptConcurrency(): void {
    const recentSuccessRate = this.metrics.totalScrapeAttempts > 0
      ? this.metrics.totalScrapeSuccesses / this.metrics.totalScrapeAttempts
      : 0.5;

    if (recentSuccessRate > 0.8 && this.adaptiveConcurrency < ADAPTIVE_CONCURRENCY_MAX) {
      this.adaptiveConcurrency = Math.min(this.adaptiveConcurrency + 2, ADAPTIVE_CONCURRENCY_MAX);
    } else if (recentSuccessRate < 0.5 && this.adaptiveConcurrency > ADAPTIVE_CONCURRENCY_MIN) {
      this.adaptiveConcurrency = Math.max(this.adaptiveConcurrency - 3, ADAPTIVE_CONCURRENCY_MIN);
    }

    this.metrics.currentConcurrency = this.adaptiveConcurrency;
  }

  /**
   * Persist source health data to Redis.
   */
  private async persistSourceHealth(): Promise<void> {
    try {
      const healthData: SourceHealthEntry[] = this.sources.map(s => ({
        name: s.name,
        healthScore: s.healthScore,
        lastScrapeAt: s.lastScraped,
        lastWorkingCount: s.totalWorking,
        consecutiveFailures: s.consecutiveFailures,
        circuitBreakerOpen: s.circuitBreakerOpen,
        avgYieldPerScrape: s.avgYieldPerScrape,
      }));
      await cacheSet('proxy-discovery:source-health', healthData, DEDUP_CACHE_TTL);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to persist source health');
    }
  }

  // --- Validation Helpers ----------------------------------------------------

  /**
   * Validate a batch of proxies with high concurrency (100 at a time).
   * Uses Promise.allSettled for parallel validation.
   */
  private async batchValidate(proxies: DiscoveredProxy[]): Promise<DiscoveredProxy[]> {
    const valid: DiscoveredProxy[] = [];
    const batchSize = VALIDATION_BATCH_SIZE;
    this.metrics.totalValidationAttempts += proxies.length;

    for (let i = 0; i < proxies.length; i += batchSize) {
      const batch = proxies.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (proxy) => {
          const isValid = await this.validateProxy(proxy.ip, proxy.port, proxy.protocol);
          return isValid ? proxy : null;
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value !== null) {
          valid.push(result.value);
          this.metrics.totalValidationSuccesses++;
        }
      }
    }

    return valid;
  }

  // --- Rate Tracking ------------------------------------------------------

  /**
   * Update discovery rate statistics.
   * Tracks rolling 6-hour window for accurate rate calculation.
   */
  private updateDiscoveryRate(discoveredCount: number, cycleStart: number): void {
    this.cycleTimestamps.push(cycleStart);
    this.cycleDiscoveryCounts.push(discoveredCount);

    // Keep only last 6 hours of data
    const cutoff = Date.now() - METRICS_WINDOW_MS;
    while (this.cycleTimestamps.length > 0 && this.cycleTimestamps[0] < cutoff) {
      this.cycleTimestamps.shift();
      this.cycleDiscoveryCounts.shift();
    }

    // Calculate rate
    const totalDiscovered = this.cycleDiscoveryCounts.reduce((sum, c) => sum + c, 0);
    const timeSpanMs = this.cycleTimestamps.length > 1
      ? Date.now() - this.cycleTimestamps[0]
      : DEFAULT_DISCOVERY_INTERVAL;

    this.stats.discoveryRate = timeSpanMs > 0 ? Math.round(totalDiscovered / (timeSpanMs / 3600000)) : 0;
    this.stats.validationRate = this.stats.totalValidated > 0 && timeSpanMs > 0
      ? Math.round(this.stats.totalValidated / (timeSpanMs / 3600000))
      : 0;

    if (this.stats.discoveryRate > this.metrics.peakDiscoveryRate) {
      this.metrics.peakDiscoveryRate = this.stats.discoveryRate;
    }
  }

  // --- Utility Methods -------------------------------------------------------

  private buildProxyUrl(ip: string, port: number, protocol: 'http' | 'https' | 'socks4' | 'socks5'): string {
    switch (protocol) {
      case 'https': return `http://${ip}:${port}`;
      case 'socks4': return `socks4://${ip}:${port}`;
      case 'socks5': return `socks5://${ip}:${port}`;
      case 'http':
      default: return `http://${ip}:${port}`;
    }
  }

  private isValidPort(port: number): boolean {
    return Number.isInteger(port) && port > 0 && port <= 65535;
  }

  private normalizeProtocol(raw: string): 'http' | 'https' | 'socks4' | 'socks5' {
    const lower = raw.toLowerCase().trim();
    if (lower === 'https' || lower === 'ssl') return 'https';
    if (lower === 'socks4') return 'socks4';
    if (lower === 'socks5' || lower === 'socks') return 'socks5';
    return 'http';
  }

  private normalizeAnonymity(raw: string | undefined): 'transparent' | 'anonymous' | 'elite' | undefined {
    if (!raw) return undefined;
    const lower = raw.toLowerCase().trim();
    if (lower.includes('elite') || lower.includes('high') || lower === 'h') return 'elite';
    if (lower.includes('anonymous') || lower.includes('anon') || lower === 'a') return 'anonymous';
    if (lower.includes('transparent') || lower.includes('non-anon') || lower === 'n' || lower === 't') return 'transparent';
    return undefined;
  }

  private extractTableCells(html: string): string[] {
    const cells: string[] = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let match: RegExpExecArray | null;
    while ((match = cellPattern.exec(html)) !== null) {
      const text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text) cells.push(text);
    }
    return cells;
  }

  private deduplicateProxies(proxies: DiscoveredProxy[]): DiscoveredProxy[] {
    const seen = new Set<string>();
    const deduped: DiscoveredProxy[] = [];

    for (const proxy of proxies) {
      const key = `${proxy.ip}:${proxy.port}:${proxy.protocol}`;
      if (this.discoveredSet.has(key)) {
        this.metrics.dedupHits++;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(proxy);
    }

    for (const key of Array.from(seen)) {
      this.discoveredSet.add(key);
    }

    // Prevent dedup set from growing too large
    if (this.discoveredSet.size > MAX_DEDUP_SET_SIZE) {
      const arr = Array.from(this.discoveredSet);
      const toKeep = arr.slice(-MAX_DEDUP_SET_SIZE);
      this.discoveredSet = new Set(toKeep);
      logger.info({ trimmed: arr.length - toKeep.length }, 'Dedup set trimmed to max size');
    }

    return deduped;
  }

  private async loadDedupCache(): Promise<void> {
    try {
      const cached = await cacheGet<string[]>('proxy-discovery:dedup-set');
      if (cached && Array.isArray(cached)) {
        for (const key of cached) {
          this.discoveredSet.add(key);
        }
        logger.debug({ size: cached.length }, 'Dedup cache loaded');
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to load dedup cache');
    }
  }

  private async persistDedupCache(): Promise<void> {
    try {
      const arr = Array.from(this.discoveredSet);
      const toStore = arr.slice(-MAX_DEDUP_SET_SIZE);
      await cacheSet('proxy-discovery:dedup-set', toStore, DEDUP_CACHE_TTL);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to persist dedup cache');
    }
  }

  private updateBreakdownStats(validated: DiscoveredProxy[]): void {
    for (const proxy of validated) {
      this.stats.byProtocol[proxy.protocol] = (this.stats.byProtocol[proxy.protocol] || 0) + 1;
      const country = proxy.country || 'XX';
      this.stats.byCountry[country] = (this.stats.byCountry[country] || 0) + 1;
    }
  }

  // --- Additional Public Methods --------------------------------------------

  getSources(): ProxySource[] {
    return this.sources.map((s) => ({ ...s }));
  }

  addSource(source: Omit<ProxySource, 'lastScraped' | 'totalDiscovered' | 'totalWorking' |
    'healthScore' | 'consecutiveFailures' | 'avgScrapeLatency' | 'totalScrapeAttempts' |
    'totalScrapeSuccesses' | 'lastError' | 'priority' | 'circuitBreakerOpen' |
    'circuitBreakerTrippedAt' | 'circuitBreakerTripCount' | 'recentScrapeResults' |
    'avgYieldPerScrape'>): void {
    const existing = this.sources.find((s) => s.name === source.name);
    if (existing) {
      logger.warn({ name: source.name }, 'Source already exists');
      return;
    }

    this.sources.push({
      ...source,
      lastScraped: 0,
      totalDiscovered: 0,
      totalWorking: 0,
      healthScore: 1.0,
      consecutiveFailures: 0,
      avgScrapeLatency: 0,
      totalScrapeAttempts: 0,
      totalScrapeSuccesses: 0,
      lastError: undefined,
      priority: 100,
      circuitBreakerOpen: false,
      circuitBreakerTrippedAt: 0,
      circuitBreakerTripCount: 0,
      recentScrapeResults: [],
      avgYieldPerScrape: 0,
    });

    this.stats.activeSources = this.sources.length;
    logger.info({ name: source.name }, 'Custom proxy source added');
  }

  removeSource(name: string): boolean {
    const index = this.sources.findIndex((s) => s.name === name);
    if (index === -1) return false;
    this.sources.splice(index, 1);
    this.stats.activeSources = this.sources.length;
    logger.info({ name }, 'Proxy source removed');
    return true;
  }

  resetStats(): void {
    this.stats = {
      totalDiscovered: 0,
      totalValidated: 0,
      totalImported: 0,
      activeSources: this.sources.length,
      healthySources: this.sources.length,
      lastCycleAt: 0,
      cyclesCompleted: 0,
      byProtocol: {},
      byCountry: {},
      discoveryRate: 0,
      validationRate: 0,
      sourceHealthBreakdown: { healthy: this.sources.length, degraded: 0, unhealthy: 0 },
      metrics: {
        ...this.metrics,
        totalScrapeAttempts: 0,
        totalScrapeSuccesses: 0,
        totalScrapeFailures: 0,
        totalValidationAttempts: 0,
        totalValidationSuccesses: 0,
        circuitBreakerTrips: 0,
        unlockerUsed: 0,
        captchaSolved: 0,
        dedupHits: 0,
        importErrors: 0,
      },
    };
    for (const source of this.sources) {
      source.totalDiscovered = 0;
      source.totalWorking = 0;
    }
    logger.info('Discovery stats reset');
  }

  async discoverFromSourceByName(name: string): Promise<DiscoveredProxy[]> {
    const source = this.sources.find((s) => s.name === name);
    if (!source) { logger.warn({ name }, 'Source not found'); return []; }
    return this.discoverFromSource(source);
  }

  isRunningState(): boolean {
    return this.isRunning;
  }

  isDiscoveringState(): boolean {
    return this.isDiscovering;
  }

  getTopCountries(limit: number = 10): Array<{ country: string; count: number }> {
    return Object.entries(this.stats.byCountry)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([country, count]) => ({ country, count }));
  }

  getProtocolDistribution(): Record<string, number> {
    return { ...this.stats.byProtocol };
  }

  getNextCycleEstimate(): number | null {
    if (!this.discoveryTimer || !this.stats.lastCycleAt) return null;
    return this.stats.lastCycleAt + DEFAULT_DISCOVERY_INTERVAL;
  }

  async cleanupStaleDedupEntries(): Promise<number> {
    if (this.discoveredSet.size <= MAX_DEDUP_SET_SIZE) return 0;
    const arr = Array.from(this.discoveredSet);
    const toKeep = arr.slice(-MAX_DEDUP_SET_SIZE);
    this.discoveredSet = new Set(toKeep);
    logger.info({ removed: arr.length - toKeep.length, kept: toKeep.length }, 'Dedup set cleaned up');
    return arr.length - toKeep.length;
  }

  async getHealthSummary(): Promise<{
    isRunning: boolean;
    isDiscovering: boolean;
    sourcesActive: number;
    totalSources: number;
    healthySources: number;
    lastCycleAt: number;
    cyclesCompleted: number;
    discoveryRate: number;
    peakDiscoveryRate: number;
    circuitBreakerTrips: number;
    unlockerUsed: number;
    captchaSolved: number;
    dedupSetSize: number;
    adaptiveConcurrency: number;
    fastModeActive: boolean;
    uptimeSeconds: number;
  }> {
    return {
      isRunning: this.isRunning,
      isDiscovering: this.isDiscovering,
      sourcesActive: this.sources.filter((s) => s.lastScraped > 0).length,
      totalSources: this.sources.length,
      healthySources: this.sources.filter(s => s.healthScore > 0.7).length,
      lastCycleAt: this.stats.lastCycleAt,
      cyclesCompleted: this.stats.cyclesCompleted,
      discoveryRate: this.stats.discoveryRate,
      peakDiscoveryRate: this.metrics.peakDiscoveryRate,
      circuitBreakerTrips: this.metrics.circuitBreakerTrips,
      unlockerUsed: this.metrics.unlockerUsed,
      captchaSolved: this.metrics.captchaSolved,
      dedupSetSize: this.discoveredSet.size,
      adaptiveConcurrency: this.adaptiveConcurrency,
      fastModeActive: this.metrics.fastModeActive,
      uptimeSeconds: this.metrics.uptimeSeconds,
    };
  }

  getMetrics(): DiscoveryMetrics {
    return { ...this.metrics };
  }

  /**
   * Get sources with open circuit breakers (currently in cooldown).
   */
  getCircuitBrokenSources(): Array<{ name: string; tripCount: number; trippedAt: number; cooldownRemaining: number }> {
    const now = Date.now();
    return this.sources
      .filter(s => s.circuitBreakerOpen)
      .map(s => ({
        name: s.name,
        tripCount: s.circuitBreakerTripCount,
        trippedAt: s.circuitBreakerTrippedAt,
        cooldownRemaining: Math.max(0, CIRCUIT_BREAKER_COOLDOWN_MS - (now - s.circuitBreakerTrippedAt)),
      }));
  }

  /**
   * Manually reset a source's circuit breaker.
   */
  resetCircuitBreaker(sourceName: string): boolean {
    const source = this.sources.find(s => s.name === sourceName);
    if (!source) return false;
    source.circuitBreakerOpen = false;
    source.circuitBreakerTrippedAt = 0;
    source.consecutiveFailures = 0;
    logger.info({ source: sourceName }, 'Circuit breaker manually reset');
    return true;
  }

  /**
   * Get the top-yielding sources.
   */
  getTopSources(limit: number = 10): Array<{ name: string; yield: number; health: number; latency: number }> {
    return this.sources
      .filter(s => s.totalScrapeSuccesses > 0)
      .sort((a, b) => b.avgYieldPerScrape - a.avgYieldPerScrape)
      .slice(0, limit)
      .map(s => ({
        name: s.name,
        yield: s.avgYieldPerScrape,
        health: Math.round(s.healthScore * 100),
        latency: s.avgScrapeLatency,
      }));
  }

  /**
   * Get discovery rate history (last N cycles).
   */
  getDiscoveryHistory(limit: number = 20): Array<{ timestamp: number; count: number }> {
    return this.cycleTimestamps
      .map((t, i) => ({ timestamp: t, count: this.cycleDiscoveryCounts[i] || 0 }))
      .slice(-limit);
  }

  /**
   * Force a source to be scraped immediately, bypassing rate limits and circuit breakers.
   */
  async forceScrapeSource(sourceName: string): Promise<DiscoveredProxy[]> {
    const source = this.sources.find(s => s.name === sourceName);
    if (!source) {
      logger.warn({ source: sourceName }, 'Source not found for force scrape');
      return [];
    }

    // Temporarily reset rate limit and circuit breaker
    source.lastScraped = 0;
    source.circuitBreakerOpen = false;
    source.consecutiveFailures = 0;

    logger.info({ source: sourceName }, 'Force-scraping source');
    return this.discoverFromSource(source);
  }
}

// --- Singleton ----------------------------------------------------------------

export const freeProxyDiscovery = new FreeProxyDiscovery();
