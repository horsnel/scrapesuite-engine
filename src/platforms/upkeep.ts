/**
 * Platform Upkeep — ScrapeSuite Engine
 *
 * The self-maintenance loop for the platform layer. Two jobs:
 *
 * 1. VERSION REFRESH — periodically bootstraps YouTube's live ytcfg so the
 *    engine's clientVersion never silently ages (we once caught the engine
 *    3 months behind the live site). When the live version differs from the
 *    cached one, a "version drift" event is logged loudly and recorded as a
 *    telemetry observation — a version bump is the most common precursor to
 *    a platform-wide shape change.
 *
 * 2. CANARY SCHEDULE — runs the power-matrix patrol on a cron schedule
 *    (SCRAPESUITE_CANARY_CRON, parsed with cron-parser) or a fixed interval
 *    (SCRAPESUITE_CANARY_INTERVAL_HOURS). FAIL rows trigger alerts.
 *
 * All jobs are opt-in via SCRAPESUITE_UPKEEP_ENABLED=1 (or MODE=worker) so
 * library consumers and tests never spawn background timers implicitly.
 */

import { createChildLogger } from '../utils/logger';
import { recordAttempt } from './telemetry';
import { parseExpression } from 'cron-parser';

const logger = createChildLogger('platform-upkeep');

// ===============================================================================
// CONFIG
// ===============================================================================

export interface UpkeepConfig {
  enabled: boolean;
  versionRefreshHours: number;
  canaryCron?: string;
  canaryIntervalHours?: number;
  canaryPacingMs: number;
}

export function loadUpkeepConfig(): UpkeepConfig {
  const canaryCron = process.env.SCRAPESUITE_CANARY_CRON || undefined;
  const canaryIntervalHours = process.env.SCRAPESUITE_CANARY_INTERVAL_HOURS
    ? Number(process.env.SCRAPESUITE_CANARY_INTERVAL_HOURS)
    : undefined;
  return {
    enabled:
      process.env.SCRAPESUITE_UPKEEP_ENABLED === '1' ||
      process.env.SCRAPESUITE_UPKEEP_ENABLED === 'true' ||
      (process.env.MODE === 'worker' && process.env.SCRAPESUITE_UPKEEP_ENABLED !== '0'),
    versionRefreshHours: Number(process.env.SCRAPESUITE_VERSION_REFRESH_HOURS ?? 12),
    canaryCron,
    canaryIntervalHours,
    canaryPacingMs: Number(process.env.SCRAPESUITE_CANARY_PACING_MS ?? 12_000),
  };
}

// ===============================================================================
// VERSION REFRESH
// ===============================================================================

let lastKnownVersion: string | null = null;

/**
 * Refresh YouTube client version from live ytcfg. Detects and logs version
 * drift. Never throws.
 */
export async function refreshYouTubeVersion(): Promise<{
  clientVersion: string | null;
  drifted: boolean;
  previousVersion: string | null;
}> {
  try {
    const { fetchYouTubeBootstrap } = await import('./youtube/bootstrap');
    const result = await fetchYouTubeBootstrap({ skipCache: true });
    const version = result.clientVersion;
    const drifted = !!version && !!lastKnownVersion && version !== lastKnownVersion;

    if (version && version !== lastKnownVersion) {
      if (lastKnownVersion) {
        logger.warn(
          { previous: lastKnownVersion, current: version },
          'YouTube clientVersion DRIFT detected — live site updated its InnerTube client',
        );
        recordAttempt({
          surface: 'youtube.other',
          outcome: 'degraded', // not a failure — but a platform-change signal
          url: 'https://www.youtube.com/ (version drift probe)',
          context: {
            sessionProvenance: 'synthetic',
            clientVersion: version,
          },
          response: { marker: `version drift ${lastKnownVersion} -> ${version}` },
        });
      }
      lastKnownVersion = version;
      logger.info({ clientVersion: version, source: result.source }, 'YouTube client version refreshed');
    }

    return { clientVersion: version, drifted, previousVersion: lastKnownVersion };
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'version refresh failed (non-fatal)');
    return { clientVersion: lastKnownVersion, drifted: false, previousVersion: lastKnownVersion };
  }
}

/** Seed the drift detector with a known version (e.g. from cache at boot). */
export function seedLastKnownVersion(version: string | null): void {
  lastKnownVersion = version;
}

// ===============================================================================
// SCHEDULER
// ===============================================================================

let versionTimer: ReturnType<typeof setInterval> | null = null;
let canaryTimer: ReturnType<typeof setInterval> | null = null;
let canaryRunning = false;
let started = false;

/** Milliseconds until the next cron fire, or null on parse failure. */
function nextCronDelayMs(expression: string): number | null {
  try {
    const interval = parseExpression(expression, { currentDate: new Date() });
    return interval.next().getTime() - Date.now();
  } catch (err: any) {
    logger.warn({ cron: expression, err: err?.message }, 'invalid canary cron expression');
    return null;
  }
}

/** Start the upkeep loop (idempotent). */
export function startUpkeep(config?: Partial<UpkeepConfig>): void {
  if (started) return;
  const cfg = { ...loadUpkeepConfig(), ...config };
  if (!cfg.enabled) {
    logger.info('Upkeep disabled (SCRAPESUITE_UPKEEP_ENABLED not set)');
    return;
  }
  started = true;

  // ---- Version refresh loop ----
  const versionMs = Math.max(1, cfg.versionRefreshHours) * 60 * 60 * 1000;
  void refreshYouTubeVersion(); // immediate first pass
  versionTimer = setInterval(() => void refreshYouTubeVersion(), versionMs);
  versionTimer.unref?.();
  logger.info({ everyHours: cfg.versionRefreshHours }, 'Version refresh scheduled');

  // ---- Canary schedule ----
  const runCanarySafely = async () => {
    if (canaryRunning) return;
    canaryRunning = true;
    try {
      const { runCanary } = await import('./canary');
      await runCanary({ pacingMs: cfg.canaryPacingMs });
    } catch (err: any) {
      logger.error({ err: err?.message }, 'scheduled canary run crashed');
    } finally {
      canaryRunning = false;
    }
  };

  if (cfg.canaryCron) {
    const scheduleCron = () => {
      const delay = nextCronDelayMs(cfg.canaryCron!);
      if (delay === null) return;
      const t = setTimeout(() => {
        void runCanarySafely();
        scheduleCron();
      }, Math.max(delay, 1_000));
      (t as any).unref?.();
    };
    scheduleCron();
    logger.info({ cron: cfg.canaryCron }, 'Canary scheduled via cron');
  } else if (cfg.canaryIntervalHours && cfg.canaryIntervalHours > 0) {
    const intervalMs = cfg.canaryIntervalHours * 60 * 60 * 1000;
    canaryTimer = setInterval(() => void runCanarySafely(), intervalMs);
    canaryTimer.unref?.();
    logger.info({ everyHours: cfg.canaryIntervalHours }, 'Canary scheduled via interval');
  }
}

/** Stop all upkeep timers (tests / graceful shutdown). */
export function stopUpkeep(): void {
  if (versionTimer) clearInterval(versionTimer);
  if (canaryTimer) clearInterval(canaryTimer);
  versionTimer = null;
  canaryTimer = null;
  started = false;
}

/** Whether the upkeep loop is running. */
export function upkeepRunning(): boolean {
  return started;
}
