/**
 * msToken Rotator -- ScrapeSuite Engine
 *
 * Manages TikTok msToken lifecycle: generation, rotation, and validation.
 * msToken is a critical session token that TikTok uses to verify request
 * authenticity. It must be rotated regularly (every 5-10 minutes) and
 * included in every API request.
 *
 * Token format: Base64-like string, typically 107 or 128 characters
 * Token lifetime: ~5-10 minutes (varies by endpoint)
 * Rotation strategy: Pre-generate pool, rotate before expiry
 */

import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type { MsTokenConfig, MsTokenResult } from './types';

const logger = createChildLogger('mstoken-rotator');

// ===============================================================================
// CONSTANTS
// ===============================================================================

/** Default msToken configuration */
const DEFAULT_MSTOKEN_CONFIG: MsTokenConfig = {
  length: 128,
  charset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  lifetimeSeconds: 300, // 5 minutes
  includeHash: true,
};

/** Pool size: number of pre-generated tokens */
const TOKEN_POOL_SIZE = 20;

/** Pre-generation threshold: generate more when pool drops below this */
const POOL_REPLENISH_THRESHOLD = 5;

// ===============================================================================
// MSTOKEN ROTATOR ENGINE
// ===============================================================================

export class MsTokenRotatorEngine {
  private config: MsTokenConfig;
  private tokenPool: MsTokenResult[] = [];
  private activeTokenIndex = 0;
  private stats = {
    totalGenerated: 0,
    totalRotations: 0,
    totalExpirations: 0,
    poolReplenishments: 0,
    avgGenerationTimeMs: 0,
  };
  private initialized = false;

  constructor(config?: Partial<MsTokenConfig>) {
    this.config = { ...DEFAULT_MSTOKEN_CONFIG, ...config };
  }

  /**
   * Initialize the token rotator and pre-generate token pool.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info({ poolSize: TOKEN_POOL_SIZE }, 'Initializing msToken rotator...');

    // Try to load cached tokens from Redis
    try {
      const cachedPool = await cacheGet<MsTokenResult[]>('tiktok:mstoken-pool');
      if (cachedPool && Array.isArray(cachedPool)) {
        const now = Date.now();
        const validTokens = cachedPool.filter(t => t.expiresAt > now);
        if (validTokens.length >= POOL_REPLENISH_THRESHOLD) {
          this.tokenPool = validTokens;
          logger.info({ loadedTokens: validTokens.length }, 'Loaded msToken pool from cache');
        }
      }
    } catch {
      logger.debug('No cached msToken pool found');
    }

    // Pre-generate tokens to fill the pool
    await this.replenishPool();

    this.initialized = true;
    logger.info({ poolSize: this.tokenPool.length }, 'msToken rotator initialized');
  }

  /**
   * Get the current active msToken.
   */
  getActiveToken(): MsTokenResult {
    // Check if active token is still valid
    if (this.tokenPool.length > 0 && this.activeTokenIndex < this.tokenPool.length) {
      const token = this.tokenPool[this.activeTokenIndex];
      if (token.expiresAt > Date.now()) {
        return token;
      }
    }

    // Rotate to next valid token
    return this.rotate();
  }

  /**
   * Rotate to the next msToken in the pool.
   */
  rotate(): MsTokenResult {
    const now = Date.now();

    // Remove expired tokens
    const beforeSize = this.tokenPool.length;
    this.tokenPool = this.tokenPool.filter(t => t.expiresAt > now);
    this.stats.totalExpirations += beforeSize - this.tokenPool.length;

    // Find next valid token
    if (this.tokenPool.length === 0) {
      // Emergency: generate a new token immediately
      const newToken = this.generateToken();
      this.tokenPool.push(newToken);
      this.activeTokenIndex = 0;
      this.stats.totalRotations++;
      return newToken;
    }

    // Move to next token in pool
    this.activeTokenIndex = (this.activeTokenIndex + 1) % this.tokenPool.length;
    const token = this.tokenPool[this.activeTokenIndex];
    this.stats.totalRotations++;

    logger.debug({
      tokenIndex: this.activeTokenIndex,
      poolSize: this.tokenPool.length,
      expiresInSeconds: Math.round((token.expiresAt - now) / 1000),
    }, 'msToken rotated');

    // Replenish pool if below threshold
    if (this.tokenPool.length < POOL_REPLENISH_THRESHOLD) {
      this.replenishPool().catch(err => {
        logger.warn({ err }, 'Failed to replenish msToken pool');
      });
    }

    return token;
  }

