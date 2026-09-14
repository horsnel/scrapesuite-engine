/**
 * Proxy Pool — ScrapeSuite Engine (utils layer)
 *
 * A lightweight, health-aware rotating proxy pool for the platform fetchers.
 * The engine's giant `src/proxy/` suite is DB/BullMQ-backed and built for
 * the SaaS app tier; this module brings rotation + burn-protection to the
 * platform layer with ZERO hard dependencies — Redis is write-behind
 * persistence, in-memory state is the source of truth for selection, so
 * `pickProxy()` stays synchronous and the fetch path never awaits.
 *
 * Configuration (env):
 *   SCRAPESUITE_PROXY_POOL — comma-separated proxy URLs, or a JSON array:
 *     ["http://user:pass@proxy1:8080", {"url":"http://p2:3128","tier":"residential"}]
 *   SCRAPESUITE_PROXY_POOL_ROTATE — "1" (default) = resolveProxyUrl consults
 *     the pool before static env vars; "0" = pool only used when asked.
 *
 * Scoring:
 *   start 100 · success +2 (cap 100) · shape_rejected -6 · bot_wall -15
 *   rate_limited -20 · network/timeout -8 · below 30 = quarantined
 *   quarantine cools down for 5 minutes, then the proxy gets one retry at
 *   score 45 — a proxy that recovers is readmitted, one that doesn't burns
 *   out and is dropped from rotation.
 */

import { createChildLogger } from './logger';
import { cacheGet, cacheSet } from './redis';

const logger = createChildLogger('proxy-pool');

const POOL_STATE_KEY = 'platlearn:proxypool:state';
const PERSIST_INTERVAL_MS = 30_000;
const QUARANTINE_MS = 5 * 60 * 1000;
const QUARANTINE_REENTRY_SCORE = 45;
const MIN_SCORE = 30;

// ===============================================================================
// TYPES
// ===============================================================================

export type ProxyTier = 'residential' | 'mobile' | 'datacenter' | 'unknown';

export interface PoolEntry {
  id: string;
  url: string;
  tier: ProxyTier;
  score: number;
  /** Continuous success counter — the burn metric. */
  successes: number;
  failures: number;
  quarantinedAt: number | null;
  lastUsedAt: number | null;
  lastError: string | null;
}

export type PoolOutcome =
  | 'success'
  | 'shape_rejected'
  | 'bot_wall'
  | 'rate_limited'
  | 'network_error'
  | 'timeout';

const SCORE_DELTAS: Record<PoolOutcome, number> = {
  success: 2,
  shape_rejected: -6,
  bot_wall: -15,
  rate_limited: -20,
  network_error: -8,
  timeout: -8,
};

// ===============================================================================
// STATE
// ===============================================================================

const entries = new Map<string, PoolEntry>();
/** Round-robin cursor over healthy entry ids. */
let cursor = 0;
let configured = false;
let persistTimer: ReturnType<typeof setInterval> | null = null;

/** Mask credentials in a proxy URL for logs. */
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '[invalid]';
  }
}

function entryId(url: string): string {
  // Stable id WITHOUT credentials so configs that rotate passwords still match.
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

/** Parse the SCRAPESUITE_PROXY_POOL env value into entries. */
function parsePoolEnv(raw: string): Array<{ url: string; tier: ProxyTier }> {
  const out: Array<{ url: string; tier: ProxyTier }> = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as Array<string | { url: string; tier?: string }>;
      for (const item of arr) {
        if (typeof item === 'string') out.push({ url: item, tier: 'unknown' });
        else if (item?.url) out.push({ url: item.url, tier: (item.tier as ProxyTier) || 'unknown' });
      }
      return out;
    } catch {
      logger.warn('SCRAPESUITE_PROXY_POOL looks like JSON but does not parse — falling back to comma split');
    }
  }
  for (const part of trimmed.split(',')) {
    const url = part.trim();
    if (url) out.push({ url, tier: 'unknown' });
  }
  return out;
}

/** Configure the pool programmatically (also used for the env bootstrap). */
export function configurePool(proxies: Array<string | { url: string; tier?: ProxyTier }>): void {
  entries.clear();
  cursor = 0;
  for (const item of proxies) {
    const { url, tier } = typeof item === 'string' ? { url: item, tier: 'unknown' as ProxyTier } : { url: item.url, tier: item.tier ?? 'unknown' };
    if (!url) continue;
    const id = entryId(url);
    if (entries.has(id)) continue;
    entries.set(id, {
      id,
      url,
      tier,
      score: 100,
      successes: 0,
      failures: 0,
      quarantinedAt: null,
      lastUsedAt: null,
      lastError: null,
    });
  }
  configured = entries.size > 0;
  if (configured) {
    logger.info({ size: entries.size, tiers: [...new Set([...entries.values()].map((e) => e.tier))] }, 'Proxy pool configured');
    ensurePersistLoop();
  }
}

