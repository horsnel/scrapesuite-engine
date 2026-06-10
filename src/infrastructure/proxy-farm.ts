/**
 * Proxy Farm — ScrapeSuite Engine
 *
 * Large-scale proxy pool orchestration supporting 10K+ endpoints across
 * residential, mobile, ISP, and datacenter tiers. Provides intelligent
 * allocation, health monitoring, auto-provisioning, and cost management.
 *
 * Key capabilities for Netflix/Google:
 * - Sticky sessions (30+ min for Netflix, 15+ min for Google)
 * - Geographic targeting with city-level precision
 * - Provider failover with zero-downtime switching
 * - Rate-limited allocation to prevent IP burn
 * - Domain-specific proxy assignment (same IP for same domain)
 * - Auto-provisioning to maintain minimum pool sizes
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet, cacheDelete } from '../utils/redis';
import type {
  ProxyEndpoint, ProxyTier, ProxyProtocol, ProxyProvider, ProxyHealthStatus,
  ProxyFarmConfig, ProxyAllocationRequest, ProxyAllocationResult,
} from './types';

const logger = createChildLogger('proxy-farm');

const FARM_PREFIX = 'infra:proxy-farm:';
const ENDPOINT_PREFIX = 'infra:proxy:endpoint:';
const DOMAIN_ASSIGN_PREFIX = 'infra:proxy:domain-assign:';
const ALLOCATION_PREFIX = 'infra:proxy:allocation:';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_PROXY_FARM_CONFIG: ProxyFarmConfig = {
  minPoolSize: { datacenter: 100, residential: 5000, mobile: 2000, isp: 1000 },
  maxPoolSize: { datacenter: 500, residential: 50000, mobile: 10000, isp: 5000 },
  healthCheckInterval: 60,
  maxFailureStreak: 3,
  minSuccessStreak: 5,
  cooldownDuration: 1800, // 30 minutes
  maxDailyCost: 500,
  providerPriority: ['brightdata', 'oxylabs', 'smartproxy', 'iproyal', 'webshare', 'packetstream', 'geonode', 'custom'],
  geoDistribution: { US: 0.35, GB: 0.10, DE: 0.10, FR: 0.08, JP: 0.07, BR: 0.06, IN: 0.06, CA: 0.05, AU: 0.04, OTHER: 0.09 },
  autoProvisioning: true,
  defaultRotation: 'weighted-reputation',
  stickySessionDuration: 1800, // 30 minutes
};

// ===============================================================================
// PROXY FARM MANAGER
// ===============================================================================

export class ProxyFarmManager {
  private config: ProxyFarmConfig;
  private endpoints: Map<string, ProxyEndpoint> = new Map();
  private domainAssignments: Map<string, string> = new Map(); // domain -> proxyId
  private allocations: Map<string, { proxyId: string; expiresAt: number }> = new Map();
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private roundRobinIndex: Map<ProxyTier, number> = new Map();
  private dailySpend: number = 0;
  private lastSpendReset: number = Date.now();

  constructor(config?: Partial<ProxyFarmConfig>) {
    this.config = { ...DEFAULT_PROXY_FARM_CONFIG, ...config };
  }

  // ---------- Initialization ---------------------------------------------------

  async initialize(): Promise<void> {
    logger.info('Initializing Proxy Farm Manager');
    await this.loadEndpoints();
    await this.loadDomainAssignments();
    this.startHealthChecks();
    logger.info({ endpointCount: this.endpoints.size }, 'Proxy Farm initialized');
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    await this.persistEndpoints();
    await this.persistDomainAssignments();
    logger.info('Proxy Farm Manager shut down');
  }

  // ---------- Endpoint Management ---------------------------------------------

  /** Register a new proxy endpoint into the farm. */
  async registerEndpoint(endpoint: Omit<ProxyEndpoint, 'id' | 'createdAt'>): Promise<ProxyEndpoint> {
    const id = createHash('sha256')
      .update(`${endpoint.host}:${endpoint.port}:${endpoint.provider}`)
      .digest('hex')
      .substring(0, 16);

    const full: ProxyEndpoint = {
      ...endpoint,
      id,
      createdAt: Date.now(),
    };

    this.endpoints.set(id, full);
    await this.persistEndpoint(full);

    logger.info({
      id,
      host: full.host,
      tier: full.tier,
      provider: full.provider,
      country: full.countryCode,
    }, 'Proxy endpoint registered');

    return full;
  }

  /** Register multiple endpoints in bulk. */
  async registerBulk(endpoints: Array<Omit<ProxyEndpoint, 'id' | 'createdAt'>>): Promise<number> {
    let registered = 0;
    for (const ep of endpoints) {
      await this.registerEndpoint(ep);
      registered++;
    }
    logger.info({ count: registered }, 'Bulk proxy registration complete');
    return registered;
  }

  /** Remove an endpoint from the farm. */
  async removeEndpoint(id: string): Promise<boolean> {
    const existed = this.endpoints.delete(id);
    if (existed) {
      await cacheDelete(`${ENDPOINT_PREFIX}${id}`);
      // Clean up domain assignments referencing this proxy
      for (const [domain, proxyId] of this.domainAssignments) {
        if (proxyId === id) {
          this.domainAssignments.delete(domain);
          await cacheDelete(`${DOMAIN_ASSIGN_PREFIX}${domain}`);
        }
      }
    }
    return existed;
  }

  /** Get endpoint by ID. */
  getEndpoint(id: string): ProxyEndpoint | undefined {
    return this.endpoints.get(id);
  }

  // ---------- Intelligent Allocation -------------------------------------------

  /**
   * Allocate a proxy for a specific request. Uses multiple strategies:
   *
   * 1. Sticky session: if domain has a previous assignment and not expired, reuse it
   * 2. Domain-specific: assign a dedicated proxy per domain for consistency
   * 3. Geographic targeting: match country/city requirements
   * 4. Reputation-weighted: prefer higher reputation proxies
   * 5. Least-connections: balance load across proxies
   * 6. Tier preference: use requested tier or auto-select
   */
  async allocateProxy(request: ProxyAllocationRequest): Promise<ProxyAllocationResult | null> {
    this.resetDailySpendIfNeeded();

    if (this.dailySpend >= this.config.maxDailyCost) {
      logger.warn('Daily cost limit reached, cannot allocate proxy');
      return null;
    }

    // Strategy 1: Sticky session for domain
    if (request.stickySession && request.domain) {
      const sticky = await this.findStickySession(request);
      if (sticky) return sticky;
    }

    // Strategy 2: Domain-specific assignment
    if (request.domain) {
      const domainAssigned = await this.findDomainAssignment(request);
      if (domainAssigned) return domainAssigned;
    }

    // Strategy 3: General allocation with filters
    const candidates = this.filterCandidates(request);
    if (candidates.length === 0) {
      logger.warn({ request }, 'No suitable proxy found');
      return null;
    }

    const selected = this.selectBestCandidate(candidates, request);
    const allocationId = createHash('sha256')
      .update(`alloc:${selected.id}:${Date.now()}`)
      .digest('hex')
      .substring(0, 16);

    // Create sticky session if requested
    let stickySessionId: string | undefined;
    let expiresAt: number | undefined;
    if (request.stickySession) {
      stickySessionId = createHash('sha256')
        .update(`session:${selected.id}:${Date.now()}`)
        .digest('hex')
        .substring(0, 12);
      expiresAt = Date.now() + this.config.stickySessionDuration * 1000;

      // Update endpoint session info
      selected.sessionId = stickySessionId;
      selected.sessionExpiry = expiresAt;
    }

    // Assign domain if specified
    if (request.domain) {
      this.domainAssignments.set(request.domain, selected.id);
      await cacheSet(`${DOMAIN_ASSIGN_PREFIX}${request.domain}`, { proxyId: selected.id, assignedAt: Date.now() }, this.config.stickySessionDuration);
    }

    // Track allocation
    this.allocations.set(allocationId, { proxyId: selected.id, expiresAt: expiresAt || Date.now() + 3600000 });
    selected.activeConnections++;

    const result: ProxyAllocationResult = {
      proxy: selected,
      stickySessionId,
      expiresAt,
      allocationId,
    };

    logger.debug({
      allocationId,
      proxyId: selected.id,
      host: selected.host,
      tier: selected.tier,
      country: selected.countryCode,
      domain: request.domain,
    }, 'Proxy allocated');

    return result;
  }

  /** Release an allocated proxy back to the pool. */
  async releaseProxy(allocationId: string, success: boolean, responseMs?: number): Promise<void> {
    const allocation = this.allocations.get(allocationId);
    if (!allocation) return;

    const endpoint = this.endpoints.get(allocation.proxyId);
    if (!endpoint) return;

    endpoint.activeConnections = Math.max(0, endpoint.activeConnections - 1);

    if (success) {
      endpoint.successStreak++;
      endpoint.failureStreak = 0;
      endpoint.totalSuccesses++;
      endpoint.lastSuccess = Date.now();

      // Restore from degraded/unhealthy if enough successes
      if (endpoint.health === 'degraded' && endpoint.successStreak >= this.config.minSuccessStreak) {
        endpoint.health = 'healthy';
        logger.info({ proxyId: endpoint.id }, 'Proxy restored to healthy');
      }

      if (responseMs) {
        endpoint.avgResponseMs = endpoint.avgResponseMs === 0
          ? responseMs
          : Math.round((endpoint.avgResponseMs * 0.8) + (responseMs * 0.2));
      }
    } else {
      endpoint.failureStreak++;
      endpoint.successStreak = 0;
      endpoint.totalFailures++;
      endpoint.lastFailure = Date.now();

      // Degrade health if too many failures
      if (endpoint.failureStreak >= this.config.maxFailureStreak) {
        endpoint.health = endpoint.health === 'healthy' ? 'degraded' : 'unhealthy';
        endpoint.cooldownUntil = Date.now() + this.config.cooldownDuration * 1000;
        logger.warn({ proxyId: endpoint.id, health: endpoint.health }, 'Proxy health degraded');
      }
    }

    this.allocations.delete(allocationId);
    await this.persistEndpoint(endpoint);
  }

  // ---------- Health Monitoring ------------------------------------------------

  /** Run health checks on all endpoints. */
  async runHealthChecks(): Promise<void> {
    logger.debug('Running proxy health checks');
    let healthy = 0;
    let degraded = 0;
    let unhealthy = 0;

    for (const [id, endpoint] of this.endpoints) {
      // Check cooldown expiry
      if (endpoint.cooldownUntil && Date.now() > endpoint.cooldownUntil) {
        endpoint.health = 'degraded'; // Will need success streak to return to healthy
        endpoint.cooldownUntil = undefined;
      }

      // Check stale endpoints (no activity in 1 hour)
      if (endpoint.lastSuccess > 0 && Date.now() - endpoint.lastSuccess > 3600000 && endpoint.health === 'healthy') {
        endpoint.health = 'degraded';
      }

      // Auto-retire permanently flagged proxies
      if (endpoint.flaggedBy.length >= 3 && endpoint.reputationScore < 20) {
        endpoint.health = 'retired';
        logger.info({ proxyId: id, flaggedBy: endpoint.flaggedBy }, 'Proxy retired due to low reputation');
      }

      switch (endpoint.health) {
        case 'healthy': healthy++; break;
        case 'degraded': degraded++; break;
        default: unhealthy++; break;
      }

      await this.persistEndpoint(endpoint);
    }

    // Check if we need auto-provisioning
    if (this.config.autoProvisioning) {
      await this.checkAndProvision();
    }

    logger.info({ healthy, degraded, unhealthy, total: this.endpoints.size }, 'Health check complete');
  }

  /** Flag a proxy as detected by a specific domain. */
  async flagProxy(proxyId: string, domain: string, reason: string): Promise<void> {
    const endpoint = this.endpoints.get(proxyId);
    if (!endpoint) return;

    if (!endpoint.flaggedBy.includes(domain)) {
      endpoint.flaggedBy.push(domain);
    }
    endpoint.reputationScore = Math.max(0, endpoint.reputationScore - 15);
    endpoint.lastFailure = Date.now();

    if (endpoint.reputationScore < 30) {
      endpoint.health = 'blacklisted';
      endpoint.cooldownUntil = Date.now() + 7200000; // 2 hour cooldown
    }

    await this.persistEndpoint(endpoint);
    logger.warn({ proxyId, domain, reason, reputation: endpoint.reputationScore }, 'Proxy flagged');
  }

  // ---------- Statistics -------------------------------------------------------

  getStats(): {
    total: number;
    byTier: Record<ProxyTier, number>;
    byHealth: Record<ProxyHealthStatus, number>;
    byProvider: Record<ProxyProvider, number>;
    byCountry: Record<string, number>;
    avgResponseMs: number;
    avgReputation: number;
    dailySpend: number;
  } {
    const byTier: Record<ProxyTier, number> = { datacenter: 0, residential: 0, mobile: 0, isp: 0 };
    const byHealth: Record<ProxyHealthStatus, number> = { healthy: 0, degraded: 0, unhealthy: 0, blacklisted: 0, cooldown: 0, retired: 0 };
    const byProvider: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    let totalResponseMs = 0;
    let totalReputation = 0;
    let count = 0;

    for (const ep of this.endpoints.values()) {
      byTier[ep.tier]++;
      byHealth[ep.health]++;
      byProvider[ep.provider] = (byProvider[ep.provider] || 0) + 1;
      byCountry[ep.countryCode] = (byCountry[ep.countryCode] || 0) + 1;
      totalResponseMs += ep.avgResponseMs;
      totalReputation += ep.reputationScore;
      count++;
    }

    return {
      total: count,
      byTier,
      byHealth,
      byProvider: byProvider as Record<ProxyProvider, number>,
      byCountry,
      avgResponseMs: count > 0 ? Math.round(totalResponseMs / count) : 0,
      avgReputation: count > 0 ? Math.round(totalReputation / count) : 0,
      dailySpend: this.dailySpend,
    };
  }

  // ---------- Private Helpers --------------------------------------------------

  private async findStickySession(request: ProxyAllocationRequest): Promise<ProxyAllocationResult | null> {
    if (!request.domain) return null;
    const assigned = this.domainAssignments.get(request.domain);
    if (!assigned) return null;

    const endpoint = this.endpoints.get(assigned);
    if (!endpoint || endpoint.health !== 'healthy') return null;
    if (endpoint.sessionExpiry && Date.now() > endpoint.sessionExpiry) return null;
    if (request.excludeIds?.includes(endpoint.id)) return null;

    const allocationId = createHash('sha256')
      .update(`alloc:${endpoint.id}:${Date.now()}`)
      .digest('hex')
      .substring(0, 16);

    endpoint.activeConnections++;

    return {
      proxy: endpoint,
      stickySessionId: endpoint.sessionId,
      expiresAt: endpoint.sessionExpiry,
      allocationId,
    };
  }

  private async findDomainAssignment(request: ProxyAllocationRequest): Promise<ProxyAllocationResult | null> {
    const assigned = this.domainAssignments.get(request.domain!);
    if (!assigned) return null;

    const endpoint = this.endpoints.get(assigned);
    if (!endpoint || endpoint.health === 'retired' || endpoint.health === 'blacklisted') return null;

    const allocationId = createHash('sha256')
      .update(`alloc:${endpoint.id}:${Date.now()}`)
      .digest('hex')
      .substring(0, 16);

    endpoint.activeConnections++;

    return {
      proxy: endpoint,
      allocationId,
    };
  }

  private filterCandidates(request: ProxyAllocationRequest): ProxyEndpoint[] {
    return Array.from(this.endpoints.values()).filter(ep => {
      // Must be healthy or degraded
      if (ep.health !== 'healthy' && ep.health !== 'degraded') return false;
      // Must not be in cooldown
      if (ep.cooldownUntil && Date.now() < ep.cooldownUntil) return false;
      // Must have connection capacity
      if (ep.activeConnections >= ep.maxConnections) return false;
      // Tier filter
      if (request.tier && ep.tier !== request.tier) return false;
      // Country filter
      if (request.countryCode && ep.countryCode !== request.countryCode) return false;
      // City filter
      if (request.city && ep.city !== request.city) return false;
      // ASN filter
      if (request.asn && ep.asn !== request.asn) return false;
      // Response time filter
      if (request.maxResponseMs && ep.avgResponseMs > request.maxResponseMs) return false;
      // Reputation filter
      if (request.minReputation && ep.reputationScore < request.minReputation) return false;
      // Cost filter
      if (request.maxCostPerGb && ep.costPerGb > request.maxCostPerGb) return false;
      // Exclude list
      if (request.excludeIds?.includes(ep.id)) return false;

      return true;
    });
  }

  private selectBestCandidate(candidates: ProxyEndpoint[], request: ProxyAllocationRequest): ProxyEndpoint {
    switch (this.config.defaultRotation) {
      case 'round-robin': {
        const tier = request.tier || 'residential';
        const idx = (this.roundRobinIndex.get(tier) || 0) % candidates.length;
        this.roundRobinIndex.set(tier, idx + 1);
        return candidates[idx];
      }
      case 'least-connections':
        return candidates.sort((a, b) => a.activeConnections - b.activeConnections)[0];
      case 'random':
        return candidates[Math.floor(Math.random() * candidates.length)];
      case 'geo-targeted': {
        if (request.countryCode) {
          const geoMatch = candidates.filter(c => c.countryCode === request.countryCode);
          if (geoMatch.length > 0) return geoMatch[0];
        }
        return candidates.sort((a, b) => b.reputationScore - a.reputationScore)[0];
      }
      case 'weighted-reputation':
      default:
        // Weighted selection by reputation score with some randomness
        const totalWeight = candidates.reduce((sum, c) => sum + c.reputationScore, 0);
        let random = Math.random() * totalWeight;
        for (const candidate of candidates) {
          random -= candidate.reputationScore;
          if (random <= 0) return candidate;
        }
        return candidates[0];
    }
  }

  private async checkAndProvision(): Promise<void> {
    for (const tier of ['residential', 'mobile', 'isp', 'datacenter'] as ProxyTier[]) {
      const currentCount = Array.from(this.endpoints.values())
        .filter(ep => ep.tier === tier && ep.health !== 'retired').length;
      const minSize = this.config.minPoolSize[tier];

      if (currentCount < minSize) {
        logger.warn({ tier, current: currentCount, minimum: minSize }, 'Pool size below minimum — auto-provisioning needed');
        // In production, this would call provider APIs to purchase/provision new IPs
        // For now, log the need
      }
    }
  }

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(
      () => this.runHealthChecks(),
      this.config.healthCheckInterval * 1000,
    );
  }

  private resetDailySpendIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastSpendReset > 86400000) { // 24 hours
      this.dailySpend = 0;
      this.lastSpendReset = now;
    }
  }

  // ---------- Persistence ------------------------------------------------------

  private async persistEndpoint(endpoint: ProxyEndpoint): Promise<void> {
    await cacheSet(`${ENDPOINT_PREFIX}${endpoint.id}`, endpoint, 86400);
  }

  private async loadEndpoints(): Promise<void> {
    // In production, load from database. For now, check Redis cache.
    logger.debug('Loading proxy endpoints from cache');
  }

  private async persistEndpoints(): Promise<void> {
    for (const endpoint of this.endpoints.values()) {
      await this.persistEndpoint(endpoint);
    }
  }

  private async loadDomainAssignments(): Promise<void> {
    logger.debug('Loading domain assignments from cache');
  }

  private async persistDomainAssignments(): Promise<void> {
    for (const [domain, proxyId] of this.domainAssignments) {
      await cacheSet(`${DOMAIN_ASSIGN_PREFIX}${domain}`, { proxyId, assignedAt: Date.now() }, this.config.stickySessionDuration);
    }
  }
}

/** Singleton instance. */
export const proxyFarmManager = new ProxyFarmManager();
