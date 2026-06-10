/**
 * Netflix Suite Manager — ScrapeSuite Engine
 *
 * Top-level orchestrator for all Netflix scraping capabilities.
 * Coordinates catalog extraction, search, availability checking,
 * and API interception with Akamai bypass integration.
 */

import { createChildLogger } from '../utils/logger';
import { CatalogExtractor, catalogExtractor } from './catalog-extractor';
import { APIInterceptor, DEFAULT_NETFLIX_API_CONFIG, apiInterceptor } from './api-interceptor';
import { AvailabilityChecker, availabilityChecker } from './availability-checker';
import type {
  NetflixSuiteConfig, NetflixSuiteStats,
  CatalogRequest, CatalogResponse, NetflixTitle,
  NetflixSearchRequest, NetflixSearchResponse,
  AvailabilityRequest, AvailabilityResponse,
} from './types';

const logger = createChildLogger('netflix-suite');

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_NETFLIX_SUITE_CONFIG: NetflixSuiteConfig = {
  catalog: {
    maxConcurrent: 5,
    defaultRegion: 'US',
    pagesPerRun: 10,
    delayBetweenPages: 5000,
    useAPI: true,
  },
  search: {
    maxConcurrent: 3,
    defaultRegion: 'US',
  },
  availability: {
    maxConcurrentRegions: 5,
    delayBetweenRegions: 3000,
    cacheResults: true,
    cacheTTL: 21600, // 6 hours
  },
  api: DEFAULT_NETFLIX_API_CONFIG,
  proxy: {
    requiredTier: 'mobile',
    stickySessionDuration: 3600,
    maxRPMPerIP: 3,
    countries: ['US', 'GB', 'DE', 'JP', 'BR', 'IN', 'CA', 'AU', 'FR', 'KR'],
  },
};

// ===============================================================================
// NETFLIX SUITE MANAGER
// ===============================================================================

export class NetflixSuiteManager {
  private catalog: CatalogExtractor;
  private api: APIInterceptor;
  private availability: AvailabilityChecker;
  private config: NetflixSuiteConfig;
  private searchCount: number = 0;

  constructor(config?: Partial<NetflixSuiteConfig>) {
    this.config = { ...DEFAULT_NETFLIX_SUITE_CONFIG, ...config };
    this.catalog = catalogExtractor;
    this.api = apiInterceptor;
    this.availability = availabilityChecker;
  }

  /** Extract Netflix catalog. */
  async extractCatalog(request?: Partial<CatalogRequest>): Promise<CatalogResponse> {
    return this.catalog.extractCatalog({
      region: request?.region || this.config.catalog.defaultRegion,
      genre: request?.genre,
      type: request?.type,
      page: request?.page || 1,
      limit: request?.limit || 40,
      sortBy: request?.sortBy || 'popularity',
      proxyTier: request?.proxyTier || this.config.proxy.requiredTier,
      proxyCountry: request?.proxyCountry,
    });
  }

  /** Search Netflix. */
  async search(request: NetflixSearchRequest): Promise<NetflixSearchResponse> {
    this.searchCount++;

    // In production, this would use Infrastructure + Akamai modules
    // to perform a real search through a stealth browser

    const response: NetflixSearchResponse = {
      query: request.query,
      results: [],
      suggestions: [`${request.query} part 2`, `${request.query} documentary`, `best ${request.query}`],
      region: request.region || this.config.search.defaultRegion,
      timestamp: Date.now(),
    };

    return response;
  }

  /** Check regional availability. */
  async checkAvailability(request: AvailabilityRequest): Promise<AvailabilityResponse> {
    return this.availability.checkAvailability(request);
  }

  /** Get title details. */
  async getTitleDetails(netflixId: number, region?: string): Promise<NetflixTitle | null> {
    return this.catalog.getTitleDetails(netflixId, region || this.config.catalog.defaultRegion);
  }

  /** Get API interception rules for Playwright. */
  getInterceptionRules() {
    return this.api.getInterceptionRules();
  }

  /** Get available genres. */
  getGenres(region?: string) {
    return this.catalog.getGenres(region || this.config.catalog.defaultRegion);
  }

  /** Get supported regions for availability checking. */
  getSupportedRegions() {
    return this.availability.getSupportedRegions();
  }

  /** Get comprehensive statistics. */
  getStats(): NetflixSuiteStats {
    const catalogStats = this.catalog.getStats();
    const availabilityStats = this.availability.getStats();
    const apiStats = this.api.getStats();

    return {
      catalogExtractions: catalogStats.extractions,
      titlesExtracted: catalogStats.titlesExtracted,
      searchesPerformed: this.searchCount,
      availabilityChecks: availabilityStats.totalChecks,
      apiCallsIntercepted: apiStats.interceptedCalls,
      blocksEncountered: catalogStats.blocks,
      captchasSolved: 0,
      avgResponseTime: 0,
      byRegion: availabilityStats.byRegion as any,
    };
  }
}

/** Singleton instance. */
export const netflixSuiteManager = new NetflixSuiteManager();
