/**
 * Platform Telemetry Bridge — ScrapeSuite Engine
 *
 * The missing nervous system between the platform layer (reddit / tiktok /
 * youtube) and the engine's self-improving brain (`src/self-improver`).
 *
 * Every platform fetch that terminates — success, blocked, rate-limited,
 * shape-rejected — is adapted into a `ScrapingObservation` and fed to the
 * observation collector, so the failure analyzer and adaptation engine can
 * learn which strategies work per domain and per anti-bot platform.
 *
 * Design rules:
 *  - Fire-and-forget: telemetry MUST NEVER break or slow a scrape. Every
 *    entry point swallows its own errors.
 *  - Zero hard dependencies: if the self-improver is unavailable (tests,
 *    stripped builds) the bridge degrades to an in-memory ring buffer that
 *    still powers failure-signature learning and the canary report.
 *  - One observation per fetch, with a compact outcome taxonomy that maps
 *    onto the self-improver's `Outcome` union.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { failureSignatures } from './failure-signatures';
import type {
  ScrapingObservation,
  Outcome,
  AntiBotPlatform,
  AppliedStrategy,
} from '../self-improver/types';

const logger = createChildLogger('platform-telemetry');

// ===============================================================================
// OUTCOME TAXONOMY (platform layer)
// ===============================================================================

/** Compact outcome vocabulary used by the platform layer. */
export type PlatformOutcome =
  | 'success'            // got usable data
  | 'shape_rejected'     // 4xx shape/protocol rejection (e.g. InnerTube Precondition)
  | 'bot_wall'           // soft block: HTML wall page / abuse interstitial (200 or 4xx)
  | 'rate_limited'       // 429 / explicit slow-down
  | 'ip_gated'           // trust-tier gate: same request works from trusted IPs
  | 'auth_required'      // login / credentials needed
  | 'timeout'            // network timeout / abort
  | 'network_error'      // DNS, connect, TLS-level failure
  | 'parse_empty'        // got bytes, extracted nothing (zero-result tripwire)
  | 'degraded';          // got data but field-stripped (e.g. player without videoDetails)

/** Platform surfaces the engine scrapes. */
export type PlatformSurface =
  | 'reddit.json' | 'reddit.oauth' | 'reddit.rss'
  | 'tiktok.web-api' | 'tiktok.sign' | 'tiktok.harvest'
  | 'youtube.browse' | 'youtube.search' | 'youtube.player'
  | 'youtube.next' | 'youtube.transcript' | 'youtube.other';

/** Known anti-bot systems mapped from raw platform responses. */
export type KnownDefense = 'google_bot_detection' | 'generic' | 'cloudflare' | 'akamai' | null;

// ===============================================================================
// OUTCOME → SELF-IMPROVER MAPPING
// ===============================================================================

const OUTCOME_MAP: Record<PlatformOutcome, { outcome: Outcome; defense: AntiBotPlatform }> = {
  success: { outcome: 'success', defense: 'generic' },
  shape_rejected: { outcome: 'fingerprint_detected', defense: 'google_bot_detection' },
  bot_wall: { outcome: 'blocked', defense: 'google_bot_detection' },
  rate_limited: { outcome: 'rate_limited', defense: 'generic' },
  ip_gated: { outcome: 'proxy_blocked', defense: 'google_bot_detection' },
  auth_required: { outcome: 'session_expired', defense: 'generic' },
  timeout: { outcome: 'timeout', defense: 'generic' },
  network_error: { outcome: 'timeout', defense: 'generic' },
  parse_empty: { outcome: 'blocked', defense: 'generic' },
  degraded: { outcome: 'success', defense: 'google_bot_detection' },
};

// ===============================================================================
// OBSERVATION INPUT
// ===============================================================================

export interface PlatformObservationInput {
  /** Platform surface, e.g. `youtube.next`. */
  surface: PlatformSurface;
  /** Outcome of the attempt. */
  outcome: PlatformOutcome;
  /** Target URL or endpoint path. */
  url: string;
  /** Wall-clock duration of the attempt (ms). */
  durationMs?: number;
  /** Strategies that were in play for this attempt. */
  strategies?: AppliedStrategy[];
  /** Extra context: proxy tier, session provenance, client version. */
  context?: {
    proxyTier?: string;
    proxySource?: string;
    sessionProvenance?: 'harvested' | 'synthetic' | 'none';
    clientVersion?: string;
    visitorData?: boolean;
  };
  /** Compact response details. */
  response?: {
    status?: number;
    bytes?: number;
    /** Short machine-readable error kind, e.g. `precondition_failed`. */
    errorKind?: string;
    /** First ~200 chars of a distinctive marker from the response. */
    marker?: string;
  };
}

