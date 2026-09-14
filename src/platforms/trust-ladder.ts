/**
 * Trust Ladder — ScrapeSuite Engine (platform layer)
 *
 * The engine's signature capability. One call, and the engine climbs the
 * trust ladder itself:
 *
 *   rung 1  DIRECT          — pure signed request from this machine
 *   rung 2  PROXY           — same request through a healthy pool proxy
 *   rung 3  BROWSER-SESSION — request wearing a harvested browser's identity
 *
 * Most scrapers make the operator pick the strategy. The ladder tries the
 * cheap rung first and escalates only on failure — and it REMEMBERS which
 * rung each surface needed (Redis, per surface + endpoint family). The next
 * request for that surface starts at the remembered rung and skips the
 * wasted attempts. When a remembered rung starts failing, the ladder
 * re-descends automatically — trust levels shift both ways.
 *
 * The ladder is outcome-driven: each rung's attempt returns a PlatformOutcome,
 * so IP-gates, bot walls, rate limits, and shape rejections all escalate
 * differently. Rate limits do NOT escalate (a different identity won't help
 * — patience will); they simply fail through.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import type { PlatformOutcome, PlatformSurface } from './telemetry';

const logger = createChildLogger('trust-ladder');

const LADDER_PREFIX = 'platlearn:ladder:';
const LADDER_TTL_SECONDS = 60 * 60 * 24 * 7;

// ===============================================================================
// TYPES
// ===============================================================================

export type LadderRung = 'direct' | 'proxy' | 'browser-session';

const RUNG_ORDER: LadderRung[] = ['direct', 'proxy', 'browser-session'];

/** What the caller's per-rung attempt produced. */
export interface RungAttempt<T> {
  ok: boolean;
  value?: T;
  outcome: PlatformOutcome;
  /** Skip ladder bookkeeping for this attempt (e.g. validation errors). */
  notPlatformRelated?: boolean;
  detail?: string;
}

export interface LadderStep<T> {
  rung: LadderRung;
  outcome: PlatformOutcome;
  ok: boolean;
  durationMs: number;
  detail?: string;
}

export interface LadderResult<T> {
  ok: boolean;
  value?: T;
  /** The rung that produced the final result. */
  rung?: LadderRung;
  /** All rungs tried, in order. */
  steps: LadderStep<T>[];
  /** Whether the winning rung came from ladder memory (skipped earlier rungs). */
  fromMemory: boolean;
}

// ===============================================================================
// RUNG MEMORY
// ===============================================================================

function ladderKey(surface: string): string {
  return `${LADDER_PREFIX}${surface}`;
}

/** Which rung does this surface currently remember as its minimum? */
export async function getRememberedRung(surface: string): Promise<LadderRung | null> {
  try {
    const remembered = await cacheGet<LadderRung>(ladderKey(surface));
    return remembered && RUNG_ORDER.includes(remembered) ? remembered : null;
  } catch {
    return null;
  }
}

/** Remember (or clear) the minimum rung a surface needs. Internal use. */
async function rememberRung(surface: string, rung: LadderRung | null): Promise<void> {
  try {
    if (rung === null) {
      await cacheSet(ladderKey(surface), 'direct', LADDER_TTL_SECONDS);
    } else {
      await cacheSet(ladderKey(surface), rung, LADDER_TTL_SECONDS);
    }
  } catch {
    // Memory is best-effort.
  }
}

// ===============================================================================
// CLIMB
// ===============================================================================

/** Outcomes that should trigger escalation to a higher rung. */
function shouldEscalate(outcome: PlatformOutcome): boolean {
  return (
    outcome === 'bot_wall' ||
    outcome === 'ip_gated' ||
    outcome === 'shape_rejected' ||
    outcome === 'network_error' ||
    outcome === 'timeout'
  );
}

/**
 * Climb the trust ladder for a surface.
 *
 * @param params.surface          Surface identifier (uses PlatformSurface or any string)
 * @param params.attempt          Map of rung → attempt function. Provide only the
 *                                rungs that make sense for your surface.
 * @param params.startFromRung    Force a starting rung (overrides memory)
 * @param params.noMemory         Disable rung-memory reads/writes for this call
 */
