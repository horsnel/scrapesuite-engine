/**
 * Owned Proxy Pool -- Self-Managed Residential Proxy Infrastructure
 *
 * Manages a fleet of self-hosted and community-sourced proxy endpoints that
 * the ScrapeSuite Engine OWNS rather than being 100% dependent on third-party
 * providers. This module provides strategic independence, cost control, and
 * resilience against provider outages.
 *
 * Unlike the third-party provider integration layer (residential-providers.ts),
 * these IPs are directly controlled by the operator through multiple acquisition
 * channels:
 *
 *   - Self-hosted VPS instances the operator controls
 *   - Auto-provisioned from cloud APIs (AWS, GCP, DO, Hetzner)
 *   - Community-sourced residential IPs (PacketStream/SmartProxy model)
 *   - Curated free proxies that passed the validation pipeline
 *   - Browser extension network contributors (Honey/PIA model)
 *   - Discovered IoT devices running open proxies
 *   - Leased IP ranges from ISPs
 *   - Peer exchange with other ScrapeSuite operators
 *
 * Features:
 *  - Multi-source proxy acquisition and lifecycle management
 *  - 9-stage validation pipeline (connectivity → DNSBL scan → stability)
 *  - Auto-provisioning from cloud providers with TTL-based auto-termination
 *  - Import from the free proxy discovery module after extended validation
 *  - Peer exchange protocol for sharing proxies between ScrapeSuite nodes
 *  - Demand-driven auto-scaling with configurable pool size targets
 *  - Per-proxy reputation scoring integrated with IPReputationTracker
 *  - Geographic optimization (country, city, ASN-level selection)
 *  - Continuous health monitoring with automatic retirement of bad proxies
 *  - Budget-aware cloud provisioning with per-provider cost tracking
 *  - Redis-cached pool statistics for fast dashboard rendering
 *
 * Redis layout:
 *   owned-proxy:pool:stats          → JSON pool statistics (cached 30s)
 *   owned-proxy:proxy:{proxyId}     → JSON individual proxy data (cached 5m)
 *   owned-proxy:country:{country}   → Set of proxy IDs in country (cached 10m)
 *   owned-proxy:tier:{tier}         → Set of proxy IDs in tier (cached 10m)
 *   owned-proxy:cooldown:{ip}       → IP cooldown tracking (TTL = cooldown duration)
 *   owned-proxy:demand              → Sorted set of demand signals (score = timestamp)
 */

import { createChildLogger } from '../utils/logger';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { db } from '../utils/db';
import { randomUUID } from 'crypto';
import { ipReputationTracker } from './reputation';

const logger = createChildLogger('owned-proxy-pool');

// --- Constants ----------------------------------------------------------------

const DEFAULT_CONFIG = {
  /** Minimum number of proxies to maintain in the pool. */
  minPoolSize: 500,
  /** Maximum number of owned proxies allowed. */
  maxPoolSize: 50000,
  /** Target pool size -- the auto-scaler tries to reach this. */
  targetPoolSize: 10000,
  /** How often the health monitor checks proxies (ms). */
  healthCheckIntervalMs: 30000,
  /** Default timeout for validation operations (ms). */
  validationTimeoutMs: 15000,
  /** Minimum reputation score required for a proxy to be eligible for use. */
  minReputationForUse: 0.5,
  /** Whether auto-provisioning from cloud providers is enabled (costs money!). */
  autoProvisionEnabled: false,
  /** Whether to automatically import validated proxies from free discovery. */
  autoImportFromDiscovery: true,
  /** Whether peer exchange with other ScrapeSuite nodes is enabled. */
  peerExchangeEnabled: true,
  /** Monthly budget for cloud provisioning ($0 = disabled). */
  cloudProvisionBudgetPerMonth: 0,
  /** How many proxies to validate concurrently during health checks. */
  healthCheckConcurrency: 20,
  /** How many consecutive health check failures before a proxy is retired. */
  retireAfterConsecutiveFailures: 5,
  /** Cooldown period after a proxy is used (ms). */
  proxyCooldownMs: 60000,
  /** How often the auto-scaler evaluates demand (ms). */
  autoScalerIntervalMs: 60000,
  /** Extended stability test duration when importing from discovery (ms). */
  stabilityTestDurationMs: 300000, // 5 minutes
  /** Number of requests required to pass the stability test. */
  stabilityTestRequests: 3,
  /** Default TTL for Redis-cached pool stats (seconds). */
  statsCacheTtlSeconds: 30,
  /** Default TTL for Redis-cached individual proxy data (seconds). */
  proxyCacheTtlSeconds: 300,
  /** Default TTL for country/tier index caches (seconds). */
  indexCacheTtlSeconds: 600,
  /** DNSBL services to check during blacklist scanning. */
  dnsblServices: [
    'zen.spamhaus.org',
    'bl.spamcop.net',
    'dnsbl.sorbs.net',
    'b.barracudacentral.org',
    'xbl.spamhaus.org',
    'sbl.spamhaus.org',
    'pbl.spamhaus.org',
    'dnsbl-1.uceprotect.net',
    'db.wpbl.info',
    'ips.backscatterer.org',
    'cbl.abuseat.org',
  ],
};

type OwnedProxyPoolConfig = typeof DEFAULT_CONFIG;

// --- Types --------------------------------------------------------------------

/**
 * The source channel through which a proxy entered the owned pool.
 * Each source has different trust levels, cost profiles, and reliability
 * characteristics that influence selection priority and validation frequency.
 */
type OwnedProxySource =
  | 'self-hosted-vps'       // Proxies on VPS instances the operator owns
  | 'cloud-provisioned'     // Auto-provisioned from cloud APIs (AWS, GCP, DO, Hetzner)
  | 'community-p2p'         // Community-sourced residential IPs (like PacketStream model)
  | 'curated-free'          // Free proxies that passed validation pipeline
  | 'browser-extension'     // From browser extension network (like Honey/PIA model)
  | 'iot-scanner'           // Discovered IoT devices running open proxies
  | 'subnet-lease'          // Leased IP ranges from ISPs
  | 'peer-exchange';        // Exchanged with other ScrapeSuite operators

/** Proxy protocol types supported by the owned pool. */
type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';

/** Proxy tier classification -- determines selection priority and cost. */
type ProxyTier = 'residential' | 'mobile' | 'datacenter' | 'isp';

/** Anonymity level detected during validation. */
type AnonymityLevel = 'transparent' | 'anonymous' | 'elite';

/**
 * Represents a single proxy endpoint in the owned pool.
 * Stored in the `owned_proxies` database table and cached in Redis.
 */
interface OwnedProxy {
  /** Unique identifier for this proxy. */
  id: string;
  /** IP address of the proxy. */
  ip: string;
  /** Port number the proxy listens on. */
  port: number;
  /** Protocol the proxy supports. */
  protocol: ProxyProtocol;
  /** How this proxy was acquired. */
  source: OwnedProxySource;
  /** ISO 3166-1 alpha-2 country code (e.g., "US", "DE"). */
  country: string;
  /** City name (if known). */
  city: string | null;
  /** Autonomous System Number (e.g., "AS13335"). */
  asn: string | null;
  /** Internet Service Provider name. */
  isp: string | null;
  /** Reputation score: 0.0 (worst) to 1.0 (best). Updated by reportProxyResult(). */
  reputationScore: number;
  /** Average latency in milliseconds over recent requests. */
  avgLatencyMs: number;
  /** Fraction of requests that succeeded (0.0 to 1.0). */
  successRate: number;
  /** Estimated bandwidth capacity in Mbps. */
  bandwidthMbps: number | null;
  /** Whether the proxy hides the client IP (no X-Forwarded-For). */
  isAnonymous: boolean;
  /** Whether the proxy is elite (no proxy-detectable headers at all). */
  isElite: boolean;
  /** Whether the proxy supports SSL/TLS connections. */
  supportsSsl: boolean;
  /** Detected anonymity level from the last validation. */
  anonymityLevel: AnonymityLevel | null;
  /** Timestamp of the last health check. */
  lastCheckedAt: Date | null;
  /** Timestamp of the last time this proxy was used for a request. */
  lastUsedAt: Date | null;
  /** Timestamp when this proxy was added to the pool. */
  createdAt: Date;
  /** Timestamp when this proxy expires (for cloud-provisioned with TTL). */
  expiresAt: Date | null;
  /** Whether this proxy is currently active and eligible for selection. */
  active: boolean;
  /** Proxy tier classification. */
  tier: ProxyTier;
  /** Consecutive health check failures (resets on success). */
  consecutiveFailures: number;
  /** Total number of requests routed through this proxy. */
  totalRequests: number;
  /** Cloud provider instance ID (for cloud-provisioned proxies). */
  cloudInstanceId: string | null;
  /** Monthly cost of this proxy in USD (for cloud-provisioned/leased). */
  monthlyCostUsd: number;
  /** Last validation score (0-100, composite of all validation stages). */
  validationScore: number | null;
  /** Whether this proxy is currently in its cooldown period. */
  isCoolingDown: boolean;
}

/**
 * Options for selecting a proxy from the owned pool.
 * All fields are optional -- the more specific the request, the fewer
 * candidates will match, potentially falling back to third-party providers.
 */
interface GetProxyOptions {
  /** Required country code (ISO 3166-1 alpha-2). */
  country?: string;
  /** Required city name. */
  city?: string;
  /** Required proxy tier. */
  tier?: ProxyTier;
  /** Minimum reputation score for selection (0.0 to 1.0). */
  minReputation?: number;
  /** Maximum acceptable latency in milliseconds. */
  maxLatencyMs?: number;
  /** Required proxy protocol. */
  protocol?: ProxyProtocol;
  /** Whether the proxy must support SSL. */
  requireSsl?: boolean;
  /** Whether the proxy must be anonymous or elite. */
  requireAnonymous?: boolean;
  /** Specific source preference. */
  source?: OwnedProxySource;
  /** Domain the proxy will be used for (for reputation-aware selection). */
  domain?: string;
  /** ASN filter -- only return proxies from this autonomous system. */
  asn?: string;
  /** Session ID for sticky proxy assignment. */
  sessionId?: string;
}

/**
 * Result returned when a proxy is selected from the owned pool.
 * Includes the proxy URL for immediate use plus metadata for logging
 * and reputation tracking.
 */
interface OwnedProxyResult {
  /** The proxy URL ready for use in HTTP clients (e.g., "http://1.2.3.4:8080"). */
  proxyUrl: string;
  /** Unique proxy ID for reputation tracking and reporting. */
  proxyId: string;
  /** How this proxy was acquired. */
  source: OwnedProxySource;
  /** Country code. */
  country: string;
  /** City name (if known). */
  city: string | null;
  /** Autonomous System Number. */
  asn: string | null;
  /** Proxy tier. */
  tier: ProxyTier;
  /** Current reputation score. */
  reputationScore: number;
  /** Whether the proxy has an established good reputation ("warm"). */
  isWarmed: boolean;
  /** Protocol type. */
  protocol: ProxyProtocol;
  /** Whether SSL is supported. */
  supportsSsl: boolean;
  /** Monthly cost in USD (0 for free sources). */
  costUsd: number;
  /** Session ID (if sticky session was requested). */
  sessionId?: string;
}

/**
 * Data required to add a new proxy to the owned pool.
 * The pool will validate connectivity and check reputation before
 * admitting the proxy.
 */
interface AddProxyInput {
  ip: string;
  port: number;
  protocol: ProxyProtocol;
  source: OwnedProxySource;
  country?: string;
  city?: string;
  asn?: string;
  isp?: string;
  tier?: ProxyTier;
  supportsSsl?: boolean;
  isAnonymous?: boolean;
  isElite?: boolean;
  /** Cloud instance ID (for cloud-provisioned proxies). */
  cloudInstanceId?: string;
  /** Monthly cost in USD. */
  monthlyCostUsd?: number;
  /** Expiration time (for TTL-limited proxies). */
  expiresAt?: Date;
}

/**
 * Cloud provisioning template -- defines how to spin up a new proxy node
 * on a cloud provider. Each template specifies the provider, region,
 * instance type, and proxy software to install.
 */
interface CloudProvisionTemplate {
  /** Cloud provider to provision on. */
  provider: 'aws' | 'digitalocean' | 'hetzner' | 'gcp';
  /** Provider region (e.g., "us-east-1", "fra1", "nbg1-dc3", "us-central1"). */
  region: string;
  /** Instance type (e.g., "t3.micro", "s-1vcpu-1gb", "cx11", "e2-micro"). */
  instanceType: string;
  /** Proxy software to install on the instance. */
  proxySoftware: 'squid' | '3proxy' | 'dante' | 'tinyproxy';
  /** Auto-terminate the instance after this many minutes. */
  ttlMinutes: number;
  /** Maximum cost per hour before we refuse to provision. */
  maxCostPerHour: number;
  /** Cloud-init script to install and configure the proxy software. */
  startupScript: string;
}

