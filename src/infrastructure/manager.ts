/**
 * Infrastructure Manager — ScrapeSuite Engine
 *
 * Top-level orchestrator that coordinates all infrastructure components
 * for Netflix and Google scraping at scale. Manages the lifecycle of
 * proxy farms, IP reputation, browser farms, session farms, and
 * mobile emulation as a unified system.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { ProxyFarmManager, DEFAULT_PROXY_FARM_CONFIG, proxyFarmManager } from './proxy-farm';
import { IPReputationManager, DEFAULT_IP_REPUTATION_CONFIG, ipReputationManager } from './ip-reputation';
import { BrowserFarmManager, DEFAULT_BROWSER_FARM_CONFIG, browserFarmManager } from './browser-farm';
import { SessionFarmManager, DEFAULT_SESSION_FARM_CONFIG, sessionFarmManager } from './session-farm';
import { MobileEmulationManager, DEFAULT_MOBILE_EMULATION_CONFIG, mobileEmulationManager } from './mobile-emulation';
import type { InfrastructureStats, ProxyAllocationRequest, BrowserAllocationRequest } from './types';

const logger = createChildLogger('infrastructure-manager');

// ===============================================================================
// INFRASTRUCTURE MANAGER
// ===============================================================================

export class InfrastructureManager {
  private proxyFarm: ProxyFarmManager;
  private ipReputation: IPReputationManager;
  private browserFarm: BrowserFarmManager;
  private sessionFarm: SessionFarmManager;
  private mobileEmulation: MobileEmulationManager;
  private initialized = false;

  constructor() {
    this.proxyFarm = proxyFarmManager;
    this.ipReputation = ipReputationManager;
    this.browserFarm = browserFarmManager;
    this.sessionFarm = sessionFarmManager;
    this.mobileEmulation = mobileEmulationManager;
  }

  /** Initialize all infrastructure components. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Infrastructure Manager — Netflix/Google Grade');

    await Promise.all([
      this.proxyFarm.initialize(),
      this.ipReputation.initialize(),
      this.browserFarm.initialize(),
      this.sessionFarm.initialize(),
      this.mobileEmulation.initialize(),
    ]);

    this.initialized = true;
    logger.info('Infrastructure Manager fully initialized');
  }

  /** Shut down all infrastructure components. */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    logger.info('Shutting down Infrastructure Manager');

    await Promise.all([
      this.proxyFarm.shutdown(),
      this.browserFarm.shutdown(),
      this.sessionFarm.shutdown(),
    ]);

    this.initialized = false;
  }

  // ---------- High-Level Operations --------------------------------------------

  /**
   * Prepare infrastructure for Netflix scraping.
   * Allocates residential/mobile proxies, high-stealth browsers,
   * and long-lived sessions with proper warm-up.
   */
  async prepareForNetflix(countryCode?: string): Promise<{
    proxyAllocation: any;
    browserAllocation: any;
    session: any;
    mobileProfile: any;
  }> {
    logger.info({ countryCode }, 'Preparing infrastructure for Netflix');

    // 1. Get a residential or mobile proxy (Netflix blocks datacenter)
    const proxyAlloc = await this.proxyFarm.allocateProxy({
      domain: 'netflix.com',
      tier: 'mobile', // Mobile IPs have highest reputation on Netflix
      countryCode: countryCode || 'US',
      stickySession: true,
      minReputation: 60,
    });

    if (!proxyAlloc) {
      // Fall back to residential
      const fallback = await this.proxyFarm.allocateProxy({
        domain: 'netflix.com',
        tier: 'residential',
        countryCode: countryCode || 'US',
        stickySession: true,
        minReputation: 50,
      });

      if (!fallback) {
        throw new Error('No suitable proxy available for Netflix');
      }
    }

    // 2. Allocate a high-stealth browser
    const browserAlloc = await this.browserFarm.allocateBrowser({
      domain: 'netflix.com',
      stealthLevel: 'maximum',
      requiresAuth: false,
    });

    // 3. Create a Netflix session
    const session = await this.sessionFarm.createSession('netflix.com', {
      proxyId: proxyAlloc?.proxy.id,
      browserInstanceId: browserAlloc?.instance.id,
    });

    // 4. Generate a mobile profile for extra realism
    const mobileProfile = this.mobileEmulation.getRandomProfile({
      countryCode: countryCode || 'US',
    });

    return {
      proxyAllocation: proxyAlloc,
      browserAllocation: browserAlloc,
      session,
      mobileProfile,
    };
  }

  /**
   * Prepare infrastructure for Google scraping.
   * Uses residential proxies, moderate stealth, and varied sessions.
   */
  async prepareForGoogle(countryCode?: string): Promise<{
    proxyAllocation: any;
    browserAllocation: any;
    session: any;
    mobileProfile: any;
  }> {
    logger.info({ countryCode }, 'Preparing infrastructure for Google');

    // 1. Get a residential proxy (Google is less strict than Netflix)
    const proxyAlloc = await this.proxyFarm.allocateProxy({
      domain: 'google.com',
      tier: 'residential',
      countryCode: countryCode || 'US',
      stickySession: true,
      minReputation: 50,
    });

    if (!proxyAlloc) {
      throw new Error('No suitable proxy available for Google');
    }

    // 2. Allocate a high-stealth browser
    const browserAlloc = await this.browserFarm.allocateBrowser({
      domain: 'google.com',
      stealthLevel: 'high',
    });

    // 3. Create a Google session
    const session = await this.sessionFarm.createSession('google.com', {
      proxyId: proxyAlloc.proxy.id,
      browserInstanceId: browserAlloc?.instance.id,
    });

    // 4. Generate a mobile profile
    const mobileProfile = this.mobileEmulation.getRandomProfile({
      countryCode: countryCode || 'US',
    });

    return {
      proxyAllocation: proxyAlloc,
      browserAllocation: browserAlloc,
      session,
      mobileProfile,
    };
  }

  /** Check if infrastructure can handle a request to a specific domain. */
  async canHandle(domain: string): Promise<{ canHandle: boolean; reason?: string }> {
    if (!this.initialized) {
      return { canHandle: false, reason: 'Infrastructure not initialized' };
    }

    const isNetflix = domain.includes('netflix');
    const isGoogle = domain.includes('google');

    // Check proxy availability
    const tier = isNetflix ? 'mobile' : 'residential';
    const proxyAlloc = await this.proxyFarm.allocateProxy({
      domain,
      tier: tier as any,
      minReputation: isNetflix ? 60 : 40,
    });

    if (!proxyAlloc) {
      return { canHandle: false, reason: `No ${tier} proxies available for ${domain}` };
    }

    // Release the test allocation immediately
    await this.proxyFarm.releaseProxy(proxyAlloc.allocationId, true);

    return { canHandle: true };
  }

  // ---------- Component Access -------------------------------------------------

  getProxyFarm(): ProxyFarmManager { return this.proxyFarm; }
  getIPReputation(): IPReputationManager { return this.ipReputation; }
  getBrowserFarm(): BrowserFarmManager { return this.browserFarm; }
  getSessionFarm(): SessionFarmManager { return this.sessionFarm; }
  getMobileEmulation(): MobileEmulationManager { return this.mobileEmulation; }

  // ---------- Statistics -------------------------------------------------------

  async getStats(): Promise<InfrastructureStats> {
    const proxyStats = this.proxyFarm.getStats();
    const ipStats = await this.ipReputation.generateReport();
    const browserStats = this.browserFarm.getStats();
    const sessionStats = this.sessionFarm.getStats();
    const mobileStats = this.mobileEmulation.getStats();

    return {
      proxyFarm: {
        totalEndpoints: proxyStats.total,
        healthyEndpoints: proxyStats.byHealth.healthy || 0,
        byTier: proxyStats.byTier,
        byProvider: proxyStats.byProvider,
        byCountry: proxyStats.byCountry,
        avgResponseMs: proxyStats.avgResponseMs,
        avgReputation: proxyStats.avgReputation,
        dailyCost: proxyStats.dailySpend,
      },
      ipReputation: {
        totalTracked: ipStats.totalIPs,
        byLevel: ipStats.byReputationLevel,
        avgScore: ipStats.averageReputation,
        retiredCount: ipStats.retiredIPs,
        flaggedCount: ipStats.flaggedIPs,
      },
      browserFarm: {
        totalInstances: browserStats.total,
        readyInstances: browserStats.readyCount,
        busyInstances: browserStats.byStatus.busy || 0,
        byType: browserStats.byType,
        avgMemoryMB: browserStats.avgMemoryMB,
        totalCrashes: browserStats.totalCrashes,
      },
      sessionFarm: {
        totalSessions: sessionStats.total,
        activeSessions: sessionStats.activeCount,
        byDomain: sessionStats.byDomain,
        byStatus: sessionStats.byStatus,
        avgHealthScore: sessionStats.avgHealthScore,
        avgSessionDuration: sessionStats.avgSessionDuration,
      },
      mobileEmulation: {
        totalProfiles: mobileStats.total,
        byPlatform: mobileStats.byPlatform,
        byDevice: mobileStats.byDevice,
      },
    };
  }
}

/** Singleton instance. */
export const infrastructureManager = new InfrastructureManager();
