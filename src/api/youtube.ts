/**
 * YouTube API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for YouTube anti-bot counter-measures.
 */

import type { FastifyInstance } from 'fastify';
import { youtubeManager } from '../platforms/youtube';
import type { YouTubeScrapeTarget, YouTubeClientPlatform } from '../platforms/youtube';

export async function youtubeRoutes(app: FastifyInstance): Promise<void> {
  // Initialize YouTube manager
  app.post('/v1/youtube/initialize', async () => {
    await youtubeManager.initialize();
    return { success: true, message: 'YouTube manager initialized' };
  });

  // Prepare a complete YouTube session
  app.post('/v1/youtube/session/prepare', async (request) => {
    const body = request.body as {
      platform?: YouTubeClientPlatform;
      proxyTier?: 'residential' | 'mobile';
    };
    const session = await youtubeManager.prepareSession(body);
    return session;
  });

  // Sign a YouTube API request
  app.post('/v1/youtube/sign', async (request) => {
    const body = request.body as {
      url: string;
      method?: 'GET' | 'POST';
      requestBody?: Record<string, unknown>;
    };
    const result = await youtubeManager.signRequest(
      body.url,
      body.method || 'GET',
      body.requestBody,
    );
    return result;
  });

  // Simulate watching a video
  app.post('/v1/youtube/simulate/watch', async (request) => {
    const body = request.body as {
      videoId: string;
      durationSeconds?: number;
    };
    const result = await youtubeManager.simulateWatch(
      body.videoId,
      body.durationSeconds || 60,
    );
    return result;
  });

  // Evade bot detection
  app.post('/v1/youtube/evade', async (request) => {
    const body = request.body as {
      statusCode: number;
      headers?: Record<string, string>;
      responseBody?: string;
    };
    const result = await youtubeManager.evadeDetection(body as any);
    return result;
  });

  // Get YouTube manager stats
  app.get('/v1/youtube/stats', async () => {
    return youtubeManager.getStats();
  });

  // ---- InnerTube endpoint surfaces (comments / transcript / browse / search) ----

  app.get('/v1/youtube/comments', async (request) => {
    const { videoId, url, maxComments, paginate, cache } = request.query as {
      videoId?: string;
      url?: string;
      maxComments?: string;
      paginate?: string;
      cache?: string;
    };
    let id = videoId;
    if (!id && url) {
      const { resolveUrl } = await import('../platforms/router');
      const resolved = resolveUrl(url);
      if (resolved.platform === 'youtube' && 'videoId' in resolved) id = resolved.videoId;
    }
    if (!id) return { error: 'videoId or url query param required' };
    const { getComments } = await import('../platforms/youtube/innertube-endpoints');
    return getComments(id, {
      ...(maxComments ? { maxComments: Number(maxComments) } : {}),
      ...(paginate ? { paginate: paginate === 'true' || paginate === '1' } : {}),
      ...(cache !== undefined ? { cache: cache !== 'false' && cache !== '0' } : {}),
    });
  });

  app.get('/v1/youtube/transcript', async (request) => {
    const { videoId, url, lang, cache } = request.query as {
      videoId?: string;
      url?: string;
      lang?: string;
      cache?: string;
    };
    let id = videoId;
    if (!id && url) {
      const { resolveUrl } = await import('../platforms/router');
      const resolved = resolveUrl(url);
      if (resolved.platform === 'youtube' && 'videoId' in resolved) id = resolved.videoId;
    }
    if (!id) return { error: 'videoId or url query param required' };
    const { getTranscript } = await import('../platforms/youtube/innertube-endpoints');
    return getTranscript(id, {
      ...(lang ? { lang } : {}),
      ...(cache !== undefined ? { cache: cache !== 'false' && cache !== '0' } : {}),
    });
  });

  app.get('/v1/youtube/browse', async (request) => {
    const { browseId } = request.query as { browseId?: string };
    const { innertubeClient } = await import('../platforms/youtube/innertube-client');
    const { extractBrowseVideos } = await import('../platforms/youtube/extractors');
    const response = await innertubeClient.execute({
      endpoint: 'browse',
      body: { browseId: browseId || 'FEwhat_to_watch' },
    });
    if (!response.ok || !response.json) {
      return { ok: false, kind: response.kind, error: response.error };
    }
    return {
      ok: true,
      items: extractBrowseVideos(response.json as Record<string, unknown>),
    };
  });

  app.get('/v1/youtube/search', async (request) => {
    const { q } = request.query as { q?: string };
    if (!q) return { error: 'q query param required' };
    const { innertubeClient } = await import('../platforms/youtube/innertube-client');
    const { extractSearchResults } = await import('../platforms/youtube/extractors');
    const response = await innertubeClient.execute({ endpoint: 'search', body: { query: q } });
    if (!response.ok || !response.json) {
      return { ok: false, kind: response.kind, error: response.error };
    }
    return { ok: true, items: extractSearchResults(response.json as Record<string, unknown>) };
  });
}
