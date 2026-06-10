/**
 * Google Suite Module — ScrapeSuite Engine
 *
 * Enterprise-grade Google scraping with SERP extraction, Shopping,
 * Maps, and reCAPTCHA handling. Designed for scale with intelligent
 * rate limiting and anti-detection.
 */

// Types
export type {
  SearchType, SearchLanguage, SearchRequest, SearchResult, SearchResponse,
  ShoppingRequest, ShoppingResult, ShoppingResponse,
  MapsRequest, MapsResult, MapsResponse,
  CaptchaType, CaptchaProvider, CaptchaTask, CaptchaSolution, CaptchaConfig,
  GoogleAPI, GoogleAPIConfig,
  GoogleSuiteConfig, GoogleSuiteStats,
} from './types';

// SERP Engine
export { SERPEngine, serpEngine } from './serp-engine';

// CAPTCHA Handler
export { CaptchaHandler, DEFAULT_CAPTCHA_CONFIG, captchaHandler } from './captcha-handler';

// Manager
export { GoogleSuiteManager, DEFAULT_GOOGLE_SUITE_CONFIG, googleSuiteManager } from './manager';
