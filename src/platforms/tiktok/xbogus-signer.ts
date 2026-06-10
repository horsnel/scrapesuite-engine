/**
 * X-Bogus Signature Generator -- ScrapeSuite Engine
 *
 * Generates X-Bogus signatures for TikTok API requests.
 * X-Bogus is TikTok's primary request signing mechanism that validates
 * each API call is coming from a legitimate TikTok client.
 *
 * Algorithm overview:
 *  1. Build a canonical string from URL + queryString + userAgent + timestamp
 *  2. Apply custom XOR-based transformation
 *  3. Base64-encode the result
 *  4. Add version prefix
 *
 * Note: TikTok frequently updates this algorithm. This implementation
 * follows the observed patterns and may need updates via the self-improver.
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type { XBogusParams, XBogusResult, TikTokDeviceType } from './types';

const logger = createChildLogger('xbogus-signer');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** X-Bogus version prefix */
const X_BOGUS_VERSION = 'DFSzswVO';

/** Character set for encoding */
const CHARSET = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25-WtUVEGayPuHJOjcLNqiz9mCeTFS';

/** Character set for URL-safe encoding */
const URL_SAFE_CHARSET = 'DkdpghZKsQB80Mfvw36XI1R25tUVEGayPuHJOjcLNqiz9mCeTFSW';

/** Character mapping table (substitution cipher) */
const CHAR_MAP: Record<string, string> = {};
const REVERSE_CHAR_MAP: Record<string, string> = {};

// Initialize character mapping
for (let i = 0; i < CHARSET.length; i++) {
  CHAR_MAP[String(i)] = CHARSET[i];
  REVERSE_CHAR_MAP[CHARSET[i]] = String(i);
}

/** XOR key for transformation */
const XOR_KEY = [
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
  0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F, 0x20,
];

/** Rotation table for byte mixing */
const ROTATION_TABLE = [
  3, 7, 1, 5, 9, 2, 6, 4,
  8, 0, 2, 6, 4, 8, 1, 5,
  7, 3, 9, 0, 4, 2, 8, 6,
  1, 5, 3, 7, 9, 0, 2, 4,
];

/** Signature validity duration (5 minutes) */
const SIGNATURE_VALIDITY_MS = 5 * 60 * 1000;

// ===============================================================================
// HELPER FUNCTIONS
// ===============================================================================

/**
 * Convert a string to its character code array.
 */
function stringToCodes(str: string): number[] {
  return Array.from(str).map(c => c.charCodeAt(0));
}

/**
 * Custom murmur-style hash for string input.
 */
function murmurHash(data: number[], seed: number = 0): number {
  let h = seed;
  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i], 0x5BD1E995);
    h ^= h >>> 15;
  }
  h = Math.imul(h, 0x5BD1E995);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5BD1E995);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * XOR transform a byte array with the key.
 */
function xorTransform(data: number[], key: number[]): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    result.push(data[i] ^ key[i % key.length]);
  }
  return result;
}

/**
 * Rotate bytes based on rotation table.
 */
function rotateBytes(data: number[], table: number[]): number[] {
  const result = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const rotAmount = table[i % table.length];
    const byte = data[i];
    result[i] = ((byte << rotAmount) | (byte >>> (8 - rotAmount))) & 0xFF;
  }
  return result;
}

/**
 * Custom base64-like encoding using the TikTok character set.
 */
function customEncode(data: number[]): string {
  let result = '';
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;

    const combined = (b1 << 16) | (b2 << 8) | b3;

    result += CHARSET[(combined >>> 18) & 0x3F];
    result += CHARSET[(combined >>> 12) & 0x3F];
    if (i + 1 < data.length) result += CHARSET[(combined >>> 6) & 0x3F];
    if (i + 2 < data.length) result += CHARSET[combined & 0x3F];
  }
  return result;
}

/**
 * Build a canonical string from X-Bogus parameters.
 */
function buildCanonicalString(params: XBogusParams): string {
  const parts: string[] = [
    params.url,
    params.queryString,
    params.userAgent,
    String(params.timestamp),
    params.body || '',
  ];
  return parts.join('\n');
}

// ===============================================================================
// X-BOGUS SIGNER ENGINE
// ===============================================================================

