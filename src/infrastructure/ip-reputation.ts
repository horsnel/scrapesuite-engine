/**
 * IP Reputation Manager — ScrapeSuite Engine
 *
 * Tracks and manages IP reputation across all proxy endpoints with
 * domain-specific scoring, burn rate analysis, and auto-retirement.
 *
 * Critical for Netflix and Google: both maintain IP reputation databases
 * and will block IPs with high request volumes or suspicious patterns.
 * This module ensures we:
 * - Never exceed safe request rates per IP per domain
 * - Automatically cool down IPs after blocks
 * - Track per-domain reputation independently
 * - Retire burned IPs and provision replacements
 * - Detect DNS/WebRTC leaks that expose proxy usage
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type {
  IPReputationRecord, IPReputationLevel, IPReputationConfig,
  IPReputationReport, IPGeoData, ProxyTier,
} from './types';

const logger = createChildLogger('ip-reputation');

const REPUTATION_PREFIX = 'infra:reputation:';
const RPM_PREFIX = 'infra:rpm:';

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_IP_REPUTATION_CONFIG: IPReputationConfig = {
  minReputationScore: 40,
  blockRateThreshold: 0.3,
  blocksBeforeRetirement: 5,
  blockCooldown: 3600, // 1 hour
  testDnsLeaks: true,
  testWebrtcLeaks: true,
  autoReplaceRetired: true,
  globalMaxRPM: 10, // 10 requests per minute per IP globally
  domainRPMLimits: {},
  netflixRPM: 3, // Very conservative for Netflix
  googleRPM: 5, // Conservative for Google
};

// ===============================================================================
// REPUTATION SCORING CONSTANTS
// ===============================================================================

const REPUTATION_THRESHOLDS: Record<IPReputationLevel, { min: number; max: number }> = {
  pristine: { min: 90, max: 100 },
  clean: { min: 70, max: 89 },
  acceptable: { min: 50, max: 69 },
  suspicious: { min: 30, max: 49 },
  flagged: { min: 10, max: 29 },
  blacklisted: { min: 0, max: 9 },
};

// Domain-specific block penalties
const BLOCK_PENALTY: Record<string, number> = {
  'netflix.com': 20,
  'www.netflix.com': 20,
  'google.com': 15,
  'www.google.com': 15,
  'accounts.google.com': 25,
  'default': 10,
};

// ===============================================================================
// IP REPUTATION MANAGER
// ===============================================================================

export class IPReputationManager {
  private config: IPReputationConfig;
  private records: Map<string, IPReputationRecord> = new Map();
  /** Tracks requests per minute per IP: ip -> timestamps */
  private rpmTracker: Map<string, number[]> = new Map();

  constructor(config?: Partial<IPReputationConfig>) {
    this.config = { ...DEFAULT_IP_REPUTATION_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    logger.info('Initializing IP Reputation Manager');
    await this.loadRecords();
    logger.info({ trackedIPs: this.records.size }, 'IP Reputation Manager initialized');
  }

  // ---------- Record Management ------------------------------------------------

  /** Get or create a reputation record for an IP. */
  async getOrCreate(ip: string, geoData?: IPGeoData): Promise<IPReputationRecord> {
    let record = this.records.get(ip);
    if (!record) {
      record = {
        ip,
        reputationLevel: 'clean',
        reputationScore: 75, // Start with decent reputation
        flaggedByDomains: {},
        blockRateByDomain: {},
        overallBlockRate: 0,
        successRateByDomain: {},
        totalRequests: 0,
        dnsLeakSafe: true,
        webrtcLeakSafe: true,
        isDatacenter: false,
        isProxy: false,
        geoData: geoData || this.defaultGeoData(ip),
        firstSeen: Date.now(),
        lastUsed: Date.now(),
        burnRate: 0,
        maxSafeRPM: this.config.globalMaxRPM,
        recoveryTime: 3600,
        shouldRetire: false,
      };
      this.records.set(ip, record);
      await this.persistRecord(record);
    }
    return record;
  }

  /** Update reputation after a successful request. */
  async recordSuccess(ip: string, domain: string, responseMs: number): Promise<IPReputationRecord> {
    const record = await this.getOrCreate(ip);
    record.totalRequests++;
    record.lastUsed = Date.now();

    // Update success rate
    if (!record.successRateByDomain[domain]) {
      record.successRateByDomain[domain] = 1;
    } else {
      record.successRateByDomain[domain] = record.successRateByDomain[domain] * 0.95 + 0.05;
    }

    // Update block rate (reduce it on success)
    if (record.blockRateByDomain[domain]) {
      record.blockRateByDomain[domain] = record.blockRateByDomain[domain] * 0.9;
    }

    // Recalculate overall block rate
    const domains = Object.keys(record.blockRateByDomain);
    record.overallBlockRate = domains.length > 0
      ? domains.reduce((sum, d) => sum + record.blockRateByDomain[d], 0) / domains.length
      : 0;

    // Small reputation boost on success (diminishing)
    record.reputationScore = Math.min(100, record.reputationScore + 0.5);

    this.updateReputationLevel(record);
    await this.persistRecord(record);
    return record;
  }

  /** Update reputation after a block/detection. */
  async recordBlock(ip: string, domain: string, reason: string): Promise<IPReputationRecord> {
    const record = await this.getOrCreate(ip);
    record.totalRequests++;
    record.lastUsed = Date.now();
    record.lastBlock = Date.now();

    // Flag by domain
    record.flaggedByDomains[domain] = { timestamp: Date.now(), reason };

    // Update block rate
    record.blockRateByDomain[domain] = (record.blockRateByDomain[domain] || 0) * 0.8 + 0.2;

    // Recalculate overall block rate
    const domains = Object.keys(record.blockRateByDomain);
    record.overallBlockRate = domains.reduce((sum, d) => sum + record.blockRateByDomain[d], 0) / domains.length;

    // Apply domain-specific penalty
    const penalty = BLOCK_PENALTY[domain] || BLOCK_PENALTY['default'];
    record.reputationScore = Math.max(0, record.reputationScore - penalty);

    // Update burn rate
    record.burnRate = record.burnRate * 0.9 + 0.1;

    // Adjust max safe RPM downward after block
    record.maxSafeRPM = Math.max(1, Math.floor(record.maxSafeRPM * 0.7));

    // Increase recovery time after block
    record.recoveryTime = Math.min(86400, record.recoveryTime * 1.5);

    // Check for retirement
    const blockCount = Object.keys(record.flaggedByDomains).length;
    if (blockCount >= this.config.blocksBeforeRetirement || record.reputationScore < 15) {
      record.shouldRetire = true;
      record.reputationLevel = record.reputationScore < 10 ? 'blacklisted' : 'flagged';
      logger.warn({ ip, reputation: record.reputationScore, blockCount, domain }, 'IP flagged for retirement');
    }

    this.updateReputationLevel(record);
    await this.persistRecord(record);
    return record;
  }

  // ---------- Rate Limiting ----------------------------------------------------

  /** Check if an IP can make a request to a specific domain. */
  async canMakeRequest(ip: string, domain: string): Promise<{ allowed: boolean; reason?: string; waitMs?: number }> {
    const record = await this.getOrCreate(ip);

    // Check if retired
    if (record.shouldRetire) {
      return { allowed: false, reason: 'IP is retired due to low reputation' };
    }

    // Check if in recovery from recent block
    if (record.lastBlock) {
      const timeSinceBlock = (Date.now() - record.lastBlock) / 1000;
      if (timeSinceBlock < record.recoveryTime) {
        const waitMs = (record.recoveryTime - timeSinceBlock) * 1000;
        return { allowed: false, reason: 'IP is in recovery cooldown after block', waitMs };
      }
    }

    // Check global RPM
    const globalRPM = this.getCurrentRPM(ip);
    if (globalRPM >= record.maxSafeRPM) {
      return { allowed: false, reason: `Global RPM limit reached (${globalRPM}/${record.maxSafeRPM})` };
    }

    // Check domain-specific RPM
    const domainRPM = this.config.domainRPMLimits[domain]
      || (domain.includes('netflix') ? this.config.netflixRPM
        : domain.includes('google') ? this.config.googleRPM
        : this.config.globalMaxRPM);

    const currentDomainRPM = this.getCurrentDomainRPM(ip, domain);
    if (currentDomainRPM >= domainRPM) {
      return { allowed: false, reason: `Domain RPM limit reached for ${domain} (${currentDomainRPM}/${domainRPM})` };
    }

    // Check reputation threshold
    if (record.reputationScore < this.config.minReputationScore) {
      return { allowed: false, reason: `Reputation score too low (${record.reputationScore})` };
    }

    return { allowed: true };
  }

  /** Record a request timestamp for RPM tracking. */
  recordRequest(ip: string, domain?: string): void {
    const now = Date.now();
    const key = domain ? `${ip}:${domain}` : ip;
    let timestamps = this.rpmTracker.get(key) || [];
    timestamps.push(now);
    // Keep only last 60 seconds
    timestamps = timestamps.filter(t => now - t < 60000);
    this.rpmTracker.set(key, timestamps);
  }

  /** Get current requests per minute for an IP. */
  getCurrentRPM(ip: string): number {
    const timestamps = this.rpmTracker.get(ip) || [];
    const now = Date.now();
    return timestamps.filter(t => now - t < 60000).length;
  }

  /** Get current requests per minute for an IP on a specific domain. */
  getCurrentDomainRPM(ip: string, domain: string): number {
    const key = `${ip}:${domain}`;
    const timestamps = this.rpmTracker.get(key) || [];
    const now = Date.now();
    return timestamps.filter(t => now - t < 60000).length;
  }

  // ---------- Leak Detection ---------------------------------------------------

  /** Check for DNS leaks (simplified check). */
  async checkDnsLeak(ip: string): Promise<boolean> {
    // In production, this would perform an actual DNS leak test
    // by making requests through the proxy and checking DNS resolution
    const record = await this.getOrCreate(ip);
    return record.dnsLeakSafe;
  }

  /** Check for WebRTC leaks (simplified check). */
  async checkWebrtcLeak(ip: string): Promise<boolean> {
    // In production, this would check if WebRTC reveals the real IP
    const record = await this.getOrCreate(ip);
    return record.webrtcLeakSafe;
  }

  // ---------- Reporting --------------------------------------------------------

  async generateReport(): Promise<IPReputationReport> {
    const byLevel: Record<IPReputationLevel, number> = {
      pristine: 0, clean: 0, acceptable: 0, suspicious: 0, flagged: 0, blacklisted: 0,
    };
    const domainStats: Record<string, { totalBlockRate: number; totalReputation: number; count: number }> = {};
    let totalReputation = 0;
    let totalBlockRate = 0;
    let retiredCount = 0;
    let flaggedCount = 0;

    for (const record of this.records.values()) {
      byLevel[record.reputationLevel]++;
      totalReputation += record.reputationScore;
      totalBlockRate += record.overallBlockRate;
      if (record.shouldRetire) retiredCount++;
      if (record.reputationLevel === 'flagged') flaggedCount++;

      for (const [domain, blockRate] of Object.entries(record.blockRateByDomain)) {
        if (!domainStats[domain]) {
          domainStats[domain] = { totalBlockRate: 0, totalReputation: 0, count: 0 };
        }
        domainStats[domain].totalBlockRate += blockRate;
        domainStats[domain].totalReputation += record.reputationScore;
        domainStats[domain].count++;
      }
    }

    const total = this.records.size;
    const recommendations: string[] = [];

    if (retiredCount > total * 0.1) {
      recommendations.push(`${retiredCount} IPs retired — consider provisioning new residential/mobile proxies`);
    }
    if (byLevel.suspicious > total * 0.2) {
      recommendations.push('High number of suspicious IPs — reduce request rate and increase cooldown periods');
    }

    // Check Netflix-specific
    const netflixStats = domainStats['netflix.com'];
    if (netflixStats && netflixStats.totalBlockRate / netflixStats.count > 0.2) {
      recommendations.push('Netflix block rate above 20% — reduce Netflix RPM to 2 and increase sticky session duration');
    }

    // Check Google-specific
    const googleStats = domainStats['google.com'];
    if (googleStats && googleStats.totalBlockRate / googleStats.count > 0.15) {
      recommendations.push('Google block rate above 15% — use residential tier only and reduce RPM to 3');
    }

    return {
      totalIPs: total,
      byReputationLevel: byLevel,
      byTier: { datacenter: 0, residential: 0, mobile: 0, isp: 0 }, // Filled by ProxyFarm integration
      averageReputation: total > 0 ? Math.round(totalReputation / total) : 0,
      averageBlockRate: total > 0 ? totalBlockRate / total : 0,
      retiredIPs: retiredCount,
      flaggedIPs: flaggedCount,
      domainSpecific: Object.fromEntries(
        Object.entries(domainStats).map(([domain, stats]) => [
          domain,
          { blockRate: stats.totalBlockRate / stats.count, avgReputation: Math.round(stats.totalReputation / stats.count) },
        ])
      ),
      recommendations,
    };
  }

  // ---------- Private Helpers --------------------------------------------------

  private updateReputationLevel(record: IPReputationRecord): void {
    for (const [level, range] of Object.entries(REPUTATION_THRESHOLDS)) {
      if (record.reputationScore >= range.min && record.reputationScore <= range.max) {
        record.reputationLevel = level as IPReputationLevel;
        break;
      }
    }
  }

  private defaultGeoData(ip: string): IPGeoData {
    return {
      ip,
      countryCode: 'US',
      countryName: 'United States',
      city: 'Unknown',
      region: 'Unknown',
      latitude: 0,
      longitude: 0,
      timezone: 'America/New_York',
      isp: 'Unknown',
      org: 'Unknown',
      asn: 'AS0000',
      asName: 'Unknown',
      connectionType: 'unknown',
    };
  }

  private async persistRecord(record: IPReputationRecord): Promise<void> {
    await cacheSet(`${REPUTATION_PREFIX}${record.ip}`, record, 86400);
  }

  private async loadRecords(): Promise<void> {
    logger.debug('Loading IP reputation records from cache');
  }
}

/** Singleton instance. */
export const ipReputationManager = new IPReputationManager();