// ===============================================================================
// TELEMETRY BRIDGE
// ===============================================================================

/** In-memory ring buffer for degraded mode + local introspection. */
const RING_LIMIT = 500;
const ring: ScrapingObservation[] = [];

let totalEmitted = 0;
let totalDropped = 0;

/**
 * Convert a platform observation into a self-improver `ScrapingObservation`.
 * Exported for offline testing.
 */
export function toScrapingObservation(input: PlatformObservationInput): ScrapingObservation {
  const mapped = OUTCOME_MAP[input.outcome] ?? OUTCOME_MAP.network_error;
  const domain = safeDomain(input.url);
  const now = Date.now();

  return {
    id: randomUUID(),
    url: input.url,
    domain,
    timestamp: now,
    outcome: mapped.outcome,
    detectedPlatform: input.outcome === 'success' ? null : mapped.defense,
    strategiesApplied: input.strategies ?? [],
    context: {
      proxyTier: input.context?.proxyTier ?? 'direct',
      proxyCountry: '',
      proxyAsn: '',
      tlsProfile: '',
      fingerprintId: '',
      accountId: null,
      sessionId: '',
      requestRate: 0,
      timeSinceLastRequestMs: 0,
      previousRequestCount: 0,
      browserType: 'undici-fetch',
      headless: false,
      referrerUrl: null,
      userAgent: '',
      viewport: '',
      platform: domain,
      // Platform-specific facts the analyzer can correlate on.
      ...(input.context?.clientVersion ? { clientVersion: input.context.clientVersion } : {}),
      ...(input.context?.visitorData !== undefined ? { visitorData: input.context.visitorData } : {}),
      ...(input.response?.errorKind ? { errorKind: input.response.errorKind } : {}),
      ...(input.response?.marker ? { marker: input.response.marker } : {}),
      surface: input.surface,
      outcomeKind: input.outcome,
      proxySource: input.context?.proxySource,
      sessionProvenance: input.context?.sessionProvenance,
    } as ScrapingObservation['context'],
    response: {
      statusCode: input.response?.status ?? 0,
      detectionHeaders: {},
      captchaPresent: false,
      captchaType: null,
      bodyLength: input.response?.bytes ?? 0,
      dataExtracted: input.outcome === 'success',
      errorMessage: input.response?.errorKind ?? input.response?.marker ?? null,
      akamaiSensorVersion: null,
      recaptchaScore: null,
    },
    analyzed: false,
    durationMs: input.durationMs ?? 0,
  };
}

/** Safe domain extraction that never throws. */
function safeDomain(url: string): string {
  try {
    return new URL(url, 'https://x.invalid').hostname;
  } catch {
    return url.split('/')[0] || 'unknown';
  }
}

/**
 * Record a platform attempt. Fire-and-forget; never throws, never blocks
 * the scrape path meaningfully.
 */
export function recordAttempt(input: PlatformObservationInput): void {
  try {
    const observation = toScrapingObservation(input);
    ring.push(observation);
    if (ring.length > RING_LIMIT) ring.shift();
    totalEmitted++;

    // Feed the self-improver brain (dynamic import keeps the platform layer
    // loadable even if the self-improver tree ever fails to import).
    void (async () => {
      try {
        const { observationCollector } = await import('../self-improver/observation-collector');
        const { id: _id, analyzed: _analyzed, ...rest } = observation;
        await observationCollector.record(rest);
      } catch (err: any) {
        totalDropped++;
        logger.debug({ err: err?.message }, 'self-improver feed unavailable (degraded to ring buffer)');
      }
    })();

    // Feed the failure-signature store.
    try {
      failureSignatures.observe(input);
    } catch (err: any) {
      logger.debug({ err: err?.message }, 'failure-signature store unavailable');
    }
  } catch (err: any) {
    totalDropped++;
    logger.debug({ err: err?.message }, 'telemetry recordAttempt failed (ignored)');
  }
}

/** Snapshot of the in-memory ring for introspection and canary reports. */
export function recentObservations(n = 50): ScrapingObservation[] {
  return ring.slice(-n);
}

/** Counts by outcome — cheap aggregate for dashboards and canary. */
export function outcomeTally(): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const o of ring) {
    const kind = (o.context as any)?.outcomeKind ?? o.outcome;
    tally[kind] = (tally[kind] ?? 0) + 1;
  }
  return tally;
}

/** Bridge health stats. */
export function telemetryStats(): { emitted: number; dropped: number; ringSize: number } {
  return { emitted: totalEmitted, dropped: totalDropped, ringSize: ring.length };
}
