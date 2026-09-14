/**
 * Unified API Routes — ScrapeSuite Engine
 *
 * The one-door HTTP surface over the unified facade + engine telemetry:
 *   GET /v1/unified/comments?url=…      — comments for any supported URL
 *   GET /v1/unified/transcript?url=…    — transcript for a YouTube URL
 *   GET /v1/unified/resolve?url=…       — platform/kind/id resolution
 *   GET /v1/unified/posts?subreddit=…   — subreddit posts via RSS (normalized)
 *   GET /v1/unified/search?q=…          — YouTube search (normalized)
 *   GET /v1/unified/status              — engine self-report (telemetry,
 *                                         cache, proxy pool, session farm)
 *   POST /v1/unified/canary/run         — trigger a canary patrol now
 *   GET  /v1/unified/canary/latest      — latest stored canary report
 */

import type { FastifyInstance } from 'fastify';
import {
  getCommentsForUrl,
  searchVideos,
  getSubredditPosts,
  engineStatus,
  resolveUrl,
  describeUrl,
  runCanary,
  latestCanaryReport,
} from '../platforms/index';

export async function unifiedRoutes(app: FastifyInstance): Promise<void> {
  // ---- Resolve ----
  app.get('/v1/unified/resolve', async (request) => {
    const { url } = request.query as { url?: string };
    if (!url) return { error: 'url query param required' };
    return { url, description: describeUrl(url), resolved: resolveUrl(url) };
  });

  // ---- Comments ----
  app.get('/v1/unified/comments', async (request) => {
    const { url, maxComments, paginate, cache } = request.query as {
      url?: string;
      maxComments?: string;
      paginate?: string;
      cache?: string;
    };
    if (!url) return { error: 'url query param required' };
    const result = await getCommentsForUrl(url, {
      ...(maxComments ? { maxComments: Number(maxComments) } : {}),
      ...(paginate ? { paginate: paginate === 'true' || paginate === '1' } : {}),
      ...(cache !== undefined ? { cache: cache !== 'false' && cache !== '0' } : {}),
    });
    return result;
  });

  // ---- Transcript ----
  app.get('/v1/unified/transcript', async (request) => {
    const { url, lang, cache } = request.query as { url?: string; lang?: string; cache?: string };
    if (!url) return { error: 'url query param required' };
    const resolved = resolveUrl(url);
    if (resolved.platform !== 'youtube' || (resolved.kind !== 'video' && resolved.kind !== 'short')) {
      return { error: 'transcript requires a YouTube video URL', resolved };
    }
    const { getTranscript } = await import('../platforms/youtube/innertube-endpoints');
    const result = await getTranscript(resolved.videoId, {
      ...(lang ? { lang } : {}),
      ...(cache !== undefined ? { cache: cache !== 'false' && cache !== '0' } : {}),
    });
    return result;
  });

  // ---- Subreddit posts ----
  app.get('/v1/unified/posts', async (request) => {
    const { subreddit, sort, limit } = request.query as { subreddit?: string; sort?: string; limit?: string };
    if (!subreddit) return { error: 'subreddit query param required' };
    const validSorts = ['hot', 'new', 'top', 'rising'] as const;
    const chosen = validSorts.includes((sort ?? 'hot') as any) ? (sort as typeof validSorts[number]) : 'hot';
    const posts = await getSubredditPosts(subreddit, {
      sort: chosen,
      ...(limit ? { limit: Number(limit) } : {}),
    });
    return { ok: posts.length > 0, subreddit, sort: chosen, count: posts.length, posts };
  });

  // ---- Search ----
  app.get('/v1/unified/search', async (request) => {
    const { q } = request.query as { q?: string };
    if (!q) return { error: 'q query param required' };
    const items = await searchVideos(q);
    return { ok: items.length > 0, query: q, count: items.length, items };
  });

  // ---- Engine status ----
  app.get('/v1/unified/status', async () => engineStatus());

  // ---- Canary ----
  app.post('/v1/unified/canary/run', async (request) => {
    const body = (request.body ?? {}) as { live?: boolean; pacingMs?: number };
    const report = await runCanary({
      ...(body.live !== undefined ? { live: body.live } : {}),
      ...(body.pacingMs ? { pacingMs: body.pacingMs } : {}),
    });
    return report;
  });

  app.get('/v1/unified/canary/latest', async () => {
    const report = await latestCanaryReport();
    return report ?? { note: 'no canary report yet — POST /v1/unified/canary/run' };
  });
}
