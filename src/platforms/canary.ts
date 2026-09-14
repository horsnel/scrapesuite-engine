/**
 * Engine Canary — ScrapeSuite Engine (platform layer)
 *
 * The platform power matrix, productized. A scheduled patrol that knocks on
 * every surface the engine supports and classifies each row as:
 *
 *   PASS   — surface returned usable data
 *   GATED  — surface is blocked in a KNOWN, documented way (IP gate, bot wall,
 *            rate-limit dial) — the world is behaving as expected
 *   FAIL   — surface behaved in a way we have NEVER seen (new error, new
 *            shape, silent empty) — this is the alarm that fires
 *
 * The PASS/GATED/FAIL distinction is the canary's whole point: gates are
 * normal, *changes* are not. A FAIL means a platform moved before your
 * users noticed.
 *
 * Rows are environment-adaptive: the transcript row, for example, is a PASS
 * when transcripts load and GATED when the known IP-trust precondition fires
 * — but FAIL for any other error.
 *
 * Reports are stored in Redis (`platlearn:canary:latest` / history) and can
 * be POSTed to `SCRAPESUITE_CANARY_WEBHOOK` on completion.
 */

import { createChildLogger } from '../utils/logger';
import { cacheGet, cacheSet } from '../utils/redis';
import { outcomeTally, telemetryStats } from './telemetry';
import { topSignatures } from './failure-signatures';

const logger = createChildLogger('platform-canary');

const CANARY_LATEST_KEY = 'platlearn:canary:latest';
const CANARY_HISTORY_KEY = 'platlearn:canary:history';
const CANARY_HISTORY_LIMIT = 60;

// ===============================================================================
// TYPES
// ===============================================================================

export type CanaryVerdict = 'PASS' | 'GATED' | 'FAIL' | 'SKIP';

export interface CanaryRow {
  id: string;
  surface: string;
  verdict: CanaryVerdict;
  /** Short human explanation of the verdict. */
  detail: string;
  durationMs: number;
  /** Extra facts (status code, counts, gate classification). */
  facts?: Record<string, unknown>;
}

export interface CanaryReport {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  rows: CanaryRow[];
  summary: {
    pass: number;
    gated: number;
    fail: number;
    skip: number;
    /** Engine health verdict: FAIL rows mean the platform world changed. */
    healthy: boolean;
  };
  /** Failure signatures observed during this run's window. */
  signatureCount: number;
}

export interface CanaryOptions {
  /** Live network probes (default true). false = signing/offline rows only. */
  live?: boolean;
  /** Pacing between live probes in ms (default 12s — Reddit's limiter needs it). */
  pacingMs?: number;
  /** Per-probe timeout in ms (default 20s). */
  timeoutMs?: number;
  /** Reddit subreddit used for live RSS probes. */
  subreddit?: string;
  /** YouTube video used for the comments probe. */
  videoId?: string;
}

const DEFAULTS: Required<Omit<CanaryOptions, 'subreddit' | 'videoId'>> = {
  live: true,
  pacingMs: 12_000,
  timeoutMs: 20_000,
};

// ===============================================================================
// HELPERS
// ===============================================================================

