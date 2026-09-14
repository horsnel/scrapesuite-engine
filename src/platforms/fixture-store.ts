/**
 * Fixture Store + Zero-Result Tripwire — ScrapeSuite Engine (platform layer)
 *
 * Two related jobs:
 *
 * FIXTURE CORPUS — every interesting live response (successes and failures)
 * can be snapshotted into a rolling per-surface store (Redis) and optionally
 * mirrored to disk (SCRAPESUITE_FIXTURE_DIR). Fixtures are the offline test
 * corpus: they let parsers be regression-tested without hammering the real
 * platforms, and they are the raw material for diagnosing shape changes.
 *
 * ZERO-RESULT TRIPWIRE — the silent killer. During testing, the comment
 * parser once returned 0 comments against a response that visibly contained
 * twenty. Nothing errored; the data was just gone. The tripwire wraps any
 * parser: when the parsed result is empty but the raw payload has
 * substantial bytes, it saves the payload as a fixture, flags the result,
 * and records a `parse_empty` observation — turning silent failures into
 * learning moments.
 */

import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { recordAttempt, type PlatformSurface } from './telemetry';

const logger = createChildLogger('fixture-store');

const FIXTURE_PREFIX = 'platlearn:fixtures:';
const FIXTURE_TTL_SECONDS = 60 * 60 * 24 * 14;
const MAX_FIXTURES_PER_SURFACE = 40;
/** Payloads larger than this are truncated before storage (bytes). */
const MAX_STORED_BYTES = 256 * 1024;

// ===============================================================================
// TYPES
// ===============================================================================

export interface StoredFixture {
  id: string;
  surface: string;
  url?: string;
  capturedAt: number;
  /** SHA-256 of the raw payload — dedup + integrity. */
  payloadHash: string;
  byteLength: number;
  truncated: boolean;
  /** Why this fixture exists: 'zero_result' | 'failure' | 'manual' | 'sample'. */
  reason: 'zero_result' | 'failure' | 'manual' | 'sample';
  meta?: Record<string, unknown>;
  payload: string;
}

// ===============================================================================
// STORE
// ===============================================================================

function fixtureId(surface: string, payload: string): string {
  return createHash('sha1').update(`${surface}|${payload.slice(0, 4096)}`).digest('hex').slice(0, 12);
}

/**
 * Save a fixture for a surface. Deduplicates by content hash; keeps the N
 * most recent per surface. Never throws.
 */
export async function saveFixture(params: {
  surface: string;
  payload: string;
  reason: StoredFixture['reason'];
  url?: string;
  meta?: Record<string, unknown>;
}): Promise<StoredFixture | null> {
  try {
    const raw = params.payload ?? '';
    if (!raw) return null;
    const truncated = raw.length > MAX_STORED_BYTES;
    const stored = truncated ? raw.slice(0, MAX_STORED_BYTES) : raw;

    const fixture: StoredFixture = {
      id: fixtureId(params.surface, raw),
      surface: params.surface,
      ...(params.url ? { url: params.url } : {}),
      capturedAt: Date.now(),
      payloadHash: createHash('sha256').update(raw).digest('hex'),
      byteLength: Buffer.byteLength(raw),
      truncated,
      reason: params.reason,
      ...(params.meta ? { meta: params.meta } : {}),
      payload: stored,
    };

    const listKey = `${FIXTURE_PREFIX}${params.surface}`;
    const existing = (await cacheGet<StoredFixture[]>(listKey)) ?? [];
    if (existing.some((f) => f.id === fixture.id)) return fixture; // dedup
    existing.unshift(fixture);
    await cacheSet(listKey, existing.slice(0, MAX_FIXTURES_PER_SURFACE), FIXTURE_TTL_SECONDS);

    // Optional disk mirror for building committed test corpora.
    const dir = process.env.SCRAPESUITE_FIXTURE_DIR;
    if (dir) {
      const { mkdirSync, writeFileSync } = await import('fs');
      try {
        mkdirSync(dir, { recursive: true });
        const safe = params.surface.replace(/[^a-z0-9.-]/gi, '_');
        writeFileSync(`${dir}/${safe}-${fixture.id}-${fixture.reason}.json`, JSON.stringify(fixture, null, 2));
      } catch (err: any) {
        logger.debug({ err: err?.message }, 'fixture disk mirror failed');
      }
    }

    logger.info({ surface: params.surface, reason: params.reason, bytes: fixture.byteLength }, 'Fixture saved');
    return fixture;
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'saveFixture failed (non-fatal)');
    return null;
  }
}

/** Load stored fixtures for a surface, newest first. */
export async function loadFixtures(surface: string, limit = 10): Promise<StoredFixture[]> {
  try {
    const all = (await cacheGet<StoredFixture[]>(`${FIXTURE_PREFIX}${surface}`)) ?? [];
    return all.slice(0, limit);
  } catch {
    return [];
  }
}

// ===============================================================================
// ZERO-RESULT TRIPWIRE
// ===============================================================================

export interface TripwireResult<T> {
  result: T;
  /** True when the parser returned empty against substantial bytes. */
  tripped: boolean;
  /** Fixture saved for the empty-but-substantial payload, if any. */
  fixture: StoredFixture | null;
}

/**
 * Wrap a parse result with the zero-result tripwire.
 *
 * @param surface   Telemetry surface (e.g. `youtube.next`)
 * @param payload   Raw response bytes/string the parser consumed
 * @param parsed    Parser output
 * @param isEmpty   Predicate deciding whether `parsed` counts as "empty"
 * @param url       Optional source URL for the fixture
 * @param meta      Optional metadata for the fixture
 */
export async function tripwire<T>(params: {
  surface: PlatformSurface | string;
  payload: string;
  parsed: T;
  isEmpty: (parsed: T) => boolean;
  url?: string;
  meta?: Record<string, unknown>;
}): Promise<TripwireResult<T>> {
  const { payload, parsed, isEmpty } = params;
  const bytes = Buffer.byteLength(payload ?? '');
  const empty = (() => {
    try {
      return isEmpty(parsed);
    } catch {
      return true;
    }
  })();

  if (empty && bytes > 1024) {
    const fixture = await saveFixture({
      surface: String(params.surface),
      payload,
      reason: 'zero_result',
      ...(params.url ? { url: params.url } : {}),
      ...(params.meta ? { meta: params.meta } : {}),
    });
    recordAttempt({
      surface: params.surface as PlatformSurface,
      outcome: 'parse_empty',
      url: params.url ?? String(params.surface),
      response: { bytes, marker: 'zero-result tripwire: parser empty against substantial payload' },
    });
    logger.warn(
      { surface: params.surface, bytes, fixtureId: fixture?.id },
      'ZERO-RESULT TRIPWIRE: parser returned empty against substantial bytes — fixture saved',
    );
    return { result: parsed, tripped: true, fixture };
  }

  return { result: parsed, tripped: false, fixture: null };
}

/** Reset in-memory state (tests only — store is Redis-backed). */
export function __resetFixtureStore(): void {
  /* Redis-backed; nothing to clear in-process. */
}
