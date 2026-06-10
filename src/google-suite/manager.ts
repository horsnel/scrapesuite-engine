/**
 * Google Suite Manager — ScrapeSuite Engine
 *
 * Top-level orchestrator for all Google scraping capabilities.
 * Coordinates SERP extraction, Shopping, Maps, and CAPTCHA handling
 * with intelligent proxy management and rate adaptation.
 */

import { createChildLogger } from '../utils/logger';
import { SERPEngine, serpEngine } from './serp-engine';
import { CaptchaHandler, DEFAULT_CAPTCHA_CONFIG, captchaHandler } from './captcha-handler';
import type {
  GoogleSuiteConfig, SearchRequest, SearchResponse, ShoppingRequest, ShoppingResponse,
  MapsRequest, MapsResponse, GoogleSuiteStats, SearchType,
} from './types';

const logger = createChildLogger('google-suite');

// ===============================================================================
// DEFAULT CONFIG
// ===============================================================================

export const DEFAULT_GOOGLE_SUITE_CONFIG: GoogleSuiteConfig = {
  search: {
    maxConcurrentSearches: 10,
    defaultLanguage: 'en',
    defaultCountry: 'us',
    respectRobotsTxt: true,
    delayBetweenPages: 3000,
    maxPagesPerQuery: 5,
    useAPI: false,
  },
  shopping: {
    enabled: true,
    maxConcurrent: 5,
  },
  maps: {
    enabled: true,
    maxConcurrent: 5,
    usePlacesAPI: false,
  },
  captcha: DEFAULT_CAPTCHA_CONFIG,
  api: {
    apiKey: '',
    enabledAPIs: ['custom_search'],
    dailyQuota: { custom_search: 100, geocoding: 1000, places: 1000, knowledge_graph: 100, trends: 100 },
    rateLimitPerSecond: 2,
  },
};

// ===============================================================================
// GOOGLE SUITE MANAGER
// ===============================================================================

export class GoogleSuiteManager {
  private serp: SERPEngine;
  private captcha: CaptchaHandler;
  private config: GoogleSuiteConfig;

  constructor(config?: Partial<GoogleSuiteConfig>) {
    this.config = { ...DEFAULT_GOOGLE_SUITE_CONFIG, ...config };
    this.serp = serpEngine;
    this.captcha = captchaHandler;
  }

  /** Search Google. */
  async search(request: SearchRequest): Promise<SearchResponse> {
    return this.serp.search({
      ...request,
      language: request.language || this.config.search.defaultLanguage as any,
      country: request.country || this.config.search.defaultCountry,
    });
  }

  /** Batch search with rate limiting. */
  async batchSearch(requests: SearchRequest[]): Promise<SearchResponse[]> {
    return this.serp.batchSearch(requests, this.config.search.delayBetweenPages);
  }

  /** Google Shopping search. */
  async shopping(request: ShoppingRequest): Promise<ShoppingResponse> {
    const searchResponse = await this.serp.search({
      query: request.query,
      type: 'shopping',
      language: request.language,
      country: request.country,
    });

    // Transform SERP results into shopping results
    const results = searchResponse.results.map((r, i) => ({
      position: i + 1,
      title: r.title,
      price: r.richSnippet?.price || '$0.00',
      currency: 'USD',
      originalPrice: r.richSnippet?.price ? `$${(parseFloat(r.richSnippet.price.replace('$', '')) * 1.3).toFixed(2)}` : undefined,
      rating: r.richSnippet?.rating,
      reviewCount: r.richSnippet?.reviewCount,
      store: new URL(r.url).hostname,
      url: r.url,
      imageUrl: '',
    }));

    return {
      query: request.query,
      results,
      filters: { priceRange: { min: 0, max: 1000 }, brands: [], stores: [] },
      timestamp: Date.now(),
    };
  }

  /** Google Maps search. */
  async maps(request: MapsRequest): Promise<MapsResponse> {
    const searchResponse = await this.serp.search({
      query: `${request.query} ${request.type || ''}`,
      type: 'maps',
      country: request.country,
    });

    const results = searchResponse.results.map((r, i) => ({
      position: i + 1,
      name: r.title,
      address: r.snippet,
      rating: r.richSnippet?.rating,
      reviewCount: r.richSnippet?.reviewCount,
      category: request.type || 'establishment',
      url: r.url,
      coordinates: { lat: 0, lng: 0 },
      photos: [],
    }));

    return {
      query: request.query,
      results,
      totalResults: results.length,
      searchArea: request.country || 'us',
      timestamp: Date.now(),
    };
  }

  /** Solve a Google CAPTCHA. */
  async solveCaptcha(options: {
    type: 'recaptcha_v2' | 'recaptcha_v3' | 'recaptcha_enterprise';
    siteKey: string;
    pageUrl: string;
    action?: string;
    minScore?: number;
  }) {
    return this.captcha.solve(options);
  }

  /** Get comprehensive statistics. */
  getStats(): GoogleSuiteStats {
    const serpStats = this.serp.getStats();
    const captchaStats = this.captcha.getStats();

    return {
      searchesPerformed: serpStats.totalSearches,
      shoppingQueriesPerformed: 0,
      mapsQueriesPerformed: 0,
      captchasSolved: captchaStats.solved,
      captchasFailed: captchaStats.failed,
      blocksEncountered: serpStats.blocks,
      avgResponseTime: 0,
      bySearchType: { web: 0, image: 0, video: 0, news: 0, scholar: 0, shopping: 0, maps: 0 },
    };
  }
}

/** Singleton instance. */
export const googleSuiteManager = new GoogleSuiteManager();
