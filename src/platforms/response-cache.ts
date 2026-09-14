/**
 * Response Cache — ScrapeSuite Engine (platform layer)
 *
 * Stop paying tolls twice. A Redis-backed cache-aside layer with per-surface
 * TTL policies and stale-while-revalidate semantics:
 *
 *   soft TTL — how long an entry is served fresh
 *   hard TTL — how long a stale entry may still be served while a background
 *              refresh runs (SWR). The caller gets instant stale data; the
 *              next caller gets fresh data.
 *
 * Default policies are tuned per surface (transcripts barely ever change;
 * home feeds churn constantly). Failures are never cached. The producer
 * decides what counts as a failure — only resolved values are stored.
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet, cacheDelete } from '../utils/redis';

const logger = createChildLogger('response-cache');

const CACHE_PREFIX = 'platlearn:cache:';

// ===============================================================================
// TTL POLICIES
// ===============================================================================

export interface TtlPolicy {
  /** Fresh window (seconds). */
  softTtl: number;
  /** Stale-while-revalidate window (seconds). 0 disables SWR. */
  hardTtl: number;
}

/** Per-surface default policies (seconds). */
export const DEFAULT_TTLS: Record<string, TtlPolicy> = {
  'youtube.transcript': { softTtl: 60 * 60 * 12, hardTtl: 60 * 60 * 24 * 3 },
  'youtube.comments': { softTtl: 60 * 10, hardTtl: 60 * 60 },
  'youtube.browse': { softTtl: 60 * 3, hardTtl: 60 * 15 },
  'youtube.search': { softTtl: 60 * 15, hardTtl: 60 * 60 },
  'youtube.player': { softTtl: 60 * 30, hardTtl: 60 * 60 * 6 },
  'reddit.rss': { softTtl: 60 * 5, hardTtl: 60 * 30 },
  'tiktok.web-api': { softTtl: 60 * 10, hardTtl: 60 * 60 },
};

// ===============================================================================
// STATS
// ===============================================================================

const stats = { hits: 0, staleHits: 0, misses: 0, stores: 0, errors: 0 };

export function cacheStats(): { hits: number; staleHits: number; misses: number; stores: number; errors: number; hitRate: number } {
  const total = stats.hits + stats.staleHits + stats.misses;
  return {
    ...stats,
    hitRate: total === 0 ? 0 : Math.round(((stats.hits + stats.staleHits) / total) * 100),
  };
}

// ===============================================================================
// CORE
// ===============================================================================

function cacheKey(surface: string, key: string): string {
  return `${CACHE_PREFIX}${surface}:${createHash('sha1').update(key).digest('hex').slice(0, 24)}`;
}

interface CacheEnvelope<T> {
  value: T;
  storedAt: number;
}

/**
 * Cache-aside fetch with stale-while-revalidate.
 *
 * @param surface  Surface name — selects the default TTL policy
 * @param key      Stable request identity (will be hashed into the cache key)
 * @param producer Async producer that resolves the value on miss/revalidate
 * @param opts     Override TTLs, disable SWR, or pass a custom policy
 */
export async function cachedFetch<T>(params: {
  surface: string;
  key: string;
  producer: () => Promise<T>;
  policy?: Partial<TtlPolicy>;
  /** Skip cache reads (still writes). */
  skipRead?: boolean;
  /** Skip cache writes. */
  skipWrite?: boolean;
  /** Predicate: only cache when the produced value is worth keeping (e.g. ok=true). */
  shouldCache?: (value: T) => boolean;
}): Promise<{ value: T; fromCache: 'fresh' | 'stale' | false }> {
  const policy: TtlPolicy = {
    ...(DEFAULT_TTLS[params.surface] ?? { softTtl: 300, hardTtl: 900 }),
    ...params.policy,
  };
  const ck = cacheKey(params.surface, params.key);

  // ---- Read path ----
  if (!params.skipRead) {
    try {
      const hit = await cacheGet<CacheEnvelope<T>>(ck);
      if (hit && hit.value !== undefined && hit.value !== null) {
        const age = Date.now() - hit.storedAt;
        if (age < policy.softTtl * 1000) {
          stats.hits++;
          return { value: hit.value, fromCache: 'fresh' };
        }
        if (policy.hardTtl > 0 && age < policy.hardTtl * 1000) {
          // Stale-while-revalidate: serve stale now, refresh in background.
          stats.staleHits++;
          void params
            .producer()
            .then((fresh) => {
              const worthKeeping = params.shouldCache ? params.shouldCache(fresh) : true;
              if (!params.skipWrite && worthKeeping) {
                return cacheSet(ck, { value: fresh, storedAt: Date.now() } satisfies CacheEnvelope<T>, policy.hardTtl);
              }
            })
            .then(() => {
              stats.stores++;
            })
            .catch(() => {
              stats.errors++;
            });
          return { value: hit.value, fromCache: 'stale' };
        }
      }
    } catch {
      stats.errors++;
      // Redis unavailable — proceed to producer.
    }
  }

  // ---- Miss path ----
  stats.misses++;
  const value = await params.producer();
  const worthCaching = params.shouldCache ? params.shouldCache(value) : true;
  if (!params.skipWrite && worthCaching) {
    try {
      const ttl = policy.hardTtl > 0 ? policy.hardTtl : policy.softTtl;
      await cacheSet(ck, { value, storedAt: Date.now() } satisfies CacheEnvelope<T>, ttl);
      stats.stores++;
    } catch {
      stats.errors++;
    }
  }
  return { value, fromCache: false };
}

/** Invalidate a specific cached request. */
export async function invalidateCache(surface: string, key: string): Promise<void> {
  try {
    await cacheDelete(cacheKey(surface, key));
  } catch {
    // Non-fatal
  }
}

/** Invalidate every cached entry for a surface (prefix scan + delete, best-effort). */
export async function invalidateSurface(surface: string): Promise<number> {
  try {
    const { cacheGetWithPrefix, cacheDelete } = await import('../utils/redis');
    const map = await cacheGetWithPrefix(`platlearn:cache:${surface}:`);
    let deleted = 0;
    for (const key of map.keys()) {
      await cacheDelete(key);
      deleted++;
    }
    return deleted;
  } catch {
    return 0;
  }
}

/** Test hook. */
export function __resetCacheStats(): void {
  stats.hits = 0;
  stats.staleHits = 0;
  stats.misses = 0;
  stats.stores = 0;
  stats.errors = 0;
}

logger.debug('response-cache ready');