export async function climbLadder<T>(params: {
  surface: PlatformSurface | string;
  attempt: Partial<Record<LadderRung, () => Promise<RungAttempt<T>>>>;
  startFromRung?: LadderRung;
  noMemory?: boolean;
}): Promise<LadderResult<T>> {
  const surface = String(params.surface);
  const steps: LadderStep<T>[] = [];

  // ---- Determine the starting rung -----------------------------------------
  // Iterate only the rungs the caller provided, in canonical order. Ladder
  // memory SKIPS cheaper provided rungs — but never makes us try a rung the
  // caller didn't supply: if memory is higher than everything provided, we
  // simply start from the cheapest provided rung.
  const provided = RUNG_ORDER.filter((r) => !!params.attempt[r]);
  if (provided.length === 0) {
    return { ok: false, steps, fromMemory: false };
  }
  let startRung: LadderRung = provided[0];
  let fromMemory = false;
  if (!params.noMemory) {
    const remembered = await getRememberedRung(surface);
    if (remembered) {
      const memIdx = RUNG_ORDER.indexOf(remembered);
      const firstAtOrAbove = provided.find((r) => RUNG_ORDER.indexOf(r) >= memIdx);
      if (firstAtOrAbove) {
        fromMemory = RUNG_ORDER.indexOf(firstAtOrAbove) > RUNG_ORDER.indexOf(provided[0]);
        startRung = firstAtOrAbove;
        if (fromMemory) {
          logger.debug({ surface, remembered }, 'Ladder starting at remembered rung');
        }
      }
    }
  }
  if (params.startFromRung) {
    startRung = params.startFromRung;
    fromMemory = false;
  }

  // ---- Climb ----------------------------------------------------------------
  let lastOutcome: PlatformOutcome = 'network_error';
  let rung: LadderRung | undefined = startRung;
  while (rung) {
    const fn = params.attempt[rung];
    if (!fn) break; // unreachable — rung always comes from `provided`

    const stepStart = Date.now();
    let attempt: RungAttempt<T>;
    try {
      attempt = await fn();
    } catch (err: any) {
      attempt = { ok: false, outcome: 'network_error', detail: err?.message?.slice(0, 150) };
    }
    const step: LadderStep<T> = {
      rung,
      outcome: attempt.outcome,
      ok: attempt.ok,
      durationMs: Date.now() - stepStart,
      ...(attempt.detail ? { detail: attempt.detail } : {}),
    };
    steps.push(step);
    lastOutcome = attempt.outcome;

    if (attempt.ok) {
      // Success: remember this rung as sufficient (and reward de-escalation:
      // success BELOW the remembered rung relaxes memory).
      if (!params.noMemory) {
        const remembered = await getRememberedRung(surface);
        if (remembered && RUNG_ORDER.indexOf(rung) < RUNG_ORDER.indexOf(remembered)) {
          await rememberRung(surface, rung);
          logger.info({ surface, relaxedFrom: remembered, relaxedTo: rung }, 'Ladder memory relaxed — lower rung works again');
        } else if (!remembered && rung !== 'direct') {
          await rememberRung(surface, rung);
          logger.info({ surface, rung }, 'Ladder memory set — surface needed escalation');
        }
      }
      return { ok: true, value: attempt.value, rung, steps, fromMemory };
    }

    if (attempt.notPlatformRelated) {
      // Validation / caller errors don't escalate — failing fast is correct.
      return { ok: false, steps, fromMemory: false };
    }

    if (attempt.outcome === 'rate_limited' || attempt.outcome === 'auth_required') {
      // Escalation cannot fix these — a different identity still gets scolded.
      return { ok: false, steps, fromMemory };
    }

    if (!shouldEscalate(attempt.outcome)) {
      // parse_empty / degraded: data arrived; the rung is fine, the parser isn't.
      return { ok: false, steps, fromMemory };
    }

    // Escalate to the next provided rung.
    rung = provided.find((r) => RUNG_ORDER.indexOf(r) > RUNG_ORDER.indexOf(rung!));
  }

  // ---- Exhausted: everything failed -----------------------------------------
  // If even the top rung failed, relax memory (the world may have changed).
  if (!params.noMemory && lastOutcome !== 'parse_empty') {
    await rememberRung(surface, 'direct');
  }
  return { ok: false, steps, fromMemory: false };
}

/** Test hook: clear in-process state (Redis keys expire on their own). */
export async function resetLadderMemory(surface?: string): Promise<void> {
  try {
    if (surface) await cacheSet(ladderKey(surface), 'direct', 1);
  } catch {
    // ignore
  }
}