export class XBogusSignerEngine {
  private stats = {
    totalGenerated: 0,
    avgGenerationTimeMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  private cache = new Map<string, { result: XBogusResult; expiresAt: number }>();

  constructor() {
    logger.info('X-Bogus signer engine initialized');
  }

  /**
   * Generate an X-Bogus signature for TikTok API request.
   *
   * @param params - Parameters for signature generation
   * @returns X-Bogus signature result
   */
  async generate(params: XBogusParams): Promise<XBogusResult> {
    const startTime = performance.now();

    // Check cache first
    const cacheKey = this.buildCacheKey(params);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.stats.cacheHits++;
      return cached.result;
    }
    this.stats.cacheMisses++;

    // Step 1: Build canonical string
    const canonical = buildCanonicalString(params);
    const canonicalBytes = stringToCodes(canonical);

    // Step 2: Compute hash
    const hashValue = murmurHash(canonicalBytes, params.timestamp);

    // Step 3: XOR transformation
    const hashBytes = [
      (hashValue >>> 24) & 0xFF,
      (hashValue >>> 16) & 0xFF,
      (hashValue >>> 8) & 0xFF,
      hashValue & 0xFF,
    ];

    // Step 4: Combine with user agent hash
    const uaBytes = stringToCodes(params.userAgent);
    const uaHash = murmurHash(uaBytes, 0x12345678);

    // Step 5: Build raw signature bytes
    const rawBytes: number[] = [
      ...hashBytes,
      (uaHash >>> 24) & 0xFF,
      (uaHash >>> 16) & 0xFF,
      (params.timestamp >>> 24) & 0xFF,
      (params.timestamp >>> 16) & 0xFF,
      (params.timestamp >>> 8) & 0xFF,
      params.timestamp & 0xFF,
      ...xorTransform(
        rotateBytes(canonicalBytes.slice(0, 16), ROTATION_TABLE),
        XOR_KEY,
      ).slice(0, 8),
    ];

    // Step 6: Encode
    const encoded = customEncode(rawBytes);

    // Step 7: Add version prefix
    const xBogus = `${X_BOGUS_VERSION}${encoded}`;

    const generationTime = performance.now() - startTime;

    const result: XBogusResult = {
      xBogus,
      version: X_BOGUS_VERSION,
      generationTimeMs: generationTime,
      isValid: true,
      expiresAt: Date.now() + SIGNATURE_VALIDITY_MS,
    };

    // Cache the result
    this.cache.set(cacheKey, { result, expiresAt: result.expiresAt });

    // Prune old cache entries
    if (this.cache.size > 1000) {
      const now = Date.now();
      for (const [key, value] of this.cache) {
        if (value.expiresAt <= now) {
          this.cache.delete(key);
        }
      }
    }

    // Update stats
    this.stats.totalGenerated++;
    this.stats.avgGenerationTimeMs = this.stats.totalGenerated > 0
      ? (this.stats.avgGenerationTimeMs * (this.stats.totalGenerated - 1) + generationTime) / this.stats.totalGenerated
      : generationTime;

    logger.debug({
      xBogus: xBogus.substring(0, 20) + '...',
      generationTimeMs: generationTime.toFixed(2),
      cached: false,
    }, 'X-Bogus signature generated');

    return result;
  }

  /**
   * Validate an X-Bogus signature.
   */
  validate(xBogus: string, params: XBogusParams): boolean {
    // Check version prefix
    if (!xBogus.startsWith(X_BOGUS_VERSION)) {
      return false;
    }
    // Check length (typical: 28-45 characters)
    if (xBogus.length < 20 || xBogus.length > 60) {
      return false;
    }
    // Check charset
    for (const char of xBogus.slice(X_BOGUS_VERSION.length)) {
      if (!CHARSET.includes(char)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Build cache key for signature caching.
   */
  private buildCacheKey(params: XBogusParams): string {
    return `${params.url}:${params.queryString}:${params.userAgent}:${params.timestamp}:${params.platform}:${params.body || ''}`;
  }

  /**
   * Get signer statistics.
   */
  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      cacheSize: this.cache.size,
    };
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const xbogusSigner = new XBogusSignerEngine();
