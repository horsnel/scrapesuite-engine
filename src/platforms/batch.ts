/**
 * Batch Runner — ScrapeSuite Engine (platform layer)
 *
 * Fetch many things at once, politely. A concurrency-limited, pacing-aware
 * worker pool for platform calls: 50 videos' comments without hammering,
 * with per-item error capture so one bad ID never sinks the batch.
 *
 * Pacing inserts a delay between worker STARTS, spreading requests even
 * when each completes instantly — combined with the engine's Redis rate
 * limiter and proxy pool, batches stay under the abuse radar.
 */

import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('platform-batch');

// ===============================================================================
// TYPES
// ===============================================================================

export interface BatchOptions {
  /** Max simultaneous in-flight workers (default 4). */
  concurrency?: number;
  /** Delay between worker starts in ms (default 250). */
  pacingMs?: number;
  /** Continue when individual items fail (default true). */
  continueOnError?: boolean;
  /** Abort the whole batch after this many ms (default none). */
  totalTimeoutMs?: number;
}

export interface BatchItemResult<R> {
  index: number;
  ok: boolean;
  value?: R;
  error?: string;
  durationMs: number;
}

export interface BatchReport<R> {
  results: BatchItemResult<R>[];
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}

// ===============================================================================
// CORE
// ===============================================================================

/**
 * Run `worker` over `items` with bounded concurrency and start-pacing.
 * Results carry per-item ok/error; never throws unless continueOnError=false
 * and an item throws (then the batch aborts and the error propagates).
 */
export async function runBatch<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: BatchOptions = {},
): Promise<BatchReport<R>> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const pacingMs = Math.max(0, options.pacingMs ?? 250);
  const continueOnError = options.continueOnError ?? true;

  const results: BatchItemResult<R>[] = new Array(items.length);
  const startedAt = Date.now();
  let nextIndex = 0;
  let aborted = false;

  const totalTimer = options.totalTimeoutMs
    ? setTimeout(() => {
        aborted = true;
      }, options.totalTimeoutMs)
    : null;

  async function lane(laneId: number): Promise<void> {
    while (true) {
      if (aborted) return;
      const index = nextIndex++;
      if (index >= items.length) return;

      const itemStart = Date.now();
      try {
        const value = await worker(items[index], index);
        results[index] = { index, ok: true, value, durationMs: Date.now() - itemStart };
      } catch (err: any) {
        const message = err?.message ?? String(err);
        results[index] = { index, ok: false, error: message, durationMs: Date.now() - itemStart };
        if (!continueOnError) {
          aborted = true;
          throw err;
        }
      }

      // Pace between item starts (spread load); last item needs no wait.
      if (pacingMs > 0 && nextIndex < items.length) {
        await new Promise((r) => setTimeout(r, pacingMs));
      }
      void laneId;
    }
  }

  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, (_, i) => lane(i));
  try {
    await Promise.all(lanes);
  } catch (err: any) {
    if (!continueOnError) {
      if (totalTimer) clearTimeout(totalTimer);
      throw err;
    }
  }
  if (totalTimer) clearTimeout(totalTimer);

  // Fill any holes left by an abort with error markers.
  for (let i = 0; i < items.length; i++) {
    if (!results[i]) {
      results[i] = { index: i, ok: false, error: aborted ? 'batch aborted' : 'not processed', durationMs: 0 };
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  logger.info(
    { total: items.length, succeeded, failed: items.length - succeeded, durationMs: Date.now() - startedAt },
    'Batch complete',
  );

  return {
    results,
    total: items.length,
    succeeded,
    failed: items.length - succeeded,
    durationMs: Date.now() - startedAt,
  };
}

// ===============================================================================
// PLATFORM CONVENIENCES
// ===============================================================================

/**
 * Fetch comments for many YouTube videos. Concurrency 3 / pacing 400ms by
 * default — InnerTube tolerates this comfortably from datacenter IPs.
 */
export async function batchYouTubeComments(
  videoIds: string[],
  options: BatchOptions & {
    maxComments?: number;
    paginate?: boolean;
    lang?: string;
    cache?: boolean;
    request?: Record<string, unknown>;
  } = {},
): Promise<BatchReport<Awaited<ReturnType<typeof import('./youtube/innertube-endpoints').getComments>>>> {
  const { getComments } = await import('./youtube/innertube-endpoints');
  return runBatch(
    videoIds,
    (videoId) =>
      getComments(videoId, {
        maxComments: options.maxComments,
        paginate: options.paginate,
        lang: options.lang,
        cache: options.cache,
        ...(options.request ? { request: options.request as any } : {}),
      }),
    { concurrency: 3, pacingMs: 400, ...options },
  );
}

/**
 * Fetch many Reddit RSS feeds. Reddit's limiter is unforgiving: concurrency
 * 2 / pacing 1.2s by default, and the engine's persistent rate limiter
 * carries any real 429 backoff across batches.
 */
export async function batchRedditRss(
  urls: string[],
  options: BatchOptions & { limit?: number; timeoutMs?: number } = {},
): Promise<BatchReport<Awaited<ReturnType<typeof import('./reddit/rss-adapter').rssAdapter.fetchAndParse>>>> {
  const { rssAdapter } = await import('./reddit/rss-adapter');
  return runBatch(
    urls,
    (url) => rssAdapter.fetchAndParse(url, { limit: options.limit, timeoutMs: options.timeoutMs }),
    { concurrency: 2, pacingMs: 1_200, ...options },
  );
}
