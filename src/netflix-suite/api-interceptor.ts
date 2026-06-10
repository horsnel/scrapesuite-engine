/**
 * Netflix API Interceptor — ScrapeSuite Engine
 *
 * Intercepts and parses Netflix's proprietary shakti API responses.
 * Netflix uses a custom API (codenamed "shakti") that delivers
 * catalog data, search results, and title metadata as JSON responses
 * with a specific structure.
 *
 * Key Netflix API endpoints:
 * - /browse: Main browse page with genre rows
 * - /search: Search suggestions and results
 * - /title/{id}: Title detail page with metadata
 * - /api/shakti: Primary API for catalog data
 * - /api/preferred_content: Personalized recommendations
 * - /api/metadata: Title metadata (cast, crew, etc.)
 * - /api/locakup: Artwork and image URLs
 *
 * The interceptor captures these API calls from the browser's
 * network traffic, parses the JSON responses, and extracts
 * structured data.
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type { NetflixAPIEndpoint, NetflixAPIConfig, NetflixAPIRequest, NetflixAPIResponse } from './types';

const logger = createChildLogger('netflix-api-interceptor');

const API_CACHE_PREFIX = 'netflix:api:';
const INTERCEPTED_PREFIX = 'netflix:intercepted:';

// ===============================================================================
// DEFAULT API CONFIG
// ===============================================================================

export const DEFAULT_NETFLIX_API_CONFIG: NetflixAPIConfig = {
  apiBaseUrl: 'https://www.netflix.com/api/shakti',
  interceptResponses: true,
  replayAPICalls: false,
  apiVersion: 'v891a2c53',
  customHeaders: {
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  cacheResponses: true,
  cacheTTL: 3600,
};

// ===============================================================================
// NETFLIX API RESPONSE PARSERS
// ===============================================================================

/** Parse a Netflix browse API response into structured data. */
function parseBrowseResponse(data: any): any {
  if (!data) return null;

  const result: any = {
    genreRows: [],
    featuredTitles: [],
  };

  // Netflix browse response contains "lists" with genre rows
  if (data.lists) {
    for (const list of data.lists) {
      result.genreRows.push({
        id: list.id,
        name: list.displayName || list.contextName,
        titles: (list.titles || []).map((t: any) => parseTitleSummary(t)),
      });
    }
  }

  // Featured/trending content
  if ( data.featuredTitles) {
    result.featuredTitles = data.featuredTitles.map((t: any) => parseTitleSummary(t));
  }

  return result;
}

/** Parse a Netflix title summary from API response. */
function parseTitleSummary(data: any): any {
  if (!data) return null;

  return {
    netflixId: data.id || data.titleId,
    title: data.title || data.name,
    type: data.type || (data.isSeries ? 'series' : 'movie'),
    year: data.releaseYear,
    maturityRating: data.maturity?.rating?.value,
    runtime: data.runtime,
    imageUrl: data.artWork?.url || data.boxart?.url,
    synopsis: data.synopsis || data.shortSynopsis,
    genres: data.genres?.map((g: any) => g.name) || [],
    cast: data.cast?.map((c: any) => c.name) || [],
    rating: data.userRating?.matchScore,
    availability: {
      available: true,
      isNew: data.isNew,
      isTrending: data.isTrending,
      isTop10: data.isTop10,
    },
  };
}

/** Parse a Netflix search API response. */
function parseSearchResponse(data: any): any {
  if (!data) return null;

  return {
    results: (data.titles || []).map((t: any) => parseTitleSummary(t)),
    suggestions: data.suggestions || [],
    query: data.searchTerm,
  };
}

/** Parse Netflix metadata response. */
function parseMetadataResponse(data: any): any {
  if (!data) return null;

  return {
    netflixId: data.id,
    title: data.title,
    type: data.type,
    description: data.synopsis,
    year: data.releaseYear,
    maturity: data.maturity,
    cast: data.cast?.map((c: any) => ({ name: c.name, role: c.role })) || [],
    crew: data.crew?.map((c: any) => ({ name: c.name, role: c.role })) || [],
    genres: data.genres?.map((g: any) => g.name) || [],
    tags: data.tags?.map((t: any) => t.name) || [],
    artwork: data.artWork || [],
    runtime: data.runtime,
    seasons: data.seasons?.map((s: any) => ({
      number: s.seq,
      episodes: s.episodes?.map((e: any) => ({
        number: e.seq,
        title: e.title,
        runtime: e.runtime,
        synopsis: e.synopsis,
      })),
    })),
  };
}

// ===============================================================================
// API INTERCEPTOR CLASS
// ===============================================================================

