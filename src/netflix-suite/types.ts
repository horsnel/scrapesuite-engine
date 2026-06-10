/**
 * Netflix Suite Types — ScrapeSuite Engine
 *
 * Type definitions for Netflix-specific scraping capabilities
 * including catalog extraction, search, regional availability,
 * and API interception.
 */

// ===============================================================================
// CATALOG TYPES
// ===============================================================================

export type NetflixContentType = 'movie' | 'series' | 'documentary' | 'special' | 'short';
export type NetflixMaturityRating = 'G' | 'PG' | 'PG-13' | 'R' | 'TV-Y' | 'TV-Y7' | 'TV-G' | 'TV-PG' | 'TV-14' | 'TV-MA' | 'NR';

export interface NetflixTitle {
  id: string;
  netflixId: number;
  title: string;
  type: NetflixContentType;
  description: string;
  shortDescription: string;
  year: number;
  maturityRating: NetflixMaturityRating;
  runtime?: number; // minutes
  seasons?: number;
  episodes?: number;
  genres: string[];
  cast: string[];
  directors: string[];
  rating: number; // 0-5
  ratingCount: number;
  imageUrl: string;
  backdropUrl: string;
  trailerUrl?: string;
  dateAdded?: string;
  availability: NetflixAvailability;
  genres_raw: string[];
  tags: string[];
}

export interface NetflixAvailability {
  available: boolean;
  availableSince?: string;
  leavingOn?: string;
  regions: string[];
  isNew: boolean;
  isTrending: boolean;
  isTop10: boolean;
}

export interface CatalogRequest {
  region?: string;
  genre?: string;
  type?: NetflixContentType;
  page?: number;
  limit?: number;
  sortBy?: 'popularity' | 'date_added' | 'title' | 'rating' | 'year';
  includeAdult?: boolean;
  proxyTier?: 'residential' | 'mobile';
  proxyCountry?: string;
}

export interface CatalogResponse {
  titles: NetflixTitle[];
  totalResults: number;
  page: number;
  hasMore: boolean;
  region: string;
  genre?: string;
  timestamp: number;
}

// ===============================================================================
// SEARCH TYPES
// ===============================================================================

export interface NetflixSearchRequest {
  query: string;
  region?: string;
  type?: NetflixContentType;
  limit?: number;
  proxyCountry?: string;
}

export interface NetflixSearchResult {
  netflixId: number;
  title: string;
  type: NetflixContentType;
  year: number;
  maturityRating: NetflixMaturityRating;
  imageUrl: string;
  matchScore: number;
}

export interface NetflixSearchResponse {
  query: string;
  results: NetflixSearchResult[];
  suggestions: string[];
  region: string;
  timestamp: number;
}

// ===============================================================================
// AVAILABILITY TYPES
// ===============================================================================

export interface AvailabilityRequest {
  titleId?: string;
  netflixId?: number;
  title?: string;
  regions: string[];
  proxyTier?: 'residential' | 'mobile';
}

export interface AvailabilityResult {
  title: string;
  netflixId?: number;
  availableIn: Array<{
    region: string;
    available: boolean;
    availableSince?: string;
    leavingOn?: string;
    title?: string; // Region-specific title
  }>;
  unavailableIn: string[];
  lastChecked: number;
}

export interface AvailabilityResponse {
  results: AvailabilityResult[];
  totalRegionsChecked: number;
  timestamp: number;
}

// ===============================================================================
// API INTERCEPTION TYPES
// ===============================================================================

export type NetflixAPIEndpoint = 'browse' | 'search' | 'title' | 'genre_list' | 'artwork' | 'metadata' | 'shakti';

export interface NetflixAPIConfig {
  /** Base URL for Netflix API endpoints */
  apiBaseUrl: string;
  /** Whether to intercept API responses from browser */
  interceptResponses: boolean;
  /** Whether to replay API calls with modified parameters */
  replayAPICalls: boolean;
  /** Netflix API version */
  apiVersion: string;
  /** Custom headers for API requests */
  customHeaders: Record<string, string>;
  /** Whether to cache API responses */
  cacheResponses: boolean;
  /** Cache TTL in seconds */
  cacheTTL: number;
}

export interface NetflixAPIRequest {
  endpoint: NetflixAPIEndpoint;
  path?: string;
  params?: Record<string, string>;
  body?: Record<string, any>;
  method: 'GET' | 'POST';
}

export interface NetflixAPIResponse {
  endpoint: NetflixAPIEndpoint;
  status: number;
  data: any;
  headers: Record<string, string>;
  timestamp: number;
}

// ===============================================================================
// NETFLIX SUITE CONFIG
// ===============================================================================

export interface NetflixSuiteConfig {
  catalog: {
    maxConcurrent: number;
    defaultRegion: string;
    pagesPerRun: number;
    delayBetweenPages: number;
    useAPI: boolean;
  };
  search: {
    maxConcurrent: number;
    defaultRegion: string;
  };
  availability: {
    maxConcurrentRegions: number;
    delayBetweenRegions: number;
    cacheResults: boolean;
    cacheTTL: number;
  };
  api: NetflixAPIConfig;
  /** Netflix-specific proxy requirements */
  proxy: {
    requiredTier: 'residential' | 'mobile';
    stickySessionDuration: number;
    maxRPMPerIP: number;
    countries: string[];
  };
}

export interface NetflixSuiteStats {
  catalogExtractions: number;
  titlesExtracted: number;
  searchesPerformed: number;
  availabilityChecks: number;
  apiCallsIntercepted: number;
  blocksEncountered: number;
  captchasSolved: number;
  avgResponseTime: number;
  byRegion: Record<string, { extractions: number; blocks: number }>;
}