/** Run a probe with a hard timeout; never throws. */
async function guard(
  probe: () => Promise<Omit<CanaryRow, 'durationMs'>>,
  timeoutMs: number,
): Promise<CanaryRow> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      probe(),
      new Promise<Omit<CanaryRow, 'durationMs'>>((_, reject) =>
        setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return { ...result, durationMs: Date.now() - start };
  } catch (err: any) {
    return {
      id: 'unknown',
      surface: 'unknown',
      verdict: 'FAIL',
      detail: `probe crashed: ${err?.message ?? String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Classify an unauthenticated reddit .json status code. */
function redditJsonVerdict(status: number): { verdict: CanaryVerdict; detail: string } {
  if (status === 200) return { verdict: 'PASS', detail: 'unauthenticated .json returned 200' };
  if (status === 403 || status === 429)
    return { verdict: 'GATED', detail: `unauthenticated .json gated with ${status} (documented datacenter gate)` };
  return { verdict: 'FAIL', detail: `unauthenticated .json returned unexpected status ${status}` };
}

// ===============================================================================
// CANARY RUNNER
// ===============================================================================

/**
 * Run the full canary patrol. Never throws — a crashed probe becomes a FAIL
 * row, a crashed row-collection becomes an empty report with healthy=false.
 */
export async function runCanary(options?: CanaryOptions): Promise<CanaryReport> {
  const opts = { ...DEFAULTS, ...options };
  const startedAt = Date.now();
  const rows: CanaryRow[] = [];

  // ------------------------------------------------------------------
  // ROW 1: TikTok X-Bogus signing (offline — always runs)
  // ------------------------------------------------------------------
  rows.push(
    await guard(async () => {
      const { tiktokManager } = await import('../platforms/tiktok');
      await tiktokManager.initialize().catch(() => {});
      const result = await tiktokManager.quickSign('https://www.tiktok.com/api/item/detail/?aid=1988');
      const hasSignature = !!result?.signedUrl?.includes('X-Bogus=') || !!result?.xBogus;
      if (!hasSignature) {
        return { id: 'tiktok.sign', surface: 'tiktok.sign', verdict: 'FAIL' as const, detail: 'quickSign produced no X-Bogus signature' };
      }
      return { id: 'tiktok.sign', surface: 'tiktok.sign', verdict: 'PASS' as const, detail: 'X-Bogus signature produced' };
    }, opts.timeoutMs).then((r) => ({ ...r, id: r.id === 'unknown' ? 'tiktok.sign' : r.id })),
  );

  if (opts.live) {
    // ----------------------------------------------------------------
    // ROW 2: Reddit RSS subreddit feed
    // ----------------------------------------------------------------
    const subreddit = options?.subreddit ?? 'programming';
    rows.push(
      await guard(async () => {
        const { rssAdapter } = await import('./reddit/rss-adapter');
        const result = await rssAdapter.fetchAndParse(`https://www.reddit.com/r/${subreddit}/hot`, {
          limit: 5,
          timeoutMs: opts.timeoutMs,
        });
        if (result.success && result.entryCount > 0) {
          return {
            id: 'reddit.rss.subreddit',
            surface: 'reddit.rss',
            verdict: 'PASS' as const,
            detail: `r/${subreddit} feed returned ${result.entryCount} entries`,
            facts: { entries: result.entryCount },
          };
        }
        const blocked = result.errors.some((e) => e.includes('429') || e.includes('403'));
        return blocked
          ? { id: 'reddit.rss.subreddit', surface: 'reddit.rss', verdict: 'GATED' as const, detail: `RSS gated: ${result.errors[0]}` }
          : { id: 'reddit.rss.subreddit', surface: 'reddit.rss', verdict: 'FAIL' as const, detail: `RSS no entries: ${result.errors[0] ?? 'unknown'}` };
      }, opts.timeoutMs),
    );

    await sleep(opts.pacingMs);

    // ----------------------------------------------------------------
    // ROW 3: YouTube browse (home feed)
    // ----------------------------------------------------------------
    rows.push(
      await guard(async () => {
        const { innertubeClient } = await import('./youtube/innertube-client');
        const response = await innertubeClient.execute({
          endpoint: 'browse',
          body: { browseId: 'FEwhat_to_watch' },
          maxAttempts: 1,
          timeoutMs: opts.timeoutMs,
        });
        if (response.ok && response.json) {
          const hasContents = !!JSON.stringify(response.json).includes('"contents"');
          return hasContents
            ? { id: 'youtube.browse', surface: 'youtube.browse', verdict: 'PASS' as const, detail: 'browse returned contents', facts: { status: response.status } }
            : { id: 'youtube.browse', surface: 'youtube.browse', verdict: 'FAIL' as const, detail: 'browse 200 JSON but no contents key (shape changed?)' };
        }
        if (response.kind === 'sorry_page' || response.kind === 'rate_limited') {
          return { id: 'youtube.browse', surface: 'youtube.browse', verdict: 'GATED' as const, detail: `browse gated (${response.kind})` };
        }
        return { id: 'youtube.browse', surface: 'youtube.browse', verdict: 'FAIL' as const, detail: `browse unexpected: ${response.kind} ${response.error ?? ''}`.trim() };
      }, opts.timeoutMs),
    );

    await sleep(Math.min(opts.pacingMs, 2_000));

    // ----------------------------------------------------------------
    // ROW 4: YouTube comments (next)
    // ----------------------------------------------------------------
    const videoId = options?.videoId ?? 'dQw4w9WgXcQ';
    rows.push(
      await guard(async () => {
        const { getComments } = await import('./youtube/innertube-endpoints');
        const page = await getComments({ videoId, maxAttempts: 1, timeoutMs: opts.timeoutMs } as any);
        const count = (page as any)?.comments?.length ?? 0;
        if (count > 0) {
          return {
            id: 'youtube.comments',
            surface: 'youtube.next',
            verdict: 'PASS' as const,
            detail: `comments page returned ${count} threads`,
            facts: { count },
          };
        }
        const gated = (page as any)?.gated === true || (page as any)?.reason?.includes?.('Precondition');
        return gated
          ? { id: 'youtube.comments', surface: 'youtube.next', verdict: 'GATED' as const, detail: 'comments gated (trust tier raised)' }
          : { id: 'youtube.comments', surface: 'youtube.next', verdict: 'FAIL' as const, detail: 'comments page parsed 0 threads (parser or shape break)' };
      }, opts.timeoutMs),
    );

    await sleep(Math.min(opts.pacingMs, 2_000));

    // ----------------------------------------------------------------
    // ROW 5: YouTube transcript (environment-adaptive)
    // ----------------------------------------------------------------
    rows.push(
      await guard(async () => {
        const { getTranscript } = await import('./youtube/innertube-endpoints');
        const result = await getTranscript({ videoId, maxAttempts: 1, timeoutMs: opts.timeoutMs } as any);
        const segments = (result as any)?.segments?.length ?? 0;
        if (segments > 0) {
          return { id: 'youtube.transcript', surface: 'youtube.transcript', verdict: 'PASS' as const, detail: `transcript returned ${segments} segments`, facts: { segments } };
        }
        const reason = String((result as any)?.reason ?? '');
        if (reason.includes('Precondition') || (result as any)?.gated) {
          return { id: 'youtube.transcript', surface: 'youtube.transcript', verdict: 'GATED' as const, detail: 'transcript IP-gated (known trust-tier precondition)' };
        }
        return { id: 'youtube.transcript', surface: 'youtube.transcript', verdict: 'FAIL' as const, detail: `transcript unexpected failure: ${reason.slice(0, 120)}` };
      }, opts.timeoutMs),
    );
  } else {
    rows.push({
      id: 'live-rows',
      surface: '*',
      verdict: 'SKIP',
      detail: 'live probes disabled (live=false)',
      durationMs: 0,
    });
  }

  const finishedAt = Date.now();
  const summary = {
    pass: rows.filter((r) => r.verdict === 'PASS').length,
    gated: rows.filter((r) => r.verdict === 'GATED').length,
    fail: rows.filter((r) => r.verdict === 'FAIL').length,
    skip: rows.filter((r) => r.verdict === 'SKIP').length,
    healthy: rows.every((r) => r.verdict !== 'FAIL'),
  };

  const signatures = await topSignatures(undefined, 10).catch(() => []);
  const report: CanaryReport = {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    rows,
    summary,
    signatureCount: signatures.length,
  };

  // Persist + notify (best-effort)
  try {
    await cacheSet(CANARY_LATEST_KEY, report, 60 * 60 * 24 * 7);
    const history = (await cacheGet<CanaryReport[]>(CANARY_HISTORY_KEY)) ?? [];
    history.unshift(report);
    await cacheSet(CANARY_HISTORY_KEY, history.slice(0, CANARY_HISTORY_LIMIT), 60 * 60 * 24 * 30);
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'canary report persistence failed (non-fatal)');
  }

  if (summary.fail > 0) {
    logger.error({ fails: summary.fail, rows: rows.filter((r) => r.verdict === 'FAIL').map((r) => r.id) }, 'CANARY ALERT: platform behavior changed');
    void notifyWebhook(report);
  } else {
    logger.info({ pass: summary.pass, gated: summary.gated, durationMs: report.durationMs }, 'Canary patrol complete');
  }

  return report;
}

/** Fire-and-forget webhook notification for FAIL rows. */
async function notifyWebhook(report: CanaryReport): Promise<void> {
  const url = process.env.SCRAPESUITE_CANARY_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'canary-alert', report }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'canary webhook delivery failed');
  }
}

/** Fetch the latest stored canary report. */
export async function latestCanaryReport(): Promise<CanaryReport | null> {
  return cacheGet<CanaryReport>(CANARY_LATEST_KEY);
}

/** Fetch canary history (most recent first). */
export async function canaryHistory(limit = 10): Promise<CanaryReport[]> {
  const all = (await cacheGet<CanaryReport[]>(CANARY_HISTORY_KEY)) ?? [];
  return all.slice(0, limit);
}

/** Telemetry snapshot bundled for dashboards. */
export function canaryTelemetrySnapshot(): Record<string, unknown> {
  return { outcomes: outcomeTally(), telemetry: telemetryStats() };
}
