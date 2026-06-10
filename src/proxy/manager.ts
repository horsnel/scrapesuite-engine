// ===============================================================================
// PROXY MANAGER -- The Ultimate Proxy Orchestration Engine
// ===============================================================================
// Central orchestrator that ties ALL proxy modules together into a unified API.
// Supports: smart selection, auto-failover, CAPTCHA-aware routing, Web Unlocker,
// fusion reactor management, domain intelligence, cost optimization, and more.
// ===============================================================================

import { db } from '../utils/db';
import { redis, cacheGet, cacheSet } from '../utils/redis';
import { createChildLogger } from '../utils/logger';
import { testProxy } from '../utils/proxy-fetch';

// --- Core Module Imports ------------------------------------------------------
import { residentialProxyManager, type ProxyProvider, type ProxyResult } from './residential-providers';
import { smartIPPool, type IPPoolResult } from './ip-pool';
import { ipReputationTracker, type ReputationVerdict } from './reputation';
import { proxyAggregator } from './aggregator';
import { megaPool, type MegaPoolResult } from './mega-pool';
import type { ProxyInfo, ProxyOutcome } from '../types';

const logger = createChildLogger('proxy-manager');

// --- Constants ----------------------------------------------------------------

const PROXY_CACHE_TTL = 10;              // Reduced from 60s to 10s for faster cache refresh
const MAX_CONSECUTIVE_FAILURES = 5;
const RETIRE_THRESHOLD = 0.2;
const HEALTH_CHECK_INTERVAL = 5_000;      // 5s health check interval (was 300s)
const DOMAIN_INTEL_TTL = 600_000;         // 10 minutes for domain intelligence
const STICKY_SESSION_TTL = 600_000;       // 10 minutes for sticky sessions
const STATS_AGGREGATION_INTERVAL = 10_000; // 10s stats aggregation
const ADAPTIVE_STRATEGY_INTERVAL = 10_000; // 10s adaptive strategy check
const COST_OPTIMIZATION_INTERVAL = 10_000; // 10s cost optimization cycle
const MODULE_HEALTH_CHECK_INTERVAL = 5_000; // 5s module health ping
const DOMAIN_INTELLIGENCE_SAMPLE_SIZE = 100;
const MAX_FAILBACK_ATTEMPTS = 3;
const CAPTCHA_DETECTION_PATTERNS = [
  'recaptcha', 'g-recaptcha', 'hcaptcha', 'h-captcha',
  'cf-turnstile', 'captcha', 'funcaptcha', 'arkose',
  'challenge-platform', 'px-captcha', 'geetest',
];
const ANTIBOT_DETECTION_PATTERNS = [
  'cloudflare', 'akamai', 'perimeterx', 'kasada',
  'datadome', 'shape', 'f5', 'imperva', 'distil',
  'incapsula', 'silverline', 'bot-manager',
];
const STEALTH_DOMAINS = new Set([
  'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.co.jp',
  'ticketmaster.com', 'livenation.com', 'axs.com',
  'nike.com', 'adidas.com', 'footlocker.com',
  'zillow.com', 'redfin.com', 'realtor.com',
  'linkedin.com', 'indeed.com', 'glassdoor.com',
  'yelp.com', 'tripadvisor.com', 'airbnb.com',
]);

// --- Rotation Strategies -----------------------------------------------------

export type RotationStrategy =
  | 'round-robin'
  | 'random'
  | 'least-failures'
  | 'fastest'
  | 'sticky'
  | 'weighted-random'
  | 'adaptive'
  | 'cost-optimized'
  | 'reputation-weighted'
  | 'domain-intelligent';

// --- Tier Types ---------------------------------------------------------------

export type ProxyTier = 'residential' | 'mobile' | 'datacenter' | 'isp';

// --- Proxy Selection ---------------------------------------------------------

export interface ProxySelection {
  proxyUrl: string;
  proxyId: string;
  country: string;
  tier: string;
  city?: string;
  asn?: string;
}

// --- Domain Intelligence -----------------------------------------------------

interface DomainIntelligenceEntry {
  domain: string;
  bestProxyIds: string[];            // Top N proxy IDs that work for this domain
  worstProxyIds: string[];           // Proxy IDs that have failed for this domain
  requiresStealth: boolean;          // Domain needs stealth/anti-bot bypass
  requiresCaptcha: boolean;          // Domain typically requires CAPTCHA solving
  preferredTier: ProxyTier;          // Which tier works best for this domain
  preferredCountry: string;          // Which country proxy works best
  averageLatency: number;            // Average latency for this domain
  successRate: number;               // Overall success rate for this domain
  captchaFrequency: number;          // 0-1 how often CAPTCHA is encountered
  antibotFrequency: number;          // 0-1 how often anti-bot is encountered
  costPerRequest: number;            // Average cost per successful request
  lastUpdated: number;               // Timestamp of last update
  requestCount: number;              // Total requests made to this domain
  failoverChain: ProxyTier[];        // Preferred failover tier chain
}

// --- Adaptive Strategy State -------------------------------------------------

interface AdaptiveStrategyState {
  domain: string;
  currentStrategy: RotationStrategy;
  previousStrategies: Array<{ strategy: RotationStrategy; successRate: number; timestamp: number }>;
  lastRotation: number;
  rotationCount: number;
  performanceWindow: Array<{ timestamp: number; success: boolean; latency: number }>;
  optimalStrategy: RotationStrategy | null;
}

// --- Cost Optimization State -------------------------------------------------

interface CostOptimizationState {
  domain: string;
  costHistory: Array<{ timestamp: number; cost: number; success: boolean; source: string }>;
  cheapestSource: string | null;
  costEfficiencyScore: number;       // Success rate per dollar
  recommendedTier: ProxyTier | null;
  recommendedSource: string | null;
  lastOptimized: number;
}

// --- Module Health State -----------------------------------------------------

interface ModuleHealthState {
  moduleName: string;
  available: boolean;
  lastCheck: number;
  consecutiveFailures: number;
  latencyMs: number;
  errorCount: number;
  lastError: string | null;
}

// --- Unified Pool Statistics -------------------------------------------------

export interface UnifiedPoolStats {
  // Legacy pool stats
  legacy: {
    total: number;
    active: number;
    retired: number;
    byTier: Record<string, number>;
    byCountry: Record<string, number>;
    byProvider: Record<string, number>;
    avgSuccessRate: number;
    avgP95Latency: number;
    geoCoverage: { countries: number; cities: number; asns: number };
  } | null;
  // Smart IP Pool stats
  smartPool: any;
  // Aggregator composition
  aggregator: any;
  // Mega pool stats (fusion system)
  megaPool: any;
  // Reputation system state
  reputation: { decayRunning: boolean; stats: any };
  // Fusion core status
  fusion: any;
  // Chain reaction stats
  chainReaction: any;
  // Breeder reactor stats
  breederReactor: any;
  // Quantum tunnel stats
  quantumTunnel: any;
  // Plasma state stats
  plasmaState: any;
  // Containment shield stats
  containment: any;
  // Validation pipeline stats
  validationPipeline: any;
  // Rotating session factory stats
  rotatingSessionFactory: any;
  // Free proxy discovery stats
  freeProxyDiscovery: any;
  // Tor pool stats
  torPool: any;
  // Bulk session stats
  bulkSessions: any;
  // Subnet expander stats
  subnetExpander: any;
  // CAPTCHA solver stats
  captchaSolver: any;
  // Web Unlocker stats
  webUnlocker: any;
  // CDP Injection Engine stats
  cdpInjection: any;
  // Deep Browser Patcher stats
  deepPatcher: any;
  // Mobile Proxy Engine stats
  mobileProxy: any;
  // Geo Expander stats
  geoExpander: any;
  // DNS Shield stats
  dnsShield: any;
  // Stealth Browser Engine stats
  stealthBrowser: any;
  // Request Pacer stats
  requestPacer: any;
  // Structured Extractor stats
  structuredExtractor: any;
  // Anti-Bot Monitor stats
  antiBotMonitor: any;
  // Fingerprint Calibrator stats
  fingerprintCalibrator: any;
  // Kasada Challenger stats
  kasadaChallenger: any;
  // Kasada SW Proxy stats
  kasadaSWProxy: any;
  // Kasada Behavior stats
  kasadaBehavior: any;
  // Kasada Fingerprint stats
  kasadaFingerprint: any;
  // Residential providers stats
  residentialProviders: any;
  // Domain intelligence summary
  domainIntelligence: {
    trackedDomains: number;
    stealthDomains: number;
    captchaDomains: number;
    avgSuccessRate: number;
  };
  // Module health summary
  moduleHealth: {
    totalModules: number;
    healthyModules: number;
    degradedModules: number;
    offlineModules: number;
    modules: Array<{ name: string; status: 'healthy' | 'degraded' | 'offline' }>;
  };
  // Cost optimization summary
  costOptimization: {
    totalCostSaved: number;
    optimizedDomains: number;
    avgCostEfficiency: number;
  };
  // Timestamp
  collectedAt: number;
}

// --- CAPTCHA Detection Result ------------------------------------------------

interface CaptchaDetectionResult {
  detected: boolean;
  type: string | null;
  confidence: number;
}

// --- Anti-Bot Detection Result -----------------------------------------------

interface AntibotDetectionResult {
  detected: boolean;
  system: string | null;
  confidence: number;
}

// ===============================================================================
// PROXY MANAGER -- The Ultimate Proxy Orchestration Engine
// ===============================================================================

export class ProxyManager {

  // --- Core State ----------------------------------------------------------

  private roundRobinIndex = new Map<string, number>();
  private stickySessions = new Map<string, { proxyId: string; expires: number }>();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private domainProxyMap = new Map<string, string>();

  // --- Domain Intelligence -------------------------------------------------

  private domainIntelligence = new Map<string, DomainIntelligenceEntry>();

  // --- Adaptive Strategy ---------------------------------------------------

  private adaptiveStrategies = new Map<string, AdaptiveStrategyState>();
  private adaptiveStrategyTimer: ReturnType<typeof setInterval> | null = null;

  // --- Cost Optimization ---------------------------------------------------

  private costOptimizationStates = new Map<string, CostOptimizationState>();
  private costOptimizationTimer: ReturnType<typeof setInterval> | null = null;

  // --- Module Health Tracking ----------------------------------------------

  private moduleHealth = new Map<string, ModuleHealthState>();
  private moduleHealthTimer: ReturnType<typeof setInterval> | null = null;

  // --- Stats Aggregation ---------------------------------------------------

  private statsAggregationTimer: ReturnType<typeof setInterval> | null = null;
  private lastAggregatedStats: UnifiedPoolStats | null = null;

  // --- Lazy Module References ----------------------------------------------

  private _fusionCore: any = null;
  private _chainReaction: any = null;
  private _breederReactor: any = null;
  private _quantumTunnel: any = null;
  private _plasmaState: any = null;
  private _containmentShield: any = null;
  private _validationPipeline: any = null;
  private _rotatingSessionFactory: any = null;
  private _freeProxyDiscovery: any = null;
  private _torPool: any = null;
  private _bulkSessionManager: any = null;
  private _subnetExpander: any = null;
  private _captchaSolver: any = null;
  private _webUnlocker: any = null;
  private _cdpInjection: any = null;
  private _deepPatcher: any = null;
  private _mobileProxy: any = null;
  private _geoExpander: any = null;
  private _dnsShield: any = null;
  private _stealthBrowser: any = null;
  private _requestPacer: any = null;
  private _structuredExtractor: any = null;
  private _antiBotMonitor: any = null;
  private _fingerprintCalibrator: any = null;
  private _kasadaChallenger: any = null;
  private _kasadaSWProxy: any = null;
  private _kasadaBehavior: any = null;
  private _kasadaFingerprint: any = null;

  // --- Lifecycle State -----------------------------------------------------

  private started = false;
  private shutdownRequested = false;

  // ===========================================================================
  // LAZY MODULE LOADERS
  // ===========================================================================

  private async getFusionCore(): Promise<any> {
    if (!this._fusionCore) {
      try {
        const mod = await import('./fusion-core');
        this._fusionCore = mod.fusionCore;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Fusion core module not available');
        return null;
      }
    }
    return this._fusionCore;
  }

  private async getChainReaction(): Promise<any> {
    if (!this._chainReaction) {
      try {
        const mod = await import('./chain-reaction');
        this._chainReaction = mod.chainReaction;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Chain reaction module not available');
        return null;
      }
    }
    return this._chainReaction;
  }

  private async getBreederReactor(): Promise<any> {
    if (!this._breederReactor) {
      try {
        const mod = await import('./breeder-reactor');
        this._breederReactor = mod.breederReactor;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Breeder reactor module not available');
        return null;
      }
    }
    return this._breederReactor;
  }

  private async getQuantumTunnel(): Promise<any> {
    if (!this._quantumTunnel) {
      try {
        const mod = await import('./quantum-tunnel');
        this._quantumTunnel = mod.quantumTunnel;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Quantum tunnel module not available');
        return null;
      }
    }
    return this._quantumTunnel;
  }

  private async getPlasmaState(): Promise<any> {
    if (!this._plasmaState) {
      try {
        const mod = await import('./plasma-state');
        this._plasmaState = mod.plasmaState;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Plasma state module not available');
        return null;
      }
    }
    return this._plasmaState;
  }

  private async getContainmentShield(): Promise<any> {
    if (!this._containmentShield) {
      try {
        const mod = await import('./containment');
        this._containmentShield = mod.containmentShield;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Containment shield module not available');
        return null;
      }
    }
    return this._containmentShield;
  }

  private async getValidationPipeline(): Promise<any> {
    if (!this._validationPipeline) {
      try {
        const mod = await import('./validation-pipeline');
        this._validationPipeline = mod.validationPipeline;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Validation pipeline module not available');
        return null;
      }
    }
    return this._validationPipeline;
  }

  private async getRotatingSessionFactory(): Promise<any> {
    if (!this._rotatingSessionFactory) {
      try {
        const mod = await import('./rotating-session-factory');
        this._rotatingSessionFactory = mod.rotatingSessionFactory;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Rotating session factory module not available');
        return null;
      }
    }
    return this._rotatingSessionFactory;
  }

  private async getFreeProxyDiscovery(): Promise<any> {
    if (!this._freeProxyDiscovery) {
      try {
        const mod = await import('./free-proxy-discovery');
        this._freeProxyDiscovery = mod.freeProxyDiscovery;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Free proxy discovery module not available');
        return null;
      }
    }
    return this._freeProxyDiscovery;
  }

  private async getTorPool(): Promise<any> {
    if (!this._torPool) {
      try {
        const mod = await import('./tor-pool');
        this._torPool = mod.torPool;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Tor pool module not available');
        return null;
      }
    }
    return this._torPool;
  }

  private async getBulkSessionManager(): Promise<any> {
    if (!this._bulkSessionManager) {
      try {
        const mod = await import('./bulk-sessions');
        this._bulkSessionManager = mod.bulkSessionManager;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Bulk session manager module not available');
        return null;
      }
    }
    return this._bulkSessionManager;
  }

  private async getSubnetExpander(): Promise<any> {
    if (!this._subnetExpander) {
      try {
        const mod = await import('./subnet-expander');
        this._subnetExpander = mod.subnetExpander;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Subnet expander module not available');
        return null;
      }
    }
    return this._subnetExpander;
  }