export class APIInterceptor {
  private config: NetflixAPIConfig;
  private interceptedCalls: Map<string, NetflixAPIResponse> = new Map();
  private interceptCount: number = 0;

  constructor(config?: Partial<NetflixAPIConfig>) {
    this.config = { ...DEFAULT_NETFLIX_API_CONFIG, ...config };
  }

  /**
   * Intercept a Netflix API response and parse it.
   * This is called when a network response is captured from the browser.
   */
  async interceptResponse(url: string, status: number, responseData: any, headers: Record<string, string>): Promise<NetflixAPIResponse | null> {
    const endpoint = this.identifyEndpoint(url);
    if (!endpoint) return null;

    this.interceptCount++;
    const timestamp = Date.now();

    logger.debug({ url: url.substring(0, 80), endpoint, status }, 'Intercepted Netflix API response');

    // Parse the response based on endpoint type
    let parsedData: any;
    switch (endpoint) {
      case 'browse':
        parsedData = parseBrowseResponse(responseData);
        break;
      case 'search':
        parsedData = parseSearchResponse(responseData);
        break;
      case 'title':
      case 'metadata':
        parsedData = parseMetadataResponse(responseData);
        break;
      default:
        parsedData = responseData;
    }

    const apiResponse: NetflixAPIResponse = {
      endpoint,
      status,
      data: parsedData,
      headers,
      timestamp,
    };

    // Cache intercepted response
    if (this.config.cacheResponses) {
      const cacheKey = createHash('sha256')
        .update(`${endpoint}:${url}:${timestamp}`)
        .digest('hex')
        .substring(0, 16);
      await cacheSet(`${API_CACHE_PREFIX}${cacheKey}`, apiResponse, this.config.cacheTTL);
      this.interceptedCalls.set(cacheKey, apiResponse);
    }

    return apiResponse;
  }

  /**
   * Build a Netflix API request URL.
   */
  buildAPIRequest(request: NetflixAPIRequest): string {
    const base = this.config.apiBaseUrl;
    const version = this.config.apiVersion;

    switch (request.endpoint) {
      case 'browse':
        return `${base}/${version}/browse?${new URLSearchParams(request.params || {}).toString()}`;
      case 'search':
        return `${base}/${version}/search?${new URLSearchParams(request.params || {}).toString()}`;
      case 'title':
        return `${base}/${version}/title/${request.path || ''}`;
      case 'metadata':
        return `${base}/${version}/metadata?${new URLSearchParams(request.params || {}).toString()}`;
      case 'genre_list':
        return `${base}/${version}/genreList`;
      case 'artwork':
        return `${base}/${version}/artwork?${new URLSearchParams(request.params || {}).toString()}`;
      default:
        return `${base}/${version}/${request.endpoint}`;
    }
  }

  /**
   * Generate network interception rules for Playwright.
   * These rules tell the browser which requests to capture.
   */
  getInterceptionRules(): Array<{
    pattern: string | RegExp;
    method?: string;
    endpoint: NetflixAPIEndpoint;
  }> {
    return [
      { pattern: /\/api\/shakti\/.*\/browse/, endpoint: 'browse' },
      { pattern: /\/api\/shakti\/.*\/search/, endpoint: 'search' },
      { pattern: /\/api\/shakti\/.*\/title\//, endpoint: 'title' },
      { pattern: /\/api\/shakti\/.*\/metadata/, endpoint: 'metadata' },
      { pattern: /\/api\/shakti\/.*\/genreList/, endpoint: 'genre_list' },
      { pattern: /\/api\/shakti\/.*\/artwork/, endpoint: 'artwork' },
      { pattern: /\/api\/preferred_content/, endpoint: 'browse' },
      { pattern: /\/api\/locakup/, endpoint: 'artwork' },
    ];
  }

  /** Identify the Netflix API endpoint from a URL. */
  private identifyEndpoint(url: string): NetflixAPIEndpoint | null {
    if (url.includes('/browse') || url.includes('/preferred_content')) return 'browse';
    if (url.includes('/search')) return 'search';
    if (url.includes('/title/')) return 'title';
    if (url.includes('/metadata')) return 'metadata';
    if (url.includes('/genreList')) return 'genre_list';
    if (url.includes('/artwork') || url.includes('/locakup')) return 'artwork';
    if (url.includes('/shakti')) return 'shakti';
    return null;
  }

  /** Get interception statistics. */
  getStats(): { interceptedCalls: number; uniqueEndpoints: number } {
    return {
      interceptedCalls: this.interceptCount,
      uniqueEndpoints: new Set(Array.from(this.interceptedCalls.values()).map(r => r.endpoint)).size,
    };
  }
}

/** Singleton instance. */
export const apiInterceptor = new APIInterceptor();
