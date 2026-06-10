/**
 * Google Suite Types — ScrapeSuite Engine
 *
 * Type definitions for Google-specific scraping capabilities
 * including Search, Shopping, Maps, News, Scholar, and reCAPTCHA.
 */

// ===============================================================================
// SEARCH ENGINE TYPES
// ===============================================================================

export type SearchType = 'web' | 'image' | 'video' | 'news' | 'scholar' | 'shopping' | 'maps';
export type SearchLanguage = 'en' | 'es' | 'fr' | 'de' | 'pt' | 'ja' | 'ko' | 'zh-CN' | 'zh-TW' | 'ar' | 'hi' | 'ru';

export interface SearchRequest {
  query: string;
  type: SearchType;
  language?: SearchLanguage;
  country?: string;
  page?: number;
  resultsPerPage?: number;
  safeSearch?: boolean;
  dateRange?: { start: string; end: string };
  siteFilter?: string;
  exactMatch?: string;
  excludeTerms?: string[];
  proxyTier?: 'residential' | 'mobile';
  proxyCountry?: string;
}

export interface SearchResult {
  position: number;
  title: string;
  url: string;
  displayUrl: string;
  snippet: string;
  date?: string;
  richSnippet?: {
    rating?: number;
    reviewCount?: number;
    price?: string;
    availability?: string;
    featured?: boolean;
    sitelinks?: Array<{ title: string; url: string }>;
  };
}

export interface SearchResponse {
  query: string;
  type: SearchType;
  totalResults?: string;
  searchTime?: number;
  results: SearchResult[];
  relatedSearches: string[];
  peopleAlsoAsk: string[];
  currentPage: number;
  hasNextPage: boolean;
  timestamp: number;
}

// ===============================================================================
// GOOGLE SHOPPING TYPES
// ===============================================================================

export interface ShoppingRequest {
  query: string;
  country?: string;
  language?: SearchLanguage;
  minPrice?: number;
  maxPrice?: number;
  sortBy?: 'relevance' | 'price_low' | 'price_high' | 'rating';
  productCondition?: 'new' | 'used' | 'refurbished';
  shopFilter?: string;
}

export interface ShoppingResult {
  position: number;
  title: string;
  price: string;
  currency: string;
  originalPrice?: string;
  rating?: number;
  reviewCount?: number;
  store: string;
  storeRating?: number;
  url: string;
  imageUrl: string;
  productId?: string;
  description?: string;
  shipping?: string;
}

export interface ShoppingResponse {
  query: string;
  results: ShoppingResult[];
  filters: {
    priceRange: { min: number; max: number };
    brands: string[];
    stores: string[];
  };
  timestamp: number;
}

// ===============================================================================
// GOOGLE MAPS TYPES
// ===============================================================================

export interface MapsRequest {
  query: string;
  location?: { lat: number; lng: number };
  radius?: number; // meters
  type?: 'restaurant' | 'hotel' | 'gas_station' | 'grocery' | 'hospital' | 'pharmacy' | 'school' | 'atm' | 'parking';
  country?: string;
  language?: SearchLanguage;
  minRating?: number;
  openNow?: boolean;
}

export interface MapsResult {
  position: number;
  name: string;
  address: string;
  rating?: number;
  reviewCount?: number;
  category: string;
  phone?: string;
  website?: string;
  hours?: Record<string, string>;
  coordinates: { lat: number; lng: number };
  url: string;
  priceLevel?: number; // 1-4
  photos: string[];
}

export interface MapsResponse {
  query: string;
  results: MapsResult[];
  totalResults: number;
  searchArea: string;
  timestamp: number;
}

// ===============================================================================
// CAPTCHA HANDLER TYPES
// ===============================================================================

export type CaptchaType = 'recaptcha_v2' | 'recaptcha_v3' | 'recaptcha_enterprise';
export type CaptchaProvider = '2captcha' | 'anticaptcha' | 'capmonster' | 'internal';

export interface CaptchaTask {
  id: string;
  type: CaptchaType;
  siteKey: string;
  pageUrl: string;
  action?: string;
  minScore?: number;
  proxyUrl?: string;
  createdAt: number;
}

export interface CaptchaSolution {
  taskId: string;
  token: string;
  solveTimeMs: number;
  cost: number;
  provider: CaptchaProvider;
  score?: number; // For v3
}

export interface CaptchaConfig {
  defaultProvider: CaptchaProvider;
  providers: Record<CaptchaProvider, { apiKey: string; maxConcurrent: number; costPerSolve: number }>;
  maxSolveTime: number;
  retryOnFailure: boolean;
  maxRetries: number;
  cacheTokens: boolean;
  tokenCacheTTL: number;
  /** Google-specific: minimum reCAPTCHA v3 score needed */
  googleMinScore: number;
  /** Netflix-specific: reCAPTCHA v2 solving */
  netflixCaptcha: boolean;
}

// ===============================================================================
// API CLIENT TYPES
// ===============================================================================

export type GoogleAPI = 'custom_search' | 'geocoding' | 'places' | 'knowledge_graph' | 'trends';

export interface GoogleAPIConfig {
  apiKey: string;
  cx?: string; // Custom Search Engine ID
  enabledAPIs: GoogleAPI[];
  dailyQuota: Record<GoogleAPI, number>;
  rateLimitPerSecond: number;
}

export interface GoogleSuiteConfig {
  search: {
    maxConcurrentSearches: number;
    defaultLanguage: SearchLanguage;
    defaultCountry: string;
    respectRobotsTxt: boolean;
    delayBetweenPages: number;
    maxPagesPerQuery: number;
    useAPI: boolean;
  };
  shopping: {
    enabled: boolean;
    maxConcurrent: number;
  };
  maps: {
    enabled: boolean;
    maxConcurrent: number;
    usePlacesAPI: boolean;
  };
  captcha: CaptchaConfig;
  api: GoogleAPIConfig;
}

export interface GoogleSuiteStats {
  searchesPerformed: number;
  shoppingQueriesPerformed: number;
  mapsQueriesPerformed: number;
  captchasSolved: number;
  captchasFailed: number;
  blocksEncountered: number;
  avgResponseTime: number;
  bySearchType: Record<SearchType, number>;
}
