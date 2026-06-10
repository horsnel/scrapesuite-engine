/**
 * Netflix Suite Module — ScrapeSuite Engine
 *
 * Enterprise-grade Netflix scraping with catalog extraction, search,
 * regional availability checking, and API interception. Designed to
 * bypass Akamai Bot Manager Enterprise with full infrastructure support.
 */

// Types
export type {
  NetflixContentType, NetflixMaturityRating, NetflixTitle, NetflixAvailability,
  CatalogRequest, CatalogResponse,
  NetflixSearchRequest, NetflixSearchResult, NetflixSearchResponse,
  AvailabilityRequest, AvailabilityResult, AvailabilityResponse,
  NetflixAPIEndpoint, NetflixAPIConfig, NetflixAPIRequest, NetflixAPIResponse,
  NetflixSuiteConfig, NetflixSuiteStats,
} from './types';

// Catalog Extractor
export { CatalogExtractor, catalogExtractor } from './catalog-extractor';

// API Interceptor
export { APIInterceptor, DEFAULT_NETFLIX_API_CONFIG, apiInterceptor } from './api-interceptor';

// Availability Checker
export { AvailabilityChecker, availabilityChecker } from './availability-checker';

// Manager
export { NetflixSuiteManager, DEFAULT_NETFLIX_SUITE_CONFIG, netflixSuiteManager } from './manager';