  /**
   * Generate a new msToken.
   */
  generateToken(): MsTokenResult {
    const startTime = performance.now();

    const now = Date.now();
    const tokenParts: string[] = [];

    // Part 1: Random base (32 chars)
    tokenParts.push(this.randomString(32));

    // Part 2: Timestamp-based component
    const tsComponent = this.encodeTimestamp(now);
    tokenParts.push(tsComponent);

    // Part 3: Random middle section
    tokenParts.push(this.randomString(24));

    // Part 4: Hash component (if enabled)
    if (this.config.includeHash) {
      const hashInput = tokenParts.join('');
      const hash = this.simpleHash(hashInput);
      tokenParts.push(hash);
    }

    // Part 5: Padding to reach target length
    const currentLength = tokenParts.join('').length;
    if (currentLength < this.config.length) {
      tokenParts.push(this.randomString(this.config.length - currentLength));
    }

    const token = tokenParts.join('').slice(0, this.config.length);
    const generationTime = performance.now() - startTime;

    this.stats.totalGenerated++;
    this.stats.avgGenerationTimeMs = this.stats.totalGenerated > 0
      ? (this.stats.avgGenerationTimeMs * (this.stats.totalGenerated - 1) + generationTime) / this.stats.totalGenerated
      : generationTime;

    return {
      token,
      version: 'v2',
      generatedAt: now,
      expiresAt: now + (this.config.lifetimeSeconds * 1000),
      isValid: true,
    };
  }

  /**
   * Generate multiple tokens in bulk.
   */
  generateBulk(count: number): MsTokenResult[] {
    const tokens: MsTokenResult[] = [];
    for (let i = 0; i < count; i++) {
      tokens.push(this.generateToken());
    }
    return tokens;
  }

  /**
   * Replenish the token pool up to the target size.
   */
  private async replenishPool(): Promise<void> {
    const needed = TOKEN_POOL_SIZE - this.tokenPool.length;
    if (needed <= 0) return;

    logger.debug({ needed, currentPoolSize: this.tokenPool.length }, 'Replenishing msToken pool');

    const newTokens = this.generateBulk(needed);
    this.tokenPool.push(...newTokens);
    this.stats.poolReplenishments++;

    // Persist to cache
    try {
      await cacheSet('tiktok:mstoken-pool', this.tokenPool, 300);
    } catch {
      logger.debug('Failed to persist msToken pool to cache');
    }
  }

  /**
   * Generate a random string of the given length using the configured charset.
   */
  private randomString(length: number): string {
    const chars = this.config.charset;
    let result = '';
    const randomValues = new Uint8Array(length);
    // Use crypto-quality randomness when available, fallback to Math.random
    try {
      require('crypto').randomFillSync(randomValues);
      for (let i = 0; i < length; i++) {
        result += chars[randomValues[i] % chars.length];
      }
    } catch {
      for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    return result;
  }

  /**
   * Encode a timestamp into a short string.
   */
  private encodeTimestamp(timestamp: number): string {
    const chars = this.config.charset;
    let result = '';
    let value = Math.floor(timestamp / 1000); // Use seconds
    while (value > 0) {
      result = chars[value % chars.length] + result;
      value = Math.floor(value / chars.length);
    }
    return result;
  }

  /**
   * Simple hash function for token integrity.
   */
  private simpleHash(input: string): string {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV prime
    }
    const chars = this.config.charset;
    let result = '';
    let value = hash >>> 0;
    for (let i = 0; i < 8; i++) {
      result += chars[value % chars.length];
      value = Math.floor(value / chars.length);
    }
    return result;
  }

  /**
   * Get rotator statistics.
   */
  getStats(): Record<string, unknown> {
    const now = Date.now();
    const validTokens = this.tokenPool.filter(t => t.expiresAt > now);
    return {
      ...this.stats,
      poolSize: this.tokenPool.length,
      validPoolSize: validTokens.length,
      activeTokenIndex: this.activeTokenIndex,
      activeTokenExpiresIn: validTokens.length > 0
        ? Math.round((validTokens[this.activeTokenIndex % validTokens.length].expiresAt - now) / 1000)
        : 0,
    };
  }
}

// ===============================================================================
// SINGLETON
// ===============================================================================

export const msTokenRotator = new MsTokenRotatorEngine();
