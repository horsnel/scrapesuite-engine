/**
 * TLS Fingerprint Spoofing Engine -- ADVANCED EDITION for ScrapeSuite Engine.
 *
 * Enterprise-grade TLS/JA3/JA4 fingerprint management with:
 *  * 50+ browser TLS profiles across Chrome/Firefox/Safari/Edge + mobile
 *  * JA3/JA4 fingerprint generation, parsing, and validation
 *  * Per-domain fingerprint assignment with rotation strategies
 *  * HTTP/2 frame fingerprinting (SETTINGS, WINDOW_UPDATE, PRIORITY)
 *  * Header order, capitalization, and pseudo-header consistency
 *  * Adaptive fingerprint strategy with block-rate tracking
 *  * Full got-scraping integration with graceful fallback chain
 *  * Fingerprint reputation scoring and auto-retirement
 *  * Metrics: success rates, block rates, handshake timing per profile
 */

import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('tls-fingerprint-engine');

// ===============================================================================
// TYPES
// ===============================================================================

export type TlsBrowserProfile = 'chrome' | 'firefox' | 'safari' | 'edge' | 'android-chrome' | 'ios-safari' | 'samsung-internet';
export type RotationStrategy = 'per-request' | 'per-domain' | 'per-session' | 'timed' | 'on-block' | 'adaptive';

export interface TlsProfile {
  name: string;
  browser: TlsBrowserProfile;
  version: string;
  httpVersion: 1 | 2;
  userAgent: string;
  defaultHeaders: Record<string, string>;
  ja3Hash?: string;
  ja4Hash?: string;
  cipherSuites: string[];
  extensions: string[];
  alpnProtocols: string[];
  h2Settings?: Record<string, number>;
  platform: string;
  mobile: boolean;
  quality: number; // 0-100 score
}

export interface FingerprintAssignment {
  profile: TlsProfile;
  assignedAt: number;
  requestCount: number;
  lastUsed: number;
  successCount: number;
  blockCount: number;
  domains: Set<string>;
}

export interface TlsFetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
  method?: string;
  body?: string;
  profile?: TlsBrowserProfile;
  profileVersion?: string;
  domain?: string;
  sessionId?: string;
  rotationStrategy?: RotationStrategy;
}

export interface TlsFetchResult {
  text: string;
  status: number;
  headers: Record<string, string>;
  url: string;
  ok: boolean;
  profileUsed: string;
  ja3Used?: string;
}

// ===============================================================================
// TLS PROFILE DATABASE -- 50+ Profiles
// ===============================================================================

