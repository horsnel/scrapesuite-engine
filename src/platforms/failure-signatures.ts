/**
 * Failure Signature Store — ScrapeSuite Engine (platform layer)
 *
 * "Autopsy mode" for the platform fetchers. Every failed request is
 * fingerprinted and remembered; every successful request updates the
 * last-known-good baseline for its surface. When a failure repeats, the
 * engine classifies it instantly instead of rediscovering it, and when a
 * request shape changes between a success and a failure, the changed fields
 * are extracted automatically — the exact manual-diffing process that
 * produced the canonical-context breakthrough, now built into the engine.
 *
 * Storage: Redis (via utils/redis) with an in-memory fallback so the store
 * works in stripped builds and offline tests.
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type { PlatformObservationInput } from './telemetry';

const logger = createChildLogger('failure-signatures');

const SIG_PREFIX = 'platlearn:sig:';
const BASELINE_PREFIX = 'platlearn:baseline:';
const SIG_TTL_SECONDS = 60 * 60 * 24 * 14; // signatures stay hot for two weeks
const BASELINE_TTL_SECONDS = 60 * 60 * 24 * 30; // baselines live a month
const MAX_TRACKED_SIGS = 200;

// ===============================================================================
// TYPES
// ===============================================================================

/** A remembered failure pattern. */
export interface FailureSignature {
  /** Stable hash key for this pattern. */
  key: string;
  /** Platform surface, e.g. `youtube.transcript`. */
  surface: string;
  /** Platform-layer outcome kind. */
  outcome: string;
  /** Machine-readable error kind from the response, if any. */
  errorKind?: string;
  /** Response status code, if any. */
  status?: number;
  /** How many times this exact pattern was seen. */
  count: number;
  /** First and last sighting (epoch ms). */
  firstSeenAt: number;
  lastSeenAt: number;
  /** Fields that changed vs. the last-known-good request, when computed. */
  changedFields?: string[];
  /** Distinctive response marker snippet. */
  marker?: string;
}

/** Result of diffing a failed request against the last-known-good one. */
export interface BaselineDiff {
  surface: string;
  hadBaseline: boolean;
  changedFields: string[];
  addedFields: string[];
  removedFields: string[];
}

// ===============================================================================
// IN-MEMORY FALLBACK
// ===============================================================================

const memSigs = new Map<string, FailureSignature>();
const memBaselines = new Map<string, Record<string, unknown>>();
let redisHealthy = true;

// ===============================================================================
// CORE
// ===============================================================================

/** Request fingerprint: a flat map of the fields worth diffing. */
export type RequestFingerprint = Record<string, string | number | boolean | undefined>;