  private async getCaptchaSolver(): Promise<any> {
    if (!this._captchaSolver) {
      try {
        const mod = await import('./captcha-solver');
        this._captchaSolver = mod.captchaSolver;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'CAPTCHA solver module not available');
        return null;
      }
    }
    return this._captchaSolver;
  }

  private async getWebUnlocker(): Promise<any> {
    if (!this._webUnlocker) {
      try {
        const mod = await import('./web-unlocker');
        this._webUnlocker = mod.webUnlocker;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Web Unlocker module not available');
        return null;
      }
    }
    return this._webUnlocker;
  }

  private async getCdpInjection(): Promise<any> {
    if (!this._cdpInjection) {
      try {
        const mod = await import('../anti-bot/cdp-injection');
        this._cdpInjection = mod.cdpInjectionEngine;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'CDP Injection module not available');
        return null;
      }
    }
    return this._cdpInjection;
  }

  private async getDeepPatcher(): Promise<any> {
    if (!this._deepPatcher) {
      try {
        const mod = await import('../anti-bot/deep-patcher');
        this._deepPatcher = mod.deepBrowserPatcher;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Deep Patcher module not available');
        return null;
      }
    }
    return this._deepPatcher;
  }

  private async getMobileProxy(): Promise<any> {
    if (!this._mobileProxy) {
      try {
        const mod = await import('./mobile-proxy');
        this._mobileProxy = mod.mobileProxyEngine;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Mobile Proxy module not available');
        return null;
      }
    }
    return this._mobileProxy;
  }

  private async getGeoExpander(): Promise<any> {
    if (!this._geoExpander) {
      try {
        const mod = await import('./geo-expander');
        this._geoExpander = mod.geoExpander;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Geo Expander module not available');
        return null;
      }
    }
    return this._geoExpander;
  }

  private async getDnsShield(): Promise<any> {
    if (!this._dnsShield) {
      try {
        const mod = await import('./dns-shield');
        this._dnsShield = mod.dnsShield;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'DNS Shield module not available');
        return null;
      }
    }
    return this._dnsShield;
  }

  private async getStealthBrowser(): Promise<any> {
    if (!this._stealthBrowser) {
      try {
        const mod = await import('../anti-bot/stealth-browser');
        this._stealthBrowser = mod.stealthBrowserEngine;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Stealth Browser module not available');
        return null;
      }
    }
    return this._stealthBrowser;
  }

  private async getRequestPacer(): Promise<any> {
    if (!this._requestPacer) {
      try {
        const mod = await import('../anti-bot/request-pacer');
        this._requestPacer = mod.requestPacer;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Request Pacer module not available');
        return null;
      }
    }
    return this._requestPacer;
  }

  private async getStructuredExtractor(): Promise<any> {
    if (!this._structuredExtractor) {
      try {
        const mod = await import('../extractor/structured-extractor');
        this._structuredExtractor = mod.structuredExtractor;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Structured Extractor module not available');
        return null;
      }
    }
    return this._structuredExtractor;
  }

  private async getAntiBotMonitor(): Promise<any> {
    if (!this._antiBotMonitor) {
      try {
        const mod = await import('../intelligence/anti-bot-monitor');
        this._antiBotMonitor = mod.antiBotMonitor;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Anti-Bot Monitor module not available');
        return null;
      }
    }
    return this._antiBotMonitor;
  }

  private async getFingerprintCalibrator(): Promise<any> {
    if (!this._fingerprintCalibrator) {
      try {
        const mod = await import('../intelligence/fingerprint-calibrator');
        this._fingerprintCalibrator = mod.fingerprintCalibrator;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Fingerprint Calibrator module not available');
        return null;
      }
    }
    return this._fingerprintCalibrator;
  }

  private async getKasadaChallenger(): Promise<any> {
    if (!this._kasadaChallenger) {
      try {
        const mod = await import('../anti-bot/kasada-challenger');
        this._kasadaChallenger = mod.kasadaChallenger;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Kasada Challenger module not available');
        return null;
      }
    }
    return this._kasadaChallenger;
  }

  private async getKasadaSWProxy(): Promise<any> {
    if (!this._kasadaSWProxy) {
      try {
        const mod = await import('../anti-bot/kasada-sw-proxy');
        this._kasadaSWProxy = mod.kasadaSWProxy;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Kasada SW Proxy module not available');
        return null;
      }
    }
    return this._kasadaSWProxy;
  }

  private async getKasadaBehavior(): Promise<any> {
    if (!this._kasadaBehavior) {
      try {
        const mod = await import('../anti-bot/kasada-behavior');
        this._kasadaBehavior = mod.kasadaBehavior;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Kasada Behavior module not available');
        return null;
      }
    }
    return this._kasadaBehavior;
  }

  private async getKasadaFingerprint(): Promise<any> {
    if (!this._kasadaFingerprint) {
      try {
        const mod = await import('../anti-bot/kasada-fingerprint');
        this._kasadaFingerprint = mod.kasadaFingerprint;
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Kasada Fingerprint module not available');
        return null;
      }
    }
    return this._kasadaFingerprint;
  }

  // ===========================================================================
  // PUBLIC API -- CORE PROXY SELECTION
  // ===========================================================================

  /**
   * Get the best proxy for a given domain and tier.
   * Supports: ASN targeting, city-level targeting, sticky sessions,
   * weighted random, domain-optimized selection, adaptive strategy,
   * cost optimization, and reputation-weighted selection.
   *
   * This is the BACKWARD-COMPATIBLE entry point.
   */
  async getProxy(
    domain: string,
    tier: ProxyTier = 'residential',
    country?: string,
    strategy: RotationStrategy = 'least-failures',
    options?: {
      city?: string;
      asn?: string;
      sessionId?: string;
      requireStealth?: boolean;
      maxCostPerGb?: number;
      preferredProvider?: ProxyProvider;
    },
  ): Promise<ProxySelection | null> {
    try {
      // -- Step 1: Check sticky session by ID ------------------------------
      if (options?.sessionId) {
        const stickyResult = await this.checkStickySession(
          options.sessionId, tier, domain,
        );
        if (stickyResult) return stickyResult;
      }

      // -- Step 2: Check domain-optimized proxy ----------------------------
      if (!options?.sessionId) {
        const domainResult = await this.checkDomainOptimizedProxy(domain, tier);
        if (domainResult) return domainResult;
      }

      // -- Step 3: Check domain intelligence for adaptive selection --------
      const intel = this.getDomainIntelligence(domain);
      const effectiveStrategy = this.resolveStrategy(domain, strategy, intel);

      // -- Step 4: Determine if stealth or CAPTCHA routing is needed -------
      const needsStealth = options?.requireStealth || intel?.requiresStealth || this.isStealthDomain(domain);
      const needsCaptcha = intel?.requiresCaptcha || false;

      // -- Step 5: Get available proxies with advanced filtering -----------
      const effectiveTier = intel?.preferredTier || tier;
      const effectiveCountry = intel?.preferredCountry || country;

      const proxies = await this.getAvailableProxies(
        effectiveTier, effectiveCountry, options?.city, options?.asn,
      );

      // -- Step 6: If stealth required, prefer residential/mobile ----------
      if (needsStealth && proxies.length > 0) {
        const stealthProxies = proxies.filter(
          (p: any) => p.tier === 'residential' || p.tier === 'mobile' || p.tier === 'isp',
        );
        if (stealthProxies.length > 0) {
          const selected = this.selectProxy(stealthProxies, domain, effectiveStrategy);
          if (selected) {
            await this.finalizeProxySelection(selected, domain, options);
            return this.toSelection(selected);
          }
        }
      }

      // -- Step 7: If no internal proxies, try external sources ------------
      if (proxies.length === 0) {
        logger.warn(
          { tier: effectiveTier, country: effectiveCountry, domain, city: options?.city, asn: options?.asn },
          'No available proxies for criteria -- trying external sources',
        );

        // Try multiple external sources in parallel
        const externalResult = await this.tryExternalSourcesWithFailover(
          effectiveTier, effectiveCountry, options?.city, options?.asn, domain,
        );
        if (externalResult) return externalResult;
      }

      // -- Step 8: Select proxy based on resolved strategy -----------------
      const selected = this.selectProxy(proxies, domain, effectiveStrategy);
      if (!selected) return null;

      // -- Step 9: Finalize selection --------------------------------------
      await this.finalizeProxySelection(selected, domain, options);

      return this.toSelection(selected);
    } catch (err: any) {
      logger.error(
        { domain, tier, country, strategy, error: err.message },
        'Proxy selection failed -- degrading gracefully',
      );

      // Emergency fallback: try to get any proxy at all
      return this.emergencyFallback(domain, tier, country);
    }
  }

  /**
   * Get a proxy using the Smart IP Pool Manager (recommended for v3.1+).
   * Uses the unified mega-pool with reputation tracking, IP cooling,
   * auto-scaling, and multi-provider aggregation.
   * Falls back to legacy getProxy() if the smart pool fails.
   */
  async getSmartProxy(
    domain: string,
    tier: ProxyTier = 'residential',
    country?: string,
    options?: {
      city?: string;
      asn?: string;
      sessionId?: string;
      requireReputation?: boolean;
      maxCostPerGb?: number;
      preferProvider?: boolean;
      preferredProvider?: ProxyProvider;
    },
  ): Promise<(ProxySelection & { source?: string; reputationScore?: number; costPerGb?: number }) | null> {
    try {
      // -- Try Smart IP Pool first ---------------------------------------
      const poolResult = await smartIPPool.getProxy({
        domain,
        tier,
        country,
        city: options?.city,
        asn: options?.asn,
        sessionId: options?.sessionId,
        requireReputation: options?.requireReputation,
        maxCostPerGb: options?.maxCostPerGb,
      });

      if (poolResult) {
        this.updateDomainIntelligenceFromResult(domain, poolResult);
        return {
          proxyUrl: poolResult.proxyUrl,
          proxyId: poolResult.proxyId,
          country: poolResult.country,
          tier: poolResult.tier,
          city: poolResult.city,
          asn: poolResult.asn,
          source: poolResult.source,
          reputationScore: poolResult.reputationScore,
          costPerGb: poolResult.costPerGb,
        };
      }

      // -- Try aggregator for cost-optimized multi-provider selection -----
      const aggResult = await proxyAggregator.getProxy({
        domain,
        tier,
        country,
        city: options?.city,
        asn: options?.asn,
        sessionId: options?.sessionId,
        maxCostPerGb: options?.maxCostPerGb,
        preferredProvider: options?.preferredProvider,
        preferProvider: options?.preferProvider,
      });

      if (aggResult) {
        this.updateDomainIntelligenceFromAggregator(domain, aggResult);
        return {
          proxyUrl: aggResult.proxyUrl,
          proxyId: aggResult.proxyId,
          country: aggResult.country,
          tier: aggResult.tier,
          city: aggResult.city,
          asn: aggResult.asn,
          source: aggResult.provider,
        };
      }
    } catch (err: any) {
      logger.warn({ domain, tier, error: err.message }, 'Smart IP pool selection failed -- falling back to legacy');
    }

    // -- Final fallback: legacy getProxy() --------------------------------
    const legacyResult = await this.getProxy(domain, tier, country, 'least-failures', {
      city: options?.city,
      asn: options?.asn,
      sessionId: options?.sessionId,
    });

    if (legacyResult) {
      return { ...legacyResult, source: 'legacy' };
    }

    return null;
  }

  /**
   * Get a proxy from the Nuclear Fusion mega pool.
   * Highest-level proxy selection that uses ALL sources including
   * chain reactions, breeding, quantum tunneling, and plasma state.
   * Automatically falls back through: mega-pool → smart-proxy → legacy.
   */
  async getFusionProxy(
    domain: string,
    tier: ProxyTier = 'residential',
    country?: string,
    options?: {
      city?: string;
      asn?: string;
      sessionId?: string;
      stealthLevel?: 'light' | 'medium' | 'maximum';
      captchaAware?: boolean;
    },
  ): Promise<(ProxySelection & { source?: string; fusionPowered?: boolean }) | null> {
    try {
      // -- Check domain intelligence for fusion-specific routing ----------
      const intel = this.getDomainIntelligence(domain);
      const needsCaptcha = options?.captchaAware !== false &&
        (intel?.requiresCaptcha || this.detectCaptchaNeed(domain).detected);
      const needsStealth = intel?.requiresStealth ||
        this.isStealthDomain(domain) ||
        options?.stealthLevel === 'maximum';

      // -- Try mega pool (fusion-powered) --------------------------------
      const result = await megaPool.getProxy({
        domain,
        tier,
        country,
        city: options?.city,
        asn: options?.asn,
        sessionId: options?.sessionId,
      });

      if (result) {
        this.updateDomainIntelligenceFromMegaPool(domain, result);

        // -- If CAPTCHA detected, pre-warm CAPTCHA solver ---------------
        if (needsCaptcha) {
          this.prewarmCaptchaSolver(domain).catch(() => {});
        }

        return {
          proxyUrl: result.proxyUrl,
          proxyId: result.proxyId,
          country: result.country,
          tier: result.tier,
          city: result.city,
          asn: result.asn,
          source: result.source,
          fusionPowered: true,
        };
      }
    } catch (err: any) {
      logger.warn({ domain, tier, error: err.message }, 'Fusion proxy selection failed -- falling back to smart proxy');
    }

    // -- Fallback to smart proxy ------------------------------------------
    const smartResult = await this.getSmartProxy(domain, tier, country, {
      city: options?.city,
      asn: options?.asn,
      sessionId: options?.sessionId,
    });

    if (smartResult) {
      return { ...smartResult, fusionPowered: false };
    }

    return null;
  }

  /**
   * The ULTIMATE proxy selection method.
   * Combines all sources with intelligent routing:
   *   1. Domain intelligence check (knows what works for this domain)
   *   2. CAPTCHA-aware routing (auto-detect and route through captcha-solver)
   *   3. Anti-bot detection (auto-route through web-unlocker)
   *   4. Cost optimization (minimize cost while maximizing success)
   *   5. Adaptive strategy (adjusts based on real-time performance)
   *   6. Multi-source failover (never give up until all sources exhausted)
   */
  async getUltimateProxy(
    domain: string,
    options?: {
      tier?: ProxyTier;
      country?: string;
      city?: string;
      asn?: string;
      sessionId?: string;
      stealthLevel?: 'light' | 'medium' | 'maximum';
      maxCostPerGb?: number;
      requireReputation?: boolean;
      preferredProvider?: ProxyProvider;
      captchaAware?: boolean;
      antibotAware?: boolean;
      maxRetries?: number;
      onRetry?: (attempt: number, reason: string) => void;
    },
  ): Promise<ProxySelection & {
    source?: string;
    fusionPowered?: boolean;
    reputationScore?: number;
    costPerGb?: number;
    captchaDetected?: boolean;
    antibotDetected?: boolean;
    routingPath?: string[];
  } | null> {
    const startTime = Date.now();
    const routingPath: string[] = [];
    const maxRetries = options?.maxRetries ?? 3;

    try {
      // -- Phase 1: Domain Intelligence Analysis --------------------------
      const intel = this.getDomainIntelligence(domain);
      const effectiveTier = intel?.preferredTier || options?.tier || 'residential';
      const effectiveCountry = intel?.preferredCountry || options?.country;
      routingPath.push('domain-intelligence');

      // -- Phase 2: CAPTCHA Detection -------------------------------------
      const captchaDetection = (options?.captchaAware !== false)
        ? this.detectCaptchaNeed(domain)
        : { detected: false, type: null, confidence: 0 } as CaptchaDetectionResult;

      if (captchaDetection.detected) {
        routingPath.push('captcha-detected');
        this.prewarmCaptchaSolver(domain).catch(() => {});
      }

      // -- Phase 3: Anti-Bot Detection ------------------------------------
      const antibotDetection = (options?.antibotAware !== false)
        ? this.detectAntibotNeed(domain)
        : { detected: false, system: null, confidence: 0 } as AntibotDetectionResult;

      if (antibotDetection.detected) {
        routingPath.push('antibot-detected');
      }

      // -- Phase 4: Strategy Resolution -----------------------------------
      const strategy = this.resolveUltimateStrategy(domain, intel, captchaDetection, antibotDetection);
      routingPath.push(`strategy:${strategy}`);

      // -- Phase 5: Try sources in priority order with failover -----------
      const sources: Array<{
        name: string;
        getProxy: () => Promise<ProxySelection | null>;
      }> = [];

      // Source 1: Fusion mega pool (if domain needs fusion power)
      if (antibotDetection.detected || intel?.requiresStealth || this.isStealthDomain(domain)) {
        sources.push({
          name: 'fusion-mega-pool',
          getProxy: () => this.getFusionProxy(domain, effectiveTier, effectiveCountry, {
            city: options?.city,
            asn: options?.asn,
            sessionId: options?.sessionId,
            stealthLevel: options?.stealthLevel || 'medium',
            captchaAware: captchaDetection.detected,
          }).then(r => r ? { proxyUrl: r.proxyUrl, proxyId: r.proxyId, country: r.country, tier: r.tier, city: r.city, asn: r.asn } : null),
        });
      }

      // Source 2: Smart IP pool
      sources.push({
        name: 'smart-ip-pool',
        getProxy: () => this.getSmartProxy(domain, effectiveTier, effectiveCountry, {
          city: options?.city,
          asn: options?.asn,
          sessionId: options?.sessionId,
          requireReputation: options?.requireReputation,
          maxCostPerGb: options?.maxCostPerGb,
          preferredProvider: options?.preferredProvider,
        }).then(r => r ? { proxyUrl: r.proxyUrl, proxyId: r.proxyId, country: r.country, tier: r.tier, city: r.city, asn: r.asn } : null),
      });

      // Source 3: Cost-optimized selection
      const costState = this.costOptimizationStates.get(domain);
      if (costState?.recommendedSource) {
        sources.push({
          name: `cost-optimized:${costState.recommendedSource}`,
          getProxy: () => this.getProxy(domain, effectiveTier, effectiveCountry, 'cost-optimized', {
            city: options?.city,
            asn: options?.asn,
            sessionId: options?.sessionId,
          }),
        });
      }

      // Source 4: Legacy database pool
      sources.push({
        name: 'legacy-pool',
        getProxy: () => this.getProxy(domain, effectiveTier, effectiveCountry, strategy, {
          city: options?.city,
          asn: options?.asn,
          sessionId: options?.sessionId,
        }),
      });

      // Source 5: External residential providers
      sources.push({
        name: 'external-residential',
        getProxy: () => this.getExternalProxy(effectiveTier, effectiveCountry, options?.city, options?.asn),
      });

      // Source 6: Mobile proxy escalation (for hard-to-bypass domains)
      if (antibotDetection.detected || intel?.preferredTier === 'mobile') {
        sources.push({
          name: 'mobile-proxy-escalation',
          getProxy: async () => {
            const mobile = await this.getMobileProxy();
            if (!mobile) return null;
            try {
              const result = await mobile.escalateToMobile(domain, { proxyUrl: '', proxyId: '', country: effectiveCountry || '', tier: 'residential' });
              if (result) return { proxyUrl: result.proxyUrl, proxyId: result.sessionId, country: result.geo.country || '', tier: 'mobile', city: result.geo.city, asn: result.geo.asn };
            } catch { /* fall through */ }
            return null;
          },
        });
      }

      // -- Try each source with retry logic -------------------------------
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        for (const source of sources) {
          try {
            const result = await source.getProxy();
            if (result) {
              routingPath.push(source.name);

              const elapsed = Date.now() - startTime;
              logger.info({
                domain,
                tier: effectiveTier,
                country: effectiveCountry,
                source: source.name,
                attempt,
                elapsedMs: elapsed,
                routingPath,
              }, 'Ultimate proxy selection successful');

              return {
                ...result,
                source: source.name,
                fusionPowered: source.name.includes('fusion'),
                captchaDetected: captchaDetection.detected,
                antibotDetected: antibotDetection.detected,
                routingPath,
              };
            }
          } catch (err: any) {
            logger.debug({ source: source.name, error: err.message }, 'Source failed, trying next');
            options?.onRetry?.(attempt, `Source ${source.name} failed: ${err.message}`);
          }
        }
      }

      logger.warn({ domain, tier: effectiveTier, attempts: maxRetries * sources.length }, 'All proxy sources exhausted');
    } catch (err: any) {
      logger.error({ domain, error: err.message }, 'Ultimate proxy selection crashed');
    }

    return null;
  }

  // ===========================================================================
  // PUBLIC API -- OUTCOME RECORDING
  // ===========================================================================

  /**
   * Record the outcome of a proxy request for future optimization.
   * Auto-rotates to a different proxy on failure.
   * Updates domain intelligence, adaptive strategy, and cost optimization.
   */
  async recordOutcome(outcome: ProxyOutcome): Promise<void> {
    try {
      const { proxyId, domain, success, statusCode, latencyMs } = outcome;

      // -- Update domain intelligence --------------------------------------
      this.updateDomainIntelligenceFromOutcome(domain, proxyId, success, latencyMs, statusCode);

      // -- Update adaptive strategy performance window ---------------------
      this.updateAdaptiveStrategyPerformance(domain, success, latencyMs);

      // -- Update cost optimization ----------------------------------------
      this.updateCostOptimizationFromOutcome(domain, proxyId, success);

      // -- Record outcome in DB --------------------------------------------
      await db.proxyOutcome.create({
        data: {
          id: crypto.randomUUID(),
          proxyId,
          domain,
          success,
          statusCode,
          latencyMs,
        },
      });

      // -- Update proxy health metrics -------------------------------------
      const proxy = await db.proxy.findUnique({ where: { id: proxyId } });
      if (!proxy) return;

      const newConsecutiveFailures = success ? 0 : proxy.consecutiveFailures + 1;

      // EMA success rate (alpha=0.1)
      const alpha = 0.1;
      const newSuccessRate = success
        ? proxy.successRate * (1 - alpha) + 1 * alpha
        : proxy.successRate * (1 - alpha);

      // Update p95 latency (approximation)
      const newP95Latency = latencyMs > proxy.p95Latency
        ? Math.round(proxy.p95Latency * 0.9 + latencyMs * 0.1)
        : proxy.p95Latency;

      // Decide whether to retire the proxy
      const shouldRetire = newConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES
        || newSuccessRate < RETIRE_THRESHOLD;

      await db.proxy.update({
        where: { id: proxyId },
        data: {
          successRate: Math.round(newSuccessRate * 1000) / 1000,
          p95Latency: newP95Latency,
          failures: success ? proxy.failures : proxy.failures + 1,
          consecutiveFailures: newConsecutiveFailures,
          retired: shouldRetire,
          lastChecked: new Date(),
        },
      });

      if (shouldRetire) {
        logger.warn(
          { proxyId, domain, successRate: newSuccessRate, consecutiveFailures: newConsecutiveFailures },
          'Proxy retired due to poor performance',
        );

        // Remove from domain optimization map
        if (this.domainProxyMap.get(domain) === proxyId) {
          this.domainProxyMap.delete(domain);
        }

        // Report to containment shield
        this.reportRetiredProxy(proxyId, domain).catch(() => {});
      }

      // On failure, clear domain-optimized proxy so next request uses a different one
      if (!success && this.domainProxyMap.get(domain) === proxyId) {
        this.domainProxyMap.delete(domain);
      }

      // Invalidate cache
      await redis.del(`proxies:${proxy.tier}`);
    } catch (error: any) {
      logger.error({ error: error.message, proxyId: outcome.proxyId }, 'Failed to record proxy outcome');
    }
  }

  /**
   * Release a proxy back to the smart pool after use.
   * Records the outcome in both the proxy DB and the reputation tracker.
   */
  async releaseSmartProxy(
    proxyId: string,
    domain: string,
    success: boolean,
    statusCode?: number,
    source?: string,
  ): Promise<void> {
    try {
      // Release back to smart pool (handles reputation + cooldown)
      await smartIPPool.releaseProxy(proxyId, domain, success, statusCode, source as any);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Smart pool release failed');
    }

    // Also record in the legacy proxy manager for DB tracking
    await this.recordOutcome({
      proxyId,
      domain,
      success,
      statusCode,
      latencyMs: 0,
    });
  }

  /**
   * Release a fusion proxy back to the mega pool.
   */
  async releaseFusionProxy(
    proxyId: string,
    domain: string,
    success: boolean,
    statusCode?: number,
    latencyMs?: number,
    source?: string,
  ): Promise<void> {
    try {
      await megaPool.releaseProxy(proxyId, domain, success, statusCode, source as any);
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Mega pool release failed');
    }

    // Also record outcome
    await this.recordOutcome({
      proxyId,
      domain,
      success,
      statusCode,
      latencyMs: latencyMs ?? 0,
    });
  }

  // ===========================================================================
  // PUBLIC API -- CAPTCHA SOLVER
  // ===========================================================================

  /**
   * Solve a CAPTCHA using the integrated CAPTCHA solver.
   * Supports reCAPTCHA v2/v3, hCaptcha, FunCaptcha, Turnstile, image CAPTCHAs.
   * Uses 2Captcha and CapSolver with automatic failover.
   */
  async solveCaptcha(request: {
    type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'funcaptcha' | 'turnstile' | 'image' | 'geetest';
    siteKey: string;
    pageUrl: string;
    domain?: string;
    proxyUrl?: string;
    action?: string;
    minScore?: number;
    imageData?: string;
  }): Promise<{
    success: boolean;
    token?: string;
    provider: string;
    solveTimeMs: number;
    cost: number;
    error?: string;
  }> {
    try {
      const solver = await this.getCaptchaSolver();
      if (!solver) {
        return { success: false, provider: 'none', solveTimeMs: 0, cost: 0, error: 'CAPTCHA solver module not available' };
      }

      const result = await solver.solve(request);
      return {
        success: result.success,
        token: result.token,
        provider: result.provider,
        solveTimeMs: result.solveTimeMs,
        cost: result.cost,
        error: result.error,
      };
    } catch (err: any) {
      logger.error({ error: err.message, type: request.type }, 'CAPTCHA solving failed');
      return { success: false, provider: 'none', solveTimeMs: 0, cost: 0, error: err.message };
    }
  }

  /**
   * Batch solve CAPTCHAs using the integrated CAPTCHA solver.
   */
  async solveCaptchaBatch(
    requests: Array<{
      type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'funcaptcha' | 'turnstile' | 'image' | 'geetest';
      siteKey: string;
      pageUrl: string;
      domain?: string;
      proxyUrl?: string;
    }>,
  ): Promise<Array<{
    success: boolean;
    token?: string;
    provider: string;
    solveTimeMs: number;
    cost: number;
    error?: string;
  }>> {
    try {
      const solver = await this.getCaptchaSolver();
      if (!solver) {
        return requests.map(() => ({
          success: false, provider: 'none', solveTimeMs: 0, cost: 0,
          error: 'CAPTCHA solver module not available',
        }));
      }

      const results = await solver.solveBatch(requests, { concurrency: 3 });
      return results.map((r: any) => ({
        success: r.success,
        token: r.token,
        provider: r.provider,
        solveTimeMs: r.solveTimeMs,
        cost: r.cost,
        error: r.error,
      }));
    } catch (err: any) {
      logger.error({ error: err.message, count: requests.length }, 'Batch CAPTCHA solving failed');
      return requests.map(() => ({
        success: false, provider: 'none', solveTimeMs: 0, cost: 0, error: err.message,
      }));
    }
  }

  // ===========================================================================
  // PUBLIC API -- WEB UNLOCKER
  // ===========================================================================

  /**
   * Unlock a web page using the Web Unlocker service.
   * Handles JavaScript rendering, anti-bot bypass, CAPTCHA solving,
   * and smart retry with proxy rotation.
   */
  async unlockPage(request: {
    url: string;
    domain?: string;
    strategy?: 'http' | 'browser' | 'stealth' | 'auto';
    stealthLevel?: 'light' | 'medium' | 'maximum';
    proxyUrl?: string;
    proxyTier?: ProxyTier;
    proxyCountry?: string;
    headers?: Record<string, string>;
    waitForSelector?: string;
    timeout?: number;
    solveCaptcha?: boolean;
    sessionId?: string;
    maxRetries?: number;
  }): Promise<{
    success: boolean;
    html?: string;
    statusCode?: number;
    finalUrl?: string;
    captchaDetected: boolean;
    captchaSolved: boolean;
    strategy: string;
    stealthLevel: string;
    proxyUsed: boolean;
    retries: number;
    renderTimeMs: number;
    totalTimeMs: number;
    error?: string;
  }> {
    try {
      const unlocker = await this.getWebUnlocker();
      if (!unlocker) {
        return {
          success: false, captchaDetected: false, captchaSolved: false,
          strategy: 'http', stealthLevel: 'light', proxyUsed: false,
          retries: 0, renderTimeMs: 0, totalTimeMs: 0,
          error: 'Web Unlocker module not available',
        };
      }

      const result = await unlocker.unlock(request);
      return {
        success: result.success,
        html: result.html,
        statusCode: result.statusCode,
        finalUrl: result.finalUrl,
        captchaDetected: result.captchaDetected,
        captchaSolved: result.captchaSolved,
        strategy: result.strategy,
        stealthLevel: result.stealthLevel,
        proxyUsed: result.proxyUsed,
        retries: result.retries,
        renderTimeMs: result.renderTimeMs,
        totalTimeMs: result.totalTimeMs,
        error: result.error,
      };
    } catch (err: any) {
      logger.error({ error: err.message, url: request.url }, 'Web Unlocker failed');
      return {
        success: false, captchaDetected: false, captchaSolved: false,
        strategy: 'http', stealthLevel: 'light', proxyUsed: false,
        retries: 0, renderTimeMs: 0, totalTimeMs: 0, error: err.message,
      };
    }
  }

  // ===========================================================================
  // PUBLIC API -- FUSION REACTOR MANAGEMENT
  // ===========================================================================

  /**
   * Ignite the Nuclear Fusion reactor.
   * Starts chain reactions, breeding, quantum tunneling, and plasma management.
   * The pool becomes self-sustaining when Q-factor > 1.
   */
  async igniteFusion(config?: {
    targetQFactor?: number;
    maxReactionRate?: number;
    fuelTypes?: string[];
    plasmaTemperature?: number;
    neutronModeration?: number;
    containmentLevel?: number;
  }): Promise<{ ignited: boolean; status: string; qFactor?: number }> {
    try {
      const fusionCore = await this.getFusionCore();
      if (!fusionCore) {
        return { ignited: false, status: 'unavailable' };
      }

      await fusionCore.ignite({
        targetQFactor: config?.targetQFactor ?? 1.5,
        maxReactionRate: config?.maxReactionRate ?? 100,
        containmentLevel: config?.containmentLevel ?? 0,
        fuelTypes: config?.fuelTypes ?? ['free', 'residential', 'tor', 'datacenter'],
        plasmaTemperature: config?.plasmaTemperature ?? 20,
        neutronModeration: config?.neutronModeration ?? 0.5,
      });

      // Start chain reaction
      const chainReaction = await this.getChainReaction();
      if (chainReaction) {
        chainReaction.startReaction();
      }

      // Start breeder reactor
      const breederReactor = await this.getBreederReactor();
      if (breederReactor) {
        breederReactor.startBreeding();
      }

      // Start quantum tunneling
      const quantumTunnel = await this.getQuantumTunnel();
      if (quantumTunnel) {
        quantumTunnel.startTunneling();
      }

      // Start plasma state
      const plasmaState = await this.getPlasmaState();
      if (plasmaState) {
        await plasmaState.startPlasma();
      }

      // Start containment shield
      const containmentShield = await this.getContainmentShield();
      if (containmentShield) {
        await containmentShield.startContainment();
      }

      const qFactor = fusionCore.getQFactor?.() ?? 0;
      const status = fusionCore.getStatus?.() ?? 'unknown';

      logger.info({ qFactor, status }, 'Fusion reactor ignited successfully');

      return { ignited: true, status, qFactor };
    } catch (err: any) {
      logger.error({ error: err.message }, 'Fusion ignition failed');
      return { ignited: false, status: 'failed' };
    }
  }

  /**
   * Shut down the Nuclear Fusion reactor gracefully.
   */
  async shutdownFusion(): Promise<void> {
    try {
      // Stop in reverse order of startup
      const modules = [
        { name: 'containment', loader: () => this.getContainmentShield(), stop: (m: any) => m.stopContainment?.() },
        { name: 'plasma', loader: () => this.getPlasmaState(), stop: (m: any) => m.stopPlasma?.() },
        { name: 'quantum', loader: () => this.getQuantumTunnel(), stop: (m: any) => m.stopTunneling?.() },
        { name: 'breeder', loader: () => this.getBreederReactor(), stop: (m: any) => m.stopBreeding?.() },
        { name: 'chain', loader: () => this.getChainReaction(), stop: (m: any) => m.stopReaction?.() },
        { name: 'fusion', loader: () => this.getFusionCore(), stop: (m: any) => m.shutdown?.() },
      ];

      const stopResults = await Promise.allSettled(
        modules.map(async ({ name, loader, stop }) => {
          try {
            const mod = await loader();
            if (mod) await stop(mod);
          } catch (err: any) {
            logger.debug({ module: name, error: err.message }, `Failed to stop ${name}`);
          }
        }),
      );

      const failures = stopResults.filter(r => r.status === 'rejected').length;
      if (failures > 0) {
        logger.warn({ failures }, 'Some fusion modules failed to stop gracefully');
      }

      logger.info('Fusion reactor shutdown completed');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Fusion shutdown failed');
    }
  }

  /**
   * Emergency SCRAM -- immediately shut down the fusion reactor.
   */
  async scramFusion(): Promise<void> {
    try {
      const fusionCore = await this.getFusionCore();
      if (fusionCore) {
        await fusionCore.scram();
      }

      const containmentShield = await this.getContainmentShield();
      if (containmentShield) {
        await containmentShield.scram();
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'Fusion SCRAM failed');
    }
  }

  /**
   * Get Nuclear Fusion reactor status.
   */
  async getFusionStatus(): Promise<any> {
    try {
      const fusionCore = await this.getFusionCore();
      if (!fusionCore) {
        return { status: 'offline', error: 'Fusion core not available' };
      }
      return fusionCore.getStatus();
    } catch {
      return { status: 'offline', error: 'Fusion core not available' };
    }
  }

  /**
   * Get detailed fusion reactor statistics.
   */
  async getFusionReactorStats(): Promise<any> {
    try {
      const fusionCore = await this.getFusionCore();
      if (!fusionCore) return null;
      return fusionCore.getReactorStats?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get fusion Q-factor.
   */
  async getFusionQFactor(): Promise<number> {
    try {
      const fusionCore = await this.getFusionCore();
      if (!fusionCore) return 0;
      return fusionCore.getQFactor?.() ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Inject fuel into the fusion reactor.
   */
  async injectFusionFuel(fuelType: string, amount: number): Promise<number> {
    try {
      const fusionCore = await this.getFusionCore();
      if (!fusionCore) return 0;
      return fusionCore.injectFuel?.(fuelType, amount) ?? 0;
    } catch (err: any) {
      logger.error({ error: err.message }, 'Fusion fuel injection failed');
      return 0;
    }
  }

  /**
   * Get fusion core milestones.
   */
  async getFusionMilestones(): Promise<any[]> {
    try {
      const fusionCore = await this.getFusionCore();
      if (!fusionCore) return [];
      return fusionCore.getMilestones?.() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Get fusion module diagnostics.
   */
  async getFusionDiagnostics(): Promise<Record<string, unknown>> {
    try {
      const fusionCore = await this.getFusionCore();
      if (!fusionCore) return {};
      return fusionCore.getDiagnostics?.() ?? {};
    } catch {
      return {};
    }
  }

  // ===========================================================================
  // PUBLIC API -- DOMAIN INTELLIGENCE
  // ===========================================================================

  /**
   * Get domain intelligence for a specific domain.
   */
  getDomainIntelligence(domain: string): DomainIntelligenceEntry | undefined {
    return this.domainIntelligence.get(domain);
  }

  /**
   * Get all tracked domain intelligence entries.
   */
  getAllDomainIntelligence(): DomainIntelligenceEntry[] {
    return Array.from(this.domainIntelligence.values());
  }

  /**
   * Get domain intelligence summary.
   */
  getDomainIntelligenceSummary(): {
    trackedDomains: number;
    stealthDomains: number;
    captchaDomains: number;
    avgSuccessRate: number;
    topDomains: Array<{ domain: string; successRate: number; requestCount: number }>;
  } {
    const entries = Array.from(this.domainIntelligence.values());
    const stealthDomains = entries.filter(e => e.requiresStealth).length;
    const captchaDomains = entries.filter(e => e.requiresCaptcha).length;
    const avgSuccessRate = entries.length > 0
      ? entries.reduce((sum, e) => sum + e.successRate, 0) / entries.length
      : 0;
    const topDomains = entries
      .sort((a, b) => b.requestCount - a.requestCount)
      .slice(0, 20)
      .map(e => ({ domain: e.domain, successRate: e.successRate, requestCount: e.requestCount }));

    return {
      trackedDomains: entries.length,
      stealthDomains,
      captchaDomains,
      avgSuccessRate,
      topDomains,
    };
  }

  /**
   * Manually update domain intelligence for a domain.
   */
  setDomainIntelligence(domain: string, update: Partial<DomainIntelligenceEntry>): void {
    const existing = this.domainIntelligence.get(domain);
    if (existing) {
      Object.assign(existing, update, { lastUpdated: Date.now() });
    } else {
      this.domainIntelligence.set(domain, {
        domain,
        bestProxyIds: [],
        worstProxyIds: [],
        requiresStealth: false,
        requiresCaptcha: false,
        preferredTier: 'residential',
        preferredCountry: '',
        averageLatency: 0,
        successRate: 0,
        captchaFrequency: 0,
        antibotFrequency: 0,
        costPerRequest: 0,
        lastUpdated: Date.now(),
        requestCount: 0,
        failoverChain: ['residential', 'mobile', 'isp', 'datacenter'],
        ...update,
      });
    }
  }

  // ===========================================================================
  // PUBLIC API -- CAPTCHA & ANTI-BOT DETECTION
  // ===========================================================================

  /**
   * Detect if a domain likely requires CAPTCHA solving.
   */
  detectCaptchaNeed(domain: string): CaptchaDetectionResult {
    const intel = this.domainIntelligence.get(domain);

    // Check domain intelligence first
    if (intel?.captchaFrequency && intel.captchaFrequency > 0.3) {
      return { detected: true, type: 'unknown', confidence: intel.captchaFrequency };
    }

    // Known CAPTCHA-heavy domains
    const captchaHeavyDomains: Record<string, string> = {
      'google.com': 'recaptcha_v3',
      'recaptcha.net': 'recaptcha_v2',
      'hcaptcha.com': 'hcaptcha',
    };

    for (const [key, type] of Object.entries(captchaHeavyDomains)) {
      if (domain.includes(key)) {
        return { detected: true, type, confidence: 0.9 };
      }
    }

    // Check against patterns
    const domainLower = domain.toLowerCase();
    for (const pattern of CAPTCHA_DETECTION_PATTERNS) {
      if (domainLower.includes(pattern)) {
        return { detected: true, type: 'unknown', confidence: 0.5 };
      }
    }

    return { detected: false, type: null, confidence: 0 };
  }

  /**
   * Detect if a domain likely uses anti-bot protection.
   */
  detectAntibotNeed(domain: string): AntibotDetectionResult {
    const intel = this.domainIntelligence.get(domain);

    // Check domain intelligence
    if (intel?.antibotFrequency && intel.antibotFrequency > 0.3) {
      return { detected: true, system: 'unknown', confidence: intel.antibotFrequency };
    }

    // Check stealth domain list
    if (this.isStealthDomain(domain)) {
      return { detected: true, system: 'unknown', confidence: 0.8 };
    }

    // Known anti-bot system associations
    const antibotDomains: Record<string, string> = {
      'amazon.com': 'aws-waf',
      'ticketmaster.com': 'perimeterx',
      'nike.com': 'akamai',
      'adidas.com': 'akamai',
      'zillow.com': 'cloudflare',
      'yelp.com': 'cloudflare',
      'linkedin.com': 'perimeterx',
      'airbnb.com': 'cloudflare',
    };

    for (const [key, system] of Object.entries(antibotDomains)) {
      if (domain.includes(key)) {
        return { detected: true, system, confidence: 0.7 };
      }
    }

    // Check against patterns
    const domainLower = domain.toLowerCase();
    for (const pattern of ANTIBOT_DETECTION_PATTERNS) {
      if (domainLower.includes(pattern)) {
        return { detected: true, system: pattern, confidence: 0.5 };
      }
    }

    return { detected: false, system: null, confidence: 0 };
  }

  /**
   * Check if a domain is known to require stealth.
   */
  isStealthDomain(domain: string): boolean {
    // Check explicit set
    for (const stealthDomain of STEALTH_DOMAINS) {
      if (domain.includes(stealthDomain) || stealthDomain.includes(domain)) {
        return true;
      }
    }

    // Check domain intelligence
    const intel = this.domainIntelligence.get(domain);
    if (intel?.requiresStealth) return true;

    return false;
  }

  // ===========================================================================
  // PUBLIC API -- PRE-WARMING & POOL MANAGEMENT
  // ===========================================================================

  /**
   * Pre-warm IPs for a high-traffic domain.
   * Delegates to the Smart IP Pool Manager and Fusion system.
   */
  async prewarmDomain(
    domain: string,
    tier: ProxyTier = 'residential',
    country?: string,
    count?: number,
  ): Promise<number> {
    const results = await Promise.allSettled([
      smartIPPool.prewarmDomain(domain, tier, country),
      megaPool.prewarmDomain(domain, tier, country),
    ]);

    let totalPrewarmed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled' && typeof result.value === 'number') {
        totalPrewarmed += result.value;
      }
    }

    logger.info({ domain, tier, country, prewarmed: totalPrewarmed }, 'Domain pre-warming completed');
    return totalPrewarmed;
  }

  /**
   * Get the total effective pool size across ALL sources including fusion.
   */
  async getTotalEffectiveIPs(): Promise<number> {
    try {
      return await megaPool.getTotalPoolSize();
    } catch {
      // Fallback: count DB proxies
      return db.proxy.count({ where: { retired: false } });
    }
  }

  /**
   * Add a proxy to the pool with full geotargeting metadata.
   */
  async addProxy(proxy: {
    id: string;
    url: string;
    tier: ProxyTier;
    country?: string;
    city?: string;
    region?: string;
    asn?: string;
    isp?: string;
    provider: string;
  }): Promise<void> {
    await db.proxy.upsert({
      where: { id: proxy.id },
      update: { url: proxy.url, retired: false, city: proxy.city, region: proxy.region, asn: proxy.asn, isp: proxy.isp },
      create: {
        id: proxy.id,
        url: proxy.url,
        tier: proxy.tier,
        country: proxy.country || 'US',
        city: proxy.city,
        region: proxy.region,
        asn: proxy.asn,
        isp: proxy.isp,
        provider: proxy.provider,
      },
    });

    await redis.del(`proxies:${proxy.tier}`);
  }

  /**
   * Bulk import proxies from a provider with parallel processing.
   */
  async bulkImport(proxies: Array<{
    id: string;
    url: string;
    tier: ProxyTier;
    country: string;
    city?: string;
    asn?: string;
    isp?: string;
    provider: string;
  }>): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;

    // Process in parallel batches of 20
    const batchSize = 20;
    for (let i = 0; i < proxies.length; i += batchSize) {
      const batch = proxies.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(proxy => this.addProxy(proxy)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          imported++;
        } else {
          skipped++;
        }
      }
    }

    logger.info({ imported, skipped, total: proxies.length }, 'Bulk proxy import completed');
    return { imported, skipped };
  }

  /**
   * Validate a proxy using the validation pipeline.
   */
  async validateProxy(
    proxyUrl: string,
    proxyId: string,
    expectedCountry?: string,
  ): Promise<any> {
    try {
      const pipeline = await this.getValidationPipeline();
      if (!pipeline) {
        return { valid: false, error: 'Validation pipeline not available' };
      }
      return pipeline.validateAndStore(proxyUrl, proxyId, expectedCountry);
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  }

  /**
   * Validate multiple proxies using the validation pipeline.
   */
  async validateProxyBatch(
    proxies: Array<{ url: string; id: string; expectedCountry?: string }>,
  ): Promise<any[]> {
    try {
      const pipeline = await this.getValidationPipeline();
      if (!pipeline) return proxies.map(() => ({ valid: false, error: 'Validation pipeline not available' }));
      return pipeline.validateBatch(proxies.map(p => ({
        proxyUrl: p.url,
        proxyId: p.id,
        expectedCountry: p.expectedCountry,
      })));
    } catch (err: any) {
      return proxies.map(() => ({ valid: false, error: err.message }));
    }
  }

  // ===========================================================================
  // PUBLIC API -- MODULE-SPECIFIC OPERATIONS
  // ===========================================================================

  /**
   * Create a rotating session.
   */
  async createRotatingSession(options?: {
    tier?: ProxyTier;
    country?: string;
    domain?: string;
    provider?: string;
  }): Promise<any> {
    try {
      const factory = await this.getRotatingSessionFactory();
      if (!factory) return null;

      if (options?.domain) {
        return factory.getSessionForDomain(options.domain, options.tier, options.country);
      }
      return factory.createSession({
        tier: options?.tier,
        country: options?.country,
        preferredProvider: options?.provider,
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Rotating session creation failed');
      return null;
    }
  }

  /**
   * Get a TOR circuit.
   */
  async getTorCircuit(options?: {
    country?: string;
    exitCountry?: string;
  }): Promise<any> {
    try {
      const torPool = await this.getTorPool();
      if (!torPool) return null;
      return torPool.getCircuit(options);
    } catch (err: any) {
      logger.error({ error: err.message }, 'TOR circuit creation failed');
      return null;
    }
  }

  /**
   * Get a warm bulk session.
   */
  async getWarmSession(tier?: string, country?: string): Promise<any> {
    try {
      const bulkManager = await this.getBulkSessionManager();
      if (!bulkManager) return null;
      return bulkManager.getWarmSession(tier, country);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Warm session retrieval failed');
      return null;
    }
  }

  /**
   * Get a virtual IP from subnet expander.
   */
  async getVirtualIP(country?: string, tier?: string): Promise<any> {
    try {
      const expander = await this.getSubnetExpander();
      if (!expander) return null;
      return expander.getVirtualIP(country, tier);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Virtual IP retrieval failed');
      return null;
    }
  }

  /**
   * Get a plasma-state proxy.
   */
  async getPlasmaProxy(tier?: string, country?: string): Promise<any> {
    try {
      const plasma = await this.getPlasmaState();
      if (!plasma) return null;
      return plasma.getProxy(tier, country);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Plasma proxy retrieval failed');
      return null;
    }
  }

  /**
   * Tunnel through a geographic barrier using quantum tunneling.
   */
  async tunnelGeographic(sourceCountry: string, targetCountry: string): Promise<any> {
    try {
      const tunnel = await this.getQuantumTunnel();
      if (!tunnel) return null;
      return tunnel.tunnelGeographic(sourceCountry, targetCountry);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Geographic tunneling failed');
      return null;
    }
  }

  /**
   * Discover free proxies.
   */
  async discoverFreeProxies(): Promise<any> {
    try {
      const discovery = await this.getFreeProxyDiscovery();
      if (!discovery) return { discovered: 0 };
      return discovery.runDiscoveryCycle();
    } catch (err: any) {
      logger.error({ error: err.message }, 'Free proxy discovery failed');
      return { discovered: 0 };
    }
  }

  /**
   * Breed new proxy configurations from existing ones.
   */
  async breedProxy(proxyId: string): Promise<any[]> {
    try {
      const breeder = await this.getBreederReactor();
      if (!breeder) return [];
      return breeder.breedFromProxy(proxyId);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Proxy breeding failed');
      return [];
    }
  }

  /**
   * Check containment for a proxy.
   */
  async checkContainment(proxyId: string): Promise<any> {
    try {
      const shield = await this.getContainmentShield();
      if (!shield) return { contained: false, error: 'Containment shield not available' };
      return shield.checkProxy(proxyId);
    } catch (err: any) {
      return { contained: false, error: err.message };
    }
  }

  /**
   * Get reputation verdict for a proxy/domain pair.
   */
  async getReputationVerdict(proxyId: string, domain: string): Promise<ReputationVerdict | null> {
    try {
      return await ipReputationTracker.getVerdict(proxyId, domain);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Reputation verdict failed');
      return null;
    }
  }

  // ===========================================================================
  // PUBLIC API -- STATISTICS & MONITORING
  // ===========================================================================

  /**
   * Get pool statistics with geographic breakdown.
   */
  async getPoolStats(): Promise<{
    total: number;
    active: number;
    retired: number;
    byTier: Record<string, number>;
    byCountry: Record<string, number>;
    byProvider: Record<string, number>;
    avgSuccessRate: number;
    avgP95Latency: number;
    geoCoverage: {
      countries: number;
      cities: number;
      asns: number;
    };
  }> {
    const [total, active, retired] = await Promise.all([
      db.proxy.count(),
      db.proxy.count({ where: { retired: false } }),
      db.proxy.count({ where: { retired: true } }),
    ]);

    const [tierGroups, countryGroups, providerGroups, activeProxies] = await Promise.all([
      db.proxy.groupBy({
        by: ['tier'],
        _count: { tier: true },
        where: { retired: false },
      }),
      db.proxy.groupBy({
        by: ['country'],
        _count: { country: true },
        where: { retired: false },
      }),
      db.proxy.groupBy({
        by: ['provider'],
        _count: { provider: true },
        where: { retired: false },
      }),
      db.proxy.findMany({
        where: { retired: false },
        select: { successRate: true, p95Latency: true, country: true, city: true, asn: true },
      }),
    ]);

    const avgSuccessRate = activeProxies.length > 0
      ? activeProxies.reduce((sum, p) => sum + p.successRate, 0) / activeProxies.length
      : 0;

    const avgP95Latency = activeProxies.length > 0
      ? activeProxies.reduce((sum, p) => sum + p.p95Latency, 0) / activeProxies.length
      : 0;

    const countries = new Set(activeProxies.map((p) => p.country));
    const cities = new Set(activeProxies.map((p) => p.city).filter(Boolean));
    const asns = new Set(activeProxies.map((p) => p.asn).filter(Boolean));

    return {
      total,
      active,
      retired,
      byTier: Object.fromEntries(tierGroups.map((g) => [g.tier, g._count.tier])),
      byCountry: Object.fromEntries(countryGroups.map((g) => [g.country, g._count.country])),
      byProvider: Object.fromEntries(providerGroups.map((g) => [g.provider, g._count.provider])),
      avgSuccessRate: Math.round(avgSuccessRate * 1000) / 1000,
      avgP95Latency: Math.round(avgP95Latency),
      geoCoverage: {
        countries: countries.size,
        cities: cities.size,
        asns: asns.size,
      },
    };
  }

  /**
   * Get comprehensive pool statistics including smart pool state and fusion system.
   */
  async getEnhancedPoolStats(): Promise<{
    legacy: Awaited<ReturnType<ProxyManager['getPoolStats']>>;
    smartPool: any;
    aggregator: any;
    megaPool: any;
    reputation: { decayRunning: boolean; stats: any };
  }> {
    const [legacy, smartPoolStats, aggregatorComp] = await Promise.all([
      this.getPoolStats(),
      smartIPPool.getPoolStats(),
      proxyAggregator.getComposition(),
    ]);

    // Get mega pool / fusion stats (non-blocking -- returns empty if not started)
    let megaPoolStats: any = null;
    try {
      megaPoolStats = await megaPool.getStats();
    } catch (err: any) {
      logger.debug({ error: err.message }, 'Mega pool stats not available');
    }

    let reputationStats: any = null;
    try {
      reputationStats = {
        decayRunning: true,
      };
    } catch {
      reputationStats = { decayRunning: false };
    }

    return {
      legacy,
      smartPool: smartPoolStats,
      aggregator: aggregatorComp,
      megaPool: megaPoolStats,
      reputation: { decayRunning: true, stats: reputationStats },
    };
  }

  /**
   * Get UNIFIED pool statistics from ALL modules.
   * Combines stats from every module into a comprehensive dashboard view.
   */
  async getUnifiedPoolStats(): Promise<UnifiedPoolStats> {
    const startTime = Date.now();

    // -- Gather stats from ALL modules in parallel -------------------------
    const [
      legacyResult,
      smartPoolResult,
      aggregatorResult,
      megaPoolResult,
      fusionResult,
      chainReactionResult,
      breederReactorResult,
      quantumTunnelResult,
      plasmaStateResult,
      containmentResult,
      validationPipelineResult,
      rotatingSessionFactoryResult,
      freeProxyDiscoveryResult,
      torPoolResult,
      bulkSessionsResult,
      subnetExpanderResult,
      captchaSolverResult,
      webUnlockerResult,
      cdpInjectionResult,
      deepPatcherResult,
      residentialProvidersResult,
      mobileProxyResult,
      geoExpanderResult,
      dnsShieldResult,
      stealthBrowserResult,
      requestPacerResult,
      structuredExtractorResult,
      antiBotMonitorResult,
      fingerprintCalibratorResult,
      kasadaChallengerResult,
      kasadaSWProxyResult,
      kasadaBehaviorResult,
      kasadaFingerprintResult,
    ] = await Promise.allSettled([
      this.getPoolStats(),
      smartIPPool.getPoolStats().catch(() => null),
      proxyAggregator.getComposition().catch(() => null),
      megaPool.getStats().catch(() => null),
      this.getFusionStatus(),
      this.getModuleStats('chain-reaction', () => this.getChainReaction()),
      this.getModuleStats('breeder-reactor', () => this.getBreederReactor()),
      this.getModuleStats('quantum-tunnel', () => this.getQuantumTunnel()),
      this.getModuleStats('plasma-state', () => this.getPlasmaState()),
      this.getModuleStats('containment', () => this.getContainmentShield()),
      this.getModuleStats('validation-pipeline', () => this.getValidationPipeline()),
      this.getModuleStats('rotating-session-factory', () => this.getRotatingSessionFactory()),
      this.getModuleStats('free-proxy-discovery', () => this.getFreeProxyDiscovery()),
      this.getModuleStats('tor-pool', () => this.getTorPool()),
      this.getModuleStats('bulk-sessions', () => this.getBulkSessionManager()),
      this.getModuleStats('subnet-expander', () => this.getSubnetExpander()),
      this.getModuleStats('captcha-solver', () => this.getCaptchaSolver()),
      this.getModuleStats('web-unlocker', () => this.getWebUnlocker()),
      this.getModuleStats('cdp-injection', () => this.getCdpInjection()),
      this.getModuleStats('deep-patcher', () => this.getDeepPatcher()),
      Promise.resolve(residentialProxyManager.getProviderStats()),
      this.getModuleStats('mobile-proxy', () => this.getMobileProxy()),
      this.getModuleStats('geo-expander', () => this.getGeoExpander()),
      this.getModuleStats('dns-shield', () => this.getDnsShield()),
      this.getModuleStats('stealth-browser', () => this.getStealthBrowser()),
      this.getModuleStats('request-pacer', () => this.getRequestPacer()),
      this.getModuleStats('structured-extractor', () => this.getStructuredExtractor()),
      this.getModuleStats('anti-bot-monitor', () => this.getAntiBotMonitor()),
      this.getModuleStats('fingerprint-calibrator', () => this.getFingerprintCalibrator()),
      this.getModuleStats('kasada-challenger', () => this.getKasadaChallenger()),
      this.getModuleStats('kasada-sw-proxy', () => this.getKasadaSWProxy()),
      this.getModuleStats('kasada-behavior', () => this.getKasadaBehavior()),
      this.getModuleStats('kasada-fingerprint', () => this.getKasadaFingerprint()),
    ]);

    // -- Build module health summary ---------------------------------------
    const moduleHealthEntries = Array.from(this.moduleHealth.values());
    const healthyModules = moduleHealthEntries.filter(m => m.available && m.consecutiveFailures === 0).length;
    const degradedModules = moduleHealthEntries.filter(m => m.available && m.consecutiveFailures > 0).length;
    const offlineModules = moduleHealthEntries.filter(m => !m.available).length;

    // -- Build cost optimization summary -----------------------------------
    const costEntries = Array.from(this.costOptimizationStates.values());
    const totalCostSaved = costEntries.reduce((sum, c) => sum + c.costEfficiencyScore, 0);
    const avgCostEfficiency = costEntries.length > 0
      ? costEntries.reduce((sum, c) => sum + c.costEfficiencyScore, 0) / costEntries.length
      : 0;

    // -- Build domain intelligence summary ---------------------------------
    const domainIntel = this.getDomainIntelligenceSummary();

    const elapsed = Date.now() - startTime;
    logger.debug({ elapsedMs: elapsed }, 'Unified pool stats collected');

    return {
      legacy: this.settledValue(legacyResult),
      smartPool: this.settledValue(smartPoolResult),
      aggregator: this.settledValue(aggregatorResult),
      megaPool: this.settledValue(megaPoolResult),
      reputation: { decayRunning: true, stats: null },
      fusion: this.settledValue(fusionResult),
      chainReaction: this.settledValue(chainReactionResult),
      breederReactor: this.settledValue(breederReactorResult),
      quantumTunnel: this.settledValue(quantumTunnelResult),
      plasmaState: this.settledValue(plasmaStateResult),
      containment: this.settledValue(containmentResult),
      validationPipeline: this.settledValue(validationPipelineResult),
      rotatingSessionFactory: this.settledValue(rotatingSessionFactoryResult),
      freeProxyDiscovery: this.settledValue(freeProxyDiscoveryResult),
      torPool: this.settledValue(torPoolResult),
      bulkSessions: this.settledValue(bulkSessionsResult),
      subnetExpander: this.settledValue(subnetExpanderResult),
      captchaSolver: this.settledValue(captchaSolverResult),
      webUnlocker: this.settledValue(webUnlockerResult),
      cdpInjection: this.settledValue(cdpInjectionResult),
      deepPatcher: this.settledValue(deepPatcherResult),
      residentialProviders: this.settledValue(residentialProvidersResult),
      mobileProxy: this.settledValue(mobileProxyResult),
      geoExpander: this.settledValue(geoExpanderResult),
      dnsShield: this.settledValue(dnsShieldResult),
      stealthBrowser: this.settledValue(stealthBrowserResult),
      requestPacer: this.settledValue(requestPacerResult),
      structuredExtractor: this.settledValue(structuredExtractorResult),
      antiBotMonitor: this.settledValue(antiBotMonitorResult),
      fingerprintCalibrator: this.settledValue(fingerprintCalibratorResult),
      kasadaChallenger: this.settledValue(kasadaChallengerResult),
      kasadaSWProxy: this.settledValue(kasadaSWProxyResult),
      kasadaBehavior: this.settledValue(kasadaBehaviorResult),
      kasadaFingerprint: this.settledValue(kasadaFingerprintResult),
      domainIntelligence: {
        trackedDomains: domainIntel.trackedDomains,
        stealthDomains: domainIntel.stealthDomains,
        captchaDomains: domainIntel.captchaDomains,
        avgSuccessRate: domainIntel.avgSuccessRate,
      },
      moduleHealth: {
        totalModules: moduleHealthEntries.length || 28,
        healthyModules,
        degradedModules,
        offlineModules,
        modules: moduleHealthEntries.map(m => ({
          name: m.moduleName,
          status: m.available
            ? (m.consecutiveFailures === 0 ? 'healthy' as const : 'degraded' as const)
            : 'offline' as const,
        })),
      },
      costOptimization: {
        totalCostSaved,
        optimizedDomains: costEntries.length,
        avgCostEfficiency,
      },
      collectedAt: Date.now(),
    };
  }

  /**
   * Get CAPTCHA solver statistics.
   */
  async getCaptchaStats(): Promise<any> {
    try {
      const solver = await this.getCaptchaSolver();
      if (!solver) return { status: 'offline', error: 'CAPTCHA solver not available' };
      return solver.getStats();
    } catch {
      return { status: 'offline', error: 'CAPTCHA solver not available' };
    }
  }

  /**
   * Get Web Unlocker statistics.
   */
  async getWebUnlockerStats(): Promise<any> {
    try {
      const unlocker = await this.getWebUnlocker();
      if (!unlocker) return { status: 'offline', error: 'Web Unlocker not available' };
      return unlocker.getStats();
    } catch {
      return { status: 'offline', error: 'Web Unlocker not available' };
    }
  }

  /**
   * Get chain reaction statistics.
   */
  async getChainReactionStats(): Promise<any> {
    try {
      const chain = await this.getChainReaction();
      if (!chain) return { status: 'offline' };
      return chain.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get breeder reactor statistics.
   */
  async getBreederReactorStats(): Promise<any> {
    try {
      const breeder = await this.getBreederReactor();
      if (!breeder) return { status: 'offline' };
      return breeder.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get quantum tunnel statistics.
   */
  async getQuantumTunnelStats(): Promise<any> {
    try {
      const tunnel = await this.getQuantumTunnel();
      if (!tunnel) return { status: 'offline' };
      return tunnel.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get plasma state statistics.
   */
  async getPlasmaStateStats(): Promise<any> {
    try {
      const plasma = await this.getPlasmaState();
      if (!plasma) return { status: 'offline' };
      return plasma.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get containment shield statistics.
   */
  async getContainmentStats(): Promise<any> {
    try {
      const shield = await this.getContainmentShield();
      if (!shield) return { status: 'offline' };
      return shield.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get validation pipeline statistics.
   */
  async getValidationPipelineStats(): Promise<any> {
    try {
      const pipeline = await this.getValidationPipeline();
      if (!pipeline) return { status: 'offline' };
      return pipeline.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get rotating session factory statistics.
   */
  async getRotatingSessionFactoryStats(): Promise<any> {
    try {
      const factory = await this.getRotatingSessionFactory();
      if (!factory) return { status: 'offline' };
      return factory.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get free proxy discovery statistics.
   */
  async getFreeProxyDiscoveryStats(): Promise<any> {
    try {
      const discovery = await this.getFreeProxyDiscovery();
      if (!discovery) return { status: 'offline' };
      return discovery.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get TOR pool statistics.
   */
  async getTorPoolStats(): Promise<any> {
    try {
      const torPool = await this.getTorPool();
      if (!torPool) return { status: 'offline' };
      return torPool.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get bulk session statistics.
   */
  async getBulkSessionStats(): Promise<any> {
    try {
      const bulk = await this.getBulkSessionManager();
      if (!bulk) return { status: 'offline' };
      return bulk.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get subnet expander statistics.
   */
  async getSubnetExpanderStats(): Promise<any> {
    try {
      const expander = await this.getSubnetExpander();
      if (!expander) return { status: 'offline' };
      return expander.getStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get residential providers statistics.
   */
  getResidentialProvidersStats(): any {
    try {
      return residentialProxyManager.getProviderStats();
    } catch {
      return { status: 'offline' };
    }
  }

  /**
   * Get module health status for all modules.
   */
  getModuleHealthStatus(): Array<{
    name: string;
    status: 'healthy' | 'degraded' | 'offline';
    latencyMs: number;
    lastCheck: number;
    errorCount: number;
  }> {
    return Array.from(this.moduleHealth.values()).map(m => ({
      name: m.moduleName,
      status: m.available
        ? (m.consecutiveFailures === 0 ? 'healthy' as const : 'degraded' as const)
        : 'offline' as const,
      latencyMs: m.latencyMs,
      lastCheck: m.lastCheck,
      errorCount: m.errorCount,
    }));
  }

  /**
   * Get adaptive strategy state for a domain.
   */
  getAdaptiveStrategy(domain: string): AdaptiveStrategyState | undefined {
    return this.adaptiveStrategies.get(domain);
  }

  /**
   * Get cost optimization state for a domain.
   */
  getCostOptimization(domain: string): CostOptimizationState | undefined {
    return this.costOptimizationStates.get(domain);
  }

  // ===========================================================================
  // PUBLIC API -- LIFECYCLE MANAGEMENT
  // ===========================================================================

  /**
   * Start ALL pool management services.
   * This includes: health checks, pool monitor, reputation decay,
   * aggregator rebalancing, mega pool, fusion core, adaptive strategy,
   * cost optimization, module health monitoring, and stats aggregation.
   */
  startAllServices(): void {
    if (this.started) {
      logger.warn('Proxy manager services already started');
      return;
    }

    this.started = true;
    this.shutdownRequested = false;

    // -- Core services ----------------------------------------------------
    this.startHealthChecks();
    smartIPPool.startPoolMonitor();
    ipReputationTracker.startDecay();
    proxyAggregator.startRebalancing();
    residentialProxyManager.startHealthChecks(10_000); // 10s interval (was 300s)

    // -- Mega pool and all sub-services -----------------------------------
    megaPool.start().catch((err: any) => {
      logger.warn({ error: err.message }, 'Mega pool start failed -- fusion modules not available');
    });

    // -- Start lazy-loaded modules ----------------------------------------
    this.startLazyModules();

    // -- Advanced services ------------------------------------------------
    this.startAdaptiveStrategyEngine();
    this.startCostOptimizationEngine();
    this.startModuleHealthMonitor();
    this.startStatsAggregation();

    logger.info('All proxy pool management services started (including Nuclear Fusion system)');
  }

  /**
   * Stop ALL pool management services gracefully.
   */
  stopAllServices(): void {
    if (!this.started) return;

    this.shutdownRequested = true;

    // -- Stop core services -----------------------------------------------
    this.stopHealthChecks();
    smartIPPool.stopPoolMonitor();
    ipReputationTracker.stopDecay();
    proxyAggregator.stopRebalancing();
    residentialProxyManager.stopHealthChecks();

    // -- Stop mega pool ---------------------------------------------------
    megaPool.stop().catch((err: any) => {
      logger.warn({ error: err.message }, 'Mega pool stop failed');
    });

    // -- Stop lazy-loaded modules -----------------------------------------
    this.stopLazyModules();

    // -- Stop advanced services -------------------------------------------
    this.stopAdaptiveStrategyEngine();
    this.stopCostOptimizationEngine();
    this.stopModuleHealthMonitor();
    this.stopStatsAggregation();

    this.started = false;
    logger.info('All proxy pool management services stopped (including Nuclear Fusion system)');
  }

  /**
   * Start health checks (5s interval).
   */
  startHealthChecks(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      if (this.shutdownRequested) return;
      await this.runHealthChecks();
    }, HEALTH_CHECK_INTERVAL);

    logger.info({ intervalMs: HEALTH_CHECK_INTERVAL }, 'Proxy health check scheduler started');
  }

  /**
   * Stop health checks.
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ===========================================================================
  // PRIVATE -- STICKY SESSION MANAGEMENT
  // ===========================================================================

  private async checkStickySession(
    sessionId: string,
    tier: ProxyTier,
    domain: string,
  ): Promise<ProxySelection | null> {
    const stickyKey = `sticky:${sessionId}`;
    const sticky = this.stickySessions.get(stickyKey);
    if (sticky && sticky.expires > Date.now()) {
      const proxy = await this.getProxyById(sticky.proxyId);
      if (proxy && !proxy.retired) {
        return this.toSelection(proxy);
      }
      // Session expired or proxy retired -- remove
      this.stickySessions.delete(stickyKey);
    }
    return null;
  }

  // ===========================================================================
  // PRIVATE -- DOMAIN-OPTIMIZED PROXY SELECTION
  // ===========================================================================

  private async checkDomainOptimizedProxy(
    domain: string,
    tier: ProxyTier,
  ): Promise<ProxySelection | null> {
    const domainProxyId = this.domainProxyMap.get(domain);
    if (domainProxyId) {
      const proxy = await this.getProxyById(domainProxyId);
      if (proxy && !proxy.retired && proxy.tier === tier) {
        // Verify it's still healthy
        if (proxy.successRate > 0.5 && proxy.consecutiveFailures < 3) {
          return this.toSelection(proxy);
        }
        // Not healthy anymore -- remove from domain map
        this.domainProxyMap.delete(domain);
      }
    }

    // Also check domain intelligence for best proxy IDs
    const intel = this.getDomainIntelligence(domain);
    if (intel && intel.bestProxyIds.length > 0) {
      for (const proxyId of intel.bestProxyIds) {
        const proxy = await this.getProxyById(proxyId);
        if (proxy && !proxy.retired && proxy.tier === tier && proxy.successRate > 0.5) {
          return this.toSelection(proxy);
        }
      }
    }

    return null;
  }

  // ===========================================================================
  // PRIVATE -- EXTERNAL SOURCE FAILOVER
  // ===========================================================================

  private async tryExternalSourcesWithFailover(
    tier: string,
    country?: string,
    city?: string,
    asn?: string,
    domain?: string,
  ): Promise<ProxySelection | null> {
    const sources: Array<{
      name: string;
      getProxy: () => Promise<ProxySelection | null>;
    }> = [];

    // Source 1: Residential proxy providers
    sources.push({
      name: 'residential-providers',
      getProxy: () => this.getExternalProxy(tier, country, city, asn),
    });

    // Source 2: Smart IP pool
    sources.push({
      name: 'smart-ip-pool',
      getProxy: async () => {
        try {
          const result = await smartIPPool.getProxy({
            domain: domain || '',
            tier: tier as any,
            country,
            city,
            asn,
          });
          if (result) {
            return {
              proxyUrl: result.proxyUrl,
              proxyId: result.proxyId,
              country: result.country,
              tier: result.tier,
              city: result.city,
              asn: result.asn,
            };
          }
        } catch { /* ignore */ }
        return null;
      },
    });

    // Source 3: Aggregator
    sources.push({
      name: 'aggregator',
      getProxy: async () => {
        try {
          const result = await proxyAggregator.getProxy({
            domain: domain || '',
            tier: tier as any,
            country,
            city,
            asn,
          });
          if (result) {
            return {
              proxyUrl: result.proxyUrl,
              proxyId: result.proxyId,
              country: result.country,
              tier: result.tier,
              city: result.city,
              asn: result.asn,
            };
          }
        } catch { /* ignore */ }
        return null;
      },
    });

    // Source 4: Mega pool (fusion)
    sources.push({
      name: 'mega-pool',
      getProxy: async () => {
        try {
          const result = await megaPool.getProxy({
            domain: domain || '',
            tier: tier as any,
            country,
            city,
            asn,
          });
          if (result) {
            return {
              proxyUrl: result.proxyUrl,
              proxyId: result.proxyId,
              country: result.country,
              tier: result.tier,
              city: result.city,
              asn: result.asn,
            };
          }
        } catch { /* ignore */ }
        return null;
      },
    });

    // Source 5: TOR circuit
    sources.push({
      name: 'tor-circuit',
      getProxy: async () => {
        try {
          const torPool = await this.getTorPool();
          if (!torPool) return null;
          const circuit = await torPool.getCircuit({ exitCountry: country });
          if (circuit) {
            return {
              proxyUrl: circuit.socksUrl || torPool.getDefaultSocksUrl(),
              proxyId: circuit.id,
              country: circuit.exitCountry || '',
              tier: 'datacenter',
              city: undefined,
              asn: undefined,
            };
          }
        } catch { /* ignore */ }
        return null;
      },
    });

    // Source 6: Free proxy discovery
    sources.push({
      name: 'free-proxy',
      getProxy: async () => {
        try {
          const discovery = await this.getFreeProxyDiscovery();
          if (!discovery) return null;
          // Free proxies are a last resort -- don't actively fetch, just check cache
          return null;
        } catch { /* ignore */ }
        return null;
      },
    });

    // Try each source sequentially with failover
    for (const source of sources) {
      try {
        const result = await source.getProxy();
        if (result) {
          logger.debug({ source: source.name, tier, country }, 'External proxy source hit');
          return result;
        }
      } catch (err: any) {
        logger.debug({ source: source.name, error: err.message }, 'External proxy source failed');
      }
    }

    return null;
  }

  /**
   * Emergency fallback -- try absolutely anything to get a proxy.
   */
  private async emergencyFallback(
    domain: string,
    tier: ProxyTier,
    country?: string,
  ): Promise<ProxySelection | null> {
    try {
      // Try to get any non-retired proxy
      const anyProxy = await db.proxy.findFirst({
        where: { retired: false },
        orderBy: { successRate: 'desc' },
      });

      if (anyProxy) {
        logger.warn({ proxyId: anyProxy.id, domain }, 'Using emergency fallback proxy');
        return this.toSelection(anyProxy);
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'Emergency fallback failed');
    }

    return null;
  }

  // ===========================================================================
  // PRIVATE -- PROXY SELECTION STRATEGIES
  // ===========================================================================

  private selectProxy(
    proxies: any[],
    domain: string,
    strategy: RotationStrategy,
  ): any | null {
    if (proxies.length === 0) return null;

    switch (strategy) {
      case 'round-robin': {
        const key = domain;
        const idx = (this.roundRobinIndex.get(key) || 0) % proxies.length;
        this.roundRobinIndex.set(key, idx + 1);
        return proxies[idx];
      }

      case 'random': {
        return proxies[Math.floor(Math.random() * proxies.length)];
      }

      case 'weighted-random': {
        // Weight by success rate -- higher success rate = higher probability
        const totalWeight = proxies.reduce((sum, p) => sum + Math.max(p.successRate, 0.1), 0);
        let random = Math.random() * totalWeight;
        for (const proxy of proxies) {
          random -= Math.max(proxy.successRate, 0.1);
          if (random <= 0) return proxy;
        }
        return proxies[0];
      }

      case 'least-failures': {
        return [...proxies].sort((a, b) => {
          if (a.consecutiveFailures !== b.consecutiveFailures) {
            return a.consecutiveFailures - b.consecutiveFailures;
          }
          return b.successRate - a.successRate;
        })[0];
      }

      case 'fastest': {
        return [...proxies].sort((a, b) => a.p95Latency - b.p95Latency)[0];
      }

      case 'sticky': {
        return [...proxies].sort((a, b) => {
          if (a.consecutiveFailures !== b.consecutiveFailures) {
            return a.consecutiveFailures - b.consecutiveFailures;
          }
          return b.successRate - a.successRate;
        })[0];
      }

      case 'adaptive': {
        return this.selectAdaptiveProxy(proxies, domain);
      }

      case 'cost-optimized': {
        return this.selectCostOptimizedProxy(proxies, domain);
      }

      case 'reputation-weighted': {
        return this.selectReputationWeightedProxy(proxies, domain);
      }

      case 'domain-intelligent': {
        return this.selectDomainIntelligentProxy(proxies, domain);
      }

      default:
        return proxies[0];
    }
  }

  /**
   * Adaptive proxy selection -- uses domain intelligence to dynamically adjust.
   */
  private selectAdaptiveProxy(proxies: any[], domain: string): any {
    const intel = this.getDomainIntelligence(domain);
    const adaptiveState = this.adaptiveStrategies.get(domain);

    // If we have domain intelligence, prefer proxies that worked before
    if (intel && intel.bestProxyIds.length > 0) {
      for (const bestId of intel.bestProxyIds) {
        const proxy = proxies.find((p: any) => p.id === bestId);
        if (proxy && !proxy.retired && proxy.successRate > 0.5) {
          return proxy;
        }
      }
    }

    // If adaptive state suggests a strategy, use it
    if (adaptiveState?.optimalStrategy && adaptiveState.optimalStrategy !== 'adaptive') {
      return this.selectProxy(proxies, domain, adaptiveState.optimalStrategy);
    }

    // Default: weighted random with success rate bias
    return this.selectProxy(proxies, domain, 'weighted-random');
  }

  /**
   * Cost-optimized proxy selection -- minimize cost while maintaining success rate.
   */
  private selectCostOptimizedProxy(proxies: any[], domain: string): any {
    const costState = this.costOptimizationStates.get(domain);

    // Sort by: prefer cheaper providers, but maintain minimum success rate
    const sorted = [...proxies].sort((a, b) => {
      const aScore = this.computeCostScore(a, costState);
      const bScore = this.computeCostScore(b, costState);
      return bScore - aScore; // Higher score = better
    });

    return sorted[0];
  }

  /**
   * Compute a cost score for a proxy (higher is better).
   */
  private computeCostScore(proxy: any, costState?: CostOptimizationState): number {
    let score = proxy.successRate * 100; // Base: success rate is most important

    // Prefer datacenter over residential for cost
    if (proxy.tier === 'datacenter') score += 20;
    else if (proxy.tier === 'isp') score += 15;
    else if (proxy.tier === 'residential') score += 5;
    else if (proxy.tier === 'mobile') score += 0;

    // Penalize high latency
    score -= proxy.p95Latency / 100;

    // Penalize recent failures
    score -= proxy.consecutiveFailures * 10;

    // Bonus for cost-effective providers
    if (costState?.recommendedSource && proxy.provider === costState.recommendedSource) {
      score += 15;
    }

    return Math.max(score, 0);
  }

  /**
   * Reputation-weighted proxy selection -- use reputation data for selection.
   */
  private selectReputationWeightedProxy(proxies: any[], domain: string): any {
    // Sort by: reputation score > success rate > latency
    return [...proxies].sort((a, b) => {
      // First: success rate (proxy of reputation)
      const srDiff = b.successRate - a.successRate;
      if (Math.abs(srDiff) > 0.1) return srDiff;

      // Second: consecutive failures
      const cfDiff = a.consecutiveFailures - b.consecutiveFailures;
      if (cfDiff !== 0) return cfDiff;

      // Third: latency
      return a.p95Latency - b.p95Latency;
    })[0];
  }

  /**
   * Domain-intelligent proxy selection -- use all domain knowledge.
   */
  private selectDomainIntelligentProxy(proxies: any[], domain: string): any {
    const intel = this.getDomainIntelligence(domain);

    if (!intel) {
      return this.selectProxy(proxies, domain, 'least-failures');
    }

    // Score each proxy based on domain intelligence
    const scored = proxies.map((proxy: any) => {
      let score = 0;

      // Bonus for being in best proxy list
      if (intel.bestProxyIds.includes(proxy.id)) score += 50;

      // Penalty for being in worst proxy list
      if (intel.worstProxyIds.includes(proxy.id)) score -= 30;

      // Bonus for matching preferred tier
      if (proxy.tier === intel.preferredTier) score += 20;

      // Bonus for matching preferred country
      if (proxy.country === intel.preferredCountry) score += 15;

      // Standard health metrics
      score += proxy.successRate * 30;
      score -= proxy.consecutiveFailures * 10;
      score -= proxy.p95Latency / 200;

      // Stealth bonus
      if (intel.requiresStealth && (proxy.tier === 'residential' || proxy.tier === 'mobile')) {
        score += 25;
      }

      return { proxy, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.proxy ?? proxies[0];
  }

  /**
   * Resolve the effective strategy for a domain.
   */
  private resolveStrategy(
    domain: string,
    requested: RotationStrategy,
    intel?: DomainIntelligenceEntry,
  ): RotationStrategy {
    // If the user explicitly requested a non-default strategy, honor it
    if (requested !== 'least-failures' && requested !== 'adaptive') {
      return requested;
    }

    // Check adaptive strategy state
    const adaptiveState = this.adaptiveStrategies.get(domain);
    if (adaptiveState?.optimalStrategy) {
      return adaptiveState.optimalStrategy;
    }

    // Use domain intelligence to pick a strategy
    if (intel) {
      if (intel.requiresStealth) return 'domain-intelligent';
      if (intel.captchaFrequency > 0.5) return 'reputation-weighted';
      if (intel.requestCount > 100 && intel.successRate < 0.7) return 'adaptive';
      if (intel.requestCount > 50) return 'domain-intelligent';
    }

    // Default to the requested strategy
    return requested;
  }

  /**
   * Resolve the ultimate strategy considering CAPTCHA and anti-bot detection.
   */
  private resolveUltimateStrategy(
    domain: string,
    intel: DomainIntelligenceEntry | undefined,
    captcha: CaptchaDetectionResult,
    antibot: AntibotDetectionResult,
  ): RotationStrategy {
    if (antibot.detected && antibot.confidence > 0.7) return 'domain-intelligent';
    if (captcha.detected && captcha.confidence > 0.7) return 'reputation-weighted';
    if (intel?.requiresStealth) return 'domain-intelligent';
    if (intel && intel.requestCount > 50) return 'domain-intelligent';

    const adaptiveState = this.adaptiveStrategies.get(domain);
    if (adaptiveState?.optimalStrategy) return adaptiveState.optimalStrategy;

    return 'least-failures';
  }

  // ===========================================================================
  // PRIVATE -- DOMAIN INTELLIGENCE UPDATES
  // ===========================================================================

  private updateDomainIntelligenceFromOutcome(
    domain: string,
    proxyId: string,
    success: boolean,
    latencyMs: number,
    statusCode?: number,
  ): void {
    let intel = this.domainIntelligence.get(domain);

    if (!intel) {
      intel = {
        domain,
        bestProxyIds: [],
        worstProxyIds: [],
        requiresStealth: false,
        requiresCaptcha: false,
        preferredTier: 'residential',
        preferredCountry: '',
        averageLatency: 0,
        successRate: 0,
        captchaFrequency: 0,
        antibotFrequency: 0,
        costPerRequest: 0,
        lastUpdated: Date.now(),
        requestCount: 0,
        failoverChain: ['residential', 'mobile', 'isp', 'datacenter'],
      };
      this.domainIntelligence.set(domain, intel);
    }

    intel.requestCount++;
    intel.lastUpdated = Date.now();

    // Update success rate (EMA)
    const alpha = 0.1;
    intel.successRate = intel.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;

    // Update average latency (EMA)
    intel.averageLatency = intel.averageLatency * (1 - alpha) + latencyMs * alpha;

    // Update best/worst proxy lists
    if (success) {
      if (!intel.bestProxyIds.includes(proxyId)) {
        intel.bestProxyIds.unshift(proxyId);
        if (intel.bestProxyIds.length > 10) intel.bestProxyIds.pop();
      }
      // Remove from worst list if it was there
      intel.worstProxyIds = intel.worstProxyIds.filter(id => id !== proxyId);
    } else {
      if (!intel.worstProxyIds.includes(proxyId)) {
        intel.worstProxyIds.unshift(proxyId);
        if (intel.worstProxyIds.length > 10) intel.worstProxyIds.pop();
      }
      // Remove from best list if it was there
      intel.bestProxyIds = intel.bestProxyIds.filter(id => id !== proxyId);
    }

    // Detect CAPTCHA from status codes
    if (statusCode === 403 || statusCode === 429 || statusCode === 503) {
      intel.captchaFrequency = intel.captchaFrequency * (1 - alpha) + 1 * alpha;
      if (statusCode === 403) {
        intel.antibotFrequency = intel.antibotFrequency * (1 - alpha) + 1 * alpha;
        intel.requiresStealth = intel.antibotFrequency > 0.3;
      }
    } else {
      intel.captchaFrequency = intel.captchaFrequency * (1 - alpha);
      intel.antibotFrequency = intel.antibotFrequency * (1 - alpha);
    }

    // Auto-detect stealth requirement
    if (intel.antibotFrequency > 0.3) intel.requiresStealth = true;
    if (intel.captchaFrequency > 0.5) intel.requiresCaptcha = true;
  }

  private updateDomainIntelligenceFromResult(domain: string, result: IPPoolResult): void {
    let intel = this.domainIntelligence.get(domain);
    if (!intel) {
      intel = {
        domain,
        bestProxyIds: [],
        worstProxyIds: [],
        requiresStealth: false,
        requiresCaptcha: false,
        preferredTier: 'residential',
        preferredCountry: '',
        averageLatency: 0,
        successRate: 0,
        captchaFrequency: 0,
        antibotFrequency: 0,
        costPerRequest: 0,
        lastUpdated: Date.now(),
        requestCount: 0,
        failoverChain: ['residential', 'mobile', 'isp', 'datacenter'],
      };
      this.domainIntelligence.set(domain, intel);
    }

    intel.preferredCountry = result.country || intel.preferredCountry;
    intel.preferredTier = (result.tier as ProxyTier) || intel.preferredTier;
    intel.lastUpdated = Date.now();
  }

  private updateDomainIntelligenceFromAggregator(domain: string, result: any): void {
    let intel = this.domainIntelligence.get(domain);
    if (!intel) {
      intel = {
        domain,
        bestProxyIds: [],
        worstProxyIds: [],
        requiresStealth: false,
        requiresCaptcha: false,
        preferredTier: 'residential',
        preferredCountry: '',
        averageLatency: 0,
        successRate: 0,
        captchaFrequency: 0,
        antibotFrequency: 0,
        costPerRequest: 0,
        lastUpdated: Date.now(),
        requestCount: 0,
        failoverChain: ['residential', 'mobile', 'isp', 'datacenter'],
      };
      this.domainIntelligence.set(domain, intel);
    }

    intel.preferredCountry = result.country || intel.preferredCountry;
    intel.lastUpdated = Date.now();
  }

  private updateDomainIntelligenceFromMegaPool(domain: string, result: MegaPoolResult): void {
    let intel = this.domainIntelligence.get(domain);
    if (!intel) {
      intel = {
        domain,
        bestProxyIds: [],
        worstProxyIds: [],
        requiresStealth: false,
        requiresCaptcha: false,
        preferredTier: 'residential',
        preferredCountry: '',
        averageLatency: 0,
        successRate: 0,
        captchaFrequency: 0,
        antibotFrequency: 0,
        costPerRequest: 0,
        lastUpdated: Date.now(),
        requestCount: 0,
        failoverChain: ['residential', 'mobile', 'isp', 'datacenter'],
      };
      this.domainIntelligence.set(domain, intel);
    }

    intel.preferredCountry = result.country || intel.preferredCountry;
    intel.preferredTier = (result.tier as ProxyTier) || intel.preferredTier;
    intel.lastUpdated = Date.now();
  }

  // ===========================================================================
  // PRIVATE -- ADAPTIVE STRATEGY ENGINE
  // ===========================================================================

  private updateAdaptiveStrategyPerformance(
    domain: string,
    success: boolean,
    latency: number,
  ): void {
    let state = this.adaptiveStrategies.get(domain);

    if (!state) {
      state = {
        domain,
        currentStrategy: 'least-failures',
        previousStrategies: [],
        lastRotation: Date.now(),
        rotationCount: 0,
        performanceWindow: [],
        optimalStrategy: null,
      };
      this.adaptiveStrategies.set(domain, state);
    }

    // Add to performance window (keep last 100 results)
    state.performanceWindow.push({ timestamp: Date.now(), success, latency });
    if (state.performanceWindow.length > 100) {
      state.performanceWindow.shift();
    }

    // Evaluate optimal strategy every 50 requests
    if (state.performanceWindow.length % 50 === 0) {
      this.evaluateOptimalStrategy(domain, state);
    }
  }

  private evaluateOptimalStrategy(domain: string, state: AdaptiveStrategyState): void {
    const window = state.performanceWindow;
    if (window.length < 20) return;

    const recentSuccessRate = window.filter(w => w.success).length / window.length;
    const recentAvgLatency = window.reduce((sum, w) => sum + w.latency, 0) / window.length;

    // If success rate is too low, try rotating strategies
    if (recentSuccessRate < 0.5) {
      const strategies: RotationStrategy[] = [
        'domain-intelligent', 'reputation-weighted', 'weighted-random',
        'least-failures', 'fastest', 'cost-optimized',
      ];

      // Record current strategy performance
      state.previousStrategies.push({
        strategy: state.currentStrategy,
        successRate: recentSuccessRate,
        timestamp: Date.now(),
      });

      // Keep only last 20 strategy records
      if (state.previousStrategies.length > 20) {
        state.previousStrategies.shift();
      }

      // Find the best performing strategy from history
      const bestHistorical = state.previousStrategies
        .filter(s => s.successRate > recentSuccessRate)
        .sort((a, b) => b.successRate - a.successRate)[0];

      if (bestHistorical) {
        state.currentStrategy = bestHistorical.strategy;
        state.optimalStrategy = bestHistorical.strategy;
      } else {
        // Try a new strategy
        const currentIdx = strategies.indexOf(state.currentStrategy);
        const nextIdx = (currentIdx + 1) % strategies.length;
        state.currentStrategy = strategies[nextIdx];
        state.optimalStrategy = state.currentStrategy;
      }

      state.lastRotation = Date.now();
      state.rotationCount++;

      logger.debug({
        domain,
        strategy: state.currentStrategy,
        successRate: recentSuccessRate,
        avgLatency: recentAvgLatency,
      }, 'Adaptive strategy rotated');
    } else if (recentSuccessRate > 0.8) {
      // Success rate is good -- lock in the current strategy
      state.optimalStrategy = state.currentStrategy;
    }
  }

  private startAdaptiveStrategyEngine(): void {
    if (this.adaptiveStrategyTimer) return;

    this.adaptiveStrategyTimer = setInterval(() => {
      if (this.shutdownRequested) return;
      this.runAdaptiveStrategyCycle();
    }, ADAPTIVE_STRATEGY_INTERVAL);

    logger.info({ intervalMs: ADAPTIVE_STRATEGY_INTERVAL }, 'Adaptive strategy engine started');
  }

  private stopAdaptiveStrategyEngine(): void {
    if (this.adaptiveStrategyTimer) {
      clearInterval(this.adaptiveStrategyTimer);
      this.adaptiveStrategyTimer = null;
    }
  }

  private runAdaptiveStrategyCycle(): void {
    // Evaluate adaptive strategies for all tracked domains
    for (const [domain, state] of this.adaptiveStrategies.entries()) {
      try {
        // Clean up old performance data (older than 1 hour)
        const cutoff = Date.now() - 3_600_000;
        state.performanceWindow = state.performanceWindow.filter(w => w.timestamp > cutoff);

        // Evaluate if we have enough data
        if (state.performanceWindow.length >= 20) {
          this.evaluateOptimalStrategy(domain, state);
        }
      } catch (err: any) {
        logger.debug({ domain, error: err.message }, 'Adaptive strategy cycle failed for domain');
      }
    }

    // Clean up stale domain intelligence entries (older than 24 hours)
    const staleCutoff = Date.now() - 86_400_000;
    for (const [domain, intel] of this.domainIntelligence.entries()) {
      if (intel.lastUpdated < staleCutoff && intel.requestCount < 10) {
        this.domainIntelligence.delete(domain);
        this.adaptiveStrategies.delete(domain);
      }
    }
  }

  // ===========================================================================
  // PRIVATE -- COST OPTIMIZATION ENGINE
  // ===========================================================================

  private updateCostOptimizationFromOutcome(
    domain: string,
    proxyId: string,
    success: boolean,
  ): void {
    let state = this.costOptimizationStates.get(domain);

    if (!state) {
      state = {
        domain,
        costHistory: [],
        cheapestSource: null,
        costEfficiencyScore: 0,
        recommendedTier: null,
        recommendedSource: null,
        lastOptimized: Date.now(),
      };
      this.costOptimizationStates.set(domain, state);
    }

    // Record cost data point
    state.costHistory.push({
      timestamp: Date.now(),
      cost: success ? 0.001 : 0.01, // Approximate cost
      success,
      source: proxyId,
    });

    // Keep last 100 entries
    if (state.costHistory.length > 100) {
      state.costHistory.shift();
    }
  }

  private startCostOptimizationEngine(): void {
    if (this.costOptimizationTimer) return;

    this.costOptimizationTimer = setInterval(() => {
      if (this.shutdownRequested) return;
      this.runCostOptimizationCycle();
    }, COST_OPTIMIZATION_INTERVAL);

    logger.info({ intervalMs: COST_OPTIMIZATION_INTERVAL }, 'Cost optimization engine started');
  }

  private stopCostOptimizationEngine(): void {
    if (this.costOptimizationTimer) {
      clearInterval(this.costOptimizationTimer);
      this.costOptimizationTimer = null;
    }
  }

  private runCostOptimizationCycle(): void {
    for (const [domain, state] of this.costOptimizationStates.entries()) {
      try {
        // Clean old cost data
        const cutoff = Date.now() - 86_400_000;
        state.costHistory = state.costHistory.filter(c => c.timestamp > cutoff);

        if (state.costHistory.length < 10) continue;

        // Calculate cost efficiency (success rate per unit cost)
        const successes = state.costHistory.filter(c => c.success).length;
        const totalCost = state.costHistory.reduce((sum, c) => sum + c.cost, 0);
        state.costEfficiencyScore = totalCost > 0 ? successes / totalCost : 0;

        // Find cheapest source
        const sourceMap = new Map<string, { cost: number; successes: number; total: number }>();
        for (const entry of state.costHistory) {
          const existing = sourceMap.get(entry.source) || { cost: 0, successes: 0, total: 0 };
          existing.cost += entry.cost;
          existing.successes += entry.success ? 1 : 0;
          existing.total += 1;
          sourceMap.set(entry.source, existing);
        }

        let bestSource: string | null = null;
        let bestEfficiency = 0;
        for (const [source, data] of sourceMap.entries()) {
          const efficiency = data.cost > 0 ? data.successes / data.cost : 0;
          if (efficiency > bestEfficiency && data.total >= 3) {
            bestEfficiency = efficiency;
            bestSource = source;
          }
        }

        state.cheapestSource = bestSource;
        state.recommendedSource = bestSource;
        state.lastOptimized = Date.now();
      } catch (err: any) {
        logger.debug({ domain, error: err.message }, 'Cost optimization cycle failed for domain');
      }
    }
  }

  // ===========================================================================
  // PRIVATE -- MODULE HEALTH MONITORING
  // ===========================================================================

  private initializeModuleHealth(): void {
    const moduleNames = [
      'fusion-core', 'chain-reaction', 'breeder-reactor', 'quantum-tunnel',
      'plasma-state', 'containment', 'mega-pool', 'captcha-solver',
      'web-unlocker', 'validation-pipeline', 'rotating-session-factory',
      'free-proxy-discovery', 'tor-pool', 'bulk-sessions', 'subnet-expander',
      'residential-providers', 'ip-pool', 'aggregator', 'reputation',
    ];

    for (const name of moduleNames) {
      if (!this.moduleHealth.has(name)) {
        this.moduleHealth.set(name, {
          moduleName: name,
          available: false,
          lastCheck: 0,
          consecutiveFailures: 0,
          latencyMs: 0,
          errorCount: 0,
          lastError: null,
        });
      }
    }
  }

  private startModuleHealthMonitor(): void {
    this.initializeModuleHealth();

    if (this.moduleHealthTimer) return;

    this.moduleHealthTimer = setInterval(() => {
      if (this.shutdownRequested) return;
      this.runModuleHealthCheck();
    }, MODULE_HEALTH_CHECK_INTERVAL);

    logger.info({ intervalMs: MODULE_HEALTH_CHECK_INTERVAL }, 'Module health monitor started');
  }

  private stopModuleHealthMonitor(): void {
    if (this.moduleHealthTimer) {
      clearInterval(this.moduleHealthTimer);
      this.moduleHealthTimer = null;
    }
  }

  private async runModuleHealthCheck(): Promise<void> {
    const healthChecks: Array<{ name: string; check: () => Promise<boolean> }> = [
      { name: 'fusion-core', check: async () => { const m = await this.getFusionCore(); return m !== null; } },
      { name: 'chain-reaction', check: async () => { const m = await this.getChainReaction(); return m !== null; } },
      { name: 'breeder-reactor', check: async () => { const m = await this.getBreederReactor(); return m !== null; } },
      { name: 'quantum-tunnel', check: async () => { const m = await this.getQuantumTunnel(); return m !== null; } },
      { name: 'plasma-state', check: async () => { const m = await this.getPlasmaState(); return m !== null; } },
      { name: 'containment', check: async () => { const m = await this.getContainmentShield(); return m !== null; } },
      { name: 'mega-pool', check: async () => { try { await megaPool.getStats(); return true; } catch { return false; } } },
      { name: 'captcha-solver', check: async () => { const m = await this.getCaptchaSolver(); return m !== null; } },
      { name: 'web-unlocker', check: async () => { const m = await this.getWebUnlocker(); return m !== null; } },
      { name: 'validation-pipeline', check: async () => { const m = await this.getValidationPipeline(); return m !== null; } },
      { name: 'rotating-session-factory', check: async () => { const m = await this.getRotatingSessionFactory(); return m !== null; } },
      { name: 'free-proxy-discovery', check: async () => { const m = await this.getFreeProxyDiscovery(); return m !== null; } },
      { name: 'tor-pool', check: async () => { const m = await this.getTorPool(); return m !== null; } },
      { name: 'bulk-sessions', check: async () => { const m = await this.getBulkSessionManager(); return m !== null; } },
      { name: 'subnet-expander', check: async () => { const m = await this.getSubnetExpander(); return m !== null; } },
      { name: 'residential-providers', check: async () => true },
      { name: 'ip-pool', check: async () => { try { await smartIPPool.getPoolStats(); return true; } catch { return false; } } },
      { name: 'aggregator', check: async () => { try { await proxyAggregator.getComposition(); return true; } catch { return false; } } },
      { name: 'reputation', check: async () => true },
    ];

    const results = await Promise.allSettled(
      healthChecks.map(async ({ name, check }) => {
        const start = Date.now();
        try {
          const available = await check();
          const latencyMs = Date.now() - start;

          const health = this.moduleHealth.get(name);
          if (health) {
            health.available = available;
            health.lastCheck = Date.now();
            health.latencyMs = latencyMs;
            if (available) {
              health.consecutiveFailures = 0;
            } else {
              health.consecutiveFailures++;
              health.errorCount++;
            }
          }

          return { name, available, latencyMs };
        } catch (err: any) {
          const health = this.moduleHealth.get(name);
          if (health) {
            health.available = false;
            health.lastCheck = Date.now();
            health.consecutiveFailures++;
            health.errorCount++;
            health.lastError = err.message;
          }
          return { name, available: false, latencyMs: Date.now() - start };
        }
      }),
    );

    const healthyCount = results.filter(r => r.status === 'fulfilled' && r.value.available).length;
    const totalCount = results.length;

    logger.debug({ healthy: healthyCount, total: totalCount }, 'Module health check completed');
  }

  // ===========================================================================
  // PRIVATE -- STATS AGGREGATION
  // ===========================================================================

  private startStatsAggregation(): void {
    if (this.statsAggregationTimer) return;

    this.statsAggregationTimer = setInterval(async () => {
      if (this.shutdownRequested) return;
      try {
        this.lastAggregatedStats = await this.getUnifiedPoolStats();
      } catch (err: any) {
        logger.debug({ error: err.message }, 'Stats aggregation cycle failed');
      }
    }, STATS_AGGREGATION_INTERVAL);

    logger.info({ intervalMs: STATS_AGGREGATION_INTERVAL }, 'Stats aggregation started');
  }

  private stopStatsAggregation(): void {
    if (this.statsAggregationTimer) {
      clearInterval(this.statsAggregationTimer);
      this.statsAggregationTimer = null;
    }
  }

  /**
   * Get the last cached aggregated stats (non-blocking).
   */
  getCachedStats(): UnifiedPoolStats | null {
    return this.lastAggregatedStats;
  }

  // ===========================================================================
  // PRIVATE -- LAZY MODULE START/STOP
  // ===========================================================================

  private async startLazyModules(): Promise<void> {
    const startResults = await Promise.allSettled([
      (async () => { const m = await this.getValidationPipeline(); m?.startPipeline?.(10_000); })(),
      (async () => { const m = await this.getRotatingSessionFactory(); m?.startFactory?.(); })(),
      (async () => { const m = await this.getFreeProxyDiscovery(); m?.startDiscovery?.(10_000); })(),
      (async () => { const m = await this.getTorPool(); m?.startPool?.(10_000); })(),
      (async () => { const m = await this.getBulkSessionManager(); m?.startManager?.(10_000); })(),
      (async () => { const m = await this.getSubnetExpander(); m?.startExpander?.(); })(),
    ]);

    const failures = startResults.filter(r => r.status === 'rejected').length;
    if (failures > 0) {
      logger.debug({ failures }, 'Some lazy modules failed to start');
    }
  }

  private async stopLazyModules(): Promise<void> {
    const stopResults = await Promise.allSettled([
      (async () => { const m = await this.getValidationPipeline(); m?.stopPipeline?.(); })(),
      (async () => { const m = await this.getRotatingSessionFactory(); m?.stopFactory?.(); })(),
      (async () => { const m = await this.getFreeProxyDiscovery(); m?.stopDiscovery?.(); })(),
      (async () => { const m = await this.getTorPool(); m?.stopPool?.(); })(),
      (async () => { const m = await this.getBulkSessionManager(); m?.stopManager?.(); })(),
      (async () => { const m = await this.getSubnetExpander(); m?.stopExpander?.(); })(),
      (async () => { const m = await this.getWebUnlocker(); m?.shutdown?.(); })(),
    ]);

    const failures = stopResults.filter(r => r.status === 'rejected').length;
    if (failures > 0) {
      logger.debug({ failures }, 'Some lazy modules failed to stop');
    }
  }

  // ===========================================================================
  // PRIVATE -- HEALTH CHECKS
  // ===========================================================================

  private async runHealthChecks(): Promise<void> {
    logger.debug('Running proxy health checks...');

    const activeProxies = await db.proxy.findMany({
      where: { retired: false },
      select: { id: true, url: true, tier: true },
      take: 50, // Limit concurrent health checks
    });

    let checked = 0;
    let healthy = 0;
    let failed = 0;

    // Run health checks in batches of 10
    const batchSize = 10;
    for (let i = 0; i < activeProxies.length; i += batchSize) {
      const batch = activeProxies.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (proxy) => {
          try {
            const result = await testProxy(proxy.url, 'https://httpbin.org/ip', 10_000);

            if (result.working) {
              healthy++;
              await db.proxy.update({
                where: { id: proxy.id },
                data: {
                  lastChecked: new Date(),
                  successRate: { increment: 0.01 },
                  p95Latency: result.latencyMs,
                },
              });
            } else {
              failed++;
              await db.proxy.update({
                where: { id: proxy.id },
                data: {
                  consecutiveFailures: { increment: 1 },
                  lastChecked: new Date(),
                },
              });
            }

            return { id: proxy.id, ok: result.working, latency: result.latencyMs, ip: result.ip };
          } catch (err: any) {
            failed++;
            await db.proxy.update({
              where: { id: proxy.id },
              data: {
                consecutiveFailures: { increment: 1 },
                lastChecked: new Date(),
              },
            });
            return { id: proxy.id, ok: false, latency: 0, error: err.message };
          }
        }),
      );

      checked += results.length;
    }

    logger.debug({ checked, healthy, failed }, 'Proxy health checks completed');
  }

  // ===========================================================================
  // PRIVATE -- UTILITY METHODS
  // ===========================================================================

  private async getAvailableProxies(
    tier: string,
    country?: string,
    city?: string,
    asn?: string,
  ): Promise<any[]> {
    const cacheKey = `proxies:${tier}:${country || 'all'}:${city || 'all'}:${asn || 'all'}`;

    const cached = await cacheGet<any[]>(cacheKey);
    if (cached) return cached;

    const where: any = { tier: tier as any, retired: false };
    if (country) where.country = country.toUpperCase();
    if (city) where.city = city;
    if (asn) where.asn = asn;

    // Prioritize proxies with higher success rates
    const proxies = await db.proxy.findMany({
      where,
      orderBy: [
        { successRate: 'desc' },
        { p95Latency: 'asc' },
      ],
    });

    await cacheSet(cacheKey, proxies, PROXY_CACHE_TTL);
    return proxies;
  }

  private async getProxyById(id: string): Promise<any | null> {
    return db.proxy.findUnique({ where: { id } });
  }

  private toSelection(proxy: any): ProxySelection {
    return {
      proxyUrl: proxy.url,
      proxyId: proxy.id,
      country: proxy.country,
      tier: proxy.tier,
      city: proxy.city || undefined,
      asn: proxy.asn || undefined,
    };
  }

  private async getExternalProxy(
    tier: string,
    country?: string,
    city?: string,
    asn?: string,
  ): Promise<ProxySelection | null> {
    try {
      const result = await residentialProxyManager.getProxy({
        country,
        city,
        asn,
        tier: tier as any,
      });

      if (result) {
        return {
          proxyUrl: result.proxyUrl,
          proxyId: result.proxyId,
          country: result.country,
          tier: result.tier,
          city: result.city,
          asn: result.asn,
        };
      }
    } catch (err: any) {
      logger.warn({ tier, country, error: err.message }, 'Residential proxy provider error');
    }

    logger.warn({ tier, country, city, asn }, 'No external proxy provider configured');
    return null;
  }

  private async finalizeProxySelection(
    selected: any,
    domain: string,
    options?: { sessionId?: string },
  ): Promise<void> {
    // Update last used timestamp
    db.proxy.update({
      where: { id: selected.id },
      data: { lastUsed: new Date() },
    }).catch(() => {});

    // Set sticky session if requested
    if (options?.sessionId) {
      this.stickySessions.set(`sticky:${options.sessionId}`, {
        proxyId: selected.id,
        expires: Date.now() + STICKY_SESSION_TTL,
      });
    }

    // Remember domain-optimized proxy
    this.domainProxyMap.set(domain, selected.id);
  }

  private async reportRetiredProxy(proxyId: string, domain: string): Promise<void> {
    try {
      const shield = await this.getContainmentShield();
      if (shield) {
        await shield.checkProxy(proxyId);
      }
    } catch { /* ignore */ }
  }

  private async prewarmCaptchaSolver(domain: string): Promise<void> {
    try {
      const solver = await this.getCaptchaSolver();
      if (solver) {
        // Pre-warm by checking balances
        await solver.getBalances?.();
      }
    } catch { /* ignore */ }
  }

  private async getModuleStats(name: string, loader: () => Promise<any>): Promise<any> {
    try {
      const mod = await loader();
      if (!mod) return { status: 'offline', module: name };
      if (typeof mod.getStats === 'function') return mod.getStats();
      return { status: 'available', module: name };
    } catch (err: any) {
      return { status: 'error', module: name, error: err.message };
    }
  }

  private settledValue<T>(result: PromiseSettledResult<T>): T | null {
    if (result.status === 'fulfilled') return result.value;
    return null;
  }

  // ===========================================================================
  // PRIVATE -- CLEANUP & MAINTENANCE
  // ===========================================================================

  /**
   * Clean up expired sticky sessions.
   */
  cleanupStickySessions(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this.stickySessions.entries()) {
      if (session.expires <= now) {
        this.stickySessions.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Clean up stale domain proxy mappings.
   */
  cleanupDomainProxyMap(): number {
    let cleaned = 0;

    for (const [domain, proxyId] of this.domainProxyMap.entries()) {
      // We'll verify these lazily on next access
      // Just clean up entries that are clearly stale
      const intel = this.domainIntelligence.get(domain);
      if (intel && intel.worstProxyIds.includes(proxyId)) {
        this.domainProxyMap.delete(domain);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Run comprehensive cleanup.
   */
  async runCleanup(): Promise<{
    stickySessionsCleaned: number;
    domainProxyMapCleaned: number;
    cacheKeysCleared: number;
  }> {
    const stickySessionsCleaned = this.cleanupStickySessions();
    const domainProxyMapCleaned = this.cleanupDomainProxyMap();

    // Clear stale cache keys
    let cacheKeysCleared = 0;
    try {
      const keys = await redis.keys('proxies:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        cacheKeysCleared = keys.length;
      }
    } catch { /* ignore */ }

    logger.info({
      stickySessionsCleaned,
      domainProxyMapCleaned,
      cacheKeysCleared,
    }, 'Cleanup completed');

    return { stickySessionsCleaned, domainProxyMapCleaned, cacheKeysCleared };
  }

  /**
   * Get a comprehensive diagnostic report.
   */
  async getDiagnosticReport(): Promise<{
    manager: {
      started: boolean;
      stickySessionsCount: number;
      domainProxyMapSize: number;
      domainIntelligenceEntries: number;
      adaptiveStrategies: number;
      costOptimizationEntries: number;
      roundRobinIndexSize: number;
    };
    moduleHealth: Array<{
      name: string;
      status: 'healthy' | 'degraded' | 'offline';
      latencyMs: number;
      errorCount: number;
    }>;
    topProblematicDomains: Array<{
      domain: string;
      successRate: number;
      requestCount: number;
      requiresStealth: boolean;
      requiresCaptcha: boolean;
    }>;
    poolOverview: {
      totalProxies: number;
      activeProxies: number;
      retiredProxies: number;
      avgSuccessRate: number;
    };
  }> {
    const [totalProxies, activeProxies, retiredProxies] = await Promise.all([
      db.proxy.count().catch(() => 0),
      db.proxy.count({ where: { retired: false } }).catch(() => 0),
      db.proxy.count({ where: { retired: true } }).catch(() => 0),
    ]);

    const intelEntries = Array.from(this.domainIntelligence.values());
    const topProblematic = intelEntries
      .filter(e => e.requestCount > 10)
      .sort((a, b) => a.successRate - b.successRate)
      .slice(0, 10);

    return {
      manager: {
        started: this.started,
        stickySessionsCount: this.stickySessions.size,
        domainProxyMapSize: this.domainProxyMap.size,
        domainIntelligenceEntries: this.domainIntelligence.size,
        adaptiveStrategies: this.adaptiveStrategies.size,
        costOptimizationEntries: this.costOptimizationStates.size,
        roundRobinIndexSize: this.roundRobinIndex.size,
      },
      moduleHealth: this.getModuleHealthStatus(),
      topProblematicDomains: topProblematic.map(e => ({
        domain: e.domain,
        successRate: Math.round(e.successRate * 100) / 100,
        requestCount: e.requestCount,
        requiresStealth: e.requiresStealth,
        requiresCaptcha: e.requiresCaptcha,
      })),
      poolOverview: {
        totalProxies,
        activeProxies,
        retiredProxies,
        avgSuccessRate: 0, // Would need a query; approximate
      },
    };
  }

  /**
   * Reset domain intelligence for a specific domain.
   */
  resetDomainIntelligence(domain: string): void {
    this.domainIntelligence.delete(domain);
    this.domainProxyMap.delete(domain);
    this.adaptiveStrategies.delete(domain);
    this.costOptimizationStates.delete(domain);
    this.roundRobinIndex.delete(domain);
  }

  /**
   * Reset all domain intelligence.
   */
  resetAllDomainIntelligence(): void {
    this.domainIntelligence.clear();
    this.domainProxyMap.clear();
    this.adaptiveStrategies.clear();
    this.costOptimizationStates.clear();
    this.roundRobinIndex.clear();
    this.stickySessions.clear();
  }
}

// --- Singleton ----------------------------------------------------------------

export const proxyManager = new ProxyManager();