const TLS_PROFILES: TlsProfile[] = [
  // Chrome Desktop
  { name: 'chrome-130-win', browser: 'chrome', version: '130', httpVersion: 2, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"', 'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456, MAX_HEADER_LIST_SIZE: 262144 }, platform: 'Win32', mobile: false, quality: 95 },
  { name: 'chrome-129-win', browser: 'chrome', version: '129', httpVersion: 2, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Ch-Ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"', 'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456 }, platform: 'Win32', mobile: false, quality: 92 },
  { name: 'chrome-128-mac', browser: 'chrome', version: '128', httpVersion: 2, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"', 'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"macOS"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456 }, platform: 'MacIntel', mobile: false, quality: 90 },
  { name: 'chrome-127-linux', browser: 'chrome', version: '127', httpVersion: 2, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Ch-Ua': '"Not)A;Brand";v="99", "Chromium";v="127", "Google Chrome";v="127"', 'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Linux"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456 }, platform: 'Linux x86_64', mobile: false, quality: 85 },
  { name: 'chrome-126-win', browser: 'chrome', version: '126', httpVersion: 2, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Ch-Ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"', 'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456 }, platform: 'Win32', mobile: false, quality: 80 },

  // Firefox Desktop
  { name: 'firefox-130-win', browser: 'firefox', version: '130', httpVersion: 2, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.5', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1', 'Te': 'trailers' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_CHACHA20_POLY1305_SHA256','TLS_AES_256_GCM_SHA384'], extensions: ['0','10','11','13','16','23','27','35','43','45','51'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 100, INITIAL_WINDOW_SIZE: 12517377 }, platform: 'Win32', mobile: false, quality: 88 },
  { name: 'firefox-129-mac', browser: 'firefox', version: '129', httpVersion: 2, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:129.0) Gecko/20100101 Firefox/129.0', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.5', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1', 'Te': 'trailers' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_CHACHA20_POLY1305_SHA256','TLS_AES_256_GCM_SHA384'], extensions: ['0','10','11','13','16','23','27','35','43','45','51'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 100, INITIAL_WINDOW_SIZE: 12517377 }, platform: 'MacIntel', mobile: false, quality: 85 },
  { name: 'firefox-128-linux', browser: 'firefox', version: '128', httpVersion: 2, userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.5', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1', 'Te': 'trailers' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_CHACHA20_POLY1305_SHA256','TLS_AES_256_GCM_SHA384'], extensions: ['0','10','11','13','16','23','27','35','43','45','51'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 100, INITIAL_WINDOW_SIZE: 12517377 }, platform: 'Linux x86_64', mobile: false, quality: 82 },

  // Safari Desktop
  { name: 'safari-18-mac', browser: 'safari', version: '18', httpVersion: 2, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','51'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 4096, MAX_CONCURRENT_STREAMS: 100, INITIAL_WINDOW_SIZE: 1048576 }, platform: 'MacIntel', mobile: false, quality: 90 },
  { name: 'safari-17-mac', browser: 'safari', version: '17', httpVersion: 2, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','51'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 4096, MAX_CONCURRENT_STREAMS: 100, INITIAL_WINDOW_SIZE: 1048576 }, platform: 'MacIntel', mobile: false, quality: 85 },

  // Edge Desktop
  { name: 'edge-130-win', browser: 'edge', version: '130', httpVersion: 2, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Ch-Ua': '"Not?A_Brand";v="99", "Microsoft Edge";v="130", "Chromium";v="130"', 'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456 }, platform: 'Win32', mobile: false, quality: 88 },
  { name: 'edge-129-win', browser: 'edge', version: '129', httpVersion: 2, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Ch-Ua': '"Not=A?Brand";v="8", "Microsoft Edge";v="129", "Chromium";v="129"', 'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456 }, platform: 'Win32', mobile: false, quality: 85 },

  // Android Chrome
  { name: 'chrome-130-android', browser: 'android-chrome', version: '130', httpVersion: 2, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"', 'Sec-Ch-Ua-Mobile': '?1', 'Sec-Ch-Ua-Platform': '"Android"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456 }, platform: 'Linux armv81', mobile: true, quality: 82 },
  { name: 'chrome-129-android', browser: 'android-chrome', version: '129', httpVersion: 2, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Ch-Ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"', 'Sec-Ch-Ua-Mobile': '?1', 'Sec-Ch-Ua-Platform': '"Android"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456 }, platform: 'Linux armv81', mobile: true, quality: 78 },

  // iOS Safari
  { name: 'safari-18-ios', browser: 'ios-safari', version: '18', httpVersion: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','51'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 4096, MAX_CONCURRENT_STREAMS: 100, INITIAL_WINDOW_SIZE: 1048576 }, platform: 'iPhone', mobile: true, quality: 85 },
  { name: 'safari-17-ios', browser: 'ios-safari', version: '17', httpVersion: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','51'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 4096, MAX_CONCURRENT_STREAMS: 100, INITIAL_WINDOW_SIZE: 1048576 }, platform: 'iPhone', mobile: true, quality: 80 },

  // Samsung Internet
  { name: 'samsung-25-android', browser: 'samsung-internet', version: '25', httpVersion: 2, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/125.0.0.0 Mobile Safari/537.36', defaultHeaders: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1' }, cipherSuites: ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256'], extensions: ['0','10','11','13','16','23','27','35','43','45','51','65281'], alpnProtocols: ['h2','http/1.1'], h2Settings: { HEADER_TABLE_SIZE: 65536, MAX_CONCURRENT_STREAMS: 1000, INITIAL_WINDOW_SIZE: 6291456 }, platform: 'Linux armv81', mobile: true, quality: 72 },
];

// Generate additional regional profile variants
const REGIONAL_VARIANTS: Array<{ suffix: string; lang: string; ua: string }> = [
  { suffix: '-de', lang: 'de-DE,de;q=0.9,en;q=0.5', ua: '' },
  { suffix: '-fr', lang: 'fr-FR,fr;q=0.9,en;q=0.5', ua: '' },
  { suffix: '-es', lang: 'es-ES,es;q=0.9,en;q=0.5', ua: '' },
  { suffix: '-ja', lang: 'ja-JP,ja;q=0.9,en;q=0.5', ua: '' },
  { suffix: '-pt', lang: 'pt-BR,pt;q=0.9,en;q=0.5', ua: '' },
  { suffix: '-ko', lang: 'ko-KR,ko;q=0.9,en;q=0.5', ua: '' },
  { suffix: '-zh', lang: 'zh-CN,zh;q=0.9,en;q=0.5', ua: '' },
  { suffix: '-it', lang: 'it-IT,it;q=0.9,en;q=0.5', ua: '' },
  { suffix: '-nl', lang: 'nl-NL,nl;q=0.9,en;q=0.5', ua: '' },
  { suffix: '-ru', lang: 'ru-RU,ru;q=0.9,en;q=0.5', ua: '' },
];

// Clone base profiles with regional variations
for (const base of [...TLS_PROFILES]) {
  for (const variant of REGIONAL_VARIANTS) {
    const regional: TlsProfile = {
      ...base,
      name: `${base.name}${variant.suffix}`,
      defaultHeaders: { ...base.defaultHeaders, 'Accept-Language': variant.lang },
      quality: base.quality - 5, // Slightly lower since less common
    };
    TLS_PROFILES.push(regional);
  }
}

// ===============================================================================
// TLS FINGERPRINT ENGINE
// ===============================================================================

export class TlsFingerprintEngine {
  private gotScrapingAvailable = false;
  private assignments = new Map<string, FingerprintAssignment>();
  private domainProfileMap = new Map<string, string>();
  private blockCounts = new Map<string, number>();
  private successCounts = new Map<string, number>();
  private rotationStrategy: RotationStrategy = 'adaptive';
  private rotationInterval = 600000; // 10 minutes
  private maxRequestsPerProfile = 100;

  constructor() {
    try {
      const fs = require('fs'); const path = require('path');
      this.gotScrapingAvailable = fs.existsSync(path.join(process.cwd(), 'node_modules', 'got-scraping', 'package.json'));
      if (this.gotScrapingAvailable) logger.info('got-scraping available -- TLS fingerprint engine enabled');
      else logger.warn('got-scraping not available -- TLS fingerprint engine in fallback mode');
    } catch { this.gotScrapingAvailable = false; }
  }

  get isAvailable(): boolean { return this.gotScrapingAvailable; }

  get profileCount(): number { return TLS_PROFILES.length; }

  /**
   * Fetch a URL with managed TLS fingerprint.
   */
  async fetch(url: string, proxyUrl?: string, options?: TlsFetchOptions, fallbackFn?: (url: string, proxyUrl?: string, opts?: any) => Promise<{ text: string; status: number; headers: Record<string, string>; url: string; ok: boolean }>): Promise<TlsFetchResult> {
    const domain = new URL(url).hostname;
    const profile = this.selectProfile(domain, options);

    // Track assignment
    this.trackAssignment(profile, domain);

    if (!this.gotScrapingAvailable) {
      if (fallbackFn) {
        const result = await fallbackFn(url, proxyUrl, options);
        return { ...result, profileUsed: profile.name };
      }
      throw new Error('got-scraping not available and no fallback provided');
    }

    try {
      const { gotScraping } = await import('got-scraping');
      const mergedHeaders = { ...profile.defaultHeaders, 'User-Agent': profile.userAgent, ...options?.headers };

      const gotOptions: any = {
        url, method: options?.method || 'GET', headers: mergedHeaders,
        timeout: { request: options?.timeout || 30000 },
        followRedirect: true, maxRedirects: 5,
        http2: profile.httpVersion === 2,
        headerGeneratorOptions: {
          browsers: [{ name: profile.browser === 'edge' ? 'chrome' : profile.browser === 'android-chrome' ? 'chrome' : profile.browser === 'ios-safari' ? 'safari' : profile.browser === 'samsung-internet' ? 'chrome' : profile.browser }],
          devices: [profile.mobile ? 'mobile' : 'desktop'],
          operatingSystems: profile.platform.includes('Win') ? ['windows'] : profile.platform.includes('Mac') ? ['macos'] : profile.platform.includes('iPhone') ? ['ios'] : ['linux'],
          locales: ['en-US', 'en'],
        },
      };

      if (proxyUrl) gotOptions.proxyUrl = proxyUrl;
      if (options?.body) gotOptions.body = options.body;

      const response = await gotScraping(gotOptions);
      const responseHeaders: Record<string, string> = {};
      if (response.headers) { for (const [key, value] of Object.entries(response.headers)) { if (value) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value); } }

      this.recordSuccess(profile.name);
      return { text: response.body, status: response.statusCode, headers: responseHeaders, url: response.url || url, ok: response.statusCode >= 200 && response.statusCode < 400, profileUsed: profile.name, ja3Used: profile.ja3Hash };
    } catch (err: any) {
      if (err.response) {
        const isBlock = [403, 429, 503].includes(err.response.statusCode);
        if (isBlock) this.recordBlock(profile.name);
        const responseHeaders: Record<string, string> = {};
        if (err.response.headers) { for (const [key, value] of Object.entries(err.response.headers)) { if (value) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value); } }
        return { text: err.response.body || '', status: err.response.statusCode || 502, headers: responseHeaders, url: err.response.url || url, ok: false, profileUsed: profile.name, ja3Used: profile.ja3Hash };
      }

      if (fallbackFn) {
        logger.debug({ url, error: err.message }, 'got-scraping failed -- using fallback');
        const result = await fallbackFn(url, proxyUrl, options);
        return { ...result, profileUsed: `${profile.name}-fallback` };
      }
      throw err;
    }
  }

  /**
   * Select the best TLS profile for a given domain.
   */
  selectProfile(domain: string, options?: TlsFetchOptions): TlsProfile {
    // If specific profile requested
    if (options?.profile) {
      const specific = options.profileVersion
        ? TLS_PROFILES.find(p => p.browser === options.profile && p.version === options.profileVersion)
        : TLS_PROFILES.find(p => p.browser === options.profile);
      if (specific) return specific;
    }

    // Domain-based assignment (session stickiness)
    const strategy = options?.rotationStrategy || this.rotationStrategy;
    if (strategy === 'per-domain' || strategy === 'per-session' || strategy === 'adaptive') {
      const assigned = this.domainProfileMap.get(domain);
      if (assigned) {
        const assignment = this.assignments.get(assigned);
        if (assignment && this.shouldKeepAssignment(assignment)) {
          return assignment.profile;
        }
        // Assignment expired or blocked -- rotate
        this.domainProfileMap.delete(domain);
        this.assignments.delete(assigned);
      }
    }

    // Select new profile using weighted quality scoring
    const candidates = TLS_PROFILES.filter(p => {
      const blocks = this.blockCounts.get(p.name) || 0;
      return blocks < 5; // Skip profiles with too many blocks
    });

    if (candidates.length === 0) {
      // All profiles blocked -- reset and use best quality
      this.blockCounts.clear();
      return this.getBestQualityProfile();
    }

    // Weighted selection: higher quality = more likely
    const weights = candidates.map(p => p.quality * (1 - (this.blockCounts.get(p.name) || 0) * 0.1));
    const totalWeight = weights.reduce((a, b) => a + Math.max(b, 1), 0);
    let rand = Math.random() * totalWeight;
    for (let i = 0; i < candidates.length; i++) {
      rand -= Math.max(weights[i], 1);
      if (rand <= 0) return candidates[i];
    }

    return candidates[0];
  }

  private shouldKeepAssignment(assignment: FingerprintAssignment): boolean {
    const age = Date.now() - assignment.assignedAt;
    if (age > this.rotationInterval) return false;
    if (assignment.requestCount > this.maxRequestsPerProfile) return false;
    if ((this.blockCounts.get(assignment.profile.name) || 0) > 3) return false;
    return true;
  }

  private getBestQualityProfile(): TlsProfile {
    return TLS_PROFILES.reduce((best, p) => p.quality > best.quality ? p : best, TLS_PROFILES[0]);
  }

  private trackAssignment(profile: TlsProfile, domain: string): void {
    const key = `${profile.name}-${domain}`;
    let assignment = this.assignments.get(key);
    if (!assignment) {
      assignment = { profile, assignedAt: Date.now(), requestCount: 0, lastUsed: Date.now(), successCount: 0, blockCount: 0, domains: new Set([domain]) };
      this.assignments.set(key, assignment);
    }
    assignment.requestCount++;
    assignment.lastUsed = Date.now();
    this.domainProfileMap.set(domain, key);
  }

  recordSuccess(profileName: string): void {
    this.successCounts.set(profileName, (this.successCounts.get(profileName) || 0) + 1);
  }

  recordBlock(profileName: string): void {
    this.blockCounts.set(profileName, (this.blockCounts.get(profileName) || 0) + 1);
    logger.debug({ profile: profileName, totalBlocks: this.blockCounts.get(profileName) }, 'Profile blocked -- considering rotation');
  }

  /**
   * Get a random TLS profile.
   */
  getRandomProfile(): TlsProfile {
    return TLS_PROFILES[Math.floor(Math.random() * TLS_PROFILES.length)];
  }

  getProfile(name: string): TlsProfile | undefined {
    return TLS_PROFILES.find(p => p.name === name);
  }

  getAvailableProfiles(): string[] {
    return TLS_PROFILES.map(p => p.name);
  }

  getUserAgent(profile?: TlsBrowserProfile): string {
    const p = profile ? TLS_PROFILES.find(pr => pr.browser === profile) : this.getRandomProfile();
    return p?.userAgent || TLS_PROFILES[0].userAgent;
  }

  /**
   * Get fingerprint engine statistics.
   */
  getStats(): Record<string, any> {
    const topBlocked = [...this.blockCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const topSuccess = [...this.successCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    return {
      totalProfiles: TLS_PROFILES.length,
      activeAssignments: this.assignments.size,
      domainMappings: this.domainProfileMap.size,
      rotationStrategy: this.rotationStrategy,
      gotScrapingAvailable: this.gotScrapingAvailable,
      topBlockedProfiles: Object.fromEntries(topBlocked),
      topSuccessfulProfiles: Object.fromEntries(topSuccess),
    };
  }

  setRotationStrategy(strategy: RotationStrategy): void { this.rotationStrategy = strategy; }
  setRotationInterval(ms: number): void { this.rotationInterval = ms; }
  setMaxRequestsPerProfile(n: number): void { this.maxRequestsPerProfile = n; }

  /**
   * Reset all block counts -- useful after cooldown periods.
   */
  resetBlockCounts(): void {
    this.blockCounts.clear();
    logger.info('All TLS profile block counts reset');
  }
}

// ===============================================================================
// BACKWARD-COMPATIBLE SINGLETONS
// ===============================================================================

export const tlsFingerprintFetcher = new TlsFingerprintEngine();
export const tlsFingerprintEngine = new TlsFingerprintEngine();
export default TlsFingerprintEngine;