function hashSignature(surface: string, outcome: string, errorKind: string | undefined, status: number | undefined, marker: string | undefined): string {
  return createHash('sha1')
    .update(`${surface}|${outcome}|${errorKind ?? ''}|${status ?? ''}|${marker ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** Safe wrapper around cacheGet that flips to memory mode on Redis errors. */
async function safeGet<T>(key: string): Promise<T | null> {
  if (!redisHealthy) return memGet<T>(key);
  try {
    return await cacheGet<T>(key);
  } catch (err: any) {
    redisHealthy = false;
    logger.warn({ err: err?.message }, 'Redis unavailable — failure signatures degrade to memory');
    return memGet<T>(key);
  }
}

/** Safe wrapper around cacheSet that flips to memory mode on Redis errors. */
async function safeSet(key: string, value: unknown, ttl: number): Promise<void> {
  if (!redisHealthy) return memSet(key, value);
  try {
    await cacheSet(key, value, ttl);
  } catch (err: any) {
    redisHealthy = false;
    logger.warn({ err: err?.message }, 'Redis unavailable — failure signatures degrade to memory');
    memSet(key, value);
  }
}

function memGet<T>(key: string): T | null {
  if (key.startsWith(SIG_PREFIX)) {
    const sig = memSigs.get(key.slice(SIG_PREFIX.length));
    return sig ? (sig as unknown as T) : null;
  }
  if (key.startsWith(BASELINE_PREFIX)) {
    const b = memBaselines.get(key.slice(BASELINE_PREFIX.length));
    return b ? (b as unknown as T) : null;
  }
  return null;
}

function memSet(key: string, value: unknown): void {
  if (key.startsWith(SIG_PREFIX)) {
    memSigs.set(key.slice(SIG_PREFIX.length), value as FailureSignature);
    if (memSigs.size > MAX_TRACKED_SIGS) {
      const oldest = memSigs.keys().next().value;
      if (oldest) memSigs.delete(oldest);
    }
    return;
  }
  if (key.startsWith(BASELINE_PREFIX)) {
    memBaselines.set(key.slice(BASELINE_PREFIX.length), value as Record<string, unknown>);
  }
}

/**
 * Diff a request fingerprint against the stored last-known-good baseline
 * for its surface. Returns which fields changed / appeared / vanished.
 * Exported for offline testing.
 */
export function diffAgainstBaseline(
  fingerprint: RequestFingerprint,
  baseline: RequestFingerprint | null,
): BaselineDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  if (!baseline) {
    return { surface: '', hadBaseline: false, changedFields: [], addedFields: [], removedFields: [] };
  }

  const base = new Set(Object.keys(baseline));
  for (const [k, v] of Object.entries(fingerprint)) {
    if (!base.has(k)) {
      if (v !== undefined) added.push(k);
      continue;
    }
    if (baseline[k] !== v) changed.push(k);
  }
  for (const k of Object.keys(baseline)) {
    if (!(k in fingerprint)) removed.push(k);
  }

  return { surface: '', hadBaseline: true, changedFields: changed, addedFields: added, removedFields: removed };
}

/**
 * Record a platform attempt. Failures are fingerprinted and counted;
 * successes update the last-known-good baseline.
 * Never throws.
 */
/** Per-key write chains: serialize read-modify-write cycles so concurrent
 *  failures of the same pattern accumulate counts correctly. */
const writeChains = new Map<string, Promise<void>>();

function chainedWrite(key: string, write: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(write, write).finally(() => {
    if (writeChains.get(key) === next) writeChains.delete(key);
  });
  writeChains.set(key, next);
  return next;
}

function observeInternal(input: PlatformObservationInput, fingerprint?: RequestFingerprint): void {
  try {
    const isFailure = input.outcome !== 'success' && input.outcome !== 'degraded';

    if (isFailure) {
      const marker = (input.response?.marker ?? '').slice(0, 200);
      const key = hashSignature(input.surface, input.outcome, input.response?.errorKind, input.response?.status, marker);
      const storeKey = `${SIG_PREFIX}${key}`;
      void chainedWrite(storeKey, async () => {
        const existing = await safeGet<FailureSignature>(storeKey);
        const now = Date.now();
        const changedFields = fingerprint ? await computeChangedFields(input.surface, fingerprint) : undefined;

        const sig: FailureSignature = {
          key,
          surface: input.surface,
          outcome: input.outcome,
          ...(input.response?.errorKind ? { errorKind: input.response.errorKind } : {}),
          ...(input.response?.status ? { status: input.response.status } : {}),
          count: (existing?.count ?? 0) + 1,
          firstSeenAt: existing?.firstSeenAt ?? now,
          lastSeenAt: now,
          ...(changedFields && changedFields.length ? { changedFields } : {}),
          ...(marker ? { marker } : {}),
        };
        await safeSet(storeKey, sig, SIG_TTL_SECONDS);
      }).catch((err) => logger.debug({ err: err?.message }, 'signature write failed (ignored)'));
    } else if (fingerprint) {
      // Success (or usable degraded data): update last-known-good baseline.
      const storeKey = `${BASELINE_PREFIX}${input.surface}`;
      void chainedWrite(storeKey, async () => {
        await safeSet(storeKey, fingerprint, BASELINE_TTL_SECONDS);
      }).catch((err) => logger.debug({ err: err?.message }, 'baseline write failed (ignored)'));
    }
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'failure-signature observe failed (ignored)');
  }
}

/** Compute changed fields vs baseline and store the diff for the signature. */
async function computeChangedFields(surface: string, fingerprint: RequestFingerprint): Promise<string[]> {
  const baseline = await safeGet<RequestFingerprint>(`${BASELINE_PREFIX}${surface}`);
  const diff = diffAgainstBaseline(fingerprint, baseline ?? null);
  return [...diff.changedFields, ...diff.addedFields.map((f) => `+${f}`), ...diff.removedFields.map((f) => `-${f}`)];
}

/**
 * Instant known-tell lookup: has this failure pattern been seen before, and
 * how familiar is it? Lets the classifier short-circuit rediscovery.
 */
export async function lookupSignature(
  surface: string,
  outcome: string,
  errorKind?: string,
  status?: number,
  marker?: string,
): Promise<FailureSignature | null> {
  const key = hashSignature(surface, outcome, errorKind, status, marker);
  return safeGet<FailureSignature>(`${SIG_PREFIX}${key}`);
}

/** Get the stored last-known-good baseline for a surface. */
export async function getBaseline(surface: string): Promise<RequestFingerprint | null> {
  return safeGet<RequestFingerprint>(`${BASELINE_PREFIX}${surface}`);
}

/**
 * Report: all signatures for a surface (or all surfaces), hottest first.
 * Uses the engine's prefix scan (cacheGetWithPrefix) when Redis is healthy;
 * falls back to the in-memory map otherwise.
 */
export async function topSignatures(surface?: string, limit = 20): Promise<FailureSignature[]> {
  if (!redisHealthy) {
    return [...memSigs.values()]
      .filter((s) => !surface || s.surface === surface)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }
  try {
    const { cacheGetWithPrefix } = await import('../utils/redis');
    const map = await cacheGetWithPrefix('platlearn:sig:');
    const out: FailureSignature[] = [];
    for (const value of map.values()) {
      const sig = value as FailureSignature;
      if (sig && typeof sig.count === 'number' && (!surface || sig.surface === surface)) {
        out.push(sig);
      }
    }
    return out.sort((a, b) => b.count - a.count).slice(0, limit);
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'topSignatures scan failed (memory fallback)');
    return [...memSigs.values()].filter((s) => !surface || s.surface === surface).slice(0, limit);
  }
}

/** Reset in-memory state (tests). */
export function __resetFailureSignatures(): void {
  memSigs.clear();
  memBaselines.clear();
  redisHealthy = true;
}

// Facade object used by telemetry.recordAttempt (CommonJS-safe interop).
export const failureSignatures = { observe: observeInternal };

export {};