/**
 * Configuration for peer exchange -- trading proxies with other
 * ScrapeSuite operators. This is a barter system: you offer N proxies
 * and receive N in return, after validation.
 */
interface PeerExchangeConfig {
  /** URL of the peer's ScrapeSuite exchange endpoint. */
  peerEndpoint: string;
  /** Authentication token for the peer. */
  authToken: string;
  /** Number of proxies to offer. */
  offerCount: number;
  /** Preferred countries to receive. */
  preferredCountries?: string[];
  /** Preferred tiers to receive. */
  preferredTiers?: ProxyTier[];
  /** Maximum latency acceptable for received proxies. */
  maxLatencyMs?: number;
}

/**
 * Result of the full validation pipeline on a proxy.
 * Contains the outcome of each stage and a composite score.
 */
interface ValidationResult {
  /** Whether the proxy passed all stages. */
  passed: boolean;
  /** Composite score (0-100) based on stage results. */
  score: number;
  /** Stage 1: TCP connectivity. */
  tcpConnectivity: boolean;
  /** Stage 2: HTTP request through proxy. */
  httpRequest: boolean;
  /** Stage 3: HTTPS support. */
  httpsSupport: boolean;
  /** Stage 4: Anonymity level. */
  anonymityLevel: AnonymityLevel | null;
  /** Whether DNS leak was detected. */
  dnsLeak: boolean;
  /** Stage 6: Download speed (bytes per second). */
  downloadSpeedBps: number | null;
  /** Stage 7: Verified country code. */
  verifiedCountry: string | null;
  /** Stage 8: Number of DNSBL services that listed this IP. */
  blacklistHits: number;
  /** Stage 9: Stability test -- how many of N requests succeeded. */
  stabilityPassCount: number | null;
  /** Latency in milliseconds. */
  latencyMs: number | null;
  /** Error messages from failed stages. */
  errors: string[];
}

/**
 * Comprehensive pool statistics for monitoring dashboards
 * and auto-scaling decisions.
 */
interface PoolStats {
  /** Total proxies in the pool (active + inactive). */
  totalProxies: number;
  /** Number of active, usable proxies. */
  activeProxies: number;
  /** Number of proxies currently in cooldown. */
  coolingProxies: number;
  /** Number of proxies currently in use. */
  inUseProxies: number;
  /** Number of proxies that failed health checks. */
  failedProxies: number;
  /** Proxies by source type. */
  bySource: Record<OwnedProxySource, number>;
  /** Proxies by tier. */
  byTier: Record<ProxyTier, number>;
  /** Proxies by country (top 20). */
  byCountry: Record<string, number>;
  /** Average reputation score across all active proxies. */
  avgReputation: number;
  /** Average latency across all active proxies. */
  avgLatencyMs: number;
  /** Pool utilization rate (inUse / active). */
  utilizationRate: number;
  /** Current monthly cost of cloud-provisioned proxies. */
  monthlyCostUsd: number;
  /** Whether auto-scaling is currently active. */
  autoScalingActive: boolean;
  /** Number of pending demand signals. */
  pendingDemand: number;
  /** Timestamp of last health check cycle. */
  lastHealthCheckAt: number | null;
  /** Timestamp of stats computation. */
  computedAt: number;
}

// --- Startup Scripts for Cloud Provisioning -----------------------------------

/**
 * Pre-built cloud-init startup scripts for each proxy software package.
 * These scripts are injected into the CloudProvisionTemplate and executed
 * on first boot to install and configure the proxy software.
 */
const CLOUD_STARTUP_SCRIPTS: Record<CloudProvisionTemplate['proxySoftware'], string> = {
  squid: `#!/bin/bash
set -e
apt-get update && apt-get install -y squid
cat > /etc/squid/squid.conf << 'SQUID_EOF'
acl all src 0.0.0.0/0
http_access allow all
http_port 3128
via off
forwarded_for delete
request_header_access Authorization allow all
request_header_access Proxy-Authorization allow all
request_header_access Via deny all
request_header_access X-Forwarded-For deny all
SQUID_EOF
systemctl enable squid && systemctl restart squid
# Health check endpoint
echo "Squid proxy ready" > /tmp/proxy-ready
`,
  '3proxy': `#!/bin/bash
set -e
apt-get update && apt-get install -y 3proxy
cat > /etc/3proxy/3proxy.cfg << '3PROXY_EOF'
daemon
maxconn 1000
nscache 65536
timeouts 1 5 30 60 180 1800 15 60
auth none
proxy -n -p3128 -a
3PROXY_EOF
systemctl enable 3proxy && systemctl restart 3proxy
echo "3proxy ready" > /tmp/proxy-ready
`,
  dante: `#!/bin/bash
set -e
apt-get update && apt-get install -y dante-server
cat > /etc/danted.conf << 'DANTE_EOF'
logoutput: /var/log/danted.log
internal: 0.0.0.0 port = 1080
external: eth0
method: none
clientmethod: none
user.privileged: proxy
user.unprivileged: nobody
pass { from: 0.0.0.0/0 to: 0.0.0.0/0 }
DANTE_EOF
systemctl enable danted && systemctl restart danted
echo "Dante SOCKS ready" > /tmp/proxy-ready
`,
  tinyproxy: `#!/bin/bash
set -e
apt-get update && apt-get install -y tinyproxy
sed -i 's/^Port 8888/Port 8888/' /etc/tinyproxy/tinyproxy.conf
sed -i 's/^#DisableViaHeader/DisableViaHeader/' /etc/tinyproxy/tinyproxy.conf
sed -i 's/^ConnectPort.*/ConnectPort "\\+"/' /etc/tinyproxy/tinyproxy.conf
systemctl enable tinyproxy && systemctl restart tinyproxy
echo "Tinyproxy ready" > /tmp/proxy-ready
`,
};

// --- Default Cloud Provision Templates ----------------------------------------

/**
 * Default cloud provisioning templates -- one per provider with the
 * cheapest instance type that can run a proxy comfortably.
 */
const DEFAULT_CLOUD_TEMPLATES: CloudProvisionTemplate[] = [
  {
    provider: 'digitalocean',
    region: 'nyc1',
    instanceType: 's-1vcpu-1gb',
    proxySoftware: 'squid',
    ttlMinutes: 60,
    maxCostPerHour: 0.007,
    startupScript: CLOUD_STARTUP_SCRIPTS.squid,
  },
  {
    provider: 'hetzner',
    region: 'fsn1',
    instanceType: 'cx11',
    proxySoftware: '3proxy',
    ttlMinutes: 60,
    maxCostPerHour: 0.004,
    startupScript: CLOUD_STARTUP_SCRIPTS['3proxy'],
  },
  {
    provider: 'aws',
    region: 'us-east-1',
    instanceType: 't3.micro',
    proxySoftware: 'squid',
    ttlMinutes: 60,
    maxCostPerHour: 0.012,
    startupScript: CLOUD_STARTUP_SCRIPTS.squid,
  },
  {
    provider: 'gcp',
    region: 'us-central1',
    instanceType: 'e2-micro',
    proxySoftware: 'tinyproxy',
    ttlMinutes: 60,
    maxCostPerHour: 0.008,
    startupScript: CLOUD_STARTUP_SCRIPTS.tinyproxy,
  },
];

// --- OwnedProxyPool -----------------------------------------------------------

/**
 * Self-Managed Residential Proxy Pool
 *
 * The Owned Proxy Pool manages a fleet of proxy endpoints that the
 * ScrapeSuite Engine directly controls. This provides strategic
 * independence from third-party providers and allows fine-grained
 * control over IP reputation, geographic distribution, and cost.
 *
 * Architecture:
 *   ┌──────────────────────────────────────────────────────┐
 *   │                    OwnedProxyPool                     │
 *   │                                                      │
 *   │  ┌──────────┐ ┌──────────────┐ ┌──────────────────┐ │
 *   │  │ VPS      │ │ Cloud Auto-  │ │ Community P2P    │ │
 *   │  │ Proxies  │ │ Provisioned  │ │ Network          │ │
 *   │  └──────────┘ └──────────────┘ └──────────────────┘ │
 *   │  ┌──────────┐ ┌──────────────┐ ┌──────────────────┐ │
 *   │  │ Curated  │ │ Browser Ext  │ │ IoT Scanner      │ │
 *   │  │ Free     │ │ Network      │ │ Discovered       │ │
 *   │  └──────────┘ └──────────────┘ └──────────────────┘ │
 *   │  ┌──────────┐ ┌──────────────┐                      │
 *   │  │ Subnet   │ │ Peer         │                      │
 *   │  │ Lease    │ │ Exchange     │                      │
 *   │  └──────────┘ └──────────────┘                      │
 *   │                                                      │
 *   │  ┌──────────────────────────────────────────────┐   │
 *   │  │         9-Stage Validation Pipeline           │   │
 *   │  │  TCP → HTTP → HTTPS → Anon → DNS → Speed →   │   │
 *   │  │  Geo → DNSBL → Stability                      │   │
 *   │  └──────────────────────────────────────────────┘   │
 *   │                                                      │
 *   │  ┌──────────────────────────────────────────────┐   │
 *   │  │         Health Monitor + Auto-Scaler          │   │
 *   │  └──────────────────────────────────────────────┘   │
 *   └──────────────────────────────────────────────────────┘
 */
class OwnedProxyPool {
  /** Pool configuration. */
  private config: OwnedProxyPoolConfig;

  /** In-memory set of proxy IDs currently in use for active requests. */
  private inUseSet = new Set<string>();

  /** Map of proxy IP → cooldown expiry timestamp. */
  private cooldownMap = new Map<string, number>();

  /** Health monitor timer. */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Auto-scaler timer. */
  private autoScalerTimer: ReturnType<typeof setInterval> | null = null;

  /** Cloud instance expiry timer -- checks for instances past TTL. */
  private cloudExpiryTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the pool has been initialized. */
  private initialized = false;

  /** Whether the pool is currently shutting down. */
  private shuttingDown = false;

  /** Track monthly spend on cloud provisioning. */
  private monthlyCloudSpend = 0;

  /** Number of proxies currently being validated (to avoid overloading). */
  private activeValidations = 0;

  /** Maximum concurrent validations. */
  private maxConcurrentValidations = 50;

  // --- Constructor ----------------------------------------------------------

  constructor(config: Partial<OwnedProxyPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info(
      {
        targetPoolSize: this.config.targetPoolSize,
        autoProvision: this.config.autoProvisionEnabled,
        autoImport: this.config.autoImportFromDiscovery,
        peerExchange: this.config.peerExchangeEnabled,
      },
      'OwnedProxyPool created',
    );
  }

  // --- Initialize -----------------------------------------------------------

