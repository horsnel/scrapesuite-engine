/**
 * Reddit API Routes -- ScrapeSuite Engine
 *
 * REST API endpoints for Reddit anti-bot counter-measures.
 */

import type { FastifyInstance } from 'fastify';
import { redditManager } from '../platforms/reddit';
import type { RedditScrapeTarget } from '../platforms/reddit';

export async function redditRoutes(app: FastifyInstance): Promise<void> {
  // Initialize Reddit manager
  app.post('/v1/reddit/initialize', async () => {
    await redditManager.initialize();
    return { success: true, message: 'Reddit manager initialized' };
  });

  // Prepare a complete Reddit session
  app.post('/v1/reddit/session/prepare', async (request) => {
    const body = request.body as {
      target?: RedditScrapeTarget;
      proxyTier?: 'residential' | 'mobile';
      useOAuth?: boolean;
    };
    const session = await redditManager.prepareSession(body);
    return session;
  });

  // Scrape a Reddit listing
  app.post('/v1/reddit/scrape', async (request) => {
    const body = request.body as {
      url: string;
      useOAuth?: boolean;
      maxPages?: number;
    };
    const result = await redditManager.scrapeListing(body.url, {
      useOAuth: body.useOAuth,
      maxPages: body.maxPages,
    });
    return result;
  });

  // Evade rate limit
  app.post('/v1/reddit/evade-rate-limit', async (request) => {
    const body = request.body as {
      statusCode: number;
      headers?: Record<string, string>;
    };
    const result = await redditManager.evadeRateLimit(body as any);
    return result;
  });

  // Simulate Reddit browsing
  app.post('/v1/reddit/simulate', async (request) => {
    const body = request.body as {
      section?: RedditScrapeTarget;
      durationSeconds?: number;
    };
    const result = await redditManager.simulateBrowsing(
      body.section || 'listing',
      body.durationSeconds || 60,
    );
    return result;
  });

  // Get Reddit manager stats
  app.get('/v1/reddit/stats', async () => {
    return redditManager.getStats();
  });
}
