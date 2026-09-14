/**
 * TikTok Session Farm — ScrapeSuite Engine (platform layer)
 *
 * Turns the proven one-off browser harvest into a herd. Harvested browser
 * sessions are deposited into a Redis-backed pool; the manager lends the
 * healthiest non-stale session automatically in `prepareSession()`, and
 * callers report outcomes so burned sessions are evicted before they get
 * a request blocked.
 *
 * Health model:
 *   start 100 · success +1 (cap 100) · shape/bot-wall -25 · rate-limit -35
 *   network errors -5 (not the session's fault) · below 40 = evicted
 *   sessions expire after SCRAPESUITE_TT_SESSION_MAX_AGE_H (default 24h)
 *   or SCRAPESUITE_TT_SESSION_MAX_USES (default 200) uses.
 *
 * Storage is best-effort Redis with an in-memory fallback, so the farm
 * works in tests and stripped builds.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../../utils/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type { TikTokBrowserSession } from './browser-harvester';

const logger = createChildLogger('tiktok-session-farm');

const FARM_KEY = 'platlearn:tiktok:sessions';
const FARM_TTL_SECONDS = 60 * 60 * 24 * 7;

// ===============================================================================
// TYPES
// ===============================================================================

export interface FarmedSession {
  id: string;
  session: TikTokBrowserSession;
  health: number;
  uses: number;
  depositedAt: number;
  lastUsedAt: number | null;
  lastError: string | null;
}

export type SessionOutcome = 'success' | 'bot_wall' | 'rate_limited' | 'shape_rejected' | 'network_error' | 'timeout';

const HEALTH_DELTAS: Record<SessionOutcome, number> = {
  success: 1,
  bot_wall: -25,
  rate_limited: -35,
  shape_rejected: -10,
  network_error: -5,
  timeout: -5,
};

const EVICTION_HEALTH = 40;

function configLimits() {
  return {
    maxAgeMs: Number(process.env.SCRAPESUITE_TT_SESSION_MAX_AGE_H ?? 24) * 60 * 60 * 1000,
    maxUses: Number(process.env.SCRAPESUITE_TT_SESSION_MAX_USES ?? 200),
  };
}

// ===============================================================================
// STORE
// ===============================================================================

let memFarm: FarmedSession[] = [];
let redisHealthy = true;

async function load(): Promise<FarmedSession[]> {
  if (!redisHealthy) return memFarm;
  try {
    const stored = await cacheGet<FarmedSession[]>(FARM_KEY);
    return stored ?? memFarm;
  } catch {
    redisHealthy = false;
    return memFarm;
  }
}

async function save(farm: FarmedSession[]): Promise<void> {
  memFarm = farm;
  if (!redisHealthy) return;
  try {
    await cacheSet(FARM_KEY, farm, FARM_TTL_SECONDS);
  } catch {
    redisHealthy = false;
  }
}

// ===============================================================================
// FARM OPERATIONS
// ===============================================================================

/**
 * Deposit a harvested session into the farm. Validates first (same rules as
 * import). Returns the assigned farm id, or null when the session is invalid.
 */
export async function depositSession(session: TikTokBrowserSession): Promise<string | null> {
  try {
    const { tiktokBrowserHarvester } = await import('./browser-harvester');
    const check = tiktokBrowserHarvester.validateSession(session);
    if (!check.valid) {
      logger.warn({ reason: check.reason }, 'Rejected session deposit');
      return null;
    }
    const farm = await load();
    const entry: FarmedSession = {
      id: randomUUID(),
      session,
      health: 100,
      uses: 0,
      depositedAt: Date.now(),
      lastUsedAt: null,
      lastError: null,
    };
    farm.unshift(entry);
    await save(farm.slice(0, 50));
    logger.info({ id: entry.id, cookies: Object.keys(session.cookies).length }, 'Session deposited to farm');
    return entry.id;
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'depositSession failed (non-fatal)');
    return null;
  }
}

/**
 * Lend the healthiest non-stale session, or null when the farm is empty.
 * Lending marks `lastUsedAt`; callers MUST report outcomes.
 */
export async function lendSession(): Promise<{ id: string; session: TikTokBrowserSession } | null> {
  try {
    const farm = await load();
    const { maxAgeMs, maxUses } = configLimits();
    const now = Date.now();

    // Evict stale / exhausted / dead entries first.
    const living = farm.filter((f) => {
      const tooOld = now - f.depositedAt > maxAgeMs;
      const tooUsed = f.uses >= maxUses;
      const tooSick = f.health < EVICTION_HEALTH;
      return !tooOld && !tooUsed && !tooSick;
    });
    if (living.length !== farm.length) {
      logger.info({ evicted: farm.length - living.length, remaining: living.length }, 'Farm eviction pass');
    }
    if (living.length === 0) {
      await save([]);
      return null;
    }

    // Healthiest first; tie-break to freshest.
    living.sort((a, b) => (b.health - a.health) || (b.depositedAt - a.depositedAt));
    const chosen = living[0];
    chosen.lastUsedAt = now;
    await save(living);
    return { id: chosen.id, session: chosen.session };
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'lendSession failed (non-fatal)');
    return null;
  }
}

/**
 * Report the outcome of a lent session's usage. Successes heal the session;
 * repeated walls burn it out and evict it.
 */
export async function reportSessionOutcome(sessionId: string, outcome: SessionOutcome, detail?: string): Promise<void> {
  try {
    const farm = await load();
    const entry = farm.find((f) => f.id === sessionId);
    if (!entry) return;
    entry.uses++;
    entry.health = Math.max(0, Math.min(100, entry.health + (HEALTH_DELTAS[outcome] ?? -10)));
    if (outcome !== 'success') entry.lastError = detail ?? outcome;
    const evicted = entry.health < EVICTION_HEALTH || entry.uses >= configLimits().maxUses;
    const next = evicted ? farm.filter((f) => f.id !== sessionId) : farm;
    if (evicted) logger.warn({ id: sessionId, health: entry.health, outcome }, 'Session evicted from farm');
    await save(next);
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'reportSessionOutcome failed (non-fatal)');
  }
}

/** Farm snapshot for dashboards. */
export async function farmStatus(): Promise<{
  size: number;
  healthy: number;
  averageHealth: number;
  oldestAgeMs: number | null;
}> {
  const farm = await load();
  const now = Date.now();
  const healthy = farm.filter((f) => f.health >= EVICTION_HEALTH).length;
  const avg = farm.length ? Math.round(farm.reduce((s, f) => s + f.health, 0) / farm.length) : 0;
  const oldest = farm.length ? Math.max(...farm.map((f) => now - f.depositedAt)) : null;
  return { size: farm.length, healthy, averageHealth: avg, oldestAgeMs: oldest };
}

/** Test hook. */
export function __resetSessionFarm(): void {
  memFarm = [];
  redisHealthy = true;
}
