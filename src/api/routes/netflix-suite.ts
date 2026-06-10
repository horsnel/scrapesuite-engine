/**
 * Netflix Suite API Routes — ScrapeSuite Engine
 *
 * REST API endpoints for Netflix scraping including catalog
 * extraction, search, regional availability, and API interception.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { netflixSuiteManager, catalogExtractor, apiInterceptor, availabilityChecker } from '../../netflix-suite';
import type { NetflixContentType } from '../../netflix-suite/types';

interface ExtractCatalogBody {
  region?: string;
  genre?: string;
  type?: NetflixContentType;
  page?: number;
  limit?: number;
  sort_by?: 'popularity' | 'date_added' | 'title' | 'rating' | 'year';
  proxy_tier?: 'residential' | 'mobile';
  proxy_country?: string;
}

interface SearchNetflixBody {
  query: string;
  region?: string;
  type?: NetflixContentType;
  limit?: number;
  proxy_country?: string;
}

interface CheckAvailabilityBody {
  title?: string;
  netflix_id?: number;
  regions: string[];
  proxy_tier?: 'residential' | 'mobile';
}

interface GetTitleBody {
  netflix_id: number;
  region?: string;
}

export async function netflixSuiteRoutes(app: FastifyInstance): Promise<void> {

  // Extract Netflix catalog
  app.post('/v1/netflix/catalog', async (req: FastifyRequest<{ Body: ExtractCatalogBody }>, reply) => {
    const { region, genre, type, page, limit, sort_by, proxy_tier, proxy_country } = req.body;

    const result = await netflixSuiteManager.extractCatalog({
      region,
      genre,
      type,
      page,
      limit,
      sortBy: sort_by,
      proxyTier: proxy_tier,
      proxyCountry: proxy_country,
    });
    return reply.send(result);
  });

  // Search Netflix
  app.post('/v1/netflix/search', async (req: FastifyRequest<{ Body: SearchNetflixBody }>, reply) => {
    const { query, region, type, limit, proxy_country } = req.body;
    if (!query) return reply.status(400).send({ error: 'query is required' });

    const result = await netflixSuiteManager.search({
      query,
      region,
      type,
      limit,
      proxyCountry: proxy_country,
    });
    return reply.send(result);
  });

  // Check regional availability
  app.post('/v1/netflix/availability', async (req: FastifyRequest<{ Body: CheckAvailabilityBody }>, reply) => {
    const { title, netflix_id, regions, proxy_tier } = req.body;
    if (!regions?.length) return reply.status(400).send({ error: 'regions array is required' });

    const result = await netflixSuiteManager.checkAvailability({
      title,
      netflixId: netflix_id,
      regions,
      proxyTier: proxy_tier,
    });
    return reply.send(result);
  });

  // Get title details
  app.post('/v1/netflix/title', async (req: FastifyRequest<{ Body: GetTitleBody }>, reply) => {
    const { netflix_id, region } = req.body;
    if (!netflix_id) return reply.status(400).send({ error: 'netflix_id is required' });

    const title = await netflixSuiteManager.getTitleDetails(netflix_id, region);
    if (!title) return reply.status(404).send({ error: 'Title not found' });
    return reply.send(title);
  });

  // Get Netflix genres
  app.get('/v1/netflix/genres', async (req: FastifyRequest<{ Querystring: { region?: string } }>, reply) => {
    const genres = netflixSuiteManager.getGenres(req.query.region);
    return reply.send({ genres });
  });

  // Get supported regions
  app.get('/v1/netflix/regions', async (_req, reply) => {
    const regions = netflixSuiteManager.getSupportedRegions();
    return reply.send({ regions });
  });

  // Get API interception rules
  app.get('/v1/netflix/interception-rules', async (_req, reply) => {
    const rules = netflixSuiteManager.getInterceptionRules();
    return reply.send({ rules });
  });

  // Netflix Suite overall stats
  app.get('/v1/netflix/stats', async (_req, reply) => {
    return reply.send(netflixSuiteManager.getStats());
  });
}
