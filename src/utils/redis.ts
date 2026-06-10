import Redis from 'ioredis';
import { createChildLogger } from './logger';

const logger = createChildLogger('redis');

// --- Lazy Redis Singleton ----------------------------------------------------
// Only creates the connection when first accessed, not on module import.
// This prevents the API server from crashing if Redis is unavailable.

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    logger.info({ url: url.replace(/\/\/.*@/, '//***@') }, 'Creating Redis connection');

    _redis = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,       // Don't connect until first command
      retryStrategy(times) {
        const delay = Math.min(times * 200, 5000);
        return delay;
      },
    });

    _redis.on('error', (err) => {
      // Suppress ECONNREFUSED spam -- just log at debug level
      if (err.message?.includes('ECONNREFUSED')) {
        logger.debug({ error: err.message }, 'Redis connection refused (will retry)');
      } else {
        logger.warn({ error: err.message }, 'Redis connection error');
      }
    });

    _redis.on('connect', () => {
      logger.info('Redis connected');
    });
  }
  return _redis;
}

// For backward compatibility -- exports a getter that lazily creates the connection
export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    const actualRedis = getRedis();
    const value = (actualRedis as any)[prop];
    if (typeof value === 'function') {
      return value.bind(actualRedis);
    }
    return value;
  },
});

// Cache helpers
export async function cacheGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  const data = await r.get(`cache:${key}`);
  if (!data) return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: any, ttlSeconds: number = 3600): Promise<void> {
  const r = getRedis();
  await r.set(`cache:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
}

export async function cacheDelete(key: string): Promise<void> {
  const r = getRedis();
  await r.del(`cache:${key}`);
}

export async function cacheGetWithPrefix(prefix: string): Promise<Map<string, any>> {
  const r = getRedis();
  const keys = await r.keys(`cache:${prefix}*`);
  const result = new Map<string, any>();
  if (keys.length === 0) return result;
  const values = await r.mget(...keys);
  keys.forEach((key, i) => {
    try {
      const cleanKey = key.replace('cache:', '');
      result.set(cleanKey, JSON.parse(values[i]!));
    } catch {}
  });
  return result;
}