/** Bootstrap from env once at import time. */
(function bootstrapFromEnv() {
  const raw = process.env.SCRAPESUITE_PROXY_POOL;
  if (raw && raw.trim()) configurePool(parsePoolEnv(raw));
})();

// ===============================================================================
// SELECTION (sync — the fetch path must never await)
// ===============================================================================

function isUsable(e: PoolEntry, now: number): boolean {
  if (e.quarantinedAt === null) return e.score >= MIN_SCORE;
  const cooldownOver = now - e.quarantinedAt >= QUARANTINE_MS;
  if (cooldownOver) {
    // One probationary re-entry at a mercy score.
    e.score = QUARANTINE_REENTRY_SCORE;
    e.quarantinedAt = null;
    return true;
  }
  return false;
}

/**
 * Pick the next healthy proxy. Score-weighted round-robin: candidates are
 * cycled by cursor, but a candidate with a higher score wins ties. Sync by
 * design — selection reads warm in-memory state.
 */
export function pickProxy(): { url: string; id: string; tier: ProxyTier } | undefined {
  if (!configured || entries.size === 0) return undefined;
  const now = Date.now();
  const healthy = [...entries.values()].filter((e) => isUsable(e, now));
  if (healthy.length === 0) {
    logger.warn('Proxy pool: all proxies quarantined or burned — no proxy available');
    return undefined;
  }
  // Round-robin with score preference: pick the best of the next 2 candidates.
  let best: PoolEntry | null = null;
  for (let i = 0; i < Math.min(2, healthy.length); i++) {
    const candidate = healthy[cursor % healthy.length];
    cursor++;
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best) return undefined;
  best.lastUsedAt = now;
  return { url: best.url, id: best.id, tier: best.tier };
}

// ===============================================================================
// RESULT REPORTING (fire-and-forget)
// ===============================================================================

/**
 * Report the outcome of a fetch that used a pool proxy. Updates the score,
 * quarantine state, and schedules persistence. Never throws.
 */
export function reportResult(proxyUrl: string, outcome: PoolOutcome, detail?: string): void {
  try {
    const e = entries.get(entryId(proxyUrl));
    if (!e) return; // not a pool proxy (explicit or env single proxy)
    const delta = SCORE_DELTAS[outcome] ?? -5;
    e.score = Math.max(0, Math.min(100, e.score + delta));
    if (outcome === 'success') e.successes++;
    else {
      e.failures++;
      e.lastError = detail ?? outcome;
    }
    if (e.score < MIN_SCORE && e.quarantinedAt === null) {
      e.quarantinedAt = Date.now();
      logger.warn({ proxy: maskUrl(e.url), score: e.score, outcome }, 'Proxy quarantined (score below threshold)');
    } else if (outcome === 'success' && e.score >= MIN_SCORE && e.quarantinedAt !== null) {
      e.quarantinedAt = null; // recovered during probation
      logger.info({ proxy: maskUrl(e.url), score: e.score }, 'Proxy recovered from quarantine');
    }
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'reportResult failed (ignored)');
  }
}

// ===============================================================================
// PERSISTENCE (write-behind; best-effort)
// ===============================================================================

function ensurePersistLoop(): void {
  if (persistTimer) return;
  persistTimer = setInterval(() => void persistNow(), PERSIST_INTERVAL_MS);
  persistTimer.unref?.();
}

async function persistNow(): Promise<void> {
  try {
    const state = [...entries.values()].map((e) => ({
      id: e.id,
      tier: e.tier,
      score: e.score,
      successes: e.successes,
      failures: e.failures,
      lastError: e.lastError,
    }));
    await cacheSet(POOL_STATE_KEY, { savedAt: Date.now(), state }, 60 * 60 * 24 * 7);
  } catch {
    // Redis unavailable — in-memory selection keeps working.
  }
}

/** Pool status snapshot for dashboards and the canary report. */
export function poolStatus(): {
  configured: boolean;
  size: number;
  healthy: number;
  quarantined: number;
  proxies: Array<{ proxy: string; tier: ProxyTier; score: number; successes: number; failures: number; quarantined: boolean }>;
} {
  const now = Date.now();
  const all = [...entries.values()];
  return {
    configured,
    size: all.length,
    healthy: all.filter((e) => isUsable(e, now)).length,
    quarantined: all.filter((e) => e.quarantinedAt !== null).length,
    proxies: all.map((e) => ({
      proxy: maskUrl(e.url),
      tier: e.tier,
      score: e.score,
      successes: e.successes,
      failures: e.failures,
      quarantined: e.quarantinedAt !== null && now - e.quarantinedAt < QUARANTINE_MS,
    })),
  };
}

/** Test hook: reset in-memory state. */
export function __resetProxyPool(): void {
  entries.clear();
  cursor = 0;
  configured = false;
  if (persistTimer) clearInterval(persistTimer);
  persistTimer = null;
}