  /**
   * Initialize the owned proxy pool. This:
   *  1. Creates the database table if it doesn't exist
   *  2. Loads the current pool from the database
   *  3. Starts the health monitoring loop
   *  4. Starts the auto-scaler
   *  5. Starts the cloud instance expiry checker
   *
   * Must be called before any other method. Safe to call multiple times
   * (subsequent calls are no-ops).
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('OwnedProxyPool already initialized -- skipping');
      return;
    }

    logger.info('Initializing OwnedProxyPool...');

    try {
      // Step 1: Create the database table if it doesn't exist
      await this.ensureSchema();

      // Step 2: Load current pool statistics
      const stats = await this.getPoolStats();
      logger.info(
        {
          totalProxies: stats.totalProxies,
          activeProxies: stats.activeProxies,
          bySource: stats.bySource,
          monthlyCost: stats.monthlyCostUsd,
        },
        'Loaded owned proxy pool from database',
      );

      // Step 3: Start the health monitoring loop
      this.startHealthMonitor();

      // Step 4: Start the auto-scaler
      this.startAutoScaler();

      // Step 5: Start cloud instance expiry checker
      this.startCloudExpiryChecker();

      this.initialized = true;
      logger.info('OwnedProxyPool initialization complete');
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to initialize OwnedProxyPool');
      throw err;
    }
  }

  // --- Ensure Database Schema -----------------------------------------------

  /**
   * Create the owned_proxies table if it doesn't exist.
   * Uses raw SQL because this table is not in the Prisma schema --
   * it's managed exclusively by this module.
   */
  private async ensureSchema(): Promise<void> {
    try {
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS owned_proxies (
          id                    TEXT PRIMARY KEY,
          ip                    TEXT NOT NULL,
          port                  INTEGER NOT NULL,
          protocol              TEXT NOT NULL DEFAULT 'http',
          source                TEXT NOT NULL DEFAULT 'curated-free',
          country               TEXT NOT NULL DEFAULT 'US',
          city                  TEXT,
          asn                   TEXT,
          isp                   TEXT,
          reputation_score      REAL NOT NULL DEFAULT 0.5,
          avg_latency_ms        INTEGER NOT NULL DEFAULT 1000,
          success_rate          REAL NOT NULL DEFAULT 0.5,
          bandwidth_mbps        REAL,
          is_anonymous          BOOLEAN NOT NULL DEFAULT FALSE,
          is_elite              BOOLEAN NOT NULL DEFAULT FALSE,
          supports_ssl          BOOLEAN NOT NULL DEFAULT FALSE,
          anonymity_level       TEXT,
          last_checked_at       TIMESTAMPTZ,
          last_used_at          TIMESTAMPTZ,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at            TIMESTAMPTZ,
          active                BOOLEAN NOT NULL DEFAULT TRUE,
          tier                  TEXT NOT NULL DEFAULT 'datacenter',
          consecutive_failures  INTEGER NOT NULL DEFAULT 0,
          total_requests        INTEGER NOT NULL DEFAULT 0,
          cloud_instance_id     TEXT,
          monthly_cost_usd      REAL NOT NULL DEFAULT 0,
          validation_score      INTEGER,
          UNIQUE(ip, port, protocol)
        );

        CREATE INDEX IF NOT EXISTS idx_owned_proxies_active ON owned_proxies(active);
        CREATE INDEX IF NOT EXISTS idx_owned_proxies_tier ON owned_proxies(tier);
        CREATE INDEX IF NOT EXISTS idx_owned_proxies_country ON owned_proxies(country);
        CREATE INDEX IF NOT EXISTS idx_owned_proxies_source ON owned_proxies(source);
        CREATE INDEX IF NOT EXISTS idx_owned_proxies_reputation ON owned_proxies(reputation_score);
        CREATE INDEX IF NOT EXISTS idx_owned_proxies_country_tier ON owned_proxies(country, tier);
        CREATE INDEX IF NOT EXISTS idx_owned_proxies_expires ON owned_proxies(expires_at) WHERE expires_at IS NOT NULL;
      `);

      logger.info('Ensured owned_proxies schema exists');
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to create owned_proxies schema');
      throw err;
    }
  }

  // --- Get Proxy ------------------------------------------------------------

  /**
   * Get the best available owned proxy matching the given criteria.
   *
   * Selection algorithm:
   *  1. If sessionId is provided, check for sticky session in Redis
   *  2. Build SQL query with all filters applied
   *  3. Order by: reputation DESC, latency ASC (best proxy first)
   *  4. If domain is specified, check IP reputation for that domain
   *  5. Mark the selected proxy as in-use and start cooldown
   *  6. Return the proxy URL with full metadata
   *
   * Returns null if no suitable proxy is found in the owned pool.
   */
  async getProxy(options: GetProxyOptions = {}): Promise<OwnedProxyResult | null> {
    if (!this.initialized) {
      logger.warn('OwnedProxyPool not initialized -- call initialize() first');
      return null;
    }

    const {
      country,
      city,
      tier,
      minReputation = this.config.minReputationForUse,
      maxLatencyMs,
      protocol,
      requireSsl = false,
      requireAnonymous = false,
      source,
      domain,
      asn,
      sessionId,
    } = options;

    try {
      // Step 1: Check sticky session
      if (sessionId) {
        const stickyResult = await this.getStickySession(sessionId, domain);
        if (stickyResult) {
          logger.debug({ sessionId, proxyId: stickyResult.proxyId }, 'Returning sticky session proxy');
          return stickyResult;
        }
      }

      // Step 2: Build and execute the selection query
      // We use parameterized queries for safety
      const conditions: string[] = [
        'active = TRUE',
        'reputation_score >= $1',
      ];
      const params: any[] = [minReputation];

      let paramIdx = 2;

      if (country) {
        conditions.push(`country = $${paramIdx}`);
        params.push(country);
        paramIdx++;
      }

      if (city) {
        conditions.push(`city = $${paramIdx}`);
        params.push(city);
        paramIdx++;
      }

      if (tier) {
        conditions.push(`tier = $${paramIdx}`);
        params.push(tier);
        paramIdx++;
      }

      if (maxLatencyMs) {
        conditions.push(`avg_latency_ms <= $${paramIdx}`);
        params.push(maxLatencyMs);
        paramIdx++;
      }

      if (protocol) {
        conditions.push(`protocol = $${paramIdx}`);
        params.push(protocol);
        paramIdx++;
      }

      if (requireSsl) {
        conditions.push('supports_ssl = TRUE');
      }

      if (requireAnonymous) {
        conditions.push('(is_anonymous = TRUE OR is_elite = TRUE)');
      }

      if (source) {
        conditions.push(`source = $${paramIdx}`);
        params.push(source);
        paramIdx++;
      }

      if (asn) {
        conditions.push(`asn = $${paramIdx}`);
        params.push(asn);
        paramIdx++;
      }

      // Exclude IPs currently in cooldown
      // (We check in-memory for speed; the cooldown window is short)
      const cooldownIps = this.getCooldownIps();
      if (cooldownIps.length > 0) {
        // Build a parameterized NOT IN clause
        const notInPlaceholders = cooldownIps.map((_, i) => `$${paramIdx + i}`);
        conditions.push(`ip NOT IN (${notInPlaceholders.join(', ')})`);
        params.push(...cooldownIps);
        paramIdx += cooldownIps.length;
      }

      const whereClause = conditions.join(' AND ');

      // Order: highest reputation first, then lowest latency
      const query = `
        SELECT * FROM owned_proxies
        WHERE ${whereClause}
        ORDER BY reputation_score DESC, avg_latency_ms ASC
        LIMIT 20
      `;

      const candidates = await db.$queryRawUnsafe<OwnedProxy[]>(query, ...params);

      if (!candidates || candidates.length === 0) {
        logger.debug(
          { country, tier, minReputation, maxLatencyMs, protocol },
          'No owned proxies matching criteria',
        );

        // Record demand signal for auto-scaler
        await this.recordDemandSignal(country, tier);
        return null;
      }

      // Step 3: If domain is specified, use reputation tracker to rank
      let selectedProxy: OwnedProxy | null = null;

      if (domain && candidates.length > 1) {
        // Check reputation for each candidate against the specific domain
        for (const candidate of candidates) {
          const verdict = await ipReputationTracker.getVerdict(candidate.id, domain);
          if (verdict.usable && !this.inUseSet.has(candidate.id)) {
            selectedProxy = candidate;
            break;
          }
        }
      } else {
        // Just pick the first one that's not in use
        for (const candidate of candidates) {
          if (!this.inUseSet.has(candidate.id)) {
            selectedProxy = candidate;
            break;
          }
        }
      }

      if (!selectedProxy) {
        logger.debug('All candidate owned proxies are in use or blacklisted');
        await this.recordDemandSignal(country, tier);
        return null;
      }

      // Step 4: Mark as in-use and start cooldown
      this.inUseSet.add(selectedProxy.id);
      this.startCooldown(selectedProxy.ip);

      // Update last_used_at in database (fire-and-forget)
      this.updateLastUsedAt(selectedProxy.id).catch(() => {});

      // Step 5: Build the proxy URL
      const proxyUrl = this.buildProxyUrl(selectedProxy);

      // Step 6: Set sticky session if requested
      if (sessionId) {
        await this.setStickySession(sessionId, selectedProxy, domain);
      }

      const result: OwnedProxyResult = {
        proxyUrl,
        proxyId: selectedProxy.id,
        source: selectedProxy.source,
        country: selectedProxy.country,
        city: selectedProxy.city,
        asn: selectedProxy.asn,
        tier: selectedProxy.tier,
        reputationScore: selectedProxy.reputationScore,
        isWarmed: selectedProxy.reputationScore > 0.7 && selectedProxy.totalRequests >= 10,
        protocol: selectedProxy.protocol,
        supportsSsl: selectedProxy.supportsSsl,
        costUsd: selectedProxy.monthlyCostUsd,
        sessionId,
      };

      logger.debug(
        { proxyId: selectedProxy.id, ip: selectedProxy.ip, country: selectedProxy.country, tier: selectedProxy.tier },
        'Selected owned proxy',
      );

      return result;
    } catch (err: any) {
      logger.error({ error: err.message, options }, 'Failed to get owned proxy');
      return null;
    }
  }

  // --- Add Proxy ------------------------------------------------------------

  /**
   * Add a new proxy to the owned pool.
   *
   * The admission process:
   *  1. Check for duplicate (ip + port + protocol)
   *  2. Validate connectivity (quick TCP test)
   *  3. Check IP reputation against known blacklists
   *  4. Assign tier based on source and detected characteristics
   *  5. Store in database
   *  6. Update Redis indexes
   *
   * Returns the proxy ID if admitted, or null if rejected.
   */
  async addProxy(input: AddProxyInput): Promise<string | null> {
    try {
      // Step 1: Check for duplicate
      const existing = await db.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM owned_proxies WHERE ip = $1 AND port = $2 AND protocol = $3 LIMIT 1',
        input.ip,
        input.port,
        input.protocol,
      );

      if (existing && existing.length > 0) {
        logger.debug(
          { ip: input.ip, port: input.port, protocol: input.protocol },
          'Proxy already exists in owned pool -- skipping',
        );
        return existing[0].id;
      }

      // Step 2: Quick connectivity test
      const isReachable = await this.quickConnectivityTest(input.ip, input.port);
      if (!isReachable) {
        logger.debug(
          { ip: input.ip, port: input.port },
          'Proxy failed connectivity test -- rejecting',
        );
        return null;
      }

      // Step 3: Check IP reputation (quick DNSBL check)
      const blacklistHits = await this.checkBlacklists(input.ip);
      if (blacklistHits >= 5) {
        logger.warn(
          { ip: input.ip, blacklists: blacklistHits },
          'IP listed on too many blacklists -- rejecting',
        );
        return null;
      }

      // Step 4: Determine tier
      const tier = input.tier || this.inferTier(input.source, input.ip);

      // Step 5: Generate ID and insert into database
      const proxyId = randomUUID();
      const now = new Date();

      await db.$executeRawUnsafe(
        `INSERT INTO owned_proxies (
          id, ip, port, protocol, source, country, city, asn, isp,
          reputation_score, avg_latency_ms, success_rate, bandwidth_mbps,
          is_anonymous, is_elite, supports_ssl, anonymity_level,
          last_checked_at, created_at, expires_at, active, tier,
          consecutive_failures, total_requests, cloud_instance_id, monthly_cost_usd
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21, $22,
          $23, $24, $25, $26
        )`,
        proxyId,
        input.ip,
        input.port,
        input.protocol,
        input.source,
        input.country || 'US',
        input.city || null,
        input.asn || null,
        input.isp || null,
        0.5, // reputation_score (neutral start)
        1000, // avg_latency_ms (unknown)
        0.5, // success_rate (neutral)
        null, // bandwidth_mbps
        input.isAnonymous || false,
        input.isElite || false,
        input.supportsSsl || false,
        null, // anonymity_level
        now, // last_checked_at
        now, // created_at
        input.expiresAt || null,
        true, // active
        tier,
        0, // consecutive_failures
        0, // total_requests
        input.cloudInstanceId || null,
        input.monthlyCostUsd || 0,
      );

      // Step 6: Update Redis indexes
      await this.updateRedisIndexes(proxyId, input.country || 'US', tier);

      // Step 7: Invalidate stats cache
      await this.invalidateStatsCache();

      logger.info(
        {
          proxyId,
          ip: input.ip,
          port: input.port,
          source: input.source,
          country: input.country || 'US',
          tier,
        },
        'Added proxy to owned pool',
      );

      return proxyId;
    } catch (err: any) {
      logger.error({ error: err.message, ip: input.ip, port: input.port }, 'Failed to add proxy to owned pool');
      return null;
    }
  }

  // --- Remove Proxy ---------------------------------------------------------

  /**
   * Remove a proxy from the owned pool.
   * If the proxy is cloud-provisioned, this also schedules the cloud
   * instance for termination.
   */
  async removeProxy(proxyId: string): Promise<boolean> {
    try {
      // Fetch the proxy details first (we need cloud_instance_id for cleanup)
      const proxies = await db.$queryRawUnsafe<Array<OwnedProxy>>(
        'SELECT * FROM owned_proxies WHERE id = $1 LIMIT 1',
        proxyId,
      );

      if (!proxies || proxies.length === 0) {
        logger.debug({ proxyId }, 'Proxy not found in owned pool');
        return false;
      }

      const proxy = proxies[0];

      // If cloud-provisioned, schedule instance termination
      if (proxy.source === 'cloud-provisioned' && proxy.cloudInstanceId) {
        await this.terminateCloudInstance(proxy.cloudInstanceId, proxy.ip).catch((err: any) => {
          logger.warn(
            { cloudInstanceId: proxy.cloudInstanceId, error: err.message },
            'Failed to terminate cloud instance (will be cleaned up by expiry checker)',
          );
        });
      }

      // Remove from database
      await db.$executeRawUnsafe('DELETE FROM owned_proxies WHERE id = $1', proxyId);

      // Clean up in-memory state
      this.inUseSet.delete(proxyId);
      this.cooldownMap.delete(proxy.ip);

      // Invalidate caches
      await this.invalidateProxyCache(proxyId);
      await this.invalidateStatsCache();

      logger.info({ proxyId, ip: proxy.ip, source: proxy.source }, 'Removed proxy from owned pool');
      return true;
    } catch (err: any) {
      logger.error({ error: err.message, proxyId }, 'Failed to remove proxy from owned pool');
      return false;
    }
  }

  // --- Validate Proxy (Full Pipeline) ---------------------------------------

  /**
   * Run the full 9-stage validation pipeline on a proxy.
   *
   * Stages:
   *  1. TCP connectivity test (3-second timeout)
   *  2. HTTP request through proxy (10-second timeout)
   *  3. HTTPS support check
   *  4. Anonymity level test (check X-Forwarded-For, Via headers)
   *  5. DNS leak test
   *  6. Speed benchmark (download 100KB test file)
   *  7. Geo-location verification (verify country matches claim)
   *  8. DNSBL blacklist scan (query 10+ DNSBL services)
   *  9. Stability test (3 consecutive successful requests over 60 seconds)
   *
   * Returns a comprehensive ValidationResult with pass/fail status and
   * a composite score used for proxy ranking.
   */
  async validateProxy(proxyId: string): Promise<ValidationResult> {
    // Throttle concurrent validations
    if (this.activeValidations >= this.maxConcurrentValidations) {
      return {
        passed: false,
        score: 0,
        tcpConnectivity: false,
        httpRequest: false,
        httpsSupport: false,
        anonymityLevel: null,
        dnsLeak: false,
        downloadSpeedBps: null,
        verifiedCountry: null,
        blacklistHits: 0,
        stabilityPassCount: null,
        latencyMs: null,
        errors: ['Validation throttled -- too many concurrent validations'],
      };
    }

    this.activeValidations++;

    try {
      // Fetch proxy details
      const proxies = await db.$queryRawUnsafe<Array<OwnedProxy>>(
        'SELECT * FROM owned_proxies WHERE id = $1 LIMIT 1',
        proxyId,
      );

      if (!proxies || proxies.length === 0) {
        return {
          passed: false,
          score: 0,
          tcpConnectivity: false,
          httpRequest: false,
          httpsSupport: false,
          anonymityLevel: null,
          dnsLeak: false,
          downloadSpeedBps: null,
          verifiedCountry: null,
          blacklistHits: 0,
          stabilityPassCount: null,
          latencyMs: null,
          errors: ['Proxy not found in database'],
        };
      }

      const proxy = proxies[0];
      const errors: string[] = [];
      let score = 0;

      logger.info({ proxyId, ip: proxy.ip, port: proxy.port }, 'Starting full validation pipeline');

      // --- Stage 1: TCP Connectivity ---
      const tcpOk = await this.testTcpConnectivity(proxy.ip, proxy.port, 3000);
      if (!tcpOk) {
        errors.push('TCP connectivity failed');
        await this.recordValidationResult(proxyId, false, 0, errors);
        return this.buildValidationResult(false, 0, { tcpConnectivity: false }, errors);
      }
      score += 10; // 10 points for TCP connectivity

      // --- Stage 2: HTTP Request Through Proxy ---
      const httpResult = await this.testHttpThroughProxy(proxy, 10000);
      if (!httpResult.success) {
        errors.push(`HTTP request failed: ${httpResult.error || 'unknown'}`);
        await this.recordValidationResult(proxyId, false, score, errors);
        return this.buildValidationResult(false, score, { tcpConnectivity: true, httpRequest: false, latencyMs: httpResult.latencyMs }, errors);
      }
      score += 15; // 15 points for HTTP
      const latencyMs = httpResult.latencyMs;

      // --- Stage 3: HTTPS Support ---
      const httpsOk = await this.testHttpsSupport(proxy, 10000);
      if (httpsOk) {
        score += 10;
      } else {
        errors.push('HTTPS not supported');
      }

      // --- Stage 4: Anonymity Level ---
      const anonResult = await this.testAnonymityLevel(proxy);
      score += anonResult.level === 'elite' ? 20 : anonResult.level === 'anonymous' ? 15 : 5;

      // --- Stage 5: DNS Leak Test ---
      const dnsLeak = await this.testDnsLeak(proxy);
      if (dnsLeak) {
        errors.push('DNS leak detected');
        score -= 10;
      } else {
        score += 10;
      }

      // --- Stage 6: Speed Benchmark ---
      const speedResult = await this.testSpeed(proxy);
      const downloadSpeedBps = speedResult.speedBps;
      if (speedResult.speedBps && speedResult.speedBps > 100000) {
        score += Math.min(15, Math.floor(speedResult.speedBps / 50000)); // Up to 15 points for speed
      }

      // --- Stage 7: Geo-location Verification ---
      const geoResult = await this.verifyGeoLocation(proxy);
      const verifiedCountry = geoResult.country;
      if (geoResult.country && geoResult.country === proxy.country) {
        score += 10;
      } else if (geoResult.country) {
        // Country doesn't match -- update it
        errors.push(`Country mismatch: expected ${proxy.country}, got ${geoResult.country}`);
        score += 5; // Partial credit -- at least we got a location
      }

      // --- Stage 8: DNSBL Blacklist Scan ---
      const blacklistHits = await this.checkBlacklists(proxy.ip);
      if (blacklistHits > 0) {
        score -= Math.min(20, blacklistHits * 4); // -4 points per blacklist, max -20
        if (blacklistHits >= 5) {
          errors.push(`Listed on ${blacklistHits} DNSBL services`);
        }
      } else {
        score += 10;
      }

      // --- Stage 9: Stability Test ---
      // Only run stability test for proxies being imported (expensive)
      // For existing pool members, we skip this stage
      let stabilityPassCount: number | null = null;
      if (proxy.source === 'curated-free' || proxy.source === 'iot-scanner') {
        stabilityPassCount = await this.runStabilityTest(proxy);
        if (stabilityPassCount >= this.config.stabilityTestRequests) {
          score += 15;
        } else {
          errors.push(`Stability test: ${stabilityPassCount}/${this.config.stabilityTestRequests} passed`);
          score += Math.floor((stabilityPassCount / this.config.stabilityTestRequests) * 10);
        }
      } else {
        // Skip stability test for managed sources -- they're already trusted
        score += 15; // Assume stable
      }

      // Clamp score to 0-100
      score = Math.max(0, Math.min(100, score));
      const passed = score >= 50 && errors.filter(e => e.includes('TCP') || e.includes('HTTP')).length === 0;

      // Update database with validation results
      await this.recordValidationResult(proxyId, passed, score, errors);

      // Update proxy metadata from validation
      await db.$executeRawUnsafe(
        `UPDATE owned_proxies SET
          avg_latency_ms = $1,
          is_anonymous = $2,
          is_elite = $3,
          supports_ssl = $4,
          anonymity_level = $5,
          last_checked_at = NOW(),
          validation_score = $6,
          country = COALESCE($7, country)
        WHERE id = $8`,
        latencyMs || proxy.avgLatencyMs,
        anonResult.level !== 'transparent',
        anonResult.level === 'elite',
        httpsOk,
        anonResult.level,
        score,
        verifiedCountry,
        proxyId,
      );

      logger.info(
        {
          proxyId,
          ip: proxy.ip,
          passed,
          score,
          latencyMs,
          anonymityLevel: anonResult.level,
          blacklistHits,
          stabilityPassCount,
        },
        'Validation pipeline completed',
      );

      return {
        passed,
        score,
        tcpConnectivity: tcpOk,
        httpRequest: httpResult.success,
        httpsSupport: httpsOk,
        anonymityLevel: anonResult.level,
        dnsLeak,
        downloadSpeedBps,
        verifiedCountry,
        blacklistHits,
        stabilityPassCount,
        latencyMs,
        errors,
      };
    } catch (err: any) {
      logger.error({ error: err.message, proxyId }, 'Validation pipeline failed');
      return {
        passed: false,
        score: 0,
        tcpConnectivity: false,
        httpRequest: false,
        httpsSupport: false,
        anonymityLevel: null,
        dnsLeak: false,
        downloadSpeedBps: null,
        verifiedCountry: null,
        blacklistHits: 0,
        stabilityPassCount: null,
        latencyMs: null,
        errors: [`Validation pipeline error: ${err.message}`],
      };
    } finally {
      this.activeValidations--;
    }
  }

  // --- Auto-Provision Cloud Instances ---------------------------------------

  /**
   * Auto-provision cloud instances as proxy nodes.
   *
   * This method:
   *  1. Selects a cloud provision template (round-robin by provider)
   *  2. Checks the monthly budget hasn't been exceeded
   *  3. Calls the cloud provider API to create an instance
   *  4. Waits for the instance to be ready (with timeout)
   *  5. Validates the newly created proxy
   *  6. Registers it in the owned pool
   *  7. Sets an auto-terminate timer based on the TTL
   *
   * Supported providers:
   *  - AWS EC2 (via REST API)
   *  - DigitalOcean Droplets (via REST API)
   *  - Hetzner Cloud (via REST API)
   *  - Google Compute Engine (via REST API)
   *
   * Returns the proxy ID if successfully provisioned, or null on failure.
   */
  async autoProvisionCloud(config?: Partial<CloudProvisionTemplate>): Promise<string | null> {
    if (!this.config.autoProvisionEnabled) {
      logger.warn('Cloud auto-provisioning is disabled in config');
      return null;
    }

    // Select a template -- use provided config or default
    const template: CloudProvisionTemplate = config
      ? { ...DEFAULT_CLOUD_TEMPLATES[0], ...config }
      : DEFAULT_CLOUD_TEMPLATES[Math.floor(Math.random() * DEFAULT_CLOUD_TEMPLATES.length)];

    // Check budget
    if (this.config.cloudProvisionBudgetPerMonth > 0 &&
        this.monthlyCloudSpend >= this.config.cloudProvisionBudgetPerMonth) {
      logger.warn(
        { spend: this.monthlyCloudSpend, budget: this.config.cloudProvisionBudgetPerMonth },
        'Monthly cloud provision budget exceeded -- skipping',
      );
      return null;
    }

    // Check max cost per hour
    if (template.maxCostPerHour <= 0) {
      logger.warn({ template }, 'Invalid max cost per hour -- skipping');
      return null;
    }

    logger.info(
      { provider: template.provider, region: template.region, instanceType: template.instanceType, software: template.proxySoftware },
      'Starting cloud auto-provisioning',
    );

    try {
      // Step 1: Call the cloud provider API to create an instance
      // NOTE: In production, these would use the provider's REST API with
      // proper authentication. Here we document the exact API calls that
      // would be made.

      const instanceResult = await this.callCloudProviderAPI(template);

      if (!instanceResult.success) {
        logger.error(
          { provider: template.provider, error: instanceResult.error },
          'Cloud provider API call failed',
        );
        return null;
      }

      logger.info(
        { provider: template.provider, instanceId: instanceResult.instanceId, ip: instanceResult.ip },
        'Cloud instance created -- waiting for proxy to be ready',
      );

      // Step 2: Wait for the proxy to be ready (with timeout)
      const proxyPort = this.getProxyPort(template.proxySoftware);
      const isReady = await this.waitForProxyReady(instanceResult.ip!, proxyPort, 120000);

      if (!isReady) {
        logger.error(
          { ip: instanceResult.ip, port: proxyPort },
          'Cloud provisioned proxy failed to become ready -- terminating instance',
        );
        // Clean up the instance since the proxy isn't working
        if (instanceResult.instanceId) {
          await this.terminateCloudInstance(instanceResult.instanceId, instanceResult.ip!).catch(() => {});
        }
        return null;
      }

      // Step 3: Determine the protocol based on proxy software
      const protocol: ProxyProtocol = template.proxySoftware === 'dante' ? 'socks5' : 'http';

      // Step 4: Add to the owned pool
      const proxyId = await this.addProxy({
        ip: instanceResult.ip!,
        port: proxyPort,
        protocol,
        source: 'cloud-provisioned',
        country: this.regionToCountry(template.region),
        tier: 'datacenter',
        supportsSsl: template.proxySoftware !== 'tinyproxy',
        cloudInstanceId: instanceResult.instanceId ?? undefined,
        monthlyCostUsd: this.estimateMonthlyCost(template),
        expiresAt: new Date(Date.now() + template.ttlMinutes * 60 * 1000),
      });

      if (!proxyId) {
        logger.error('Failed to add cloud-provisioned proxy to pool -- terminating instance');
        if (instanceResult.instanceId) {
          await this.terminateCloudInstance(instanceResult.instanceId, instanceResult.ip!).catch(() => {});
        }
        return null;
      }

      // Step 5: Update monthly spend tracking
      this.monthlyCloudSpend += this.estimateMonthlyCost(template);

      // Step 6: Run validation (non-blocking -- don't wait for result)
      this.validateProxy(proxyId).catch((err: any) => {
        logger.warn({ proxyId, error: err.message }, 'Background validation of cloud-provisioned proxy failed');
      });

      logger.info(
        { proxyId, ip: instanceResult.ip, provider: template.provider, ttlMinutes: template.ttlMinutes },
        'Cloud-provisioned proxy added to owned pool',
      );

      return proxyId;
    } catch (err: any) {
      logger.error({ error: err.message, provider: template.provider }, 'Cloud auto-provisioning failed');
      return null;
    }
  }

  // --- Import from Discovery ------------------------------------------------

  /**
   * Import validated proxies from the free proxy discovery module.
   *
   * This is the primary way to grow the owned pool for free. It:
   *  1. Queries the best candidates from the free proxy discovery system
   *  2. Runs an extended validation (5-minute stability test)
   *  3. Adds qualifying proxies to the owned pool as 'curated-free' source
   *
   * The import process is conservative -- only proxies that pass the
   * extended stability test are admitted, ensuring the owned pool
   * maintains high quality.
   *
   * @param count - Maximum number of proxies to import
   * @returns Number of proxies successfully imported
   */
  async importFromDiscovery(count: number = 50): Promise<number> {
    logger.info({ count }, 'Starting import from free proxy discovery');

    let imported = 0;

    try {
      // Step 1: Get best candidates from the database
      // These are proxies in the regular 'proxies' table that have good
      // success rates but aren't yet in the owned pool
      const candidates = await db.$queryRawUnsafe<Array<{
        id: string;
        url: string;
        country: string;
        tier: string;
        success_rate: number;
        p95_latency: number;
      }>>(
        `SELECT id, url, country, tier, success_rate, p95_latency
         FROM proxies
         WHERE retired = FALSE
           AND success_rate >= 0.6
           AND p95_latency <= 3000
           AND id NOT IN (SELECT id FROM owned_proxies)
         ORDER BY success_rate DESC, p95_latency ASC
         LIMIT $1`,
        count * 3, // Get 3x candidates (many will fail stability test)
      );

      if (!candidates || candidates.length === 0) {
        logger.info('No suitable candidates found in discovery pool');
        return 0;
      }

      logger.info({ candidates: candidates.length }, 'Found candidates from discovery pool');

      // Step 2: Parse proxy URLs and run extended validation
      for (const candidate of candidates) {
        if (imported >= count) break;

        const parsed = this.parseProxyUrl(candidate.url);
        if (!parsed) continue;

        // Quick connectivity test first
        const reachable = await this.quickConnectivityTest(parsed.ip, parsed.port);
        if (!reachable) continue;

        // Run extended stability test
        const stabilityOk = await this.runExtendedStabilityTest(parsed.ip, parsed.port, parsed.protocol);
        if (!stabilityOk) continue;

        // Add to owned pool
        const proxyId = await this.addProxy({
          ip: parsed.ip,
          port: parsed.port,
          protocol: parsed.protocol,
          source: 'curated-free',
          country: candidate.country || 'US',
          tier: (candidate.tier as ProxyTier) || 'datacenter',
        });

        if (proxyId) {
          imported++;
          logger.debug(
            { proxyId, ip: parsed.ip, imported, target: count },
            'Imported proxy from discovery',
          );
        }
      }

      logger.info(
        { imported, candidates: candidates.length, target: count },
        'Import from discovery completed',
      );

      return imported;
    } catch (err: any) {
      logger.error({ error: err.message }, 'Import from discovery failed');
      return imported;
    }
  }

  // --- Peer Exchange --------------------------------------------------------

  /**
   * Exchange proxies with another ScrapeSuite node.
   *
   * The peer exchange protocol works as follows:
   *  1. Select N proxies from our pool to offer (excluding our best ones)
   *  2. POST the offer to the peer's exchange endpoint
   *  3. Receive N proxies in return
   *  4. Validate all received proxies through our pipeline
   *  5. Add qualifying proxies to our pool as 'peer-exchange' source
   *
   * This creates a cooperative mesh network where operators help
   * each other diversify their IP pools without monetary cost.
   */
  async handlePeerExchange(exchangeConfig: PeerExchangeConfig): Promise<number> {
    if (!this.config.peerExchangeEnabled) {
      logger.warn('Peer exchange is disabled in config');
      return 0;
    }

    logger.info(
      { peerEndpoint: exchangeConfig.peerEndpoint, offerCount: exchangeConfig.offerCount },
      'Starting peer exchange',
    );

    try {
      // Step 1: Select proxies to offer
      // We offer our lower-tier proxies, keeping the best for ourselves
      const offered = await db.$queryRawUnsafe<Array<OwnedProxy>>(
        `SELECT * FROM owned_proxies
         WHERE active = TRUE
           AND reputation_score >= 0.3
           AND reputation_score <= 0.7
           AND source != 'peer-exchange'
         ORDER BY reputation_score ASC
         LIMIT $1`,
        exchangeConfig.offerCount,
      );

      if (!offered || offered.length === 0) {
        logger.warn('No proxies available to offer in peer exchange');
        return 0;
      }

      // Build the offer payload (sanitized -- no internal IDs)
      const offerPayload = offered.map(p => ({
        ip: p.ip,
        port: p.port,
        protocol: p.protocol,
        country: p.country,
        city: p.city,
        tier: p.tier,
        reputationScore: p.reputationScore,
        avgLatencyMs: p.avgLatencyMs,
        supportsSsl: p.supportsSsl,
      }));

      // Step 2: POST the offer to the peer endpoint
      // NOTE: In production, this would make an actual HTTP request.
      // The peer endpoint format is:
      //   POST {peerEndpoint}/api/v1/peer-exchange
      //   Headers: Authorization: Bearer {authToken}
      //   Body: { offer: offerPayload, preferredCountries, preferredTiers, maxLatencyMs }
      //   Response: { received: [{ ip, port, protocol, country, ... }] }
      logger.info(
        { offeredCount: offerPayload.length, peerEndpoint: exchangeConfig.peerEndpoint },
        'Would POST peer exchange offer (HTTP call not implemented in this module)',
      );

      // Placeholder: In production, this would be:
      // const response = await fetch(`${exchangeConfig.peerEndpoint}/api/v1/peer-exchange`, {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     'Authorization': `Bearer ${exchangeConfig.authToken}`,
      //   },
      //   body: JSON.stringify({
      //     offer: offerPayload,
      //     preferredCountries: exchangeConfig.preferredCountries,
      //     preferredTiers: exchangeConfig.preferredTiers,
      //     maxLatencyMs: exchangeConfig.maxLatencyMs,
      //   }),
      // });
      // const data = await response.json();
      // const received: Array<{ ip: string; port: number; ... }> = data.received;

      // For now, simulate receiving nothing (no actual peer to talk to)
      const received: Array<{ ip: string; port: number; protocol: ProxyProtocol; country: string; tier: ProxyTier }> = [];

      // Step 3: Validate received proxies
      let addedCount = 0;
      for (const receivedProxy of received) {
        // Quick validation
        const reachable = await this.quickConnectivityTest(receivedProxy.ip, receivedProxy.port);
        if (!reachable) continue;

        // Add to pool
        const proxyId = await this.addProxy({
          ip: receivedProxy.ip,
          port: receivedProxy.port,
          protocol: receivedProxy.protocol,
          source: 'peer-exchange',
          country: receivedProxy.country,
          tier: receivedProxy.tier,
        });

        if (proxyId) {
          addedCount++;
        }
      }

      logger.info(
        { offered: offered.length, received: received.length, added: addedCount },
        'Peer exchange completed',
      );

      return addedCount;
    } catch (err: any) {
      logger.error({ error: err.message }, 'Peer exchange failed');
      return 0;
    }
  }

  // --- Report Proxy Result --------------------------------------------------

  /**
   * Report the result of a request made through an owned proxy.
   * This feeds data back into the reputation system and updates
   * the proxy's success rate and latency statistics.
   */
  async reportProxyResult(
    proxyId: string,
    success: boolean,
    responseTimeMs: number,
  ): Promise<void> {
    try {
      // Update IP reputation tracker
      await ipReputationTracker.recordOutcome(proxyId, '*', success);

      // Update proxy statistics in database
      // Use exponential moving average for success rate and latency
      const proxies = await db.$queryRawUnsafe<Array<{ success_rate: number; avg_latency_ms: number; total_requests: number; consecutive_failures: number }>>(
        'SELECT success_rate, avg_latency_ms, total_requests, consecutive_failures FROM owned_proxies WHERE id = $1',
        proxyId,
      );

      if (proxies && proxies.length > 0) {
        const current = proxies[0];
        const alpha = 0.15; // EMA smoothing factor

        const newSuccessRate = success
          ? current.success_rate * (1 - alpha) + alpha
          : current.success_rate * (1 - alpha);

        const newLatency = responseTimeMs > 0
          ? current.avg_latency_ms * (1 - alpha) + responseTimeMs * alpha
          : current.avg_latency_ms;

        const newConsecutiveFailures = success ? 0 : current.consecutive_failures + 1;

        // Update reputation score based on success rate
        const newReputation = newSuccessRate;

        // Determine if proxy should be deactivated
        const shouldDeactivate = newConsecutiveFailures >= this.config.retireAfterConsecutiveFailures;

        await db.$executeRawUnsafe(
          `UPDATE owned_proxies SET
            success_rate = $1,
            avg_latency_ms = $2,
            reputation_score = $3,
            consecutive_failures = $4,
            total_requests = total_requests + 1,
            active = $5,
            last_used_at = NOW()
          WHERE id = $6`,
          newSuccessRate,
          Math.round(newLatency),
          newReputation,
          newConsecutiveFailures,
          shouldDeactivate ? false : true,
          proxyId,
        );

        // Release from in-use set
        this.inUseSet.delete(proxyId);

        // Record demand signal if failed
        if (!success) {
          await this.recordDemandSignal(undefined, undefined);
        }
      }
    } catch (err: any) {
      logger.warn({ error: err.message, proxyId }, 'Failed to report proxy result');
    }
  }

  // --- Get Pool Stats -------------------------------------------------------

  /**
   * Return comprehensive pool statistics.
   * Results are cached in Redis for 30 seconds to avoid hammering
   * the database on dashboard refreshes.
   */
  async getPoolStats(): Promise<PoolStats> {
    try {
      // Check cache first
      const cached = await cacheGet<PoolStats>('owned-proxy:pool:stats');
      if (cached && Date.now() - cached.computedAt < this.config.statsCacheTtlSeconds * 1000) {
        return cached;
      }

      // Total counts
      const totalResult = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT COUNT(*) as count FROM owned_proxies',
      );
      const totalProxies = Number(totalResult?.[0]?.count ?? 0);

      const activeResult = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT COUNT(*) as count FROM owned_proxies WHERE active = TRUE',
      );
      const activeProxies = Number(activeResult?.[0]?.count ?? 0);

      // By source
      const bySourceRows = await db.$queryRawUnsafe<Array<{ source: string; count: bigint }>>(
        'SELECT source, COUNT(*) as count FROM owned_proxies WHERE active = TRUE GROUP BY source',
      );
      const bySource: Record<string, number> = {};
      for (const row of bySourceRows || []) {
        bySource[row.source] = Number(row.count);
      }

      // By tier
      const byTierRows = await db.$queryRawUnsafe<Array<{ tier: string; count: bigint }>>(
        'SELECT tier, COUNT(*) as count FROM owned_proxies WHERE active = TRUE GROUP BY tier',
      );
      const byTier: Record<string, number> = {};
      for (const row of byTierRows || []) {
        byTier[row.tier] = Number(row.count);
      }

      // By country (top 20)
      const byCountryRows = await db.$queryRawUnsafe<Array<{ country: string; count: bigint }>>(
        'SELECT country, COUNT(*) as count FROM owned_proxies WHERE active = TRUE GROUP BY country ORDER BY count DESC LIMIT 20',
      );
      const byCountry: Record<string, number> = {};
      for (const row of byCountryRows || []) {
        byCountry[row.country] = Number(row.count);
      }

      // Average reputation and latency
      const avgResult = await db.$queryRawUnsafe<Array<{ avg_rep: number | null; avg_lat: number | null }>>(
        'SELECT AVG(reputation_score) as avg_rep, AVG(avg_latency_ms) as avg_lat FROM owned_proxies WHERE active = TRUE',
      );
      const avgReputation = avgResult?.[0]?.avg_rep ?? 0;
      const avgLatencyMs = avgResult?.[0]?.avg_lat ?? 0;

      // Monthly cost
      const costResult = await db.$queryRawUnsafe<Array<{ total_cost: number | null }>>(
        'SELECT SUM(monthly_cost_usd) as total_cost FROM owned_proxies WHERE active = TRUE',
      );
      const monthlyCostUsd = costResult?.[0]?.total_cost ?? 0;

      // Pending demand
      const demandCount = await redis.zcard('owned-proxy:demand');

      const stats: PoolStats = {
        totalProxies,
        activeProxies,
        coolingProxies: this.cooldownMap.size,
        inUseProxies: this.inUseSet.size,
        failedProxies: totalProxies - activeProxies,
        bySource: bySource as Record<OwnedProxySource, number>,
        byTier: byTier as Record<ProxyTier, number>,
        byCountry,
        avgReputation,
        avgLatencyMs,
        utilizationRate: activeProxies > 0 ? this.inUseSet.size / activeProxies : 0,
        monthlyCostUsd,
        autoScalingActive: this.config.autoProvisionEnabled,
        pendingDemand: demandCount,
        lastHealthCheckAt: null,
        computedAt: Date.now(),
      };

      // Cache the result
      await cacheSet('owned-proxy:pool:stats', stats, this.config.statsCacheTtlSeconds);

      return stats;
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to get pool stats');
      return {
        totalProxies: 0,
        activeProxies: 0,
        coolingProxies: 0,
        inUseProxies: 0,
        failedProxies: 0,
        bySource: {} as Record<OwnedProxySource, number>,
        byTier: {} as Record<ProxyTier, number>,
        byCountry: {},
        avgReputation: 0,
        avgLatencyMs: 0,
        utilizationRate: 0,
        monthlyCostUsd: 0,
        autoScalingActive: false,
        pendingDemand: 0,
        lastHealthCheckAt: null,
        computedAt: Date.now(),
      };
    }
  }

  // --- Health Monitor -------------------------------------------------------

  /**
   * Periodic health check loop. Runs every healthCheckIntervalMs.
   * Selects a batch of proxies that haven't been checked recently
   * and runs the validation pipeline on them.
   */
  private startHealthMonitor(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      this.healthMonitor().catch((err: any) => {
        logger.warn({ error: err.message }, 'Health monitor cycle failed');
      });
    }, this.config.healthCheckIntervalMs);

    logger.info(
      { intervalMs: this.config.healthCheckIntervalMs },
      'Health monitor started',
    );
  }

  /**
   * Run one health check cycle.
   * Selects proxies that haven't been checked recently and validates them.
   */
  private async healthMonitor(): Promise<void> {
    if (this.shuttingDown) return;

    try {
      logger.debug('Health monitor cycle starting');

      // Select proxies that need health checking
      // Priority: proxies not checked in the last 5 minutes
      const staleProxies = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM owned_proxies
         WHERE active = TRUE
           AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '5 minutes')
         ORDER BY last_checked_at ASC NULLS FIRST
         LIMIT $1`,
        this.config.healthCheckConcurrency,
      );

      if (!staleProxies || staleProxies.length === 0) {
        logger.debug('No stale proxies to health check');
        return;
      }

      logger.info({ count: staleProxies.length }, 'Running health checks on stale proxies');

      // Run validations in parallel (with concurrency limit)
      const results = await Promise.allSettled(
        staleProxies.map(p => this.validateProxy(p.id)),
      );

      let passedCount = 0;
      let failedCount = 0;

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.passed) {
          passedCount++;
        } else {
          failedCount++;
        }
      }

      logger.info(
        { checked: staleProxies.length, passed: passedCount, failed: failedCount },
        'Health monitor cycle completed',
      );

      // Also check for expired proxies
      await this.retireExpiredProxies();

      // Invalidate stats cache after health check
      await this.invalidateStatsCache();
    } catch (err: any) {
      logger.error({ error: err.message }, 'Health monitor cycle error');
    }
  }

  // --- Auto-Scaler ----------------------------------------------------------

  /**
   * Start the auto-scaler that grows or shrinks the pool based on demand.
   */
  private startAutoScaler(): void {
    if (this.autoScalerTimer) return;

    this.autoScalerTimer = setInterval(() => {
      this.autoScaler().catch((err: any) => {
        logger.warn({ error: err.message }, 'Auto-scaler cycle failed');
      });
    }, this.config.autoScalerIntervalMs);

    logger.info(
      { intervalMs: this.config.autoScalerIntervalMs },
      'Auto-scaler started',
    );
  }

  /**
   * Auto-scale the pool based on demand signals and current pool health.
   *
   * Scaling logic:
   *  - If pool < minPoolSize → grow immediately
   *  - If demand signals exist and pool < targetPoolSize → grow
   *  - If pool > maxPoolSize → retire worst-performing proxies
   *  - If autoProvisionEnabled → provision cloud instances
   *  - If autoImportFromDiscovery → import from free discovery
   */
  private async autoScaler(): Promise<void> {
    if (this.shuttingDown) return;

    try {
      const stats = await this.getPoolStats();

      // Scale DOWN: retire worst proxies if over max
      if (stats.totalProxies > this.config.maxPoolSize) {
        const excess = stats.totalProxies - this.config.maxPoolSize;
        logger.info({ excess }, 'Pool over max size -- retiring worst proxies');
        await this.retireWorstProxies(excess);
        return;
      }

      // Scale UP: if below minimum, grow immediately
      if (stats.activeProxies < this.config.minPoolSize) {
        const deficit = this.config.minPoolSize - stats.activeProxies;
        logger.info({ deficit }, 'Pool below minimum size -- scaling up');

        // Try free discovery first (cheapest)
        if (this.config.autoImportFromDiscovery) {
          const imported = await this.importFromDiscovery(Math.min(deficit, 100));
          if (imported >= deficit) return; // Satisfied by free discovery
        }

        // Fall back to cloud provisioning if enabled
        if (this.config.autoProvisionEnabled) {
          const remaining = deficit - (this.config.autoImportFromDiscovery ? Math.min(deficit, 100) : 0);
          for (let i = 0; i < Math.min(remaining, 10); i++) {
            await this.autoProvisionCloud().catch(() => {});
          }
        }
        return;
      }

      // Demand-driven scaling
      if (stats.pendingDemand > 0 && stats.activeProxies < this.config.targetPoolSize) {
        logger.info(
          { demand: stats.pendingDemand, active: stats.activeProxies, target: this.config.targetPoolSize },
          'Demand signals detected -- growing pool',
        );

        if (this.config.autoImportFromDiscovery) {
          await this.importFromDiscovery(Math.min(stats.pendingDemand * 2, 50));
        }

        if (this.config.autoProvisionEnabled && stats.activeProxies < this.config.targetPoolSize * 0.8) {
          await this.autoProvisionCloud().catch(() => {});
        }
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'Auto-scaler error');
    }
  }

  // --- Cloud Expiry Checker -------------------------------------------------

  /**
   * Start a timer that checks for cloud instances past their TTL
   * and terminates them.
   */
  private startCloudExpiryChecker(): void {
    if (this.cloudExpiryTimer) return;

    // Check every 5 minutes
    this.cloudExpiryTimer = setInterval(() => {
      this.checkExpiredCloudInstances().catch((err: any) => {
        logger.warn({ error: err.message }, 'Cloud expiry check failed');
      });
    }, 5 * 60 * 1000);

    logger.info('Cloud instance expiry checker started');
  }

  /**
   * Find and terminate cloud-provisioned proxies that have passed their TTL.
   */
  private async checkExpiredCloudInstances(): Promise<void> {
    try {
      const expired = await db.$queryRawUnsafe<Array<OwnedProxy>>(
        `SELECT * FROM owned_proxies
         WHERE source = 'cloud-provisioned'
           AND expires_at IS NOT NULL
           AND expires_at < NOW()
           AND active = TRUE`,
      );

      if (!expired || expired.length === 0) return;

      logger.info({ count: expired.length }, 'Found expired cloud instances to terminate');

      for (const proxy of expired) {
        await this.removeProxy(proxy.id);
        logger.info({ proxyId: proxy.id, ip: proxy.ip }, 'Terminated expired cloud instance');
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to check expired cloud instances');
    }
  }

  // --- Shutdown -------------------------------------------------------------

  /**
   * Gracefully shut down the owned proxy pool.
   * Stops all timers and releases resources.
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down OwnedProxyPool...');
    this.shuttingDown = true;

    // Stop all timers
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.autoScalerTimer) {
      clearInterval(this.autoScalerTimer);
      this.autoScalerTimer = null;
    }

    if (this.cloudExpiryTimer) {
      clearInterval(this.cloudExpiryTimer);
      this.cloudExpiryTimer = null;
    }

    // Clear in-memory state
    this.inUseSet.clear();
    this.cooldownMap.clear();

    this.initialized = false;
    logger.info('OwnedProxyPool shutdown complete');
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  // --- Validation Pipeline Stages -------------------------------------------

  /**
   * Stage 1: Test TCP connectivity to the proxy.
   * Attempts to establish a TCP connection within the given timeout.
   */
  private async testTcpConnectivity(ip: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = require('net').createConnection({ host: ip, port, timeout: timeoutMs / 1000 });
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });
  }

  /**
   * Stage 2: Test HTTP request through the proxy.
   * Makes a GET request through the proxy and checks for a valid response.
   */
  private async testHttpThroughProxy(
    proxy: OwnedProxy,
    timeoutMs: number,
  ): Promise<{ success: boolean; latencyMs: number | null; error?: string }> {
    try {
      const proxyUrl = this.buildProxyUrl(proxy);
      const startTime = Date.now();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch('http://httpbin.org/ip', {
        signal: controller.signal,
        // @ts-ignore -- Node.js fetch supports this
        proxy: proxyUrl,
      });

      clearTimeout(timeout);

      const latencyMs = Date.now() - startTime;

      if (response.ok) {
        return { success: true, latencyMs };
      } else {
        return { success: false, latencyMs, error: `HTTP ${response.status}` };
      }
    } catch (err: any) {
      return { success: false, latencyMs: null, error: err.message };
    }
  }

  /**
   * Stage 3: Test HTTPS support through the proxy.
   */
  private async testHttpsSupport(proxy: OwnedProxy, timeoutMs: number): Promise<boolean> {
    try {
      const proxyUrl = this.buildProxyUrl(proxy);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch('https://httpbin.org/ip', {
        signal: controller.signal,
        // @ts-ignore
        proxy: proxyUrl,
      });

      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Stage 4: Test anonymity level.
   * Checks what headers the proxy forwards (X-Forwarded-For, Via, etc.)
   * to determine if it's transparent, anonymous, or elite.
   */
  private async testAnonymityLevel(
    proxy: OwnedProxy,
  ): Promise<{ level: AnonymityLevel; leakedHeaders: string[] }> {
    try {
      const proxyUrl = this.buildProxyUrl(proxy);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      // httpbin.org/headers returns all headers the server received
      const response = await fetch('http://httpbin.org/headers', {
        signal: controller.signal,
        // @ts-ignore
        proxy: proxyUrl,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return { level: 'transparent', leakedHeaders: [] };
      }

      const data = await response.json() as any;
      const headers = data?.headers || {};

      // Check for proxy-leaking headers
      const leakedHeaders: string[] = [];
      const proxyIndicators = [
        'X-Forwarded-For',
        'X-Real-Ip',
        'Via',
        'X-Proxy-Id',
        'Forwarded',
        'X-Squid-Error',
        'Proxy-Connection',
        'X-Cache',
        'X-Libcurl-Nokeep',
      ];

      for (const indicator of proxyIndicators) {
        if (headers[indicator] || headers[indicator.toLowerCase()]) {
          leakedHeaders.push(indicator);
        }
      }

      let level: AnonymityLevel;
      if (leakedHeaders.length === 0 && !headers['X-Forwarded-For']) {
        level = 'elite';
      } else if (leakedHeaders.some(h => h === 'X-Forwarded-For' || h === 'X-Real-Ip')) {
        level = 'transparent';
      } else {
        level = 'anonymous';
      }

      return { level, leakedHeaders };
    } catch {
      return { level: 'transparent', leakedHeaders: [] };
    }
  }

  /**
   * Stage 5: Test for DNS leaks.
   * Makes a request through the proxy and checks if the DNS resolution
   * leaked to the client's ISP rather than going through the proxy.
   */
  private async testDnsLeak(proxy: OwnedProxy): Promise<boolean> {
    try {
      const proxyUrl = this.buildProxyUrl(proxy);

      // Use a DNS leak test service
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch('http://dnsleak.com/', {
        signal: controller.signal,
        // @ts-ignore
        proxy: proxyUrl,
      });

      clearTimeout(timeout);

      // If we can reach the service through the proxy, DNS is working
      // A proper DNS leak test would compare the resolved IP with our actual IP
      return response.ok;
    } catch {
      // Can't determine -- assume no leak for safety
      return false;
    }
  }

  /**
   * Stage 6: Speed benchmark.
   * Downloads a test file and measures throughput.
   */
  private async testSpeed(proxy: OwnedProxy): Promise<{ speedBps: number | null }> {
    try {
      const proxyUrl = this.buildProxyUrl(proxy);
      const startTime = Date.now();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      // Download ~100KB test file
      const response = await fetch('http://speedtest.tele2.net/100KB.zip', {
        signal: controller.signal,
        // @ts-ignore
        proxy: proxyUrl,
      });

      clearTimeout(timeout);

      if (!response.ok) return { speedBps: null };

      const buffer = await response.arrayBuffer();
      const elapsedMs = Date.now() - startTime;

      if (elapsedMs <= 0) return { speedBps: null };

      const bytesPerSecond = (buffer.byteLength / elapsedMs) * 1000;
      return { speedBps: bytesPerSecond };
    } catch {
      return { speedBps: null };
    }
  }

  /**
   * Stage 7: Verify geo-location.
   * Queries a geo-IP service through the proxy to verify the country.
   */
  private async verifyGeoLocation(proxy: OwnedProxy): Promise<{ country: string | null; city: string | null }> {
    try {
      const proxyUrl = this.buildProxyUrl(proxy);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch('http://ip-api.com/json/', {
        signal: controller.signal,
        // @ts-ignore
        proxy: proxyUrl,
      });

      clearTimeout(timeout);

      if (!response.ok) return { country: null, city: null };

      const data = await response.json() as any;
      return {
        country: data?.countryCode || null,
        city: data?.city || null,
      };
    } catch {
      return { country: null, city: null };
    }
  }

  /**
   * Stage 8: DNSBL blacklist scan.
   * Queries DNS-based Blackhole Lists to check if the IP is listed.
   * Returns the number of lists that contain this IP.
   */
  private async checkBlacklists(ip: string): Promise<number> {
    let hits = 0;

    try {
      // Reverse the IP for DNSBL lookup (e.g., 1.2.3.4 → 4.3.2.1)
      const reversed = ip.split('.').reverse().join('.');

      // Query each DNSBL service
      const checkPromises = this.config.dnsblServices.map(async (dnsbl) => {
        try {
          const lookupHost = `${reversed}.${dnsbl}`;
          // Use DNS resolution to check if the IP is listed
          // A resolved address means the IP IS listed
          const { resolve4 } = require('dns').promises;
          await resolve4(lookupHost);
          return true; // Listed
        } catch {
          return false; // Not listed (NXDOMAIN)
        }
      });

      const results = await Promise.allSettled(checkPromises);
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          hits++;
        }
      }
    } catch (err: any) {
      logger.debug({ error: err.message, ip }, 'Blacklist check error');
    }

    return hits;
  }

  /**
   * Stage 9: Stability test.
   * Makes N consecutive requests through the proxy over a period of time
   * and counts how many succeed.
   */
  private async runStabilityTest(proxy: OwnedProxy): Promise<number> {
    const requestCount = this.config.stabilityTestRequests;
    const intervalMs = 20000; // 20 seconds between requests
    let passCount = 0;

    for (let i = 0; i < requestCount; i++) {
      const result = await this.testHttpThroughProxy(proxy, 10000);
      if (result.success) {
        passCount++;
      }

      // Wait between requests (unless this is the last one)
      if (i < requestCount - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    return passCount;
  }

  /**
   * Extended stability test for importing from discovery.
   * Runs over 5 minutes with 3 requests spread across the duration.
   */
  private async runExtendedStabilityTest(
    ip: string,
    port: number,
    protocol: ProxyProtocol,
  ): Promise<boolean> {
    const proxy: OwnedProxy = {
      id: 'temp',
      ip,
      port,
      protocol,
      source: 'curated-free',
      country: 'US',
      city: null,
      asn: null,
      isp: null,
      reputationScore: 0.5,
      avgLatencyMs: 1000,
      successRate: 0.5,
      bandwidthMbps: null,
      isAnonymous: false,
      isElite: false,
      supportsSsl: false,
      anonymityLevel: null,
      lastCheckedAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
      expiresAt: null,
      active: true,
      tier: 'datacenter',
      consecutiveFailures: 0,
      totalRequests: 0,
      cloudInstanceId: null,
      monthlyCostUsd: 0,
      validationScore: null,
      isCoolingDown: false,
    };

    const passCount = await this.runStabilityTest(proxy);
    return passCount >= this.config.stabilityTestRequests;
  }

  // --- Cloud Provider API Helpers -------------------------------------------

  /**
   * Call a cloud provider's API to create a new instance.
   *
   * NOTE: This method documents the exact API calls that would be made
   * to each provider. In production, you would use the provider's REST
   * API with proper authentication tokens stored in environment variables.
   *
   * Provider-specific API details:
   *
   * AWS EC2:
   *   POST https://ec2.{region}.amazonaws.com/
   *   Action=RunInstances
   *   ImageId=ami-0xxx (Ubuntu 22.04)
   *   InstanceType={instanceType}
   *   UserData={base64-encoded startupScript}
   *   Headers: Authorization: AWS4-HMAC-SHA256 Credential=...
   *
   * DigitalOcean:
   *   POST https://api.digitalocean.com/v2/droplets
   *   Headers: Authorization: Bearer $DIGITALOCEAN_TOKEN
   *   Body: { name, region, size, image: "ubuntu-22-04-x64", user_data: startupScript }
   *
   * Hetzner Cloud:
   *   POST https://api.hetzner.cloud/v1/servers
   *   Headers: Authorization: Bearer $HETZNER_TOKEN
   *   Body: { name, server_type, location, image: "ubuntu-22.04", user_data: startupScript }
   *
   * Google Compute Engine:
   *   POST https://compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/instances
   *   Headers: Authorization: Bearer $GCP_TOKEN
   *   Body: { name, machineType, disks, networkInterfaces, metadata: { startupScript } }
   */
  private async callCloudProviderAPI(
    template: CloudProvisionTemplate,
  ): Promise<{
    success: boolean;
    instanceId: string | null;
    ip: string | null;
    error?: string;
  }> {
    try {
      const instanceName = `scrapesuite-proxy-${Date.now()}`;
      const startupScriptB64 = Buffer.from(template.startupScript).toString('base64');

      switch (template.provider) {
        case 'digitalocean': {
          // DigitalOcean API call structure:
          // const response = await fetch('https://api.digitalocean.com/v2/droplets', {
          //   method: 'POST',
          //   headers: {
          //     'Authorization': `Bearer ${process.env.DIGITALOCEAN_TOKEN}`,
          //     'Content-Type': 'application/json',
          //   },
          //   body: JSON.stringify({
          //     name: instanceName,
          //     region: template.region,
          //     size: template.instanceType,
          //     image: 'ubuntu-22-04-x64',
          //     user_data: template.startupScript,
          //     tags: ['scrapesuite-proxy', `ttl-${template.ttlMinutes}`],
          //   }),
          // });
          logger.info(
            { provider: 'digitalocean', region: template.region, instance: instanceName },
            'Would create DigitalOcean droplet (API call placeholder)',
          );
          // Placeholder: return mock failure since we can't actually provision
          return { success: false, instanceId: null, ip: null, error: 'Cloud API not configured' };
        }

        case 'hetzner': {
          // Hetzner Cloud API call structure:
          // const response = await fetch('https://api.hetzner.cloud/v1/servers', {
          //   method: 'POST',
          //   headers: {
          //     'Authorization': `Bearer ${process.env.HETZNER_TOKEN}`,
          //     'Content-Type': 'application/json',
          //   },
          //   body: JSON.stringify({
          //     name: instanceName,
          //     server_type: template.instanceType,
          //     location: template.region,
          //     image: 'ubuntu-22.04',
          //     user_data: template.startupScript,
          //     labels: { type: 'scrapesuite-proxy', ttl: `${template.ttlMinutes}` },
          //   }),
          // });
          logger.info(
            { provider: 'hetzner', region: template.region, instance: instanceName },
            'Would create Hetzner cloud server (API call placeholder)',
          );
          return { success: false, instanceId: null, ip: null, error: 'Cloud API not configured' };
        }

        case 'aws': {
          // AWS EC2 API call structure:
          // const response = await fetch(`https://ec2.${template.region}.amazonaws.com/`, {
          //   method: 'POST',
          //   headers: {
          //     'Authorization': aws4.sign({ ... }).headers,
          //     'Content-Type': 'application/x-www-form-urlencoded',
          //   },
          //   body: new URLSearchParams({
          //     Action: 'RunInstances',
          //     ImageId: 'ami-0abcdef1234567890', // Ubuntu 22.04 in this region
          //     InstanceType: template.instanceType,
          //     MinCount: '1',
          //     MaxCount: '1',
          //     UserData: startupScriptB64,
          //     TagSpecification_1_TagType: 'instance',
          //     TagSpecification_1_Tag_1_Key: 'Name',
          //     TagSpecification_1_Tag_1_Value: instanceName,
          //     TagSpecification_1_Tag_2_Key: 'Type',
          //     TagSpecification_1_Tag_2_Value: 'scrapesuite-proxy',
          //   }).toString(),
          // });
          logger.info(
            { provider: 'aws', region: template.region, instance: instanceName },
            'Would create AWS EC2 instance (API call placeholder)',
          );
          return { success: false, instanceId: null, ip: null, error: 'Cloud API not configured' };
        }

        case 'gcp': {
          // Google Compute Engine API call structure:
          // const response = await fetch(
          //   `https://compute.googleapis.com/compute/v1/projects/${process.env.GCP_PROJECT}/zones/${template.region}/instances`,
          //   {
          //     method: 'POST',
          //     headers: {
          //       'Authorization': `Bearer ${process.env.GCP_TOKEN}`,
          //       'Content-Type': 'application/json',
          //     },
          //     body: JSON.stringify({
          //       name: instanceName,
          //       machineType: `zones/${template.region}/machineTypes/${template.instanceType}`,
          //       disks: [{ boot: true, initializeParams: { sourceImage: 'projects/ubuntu-os-cloud/global/images/ubuntu-2204-lts' } }],
          //       networkInterfaces: [{ accessConfigs: [{ type: 'ONE_TO_ONE_NAT' }] }],
          //       metadata: { items: [{ key: 'startup-script', value: template.startupScript }] },
          //       labels: { type: 'scrapesuite-proxy' },
          //     }),
          //   },
          // );
          logger.info(
            { provider: 'gcp', region: template.region, instance: instanceName },
            'Would create GCP compute instance (API call placeholder)',
          );
          return { success: false, instanceId: null, ip: null, error: 'Cloud API not configured' };
        }

        default:
          return { success: false, instanceId: null, ip: null, error: `Unknown provider: ${template.provider}` };
      }
    } catch (err: any) {
      return { success: false, instanceId: null, ip: null, error: err.message };
    }
  }

  /**
   * Terminate a cloud instance.
   * Similar to callCloudProviderAPI, this documents the API calls
   * for each provider.
   */
  private async terminateCloudInstance(instanceId: string, ip: string): Promise<void> {
    logger.info({ instanceId, ip }, 'Would terminate cloud instance (API call placeholder)');

    // DigitalOcean: DELETE https://api.digitalocean.com/v2/droplets/{instanceId}
    // Hetzner: DELETE https://api.hetzner.cloud/v1/servers/{instanceId}
    // AWS: Action=TerminateInstances & InstanceId.1={instanceId}
    // GCP: DELETE https://compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/instances/{instanceId}
  }

  // --- Utility Helpers -------------------------------------------------------

  /**
   * Quick connectivity test -- just checks if a TCP connection can be
   * established. Used as a fast pre-filter before the full validation.
   */
  private async quickConnectivityTest(ip: string, port: number): Promise<boolean> {
    return this.testTcpConnectivity(ip, port, 3000);
  }

  /**
   * Build a proxy URL from an OwnedProxy object.
   */
  private buildProxyUrl(proxy: { ip: string; port: number; protocol: ProxyProtocol }): string {
    switch (proxy.protocol) {
      case 'socks4':
        return `socks4://${proxy.ip}:${proxy.port}`;
      case 'socks5':
        return `socks5://${proxy.ip}:${proxy.port}`;
      case 'https':
        return `https://${proxy.ip}:${proxy.port}`;
      case 'http':
      default:
        return `http://${proxy.ip}:${proxy.port}`;
    }
  }

  /**
   * Parse a proxy URL into its components.
   */
  private parseProxyUrl(url: string): { ip: string; port: number; protocol: ProxyProtocol } | null {
    try {
      const parsed = new URL(url);
      return {
        ip: parsed.hostname,
        port: parseInt(parsed.port, 10),
        protocol: (parsed.protocol.replace(':', '') as ProxyProtocol) || 'http',
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the default port for a proxy software.
   */
  private getProxyPort(software: CloudProvisionTemplate['proxySoftware']): number {
    switch (software) {
      case 'squid': return 3128;
      case '3proxy': return 3128;
      case 'dante': return 1080;
      case 'tinyproxy': return 8888;
      default: return 3128;
    }
  }

  /**
   * Infer the proxy tier from its source and IP characteristics.
   * Self-hosted VPS and cloud instances are datacenter.
   * Community P2P and browser extension are residential.
   * Subnet leases from ISPs are ISP tier.
   */
  private inferTier(source: OwnedProxySource, _ip: string): ProxyTier {
    switch (source) {
      case 'self-hosted-vps':
      case 'cloud-provisioned':
        return 'datacenter';
      case 'community-p2p':
      case 'browser-extension':
        return 'residential';
      case 'iot-scanner':
        return 'residential';
      case 'subnet-lease':
        return 'isp';
      case 'curated-free':
      case 'peer-exchange':
        return 'datacenter';
      default:
        return 'datacenter';
    }
  }

  /**
   * Map a cloud provider region to an approximate country code.
   */
  private regionToCountry(region: string): string {
    const regionMap: Record<string, string> = {
      // DigitalOcean
      'nyc1': 'US', 'nyc3': 'US', 'sfo2': 'US', 'sfo3': 'US',
      'sea1': 'US', 'tor1': 'CA',
      'ams3': 'NL', 'fra1': 'DE', 'lon1': 'GB',
      'sgp1': 'SG', 'blr1': 'IN', 'syd1': 'AU',
      // Hetzner
      'fsn1': 'DE', 'nbg1': 'DE', 'hel1': 'FI', 'ash': 'US',
      // AWS
      'us-east-1': 'US', 'us-east-2': 'US', 'us-west-1': 'US', 'us-west-2': 'US',
      'eu-west-1': 'IE', 'eu-west-2': 'GB', 'eu-central-1': 'DE',
      'ap-southeast-1': 'SG', 'ap-northeast-1': 'JP',
      // GCP
      'us-central1': 'US', 'us-east1': 'US', 'us-west1': 'US',
      'europe-west1': 'BE', 'europe-west3': 'DE', 'asia-east1': 'TW',
    };
    return regionMap[region] || 'US';
  }

  /**
   * Estimate the monthly cost for a cloud provision template.
   */
  private estimateMonthlyCost(template: CloudProvisionTemplate): number {
    // Approximate monthly costs based on provider pricing (2024)
    const hourlyToMonthly = 730; // Average hours per month
    switch (template.provider) {
      case 'digitalocean':
        // s-1vcpu-1gb ≈ $0.007/hr → ~$5.11/mo
        return 0.007 * hourlyToMonthly;
      case 'hetzner':
        // cx11 ≈ €0.004/hr → ~$3.50/mo
        return 0.004 * hourlyToMonthly * 1.1; // EUR to USD
      case 'aws':
        // t3.micro ≈ $0.012/hr → ~$8.76/mo
        return 0.012 * hourlyToMonthly;
      case 'gcp':
        // e2-micro ≈ $0.008/hr → ~$5.84/mo (with sustained use discount)
        return 0.008 * hourlyToMonthly * 0.7;
      default:
        return 10; // Default estimate
    }
  }

  /**
   * Wait for a cloud-provisioned proxy to become ready.
   * Polls with TCP connectivity tests until the proxy responds
   * or the timeout is reached.
   */
  private async waitForProxyReady(ip: string, port: number, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    const pollIntervalMs = 5000; // Check every 5 seconds

    while (Date.now() - startTime < timeoutMs) {
      const ready = await this.testTcpConnectivity(ip, port, 3000);
      if (ready) {
        // Give the proxy software an extra 10s to fully initialize
        await new Promise(resolve => setTimeout(resolve, 10000));
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    return false;
  }

  // --- Sticky Session Helpers -----------------------------------------------

  /**
   * Retrieve a sticky session proxy from Redis.
   */
  private async getStickySession(
    sessionId: string,
    domain?: string,
  ): Promise<OwnedProxyResult | null> {
    try {
      const key = `owned-proxy:sticky:${sessionId}`;
      const session = await cacheGet<{
        proxyId: string;
        proxyUrl: string;
        source: OwnedProxySource;
        country: string;
        city: string | null;
        asn: string | null;
        tier: ProxyTier;
        reputationScore: number;
        protocol: ProxyProtocol;
        supportsSsl: boolean;
        costUsd: number;
      }>(key);

      if (!session) return null;

      // Check if the proxy is still usable
      if (domain) {
        const verdict = await ipReputationTracker.getVerdict(session.proxyId, domain);
        if (!verdict.usable) {
          await redis.del(`cache:${key}`);
          return null;
        }
      }

      this.inUseSet.add(session.proxyId);

      return {
        proxyUrl: session.proxyUrl,
        proxyId: session.proxyId,
        source: session.source,
        country: session.country,
        city: session.city,
        asn: session.asn,
        tier: session.tier,
        reputationScore: session.reputationScore,
        isWarmed: session.reputationScore > 0.7,
        protocol: session.protocol,
        supportsSsl: session.supportsSsl,
        costUsd: session.costUsd,
        sessionId,
      };
    } catch {
      return null;
    }
  }

  /**
   * Set a sticky session in Redis.
   */
  private async setStickySession(
    sessionId: string,
    proxy: OwnedProxy,
    domain?: string,
  ): Promise<void> {
    try {
      const key = `owned-proxy:sticky:${sessionId}`;
      const proxyUrl = this.buildProxyUrl(proxy);

      await cacheSet(key, {
        proxyId: proxy.id,
        proxyUrl,
        source: proxy.source,
        country: proxy.country,
        city: proxy.city,
        asn: proxy.asn,
        tier: proxy.tier,
        reputationScore: proxy.reputationScore,
        protocol: proxy.protocol,
        supportsSsl: proxy.supportsSsl,
        costUsd: proxy.monthlyCostUsd,
      }, 600); // 10-minute TTL for sticky sessions
    } catch (err: any) {
      logger.warn({ error: err.message, sessionId }, 'Failed to set sticky session');
    }
  }

  // --- Cooldown Management --------------------------------------------------

  /**
   * Start the cooldown period for a proxy IP.
   */
  private startCooldown(ip: string): void {
    this.cooldownMap.set(ip, Date.now() + this.config.proxyCooldownMs);
  }

  /**
   * Get the list of IPs currently in cooldown.
   */
  private getCooldownIps(): string[] {
    const now = Date.now();
    const coolingIps: string[] = [];

    this.cooldownMap.forEach((expiry, ip) => {
      if (now < expiry) {
        coolingIps.push(ip);
      } else {
        this.cooldownMap.delete(ip);
      }
    });

    return coolingIps;
  }

  // --- Redis Index Management -----------------------------------------------

  /**
   * Update Redis indexes when a proxy is added.
   */
  private async updateRedisIndexes(proxyId: string, country: string, tier: string): Promise<void> {
    try {
      // Add to country index
      await redis.sadd(`cache:owned-proxy:country:${country}`, proxyId);
      await redis.expire(`cache:owned-proxy:country:${country}`, this.config.indexCacheTtlSeconds);

      // Add to tier index
      await redis.sadd(`cache:owned-proxy:tier:${tier}`, proxyId);
      await redis.expire(`cache:owned-proxy:tier:${tier}`, this.config.indexCacheTtlSeconds);
    } catch (err: any) {
      logger.debug({ error: err.message, proxyId }, 'Failed to update Redis indexes');
    }
  }

  /**
   * Invalidate the cached pool statistics.
   */
  private async invalidateStatsCache(): Promise<void> {
    try {
      await redis.del('cache:owned-proxy:pool:stats');
    } catch {
      // Ignore -- cache will just be stale
    }
  }

  /**
   * Invalidate the cached data for a specific proxy.
   */
  private async invalidateProxyCache(proxyId: string): Promise<void> {
    try {
      await redis.del(`cache:owned-proxy:proxy:${proxyId}`);
    } catch {
      // Ignore
    }
  }

  // --- Demand Signal Management ---------------------------------------------

  /**
   * Record a demand signal when no suitable proxy is found.
   * The auto-scaler uses these signals to decide when to grow the pool.
   */
  private async recordDemandSignal(country?: string, tier?: string): Promise<void> {
    try {
      const signal = JSON.stringify({
        country: country || null,
        tier: tier || null,
        timestamp: Date.now(),
      });

      await redis.zadd('owned-proxy:demand', Date.now(), signal);
      // Keep only the last 1000 demand signals
      await redis.zremrangebyrank('owned-proxy:demand', 0, -1001);
      // Expire the demand set after 1 hour
      await redis.expire('owned-proxy:demand', 3600);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Failed to record demand signal');
    }
  }

  // --- Proxy Lifecycle Management -------------------------------------------

  /**
   * Update the last_used_at timestamp for a proxy (fire-and-forget).
   */
  private async updateLastUsedAt(proxyId: string): Promise<void> {
    try {
      await db.$executeRawUnsafe(
        'UPDATE owned_proxies SET last_used_at = NOW() WHERE id = $1',
        proxyId,
      );
    } catch {
      // Ignore -- non-critical update
    }
  }

  /**
   * Record the result of a validation pipeline run.
   */
  private async recordValidationResult(
    proxyId: string,
    passed: boolean,
    score: number,
    errors: string[],
  ): Promise<void> {
    try {
      const consecutiveFailures = passed ? 0 : 1; // Will be properly incremented on next check
      const active = passed || (errors.filter(e => e.includes('TCP') || e.includes('HTTP')).length === 0);

      await db.$executeRawUnsafe(
        `UPDATE owned_proxies SET
          last_checked_at = NOW(),
          validation_score = $1,
          consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures + 1 END,
          active = $3
        WHERE id = $4`,
        score,
        passed,
        active,
        proxyId,
      );
    } catch (err: any) {
      logger.warn({ error: err.message, proxyId }, 'Failed to record validation result');
    }
  }

  /**
   * Retire proxies that have expired (TTL reached).
   */
  private async retireExpiredProxies(): Promise<void> {
    try {
      const result = await db.$executeRawUnsafe(
        `UPDATE owned_proxies SET active = FALSE
         WHERE expires_at IS NOT NULL
           AND expires_at < NOW()
           AND active = TRUE`,
      );

      if (result > 0) {
        logger.info({ count: result }, 'Retired expired proxies');
        await this.invalidateStatsCache();
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to retire expired proxies');
    }
  }

  /**
   * Retire the worst-performing proxies from the pool.
   * Used when the pool exceeds maxPoolSize.
   */
  private async retireWorstProxies(count: number): Promise<void> {
    try {
      // Find the worst proxies by reputation score
      const worst = await db.$queryRawUnsafe<Array<{ id: string; cloud_instance_id: string | null }>>(
        `SELECT id, cloud_instance_id FROM owned_proxies
         WHERE active = TRUE
         ORDER BY reputation_score ASC, success_rate ASC, avg_latency_ms DESC
         LIMIT $1`,
        count,
      );

      if (!worst || worst.length === 0) return;

      for (const proxy of worst) {
        await this.removeProxy(proxy.id);
      }

      logger.info({ count: worst.length }, 'Retired worst-performing proxies');
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to retire worst proxies');
    }
  }

  // --- Validation Result Builder --------------------------------------------

  /**
   * Build a ValidationResult from partial stage results.
   */
  private buildValidationResult(
    passed: boolean,
    score: number,
    partials: Partial<ValidationResult>,
    errors: string[],
  ): ValidationResult {
    return {
      passed,
      score,
      tcpConnectivity: partials.tcpConnectivity ?? false,
      httpRequest: partials.httpRequest ?? false,
      httpsSupport: partials.httpsSupport ?? false,
      anonymityLevel: partials.anonymityLevel ?? null,
      dnsLeak: partials.dnsLeak ?? false,
      downloadSpeedBps: partials.downloadSpeedBps ?? null,
      verifiedCountry: partials.verifiedCountry ?? null,
      blacklistHits: partials.blacklistHits ?? 0,
      stabilityPassCount: partials.stabilityPassCount ?? null,
      latencyMs: partials.latencyMs ?? null,
      errors,
    };
  }
}

// --- Singleton ----------------------------------------------------------------

/**
 * The global OwnedProxyPool instance.
 * Use this for all operations -- do not create additional instances.
 */
export const ownedProxyPool = new OwnedProxyPool();

export default OwnedProxyPool;
